-- Canonical definition of public.add_expense. Edit here, then:
--   node scripts/sql-functions.mjs emit add_expense
create or replace function public.add_expense(
  p_date date,
  p_category text,
  p_amount numeric,
  p_description text default null,
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
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_expense');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Expense date cannot be in the future';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;

  v_category := nullif(btrim(coalesce(p_category, '')), '');
  if v_category is null then
    raise exception 'category is required';
  end if;
  if lower(v_category) = 'salary' then
    raise exception 'Salary is recorded on the Salary page, not as an expense';
  end if;
  if not exists (select 1 from public.expense_categories c where c.name = v_category) then
    raise exception 'Unknown expense category';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  insert into public.expenses (date, category, description, amount, created_by, client_request_id)
  values (
    p_date,
    v_category,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_amount,
    auth.uid(),
    p_request_id
  )
  returning id into v_id;

  v_out := jsonb_build_object('id', v_id, 'date', p_date, 'amount', p_amount, 'category', v_category);
  perform public.write_request_store(p_request_id, 'add_expense', v_out);
  return v_out;
end;
$$;

comment on function public.add_expense(date, text, numeric, text, uuid) is
  'Book expense (no staff or shift) from the Expenses page. Rejects salary, unknown categories, a non-positive amount, a certified day and future dates (IST). Retry-safe with p_request_id.';

revoke all on function public.add_expense(date, text, numeric, text, uuid) from public, anon;

grant execute on function public.add_expense(date, text, numeric, text, uuid) to authenticated;
