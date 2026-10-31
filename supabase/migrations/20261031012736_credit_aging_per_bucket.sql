-- Aging: one row per customer per bucket, using each bill's stored open amount
-- (amount - amount_settled), the same figure the customer page lists as unpaid.
-- Previously the whole balance went in the bucket of the oldest unpaid bill, and
-- payments were re-allocated here instead of read from amount_settled.

create or replace function public.get_credit_aging(p_as_of date default public.meter_station_today())
returns table (
  customer_id uuid,
  customer_name text,
  open_amount numeric,
  oldest_unpaid date,
  age_days integer,
  bucket text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();

  return query
  with open_bills as (
    select
      e.credit_customer_id,
      e.transaction_date,
      e.amount - e.amount_settled as open,
      case
        when p_as_of - e.transaction_date <= 30 then '0-30'
        when p_as_of - e.transaction_date <= 60 then '31-60'
        when p_as_of - e.transaction_date <= 90 then '61-90'
        else '90+'
      end as bucket
    from public.credit_entries e
    where e.status = 'posted'
      and e.transaction_date <= p_as_of
      and e.amount - e.amount_settled > 0.009
  )
  select
    b.credit_customer_id,
    c.customer_name::text,
    sum(b.open),
    min(b.transaction_date),
    (p_as_of - min(b.transaction_date))::integer,
    b.bucket
  from open_bills b
  join public.credit_customers c on c.id = b.credit_customer_id
  group by b.credit_customer_id, c.customer_name, b.bucket;
end;
$$;

comment on function public.get_credit_aging(date) is
  'Open credit by bill age as of p_as_of: one row per customer per bucket (0-30, 31-60, 61-90, 90+). Each row sums amount - amount_settled for that customer''s posted bills in the bucket, matching the unpaid bills on the customer page.';

grant execute on function public.get_credit_aging(date) to authenticated;
