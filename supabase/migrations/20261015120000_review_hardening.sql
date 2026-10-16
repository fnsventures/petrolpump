-- Review hardening: drive file ids, first admin, salary and attendance locks,
-- meter sales, collected-day writes, certification reason, posted credit only,
-- private photo buckets, and one dashboard snapshot.

alter table public.day_closing
  add column if not exists revoke_reason text
  check (revoke_reason is null or char_length(trim(revoke_reason)) between 3 and 500);

comment on column public.day_closing.revoke_reason is
  'Why certification was removed. Required when an admin revokes. The audit row is written even if the audit flag is off.';

drop policy if exists "users_insert_admin" on public.users;
create policy "users_insert_admin" on public.users
  for insert to authenticated
  with check (
    public.is_admin()
    or (
      coalesce(current_setting('app.allow_first_admin', true), '') = 'on'
      and not exists (select 1 from public.users u where u.role = 'admin')
      and lower(trim(email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      and role = 'admin'
    )
  );

update storage.buckets
set public = false
where id in ('user-avatars', 'staff-photos');

drop policy if exists "staff_photos_delete_staff" on storage.objects;
create policy "staff_photos_delete_staff" on storage.objects
  for delete to authenticated
  using (bucket_id = 'staff-photos' and public.is_admin());

drop function if exists public.set_day_closing_certified(date, boolean);

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


create or replace function public.upsert_staff(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_auth_id uuid;
begin
  if not public.is_admin() then
    if coalesce(current_setting('app.allow_first_admin', true), '') is distinct from 'on'
       or exists (select 1 from public.users where role = 'admin')
       or lower(trim(p_email)) <> lower(trim(coalesce(auth.jwt() ->> 'email', '')))
       or p_role <> 'admin' then
      raise exception 'Access denied: Admin role required';
    end if;
  end if;
  if p_role not in ('admin', 'supervisor') then
    raise exception 'Invalid role: must be admin or supervisor';
  end if;
  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  select a.id
  into v_auth_id
  from auth.users a
  where lower(trim(a.email)) = lower(trim(p_email))
  limit 1;

  if v_auth_id is null then
    raise exception 'Create this login in Supabase Authentication first';
  end if;

  insert into public.users (email, role, display_name, auth_user_id)
  values (lower(trim(p_email)), p_role, nullif(trim(p_display_name), ''), v_auth_id)
  on conflict (email) do update set
    role = excluded.role,
    display_name = excluded.display_name,
    auth_user_id = excluded.auth_user_id
  returning jsonb_build_object(
    'id', id,
    'email', email,
    'role', role,
    'display_name', display_name,
    'auth_user_id', auth_user_id
  ) into v_result;
  return v_result;
end;
$$;


create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();
  
  -- Define page access rules
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
    when 'letterhead' then v_role in ('admin', 'supervisor')
    when 'reminders' then v_role in ('admin', 'supervisor')
    when 'e20-register' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

comment on function public.check_page_access(text) is 'Server-side page access validation. Returns allowed status and user role.';


create or replace function public.get_night_cash_available()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_total numeric := 0;
  v_count int := 0;
  v_from date;
  v_to date;
  v_days jsonb;
begin
  perform public.require_staff_access();

  select
    coalesce(sum(night_cash), 0),
    count(*)::int,
    min(date),
    max(date),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', date,
        'night_cash', night_cash,
        'closing_reference', closing_reference
      ) order by date asc
    ), '[]'::jsonb)
  into v_total, v_count, v_from, v_to, v_days
  from public.day_closing
  where night_cash_collection_id is null;

  return jsonb_build_object(
    'total_available', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'from_date', v_from,
    'to_date', v_to,
    'days', v_days
  );
end;
$$;

comment on function public.get_night_cash_available() is
  'Sum of uncollected night cash from saved day closings, with per-day breakdown.';


