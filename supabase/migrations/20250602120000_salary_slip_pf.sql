-- Salary slip: PF/UAN for supervisors via dedicated RPC (employees table remains admin-only for direct SELECT)

create or replace function public.list_employees_salary()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint
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
    e.display_order
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
$$;

comment on function public.list_employees_salary() is
  'Active employees for salary slips (supervisors; admins use employees table).';

grant execute on function public.list_employees_salary() to authenticated;
