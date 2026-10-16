-- Credit ledger integrity: one customer per name, one allocation pass,
-- cancels instead of hard deletes, and admin checks.

alter table public.credit_entries
  add column if not exists status text not null default 'posted',
  add column if not exists entry_kind text not null default 'sale',
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null;

alter table public.credit_entries
  drop constraint if exists credit_entries_status_check,
  add constraint credit_entries_status_check check (status in ('posted', 'cancelled')),
  drop constraint if exists credit_entries_kind_check,
  add constraint credit_entries_kind_check check (entry_kind in ('sale', 'opening'));

alter table public.credit_payments
  add column if not exists status text not null default 'posted',
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null;

alter table public.credit_payments
  drop constraint if exists credit_payments_status_check,
  add constraint credit_payments_status_check check (status in ('posted', 'cancelled'));

alter table public.credit_customers
  add column if not exists credit_limit numeric(14,2);

alter table public.credit_customers
  drop constraint if exists credit_customers_credit_limit_check,
  add constraint credit_customers_credit_limit_check
    check (credit_limit is null or credit_limit >= 0);

comment on column public.credit_entries.status is
  'posted or cancelled. Cancelled rows stay for the record and are left out of balances.';
comment on column public.credit_entries.entry_kind is
  'sale, or opening when a carried-over balance was turned into a normal entry.';
comment on column public.credit_payments.status is
  'posted or cancelled. Cancelled payments stay for the record and are left out of balances.';
comment on column public.credit_customers.credit_limit is
  'Optional cap. A sale over the limit warns the operator; it is not rejected.';
comment on column public.credit_customers.date is
  'Fixed at creation. Opening balances are credit entries, so this date no longer moves day closing.';

-- Carried-over balances (amount_due and no sales) become opening entries.
-- Triggers stay off until the duplicate merge below has finished. A certified
-- day would otherwise abort the customer-id updates.
alter table public.credit_entries disable trigger credit_entries_guard_certified_day;
alter table public.credit_entries disable trigger audit_credit_entries_trigger;
alter table public.credit_entries disable trigger credit_entries_sync_trigger;
alter table public.credit_entries disable trigger credit_entries_shift_cash_sync;
alter table public.credit_payments disable trigger credit_payments_guard_certified_day;
alter table public.credit_payments disable trigger audit_credit_payments_trigger;

-- Legacy amount_due already had payments subtracted, while those payments still
-- sit in credit_payments. Opening amount restores them so the later allocation
-- pass does not subtract the same money twice. Net stays amount_due - prepaid.
-- Date is the customer date, or the day the row was created in India time.
-- Never the day this migration runs.
insert into public.credit_entries (
  credit_customer_id, transaction_date, fuel_type, quantity, amount,
  amount_settled, created_by, entry_kind, status
)
select
  c.id,
  coalesce(c.date, (c.created_at at time zone 'Asia/Kolkata')::date),
  'HSD',
  1,
  c.amount_due + coalesce(pay.paid, 0) - coalesce(c.prepaid_balance, 0),
  0,
  c.created_by,
  'opening',
  'posted'
from public.credit_customers c
left join (
  select credit_customer_id, sum(amount) as paid
  from public.credit_payments
  group by credit_customer_id
) pay on pay.credit_customer_id = c.id
where not exists (
  select 1 from public.credit_entries e where e.credit_customer_id = c.id
)
and c.amount_due + coalesce(pay.paid, 0) - coalesce(c.prepaid_balance, 0) > 0
and coalesce(c.date, (c.created_at at time zone 'Asia/Kolkata')::date) is not null;

update public.credit_customers
set customer_name = 'Customer ' || left(id::text, 8)
where trim(customer_name) = '';

-- Merge only when the name and a real mobile number match. Two different
-- people who share a name stay separate. A blank mobile is not a match.
do $$
declare
  r record;
  v_keep uuid;
begin
  for r in
    select
      lower(trim(customer_name)) as name_key,
      regexp_replace(mobile, '\D', '', 'g') as mobile_key
    from public.credit_customers
    where nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is not null
    group by 1, 2
    having count(*) > 1
  loop
    select id into v_keep
    from public.credit_customers
    where lower(trim(customer_name)) = r.name_key
      and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
    order by created_at asc nulls last, id asc
    limit 1;

    update public.credit_customers keeper
    set
      mobile = coalesce(keeper.mobile, src.mobile),
      address = coalesce(keeper.address, src.address),
      vehicle_no = coalesce(keeper.vehicle_no, src.vehicle_no),
      notes = coalesce(keeper.notes, src.notes),
      credit_limit = coalesce(keeper.credit_limit, src.credit_limit)
    from (
      select
        (array_agg(mobile order by created_at) filter (where nullif(trim(mobile), '') is not null))[1] as mobile,
        (array_agg(address order by created_at) filter (where nullif(trim(address), '') is not null))[1] as address,
        (array_agg(vehicle_no order by created_at) filter (where nullif(trim(vehicle_no), '') is not null))[1] as vehicle_no,
        (array_agg(notes order by created_at) filter (where nullif(trim(notes), '') is not null))[1] as notes,
        (array_agg(credit_limit order by created_at) filter (where credit_limit is not null))[1] as credit_limit
      from public.credit_customers
      where lower(trim(customer_name)) = r.name_key
        and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
        and id <> v_keep
    ) src
    where keeper.id = v_keep;

    update public.credit_entries
    set credit_customer_id = v_keep
    where credit_customer_id in (
      select id from public.credit_customers
      where lower(trim(customer_name)) = r.name_key
        and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
        and id <> v_keep
    );

    update public.credit_payments
    set credit_customer_id = v_keep
    where credit_customer_id in (
      select id from public.credit_customers
      where lower(trim(customer_name)) = r.name_key
        and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
        and id <> v_keep
    );

    update public.reminders
    set credit_customer_id = v_keep
    where credit_customer_id in (
      select id from public.credit_customers
      where lower(trim(customer_name)) = r.name_key
        and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
        and id <> v_keep
    );

    delete from public.credit_customers
    where lower(trim(customer_name)) = r.name_key
      and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = r.mobile_key
      and id <> v_keep;
  end loop;