create or replace function public.preview_night_cash_collection(
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_included jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_collected_count int := 0;
  v_missing_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can preview night cash collection';
  end if;

  if p_from_date is null or p_to_date is null then
    raise exception 'from_date and to_date are required';
  end if;
  if p_from_date > p_to_date then
    raise exception 'from_date must be on or before to_date';
  end if;

  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', dc.date,
        'night_cash', dc.night_cash,
        'closing_reference', dc.closing_reference
      ) order by dc.date asc
    ) filter (where dc.night_cash_collection_id is null), '[]'::jsonb),
    coalesce(sum(dc.night_cash) filter (where dc.night_cash_collection_id is null), 0),
    count(*) filter (where dc.night_cash_collection_id is null)::int,
    count(*) filter (where dc.night_cash_collection_id is not null)::int
  into v_included, v_total, v_count, v_collected_count
  from public.day_closing dc
  where dc.date between p_from_date and p_to_date;

  v_missing_count := (p_to_date - p_from_date + 1) - v_count - v_collected_count;

  return jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'total_amount', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'days', v_included,
    'already_collected_count', coalesce(v_collected_count, 0),
    'missing_closing_count', greatest(coalesce(v_missing_count, 0), 0)
  );
end;
$$;

comment on function public.preview_night_cash_collection(date, date) is
  'Admin-only: preview uncollected night cash in a date range before recording collection.';


