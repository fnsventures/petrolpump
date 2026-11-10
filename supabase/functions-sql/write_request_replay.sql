-- Canonical definition of public.write_request_replay. Edit here, then:
--   node scripts/sql-functions.mjs emit write_request_replay
create or replace function public.write_request_replay(p_request_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.write_requests%rowtype;
begin
  if p_request_id is null then
    return null;
  end if;

  -- Concurrent duplicates wait here until the first one commits, then replay its result.
  perform pg_advisory_xact_lock(hashtextextended('write_request:' || p_request_id::text, 0));

  select * into v_row from public.write_requests where request_id = p_request_id;
  if not found then
    return null;
  end if;
  if v_row.kind <> p_kind or v_row.created_by is distinct from auth.uid() then
    raise exception 'Request id already used for a different action';
  end if;
  return v_row.response;
end;
$$;

comment on function public.write_request_replay(uuid, text) is
  'Internal: stored result for a retried request id, or null. Locks the id until commit.';

revoke all on function public.write_request_replay(uuid, text) from public, anon, authenticated;
