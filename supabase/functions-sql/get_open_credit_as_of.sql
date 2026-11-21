-- Canonical definition of public.get_open_credit_as_of. Edit here, then:
--   node scripts/sql-functions.mjs emit get_open_credit_as_of
create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
      and e.status = 'posted'
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
      and p.status = 'posted'
    group by 1
  )
  select coalesce(sum(
    greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)
  ), 0)
  from bal b
  full outer join pay p using (name_key);
$$;

comment on function public.get_open_credit_as_of(date) is
  'Total outstanding credit as of date D; one balance per customer name (clamped >= 0), matching credit ledger / Total outstanding.';

grant execute on function public.get_open_credit_as_of(date) to authenticated;
