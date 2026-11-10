-- Canonical definition of public.expense_totals_by_category. Edit here, then:
--   node scripts/sql-functions.mjs emit expense_totals_by_category
create or replace function public.expense_totals_by_category(p_start date, p_end date)
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
      jsonb_build_object('category', s.category, 'amount', s.amount)
      order by s.category
    ),
    '[]'::jsonb
  )
    into result
  from (
    select coalesce(nullif(btrim(e.category), ''), 'misc') as category,
           coalesce(sum(e.amount), 0) as amount
    from public.expenses e
    where e.date >= p_start
      and e.date <= p_end
    group by 1
  ) s;
  return result;
end;
$$;

comment on function public.expense_totals_by_category(date, date) is
  'Expense amounts grouped by category for a date range. One object per category, not one per row.';

grant execute on function public.expense_totals_by_category(date, date) to authenticated;
