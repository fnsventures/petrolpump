-- Profile photo: users.avatar_url + storage bucket + self-service update

alter table public.users
  add column if not exists avatar_url text;

comment on column public.users.avatar_url is 'Public URL of operator profile photo (Supabase Storage user-avatars bucket).';

-- Sanitized folder name per login email (storage path segment)
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

create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.jwt() ->> 'email' is null or trim(auth.jwt() ->> 'email') = '' then
    raise exception 'Not authenticated';
  end if;

  update public.users
  set avatar_url = nullif(trim(p_avatar_url), '')
  where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'));

  if not found then
    raise exception 'User not provisioned';
  end if;
end;
$$;

comment on function public.update_my_avatar(text) is
  'Set or clear avatar_url for the current login (own row only).';

grant execute on function public.update_my_avatar(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-avatars',
  'user-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "user_avatars_select" on storage.objects;
create policy "user_avatars_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-avatars');

drop policy if exists "user_avatars_insert_own" on storage.objects;
create policy "user_avatars_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = public.my_avatar_storage_folder()
  );

drop policy if exists "user_avatars_update_own" on storage.objects;
create policy "user_avatars_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = public.my_avatar_storage_folder()
  )
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = public.my_avatar_storage_folder()
  );

drop policy if exists "user_avatars_delete_own" on storage.objects;
create policy "user_avatars_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = public.my_avatar_storage_folder()
  );
