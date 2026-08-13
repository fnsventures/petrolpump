-- Remove salary month N/A exclusions. Employment inactive (employees.is_active) is the single status.

drop trigger if exists audit_salary_month_exclusions_trigger on public.salary_month_exclusions;
drop table if exists public.salary_month_exclusions;

comment on column public.employees.is_active is
  'Employment status. false = inactive everywhere (salary, attendance, E-20, settings).';
