-- Canonical definition of public.create_credit_statement_link. Edit here, then:
--   node scripts/sql-functions.mjs emit create_credit_statement_link
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