end $$;

alter table public.credit_entries enable trigger credit_entries_guard_certified_day;
alter table public.credit_entries enable trigger audit_credit_entries_trigger;
alter table public.credit_entries enable trigger credit_entries_sync_trigger;
alter table public.credit_entries enable trigger credit_entries_shift_cash_sync;
alter table public.credit_payments enable trigger credit_payments_guard_certified_day;
alter table public.credit_payments enable trigger audit_credit_payments_trigger;

drop index if exists public.credit_customers_name_norm_idx;
drop index if exists public.credit_customers_name_unique;
create unique index if not exists credit_customers_name_mobile_unique
  on public.credit_customers (
    lower(trim(customer_name)),
    regexp_replace(mobile, '\D', '', 'g')
  )
  where nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is not null;

revoke update on table public.credit_customers from authenticated;
grant update (
  customer_name,
  vehicle_no,
  last_payment,
  notes,
  mobile,
  address,
  credit_limit
) on table public.credit_customers to authenticated;

drop policy if exists "credit_payments_delete_admin" on public.credit_payments;
create policy "credit_payments_delete_admin" on public.credit_payments
  for delete to authenticated using (false);

revoke delete on table public.credit_payments from public, anon, authenticated;

create or replace function public.credit_customers_guard_date()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    raise exception 'Customer date is fixed. Opening balances are recorded as credit entries.';
  end if;
  return new;
end;
$$;

drop trigger if exists credit_customers_guard_date on public.credit_customers;
create trigger credit_customers_guard_date
  before update on public.credit_customers
  for each row execute function public.credit_customers_guard_date();

create or replace function public.credit_customers_guard_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.credit_limit is distinct from old.credit_limit
     and not public.is_admin()
     and coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'Only an admin can change the credit limit.';
  end if;
  return new;
end;
$$;

drop trigger if exists credit_customers_guard_limit on public.credit_customers;
create trigger credit_customers_guard_limit
  before update on public.credit_customers
  for each row execute function public.credit_customers_guard_limit();

revoke all on function public.credit_customers_guard_limit() from public, anon;
grant execute on function public.credit_customers_guard_limit() to authenticated;

drop policy if exists "credit_entries_delete_admin" on public.credit_entries;
create policy "credit_entries_delete_admin" on public.credit_entries
  for delete to authenticated using (false);

revoke delete on table public.credit_entries from public, anon, authenticated;

-- Skip audit rows while a balance pass rewrites amount_settled.
create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.force_audit', true), '') is distinct from 'true' then
    if coalesce(current_setting('app.skip_credit_audit', true), '') = 'true' then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    elsif exists (
      select 1 from public.runtime_flags
      where key = 'audit' and value = 'off'
    ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (tg_table_name, old.id, tg_op, to_jsonb(old), auth.uid(), auth.jwt() ->> 'email');
    return old;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, to_jsonb(old), to_jsonb(new), auth.uid(), auth.jwt() ->> 'email');
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, to_jsonb(new), auth.uid(), auth.jwt() ->> 'email');
    return new;
  end if;
  return null;
end;
$$;

create or replace function public.sync_credit_customer_balances(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_due numeric;
  v_prepaid numeric;
  v_payment_total numeric;
  v_settled_total numeric;
begin
  select
    coalesce(sum(amount - amount_settled), 0),
    coalesce(sum(amount_settled), 0)
  into v_new_due, v_settled_total
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  select coalesce(sum(amount), 0) into v_payment_total
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  v_prepaid := greatest(0, v_payment_total - v_settled_total);

  update public.credit_customers
  set amount_due = v_new_due, prepaid_balance = v_prepaid
  where id = p_credit_customer_id;
end;
$$;

-- Payments settle newest eligible sale first. Anything still unallocated then
-- settles the oldest open sale, so a customer is never both owing and in advance.
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_ids uuid[];
  v_entry_dates date[];
  v_entry_amounts numeric[];
  v_settled numeric[];
  v_pay record;
  v_i int;
  v_n int;
  v_remaining numeric;
  v_open numeric;
  v_alloc numeric;
  v_pool numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);
  perform set_config('app.skip_credit_audit', 'true', true);
  perform set_config('app.skip_day_closing_refresh', 'true', true);

  select
    array_agg(id order by transaction_date asc, id asc),
    array_agg(transaction_date order by transaction_date asc, id asc),
    array_agg(amount order by transaction_date asc, id asc)
  into v_entry_ids, v_entry_dates, v_entry_amounts
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  v_n := coalesce(array_length(v_entry_ids, 1), 0);
  if v_n > 0 then
    v_settled := array_fill(0::numeric, array[v_n]);
  end if;

  for v_pay in
    select amount, date
    from public.credit_payments
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
    order by date asc, created_at asc, id asc
  loop
    v_remaining := v_pay.amount;
    for v_i in reverse v_n..1 loop
      exit when v_remaining <= 0;
      if v_entry_dates[v_i] > v_pay.date then
        continue;
      end if;
      v_open := v_entry_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_remaining, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_remaining := v_remaining - v_alloc;
    end loop;
  end loop;

  select coalesce(sum(amount), 0) into v_pool
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  if v_n > 0 then
    v_pool := v_pool - coalesce((select sum(x) from unnest(v_settled) as x), 0);
    for v_i in 1..v_n loop
      exit when v_pool <= 0;
      v_open := v_entry_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_pool, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_pool := v_pool - v_alloc;
    end loop;

    update public.credit_entries e
    set amount_settled = s.settled
    from unnest(v_entry_ids, v_settled) as s(id, settled)
    where e.id = s.id
      and e.amount_settled is distinct from s.settled;
  end if;

  perform set_config('app.skip_credit_audit', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);
  perform set_config('app.skip_credit_sync', '', true);
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

