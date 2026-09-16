-- Include prepaid_balance in aggregated credit ledger for outstanding list.
-- Must drop first: PostgreSQL cannot change RETURNS TABLE columns via CREATE OR REPLACE.

drop function if exists public.get_credit_ledger_aggregated();

create function public.get_credit_ledger_aggregated()
returns table (
  id uuid,
  customer_name text,
  vehicle_no text,
  amount_due numeric,
  prepaid_balance numeric,
  date date,
  last_payment date,
  notes text
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with ranked as (
    select c.id, c.customer_name, c.vehicle_no, c.amount_due, c.prepaid_balance, c.date, c.last_payment, c.notes,
           row_number() over (
             partition by lower(trim(c.customer_name))
             order by c.amount_due desc nulls last, c.prepaid_balance desc nulls last, c.created_at desc
           ) as rn
    from public.credit_customers c
  ),
  agg as (
    select lower(trim(r.customer_name)) as name_key,
           sum(r.amount_due) as total_due,
           sum(r.prepaid_balance) as total_prepaid,
           min(r.date) as min_date,
           max(r.last_payment) as max_last_pay,
           (array_agg(r.notes order by r.amount_due desc nulls last))[1] as first_notes
    from ranked r
    group by lower(trim(r.customer_name))
  )
  select r.id,
         r.customer_name::text as customer_name,
         r.vehicle_no::text as vehicle_no,
         a.total_due::numeric as amount_due,
         a.total_prepaid::numeric as prepaid_balance,
         a.min_date as date,
         a.max_last_pay as last_payment,
         a.first_notes::text as notes
  from ranked r
  join agg a on lower(trim(r.customer_name)) = a.name_key
  where r.rn = 1
  order by
    case when a.total_prepaid > 0 and a.total_due <= a.total_prepaid then 0 else 1 end,
    case
      when a.total_prepaid > 0 and a.total_due <= a.total_prepaid then a.total_prepaid
      else a.total_due - a.total_prepaid
    end desc nulls last,
    r.customer_name;
end;
$$;

comment on function public.get_credit_ledger_aggregated() is
  'Credit ledger with one row per customer (grouped by name). Advance payments listed first.';

grant execute on function public.get_credit_ledger_aggregated() to authenticated;