create or replace function public.collect_night_cash(
  p_from_date date,
  p_to_date date,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_preview jsonb;
  v_total numeric;
  v_count int;
  v_collection_id uuid;
  v_ref text;
  v_seq bigint;
  v_year int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can record night cash collection';
  end if;

  v_preview := public.preview_night_cash_collection(p_from_date, p_to_date);
  v_total := coalesce((v_preview->>'total_amount')::numeric, 0);
  v_count := coalesce((v_preview->>'day_count')::int, 0);

  if v_count = 0 then
    raise exception 'No uncollected day closings in this date range';
  end if;

  v_year := extract(year from p_to_date)::int;
  select coalesce(max(
    nullif(regexp_replace(collection_reference, '^NCC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
  ), 0) + 1 into v_seq
  from public.night_cash_collections
  where extract(year from collected_at) = v_year
    and collection_reference ~ '^NCC-[0-9]+-[0-9]+$';

  v_ref := 'NCC-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');

  insert into public.night_cash_collections (
    collection_reference, from_date, to_date, day_count, total_amount,
    remarks, collected_by
  )
  values (
    v_ref, p_from_date, p_to_date, v_count, v_total,
    nullif(trim(p_remarks), ''), auth.uid()
  )
  returning id into v_collection_id;

  update public.day_closing
  set night_cash_collection_id = v_collection_id
  where date between p_from_date and p_to_date
    and night_cash_collection_id is null;

  return jsonb_build_object(
    'id', v_collection_id,
    'collection_reference', v_ref,
    'from_date', p_from_date,
    'to_date', p_to_date,
    'day_count', v_count,
    'total_amount', v_total,
    'remarks', nullif(trim(p_remarks), ''),
    'days', v_preview->'days'
  );
end;
$$;

comment on function public.collect_night_cash(date, date, text) is
  'Admin-only: record physical night cash collection for a date range. Locks linked day closings.';


create or replace function public.delete_day_closing(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_latest_date date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete day closing records';
  end if;

  select * into v_row from public.day_closing where id = p_id;
  if not found then
    raise exception 'Day closing record not found';
  end if;

  if coalesce(v_row.certified, false) then
    raise exception
      'Day closing for % is certified and locked. Revoke certification before deleting it.',
      v_row.date;
  end if;

  if v_row.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected.', v_row.date;
  end if;

  select max(date) into v_latest_date from public.day_closing;

  if v_row.date < v_latest_date then
    raise exception 'Only the most recent day closing can be deleted. Remove newer closings first.';
  end if;

  delete from public.day_closing where id = p_id;

  return jsonb_build_object(
    'date', v_row.date,
    'closing_reference', v_row.closing_reference
  );
end;
$$;

comment on function public.delete_day_closing(uuid) is
  'Admin-only: delete the latest uncertified day closing so the date can be re-closed.';


create or replace function public.record_salary_payment(
  p_employee_id uuid,
  p_date date,
  p_salary_month date,
  p_amount numeric,
  p_note text default null,
  p_allow_overpay boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_month date;
  v_note text;
  v_name text;
  v_payable numeric;
  v_paid numeric;
  v_pending numeric;
  v_payment_id uuid;
  v_expense_id uuid;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_salary_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_employee_id is null then
    raise exception 'Select a staff member.';
  end if;
  if p_date is null then
    raise exception 'Payment date is required.';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Payment date cannot be in the future.';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;
  if p_salary_month is null then
    raise exception 'Select the salary month this payment applies to.';
  end if;
  v_month := date_trunc('month', p_salary_month)::date;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Note must be 200 characters or fewer.';
  end if;

  select e.name into v_name from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'Staff member not found';
  end if;

  -- Concurrent payments for the same employee and month see each other's rows.
  perform pg_advisory_xact_lock(
    hashtextextended('salary_payment:' || p_employee_id::text || ':' || v_month::text, 0)
  );

  v_payable := public.salary_month_payable(p_employee_id, v_month);
  select coalesce(sum(sp.amount), 0) into v_paid
  from public.salary_payments sp
  where sp.employee_id = p_employee_id and sp.salary_month = v_month;
  v_pending := greatest(0, v_payable - v_paid);

  -- 0.05 absorbs paisa rounding differences against the browser's floating-point figures.
  -- p_allow_overpay is ignored unless the caller is an admin.
  -- A supervisor-created employee has salary 0, so payable 0 must not accept a payment.
  if v_payable <= 0 and not (public.is_admin() and coalesce(p_allow_overpay, false)) then
    raise exception using
      message = 'This staff member has no salary payable for the month.',
      detail = jsonb_build_object('payable', v_payable, 'paid', v_paid, 'pending', v_pending)::text,
      hint = 'salary_overpay';
  end if;
  if v_payable > 0 and p_amount > v_pending + 0.05
     and not (public.is_admin() and coalesce(p_allow_overpay, false)) then
    raise exception using
      message = 'Amount exceeds the remaining salary for this month.',
      detail = jsonb_build_object('payable', v_payable, 'paid', v_paid, 'pending', v_pending)::text,
      hint = 'salary_overpay';
  end if;

  insert into public.salary_payments (employee_id, date, salary_month, amount, note, created_by)
  values (p_employee_id, p_date, v_month, p_amount, v_note, auth.uid())
  returning id into v_payment_id;

  insert into public.expenses (date, category, description, amount, salary_payment_id, created_by)
  values (
    p_date,
    'salary',
    'Salary: ' || v_name || coalesce(' - ' || v_note, ''),
    p_amount,
    v_payment_id,
    auth.uid()
  )
  returning id into v_expense_id;

  v_out := jsonb_build_object(
    'id', v_payment_id,
    'expense_id', v_expense_id,
    'employee_id', p_employee_id,
    'date', p_date,
    'salary_month', v_month,
    'amount', p_amount,
    'payable', v_payable,
    'paid_before', v_paid,
    'pending_after', greatest(0, v_payable - v_paid - p_amount)
  );
  perform public.write_request_store(p_request_id, 'record_salary_payment', v_out);
  return v_out;
end;
$$;

comment on function public.record_salary_payment(uuid, date, date, numeric, text, boolean, uuid) is
  'Record a salary payment and its linked salary expense in one transaction. Rejects a certified payment date. Raises hint salary_overpay when the amount exceeds the month''s remaining take-home. p_allow_overpay is honored for admins only. Retry-safe with p_request_id.';


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

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Attendance cannot be marked for a future date';
  end if;
  perform public.raise_if_day_closing_certified(p_date);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  if exists (
    select 1
    from public.salary_payments sp
    where sp.salary_month = date_trunc('month', p_date)::date
      and sp.employee_id in (
        select (t.value->>'employee_id')::uuid
        from jsonb_array_elements(p_rows) as t(value)
        where nullif(trim(t.value->>'employee_id'), '') is not null
      )
  ) then
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
  'Upsert attendance for one date. Blocks future and certified dates, a month that already has salary paid, and rows another user created.';


create or replace function public.dsr_validate_meter_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_label text := case when tg_table_name = 'dsr_petrol' then 'MS' else 'HSD' end;
  v_product text := case when tg_table_name = 'dsr_petrol' then 'petrol' else 'diesel' end;
  v_open numeric;
  v_close numeric;
  v_key text;
  v_pump int;
  v_nozzle int;
  v_sales1 numeric := 0;
  v_sales2 numeric := 0;
  v_prev_o1 numeric;
  v_prev_o2 numeric;
  v_prev_o3 numeric;
  v_prev_o4 numeric;
  v_prev_rate numeric;
  v_rate numeric;
  v_expected numeric;
  v_rate_text text;
  v_meters_changed boolean := tg_op = 'INSERT';
  v_rate_changed boolean := tg_op = 'INSERT';
  v_keys constant text[] := array[
    'opening_pump1_nozzle1', 'opening_pump1_nozzle2', 'opening_pump2_nozzle1', 'opening_pump2_nozzle2',
    'closing_pump1_nozzle1', 'closing_pump1_nozzle2', 'closing_pump2_nozzle1', 'closing_pump2_nozzle2',
    'sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'stock', 'receipts'
  ];
begin
  if tg_op = 'DELETE' then
    perform public.raise_if_day_closing_certified(old.date);
    return old;
  end if;

  v_new := to_jsonb(new);
  perform public.raise_if_day_closing_certified(new.date);
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    perform public.raise_if_day_closing_certified(old.date);
  end if;

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_meters_changed := exists (select 1 from unnest(v_keys) k where v_new->k is distinct from v_old->k);
    if tg_table_name = 'dsr_petrol' then
      v_rate_changed := new.petrol_rate is distinct from old.petrol_rate;
    else
      v_rate_changed := new.diesel_rate is distinct from old.diesel_rate;
    end if;
    if not v_meters_changed and not v_rate_changed then
      return new;
    end if;
  end if;

  if v_meters_changed then
    for v_pump in 1..2 loop
      for v_nozzle in 1..2 loop
        v_open := (v_new->>format('opening_pump%s_nozzle%s', v_pump, v_nozzle))::numeric;
        v_close := (v_new->>format('closing_pump%s_nozzle%s', v_pump, v_nozzle))::numeric;
        if v_open < 0 or v_close < 0 then
          raise exception using errcode = 'check_violation',
            message = format('%s meter readings must be >= 0 (Pump %s · Nozzle %s).', v_label, v_pump, v_nozzle);
        end if;
        if v_close < v_open then
          raise exception using errcode = 'check_violation',
            message = format('%s closing must be >= opening for Pump %s · Nozzle %s.', v_label, v_pump, v_nozzle);
        end if;
      end loop;
    end loop;

    v_sales1 :=
      ((v_new->>'closing_pump1_nozzle1')::numeric - (v_new->>'opening_pump1_nozzle1')::numeric)
      + ((v_new->>'closing_pump1_nozzle2')::numeric - (v_new->>'opening_pump1_nozzle2')::numeric);
    v_sales2 :=
      ((v_new->>'closing_pump2_nozzle1')::numeric - (v_new->>'opening_pump2_nozzle1')::numeric)
      + ((v_new->>'closing_pump2_nozzle2')::numeric - (v_new->>'opening_pump2_nozzle2')::numeric);
    new.sales_pump1 := v_sales1;
    new.sales_pump2 := v_sales2;
    new.total_sales := v_sales1 + v_sales2;

    foreach v_key in array array['sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'stock', 'receipts'] loop
      if (to_jsonb(new)->>v_key)::numeric < 0 then
        raise exception using errcode = 'check_violation',
          message = format('%s %s cannot be negative.', v_label, replace(v_key, '_', ' '));
      end if;
    end loop;

    if new.testing > new.total_sales then
      raise exception using errcode = 'check_violation',
        message = format('%s testing cannot exceed total sales.', v_label);
    end if;

    if tg_table_name = 'dsr_petrol' then
      select p.closing_pump1_nozzle1, p.closing_pump1_nozzle2, p.closing_pump2_nozzle1, p.closing_pump2_nozzle2
      into v_prev_o1, v_prev_o2, v_prev_o3, v_prev_o4
      from public.dsr_petrol p
      where p.date < new.date
      order by p.date desc
      limit 1;
    else
      select d.closing_pump1_nozzle1, d.closing_pump1_nozzle2, d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
      into v_prev_o1, v_prev_o2, v_prev_o3, v_prev_o4
      from public.dsr_diesel d
      where d.date < new.date
      order by d.date desc
      limit 1;
    end if;

    if found and not public.is_admin() and (
      abs(new.opening_pump1_nozzle1 - v_prev_o1) > 0.001
      or abs(new.opening_pump1_nozzle2 - v_prev_o2) > 0.001
      or abs(new.opening_pump2_nozzle1 - v_prev_o3) > 0.001
      or abs(new.opening_pump2_nozzle2 - v_prev_o4) > 0.001
    ) then
      raise exception using errcode = 'check_violation',
        message = format('%s opening must match the previous closing. An admin can record a meter rollover.', v_label);
    end if;
  end if;

  if v_rate_changed or v_meters_changed then
    if tg_table_name = 'dsr_petrol' then
      v_rate := new.petrol_rate;
      select p.petrol_rate into v_prev_rate
      from public.dsr_petrol p
      where p.date < new.date and p.petrol_rate is not null
      order by p.date desc
      limit 1;
    else
      v_rate := new.diesel_rate;
      select d.diesel_rate into v_prev_rate
      from public.dsr_diesel d
      where d.date < new.date and d.diesel_rate is not null
      order by d.date desc
      limit 1;
    end if;

    select s.config #>> array['rates', v_product] into v_rate_text
    from public.pump_settings s
    where s.id = 1;
    if v_rate_text ~ '^[0-9]+(\.[0-9]+)?$' then
      v_expected := v_rate_text::numeric;
    else
      v_expected := v_prev_rate;
    end if;

    if v_rate_changed and coalesce(v_rate, 0) <= 0 then
      raise exception using errcode = 'check_violation',
        message = format('%s selling rate is required.', v_label);
    end if;
    if coalesce(v_rate, 0) > 0 and v_expected is not null and abs(v_rate - v_expected) > 0.009 and not public.is_admin() then
      raise exception using errcode = 'check_violation',
        message = format('%s rate must match the configured price (%s). An admin can change the price.', v_label, v_expected);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.dsr_validate_meter_row() is
  'Trigger: reject a certified day, calculate nozzle sales, require opening to match the previous closing unless an admin records a rollover, and require the selling rate to match the configured price unless an admin changes it.';


create or replace function public.apply_credit_payment_to_day_closing(
  p_date date,
  p_same_day_settlement boolean default false,
  p_payment_mode text default 'Cash',
  p_amount numeric default 0
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_night_cash numeric;
  v_phone_pay numeric;
  v_short_today numeric;
  v_mode text;
begin
  if p_date is null then
    return;
  end if;

  select
    night_cash, phone_pay, total_sale, collection, short_previous, credit_today,
    expenses_today, short_today, night_cash_collection_id, certified
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  if v_row.night_cash_collection_id is not null and not public.is_admin() then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_night_cash := coalesce(v_row.night_cash, 0);
  v_phone_pay := coalesce(v_row.phone_pay, 0);

  if coalesce(p_same_day_settlement, false) and coalesce(p_amount, 0) <> 0
     and v_row.night_cash_collection_id is null then
    v_mode := lower(trim(coalesce(p_payment_mode, 'Cash')));
    if v_mode = 'upi' then
      v_phone_pay := greatest(0, v_phone_pay + p_amount);
    elsif v_mode = 'bank' then
      null;
    else
      v_night_cash := greatest(0, v_night_cash + p_amount);
    end if;
  end if;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (v_night_cash + v_phone_pay + v_credit_today + v_expenses_today);

  update public.day_closing set
    total_sale = v_total_sale,
    collection = v_collection,
    short_previous = v_short_previous,
    credit_today = v_credit_today,
    expenses_today = v_expenses_today,
    night_cash = v_night_cash,
    phone_pay = v_phone_pay,
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) is
  'After a credit payment: refresh day_closing. Certified dates are rejected until revoke.';


create or replace function public.sync_meter_shift_cash_ledger_totals(
  p_date date,
  p_shift text,
  p_employee_id uuid
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text := lower(btrim(coalesce(p_shift, '')));
  v_credit numeric := 0;
  v_expense numeric := 0;
begin
  perform public.require_staff_access();

  if p_date is null or p_employee_id is null or v_shift not in ('morning', 'afternoon') then
    return;
  end if;

  select
    coalesce((
      select sum(ce.amount)
      from public.credit_entries ce
      where ce.transaction_date = p_date
        and ce.shift = v_shift
        and ce.employee_id = p_employee_id
        and ce.status = 'posted'
    ), 0),
    coalesce((
      select sum(ex.amount)
      from public.expenses ex
      where ex.date = p_date
        and ex.shift = v_shift
        and ex.employee_id = p_employee_id
    ), 0)
  into v_credit, v_expense;

  insert into public.meter_shift_cash (
    reading_date, shift, employee_id,
    cash_collected, phone_pay, credit_amount, expense_amount,
    updated_at
  )
  values (
    p_date, v_shift, p_employee_id,
    0, 0, v_credit, v_expense,
    timezone('utc'::text, now())
  )
  on conflict (reading_date, shift, employee_id)
  do update set
    credit_amount = excluded.credit_amount,
    expense_amount = excluded.expense_amount,
    updated_at = timezone('utc'::text, now());
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows. Provisioned staff only.';


create or replace function public.trg_sync_shift_cash_from_credit_entries()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.transaction_date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.transaction_date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
       or old.status is distinct from new.status
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.transaction_date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
       or old.status is distinct from new.status
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.transaction_date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;


create or replace function public.get_customer_credit_breakdown_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  entry_type text,
  entry_date date,
  amount numeric
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  credits as (
    select 'credit'::text as entry_type,
           e.transaction_date as entry_date,
           e.amount
    from public.credit_entries e
    join customer_ids ci on ci.credit_customer_id = e.credit_customer_id
    where e.transaction_date <= p_date
      and e.status = 'posted'
  ),
  payments as (
    select 'payment'::text as entry_type,
           p.date as entry_date,
           p.amount
    from public.credit_payments p
    join customer_ids ci on ci.credit_customer_id = p.credit_customer_id
    where p.date <= p_date
      and p.status = 'posted'
  )
  select u.entry_type, u.entry_date, u.amount
  from (
    select * from credits
    union all
    select * from payments
  ) u
  order by u.entry_date asc, u.entry_type asc;
end;
$$;


create or replace function public.get_shift_staff_ledger(p_date date, p_shift text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_staff_access();
  if p_date is null then
    raise exception 'Date is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'credit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'employee_id', e.employee_id,
          'customer_name', c.customer_name,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount', e.amount,
          'amount_settled', e.amount_settled,
          'status', e.status,
          'created_by', e.created_by
        )
        order by c.customer_name, e.created_at
      )
      from public.credit_entries e
      join public.credit_customers c on c.id = e.credit_customer_id
      where e.transaction_date = p_date
        and e.shift = v_shift
        and e.employee_id is not null
        and e.status = 'posted'
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'employee_id', x.employee_id,
          'category', x.category,
          'description', x.description,
          'amount', x.amount,
          'created_by', x.created_by
        )
        order by x.created_at
      )
      from public.expenses x
      where x.date = p_date
        and x.shift = v_shift
        and x.employee_id is not null
    ), '[]'::jsonb)
  );
