-- Canonical definition of public.write_request_store. Edit here, then:
--   node scripts/sql-functions.mjs emit write_request_store
create or replace function public.write_request_store(p_request_id uuid, p_kind text, p_response jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_request_id is null then
    return;
  end if;

  insert into public.write_requests (request_id, kind, created_by, response)
  values (p_request_id, p_kind, auth.uid(), p_response)
  on conflict (request_id) do nothing;

  delete from public.write_requests
  where created_at < timezone('utc'::text, now()) - interval '14 days';
end;
$$;

comment on function public.write_request_store(uuid, text, jsonb) is
  'Internal: remember the result of a request id (same transaction as the write).';

revoke all on function public.write_request_store(uuid, text, jsonb) from public, anon, authenticated;
