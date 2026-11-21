-- Canonical definition of public.get_user_role. Edit here, then:
--   node scripts/sql-functions.mjs emit get_user_role
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role
  from public.users
  where auth_user_id = auth.uid()
  limit 1;
$$;

comment on function public.get_user_role() is
  'Returns admin/supervisor from public.users for auth.uid(). Null if not provisioned.';
