-- Period outstanding = credit taken in range minus settlements in range (not per-entry FIFO).

create or replace function public.get_credit_overview_period(
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.require_staff_access();

  with credit_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(e.amount), 0)::numeric as credit_taken
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date >= p_from
      and e.transaction_date <= p_to
    group by lower(trim(c.customer_name))
  ),
  payment_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(p.amount), 0)::numeric as settled
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date >= p_from
      and p.date <= p_to
    group by lower(trim(c.customer_name))
  ),
  merged as (
    select coalesce(c.customer_name, p.customer_name) as customer_name,
           coalesce(c.credit_taken, 0) as credit_taken,
           coalesce(p.settled, 0) as settled,
           coalesce(c.credit_taken, 0) - coalesce(p.settled, 0) as overdue
    from credit_agg c
    full outer join payment_agg p using (name_key)
  ),
  active as (
    select customer_name, credit_taken, settled, overdue
    from merged
    where credit_taken > 0 or settled > 0
  ),
  totals as (
    select
      coalesce((select sum(credit_taken) from credit_agg), 0)::numeric as credit_taken,
      coalesce((select sum(settled) from payment_agg), 0)::numeric as settled,
      coalesce((select sum(credit_taken) from credit_agg), 0)
        - coalesce((select sum(settled) from payment_agg), 0) as overdue
  ),
  top_customers as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'credit_taken', s.credit_taken,
          'settled', s.settled,
          'overdue', s.overdue
        )
        order by s.credit_taken desc, s.customer_name
      ),
      '[]'::jsonb
    ) as rows
    from (
      select customer_name, credit_taken, settled, overdue
      from active
      order by credit_taken desc, customer_name
      limit 50
    ) s
  )
  select jsonb_build_object(
    'credit_taken', t.credit_taken,
    'settled', t.settled,
    'overdue', t.overdue,
    'customers', tc.rows
  )
  into v_result
  from totals t
  cross join top_customers tc;

  return v_result;
end;
$$;

comment on function public.get_credit_overview_period(date, date) is
  'Portfolio credit activity for a date range: totals and per-customer breakdown (one round-trip).';

grant execute on function public.get_credit_overview_period(date, date) to authenticated;