end;
$$;


create or replace function public.delete_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_n int;
  v_c int;
  v_credit int := 0;
  v_expense int := 0;
  v_settled int := 0;
  v_customer_id uuid;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();
  if not public.is_admin() then
    raise exception 'Only admin can delete shift readings';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select count(*)::int into v_settled
  from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and e.status = 'posted'
    and coalesce(e.amount_settled, 0) > 0;
  if v_settled > 0 then
    raise exception
      'Cannot clear shift: % credit sale(s) already have payments. Remove settlements first.',
      v_settled;
  end if;

  for v_customer_id in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.status = 'posted'
  loop
    update public.credit_entries e
    set status = 'cancelled',
        cancelled_at = timezone('utc', now()),
        cancelled_by = auth.uid()
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.credit_customer_id = v_customer_id
      and e.status = 'posted';
    get diagnostics v_n = row_count;
    v_credit := v_credit + v_n;
    perform public.reallocate_credit_settlements(v_customer_id);
  end loop;

  delete from public.expenses x
  where x.date = p_date
    and x.shift = v_shift
    and x.employee_id is not null;
  get diagnostics v_expense = row_count;

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'deleted_credit', v_credit,
    'deleted_expenses', v_expense,
    'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzles and cash, cancel posted shift credit (the row stays), delete shift expenses, and refresh dsr_* meters.';


