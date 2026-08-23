-- Shift-attributed credit sales & expenses (real ledger rows).
-- Supervisors enter customer credit / expenses on Staff collections;
-- day closing uses the ledger only (no double-count with meter_shift_cash totals).
-- meter_shift_cash.credit_amount / expense_amount are cached sums for short / reports.

-- ─── Schema: attribution columns ────────────────────────────────────────────

alter table public.credit_entries
  add column if not exists employee_id uuid references public.employees (id) on delete set null,
  add column if not exists shift text
    check (shift is null or shift in ('morning', 'afternoon'));

alter table public.expenses
  add column if not exists employee_id uuid references public.employees (id) on delete set null,
  add column if not exists shift text
    check (shift is null or shift in ('morning', 'afternoon'));

create index if not exists credit_entries_shift_staff_idx
  on public.credit_entries (transaction_date, shift, employee_id)
  where employee_id is not null;

create index if not exists expenses_shift_staff_idx
  on public.expenses (date, shift, employee_id)
  where employee_id is not null;

comment on column public.credit_entries.employee_id is
  'Optional: staff who gave credit during a shift register entry.';
comment on column public.credit_entries.shift is
  'Optional: morning/afternoon when entered from shift register.';
comment on column public.expenses.employee_id is
  'Optional: staff whose till paid this expense during a shift.';
comment on column public.expenses.shift is
  'Optional: morning/afternoon when entered from shift register.';

-- Supervisors may delete their own shift-attributed expenses (same-day till corrections)
drop policy if exists "expenses_delete_admin" on public.expenses;
create policy "expenses_delete_admin" on public.expenses
  for delete to authenticated
  using (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and created_by = auth.uid()
      and employee_id is not null
      and shift is not null
    )
  );

-- ─── Sync cached credit/expense totals on meter_shift_cash ──────────────────

create or replace function public.sync_meter_shift_cash_ledger_totals(
  p_date date,
  p_shift text,
  p_employee_id uuid
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text := lower(btrim(coalesce(p_shift, '')));
  v_credit numeric := 0;
  v_expense numeric := 0;
begin
  if p_date is null or p_employee_id is null or v_shift not in ('morning', 'afternoon') then
    return;
  end if;

  select
    coalesce((
      select sum(ce.amount)
      from public.credit_entries ce
      where ce.transaction_date = p_date
        and ce.shift = v_shift
        and ce.employee_id = p_employee_id
    ), 0),
    coalesce((
      select sum(ex.amount)
      from public.expenses ex
      where ex.date = p_date
        and ex.shift = v_shift
        and ex.employee_id = p_employee_id
    ), 0)
  into v_credit, v_expense;

  insert into public.meter_shift_cash (
    reading_date, shift, employee_id,
    cash_collected, phone_pay, credit_amount, expense_amount,
    updated_at
  )
  values (
    p_date, v_shift, p_employee_id,
    0, 0, v_credit, v_expense,
    timezone('utc'::text, now())
  )
  on conflict (reading_date, shift, employee_id)
  do update set
    credit_amount = excluded.credit_amount,
    expense_amount = excluded.expense_amount,
    updated_at = timezone('utc'::text, now());
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows.';

grant execute on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) to authenticated;

-- Keep cache in sync whenever attributed ledger rows change
create or replace function public.trg_sync_shift_cash_from_credit_entries()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.transaction_date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.transaction_date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  -- UPDATE: refresh old key when attribution moved or amount changed
  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.transaction_date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.transaction_date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists credit_entries_shift_cash_sync on public.credit_entries;
create trigger credit_entries_shift_cash_sync
  after insert or update or delete on public.credit_entries
  for each row execute function public.trg_sync_shift_cash_from_credit_entries();

create or replace function public.trg_sync_shift_cash_from_expenses()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists expenses_shift_cash_sync on public.expenses;
create trigger expenses_shift_cash_sync
  after insert or update or delete on public.expenses
  for each row execute function public.trg_sync_shift_cash_from_expenses();


-- ─── save_meter_shift_readings: cash/phone only; credit/expense from ledger ─

