-- Canonical definition of public.get_employees_by_ids. Edit here, then:
--   node scripts/sql-functions.mjs emit get_employees_by_ids
create or replace function public.get_employees_by_ids(p_ids uuid[])
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint,
  phone_number text,
  aadhar_number text,
  address text,
  pan_number text,
  pf_number text,
  pf_contribution numeric,
  blood_group text,
  photo_url text,
  date_of_birth date,
  id_valid_from date,
  id_valid_to date,
  is_active boolean,
  photo_drive_file_id text,
  aadhaar_drive_file_id text,
  aadhaar_file_name text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  return query
  select
    e.id,
    e.name,
    e.role_display,
    e.monthly_salary,
    e.display_order,
    e.phone_number,
    e.aadhar_number,
    e.address,
    e.pan_number,
    e.pf_number,
    e.pf_contribution,
    e.blood_group,
    e.photo_url,
    e.date_of_birth,
    e.id_valid_from,
    e.id_valid_to,
    e.is_active,
    e.photo_drive_file_id,
    e.aadhaar_drive_file_id,
    e.aadhaar_file_name
  from public.employees e
  where e.id = any (p_ids);
end;
$$;

comment on function public.get_employees_by_ids(uuid[]) is
  'Lookup employees by id including inactive — for historical salary/attendance display.';

grant execute on function public.get_employees_by_ids(uuid[]) to authenticated;