create or replace function public.get_dashboard_snapshot(p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dsr jsonb;
  v_stock jsonb;
  v_expense numeric;
  v_credit numeric;
begin
  perform public.require_staff_access();
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'A valid date range is required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', d.date,
      'product', d.product,
      'total_sales', d.total_sales,
      'testing', d.testing,
      'stock', d.stock,
      'petrol_rate', d.petrol_rate,
      'diesel_rate', d.diesel_rate
    )
    order by d.date, d.product
  ), '[]'::jsonb)
  into v_dsr
  from public.dsr d
  where d.date between p_start and p_end;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
  into v_stock
  from public.get_dsr_stock_range(p_start, p_end) s;

  v_expense := public.sum_expenses(p_start, p_end, false);
  v_credit := public.sum_credit_given(p_start, p_end);

  return jsonb_build_object(
    'dsrData', v_dsr,
    'stockData', v_stock,
    'expenseData', null,
    'creditData', null,
    'expenseTotal', v_expense,
    'creditGiven', v_credit
  );
end;
$$;

comment on function public.get_dashboard_snapshot(date, date) is
  'Dashboard range in one call: meter rows, stock, expense total, and posted credit given.';


create or replace function public.set_day_closing_certified(
  p_date date,
  p_certified boolean,
  p_reason text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_existing record;
  v_name text;
  v_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can certify or remove certification on a day closing';
  end if;

  if p_date is null then
    raise exception 'date is required';
  end if;

  select date, closing_reference, certified, certified_at, certified_by_name
  into v_existing
  from public.day_closing
  where date = p_date
  for update;

  if not found then
    raise exception 'Save day closing for % before certifying it.', p_date;
  end if;

  if coalesce(p_certified, false) then
    if coalesce(v_existing.certified, false) then
      return jsonb_build_object(
        'date', v_existing.date,
        'closing_reference', v_existing.closing_reference,
        'certified', true,
        'certified_at', v_existing.certified_at,
        'certified_by_name', v_existing.certified_by_name
      );
    end if;

    select coalesce(nullif(trim(u.display_name), ''), u.email)
    into v_name
    from public.users u
    where lower(trim(u.email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    limit 1;
    v_name := coalesce(nullif(trim(v_name), ''), 'Admin');
    v_at := timezone('utc'::text, now());

    update public.day_closing set
      certified = true,
      certified_at = v_at,
      certified_by = auth.uid(),
      certified_by_name = v_name,
      revoke_reason = null
    where date = p_date;

    return jsonb_build_object(
      'date', p_date,
      'closing_reference', v_existing.closing_reference,
      'certified', true,
      'certified_at', v_at,
      'certified_by_name', v_name
    );
  end if;

  if not coalesce(v_existing.certified, false) then
    return jsonb_build_object(
      'date', v_existing.date,
      'closing_reference', v_existing.closing_reference,
      'certified', false,
      'certified_at', null,
      'certified_by_name', null
    );
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null
     or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required to remove certification';
  end if;

  perform set_config('app.force_audit', 'true', true);
  update public.day_closing set
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null,
    revoke_reason = trim(p_reason)
  where date = p_date;
  perform set_config('app.force_audit', '', true);

  return jsonb_build_object(
    'date', p_date,
    'closing_reference', v_existing.closing_reference,
    'certified', false,
    'certified_at', null,
    'certified_by_name', null
  );
end;
$$;

comment on function public.set_day_closing_certified(date, boolean, text) is
  'Admin-only: certify a saved statement or revoke it. Revoke requires a reason and always writes an audit row.';


grant execute on function public.set_day_closing_certified(date, boolean, text) to authenticated;

grant execute on function public.get_dashboard_snapshot(date, date) to authenticated;
