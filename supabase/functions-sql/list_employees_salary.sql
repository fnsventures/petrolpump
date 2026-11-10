-- Canonical definition of public.list_employees_salary. Edit here, then:
--   node scripts/sql-functions.mjs emit list_employees_salary
create or replace function public.list_employees_salary()
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
    e.photo_drive_file_id,
    e.aadhaar_drive_file_id,
    e.aadhaar_file_name
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
end;
$$;

comment on function public.list_employees_salary() is
  'Active employees with HR Staff page fields for salary slips (provisioned staff only).';

grant execute on function public.list_employees_salary() to authenticated;