comment on function public.reallocate_credit_settlements(uuid) is
  'One pass: payments settle newest open sale on or before the payment date, then leftover advance settles the oldest open sale. Writes amount_settled once.';

-- A sale or payment that is not backdated only touches the open rows it settles.
-- Backdated writes still rebuild the customer's history.
create or replace function public.credit_settle_latest_sale(
  p_credit_customer_id uuid,
  p_entry_id uuid,
  p_date date,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_entry date;
  v_max_pay date;
  v_prepaid numeric;
  v_apply numeric;
begin
  select max(transaction_date) into v_max_entry
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted'
    and id <> p_entry_id;

  select max(date) into v_max_pay
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  if p_date < coalesce(v_max_entry, p_date)
     or p_date < coalesce(v_max_pay, p_date) then
    perform public.reallocate_credit_settlements(p_credit_customer_id);
    return;
  end if;

  select prepaid_balance into v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  v_apply := least(greatest(coalesce(v_prepaid, 0), 0), coalesce(p_amount, 0));
  if v_apply > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    perform set_config('app.skip_credit_audit', 'true', true);
    update public.credit_entries
    set amount_settled = v_apply
    where id = p_entry_id;
    perform set_config('app.skip_credit_audit', '', true);
    perform set_config('app.skip_credit_sync', '', true);
  end if;
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

create or replace function public.credit_settle_latest_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  if exists (
    select 1 from public.credit_payments
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
      and date > p_date
  ) then
    perform public.reallocate_credit_settlements(p_credit_customer_id);
    return;
  end if;

  v_remaining := coalesce(p_amount, 0);
  perform set_config('app.skip_credit_sync', 'true', true);
  perform set_config('app.skip_credit_audit', 'true', true);

  for v_entry in
    select id, amount, amount_settled
    from public.credit_entries
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
      and transaction_date <= p_date
      and amount_settled < amount
    order by transaction_date desc, id desc
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
    update public.credit_entries
    set amount_settled = amount_settled + v_alloc
    where id = v_entry.id;
    v_remaining := v_remaining - v_alloc;
  end loop;

  if v_remaining > 0 then
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
        and status = 'posted'
        and amount_settled < amount
      order by transaction_date asc, id asc
      for update
    loop
      exit when v_remaining <= 0;
      v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
      update public.credit_entries
      set amount_settled = amount_settled + v_alloc
      where id = v_entry.id;
      v_remaining := v_remaining - v_alloc;
    end loop;
  end if;

  perform set_config('app.skip_credit_audit', '', true);
  perform set_config('app.skip_credit_sync', '', true);
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

revoke all on function public.credit_settle_latest_sale(uuid, uuid, date, numeric) from public, anon, authenticated;
revoke all on function public.credit_settle_latest_payment(uuid, date, numeric) from public, anon, authenticated;

-- A status change is a real ledger change (cancel), not a settlement-only update.
create or replace function public.ledger_guard_certified_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_old_date date;
begin
  if tg_table_name = 'credit_entries' then
    if tg_op = 'UPDATE'
       and old.transaction_date is not distinct from new.transaction_date
       and old.amount is not distinct from new.amount
       and old.credit_customer_id is not distinct from new.credit_customer_id
       and old.fuel_type is not distinct from new.fuel_type
       and old.quantity is not distinct from new.quantity
       and old.employee_id is not distinct from new.employee_id
       and old.shift is not distinct from new.shift
       and old.status is not distinct from new.status
       and old.entry_kind is not distinct from new.entry_kind
    then
      return null;
    end if;
    if tg_op = 'DELETE' then
      v_date := old.transaction_date;
      v_old_date := null;
    else
      v_date := new.transaction_date;
      v_old_date := case when tg_op = 'UPDATE' then old.transaction_date else null end;
    end if;
  else
    if tg_op = 'DELETE' then
      v_date := old.date;
      v_old_date := null;
    else
      v_date := new.date;
      v_old_date := case when tg_op = 'UPDATE' then old.date else null end;
    end if;
  end if;

  if tg_table_name = 'expenses' and v_date > public.meter_station_today() then
    raise exception 'Expense date cannot be in the future';
  end if;

  perform public.raise_if_day_closing_certified(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.raise_if_day_closing_certified(v_old_date);
  end if;

  if tg_table_name in ('expenses', 'credit_entries', 'credit_payments') then
    if exists (
      select 1 from public.day_closing dc
      where dc.date = v_date and dc.night_cash_collection_id is not null
    ) or (
      v_old_date is not null and exists (
        select 1 from public.day_closing dc
        where dc.date = v_old_date and dc.night_cash_collection_id is not null
      )
    ) then
      raise exception 'Night cash for this day has already been collected';
    end if;
  end if;

  if coalesce(current_setting('app.skip_day_closing_refresh', true), '') = 'true' then
    return null;
  end if;

  perform public.refresh_open_day_closing(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.refresh_open_day_closing(v_old_date);
  end if;

  return null;
end;
$$;

create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null,
  p_mobile text default null,
  p_address text default null,
  p_employee_id uuid default null,
  p_shift text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
  v_shift text;
  v_name text;
  v_mobile text;
  v_name_matches int;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_credit_entry');
  if v_replay is not null then
    return v_replay;
  end if;

  v_name := trim(p_customer_name);
  if v_name is null or v_name = '' then
    raise exception 'customer name is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > public.meter_station_today() then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'shift must be morning or afternoon';
  end if;
  if (p_employee_id is null) <> (v_shift is null) then
    raise exception 'employee_id and shift must both be set or both be null';
  end if;
  if p_employee_id is not null then
    perform public.require_meter_shift_writable(p_transaction_date, v_shift);
    if not exists (
      select 1 from public.employees e
      where e.id = p_employee_id and coalesce(e.is_active, true)
    ) then
      raise exception 'Unknown or inactive staff';
    end if;
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  v_mobile := nullif(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), '');
  perform pg_advisory_xact_lock(hashtext(lower(v_name) || ':' || coalesce(v_mobile, '')));

  if v_mobile is not null then
    select id into v_customer_id
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = v_mobile
    limit 1;
  else
    select count(*) into v_name_matches
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null;
    if v_name_matches > 1 then
      raise exception 'More than one customer is named %. Enter a mobile number.', v_name;
    end if;
    select id into v_customer_id
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null
    limit 1;
  end if;

  if v_customer_id is null then
    begin
      insert into public.credit_customers (
        customer_name, vehicle_no, amount_due, date, notes, mobile, address, created_by
      )
      values (
        v_name,
        nullif(trim(p_vehicle_no), ''),
        0,
        p_transaction_date,
        nullif(trim(p_notes), ''),
        nullif(trim(p_mobile), ''),
        nullif(trim(p_address), ''),
        auth.uid()
      )
      returning id into v_customer_id;
    exception
      when unique_violation then
        select id into v_customer_id
        from public.credit_customers
        where lower(trim(customer_name)) = lower(v_name)
          and (
            (v_mobile is not null and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = v_mobile)
            or (
              v_mobile is null
              and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null
            )
          )
        limit 1;
    end;
  elsif nullif(trim(p_mobile), '') is not null
     or nullif(trim(p_address), '') is not null
     or nullif(trim(p_vehicle_no), '') is not null then
    update public.credit_customers
    set
      mobile = coalesce(nullif(trim(p_mobile), ''), mobile),
      address = coalesce(nullif(trim(p_address), ''), address),
      vehicle_no = coalesce(nullif(trim(p_vehicle_no), ''), vehicle_no)
    where id = v_customer_id;
  end if;

  perform public.raise_if_day_closing_certified(p_transaction_date);

  perform 1 from public.credit_customers where id = v_customer_id for update;

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift, entry_kind, status
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift, 'sale', 'posted'
  )
  returning id into v_entry_id;

  perform public.credit_settle_latest_sale(v_customer_id, v_entry_id, p_transaction_date, p_amount);

  v_out := jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
  perform public.write_request_store(p_request_id, 'add_credit_entry', v_out);
  return v_out;
end;
$$;

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_credit_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  perform 1
  from public.credit_customers
  where id = p_credit_customer_id
  for update;
  if not found then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  insert into public.credit_payments (
    credit_customer_id, date, amount, note, payment_mode, same_day_settlement, created_by, status
  )
  values (
    p_credit_customer_id,
    p_date,
    p_amount,
    nullif(trim(p_note), ''),
    coalesce(p_payment_mode, 'Cash'),
    coalesce(p_same_day_settlement, false),
    auth.uid(),
    'posted'
  );

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  perform public.credit_settle_latest_payment(p_credit_customer_id, p_date, p_amount);

  update public.credit_customers
  set last_payment = p_date
  where id = p_credit_customer_id;

  if coalesce(current_setting('app.defer_credit_day_closing', true), '') is distinct from 'true' then
    perform public.apply_credit_payment_to_day_closing(
      p_date,
      coalesce(p_same_day_settlement, false),
      coalesce(p_payment_mode, 'Cash'),
      p_amount
    );
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  v_out := jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
  perform public.write_request_store(p_request_id, 'record_credit_payment', v_out);
  return v_out;
end;
$$;

create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_remaining numeric := p_total_amount;
  v_cust_id uuid;
  v_due numeric;
  v_pay_amount numeric;
  v_result jsonb;
  v_settlements jsonb := '[]'::jsonb;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'batch_record_credit_settlements');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    raise exception 'customer_ids required';
  end if;
  if p_primary_customer_id is null then
    raise exception 'primary_customer_id required';
  end if;

  perform id
  from public.credit_customers
  where id = any(p_customer_ids || array[p_primary_customer_id])
  order by id
  for update;

  perform set_config('app.defer_credit_day_closing', 'true', true);

  foreach v_cust_id in array p_customer_ids
  loop
    exit when v_remaining <= 0;

    select amount_due into v_due
    from public.credit_customers
    where id = v_cust_id;

    if not found then
      raise exception 'Credit customer not found';
    end if;

    if v_due <= 0 then
      continue;
    end if;

    v_pay_amount := least(v_remaining, v_due);
    v_result := public.record_credit_payment(
      v_cust_id, p_date, v_pay_amount, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
    v_remaining := v_remaining - v_pay_amount;
  end loop;

  if v_remaining > 0 then
    v_result := public.record_credit_payment(
      p_primary_customer_id, p_date, v_remaining, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
  end if;

  perform set_config('app.defer_credit_day_closing', '', true);

  perform public.apply_credit_payment_to_day_closing(
    p_date,
    coalesce(p_same_day_settlement, false),
    coalesce(p_payment_mode, 'Cash'),
    p_total_amount
  );

  v_out := jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'settlements', v_settlements
  );
  perform public.write_request_store(p_request_id, 'batch_record_credit_settlements', v_out);
  return v_out;
end;
$$;

create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_prepaid numeric;
  v_last_payment date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can cancel credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;
  if v_payment.status = 'cancelled' then
    raise exception 'Settlement is already cancelled';
  end if;

  perform public.raise_if_day_closing_certified(v_payment.date);

  perform 1
  from public.credit_customers
  where id = v_payment.credit_customer_id
  for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  update public.credit_payments
  set status = 'cancelled', cancelled_at = timezone('utc', now()), cancelled_by = auth.uid()
  where id = p_payment_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  perform public.reallocate_credit_settlements(v_payment.credit_customer_id);

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id
    and status = 'posted';

  update public.credit_customers
  set last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  perform public.apply_credit_payment_to_day_closing(
    v_payment.date,
    coalesce(v_payment.same_day_settlement, false),
    coalesce(v_payment.payment_mode, 'Cash'),
    -v_payment.amount
  );

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'cancelled', true,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_payment(uuid) is
  'Admin-only: cancel a settlement (the row stays) and reallocate the customer. Locks the customer row first.';

create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_entry record;
  v_new_due numeric;
  v_prepaid numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can cancel credit entries';
  end if;

  select * into v_entry
  from public.credit_entries
  where id = p_entry_id;

  if not found then
    raise exception 'Credit entry not found';
  end if;
  if v_entry.status = 'cancelled' then
    raise exception 'Credit entry is already cancelled';
  end if;

  perform public.raise_if_day_closing_certified(v_entry.transaction_date);

  perform 1
  from public.credit_customers
  where id = v_entry.credit_customer_id
  for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  update public.credit_entries
  set status = 'cancelled', cancelled_at = timezone('utc', now()), cancelled_by = auth.uid()
  where id = p_entry_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  perform public.reallocate_credit_settlements(v_entry.credit_customer_id);

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_entry.credit_customer_id;

  perform public.sync_saved_day_closing_for_date(v_entry.transaction_date);

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount,
    'transaction_date', v_entry.transaction_date,
    'cancelled', true,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_entry(uuid) is
  'Admin-only: cancel a credit sale (the row stays) and reallocate. Locks the customer row first.';

create or replace function public.delete_shift_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.credit_entries%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.credit_entries where id = p_entry_id;
  if not found then
    raise exception 'Credit entry not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register credit entries can be removed here';
  end if;
  if v_row.status = 'cancelled' then
    raise exception 'Credit entry is already cancelled';
  end if;

  perform public.require_meter_shift_writable(v_row.transaction_date, v_row.shift);
  perform public.raise_if_day_closing_certified(v_row.transaction_date);

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  perform 1 from public.credit_customers where id = v_row.credit_customer_id for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  update public.credit_entries
  set status = 'cancelled', cancelled_at = timezone('utc', now()), cancelled_by = auth.uid()
  where id = p_entry_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  perform public.reallocate_credit_settlements(v_row.credit_customer_id);
  perform public.sync_saved_day_closing_for_date(v_row.transaction_date);

  return jsonb_build_object('deleted', true, 'cancelled', true, 'id', p_entry_id);
end;
$$;

-- Posted rows only. Cancelled sales and payments stay in the table and drop out of the day.
create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_ledger numeric := 0;
  v_credit_shift numeric := 0;
  v_credit_shift_gross numeric := 0;
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_same_day_settle numeric := 0;
  v_same_day_cash numeric := 0;
  v_same_day_upi numeric := 0;
  v_same_day_bank numeric := 0;
  v_payments_raw numeric := 0;
  v_credit_entries numeric := 0;
  v_credit_legacy numeric := 0;
  v_pay_cash numeric := 0;
  v_pay_upi numeric := 0;
  v_same_day_credit_reduce numeric := 0;
  v_open_credit numeric := 0;
begin
  perform public.require_staff_access();

  select coalesce(sum(
    coalesce(v_row.total_sales, 0)
    * case
        when v_row.product = 'petrol' then coalesce(v_row.petrol_rate, 0)
        when v_row.product = 'diesel' then coalesce(v_row.diesel_rate, 0)
        else 0
      end
  ), 0) into v_total_sale
  from (
    select distinct on (product)
      product, total_sales, petrol_rate, diesel_rate
    from public.dsr
    where date = p_date
    order by product, created_at desc nulls last, id desc
  ) v_row;

  with pay as (
    select
      credit_customer_id,
      sum(amount) as pay_today,
      sum(amount) filter (where coalesce(same_day_settlement, false)) as same_day_pay,
      sum(amount) filter (where not coalesce(same_day_settlement, false)) as collection_pay,
      sum(amount) filter (where lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash') as pay_cash,
      sum(amount) filter (where lower(trim(coalesce(payment_mode, ''))) = 'upi') as pay_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as same_day_cash,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as same_day_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'bank'
      ) as same_day_bank
    from public.credit_payments
    where date = p_date
      and status = 'posted'
    group by credit_customer_id
  ),
  cred as (
    select
      credit_customer_id,
      sum(amount) as credit_today,
      sum(amount) filter (where employee_id is not null and shift is not null) as credit_shift
    from public.credit_entries
    where transaction_date = p_date
      and status = 'posted'
    group by credit_customer_id
  ),
  split as (
    select
      coalesce(p.pay_today, 0) as pay_today,
      coalesce(p.collection_pay, 0) as collection_pay,
      coalesce(p.same_day_pay, 0) as same_day_pay,
      coalesce(p.pay_cash, 0) as pay_cash,
      coalesce(p.pay_upi, 0) as pay_upi,
      coalesce(p.same_day_cash, 0) as same_day_cash,
      coalesce(p.same_day_upi, 0) as same_day_upi,
      coalesce(p.same_day_bank, 0) as same_day_bank,
      coalesce(c.credit_today, 0) as credit_today,
      coalesce(c.credit_shift, 0) as credit_shift,
      least(coalesce(p.same_day_pay, 0), coalesce(c.credit_today, 0)) as same_day_credit_reduce
    from pay p
    full outer join cred c using (credit_customer_id)
  )
  select
    coalesce(sum(pay_today), 0),
    coalesce(sum(collection_pay), 0),
    coalesce(sum(pay_cash), 0),
    coalesce(sum(pay_upi), 0),
    coalesce(sum(credit_today), 0),
    coalesce(sum(credit_shift), 0),
    coalesce(sum(same_day_pay), 0),
    coalesce(sum(same_day_cash), 0),
    coalesce(sum(same_day_upi), 0),
    coalesce(sum(same_day_bank), 0),
    coalesce(sum(same_day_credit_reduce), 0)
  into
    v_payments_raw, v_collection,
    v_pay_cash, v_pay_upi,
    v_credit_entries, v_credit_shift_gross,
    v_same_day_settle, v_same_day_cash, v_same_day_upi, v_same_day_bank,
    v_same_day_credit_reduce
  from split;

  select coalesce(sum(c.amount_due), 0) into v_credit_legacy
  from public.credit_customers c
  where c.date = p_date
    and not exists (
      select 1 from public.credit_entries e
      where e.credit_customer_id = c.id and e.status = 'posted'
    );

  v_open_credit := greatest(v_credit_entries - v_same_day_credit_reduce, 0);
  v_credit_ledger := v_open_credit + v_credit_legacy;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  v_credit_shift := least(v_credit_shift_gross, v_open_credit);

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  select coalesce(sum(cash_collected), 0), coalesce(sum(phone_pay), 0)
  into v_shift_cash, v_shift_phone
  from public.meter_shift_cash
  where reading_date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0) - coalesce(v_credit_shift, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'credit_shift_gross', coalesce(v_credit_shift_gross, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0) - coalesce(v_expenses_shift, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0),
    'shift_cash_total', coalesce(v_shift_cash, 0),
    'shift_phone_pay_total', coalesce(v_shift_phone, 0),
    'same_day_settle', coalesce(v_same_day_settle, 0),
    'same_day_settle_cash', coalesce(v_same_day_cash, 0),
    'same_day_settle_upi', coalesce(v_same_day_upi, 0),
    'same_day_settle_bank', coalesce(v_same_day_bank, 0),
    'settle_cash_total', coalesce(v_pay_cash, 0),
    'settle_upi_total', coalesce(v_pay_upi, 0),
    'suggested_night_cash', coalesce(v_shift_cash, 0) + coalesce(v_pay_cash, 0),
    'suggested_phone_pay', coalesce(v_shift_phone, 0) + coalesce(v_pay_upi, 0)
  );
