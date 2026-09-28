-- Over duty on a present day. Payroll rules (loss of pay, paid leave allowance,
-- over-duty pay, day-rate basis) live in pump_settings.config.payroll.

alter table public.employee_attendance
  add column if not exists over_duty boolean not null default false;

comment on column public.employee_attendance.over_duty is
  'Extra duty on a present day. When payroll over-duty pay is enabled, adds one day of salary.';

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
  v_status text;
  v_over_duty boolean;
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
    v_status := coalesce(nullif(trim(v_row->>'status'), ''), 'present');
    v_over_duty := v_status = 'present' and coalesce((v_row->>'over_duty')::boolean, false);

    insert into public.employee_attendance (
      employee_id, date, status, shift, note, over_duty, created_by, updated_at
    )
    values (
      v_emp_id,
      p_date,
      v_status,
      nullif(trim(v_row->>'shift'), ''),
      nullif(trim(v_row->>'note'), ''),
      v_over_duty,
      auth.uid(),
      timezone('utc'::text, now())
    )
    on conflict (employee_id, date) do update set
      status = excluded.status,
      shift = excluded.shift,
      note = excluded.note,
      over_duty = excluded.over_duty,
      updated_at = excluded.updated_at;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;

comment on function public.save_employee_attendance_batch(date, jsonb) is
  'Upsert attendance rows for one date, including over_duty on present days. Supervisor or admin only. Rejects inactive employees.';
