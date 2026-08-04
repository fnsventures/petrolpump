-- Daily E-20 Testing Register (BPCL quality monitoring form).
-- Part A: morning water check through tank dip
-- Part B: E-20 petrol quality monitoring every 2 hours
-- Printable daily sheet matching the paper register.

create table if not exists public.e20_testing_registers (
  id uuid primary key default uuid_generate_v4(),
  register_date date not null,
  retail_outlet_name text
    check (retail_outlet_name is null or char_length(trim(retail_outlet_name)) <= 200),
  cc_code text
    check (cc_code is null or char_length(trim(cc_code)) <= 32),
  certified boolean not null default false,
  certified_at timestamptz,
  dealer_sign_name text
    check (dealer_sign_name is null or char_length(trim(dealer_sign_name)) <= 120),
  remarks text
    check (remarks is null or char_length(remarks) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint e20_testing_registers_date_unique unique (register_date),
  constraint e20_testing_registers_certified_consistency check (
    (certified = false and certified_at is null)
    or (certified = true)
  )
);

-- Unique(register_date) already indexes date lookups; no extra date index.

comment on table public.e20_testing_registers is
  'Daily E-20 Testing Register header (outlet, CC code, RO dealer certification).';

create table if not exists public.e20_water_checks (
  id uuid primary key default uuid_generate_v4(),
  register_id uuid not null references public.e20_testing_registers (id) on delete cascade,
  check_time time,
  tank_no text not null
    check (char_length(trim(tank_no)) between 1 and 64),
  opening_dip_mm numeric(10, 2),
  water_finding_mm numeric(10, 2),
  water_present boolean,
  corrective_action text
    check (corrective_action is null or char_length(corrective_action) <= 500),
  tested_by text
    check (tested_by is null or char_length(trim(tested_by)) <= 120),
  manager_signed boolean not null default false,
  sort_order smallint not null default 0,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists e20_water_checks_register_idx
  on public.e20_water_checks (register_id, sort_order);

comment on table public.e20_water_checks is
  'Part A — morning water check through tank dip (one row per product tank).';

create table if not exists public.e20_quality_checks (
  id uuid primary key default uuid_generate_v4(),
  register_id uuid not null references public.e20_testing_registers (id) on delete cascade,
  slot_no smallint not null
    check (slot_no between 1 and 12),
  check_time time not null,
  visual_appearance text
    check (visual_appearance is null or visual_appearance in ('clear_bright', 'hazy')),
  water_separation boolean,
  action_taken text
    check (action_taken is null or char_length(action_taken) <= 500),
  tested_by text
    check (tested_by is null or char_length(trim(tested_by)) <= 120),
  tester_signed boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint e20_quality_checks_register_slot unique (register_id, slot_no)
);

-- Unique(register_id, slot_no) covers register lookups; no extra quality index.

comment on table public.e20_quality_checks is
  'Part B — E-20 petrol quality monitoring every 2 hours (12 fixed slots).';

alter table public.e20_testing_registers enable row level security;
alter table public.e20_water_checks enable row level security;
alter table public.e20_quality_checks enable row level security;

-- Header: full CRUD (delete admin-only). Children: select only — writes go through save RPC.
drop policy if exists "e20_registers_select" on public.e20_testing_registers;
create policy "e20_registers_select" on public.e20_testing_registers
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "e20_registers_insert_own" on public.e20_testing_registers;
create policy "e20_registers_insert_own" on public.e20_testing_registers
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "e20_registers_update_staff" on public.e20_testing_registers;
create policy "e20_registers_update_staff" on public.e20_testing_registers
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "e20_registers_delete_admin" on public.e20_testing_registers;
create policy "e20_registers_delete_admin" on public.e20_testing_registers
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "e20_water_select" on public.e20_water_checks;
drop policy if exists "e20_water_insert" on public.e20_water_checks;
drop policy if exists "e20_water_update" on public.e20_water_checks;
drop policy if exists "e20_water_delete" on public.e20_water_checks;
drop policy if exists "e20_water_delete_admin" on public.e20_water_checks;
create policy "e20_water_select" on public.e20_water_checks
  for select to authenticated
  using (public.is_supervisor_or_admin());
-- DELETE needed so admin parent-row cascade is not blocked by RLS.
create policy "e20_water_delete_admin" on public.e20_water_checks
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "e20_quality_select" on public.e20_quality_checks;
drop policy if exists "e20_quality_insert" on public.e20_quality_checks;
drop policy if exists "e20_quality_update" on public.e20_quality_checks;
drop policy if exists "e20_quality_delete" on public.e20_quality_checks;
drop policy if exists "e20_quality_delete_admin" on public.e20_quality_checks;
create policy "e20_quality_select" on public.e20_quality_checks
  for select to authenticated
  using (public.is_supervisor_or_admin());
create policy "e20_quality_delete_admin" on public.e20_quality_checks
  for delete to authenticated
  using (public.is_admin());

-- Parse Yes/No/boolean text from JSON payloads.
create or replace function public.e20_parse_yes_no(p_val text)
returns boolean
language sql
immutable
as $$
  select case
    when p_val is null or btrim(p_val) = '' then null
    when lower(btrim(p_val)) in ('true', 'yes', 'y', '1', 't') then true
    when lower(btrim(p_val)) in ('false', 'no', 'n', '0', 'f') then false
    else null
  end;
$$;

-- Atomic save: upsert header, replace Part A/B via set-based inserts.
create or replace function public.save_e20_testing_register(
  p_date date,
  p_outlet_name text,
  p_cc_code text,
  p_water_checks jsonb,
  p_quality_checks jsonb,
  p_certified boolean default false,
  p_certified_at timestamptz default null,
  p_dealer_sign_name text default null,
  p_remarks text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Register date is required';
  end if;

  insert into public.e20_testing_registers (
    register_date,
    retail_outlet_name,
    cc_code,
    certified,
    certified_at,
    dealer_sign_name,
    remarks,
    created_by,
    updated_at
  )
  values (
    p_date,
    nullif(btrim(coalesce(p_outlet_name, '')), ''),
    nullif(btrim(coalesce(p_cc_code, '')), ''),
    coalesce(p_certified, false),
    case
      when coalesce(p_certified, false)
        then coalesce(p_certified_at, timezone('utc'::text, now()))
      else null
    end,
    nullif(btrim(coalesce(p_dealer_sign_name, '')), ''),
    nullif(btrim(coalesce(p_remarks, '')), ''),
    auth.uid(),
    timezone('utc'::text, now())
  )
  on conflict (register_date) do update set
    retail_outlet_name = excluded.retail_outlet_name,
    cc_code = excluded.cc_code,
    certified = excluded.certified,
    certified_at = excluded.certified_at,
    dealer_sign_name = excluded.dealer_sign_name,
    remarks = excluded.remarks,
    updated_at = excluded.updated_at
  returning id into v_id;

  delete from public.e20_water_checks where register_id = v_id;
  delete from public.e20_quality_checks where register_id = v_id;

  if p_water_checks is not null and jsonb_typeof(p_water_checks) = 'array' then
    insert into public.e20_water_checks (
      register_id,
      check_time,
      tank_no,
      opening_dip_mm,
      water_finding_mm,
      water_present,
      corrective_action,
      tested_by,
      manager_signed,
      sort_order
    )
    select
      v_id,
      nullif(btrim(coalesce(t.value->>'check_time', '')), '')::time,
      btrim(t.value->>'tank_no'),
      nullif(btrim(coalesce(t.value->>'opening_dip_mm', '')), '')::numeric,
      nullif(btrim(coalesce(t.value->>'water_finding_mm', '')), '')::numeric,
      public.e20_parse_yes_no(t.value->>'water_present'),
      nullif(btrim(coalesce(t.value->>'corrective_action', '')), ''),
      nullif(btrim(coalesce(t.value->>'tested_by', '')), ''),
      coalesce(public.e20_parse_yes_no(t.value->>'manager_signed'), false),
      coalesce(nullif(t.value->>'sort_order', '')::smallint, (t.ord - 1)::smallint)
    from jsonb_array_elements(p_water_checks) with ordinality as t(value, ord)
    where nullif(btrim(coalesce(t.value->>'tank_no', '')), '') is not null;
  end if;

  if p_quality_checks is not null and jsonb_typeof(p_quality_checks) = 'array' then
    insert into public.e20_quality_checks (
      register_id,
      slot_no,
      check_time,
      visual_appearance,
      water_separation,
      action_taken,
      tested_by,
      tester_signed
    )
    select
      v_id,
      (t.value->>'slot_no')::smallint,
      btrim(t.value->>'check_time')::time,
      nullif(btrim(coalesce(t.value->>'visual_appearance', '')), ''),
      public.e20_parse_yes_no(t.value->>'water_separation'),
      nullif(btrim(coalesce(t.value->>'action_taken', '')), ''),
      nullif(btrim(coalesce(t.value->>'tested_by', '')), ''),
      coalesce(
        public.e20_parse_yes_no(coalesce(t.value->>'tester_signed', t.value->>'signed')),
        false
      )
    from jsonb_array_elements(p_quality_checks) as t(value)
    where t.value->>'slot_no' is not null
      and nullif(btrim(coalesce(t.value->>'check_time', '')), '') is not null
      and (
        nullif(btrim(coalesce(t.value->>'visual_appearance', '')), '') is not null
        or public.e20_parse_yes_no(t.value->>'water_separation') is not null
        or nullif(btrim(coalesce(t.value->>'tested_by', '')), '') is not null
        or nullif(btrim(coalesce(t.value->>'action_taken', '')), '') is not null
        or coalesce(
          public.e20_parse_yes_no(coalesce(t.value->>'tester_signed', t.value->>'signed')),
          false
        )
      );
  end if;

  return v_id;
end;
$$;

comment on function public.save_e20_testing_register(date, text, text, jsonb, jsonb, boolean, timestamptz, text, text) is
  'Upsert daily E-20 Testing Register and replace Part A/B rows (set-based). Staff only.';

grant execute on function public.save_e20_testing_register(date, text, text, jsonb, jsonb, boolean, timestamptz, text, text) to authenticated;
grant execute on function public.e20_parse_yes_no(text) to authenticated;

grant select, insert, update, delete on public.e20_testing_registers to authenticated;
grant select, delete on public.e20_water_checks to authenticated;
grant select, delete on public.e20_quality_checks to authenticated;

-- Page access for admin and supervisor
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

comment on function public.check_page_access(text) is
  'Server-side page access validation. Returns allowed status and user role.';
