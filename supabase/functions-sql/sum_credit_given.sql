-- Canonical definition of public.sum_credit_given. Edit here, then:
--   node scripts/sql-functions.mjs emit sum_credit_given
create or replace function public.sum_credit_given(p_start date, p_end date)
returns numeric
language plpgsql stable security definer
set search_path = public
as $$
declare
  total numeric;
begin
  perform public.require_staff_access();
  select coalesce(sum(c.amount), 0) into total
  from public.credit_entries c
  where c.transaction_date >= p_start
    and c.transaction_date <= p_end
    and c.status = 'posted';
  return total;
end;
$$;

comment on function public.sum_credit_given(date, date) is
  'Sum of credit sale amounts (credit_entries.amount) in a date range. Dashboard in-hand uses this.';

grant execute on function public.sum_credit_given(date, date) to authenticated;
