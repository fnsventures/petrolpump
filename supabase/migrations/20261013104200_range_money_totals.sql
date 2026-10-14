-- Range totals in SQL.
-- Dashboard, profit & loss, and the expenses footer were summing raw rows in the
-- browser. PostgREST stops at 1,000 rows and the client refuses past 50,000, so a
-- long range would fail or show a short total. These functions return the totals.

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

create or replace function public.sum_credit_given(p_start date, p_end date)
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
  select coalesce(sum(c.amount), 0)
    into total
  from public.credit_entries c
  where c.transaction_date >= p_start
    and c.transaction_date <= p_end;
  return total;
end;
$$;

comment on function public.sum_credit_given(date, date) is
  'Sum of credit sale amounts (credit_entries.amount) in a date range. Dashboard in-hand uses this.';

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

revoke all on function public.sum_expenses(date, date, boolean) from public, anon;
revoke all on function public.expense_totals_by_category(date, date) from public, anon;
revoke all on function public.expense_totals_by_day(date, date) from public, anon;
revoke all on function public.sum_credit_given(date, date) from public, anon;
revoke all on function public.billing_totals_by_date(date, date) from public, anon;
revoke all on function public.purchase_totals_by_date(date, date) from public, anon;

grant execute on function public.sum_expenses(date, date, boolean) to authenticated;
grant execute on function public.expense_totals_by_category(date, date) to authenticated;
grant execute on function public.expense_totals_by_day(date, date) to authenticated;
grant execute on function public.sum_credit_given(date, date) to authenticated;
grant execute on function public.billing_totals_by_date(date, date) to authenticated;
grant execute on function public.purchase_totals_by_date(date, date) to authenticated;
