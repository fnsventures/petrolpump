-- Date of birth and ID validity for staff badge (front / back)

alter table public.employees
  add column if not exists date_of_birth date,
  add column if not exists id_valid_from date,
  add column if not exists id_valid_to date;

comment on column public.employees.date_of_birth is 'Date of birth (shown on staff ID card).';
comment on column public.employees.id_valid_from is 'ID card valid from (back of card).';
comment on column public.employees.id_valid_to is 'ID card valid until (back of card).';

drop function if exists public.list_employees_salary();

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
  id_valid_to date
)
language sql
security definer
stable
as $$
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
    e.id_valid_to
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
$$;
