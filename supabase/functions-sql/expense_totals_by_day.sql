-- Canonical definition of public.expense_totals_by_day. Edit here, then:
--   node scripts/sql-functions.mjs emit expense_totals_by_day
create or replace function public.expense_totals_by_day(p_start date, p_end date)
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
      jsonb_build_object('date', s.expense_date, 'category', s.category, 'amount', s.amount)
      order by s.expense_date, s.category
    ),
    '[]'::jsonb
  )
    into result
  from (
    select e.date as expense_date,
           coalesce(nullif(btrim(e.category), ''), 'misc') as category,
           coalesce(sum(e.amount), 0) as amount
    from public.expenses e
    where e.date >= p_start
      and e.date <= p_end
    group by 1, 2
  ) s;
  return result;
end;
$$;

comment on function public.expense_totals_by_day(date, date) is
  'Expense amounts grouped by day and category. Used by the analysis chart.';

grant execute on function public.expense_totals_by_day(date, date) to authenticated;
