-- Canonical definition of public.my_avatar_storage_folder. Edit here, then:
--   node scripts/sql-functions.mjs emit my_avatar_storage_folder
create or replace function public.my_avatar_storage_folder()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(regexp_replace(trim(coalesce(auth.jwt() ->> 'email', '')), '[^a-z0-9._-]', '_', 'g'));
$$;

comment on function public.my_avatar_storage_folder() is
  'Storage folder segment for the current user avatar object.';

grant execute on function public.my_avatar_storage_folder() to authenticated;
