-- Employment-level inactive staff: soft-deactivate app-wide.
-- Active roster RPCs already filter is_active; this adds admin toggle + name lookup for history.

create index if not exists employees_active_roster_idx
  on public.employees (display_order, name)
  where is_active = true;

comment on column public.employees.is_active is
  'Employment status. false = inactive everywhere (salary, attendance, E-20, settings).';

-- Admin soft-deactivate / reactivate (never hard-delete from UI).
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

-- Resolve names (incl. inactive) for payment / attendance history.
create or replace function public.get_employees_by_ids(p_ids uuid[])
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint,
  phone_number text,
  aadhar_number text,
  address text,
  pan_number text,
  pf_number text,
  pf_contribution numeric,
  blood_group text,
  photo_url text,
  date_of_birth date,
  id_valid_from date,
  id_valid_to date,
  is_active boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  return query
  select
    e.id,
    e.name,
    e.role_display,
    e.monthly_salary,
    e.display_order,
    e.phone_number,
    e.aadhar_number,
    e.address,
    e.pan_number,
    e.pf_number,
    e.pf_contribution,
    e.blood_group,
    e.photo_url,
    e.date_of_birth,
    e.id_valid_from,
    e.id_valid_to,
    e.is_active
  from public.employees e
  where e.id = any (p_ids);
end;
$$;

comment on function public.get_employees_by_ids(uuid[]) is
  'Lookup employees by id including inactive — for historical salary/attendance display.';

grant execute on function public.get_employees_by_ids(uuid[]) to authenticated;

-- Allow photo updates for inactive staff (archive profile edits).
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
  where id = p_employee_id;

  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

-- Reject new attendance marks for inactive employees (single pre-check, history rows remain).
create or replace function public.save_employee_attendance_batch(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_count int := 0;
  v_emp_id uuid;
  v_bad_count int;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Supervisor or admin access required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  select count(*)::int into v_bad_count
  from (
    select distinct (t.value->>'employee_id')::uuid as emp_id
    from jsonb_array_elements(p_rows) as t(value)
    where nullif(trim(t.value->>'employee_id'), '') is not null
  ) ids
  left join public.employees e on e.id = ids.emp_id
  where e.id is null or e.is_active is not true;

  if v_bad_count > 0 then
    raise exception 'Cannot mark attendance for missing or inactive staff';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) as t(value)
  loop
    if nullif(trim(v_row->>'employee_id'), '') is null then
      continue;
    end if;

    v_emp_id := (v_row->>'employee_id')::uuid;

    insert into public.employee_attendance (
      employee_id, date, status, shift, note, created_by, updated_at
    )
    values (
      v_emp_id,
      p_date,
      coalesce(nullif(trim(v_row->>'status'), ''), 'present'),
      nullif(trim(v_row->>'shift'), ''),
      nullif(trim(v_row->>'note'), ''),
      auth.uid(),
      timezone('utc'::text, now())
    )
    on conflict (employee_id, date) do update set
      status = excluded.status,
      shift = excluded.shift,
      note = excluded.note,
      updated_at = excluded.updated_at;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;

comment on function public.save_employee_attendance_batch(date, jsonb) is
  'Upsert attendance rows for one date. Supervisor or admin only. Rejects inactive employees.';