end;
$$;

create or replace function public.sum_credit_given(p_start date, p_end date)
returns numeric
language plpgsql stable security definer
set search_path = public
as $$
declare
  total numeric;
begin
  perform public.require_staff_access();
  select coalesce(sum(c.amount), 0) into total
  from public.credit_entries c
  where c.transaction_date >= p_start
    and c.transaction_date <= p_end
    and c.status = 'posted';
  return total;
end;
$$;

drop function if exists public.get_customer_credit_detail_as_of(text, date);

create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date,
  p_from date default null
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb,
  opening_balance numeric,
  closing_balance numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_from date := p_from;
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  opening as (
    select
      coalesce(sum(e.amount) filter (where e.status = 'posted' and (v_from is not null and e.transaction_date < v_from)), 0)
      - coalesce(sum(0), 0) as credit_before
    from public.credit_entries e
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
  ),
  pay_before as (
    select coalesce(sum(p.amount), 0) as paid_before
    from public.credit_payments p
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.status = 'posted'
      and v_from is not null
      and p.date < v_from
  ),
  period_credit as (
    select coalesce(sum(e.amount), 0) as credit_taken,
           min(e.transaction_date) as first_sale_date,
           max(e.transaction_date) as last_credit_date
    from public.credit_entries e
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
      and e.status = 'posted'
      and e.transaction_date <= p_date
      and (v_from is null or e.transaction_date >= v_from)
  ),
  period_pay as (
    select coalesce(sum(p.amount), 0) as settlement_done,
           max(p.date) as last_payment_date
    from public.credit_payments p
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.status = 'posted'
      and p.date <= p_date
      and (v_from is null or p.date >= v_from)
  ),
  name_row as (
    select max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where c.id in (select credit_customer_id from customer_ids)
  ),
  credits_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'entry_date', e.transaction_date,
        'amount', e.amount,
        'fuel_type', e.fuel_type,
        'quantity', e.quantity,
        'amount_settled', e.amount_settled,
        'status', e.status,
        'entry_kind', e.entry_kind,
        'created_by_name', coalesce(nullif(trim(u.display_name), ''), nullif(trim(u.email), ''), '')
      ) order by e.transaction_date, e.created_at, e.id
    ), '[]'::jsonb) as entries
    from public.credit_entries e
    left join public.users u on u.auth_user_id = e.created_by
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
      and e.transaction_date <= p_date
      and (v_from is null or e.transaction_date >= v_from)
  ),
  payments_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'entry_date', p.date,
        'amount', p.amount,
        'payment_mode', p.payment_mode,
        'note', p.note,
        'same_day_settlement', coalesce(p.same_day_settlement, false),
        'status', p.status,
        'created_by_name', coalesce(nullif(trim(u.display_name), ''), nullif(trim(u.email), ''), '')
      ) order by p.date, p.created_at, p.id
    ), '[]'::jsonb) as entries
    from public.credit_payments p
    left join public.users u on u.auth_user_id = p.created_by
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.date <= p_date
      and (v_from is null or p.date >= v_from)
  )
  select
    n.customer_name,
    n.vehicle_no,
    pc.credit_taken,
    pp.settlement_done,
    (pc.credit_taken - pp.settlement_done),
    pp.last_payment_date,
    pc.first_sale_date,
    pc.last_credit_date,
    cj.entries,
    pj.entries,
    case when v_from is null then 0::numeric
         else (select coalesce(sum(e.amount), 0) from public.credit_entries e
               where e.credit_customer_id in (select credit_customer_id from customer_ids)
                 and e.status = 'posted' and e.transaction_date < v_from)
            - (select paid_before from pay_before)
    end,
    case when v_from is null then (pc.credit_taken - pp.settlement_done)
         else (
           (select coalesce(sum(e.amount), 0) from public.credit_entries e
            where e.credit_customer_id in (select credit_customer_id from customer_ids)
              and e.status = 'posted' and e.transaction_date < v_from)
           - (select paid_before from pay_before)
           + pc.credit_taken - pp.settlement_done
         )
    end
  from name_row n
  cross join period_credit pc
  cross join period_pay pp
  cross join credits_json cj
  cross join payments_json pj;