create or replace function public.save_meter_shift_readings(
  p_date date,
  p_shift text,
  p_nozzles jsonb,
  p_cash jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_shift text;
  v_row jsonb;
  v_product text;
  v_pump smallint;
  v_nozzle smallint;
  v_employee uuid;
  v_opening numeric;
  v_closing numeric;
  v_testing numeric;
  v_remarks text;
  v_cash_amt numeric;
  v_phone_pay numeric;
  v_kept_nozzles int := 0;
  v_kept_cash int := 0;
  v_keys text[] := array[]::text[];
  v_emp_ids uuid[] := array[]::uuid[];
  v_existing_count int;
  v_morning_close numeric;
  v_dsr_apply jsonb;
  v_sync_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  perform public.require_meter_shift_writable(p_date, v_shift);

  if p_nozzles is null or jsonb_typeof(p_nozzles) <> 'array' then
    raise exception 'Nozzles payload must be a JSON array';
  end if;

  if p_cash is null then
    p_cash := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_cash) <> 'array' then
    raise exception 'Cash payload must be a JSON array';
  end if;

  select count(*)::int into v_existing_count
  from public.meter_shift_readings r
  where r.reading_date = p_date and r.shift = v_shift;

  for v_row in
    select value from jsonb_array_elements(p_nozzles)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    v_product := lower(btrim(coalesce(v_row->>'product', '')));
    if v_product not in ('petrol', 'diesel') then
      raise exception 'Invalid product in nozzle row';
    end if;

    v_pump := (v_row->>'pump_no')::smallint;
    v_nozzle := (v_row->>'nozzle_no')::smallint;
    if v_pump is null or v_nozzle is null
       or v_pump < 1 or v_pump > 8
       or v_nozzle < 1 or v_nozzle > 8 then
      raise exception 'Invalid pump/nozzle in nozzle row';
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Staff is inactive or missing';
    end if;

    v_opening := coalesce((v_row->>'opening_meter')::numeric, 0);
    v_closing := coalesce((v_row->>'closing_meter')::numeric, 0);
    v_testing := coalesce((v_row->>'testing_litres')::numeric, 0);
    if v_opening < 0 or v_closing < 0 or v_testing < 0 then
      raise exception 'Meter and testing values must be >= 0';
    end if;
    if v_closing < v_opening then
      raise exception 'Closing meter must be >= opening meter (P% · N%)', v_pump, v_nozzle;
    end if;
    if v_testing > (v_closing - v_opening) then
      raise exception 'Testing cannot exceed sale litres (P% · N%)', v_pump, v_nozzle;
    end if;

    if v_shift = 'afternoon' then
      select m.closing_meter into v_morning_close
      from public.meter_shift_readings m
      where m.reading_date = p_date
        and m.shift = 'morning'
        and m.product = v_product
        and m.pump_no = v_pump
        and m.nozzle_no = v_nozzle;
      if found and v_morning_close is not null
         and abs(v_opening - v_morning_close) > 0.001 then
        raise exception
          'Afternoon opening for % P%·N% (%) must match morning closing (%)',
          v_product, v_pump, v_nozzle, v_opening, v_morning_close;
      end if;
    end if;

    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_readings (
      reading_date, product, shift, employee_id,
      pump_no, nozzle_no, opening_meter, closing_meter, testing_litres,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_product, v_shift, v_employee,
      v_pump, v_nozzle, v_opening, v_closing, v_testing,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, product, shift, pump_no, nozzle_no)
    do update set
      employee_id = excluded.employee_id,
      opening_meter = excluded.opening_meter,
      closing_meter = excluded.closing_meter,
      testing_litres = excluded.testing_litres,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now());

    v_keys := array_append(v_keys, v_product || ':' || v_pump::text || ':' || v_nozzle::text);
    v_kept_nozzles := v_kept_nozzles + 1;
  end loop;

  if v_kept_nozzles = 0 and coalesce(v_existing_count, 0) > 0 then
    raise exception
      'Assign at least one nozzle, or use Clear shift to delete existing readings';
  end if;

  delete from public.meter_shift_readings r
  where r.reading_date = p_date
    and r.shift = v_shift
    and not (
      (r.product || ':' || r.pump_no::text || ':' || r.nozzle_no::text) = any (v_keys)
    );

  -- Cash / phone only. credit_amount & expense_amount come from the ledger (never from client).
  for v_row in
    select value from jsonb_array_elements(p_cash)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Cash row references inactive or unknown staff';
    end if;

    v_cash_amt := coalesce((v_row->>'cash_collected')::numeric, 0);
    v_phone_pay := coalesce((v_row->>'phone_pay')::numeric, 0);
    if v_cash_amt < 0 then
      raise exception 'Cash collected must be >= 0';
    end if;
    if v_phone_pay < 0 then
      raise exception 'Phone pay must be >= 0';
    end if;
    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_cash (
      reading_date, shift, employee_id,
      cash_collected, phone_pay, credit_amount, expense_amount,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_shift, v_employee,
      v_cash_amt, v_phone_pay, 0, 0,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, shift, employee_id)
    do update set
      cash_collected = excluded.cash_collected,
      phone_pay = excluded.phone_pay,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now());

    v_emp_ids := array_append(v_emp_ids, v_employee);
    v_kept_cash := v_kept_cash + 1;
  end loop;

  -- Refresh ledger caches for saved staff (covers new rows inserted with 0/0)
  foreach v_sync_id in array v_emp_ids
  loop
    perform public.sync_meter_shift_cash_ledger_totals(p_date, v_shift, v_sync_id);
  end loop;

  -- Drop orphan cash rows only when staff has no nozzles and no attributed ledger
  delete from public.meter_shift_cash c
  where c.reading_date = p_date
    and c.shift = v_shift
    and not (c.employee_id = any (v_emp_ids))
    and not exists (
      select 1 from public.meter_shift_readings r
      where r.reading_date = c.reading_date
        and r.shift = c.shift
        and r.employee_id = c.employee_id
    )
    and not exists (
      select 1 from public.credit_entries e
      where e.transaction_date = c.reading_date
        and e.shift = c.shift
        and e.employee_id = c.employee_id
    )
    and not exists (
      select 1 from public.expenses x
      where x.date = c.reading_date
        and x.shift = c.shift
        and x.employee_id = c.employee_id
    );

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return public.get_meter_shift_readings(p_date, v_shift)
    || jsonb_build_object(
      'saved_nozzles', v_kept_nozzles,
      'saved_cash', v_kept_cash,
      'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
    );
