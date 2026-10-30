-- A certified day rejects every write that changes its figures, including from an admin:
-- the money RPCs and save_day_closing (raise_if_day_closing_certified), direct ledger writes
-- (ledger_guard_certified_day), and meter edits (dsr_validate_meter_row). Writes run as admin
-- so they reach the certification check rather than the earlier supervisor shift lock.
begin;
select plan(24);

select tests.seed_users();
select tests.seed_books();

select tests.login('supervisor');
select lives_ok($$ select public.save_day_closing('2026-01-10', 24000, 2500, null) $$, 'D2 saved');
select throws_ok(
  $$ select public.set_day_closing_certified('2026-01-10', true) $$,
  'P0001', null, 'Supervisor cannot certify');
select tests.logout();

select tests.login('anon');
select throws_ok(
  $$ select public.set_day_closing_certified('2026-01-10', true) $$,
  '42501', null, 'Anon cannot call set_day_closing_certified');
select tests.logout();

select tests.login('admin');
select is(
  (public.set_day_closing_certified('2026-01-10', true)->>'certified')::boolean, true, 'Admin certifies D2');

select throws_like(
  $$ select public.add_credit_entry('Acme', '2026-01-10', 10, p_mobile => '9000000002') $$,
  '%certified and locked%', 'add_credit_entry rejected');
select throws_like(
  $$ select public.record_credit_payment(tests.customer('Acme'), '2026-01-10', 10) $$,
  '%certified and locked%', 'record_credit_payment rejected');
select throws_like(
  $$ select public.batch_record_credit_settlements(array[tests.customer('Acme')], tests.customer('Acme'), '2026-01-10', 10) $$,
  '%certified and locked%', 'batch_record_credit_settlements rejected');
select throws_like(
  $$ select public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 10) $$,
  '%certified and locked%', 'add_shift_expense rejected');
select throws_like(
  $$ select public.record_salary_payment('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 10) $$,
  '%certified and locked%', 'record_salary_payment rejected');
select throws_like(
  $$ select public.save_day_closing('2026-01-10', 1, 1, null) $$,
  '%certified%', 'save_day_closing rejected');
select throws_like(
  $$ select public.delete_day_closing((select id from public.day_closing where date = '2026-01-10')) $$,
  '%certified and locked%', 'delete_day_closing rejected');

select throws_like(
  $$ insert into public.expenses (date, category, amount, created_by) values ('2026-01-10', 'miscellaneous', 10, auth.uid()) $$,
  '%certified and locked%', 'Direct expense insert rejected');
select throws_like(
  $$ update public.expenses set amount = amount + 1 where date = '2026-01-10' and salary_payment_id is null $$,
  '%certified and locked%', 'Direct expense update rejected');
select throws_like(
  $$ delete from public.expenses where date = '2026-01-10' and salary_payment_id is null $$,
  '%certified and locked%', 'Direct expense delete rejected');
select throws_like(
  $$ update public.dsr_petrol set closing_pump1_nozzle1 = 1200 where date = '2026-01-10' $$,
  '%certified and locked%', 'Petrol meter edit rejected');
select throws_like(
  $$ update public.dsr_diesel set diesel_rate = 91 where date = '2026-01-10' $$,
  '%certified and locked%', 'Diesel rate edit rejected');
select throws_like(
  $$ delete from public.dsr_petrol where date = '2026-01-10' $$,
  '%certified and locked%', 'Meter row delete rejected');

-- The certified snapshot is what the page shows, even though the live books are unchanged.
select is(
  (public.get_day_closing_breakdown('2026-01-10')->>'certified')::boolean, true, 'Breakdown reports certified');
select is(
  (public.get_day_closing_breakdown('2026-01-10')->>'snapshot')::boolean, true, 'Breakdown serves the frozen snapshot');

-- Other days stay open.
select lives_ok(
  $$ select public.add_credit_entry('Acme', '2026-01-09', 10, p_mobile => '9000000002') $$,
  'A write on an uncertified day still succeeds');

-- Revoke needs a reason; afterwards the day accepts writes again.
select throws_like(
  $$ select public.set_day_closing_certified('2026-01-10', false) $$,
  '%reason is required%', 'Revoke without a reason is rejected');
select is(
  (public.set_day_closing_certified('2026-01-10', false, 'Recount cash')->>'certified')::boolean, false,
  'Admin revokes with a reason');
select lives_ok(
  $$ select public.add_credit_entry('Acme', '2026-01-10', 10, p_mobile => '9000000002') $$,
  'Revoked day accepts writes');
select is(
  (select credit_today from public.day_closing where date = '2026-01-10'),
  1035::numeric,
  'and the saved closing refreshes from the books');

select * from finish();
rollback;
