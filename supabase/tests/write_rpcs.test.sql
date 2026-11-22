-- add_expense (Expenses page) and save_dsr_meter_row (daily meter sheet): the browser's
-- write paths for book expenses and dsr_petrol / dsr_diesel.
begin;
select plan(23);

select tests.seed_users();
select tests.seed_books();

-- add_expense ---------------------------------------------------------------------------------
select tests.login('supervisor');

select ok(
  (public.add_expense('2026-01-10', 'maintenance', 40, '  Hose  ', '20000000-0000-0000-0000-000000000001')->>'id') is not null,
  'add_expense saves a book expense');
select is(
  (select row(description, created_by, employee_id, shift, client_request_id)::text
   from public.expenses where description = 'Hose'),
  row('Hose', tests.uid('supervisor'), null::uuid, null::text, '20000000-0000-0000-0000-000000000001'::uuid)::text,
  'trimmed, owned by the caller, no staff or shift, request id stored');
select ok(
  public.add_expense('2026-01-10', 'maintenance', 40, 'Hose', '20000000-0000-0000-0000-000000000001') is not null,
  'replayed request');
select is((select count(*) from public.expenses where description = 'Hose')::int, 1, 'replay wrote nothing new');

select throws_like($$ select public.add_expense('2026-01-10', 'salary', 10) $$,
  '%Salary page%', 'salary rejected');
select throws_like($$ select public.add_expense('2026-01-10', 'nope', 10) $$,
  '%Unknown expense category%', 'unknown category rejected');
select throws_like($$ select public.add_expense('2026-01-10', 'maintenance', 0) $$,
  '%greater than 0%', 'zero amount rejected');
select throws_like($$ select public.add_expense(public.meter_station_today() + 1, 'maintenance', 10) $$,
  '%future%', 'future date rejected (IST)');
select tests.logout();

select tests.login('stranger');
select throws_ok($$ select public.add_expense('2026-01-10', 'maintenance', 10) $$,
  'P0001', null, 'unprovisioned login rejected');
select tests.logout();

-- save_dsr_meter_row --------------------------------------------------------------------------
select tests.login('supervisor');

select is(
  (public.save_dsr_meter_row('petrol', '2026-01-11',
    '{"opening_pump1_nozzle1": 1100, "closing_pump1_nozzle1": 1150, "petrol_rate": 100,
      "dip_reading": 1, "stock": 4850, "buying_price_per_litre": 1, "created_by": "00000000-0000-0000-0000-00000000000a"}',
    '20000000-0000-0000-0000-000000000002')->>'created')::boolean,
  true, 'supervisor inserts a new day');
select is(
  (select row(total_sales, created_by)::text from public.dsr_petrol where date = '2026-01-11'),
  row(50::numeric(14,2), tests.uid('supervisor'))::text,
  'trigger computes sales; created_by is the caller, not the payload');
select tests.logout();
select is(
  (select buying_price_per_litre from public.dsr_petrol where date = '2026-01-11'), null::numeric,
  'buying price in the payload is ignored');
select tests.login('supervisor');

select is(
  (public.save_dsr_meter_row('petrol', '2026-01-11', '{"stock": 1}', '20000000-0000-0000-0000-000000000002')->>'created')::boolean,
  true, 'replayed request returns the first response');
select is((select stock from public.dsr_petrol where date = '2026-01-11'), 4850::numeric, 'and changes nothing');

select throws_like(
  $$ select public.save_dsr_meter_row('petrol', '2026-01-11', '{"remarks": "late"}') $$,
  '%already saved%', 'supervisor cannot change a finished row');
select throws_like(
  $$ select public.save_dsr_meter_row('diesel', '2026-01-11', '{"opening_pump1_nozzle1": 5200, "closing_pump1_nozzle1": 5250, "diesel_rate": 90}') $$,
  '%dip reading or dip stock%', 'rate without dip or stock does not save');
select is((select count(*) from public.dsr_diesel where date = '2026-01-11')::int, 0, 'and leaves no row');
select throws_like(
  $$ select public.save_dsr_meter_row('petrol', public.meter_station_today() + 1, '{"stock": 1}') $$,
  '%future%', 'future date rejected (IST)');
select throws_like(
  $$ select public.save_dsr_meter_row('kerosene', '2026-01-11', '{"stock": 1}') $$,
  '%petrol or diesel%', 'unknown product rejected');
select tests.logout();

select tests.login('admin');
select is(
  (public.save_dsr_meter_row('petrol', '2026-01-11', '{"remarks": "checked", "stock": 4800}')->>'created')::boolean,
  false, 'admin updates a finished row');
select is(
  (select row(stock, remarks, total_sales)::text from public.dsr_petrol where date = '2026-01-11'),
  row(4800::numeric(14,2), 'checked', 50::numeric(14,2))::text,
  'only the sent columns change');

-- Certified day: the meter trigger still rejects the write, even for an admin.
select lives_ok($$ select public.save_day_closing('2026-01-10', 24000, 2500, null) $$, 'D2 saved');
select public.set_day_closing_certified('2026-01-10', true);
select throws_like(
  $$ select public.save_dsr_meter_row('petrol', '2026-01-10', '{"remarks": "x"}') $$,
  '%certified and locked%', 'certified day rejected');
select tests.logout();

select * from finish();
rollback;
