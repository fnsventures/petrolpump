-- HR Staff page: supervisors may view and edit employee profiles (admin retains delete).

create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();

  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'staff' then v_role in ('admin', 'supervisor')
    when 'analysis' then v_role = 'admin'
    when 'reports' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'day-closing' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit-overdue' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    when 'invoices' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

drop policy if exists "employees_select_admin" on public.employees;
create policy "employees_select_staff" on public.employees
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "employees_insert_admin" on public.employees;
create policy "employees_insert_staff" on public.employees
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "employees_update_admin" on public.employees;
create policy "employees_update_staff" on public.employees
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

create or replace function public.set_employee_photo(p_employee_id uuid, p_photo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Staff access required';
  end if;

  update public.employees
  set photo_url = nullif(trim(p_photo_url), '')
  where id = p_employee_id and is_active = true;

  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

comment on function public.set_employee_photo(uuid, text) is
  'Set or clear photo_url for an active employee (admin or supervisor).';

drop policy if exists "staff_photos_insert_admin" on storage.objects;
create policy "staff_photos_insert_staff" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'staff-photos' and public.is_supervisor_or_admin());

drop policy if exists "staff_photos_update_admin" on storage.objects;
create policy "staff_photos_update_staff" on storage.objects
  for update to authenticated
  using (bucket_id = 'staff-photos' and public.is_supervisor_or_admin())
  with check (bucket_id = 'staff-photos' and public.is_supervisor_or_admin());

drop policy if exists "staff_photos_delete_admin" on storage.objects;
create policy "staff_photos_delete_staff" on storage.objects
  for delete to authenticated
  using (bucket_id = 'staff-photos' and public.is_supervisor_or_admin());

comment on table public.employees is
  'Pump employees who receive salary. Mutations: admin or supervisor (delete: admin only). Used for salary and attendance.';
