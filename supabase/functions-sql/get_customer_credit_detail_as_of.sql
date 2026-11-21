-- Canonical definition of public.get_customer_credit_detail_as_of. Edit here, then:
--   node scripts/sql-functions.mjs emit get_customer_credit_detail_as_of
create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date,
  p_from date default null
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb,
  opening_balance numeric,
  closing_balance numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_from date := p_from;
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  opening as (
    select
      coalesce(sum(e.amount) filter (where e.status = 'posted' and (v_from is not null and e.transaction_date < v_from)), 0)
      - coalesce(sum(0), 0) as credit_before
    from public.credit_entries e
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
  ),
  pay_before as (
    select coalesce(sum(p.amount), 0) as paid_before
    from public.credit_payments p
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.status = 'posted'
      and v_from is not null
      and p.date < v_from
  ),
  period_credit as (
    select coalesce(sum(e.amount), 0) as credit_taken,
           min(e.transaction_date) as first_sale_date,
           max(e.transaction_date) as last_credit_date
    from public.credit_entries e
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
      and e.status = 'posted'
      and e.transaction_date <= p_date
      and (v_from is null or e.transaction_date >= v_from)
  ),
  period_pay as (
    select coalesce(sum(p.amount), 0) as settlement_done,
           max(p.date) as last_payment_date
    from public.credit_payments p
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.status = 'posted'
      and p.date <= p_date
      and (v_from is null or p.date >= v_from)
  ),
  name_row as (
    select max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where c.id in (select credit_customer_id from customer_ids)
  ),
  credits_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'entry_date', e.transaction_date,
        'amount', e.amount,
        'fuel_type', e.fuel_type,
        'quantity', e.quantity,
        'amount_settled', e.amount_settled,
        'status', e.status,
        'entry_kind', e.entry_kind,
        'created_by_name', coalesce(nullif(trim(u.display_name), ''), nullif(trim(u.email), ''), '')
      ) order by e.transaction_date, e.created_at, e.id
    ), '[]'::jsonb) as entries
    from public.credit_entries e
    left join public.users u on u.auth_user_id = e.created_by
    where e.credit_customer_id in (select credit_customer_id from customer_ids)
      and e.transaction_date <= p_date
      and (v_from is null or e.transaction_date >= v_from)
  ),
  payments_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'entry_date', p.date,
        'amount', p.amount,
        'payment_mode', p.payment_mode,
        'note', p.note,
        'same_day_settlement', coalesce(p.same_day_settlement, false),
        'status', p.status,
        'created_by_name', coalesce(nullif(trim(u.display_name), ''), nullif(trim(u.email), ''), '')
      ) order by p.date, p.created_at, p.id
    ), '[]'::jsonb) as entries
    from public.credit_payments p
    left join public.users u on u.auth_user_id = p.created_by
    where p.credit_customer_id in (select credit_customer_id from customer_ids)
      and p.date <= p_date
      and (v_from is null or p.date >= v_from)
  )
  select
    n.customer_name,
    n.vehicle_no,
    pc.credit_taken,
    pp.settlement_done,
    (pc.credit_taken - pp.settlement_done),
    pp.last_payment_date,
    pc.first_sale_date,
    pc.last_credit_date,
    cj.entries,
    pj.entries,
    case when v_from is null then 0::numeric
         else (select coalesce(sum(e.amount), 0) from public.credit_entries e
               where e.credit_customer_id in (select credit_customer_id from customer_ids)
                 and e.status = 'posted' and e.transaction_date < v_from)
            - (select paid_before from pay_before)
    end,
    case when v_from is null then (pc.credit_taken - pp.settlement_done)
         else (
           (select coalesce(sum(e.amount), 0) from public.credit_entries e
            where e.credit_customer_id in (select credit_customer_id from customer_ids)
              and e.status = 'posted' and e.transaction_date < v_from)
           - (select paid_before from pay_before)
           + pc.credit_taken - pp.settlement_done
         )
    end
  from name_row n
  cross join period_credit pc
  cross join period_pay pp
  cross join credits_json cj
  cross join payments_json pj;
end;
$$;

comment on function public.get_customer_credit_detail_as_of(text, date, date) is
  'Customer statement for a date range. Totals, opening and closing come from SQL. p_from null means all history up to p_date.';

grant execute on function public.get_customer_credit_detail_as_of(text, date, date) to authenticated;
