-- Supervisors can edit employee profiles, but salary figures and the overpay
-- override are admin-only. A supervisor who can change monthly_salary can raise
-- it, record a payment against the inflated take-home, then set it back.
-- p_allow_overpay is the same hole without touching the row: the server used
-- to accept it from any supervisor.
--
-- Expenses written straight to the table (not through add_shift_expense) had
-- no amount > 0 check, so a negative row reduces the day's expenses and hides
-- a shortage. The same write could attach a row to a shift after day closing
-- is saved, or delete the supervisor's own shift expense after that save.
-- The RPCs already call require_meter_shift_writable; this trigger covers the
-- table itself.

create or replace function public.employees_guard_salary_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.monthly_salary, 0) <> 0 or new.pf_contribution is not null then
      raise exception 'Only an admin can set salary or PF contribution.';
    end if;
    return new;
  end if;

  if new.monthly_salary is distinct from old.monthly_salary
     or new.pf_contribution is distinct from old.pf_contribution then
    raise exception 'Only an admin can change salary or PF contribution.';
  end if;

  return new;
end;
$$;

comment on function public.employees_guard_salary_columns() is
  'Trigger: supervisors may edit an employee profile, but monthly_salary and pf_contribution stay admin-only.';

revoke all on function public.employees_guard_salary_columns() from public, anon;
grant execute on function public.employees_guard_salary_columns() to authenticated;

drop trigger if exists employees_guard_salary_columns on public.employees;
create trigger employees_guard_salary_columns
  before insert or update on public.employees
  for each row execute function public.employees_guard_salary_columns();

comment on table public.employees is
  'Pump employees who receive salary. Profile mutations: admin or supervisor. monthly_salary and pf_contribution: admin only. Delete: admin only.';

-- Latest body: 20261006054630_money_write_integrity.sql. Same signature.
create or replace function public.record_salary_payment(
  p_employee_id uuid,
  p_date date,
  p_salary_month date,
  p_amount numeric,
  p_note text default null,
  p_allow_overpay boolean default false,
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
  v_month date;
  v_note text;
  v_name text;
  v_payable numeric;
  v_paid numeric;
  v_pending numeric;
  v_payment_id uuid;
  v_expense_id uuid;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_salary_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_employee_id is null then
    raise exception 'Select a staff member.';
  end if;
  if p_date is null then
    raise exception 'Payment date is required.';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Payment date cannot be in the future.';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;
  if p_salary_month is null then
    raise exception 'Select the salary month this payment applies to.';
  end if;
  v_month := date_trunc('month', p_salary_month)::date;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Note must be 200 characters or fewer.';
  end if;

  select e.name into v_name from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'Staff member not found';
  end if;

  -- Concurrent payments for the same employee and month see each other's rows.
  perform pg_advisory_xact_lock(
    hashtextextended('salary_payment:' || p_employee_id::text || ':' || v_month::text, 0)
  );

  v_payable := public.salary_month_payable(p_employee_id, v_month);
  select coalesce(sum(sp.amount), 0) into v_paid
  from public.salary_payments sp
  where sp.employee_id = p_employee_id and sp.salary_month = v_month;
  v_pending := greatest(0, v_payable - v_paid);

  -- 0.05 absorbs paisa rounding differences against the browser's floating-point figures.
  -- p_allow_overpay is ignored unless the caller is an admin.
  if v_payable > 0 and p_amount > v_pending + 0.05
     and not (public.is_admin() and coalesce(p_allow_overpay, false)) then
    raise exception using
      message = 'Amount exceeds the remaining salary for this month.',
      detail = jsonb_build_object('payable', v_payable, 'paid', v_paid, 'pending', v_pending)::text,
      hint = 'salary_overpay';
  end if;

  insert into public.salary_payments (employee_id, date, salary_month, amount, note, created_by)
  values (p_employee_id, p_date, v_month, p_amount, v_note, auth.uid())
  returning id into v_payment_id;

  insert into public.expenses (date, category, description, amount, salary_payment_id, created_by)
  values (
    p_date,
    'salary',
    'Salary: ' || v_name || coalesce(' - ' || v_note, ''),
    p_amount,
    v_payment_id,
    auth.uid()
  )
  returning id into v_expense_id;

  v_out := jsonb_build_object(
    'id', v_payment_id,
    'expense_id', v_expense_id,
    'employee_id', p_employee_id,
    'date', p_date,
    'salary_month', v_month,
    'amount', p_amount,
    'payable', v_payable,
    'paid_before', v_paid,
    'pending_after', greatest(0, v_payable - v_paid - p_amount)
  );
  perform public.write_request_store(p_request_id, 'record_salary_payment', v_out);
  return v_out;
end;
$$;

comment on function public.record_salary_payment(uuid, date, date, numeric, text, boolean, uuid) is
  'Record a salary payment and its linked salary expense in one transaction. Rejects a certified payment date. Raises hint salary_overpay when the amount exceeds the month''s remaining take-home. p_allow_overpay is honored for admins only. Retry-safe with p_request_id.';

-- A default of 0 would itself violate the new check.
alter table public.expenses alter column amount drop default;

do $$
begin
  if exists (select 1 from public.expenses where amount <= 0) then
    raise exception 'expenses.amount has non-positive rows. Correct them before adding expenses_amount_positive.';
  end if;
end;
$$;

alter table public.expenses drop constraint if exists expenses_amount_positive;
alter table public.expenses
  add constraint expenses_amount_positive check (amount > 0);

comment on column public.expenses.amount is
  'Amount in ₹. Must be greater than 0; a negative expense would hide a day''s shortage.';

create or replace function public.expenses_guard_shift_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.shift is not null then
      perform public.require_meter_shift_writable(old.date, old.shift);
    end if;
    return old;
  end if;

  if new.shift is not null then
    perform public.require_meter_shift_writable(new.date, new.shift);
  end if;

  if tg_op = 'UPDATE'
     and old.shift is not null
     and (old.date is distinct from new.date or old.shift is distinct from new.shift) then
    perform public.require_meter_shift_writable(old.date, old.shift);
  end if;

  return new;
end;
$$;

comment on function public.expenses_guard_shift_write() is
  'Trigger: a shift-attributed expense insert, update, or delete uses the same lock as the shift register. Supervisors are blocked once day closing is saved, or the day is certified or night cash is collected. Book expenses (no shift) are unchanged.';

revoke all on function public.expenses_guard_shift_write() from public, anon;
grant execute on function public.expenses_guard_shift_write() to authenticated;

drop trigger if exists expenses_guard_shift_write on public.expenses;
create trigger expenses_guard_shift_write
  before insert or update or delete on public.expenses
  for each row execute function public.expenses_guard_shift_write();
