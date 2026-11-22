-- Canonical definition of public.is_supervisor_or_admin. Edit here, then:
--   node scripts/sql-functions.mjs emit is_supervisor_or_admin
create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    else coalesce(public.get_user_role() in ('admin', 'supervisor'), false)
  end;
$$;

comment on function public.is_supervisor_or_admin() is
  'True when auth.uid() is provisioned staff. False for any other login. Null when there is no login (restore / SQL editor).';
