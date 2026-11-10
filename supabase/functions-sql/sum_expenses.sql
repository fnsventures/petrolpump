-- Canonical definition of public.sum_expenses. Edit here, then:
--   node scripts/sql-functions.mjs emit sum_expenses
create or replace function public.sum_expenses(
  p_start date,
  p_end date,
  p_exclude_salary boolean default false
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  total numeric;
begin
  perform public.require_staff_access();
  select coalesce(sum(e.amount), 0)
    into total
  from public.expenses e
  where e.date >= p_start
    and e.date <= p_end
    and (
      not coalesce(p_exclude_salary, false)
      -- category <> 'salary' also drops null categories, matching the expenses page .neq filter.
      or e.category <> 'salary'
    );
  return total;
end;
$$;

comment on function public.sum_expenses(date, date, boolean) is
  'Sum of expense amounts in a date range. p_exclude_salary matches the expenses page (drops salary and null categories).';

grant execute on function public.sum_expenses(date, date, boolean) to authenticated;
