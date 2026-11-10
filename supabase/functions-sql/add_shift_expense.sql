-- Canonical definition of public.add_shift_expense. Edit here, then:
--   node scripts/sql-functions.mjs emit add_shift_expense
create or replace function public.add_shift_expense(
  p_date date,
  p_shift text,
  p_employee_id uuid,
  p_category text,
  p_amount numeric,
  p_description text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_shift text;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_shift_expense');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
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

  perform public.raise_if_day_closing_certified(p_date);

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

  v_out := jsonb_build_object(
    'id', v_id,
    'date', p_date,
    'shift', v_shift,
    'employee_id', p_employee_id,
    'amount', p_amount,
    'category', v_category
  );
  perform public.write_request_store(p_request_id, 'add_shift_expense', v_out);
  return v_out;
end;
$$;

comment on function public.add_shift_expense(date, text, uuid, text, numeric, text, uuid) is
  'Shift register expense attributed to staff + shift. Rejects a certified day and future dates (IST). Retry-safe with p_request_id.';

grant execute on function public.add_shift_expense(date, text, uuid, text, numeric, text, uuid) to authenticated;
