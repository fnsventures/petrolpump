-- Employee personal / statutory details (HR roster)

alter table public.employees
  add column if not exists aadhar_number text,
  add column if not exists address text,
  add column if not exists phone_number text,
  add column if not exists pan_number text,
  add column if not exists pf_number text;

alter table public.employees
  drop constraint if exists employees_aadhar_number_check,
  drop constraint if exists employees_phone_number_check,
  drop constraint if exists employees_pan_number_check,
  drop constraint if exists employees_address_check,
  drop constraint if exists employees_pf_number_check;

alter table public.employees
  add constraint employees_aadhar_number_check
    check (aadhar_number is null or aadhar_number ~ '^[0-9]{12}$'),
  add constraint employees_phone_number_check
    check (phone_number is null or phone_number ~ '^[0-9]{10}$'),
  add constraint employees_pan_number_check
    check (pan_number is null or pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  add constraint employees_address_check
    check (address is null or char_length(trim(address)) <= 500),
  add constraint employees_pf_number_check
    check (pf_number is null or (char_length(trim(pf_number)) > 0 and char_length(pf_number) <= 30));

comment on column public.employees.aadhar_number is '12-digit Aadhaar (optional)';
comment on column public.employees.address is 'Residential / correspondence address';
comment on column public.employees.phone_number is '10-digit mobile (optional)';
comment on column public.employees.pan_number is 'PAN in ABCDE1234F format (optional)';
comment on column public.employees.pf_number is 'Provident Fund account / UAN (optional)';
