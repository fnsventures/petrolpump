-- Read-only credit statement links a customer can open without a login.
--
-- Staff call create_credit_statement_link(customer_id, days) and share
-- statement.html#t=<token>. Only sha256(token) is stored, so a database read does not
-- reveal working links. The token sits in the URL fragment, so it never reaches the web
-- server or a Referer header.
--
-- anon still executes no app function (rls.test.sql). The public page calls the
-- credit-statement Edge Function, which runs get_credit_statement_by_token as service_role.
-- The statement leaves out staff names and payment notes.

create table if not exists public.credit_statement_links (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_viewed_at timestamptz,
  view_count integer not null default 0
);

create index if not exists credit_statement_links_customer_idx
  on public.credit_statement_links (credit_customer_id, created_at desc);

comment on table public.credit_statement_links is
  'Expiring read-only statement links. token_hash = sha256 hex of the token in statement.html#t=. Written only by create/revoke RPCs and the service-role reader.';

alter table public.credit_statement_links enable row level security;

revoke all on table public.credit_statement_links from anon, authenticated;
grant select on table public.credit_statement_links to authenticated;

drop policy if exists "credit_statement_links_select" on public.credit_statement_links;
create policy "credit_statement_links_select" on public.credit_statement_links
  for select
  to authenticated
  using ((select public.is_supervisor_or_admin()));

create or replace function public.create_credit_statement_link(
  p_customer_id uuid,
  p_valid_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_expires timestamptz;
  v_id uuid;
begin
  if not coalesce(public.is_supervisor_or_admin(), false) then
    raise exception 'Provisioned staff access required';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 90 then
    raise exception 'valid days must be between 1 and 90';
  end if;
  if not exists (select 1 from public.credit_customers c where c.id = p_customer_id) then
    raise exception 'Unknown credit customer';
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(days => p_valid_days);

  insert into public.credit_statement_links (credit_customer_id, token_hash, expires_at, created_by)
  values (p_customer_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_expires, auth.uid())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

comment on function public.create_credit_statement_link(uuid, integer) is
  'Staff: new read-only statement link for a customer, valid 1–90 days. Returns the token once; only its hash is stored.';

revoke execute on function public.create_credit_statement_link(uuid, integer) from public, anon;
grant execute on function public.create_credit_statement_link(uuid, integer) to authenticated;

-- Revokes every live link for the customer's name group (the ledger groups rows by name).
create or replace function public.revoke_credit_statement_links(p_customer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not coalesce(public.is_supervisor_or_admin(), false) then
    raise exception 'Provisioned staff access required';
  end if;

  update public.credit_statement_links l
  set revoked_at = now()
  where l.revoked_at is null
    and l.expires_at > now()
    and l.credit_customer_id in (
      select c2.id
      from public.credit_customers c
      join public.credit_customers c2
        on lower(trim(c2.customer_name)) = lower(trim(c.customer_name))
      where c.id = p_customer_id
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.revoke_credit_statement_links(uuid) is
  'Staff: revoke all live statement links for this customer (all rows sharing the name). Returns how many.';

revoke execute on function public.revoke_credit_statement_links(uuid) from public, anon;
grant execute on function public.revoke_credit_statement_links(uuid) to authenticated;

-- Service role only (credit-statement Edge Function). Null when the token is unknown,
-- expired or revoked. Shows the last 90 days with an opening balance, plus every open bill.
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
  )
  select jsonb_build_object(
    'customer_name', v_name,
    'station_name', coalesce(
      nullif(trim((select s.config #>> '{station,legalName}' from public.pump_settings s where s.id = 1)), ''),
      'BISHNU PRIYA FUELS'),
    'as_of', v_today,
    'from', v_from,
    'expires_at', v_link.expires_at,
    'opening_balance',
      (select coalesce(sum(amount), 0) from e where transaction_date < v_from)
      - (select coalesce(sum(amount), 0) from p where date < v_from),
    'balance',
      (select coalesce(sum(amount), 0) from e where transaction_date <= v_today)
      - (select coalesce(sum(amount), 0) from p where date <= v_today),
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
  'Service role only (credit-statement Edge Function): customer statement for a live link token, or null. No staff names or notes.';

revoke execute on function public.get_credit_statement_by_token(text) from public, anon, authenticated;
grant execute on function public.get_credit_statement_by_token(text) to service_role;
