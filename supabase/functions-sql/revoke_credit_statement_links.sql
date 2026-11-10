-- Canonical definition of public.revoke_credit_statement_links. Edit here, then:
--   node scripts/sql-functions.mjs emit revoke_credit_statement_links
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
