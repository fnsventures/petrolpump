-- Aging: each bucket is a date window, and a customer's row in it is the credit
-- taken minus settlements dated in that window. Same formula as the customer
-- page's Activity outstanding for the same from/to dates.
--   0-30   p_as_of - 30 .. p_as_of
--   31-60  p_as_of - 60 .. p_as_of - 31
--   61-90  p_as_of - 90 .. p_as_of - 61
--   90+    first activity .. p_as_of - 91
-- Return columns change, so the old function is dropped first.

drop function if exists public.get_credit_aging(date);

create or replace function public.get_credit_aging(p_as_of date default public.meter_station_today())
returns table (
  customer_id uuid,
  customer_name text,
  bucket text,
  period_from date,
  period_to date,
  credit_taken numeric,
  settlement_done numeric,
  outstanding numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();

  return query
  with activity as (
    select e.credit_customer_id as cid, e.transaction_date as d, e.amount as credit, 0::numeric as settled
    from public.credit_entries e
    where e.status = 'posted'
      and e.transaction_date <= p_as_of
    union all
    select p.credit_customer_id, p.date, 0::numeric, p.amount
    from public.credit_payments p
    where p.status = 'posted'
      and p.date <= p_as_of
  ),
  bucketed as (
    select
      a.cid,
      a.d,
      a.credit,
      a.settled,
      case
        when p_as_of - a.d <= 30 then '0-30'
        when p_as_of - a.d <= 60 then '31-60'
        when p_as_of - a.d <= 90 then '61-90'
        else '90+'
      end as bucket
    from activity a
  ),
  totals as (
    select
      b.cid,
      b.bucket,
      min(b.d) as first_date,
      sum(b.credit) as credit,
      sum(b.settled) as settled
    from bucketed b
    group by b.cid, b.bucket
  )
  select
    t.cid,
    c.customer_name::text,
    t.bucket,
    case t.bucket
      when '0-30' then p_as_of - 30
      when '31-60' then p_as_of - 60
      when '61-90' then p_as_of - 90
      else t.first_date
    end,
    case t.bucket
      when '0-30' then p_as_of
      when '31-60' then p_as_of - 31
      when '61-90' then p_as_of - 61
      else p_as_of - 91
    end,
    t.credit,
    t.settled,
    t.credit - t.settled
  from totals t
  join public.credit_customers c on c.id = t.cid
  where abs(t.credit - t.settled) > 0.009;
end;
$$;

comment on function public.get_credit_aging(date) is
  'Aging by date window as of p_as_of (0-30, 31-60, 61-90, 90+ days back). One row per customer per window with posted credit taken, settlements, and outstanding = credit - settlements in that window, matching the customer page Activity for the same dates. Negative outstanding is an advance.';

revoke all on function public.get_credit_aging(date) from public, anon;
grant execute on function public.get_credit_aging(date) to authenticated;