end;
$$;

comment on function public.save_meter_shift_readings(date, text, jsonb, jsonb) is
  'Upsert shift nozzle + cash/phone; credit/expense cached from ledger. Push meters into dsr_*.';

grant execute on function public.save_meter_shift_readings(date, text, jsonb, jsonb) to authenticated;


-- ─── add_credit_entry: optional shift attribution ───────────────────────────

drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text);
drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text);

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
  p_shift text default null
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
  v_shift text;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'shift must be morning or afternoon';
  end if;
  if (p_employee_id is null) <> (v_shift is null) then
    raise exception 'employee_id and shift must both be set or both be null';
  end if;
  if p_employee_id is not null and not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and coalesce(e.is_active, true)
  ) then
    raise exception 'Unknown or inactive staff';
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

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift
  )
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

  -- Cache sync is handled by credit_entries_shift_cash_sync trigger

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
end;
$$;

comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text) is
  'Add a credit sale. Optional p_employee_id + p_shift attribute to shift register. Rejects future dates.';

grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text) to authenticated;

-- ─── Shift expense RPC (validates attribution; trigger refreshes cache) ─────

create or replace function public.add_shift_expense(
  p_date date,
  p_shift text,
  p_employee_id uuid,
  p_category text,
  p_amount numeric,
  p_description text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > current_date then
    raise exception 'Expense date cannot be in the future';
  end if;
  if p_employee_id is null then
    raise exception 'employee_id is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_category := nullif(btrim(coalesce(p_category, '')), '');
  if v_category is null then
    raise exception 'category is required';
  end if;
  if lower(v_category) = 'salary' then
    raise exception 'Salary expenses cannot be added from the shift register';
  end if;
  if not exists (
    select 1 from public.expense_categories c where c.name = v_category
  ) then
    raise exception 'Unknown expense category';
  end if;
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and coalesce(e.is_active, true)
  ) then
    raise exception 'Unknown or inactive staff';
  end if;

  insert into public.expenses (
    date, category, description, amount, employee_id, shift, created_by
  )
  values (
    p_date,
    v_category,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_amount,
    p_employee_id,
    v_shift,
    auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'date', p_date,
    'shift', v_shift,
    'employee_id', p_employee_id,
    'amount', p_amount,
    'category', v_category
  );