end;
$$;

comment on function public.get_customer_credit_detail_as_of(text, date, date) is
  'Customer statement for a date range. Totals, opening and closing come from SQL. p_from null means all history up to p_date.';

grant execute on function public.get_customer_credit_detail_as_of(text, date, date) to authenticated;

create or replace function public.get_credit_aging(p_as_of date default public.meter_station_today())
returns table (
  customer_id uuid,
  customer_name text,
  open_amount numeric,
  oldest_unpaid date,
  age_days integer,
  bucket text
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_cust uuid;
  v_ids uuid[];
  v_dates date[];
  v_amounts numeric[];
  v_settled numeric[];
  v_pay record;
  v_i int;
  v_n int;
  v_remaining numeric;
  v_open numeric;
  v_alloc numeric;
  v_pool numeric;
  v_open_amount numeric;
  v_oldest date;
  v_name text;
begin
  perform public.require_staff_access();

  for v_cust in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.status = 'posted'
      and e.transaction_date <= p_as_of
  loop
    select
      array_agg(id order by transaction_date asc, id asc),
      array_agg(transaction_date order by transaction_date asc, id asc),
      array_agg(amount order by transaction_date asc, id asc)
    into v_ids, v_dates, v_amounts
    from public.credit_entries
    where credit_customer_id = v_cust
      and status = 'posted'
      and transaction_date <= p_as_of;

    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n = 0 then
      continue;
    end if;
    v_settled := array_fill(0::numeric, array[v_n]);

    for v_pay in
      select amount, date
      from public.credit_payments
      where credit_customer_id = v_cust
        and status = 'posted'
        and date <= p_as_of
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_i in reverse v_n..1 loop
        exit when v_remaining <= 0;
        if v_dates[v_i] > v_pay.date then
          continue;
        end if;
        v_open := v_amounts[v_i] - v_settled[v_i];
        if v_open <= 0 then
          continue;
        end if;
        v_alloc := least(v_remaining, v_open);
        v_settled[v_i] := v_settled[v_i] + v_alloc;
        v_remaining := v_remaining - v_alloc;
      end loop;
    end loop;

    select coalesce(sum(amount), 0) into v_pool
    from public.credit_payments
    where credit_customer_id = v_cust
      and status = 'posted'
      and date <= p_as_of;

    v_pool := v_pool - coalesce((select sum(x) from unnest(v_settled) as x), 0);
    for v_i in 1..v_n loop
      exit when v_pool <= 0;
      v_open := v_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_pool, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_pool := v_pool - v_alloc;
    end loop;

    v_open_amount := 0;
    v_oldest := null;
    for v_i in 1..v_n loop
      v_open := v_amounts[v_i] - v_settled[v_i];
      if v_open > 0 then
        v_open_amount := v_open_amount + v_open;
        if v_oldest is null or v_dates[v_i] < v_oldest then
          v_oldest := v_dates[v_i];
        end if;
      end if;
    end loop;

    if v_open_amount > 0 and v_oldest is not null then
      customer_id := v_cust;
      select c.customer_name into v_name
      from public.credit_customers c
      where c.id = v_cust;
      customer_name := v_name;
      open_amount := v_open_amount;
      oldest_unpaid := v_oldest;
      age_days := (p_as_of - v_oldest)::integer;
      bucket := case
        when age_days <= 30 then '0-30'
        when age_days <= 60 then '31-60'
        when age_days <= 90 then '61-90'
        else '90+'
      end;
      return next;
    end if;
  end loop;
end;
$$;

comment on function public.get_credit_aging(date) is
  'Open credit as of p_as_of. Payments after that date are left out. Buckets follow the oldest unpaid bill: 0-30, 31-60, 61-90, 90+.';

grant execute on function public.get_credit_aging(date) to authenticated;

create or replace function public.check_credit_balances()
returns table (
  customer_id uuid,
  customer_name text,
  stored_due numeric,
  stored_prepaid numeric,
  book_due numeric,
  book_prepaid numeric,
  issue text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can run the credit balance check';
  end if;

  return query
  with books as (
    select
      c.id,
      c.customer_name,
      c.amount_due as stored_due,
      c.prepaid_balance as stored_prepaid,
      coalesce(e.due, 0) as book_due,
      greatest(0, coalesce(p.paid, 0) - coalesce(e.settled, 0)) as book_prepaid
    from public.credit_customers c
    left join (
      select credit_customer_id,
             sum(amount - amount_settled) as due,
             sum(amount_settled) as settled
      from public.credit_entries
      where status = 'posted'
      group by credit_customer_id
    ) e on e.credit_customer_id = c.id
    left join (
      select credit_customer_id, sum(amount) as paid
      from public.credit_payments
      where status = 'posted'
      group by credit_customer_id
    ) p on p.credit_customer_id = c.id
  )
  select
    b.id,
    b.customer_name::text,
    b.stored_due,
    b.stored_prepaid,
    b.book_due,
    b.book_prepaid,
    case
      when b.stored_due > 0.009 and b.stored_prepaid > 0.009 then 'Owes money and holds advance'
      else 'Stored balance does not match entries'
    end
  from books b
  where abs(b.stored_due - b.book_due) > 0.009
     or abs(b.stored_prepaid - b.book_prepaid) > 0.009
     or (b.stored_due > 0.009 and b.stored_prepaid > 0.009)
  order by b.customer_name;
end;
$$;

comment on function public.check_credit_balances() is
  'Admin check: stored amount_due and prepaid_balance against posted entries and payments.';

grant execute on function public.check_credit_balances() to authenticated;



-- Posted rows only in portfolio totals.

create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
      and e.status = 'posted'
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
      and p.status = 'posted'
    group by 1
  )
  select coalesce(sum(
    greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)
  ), 0)
  from bal b
  full outer join pay p using (name_key);
