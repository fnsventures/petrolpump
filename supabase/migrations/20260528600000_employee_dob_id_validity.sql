-- Date of birth and ID validity for staff badge (front / back)

alter table public.employees
  add column if not exists date_of_birth date,
  add column if not exists id_valid_from date,
  add column if not exists id_valid_to date;

comment on column public.employees.date_of_birth is 'Date of birth (shown on staff ID card).';
comment on column public.employees.id_valid_from is 'ID card valid from (back of card).';
comment on column public.employees.id_valid_to is 'ID card valid until (back of card).';
