-- Canonical definition of public.require_staff_access. Edit here, then:
--   node scripts/sql-functions.mjs emit require_staff_access
create or replace function public.require_staff_access()
returns void
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  -- No login: table owner, service role, or a restore. Not a signed-up stranger.
  if auth.uid() is null then
    return;
  end if;
  if not public.is_supervisor_or_admin() then
    raise exception 'Provisioned staff access required';
  end if;
end;
$$;

comment on function public.require_staff_access() is
  'Raises unless the caller is a provisioned admin or supervisor. No-op when there is no login.';

grant execute on function public.require_staff_access() to authenticated;
