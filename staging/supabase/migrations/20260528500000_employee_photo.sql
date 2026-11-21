-- Staff ID card photo (admin upload → public staff-photos bucket)

alter table public.employees
  add column if not exists photo_url text;

comment on column public.employees.photo_url is 'Public URL of staff photo for ID card (staff-photos bucket).';

create or replace function public.set_employee_photo(p_employee_id uuid, p_photo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;

  update public.employees
  set photo_url = nullif(trim(p_photo_url), '')
  where id = p_employee_id and is_active = true;

  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

comment on function public.set_employee_photo(uuid, text) is
  'Set or clear photo_url for an active employee (admin only).';

grant execute on function public.set_employee_photo(uuid, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-photos',
  'staff-photos',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "staff_photos_select" on storage.objects;
create policy "staff_photos_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'staff-photos');

drop policy if exists "staff_photos_insert_admin" on storage.objects;
create policy "staff_photos_insert_admin" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'staff-photos' and public.is_admin());

drop policy if exists "staff_photos_update_admin" on storage.objects;
create policy "staff_photos_update_admin" on storage.objects
  for update to authenticated
  using (bucket_id = 'staff-photos' and public.is_admin())
  with check (bucket_id = 'staff-photos' and public.is_admin());

drop policy if exists "staff_photos_delete_admin" on storage.objects;
create policy "staff_photos_delete_admin" on storage.objects
  for delete to authenticated
  using (bucket_id = 'staff-photos' and public.is_admin());
