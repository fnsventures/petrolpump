-- Allow overpayment on credit customers; excess is stored as prepaid_balance (credit in customer's favour).

alter table public.credit_customers
  add column if not exists prepaid_balance numeric(14,2) not null default 0
  check (prepaid_balance >= 0);

comment on column public.credit_customers.prepaid_balance is
  'Advance credit from overpayment. Net balance = amount_due - prepaid_balance.';

-- Recompute amount_due and prepaid_balance from entries and payments.
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
  where credit_customer_id = p_credit_customer_id;

  select coalesce(sum(amount), 0) into v_payment_total
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id;

  v_prepaid := greatest(0, v_payment_total - v_settled_total);

  update public.credit_customers
  set amount_due = v_new_due, prepaid_balance = v_prepaid
  where id = p_credit_customer_id;
end;
$$;

comment on function public.sync_credit_customer_balances(uuid) is
  'Sync amount_due and prepaid_balance from credit_entries and credit_payments.';

revoke all on function public.sync_credit_customer_balances(uuid) from public;
revoke all on function public.sync_credit_customer_balances(uuid) from authenticated;

-- Backfill prepaid for existing customers (overpayments that were previously rejected have none).
update public.credit_customers c
set prepaid_balance = greatest(0,
  coalesce((select sum(p.amount) from public.credit_payments p where p.credit_customer_id = c.id), 0)
  - coalesce((select sum(e.amount_settled) from public.credit_entries e where e.credit_customer_id = c.id), 0)
);

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
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

    insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
    values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

    perform public.sync_credit_customer_balances(p_credit_customer_id);

    update public.credit_customers
    set last_payment = p_date
    where id = p_credit_customer_id;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text) is
  'Record payment; allocate to entries FIFO. Overpayment is stored as prepaid_balance.';

create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay record;
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    update public.credit_entries
    set amount_settled = 0
    where credit_customer_id = p_credit_customer_id;

    for v_pay in
      select id, amount
      from public.credit_payments
      where credit_customer_id = p_credit_customer_id
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = p_credit_customer_id
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
    end loop;

    perform public.sync_credit_customer_balances(p_credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);
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
    raise exception 'Only an admin can delete credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    delete from public.credit_payments where id = p_payment_id;
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id;

  update public.credit_customers
  set last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
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
  p_address text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
  v_remaining numeric;
  v_entry record;
  v_alloc numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  select id into v_customer_id
  from public.credit_customers
  where trim(lower(customer_name)) = trim(lower(p_customer_name))
  order by created_at desc limit 1;

  if v_customer_id is null then
    insert into public.credit_customers (
      customer_name, vehicle_no, amount_due, date, notes, mobile, address, created_by
    )
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      nullif(trim(p_mobile), ''),
      nullif(trim(p_address), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  elsif nullif(trim(p_mobile), '') is not null
     or nullif(trim(p_address), '') is not null then
    update public.credit_customers
    set
      mobile = coalesce(nullif(trim(p_mobile), ''), mobile),
      address = coalesce(nullif(trim(p_address), ''), address)
    where id = v_customer_id;
  end if;

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  select prepaid_balance into v_prepaid
  from public.credit_customers
  where id = v_customer_id;

  if coalesce(v_prepaid, 0) > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    begin
      v_remaining := v_prepaid;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = v_customer_id
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
      perform public.sync_credit_customer_balances(v_customer_id);
    exception
      when others then
        perform set_config('app.skip_credit_sync', '', true);
        raise;
    end;
    perform set_config('app.skip_credit_sync', '', true);
  end if;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;
