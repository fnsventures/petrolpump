-- Canonical definition of public.set_employee_active. Edit here, then:
--   node scripts/sql-functions.mjs emit set_employee_active
create or replace function public.set_employee_active(
  p_employee_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_employee_id is null then
    raise exception 'Employee id is required';
  end if;

  update public.employees
  set is_active = coalesce(p_is_active, false)
  where id = p_employee_id;

  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

comment on function public.set_employee_active(uuid, boolean) is
  'Admin-only: mark employee active or inactive. Inactive staff are excluded from all operational rosters.';

grant execute on function public.set_employee_active(uuid, boolean) to authenticated;