$$;

create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  cust as (
    select distinct on (lower(trim(c.customer_name)))
           lower(trim(c.customer_name)) as name_key,
           c.customer_name::text as customer_name,
           c.vehicle_no::text as vehicle_no
    from public.credit_customers c
    order by lower(trim(c.customer_name)),
             c.amount_due desc nulls last,
             c.created_at desc
  ),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
      and e.status = 'posted'
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
      and p.status = 'posted'
    group by 1
  )
  select cust.customer_name,
         cust.vehicle_no,
         greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric,
         p.last_pay_date,
         b.last_txn_date
  from bal b
  full outer join pay p using (name_key)
  inner join cust on cust.name_key = coalesce(b.name_key, p.name_key)
  where greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0) > 0
  order by 3 desc, 1;
$$;

create or replace function public.get_customer_credit_summary_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
    group by c.id
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.status = 'posted'
      and e.credit_customer_id in (select credit_customer_id from name_match)
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
      and status = 'posted'
      and credit_customer_id in (select credit_customer_id from name_match)
    group by credit_customer_id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  )
  select (max(pc.customer_name))::text,
         (max(pc.vehicle_no))::text,
         sum(pc.credit_taken)::numeric as credit_taken,
         sum(pc.settlement_done)::numeric as settlement_done,
         sum(pc.remaining)::numeric as remaining,
         max(pc.last_payment_date) as last_payment_date,
         min(pc.first_sale_date) as first_sale_date,
         max(pc.last_credit_date) as last_credit_date
  from per_customer pc;
