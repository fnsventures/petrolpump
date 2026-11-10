-- Canonical definition of public.is_admin. Edit here, then:
--   node scripts/sql-functions.mjs emit is_admin
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    else coalesce(public.get_user_role() = 'admin', false)
  end;
$$;

comment on function public.is_admin() is
  'True when auth.uid() is a provisioned admin. False for any other login. Null when there is no login (restore / SQL editor).';
