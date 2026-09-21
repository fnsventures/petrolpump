-- Google Drive archive for sales invoices, official letters, staff photos, and Aadhaar cards.
-- Files live in Drive; Postgres keeps listing metadata and Drive file IDs.

alter table public.invoices
  add column if not exists drive_file_id text,
  add column if not exists drive_folder_id text,
  add column if not exists drive_web_view_link text,
  add column if not exists drive_file_name text;

comment on column public.invoices.drive_file_id is
  'Google Drive file ID for the generated sales invoice document.';
comment on column public.invoices.drive_web_view_link is
  'Google Drive view link for the archived sales invoice.';

alter table public.letterhead_letters
  add column if not exists drive_file_id text,
  add column if not exists drive_folder_id text,
  add column if not exists drive_web_view_link text,
  add column if not exists drive_file_name text,
  add column if not exists mime_type text;

comment on table public.letterhead_letters is
  'History of typed station letters. Document files are stored in Google Drive; body is kept for in-app preview.';
comment on column public.letterhead_letters.drive_file_id is
  'Google Drive file ID for the archived letter document.';

alter table public.employees
  add column if not exists photo_drive_file_id text,
  add column if not exists aadhaar_drive_file_id text,
  add column if not exists aadhaar_file_name text;

comment on column public.employees.photo_url is
  'Display URL for staff ID photo (Google Drive public image link).';
comment on column public.employees.photo_drive_file_id is
  'Google Drive file ID for the staff photo.';
comment on column public.employees.aadhaar_drive_file_id is
  'Google Drive file ID for the attached Aadhaar card (private; download via edge function).';
comment on column public.employees.aadhaar_file_name is
  'Original/stored Aadhaar file name in Google Drive.';

comment on table public.invoice_documents is
  'Pump vault documents stored in Google Drive under 01 Finance / 03 Compliance.';

-- Recreate staff list RPCs so the Staff page can show Drive photo + Aadhaar attachment metadata.
drop function if exists public.list_employees_salary();
create function public.list_employees_salary()
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

drop function if exists public.get_employees_by_ids(uuid[]);
create function public.get_employees_by_ids(p_ids uuid[])
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
