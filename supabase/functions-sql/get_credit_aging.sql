-- Canonical definition of public.get_credit_aging. Edit here, then:
--   node scripts/sql-functions.mjs emit get_credit_aging
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
  with customers as (
    -- One line per name, like the credit list and customer page; the link opens the row that owes most.
    select
      c.id,
      lower(trim(c.customer_name)) as name_key,
      first_value(c.id) over w as primary_id,
      first_value(trim(c.customer_name)) over w as display_name
    from public.credit_customers c
    window w as (
      partition by lower(trim(c.customer_name))
      order by c.amount_due desc nulls last, c.prepaid_balance desc nulls last, c.created_at desc
    )
  ),
  activity as (
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
      cu.name_key,
      cu.primary_id,
      cu.display_name,
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
    join customers cu on cu.id = a.cid
  ),
  totals as (
    select
      b.name_key,
      b.primary_id,
      b.display_name,
      b.bucket,
      min(b.d) as first_date,
      sum(b.credit) as credit,
      sum(b.settled) as settled
    from bucketed b
    group by b.name_key, b.primary_id, b.display_name, b.bucket
  )
  select
    t.primary_id,
    t.display_name,
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
  where abs(t.credit - t.settled) > 0.009;
end;
$$;

comment on function public.get_credit_aging(date) is
  'Aging by date window as of p_as_of (0-30, 31-60, 61-90, 90+ days back). One row per customer name (all its rows summed) per window with posted credit taken, settlements, and outstanding = credit - settlements in that window, matching the customer page Activity for the same dates. customer_id is the row that owes most. Negative outstanding is an advance.';

revoke all on function public.get_credit_aging(date) from public, anon;

grant execute on function public.get_credit_aging(date) to authenticated;

grant execute on function public.get_credit_aging(date) to authenticated;
