-- Fixed monthly PF contribution per employee (e.g. ₹200 or ₹150)

alter table public.employees
  add column if not exists pf_contribution numeric(14,2) check (pf_contribution is null or pf_contribution >= 0);

comment on column public.employees.pf_contribution is 'Fixed monthly PF amount in ₹ (employee deduction; employer matches on salary slip).';

drop function if exists public.list_employees_salary();

create or replace function public.list_employees_salary()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint,
  pf_contribution numeric
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
    e.pf_contribution
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
$$;