end;
$$;

comment on function public.add_shift_expense(date, text, uuid, text, numeric, text) is
  'Add an expense attributed to a staff shift till. Cache sync via trigger.';

grant execute on function public.add_shift_expense(date, text, uuid, text, numeric, text) to authenticated;

-- ─── Delete shift-attributed credit entry (unsettleable only) ───────────────

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
  if coalesce(v_row.amount_settled, 0) > 0 then
    raise exception 'Cannot delete a credit sale that already has payments';
  end if;
  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  delete from public.credit_entries where id = p_entry_id;
  perform public.sync_credit_customer_balances(v_row.credit_customer_id);
  -- Cache sync via credit_entries_shift_cash_sync trigger

  return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

grant execute on function public.delete_shift_credit_entry(uuid) to authenticated;

-- ─── Load shift staff ledger (credit + expenses) ────────────────────────────

create or replace function public.get_shift_staff_ledger(p_date date, p_shift text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_staff_access();
  if p_date is null then
    raise exception 'Date is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'credit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'employee_id', e.employee_id,
          'customer_name', c.customer_name,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount', e.amount,
          'amount_settled', e.amount_settled,
          'created_by', e.created_by
        )
        order by c.customer_name, e.created_at
      )
      from public.credit_entries e
      join public.credit_customers c on c.id = e.credit_customer_id
      where e.transaction_date = p_date
        and e.shift = v_shift
        and e.employee_id is not null
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'employee_id', x.employee_id,
          'category', x.category,
          'description', x.description,
          'amount', x.amount,
          'created_by', x.created_by
        )
        order by x.created_at
      )
      from public.expenses x
      where x.date = p_date
        and x.shift = v_shift
        and x.employee_id is not null
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_shift_staff_ledger(date, text) to authenticated;

-- ─── Day closing: ledger only (shift-attributed rows are already in ledger) ─

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
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
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

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  select coalesce(sum(amount), 0) into v_credit_ledger
  from public.credit_entries where transaction_date = p_date;
  select v_credit_ledger + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_ledger;

  -- Attribution breakdown only (already included in ledger totals — do not add again)
  select coalesce(sum(amount), 0) into v_credit_shift
  from public.credit_entries
  where transaction_date = p_date and employee_id is not null and shift is not null;

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0) - coalesce(v_credit_shift, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0) - coalesce(v_expenses_shift, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Day-closing totals from DSR/ledger. Shift-attributed credit/expense are part of ledger (not double-counted).';

grant execute on function public.compute_day_closing_components(date) to authenticated;

-- ─── Bug fixes: write locks, clear-shift ledger wipe, expense delete RPC,
--     locked day-closing snapshot consistency ────────────────────────────────

-- Attributed add_credit_entry must respect shift/day locks
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
  p_shift text default null
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
  v_shift text;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
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

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift
  )
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
  else
    perform public.sync_credit_customer_balances(v_customer_id);
  end if;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
end;
$$;

create or replace function public.add_shift_expense(
  p_date date,
  p_shift text,
  p_employee_id uuid,
  p_category text,
  p_amount numeric,
  p_description text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > current_date then
    raise exception 'Expense date cannot be in the future';
  end if;
  if p_employee_id is null then
    raise exception 'employee_id is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  perform public.require_meter_shift_writable(p_date, v_shift);

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_category := nullif(btrim(coalesce(p_category, '')), '');
  if v_category is null then
    raise exception 'category is required';
  end if;
  if lower(v_category) = 'salary' then
    raise exception 'Salary expenses cannot be added from the shift register';
  end if;
  if not exists (
    select 1 from public.expense_categories c where c.name = v_category
  ) then
    raise exception 'Unknown expense category';
  end if;
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and coalesce(e.is_active, true)
  ) then
    raise exception 'Unknown or inactive staff';
  end if;

  insert into public.expenses (
    date, category, description, amount, employee_id, shift, created_by
  )
  values (
    p_date,
    v_category,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_amount,
    p_employee_id,
    v_shift,
    auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'date', p_date,
    'shift', v_shift,
    'employee_id', p_employee_id,
    'amount', p_amount,
    'category', v_category
  );
