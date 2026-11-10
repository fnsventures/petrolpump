-- Canonical definition of public.purchase_totals_by_date. Edit here, then:
--   node scripts/sql-functions.mjs emit purchase_totals_by_date
create or replace function public.purchase_totals_by_date(p_start date, p_end date)
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
    select d.invoice_date as day,
           coalesce(sum(d.amount), 0) as amount
    from public.invoice_documents d
    where d.category = 'purchase'
      and d.invoice_date >= p_start
      and d.invoice_date <= p_end
      and d.amount > 0
    group by 1
  ) s;
  return result;
end;
$$;

comment on function public.purchase_totals_by_date(date, date) is
  'Purchase-document amounts grouped by invoice date. Profit and loss lube cost.';

grant execute on function public.purchase_totals_by_date(date, date) to authenticated;
