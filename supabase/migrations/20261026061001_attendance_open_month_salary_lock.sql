-- A salary payment no longer freezes the open month. Supervisors often mark
-- yesterday the next morning, and pay salary before the month ends. For a
-- supervisor, the lock stays for earlier days once that salary month is over.
-- An admin is never blocked by a salary payment.

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
  v_today date;
  v_month_end date;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Supervisor or admin access required';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;
  v_today := public.meter_station_today();
  if p_date > v_today then
    raise exception 'Attendance cannot be marked for a future date';
  end if;
  perform public.raise_if_day_closing_certified(p_date);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  -- Pay during the month, and yesterday's row the next morning (including the
  -- morning after the month ends), must still save. For a supervisor, older
  -- days in a finished month that already has a payment stay locked. An admin
  -- can always correct those days.
  v_month_end := (date_trunc('month', p_date) + interval '1 month' - interval '1 day')::date;
  if not public.is_admin()
     and p_date < (v_today - 1)
     and v_today > v_month_end
     and exists (
       select 1
       from public.salary_payments sp
       where sp.salary_month = date_trunc('month', p_date)::date
         and sp.employee_id in (
           select (t.value->>'employee_id')::uuid
           from jsonb_array_elements(p_rows) as t(value)
           where nullif(trim(t.value->>'employee_id'), '') is not null
         )
     )
  then
    raise exception 'Attendance is locked because salary for this month has been paid';
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
    if not public.is_admin() and exists (
      select 1 from public.employee_attendance a
      where a.employee_id = v_emp_id
        and a.date = p_date
        and a.created_by is distinct from auth.uid()
    ) then
      raise exception 'Attendance for this staff member was entered by someone else';
    end if;
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
  'Upsert attendance for one date. Blocks future and certified dates, and rows another user created. For a supervisor, a salary payment locks days before yesterday in a month that has already ended. An admin is not blocked by a salary payment.';

grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;
