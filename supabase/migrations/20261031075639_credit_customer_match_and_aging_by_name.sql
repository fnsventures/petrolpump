-- 1. add_credit_entry without a mobile matched only same-name rows that had no
--    mobile. Once the customer edit dialog saved a mobile, the next sale for that
--    name created a new duplicate customer. Now it falls back to the existing
--    same-name customer when all its rows share one mobile.
-- 2. get_credit_aging grouped by customer row, so a customer with several rows
--    (one per vehicle or mobile) showed split, partial amounts. Group by name,
--    as the customer page does.

create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null,
  p_mobile text default null,
  p_address text default null,
  p_employee_id uuid default null,
  p_shift text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
  v_shift text;
  v_name text;
  v_mobile text;
  v_name_matches int;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_credit_entry');
  if v_replay is not null then
    return v_replay;
  end if;

  v_name := trim(p_customer_name);
  if v_name is null or v_name = '' then
    raise exception 'customer name is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > public.meter_station_today() then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'shift must be morning or afternoon';
  end if;
  if (p_employee_id is null) <> (v_shift is null) then
    raise exception 'employee_id and shift must both be set or both be null';
  end if;
  if p_employee_id is not null then
    perform public.require_meter_shift_writable(p_transaction_date, v_shift);
    if not exists (
      select 1 from public.employees e
      where e.id = p_employee_id and coalesce(e.is_active, true)
    ) then
      raise exception 'Unknown or inactive staff';
    end if;
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  v_mobile := nullif(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), '');
  perform pg_advisory_xact_lock(hashtext(lower(v_name) || ':' || coalesce(v_mobile, '')));

  if v_mobile is not null then
    select id into v_customer_id
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = v_mobile
    limit 1;
  else
    select count(*) into v_name_matches
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null;
    if v_name_matches > 1 then
      raise exception 'More than one customer is named %. Enter a mobile number.', v_name;
    end if;
    select id into v_customer_id
    from public.credit_customers
    where lower(trim(customer_name)) = lower(v_name)
      and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null
    limit 1;
    -- No mobile-less row: use the same-name customer if all its rows share one mobile.
    if v_customer_id is null then
      if (
        select count(distinct regexp_replace(mobile, '\D', '', 'g'))
        from public.credit_customers
        where lower(trim(customer_name)) = lower(v_name)
      ) > 1 then
        raise exception 'More than one customer is named %. Enter a mobile number.', v_name;
      end if;
      select id into v_customer_id
      from public.credit_customers
      where lower(trim(customer_name)) = lower(v_name)
      order by amount_due desc nulls last, created_at desc
      limit 1;
    end if;
  end if;

  if v_customer_id is null then
    begin
      insert into public.credit_customers (
        customer_name, vehicle_no, amount_due, date, notes, mobile, address, created_by
      )
      values (
        v_name,
        nullif(trim(p_vehicle_no), ''),
        0,
        p_transaction_date,
        nullif(trim(p_notes), ''),
        nullif(trim(p_mobile), ''),
        nullif(trim(p_address), ''),
        auth.uid()
      )
      returning id into v_customer_id;
    exception
      when unique_violation then
        select id into v_customer_id
        from public.credit_customers
        where lower(trim(customer_name)) = lower(v_name)
          and (
            (v_mobile is not null and regexp_replace(coalesce(mobile, ''), '\D', '', 'g') = v_mobile)
            or (
              v_mobile is null
              and nullif(regexp_replace(coalesce(mobile, ''), '\D', '', 'g'), '') is null
            )
          )
        limit 1;
    end;
  elsif nullif(trim(p_mobile), '') is not null
     or nullif(trim(p_address), '') is not null
     or nullif(trim(p_vehicle_no), '') is not null then
    update public.credit_customers
    set
      mobile = coalesce(nullif(trim(p_mobile), ''), mobile),
      address = coalesce(nullif(trim(p_address), ''), address),
      vehicle_no = coalesce(nullif(trim(p_vehicle_no), ''), vehicle_no)
    where id = v_customer_id;
  end if;

  perform public.raise_if_day_closing_certified(p_transaction_date);

  perform 1 from public.credit_customers where id = v_customer_id for update;

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift, entry_kind, status
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift, 'sale', 'posted'
  )
  returning id into v_entry_id;

  perform public.credit_settle_latest_sale(v_customer_id, v_entry_id, p_transaction_date, p_amount);

  v_out := jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
  perform public.write_request_store(p_request_id, 'add_credit_entry', v_out);
  return v_out;
end;
$$;

comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text, uuid) is
  'Add a credit sale. Without a mobile, matches the same-name customer (a mobile-less row, else the only mobile on that name). Locks the customer row before applying prepaid. Rejects a certified day and future dates (IST). Retry-safe with p_request_id.';

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
