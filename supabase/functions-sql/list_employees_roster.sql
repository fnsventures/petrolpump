-- Canonical definition of public.list_employees_roster. Edit here, then:
--   node scripts/sql-functions.mjs emit list_employees_roster
create or replace function public.list_employees_roster()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  select e.id, e.name, e.role_display, e.monthly_salary, e.display_order
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
end;
$$;

comment on function public.list_employees_roster() is
  'Active employees without PII — for salary and attendance (all authenticated).';

grant execute on function public.list_employees_roster() to authenticated;