end;
$$;

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

  perform public.require_meter_shift_writable(v_row.transaction_date, v_row.shift);

  if coalesce(v_row.amount_settled, 0) > 0 then
    raise exception 'Cannot delete a credit sale that already has payments';
  end if;
  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  delete from public.credit_entries where id = p_entry_id;
  perform public.sync_credit_customer_balances(v_row.credit_customer_id);

  return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

create or replace function public.delete_shift_expense(p_expense_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.expenses%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.expenses where id = p_expense_id;
  if not found then
    raise exception 'Expense not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register expenses can be removed here';
  end if;

  perform public.require_meter_shift_writable(v_row.date, v_row.shift);

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this expense';
  end if;

  delete from public.expenses where id = p_expense_id;

  return jsonb_build_object('deleted', true, 'id', p_expense_id);
end;
$$;

comment on function public.delete_shift_expense(uuid) is
  'Remove a shift-attributed expense; respects shift write lock; cache sync via trigger.';

grant execute on function public.delete_shift_expense(uuid) to authenticated;

-- Clear shift: also remove attributed ledger rows (block if credit has payments)
create or replace function public.delete_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_n int;
  v_c int;
  v_credit int := 0;
  v_expense int := 0;
  v_settled int := 0;
  v_customer_id uuid;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();
  if not public.is_admin() then
    raise exception 'Only admin can delete shift readings';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select count(*)::int into v_settled
  from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and coalesce(e.amount_settled, 0) > 0;
  if v_settled > 0 then
    raise exception
      'Cannot clear shift: % credit sale(s) already have payments. Remove settlements first.',
      v_settled;
  end if;

  for v_customer_id in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
  loop
    delete from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.credit_customer_id = v_customer_id;
    get diagnostics v_n = row_count;
    v_credit := v_credit + v_n;
    perform public.sync_credit_customer_balances(v_customer_id);
  end loop;

  delete from public.expenses x
  where x.date = p_date
    and x.shift = v_shift
    and x.employee_id is not null;
  get diagnostics v_expense = row_count;

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'deleted_credit', v_credit,
    'deleted_expenses', v_expense,
    'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzles/cash and attributed credit/expenses; refresh dsr_* meters.';

-- Locked day closing: use snapshotted expenses (not live), matching credit_today
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_certified boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_today numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.certified, dc.certified_at, dc.certified_by_name,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_certified := v_already_saved and coalesce(v_existing.certified, false);
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and (
    public.is_admin()
    or (not v_night_cash_collected and not v_certified)
  );
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  v_components := public.compute_day_closing_components(p_date);

  if v_use_snapshot then
    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
    v_expenses_today := coalesce(v_existing.expenses_today, 0);
  else
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'credit_ledger', coalesce((v_components->>'credit_ledger')::numeric, 0),
    'credit_shift', coalesce((v_components->>'credit_shift')::numeric, 0),
    'expenses_ledger', coalesce((v_components->>'expenses_ledger')::numeric, 0),
    'expenses_shift', coalesce((v_components->>'expenses_shift')::numeric, 0),
    'snapshot', v_use_snapshot,
    'night_cash', case when v_already_saved then coalesce(v_existing.night_cash, 0) else null end,
    'phone_pay', case when v_already_saved then coalesce(v_existing.phone_pay, 0) else null end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref,
    'certified', v_certified,
    'certified_at', case when v_certified then v_existing.certified_at else null end,
    'certified_by_name', case when v_certified then v_existing.certified_by_name else null end,
    'can_certify', v_already_saved and not v_certified and public.is_admin()
  );
end;
$$;

comment on function public.get_day_closing_breakdown(date) is
  'Day closing components. When locked (certified/night cash), headline totals use the saved snapshot including expenses_today.';
