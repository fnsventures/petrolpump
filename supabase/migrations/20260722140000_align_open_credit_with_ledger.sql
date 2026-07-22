-- Align dashboard open credit with credit overview "Total outstanding".
-- Both must net by customer name so duplicate-name accounts (due on one row,
-- prepaid on another) produce the same portfolio total.

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
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
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

-- Outstanding list as-of: net credit-payments per name (not sum of per-id clamps).
create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  cust as (
    select distinct on (lower(trim(c.customer_name)))
           lower(trim(c.customer_name)) as name_key,
           c.customer_name::text as customer_name,
           c.vehicle_no::text as vehicle_no
    from public.credit_customers c
    order by lower(trim(c.customer_name)),
             c.amount_due desc nulls last,
             c.created_at desc
  ),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
    group by 1
  )
  select cust.customer_name,
         cust.vehicle_no,
         greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric,
         p.last_pay_date,
         b.last_txn_date
  from bal b
  full outer join pay p using (name_key)
  inner join cust on cust.name_key = coalesce(b.name_key, p.name_key)
  where greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0) > 0
  order by 3 desc, 1;
$$;

comment on function public.get_outstanding_credit_list_as_of(date) is
  'Customers with outstanding balance as of date D; one row per customer name with net (credit - payments) clamped >= 0.';

grant execute on function public.get_open_credit_as_of(date) to authenticated;
grant execute on function public.get_outstanding_credit_list_as_of(date) to authenticated;
