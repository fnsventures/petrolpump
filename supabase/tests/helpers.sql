-- Shared helpers for supabase/tests/*.test.sql. scripts/test-db.sh loads this once, as
-- supabase_admin, after the migrations. Each test file then runs in its own transaction and
-- rolls back, so fixtures never leak between files.
--
-- Logins: tests.login('admin' | 'supervisor' | 'stranger' | 'anon') sets the JWT claims that
-- auth.uid() / auth.jwt() read and switches to the PostgREST role, so RLS and the role checks
-- in RPCs run exactly as they do for a browser call. 'stranger' is signed in to Supabase Auth
-- but has no public.users row (an unprovisioned sign-up). tests.logout() returns to postgres.

create extension if not exists pgtap with schema extensions;

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

create or replace function tests.uid(p_who text)
returns uuid
language sql
immutable
as $$
  select case p_who
    when 'admin' then '00000000-0000-0000-0000-00000000000a'
    when 'supervisor' then '00000000-0000-0000-0000-00000000000b'
    when 'stranger' then '00000000-0000-0000-0000-00000000000c'
  end::uuid;
$$;

create or replace function tests.login(p_who text)
returns void
language plpgsql
as $$
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
    return;
  end if;
  if tests.uid(p_who) is null then
    raise exception 'tests.login: unknown user %', p_who;
  end if;
  perform set_config('request.jwt.claim.sub', tests.uid(p_who)::text, true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', tests.uid(p_who), 'email', p_who || '@test.local', 'role', 'authenticated'
  )::text, true);
  execute 'set local role authenticated';
end;
$$;

create or replace function tests.logout()
returns void
language plpgsql
as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Auth accounts for all three logins; app rows for admin and supervisor only.
create or replace function tests.seed_users()
returns void
language plpgsql
as $$
begin
  insert into auth.users (id, email)
  select tests.uid(w), w || '@test.local'
  from unnest(array['admin', 'supervisor', 'stranger']) w;
  insert into public.users (email, auth_user_id, role, display_name) values
    ('admin@test.local', tests.uid('admin'), 'admin', 'Test Admin'),
    ('supervisor@test.local', tests.uid('supervisor'), 'supervisor', 'Test Supervisor');
end;
$$;

-- Two business days of books, written the way the app writes them (supervisor through the
-- money RPCs, admin for salary and meters). Leaves the caller logged out.
--
-- 2026-01-09 (D1)
--   Meters   MS 900→1000 (100 L @ 100), HSD 4900→5000 (100 L @ 90)        total_sale 19000
--   Credit   Old Co sale 500                                                credit_today 500
--   Payment  Prepaid Co pays 600 Cash with nothing due (prepaid 600)        collection 600
--
-- 2026-01-10 (D2)
--   Meters   MS 1000→1100 (100 L incl. 5 testing @ 100), HSD 5000→5200 (200 L @ 90)
--                                                                           total_sale 28000
--   Credit   Acme 1000, Ravi morning shift; Acme pays 400 UPI same day      open 600
--            Bulk Co 250, no shift; Bulk Co pays 100 Cash same day          open 150
--            Prepaid Co 200, settled from prepaid (prepaid 600 → 400)       open 200
--            Legacy Co: amount_due 75 dated D2, no ledger entries           legacy 75
--                                                                           credit_today 1025
--   Payment  Old Co pays 300 Cash + 50 Bank against D1's sale               collection 350
--   Expenses Tea 200 on Ravi's morning shift, maintenance 150 (book),
--            salary 1000 paid to Ravi                                       expenses_today 1350
--   Shift    Ravi morning: cash 5000, phone pay 700
create or replace function tests.seed_books()
returns void
language plpgsql
as $$
declare
  v_ravi constant uuid := '00000000-0000-0000-0000-0000000000e1';
begin
  insert into public.dsr_petrol (date, opening_pump1_nozzle1, closing_pump1_nozzle1, petrol_rate, dip_reading, stock)
  values ('2026-01-09', 900, 1000, 100, 1, 5000),
         ('2026-01-10', 1000, 1100, 100, 1, 4900);
  update public.dsr_petrol set testing = 5 where date = '2026-01-10';
  insert into public.dsr_diesel (date, opening_pump1_nozzle1, closing_pump1_nozzle1, diesel_rate, dip_reading, stock)
  values ('2026-01-09', 4900, 5000, 90, 1, 8000),
         ('2026-01-10', 5000, 5200, 90, 1, 7800);

  perform tests.login('admin');
  insert into public.employees (id, name, monthly_salary) values (v_ravi, 'Ravi', 31000);
  perform tests.logout();

  insert into public.credit_customers (customer_name, mobile, date)
  values ('Prepaid Co', '9000000004', '2026-01-08');

  perform tests.login('supervisor');
  perform public.add_credit_entry('Old Co', '2026-01-09', 500, p_mobile => '9000000001');
  perform public.record_credit_payment(tests.customer('Prepaid Co'), '2026-01-09', 600);

  perform public.add_credit_entry('Acme', '2026-01-10', 1000, p_mobile => '9000000002',
    p_employee_id => v_ravi, p_shift => 'morning');
  perform public.record_credit_payment(tests.customer('Acme'), '2026-01-10', 400, null, 'UPI', true);
  perform public.add_credit_entry('Bulk Co', '2026-01-10', 250, p_mobile => '9000000003');
  perform public.record_credit_payment(tests.customer('Bulk Co'), '2026-01-10', 100, null, 'Cash', true);
  perform public.add_credit_entry('Prepaid Co', '2026-01-10', 200, p_mobile => '9000000004');
  perform public.record_credit_payment(tests.customer('Old Co'), '2026-01-10', 300, null, 'Cash');
  perform public.record_credit_payment(tests.customer('Old Co'), '2026-01-10', 50, null, 'Bank');

  perform public.add_shift_expense('2026-01-10', 'morning', v_ravi, 'staff_food', 200, 'Tea');
  insert into public.expenses (date, category, description, amount, created_by)
  values ('2026-01-10', 'maintenance', 'Pump repair', 150, auth.uid());
  perform tests.logout();

  perform tests.login('admin');
  perform public.record_salary_payment(v_ravi, '2026-01-10', '2026-01-01', 1000);
  perform tests.logout();

  insert into public.credit_customers (customer_name, amount_due, date)
  values ('Legacy Co', 75, '2026-01-10');
  -- The shift credit/expense triggers already created this row.
  update public.meter_shift_cash set cash_collected = 5000, phone_pay = 700
  where reading_date = '2026-01-10' and shift = 'morning' and employee_id = v_ravi;
end;
$$;

-- Run one statement as the current login. Returns the affected row count, or the SQLSTATE it
-- raised: '42501' is a privilege/RLS denial, 'P0001' an RPC's raise exception. A filtered
-- select or update returns '0', not an error, so compare both.
create or replace function tests.try(p_sql text)
returns text
language plpgsql
as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return v_rows::text;
exception when others then
  return sqlstate;
end;
$$;

create or replace function tests.customer(p_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.credit_customers where customer_name = p_name;
$$;

grant execute on all functions in schema tests to anon, authenticated;
