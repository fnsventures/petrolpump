-- Canonical definition of public.link_app_user_auth_id. Edit here, then:
--   node scripts/sql-functions.mjs emit link_app_user_auth_id
create or replace function public.link_app_user_auth_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
  set auth_user_id = new.id
  where auth_user_id is null
    and lower(trim(email)) = lower(trim(new.email));
  return new;
end;
$$;

comment on function public.link_app_user_auth_id() is
  'Links a new Auth user to a public.users row that does not yet have auth_user_id.';

revoke all on function public.link_app_user_auth_id() from public, anon, authenticated;
