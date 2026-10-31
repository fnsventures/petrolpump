-- Customer statement (statement.html) as a branded document: station letterhead details,
-- period totals and a ledger with a running balance, all from SQL so the page shows the
-- same figures as the ledger. credits / payments stay in the payload for an older page
-- still cached on a customer's phone.

create or replace function public.get_credit_statement_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.credit_statement_links%rowtype;
  v_name text;
  v_today date := public.meter_station_today();
  v_from date := public.meter_station_today() - 90;
  v_station jsonb;
  v_out jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select * into v_link
  from public.credit_statement_links l
  where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and l.revoked_at is null
    and l.expires_at > now();
  if not found then
    return null;
  end if;

  update public.credit_statement_links
  set last_viewed_at = now(), view_count = view_count + 1
  where id = v_link.id;

  select trim(c.customer_name) into v_name
  from public.credit_customers c
  where c.id = v_link.credit_customer_id;

  select coalesce(s.config -> 'station', '{}'::jsonb) into v_station
  from public.pump_settings s
  where s.id = 1;
  v_station := coalesce(v_station, '{}'::jsonb);

  with ids as (
    select c.id from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(v_name)
  ),
  e as (
    select * from public.credit_entries
    where credit_customer_id in (select id from ids) and status = 'posted'
  ),
  p as (
    select * from public.credit_payments
    where credit_customer_id in (select id from ids) and status = 'posted'
  ),
  opening as (
    select
      (select coalesce(sum(amount), 0) from e where transaction_date < v_from)
      - (select coalesce(sum(amount), 0) from p where date < v_from) as amount
  ),
  moves as (
    select e.transaction_date as d, e.created_at as at, 0 as ord,
           case when e.entry_kind = 'opening' then 'opening' else 'fuel' end as kind,
           e.fuel_type, e.quantity, null::text as mode, e.amount as amount
    from e where e.transaction_date between v_from and v_today
    union all
    select p.date, p.created_at, 1, 'payment', null, null, p.payment_mode, -p.amount
    from p where p.date between v_from and v_today
  ),
  lines as (
    select m.*,
           (select amount from opening)
             + sum(m.amount) over (order by m.d, m.ord, m.at rows unbounded preceding) as balance
    from moves m
  )
  select jsonb_build_object(
    'customer_name', v_name,
    'station_name', coalesce(nullif(trim(v_station ->> 'legalName'), ''), 'BISHNU PRIYA FUELS'),
    'station', jsonb_build_object(
      'name', coalesce(nullif(trim(v_station ->> 'legalName'), ''), 'BISHNU PRIYA FUELS'),
      'tagline', coalesce(nullif(trim(v_station ->> 'tagline'), ''),
        'Authorized Dealer — Bharat Petroleum Corporation Ltd.'),
      'address', nullif(trim(v_station ->> 'address'), ''),
      'gstin', nullif(trim(v_station ->> 'gstin'), ''),
      'mobile', nullif(trim(v_station ->> 'mobile'), ''),
      'email', nullif(trim(v_station ->> 'email'), '')
    ),
    'as_of', v_today,
    'from', v_from,
    'expires_at', v_link.expires_at,
    'opening_balance', (select amount from opening),
    'balance',
      (select coalesce(sum(amount), 0) from e where transaction_date <= v_today)
      - (select coalesce(sum(amount), 0) from p where date <= v_today),
    'period_billed',
      (select coalesce(sum(amount), 0) from e where transaction_date between v_from and v_today),
    'period_paid',
      (select coalesce(sum(amount), 0) from p where date between v_from and v_today),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', d, 'kind', kind, 'fuel_type', fuel_type, 'quantity', quantity,
               'mode', mode, 'amount', amount, 'balance', balance
             ) order by d, ord, at), '[]'::jsonb)
      from lines),
    'credits', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', transaction_date, 'amount', amount, 'fuel_type', fuel_type,
               'quantity', quantity, 'opening', entry_kind = 'opening'
             ) order by transaction_date, created_at), '[]'::jsonb)
      from e where transaction_date between v_from and v_today),
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', date, 'amount', amount, 'mode', payment_mode
             ) order by date, created_at), '[]'::jsonb)
      from p where date between v_from and v_today),
    'open_bills', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', transaction_date, 'amount', amount, 'open', amount - amount_settled,
               'age_days', v_today - transaction_date
             ) order by transaction_date, created_at), '[]'::jsonb)
      from e where amount - amount_settled > 0.009)
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.get_credit_statement_by_token(text) is
  'Service role only (credit-statement Edge Function): customer statement for a live link token, or null. Station letterhead fields, period totals, ledger lines with running balance. No staff names or notes.';

revoke execute on function public.get_credit_statement_by_token(text) from public, anon, authenticated;
grant execute on function public.get_credit_statement_by_token(text) to service_role;
