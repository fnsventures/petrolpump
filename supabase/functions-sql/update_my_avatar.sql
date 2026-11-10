-- Canonical definition of public.update_my_avatar. Edit here, then:
--   node scripts/sql-functions.mjs emit update_my_avatar
create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  update public.users
  set avatar_url = nullif(trim(p_avatar_url), '')
  where auth_user_id = auth.uid();
  if not found then
    raise exception 'User not provisioned';
  end if;
end;
$$;

comment on function public.update_my_avatar(text) is
  'Set or clear avatar_url for the current login (own row only).';

grant execute on function public.update_my_avatar(text) to authenticated;
