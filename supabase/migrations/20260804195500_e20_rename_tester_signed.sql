-- Fix: rename e20_quality_checks.signed → tester_signed (app expects tester_signed).
-- Safe if already renamed or table created with tester_signed.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'e20_quality_checks'
      and column_name = 'signed'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'e20_quality_checks'
      and column_name = 'tester_signed'
  ) then
    alter table public.e20_quality_checks rename column signed to tester_signed;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'e20_quality_checks'
      and column_name = 'tester_signed'
  ) and exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'e20_quality_checks'
  ) then
    alter table public.e20_quality_checks
      add column tester_signed boolean not null default false;
  end if;
end;
$$;

-- Refresh save RPC to match tester_signed (idempotent with current schema.sql).
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
