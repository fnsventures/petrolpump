-- Canonical definition of public.employees_guard_salary_columns. Edit here, then:
--   node scripts/sql-functions.mjs emit employees_guard_salary_columns
create or replace function public.employees_guard_salary_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.monthly_salary, 0) <> 0 or new.pf_contribution is not null then
      raise exception 'Only an admin can set salary or PF contribution.';
    end if;
    if new.photo_drive_file_id is not null
       or new.aadhaar_drive_file_id is not null
       or new.photo_url is not null then
      raise exception 'Only an admin can set staff document files.';
    end if;
    return new;
  end if;

  if new.monthly_salary is distinct from old.monthly_salary
     or new.pf_contribution is distinct from old.pf_contribution then
    raise exception 'Only an admin can change salary or PF contribution.';
  end if;

  if new.photo_drive_file_id is distinct from old.photo_drive_file_id
     or new.aadhaar_drive_file_id is distinct from old.aadhaar_drive_file_id
     or new.aadhaar_file_name is distinct from old.aadhaar_file_name
     or new.photo_url is distinct from old.photo_url then
    raise exception 'Only an admin can change staff document files.';
  end if;

  return new;
end;
$$;

comment on function public.employees_guard_salary_columns() is
  'Trigger: supervisors may edit an employee profile. Salary, PF, and Drive file ids stay admin-only. The Drive edge function uses the service role.';

revoke all on function public.employees_guard_salary_columns() from public, anon;

grant execute on function public.employees_guard_salary_columns() to authenticated;
