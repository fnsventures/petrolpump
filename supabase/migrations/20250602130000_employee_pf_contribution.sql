-- Fixed monthly PF contribution per employee (e.g. ₹200 or ₹150)

alter table public.employees
  add column if not exists pf_contribution numeric(14,2) check (pf_contribution is null or pf_contribution >= 0);

comment on column public.employees.pf_contribution is 'Fixed monthly PF amount in ₹ (employee deduction; employer matches on salary slip).';

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
