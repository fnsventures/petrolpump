-- Canonical definition of public.set_app_user_auth_id. Edit here, then:
--   node scripts/sql-functions.mjs emit set_app_user_auth_id
create or replace function public.set_app_user_auth_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_id uuid;
begin
  select a.id
  into v_auth_id
  from auth.users a
  where lower(trim(a.email)) = lower(trim(new.email))
  limit 1;

  if v_auth_id is not null then
    new.auth_user_id := v_auth_id;
  end if;
  return new;
end;
$$;

comment on function public.set_app_user_auth_id() is
  'Sets users.auth_user_id from auth.users when the emails match.';

revoke all on function public.set_app_user_auth_id() from public, anon, authenticated;
