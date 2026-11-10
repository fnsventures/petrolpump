-- Canonical definition of public.set_employee_photo. Edit here, then:
--   node scripts/sql-functions.mjs emit set_employee_photo
create or replace function public.set_employee_photo(p_employee_id uuid, p_photo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Staff access required';
  end if;
  update public.employees
  set
    photo_url = nullif(trim(p_photo_url), ''),
    photo_drive_file_id = case
      when nullif(trim(p_photo_url), '') is null then null
      else photo_drive_file_id
    end
  where id = p_employee_id;
  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

comment on function public.set_employee_photo(uuid, text) is
  'Set or clear photo_url for an active employee (admin or supervisor).';

grant execute on function public.set_employee_photo(uuid, text) to authenticated;
