-- Canonical definition of public.get_dashboard_snapshot. Edit here, then:
--   node scripts/sql-functions.mjs emit get_dashboard_snapshot
create or replace function public.get_dashboard_snapshot(p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dsr jsonb;
  v_stock jsonb;
  v_expense numeric;
  v_credit numeric;
begin
  perform public.require_staff_access();
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'A valid date range is required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', d.date,
      'product', d.product,
      'total_sales', d.total_sales,
      'testing', d.testing,
      'stock', d.stock,
      'petrol_rate', d.petrol_rate,
      'diesel_rate', d.diesel_rate
    )
    order by d.date, d.product
  ), '[]'::jsonb)
  into v_dsr
  from public.dsr d
  where d.date between p_start and p_end;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
  into v_stock
  from public.get_dsr_stock_range(p_start, p_end) s;

  v_expense := public.sum_expenses(p_start, p_end, false);
  v_credit := public.sum_credit_given(p_start, p_end);

  return jsonb_build_object(
    'dsrData', v_dsr,
    'stockData', v_stock,
    'expenseData', null,
    'creditData', null,
    'expenseTotal', v_expense,
    'creditGiven', v_credit
  );
end;
$$;

comment on function public.get_dashboard_snapshot(date, date) is
  'Dashboard range in one call: meter rows, stock, expense total, and posted credit given.';

grant execute on function public.get_dashboard_snapshot(date, date) to authenticated;
