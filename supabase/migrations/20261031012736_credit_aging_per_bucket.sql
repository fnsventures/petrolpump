-- Aging: split each customer's open bills across buckets by bill age, instead of
-- putting the whole balance in the bucket of the oldest unpaid bill.

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
declare
  v_cust uuid;
  v_ids uuid[];
  v_dates date[];
  v_amounts numeric[];
  v_settled numeric[];
  v_pay record;
  v_i int;
  v_n int;
  v_remaining numeric;
  v_open numeric;
  v_alloc numeric;
  v_pool numeric;
  v_open_amount numeric;
  v_oldest date;
  v_name text;
  v_bucket text;
  v_age integer;
begin
  perform public.require_staff_access();

  for v_cust in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.status = 'posted'
      and e.transaction_date <= p_as_of
  loop
    select
      array_agg(id order by transaction_date asc, id asc),
      array_agg(transaction_date order by transaction_date asc, id asc),
      array_agg(amount order by transaction_date asc, id asc)
    into v_ids, v_dates, v_amounts
    from public.credit_entries
    where credit_customer_id = v_cust
      and status = 'posted'
      and transaction_date <= p_as_of;

    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n = 0 then
      continue;
    end if;
    v_settled := array_fill(0::numeric, array[v_n]);

    for v_pay in
      select amount, date
      from public.credit_payments
      where credit_customer_id = v_cust
        and status = 'posted'
        and date <= p_as_of
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_i in reverse v_n..1 loop
        exit when v_remaining <= 0;
        if v_dates[v_i] > v_pay.date then
          continue;
        end if;
        v_open := v_amounts[v_i] - v_settled[v_i];
        if v_open <= 0 then
          continue;
        end if;
        v_alloc := least(v_remaining, v_open);
        v_settled[v_i] := v_settled[v_i] + v_alloc;
        v_remaining := v_remaining - v_alloc;
      end loop;
    end loop;

    select coalesce(sum(amount), 0) into v_pool
    from public.credit_payments
    where credit_customer_id = v_cust
      and status = 'posted'
      and date <= p_as_of;

    v_pool := v_pool - coalesce((select sum(x) from unnest(v_settled) as x), 0);
    for v_i in 1..v_n loop
      exit when v_pool <= 0;
      v_open := v_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_pool, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_pool := v_pool - v_alloc;
    end loop;

    select c.customer_name into v_name
    from public.credit_customers c
    where c.id = v_cust;

    -- One row per bucket, holding only the open bills in that age range.
    foreach v_bucket in array array['0-30', '31-60', '61-90', '90+'] loop
      v_open_amount := 0;
      v_oldest := null;
      for v_i in 1..v_n loop
        v_open := v_amounts[v_i] - v_settled[v_i];
        if v_open <= 0 then
          continue;
        end if;
        v_age := (p_as_of - v_dates[v_i])::integer;
        if (case
              when v_age <= 30 then '0-30'
              when v_age <= 60 then '31-60'
              when v_age <= 90 then '61-90'
              else '90+'
            end) <> v_bucket then
          continue;
        end if;
        v_open_amount := v_open_amount + v_open;
        if v_oldest is null or v_dates[v_i] < v_oldest then
          v_oldest := v_dates[v_i];
        end if;
      end loop;

      if v_open_amount > 0 and v_oldest is not null then
        customer_id := v_cust;
        customer_name := v_name;
        open_amount := v_open_amount;
        oldest_unpaid := v_oldest;
        age_days := (p_as_of - v_oldest)::integer;
        bucket := v_bucket;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

comment on function public.get_credit_aging(date) is
  'Open credit as of p_as_of, one row per customer per bucket (0-30, 31-60, 61-90, 90+). Each row holds only the open bills whose age falls in that bucket. Payments after p_as_of are left out.';

grant execute on function public.get_credit_aging(date) to authenticated;
