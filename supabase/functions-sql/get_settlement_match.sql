-- Canonical definition of public.get_settlement_match. Edit here, then:
--   node scripts/sql-functions.mjs emit get_settlement_match
create or replace function public.get_settlement_match(
  p_start date,
  p_end date,
  p_tolerance numeric default null,
  p_lag_days integer default 0
)
returns table (
  business_date date,
  bank_date date,
  app_digital numeric,
  app_source text,
  bank_amount numeric,
  bank_lines integer,
  difference numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tol numeric;
  v_lag int := greatest(least(coalesce(p_lag_days, 0), 7), 0);
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can view settlement matching.';
  end if;
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Choose a valid From / To range.';
  end if;
  if p_end - p_start > 400 then
    raise exception 'Choose a range of 400 days or less.';
  end if;

  v_tol := coalesce(
    p_tolerance,
    (select case when s.config #>> '{alerts,settlementTolerance}' ~ '^[0-9]+(\.[0-9]+)?$'
                 then (s.config #>> '{alerts,settlementTolerance}')::numeric end
     from public.pump_settings s where s.id = 1),
    10
  );

  return query
  with days as (
    select g::date as d from generate_series(p_start, p_end, interval '1 day') g
  ),
  shift_upi as (
    select c.reading_date as d, sum(c.phone_pay) as amt
    from public.meter_shift_cash c
    where c.reading_date between p_start and p_end
    group by 1
  ),
  credit_upi as (
    select cp.date as d, sum(cp.amount) as amt
    from public.credit_payments cp
    where cp.date between p_start and p_end
      and cp.status = 'posted'
      and lower(btrim(coalesce(cp.payment_mode, ''))) = 'upi'
    group by 1
  ),
  closing as (
    select dc.date as d, dc.phone_pay as amt
    from public.day_closing dc
    where dc.date between p_start and p_end
  ),
  bank as (
    select sl.txn_date as d, sum(sl.amount) as amt, count(*)::int as n
    from public.settlement_lines sl
    where sl.txn_date between p_start + v_lag and p_end + v_lag
    group by 1
  ),
  app as (
    select dd.d,
           case when cl.d is not null then cl.amt
                else coalesce(su.amt, 0) + coalesce(cu.amt, 0) end as amt,
           case when cl.d is not null then 'day_closing'
                when su.d is not null or cu.d is not null then 'shift_and_credit'
                else null end as src
    from days dd
    left join closing cl on cl.d = dd.d
    left join shift_upi su on su.d = dd.d
    left join credit_upi cu on cu.d = dd.d
  )
  select a.d,
         (a.d + v_lag)::date,
         a.amt,
         a.src,
         coalesce(b.amt, 0),
         coalesce(b.n, 0),
         coalesce(b.amt, 0) - a.amt,
         case
           when coalesce(a.amt, 0) = 0 and coalesce(b.amt, 0) = 0 then 'none'
           when coalesce(b.n, 0) = 0 then 'missing_bank'
           when coalesce(a.amt, 0) = 0 then 'bank_only'
           when abs(coalesce(b.amt, 0) - a.amt) <= v_tol then 'matched'
           when coalesce(b.amt, 0) < a.amt then 'short'
           else 'excess'
         end
  from app a
  left join bank b on b.d = a.d + v_lag
  where coalesce(a.amt, 0) <> 0 or coalesce(b.amt, 0) <> 0
  order by a.d desc;
end;
$$;

comment on function public.get_settlement_match(date, date, numeric, integer) is
  'Admin: per business date, app digital (day_closing.phone_pay, else shift UPI + UPI credit payments) vs imported statement lines on date + lag. status matched | short | excess | missing_bank | bank_only.';

grant execute on function public.get_settlement_match(date, date, numeric, integer) to authenticated;
