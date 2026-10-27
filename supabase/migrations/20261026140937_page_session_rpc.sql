-- One round trip at page start: the caller's role and profile plus the page access verdict.
-- Page rules stay in check_page_access, so a new page still only adds a branch there.

create or replace function public.get_page_session(p_page text default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user record;
  v_access jsonb;
begin
  select u.role, nullif(trim(u.display_name), '') as display_name, nullif(trim(u.avatar_url), '') as avatar_url
  into v_user
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1;

  if p_page is not null then
    v_access := public.check_page_access(p_page);
  end if;

  return jsonb_build_object(
    'role', v_user.role,
    'display_name', v_user.display_name,
    'avatar_url', v_user.avatar_url,
    'page', p_page,
    'allowed', case when p_page is null then null else coalesce((v_access->>'allowed')::boolean, false) end
  );
end;
$$;

comment on function public.get_page_session(text) is
  'Page start: role, display_name and avatar_url from public.users for auth.uid(), and check_page_access(p_page).allowed. UX and defense-in-depth only; RLS and RPC guards enforce access.';

revoke all on function public.get_page_session(text) from public, anon;
grant execute on function public.get_page_session(text) to authenticated;
