-- Remove salary month N/A exclusions. Employment inactive (employees.is_active) is the single status.
-- Guard trigger drop: IF EXISTS only covers the trigger name; the table must also exist.

do $$
begin
  if to_regclass('public.salary_month_exclusions') is not null then
    drop trigger if exists audit_salary_month_exclusions_trigger on public.salary_month_exclusions;
  end if;
end $$;

drop table if exists public.salary_month_exclusions;

comment on column public.employees.is_active is
  'Employment status. false = inactive everywhere (salary, attendance, E-20, settings).';

comment on column public.employees.is_active is
  'Employment status. false = inactive everywhere (salary, attendance, E-20, settings).';
