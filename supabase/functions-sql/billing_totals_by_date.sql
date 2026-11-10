-- Canonical definition of public.billing_totals_by_date. Edit here, then:
--   node scripts/sql-functions.mjs emit billing_totals_by_date
create or replace function public.billing_totals_by_date(p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform public.require_staff_access();
  select coalesce(
    jsonb_agg(
      jsonb_build_object('date', s.day, 'amount', s.amount)
      order by s.day
    ),
    '[]'::jsonb
  )
    into result
  from (
    select i.invoice_date as day,
           coalesce(sum(i.total_amount), 0) as amount
    from public.invoices i
    where i.invoice_date >= p_start
      and i.invoice_date <= p_end
    group by 1
  ) s;
  return result;
end;
$$;

comment on function public.billing_totals_by_date(date, date) is
  'Billing invoice totals grouped by invoice date. Profit and loss lube sales.';

grant execute on function public.billing_totals_by_date(date, date) to authenticated;
