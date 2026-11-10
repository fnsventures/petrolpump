-- Canonical definition of public.delete_meter_shift_readings. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_meter_shift_readings
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
    and e.status = 'posted'
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
      and e.status = 'posted'
  loop
    delete from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.credit_customer_id = v_customer_id
      and e.status = 'posted';
    get diagnostics v_n = row_count;
    v_credit := v_credit + v_n;
    perform public.reallocate_credit_settlements(v_customer_id);
  end loop;

  delete from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and e.status = 'cancelled';

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
  'Admin-only: remove shift nozzles and cash, delete shift credit sales, delete shift expenses, and refresh dsr_* meters.';

grant execute on function public.delete_meter_shift_readings(date, text) to authenticated;
