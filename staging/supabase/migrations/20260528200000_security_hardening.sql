-- Security hardening: role resolution, employee PII, credit dates, attendance RPC

-- 1. Role from public.users only (no JWT metadata escalation)
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
as $$
  select role
  from public.users
  where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'))
  limit 1;
$$;

comment on function public.get_user_role() is
  'Returns admin/supervisor from public.users only. Null if not provisioned.';

-- 2. Employee PII: direct table SELECT admin-only; roster RPC for supervisors
drop policy if exists "employees_select_authenticated" on public.employees;
drop policy if exists "employees_select_admin" on public.employees;
create policy "employees_select_admin" on public.employees
  for select to authenticated using (public.is_admin());

create or replace function public.list_employees_roster()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint
)
language sql
security definer
stable
as $$
  select e.id, e.name, e.role_display, e.monthly_salary, e.display_order
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
$$;

comment on function public.list_employees_roster() is
  'Active employees without PII — for salary and attendance (all authenticated).';

grant execute on function public.list_employees_roster() to authenticated;

-- 3. Credit entry: reject future transaction dates
create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
begin
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
    insert into public.credit_customers (customer_name, vehicle_no, amount_due, date, notes, created_by)
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  end if;

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;

-- 4. Credit payment: reject future settlement dates
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
begin
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
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  if v_remaining > 0 then
    raise exception 'Payment amount exceeds outstanding balance';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;

-- 5. Attendance batch: supervisors and admins only
create or replace function public.save_employee_attendance_batch(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row jsonb;
  v_count int := 0;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Supervisor or admin access required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) as t(value)
  loop
    if v_row->>'employee_id' is null then
      continue;
    end if;
    insert into public.employee_attendance (
      employee_id, date, status, shift, note, created_by, updated_at
    )
    values (
      (v_row->>'employee_id')::uuid,
      p_date,
      coalesce(nullif(trim(v_row->>'status'), ''), 'present'),
      nullif(trim(v_row->>'shift'), ''),
      nullif(trim(v_row->>'note'), ''),
      auth.uid(),
      timezone('utc'::text, now())
    )
    on conflict (employee_id, date) do update set
      status = excluded.status,
      shift = excluded.shift,
      note = excluded.note,
      updated_at = excluded.updated_at;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;