end;
$$;

create or replace function public.get_credit_overview_period(
  p_from date,
  p_to date
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  credit_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(e.amount), 0)::numeric as credit_taken
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_to
      and e.status = 'posted'
      and (p_from is null or e.transaction_date >= p_from)
    group by 1
  ),
  payment_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(p.amount), 0)::numeric as settled
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_to
      and p.status = 'posted'
      and (p_from is null or p.date >= p_from)
    group by 1
  ),
  merged as (
    select coalesce(c.customer_name, p.customer_name) as customer_name,
           coalesce(c.credit_taken, 0) as credit_taken,
           coalesce(p.settled, 0) as settled,
           coalesce(c.credit_taken, 0) - coalesce(p.settled, 0) as overdue
    from credit_agg c
    full outer join payment_agg p using (name_key)
  ),
  totals as (
    select coalesce((select sum(credit_taken) from credit_agg), 0)::numeric as credit_taken,
           coalesce((select sum(settled) from payment_agg), 0)::numeric as settled
  ),
  top_customers as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'credit_taken', s.credit_taken,
          'settled', s.settled,
          'overdue', s.overdue
        )
        order by s.credit_taken desc, s.customer_name
      ),
      '[]'::jsonb
    ) as rows
    from (
      select customer_name, credit_taken, settled, overdue
      from merged
      where credit_taken > 0 or settled > 0
      order by credit_taken desc, customer_name
      limit 50
    ) s
  )
  select jsonb_build_object(
    'credit_taken', t.credit_taken,
    'settled', t.settled,
    'overdue', t.credit_taken - t.settled,
    'customers', tc.rows
  )
  from _auth
  cross join totals t
  cross join top_customers tc;
$$;


do $$
declare
  r uuid;
  d date;
begin
  for r in select id from public.credit_customers loop
    perform public.reallocate_credit_settlements(r);
  end loop;

  for d in
    select distinct transaction_date
    from public.credit_entries
    where entry_kind = 'opening'
  loop
    if not exists (
      select 1 from public.day_closing
      where date = d and coalesce(certified, false)
    ) then
      perform public.sync_saved_day_closing_for_date(d);
    end if;
  end loop;
end $$;
