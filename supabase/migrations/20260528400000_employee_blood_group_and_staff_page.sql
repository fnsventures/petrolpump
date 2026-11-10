-- Blood group for printable staff ID cards; staff page access (admin only).

alter table public.employees
  add column if not exists blood_group text;

alter table public.employees
  drop constraint if exists employees_blood_group_check;

alter table public.employees
  add constraint employees_blood_group_check
  check (
    blood_group is null
    or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  );

comment on column public.employees.blood_group is 'Blood group shown on printable staff ID card (optional).';

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
    when 'staff' then v_role = 'admin'
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
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;
