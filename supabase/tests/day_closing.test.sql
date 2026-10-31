-- Day-closing totals: compute_day_closing_components, save_day_closing, the short chain.
-- Fixture and the hand-worked figures: tests.seed_books() in supabase/tests/helpers.sql.
-- Formula: docs/DAY_CLOSING.md. A change to any figure here is a change to the money the
-- station reconciles every night, so update the expected value only on purpose.
begin;
select plan(33);

select tests.seed_users();
select tests.seed_books();
select tests.login('supervisor');

-- D1 ------------------------------------------------------------------------------------------
create temp table d1 on commit drop as
select public.compute_day_closing_components('2026-01-09') as c;

select is((c->>'total_sale')::numeric, 19000::numeric, 'D1 total_sale = 100 L x 100 + 100 L x 90') from d1;
select is((c->>'credit_today')::numeric, 500::numeric, 'D1 credit_today = Old Co sale') from d1;
select is((c->>'collection')::numeric, 600::numeric, 'D1 collection includes a prepaid payment with nothing due') from d1;
select is((c->>'expenses_today')::numeric, 0::numeric, 'D1 has no expenses') from d1;
select is((c->>'short_previous')::numeric, 0::numeric, 'D1 short_previous is 0 with no prior closing') from d1;

-- D2 ------------------------------------------------------------------------------------------
create temp table d2 on commit drop as
select public.compute_day_closing_components('2026-01-10') as c;

select is((c->>'total_sale')::numeric, 28000::numeric, 'D2 total_sale uses gross litres (testing included)') from d2;
select is((c->>'collection')::numeric, 350::numeric,
  'D2 collection = unflagged Cash 300 + Bank 50; same-day settlements excluded') from d2;
select is((c->>'credit_today')::numeric, 1025::numeric,
  'D2 credit_today = Acme 600 + Bulk Co 150 + prepaid-settled 200 + legacy 75') from d2;
select is((c->>'expenses_today')::numeric, 1350::numeric, 'D2 expenses_today = shift 200 + book 150 + salary 1000') from d2;

select is((c->>'credit_shift_gross')::numeric, 1000::numeric, 'D2 credit_shift_gross = Ravi''s shift sale') from d2;
select is((c->>'credit_shift')::numeric, 950::numeric, 'D2 credit_shift = least(shift gross, open credit 950)') from d2;
select is((c->>'credit_ledger')::numeric, 75::numeric, 'D2 credit_ledger = credit_today - credit_shift') from d2;
select is((c->>'expenses_shift')::numeric, 200::numeric, 'D2 expenses_shift') from d2;
select is((c->>'expenses_ledger')::numeric, 1150::numeric, 'D2 expenses_ledger') from d2;

select is((c->>'same_day_settle')::numeric, 500::numeric, 'D2 same_day_settle = 400 UPI + 100 Cash') from d2;
select is((c->>'same_day_settle_cash')::numeric, 100::numeric, 'D2 same_day_settle_cash') from d2;
select is((c->>'same_day_settle_upi')::numeric, 400::numeric, 'D2 same_day_settle_upi') from d2;
select is((c->>'same_day_settle_bank')::numeric, 0::numeric, 'D2 same_day_settle_bank') from d2;
select is((c->>'suggested_night_cash')::numeric, 5400::numeric,
  'D2 suggested_night_cash = shift cash 5000 + all Cash payments 400') from d2;
select is((c->>'suggested_phone_pay')::numeric, 1100::numeric,
  'D2 suggested_phone_pay = shift phone pay 700 + all UPI payments 400') from d2;

select is(
  (select prepaid_balance from public.credit_customers where id = tests.customer('Prepaid Co')),
  400::numeric,
  'Prepaid Co: 600 prepaid less the 200 sale settled from it');

-- Save, short chain, breakdown ---------------------------------------------------------------
-- D1 short = 19000 + 600 + 0 - (18000 + 500 + 500 + 0) = 600
select is(
  (public.save_day_closing('2026-01-09', 18000, 500, null)->>'short_today')::numeric,
  600::numeric,
  'D1 save: short_today = (sale + collection + short_prev) - (night cash + phone pay + credit + expenses)');

-- D2 short = 28000 + 350 + 600 - (24000 + 2500 + 1025 + 1350) = 75
select is(
  (public.save_day_closing('2026-01-10', 24000, 2500, null)->>'short_today')::numeric,
  75::numeric,
  'D2 save carries D1''s short as short_previous');

select results_eq(
  $$ select total_sale, collection, short_previous, credit_today, expenses_today, night_cash, phone_pay, short_today
     from public.day_closing where date = '2026-01-10' $$,
  $$ values (28000::numeric, 350::numeric, 600::numeric, 1025::numeric, 1350::numeric, 24000::numeric, 2500::numeric, 75::numeric) $$,
  'D2 stored row matches the components');

select is(
  (select closing_reference from public.day_closing where date = '2026-01-09'),
  'DC-2026-00001',
  'First closing of the year gets DC-2026-00001');

-- Re-saving D1 with less night cash walks the chain forward.
select lives_ok($$ select public.save_day_closing('2026-01-09', 17900, 500, null) $$, 'D1 re-save');
select is(
  (select short_today from public.day_closing where date = '2026-01-10'),
  175::numeric,
  'Re-saving D1 (short 700) recascades D2 (short 175)');

-- Once a day is saved only an admin changes its shifts; a book expense still lands and
-- refreshes the saved snapshot.
select throws_ok(
  $$ select public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 25) $$,
  'P0001', 'Day closing is saved for 2026-01-10. Only an admin can change shift afternoon.',
  'Supervisor cannot add a shift expense after the day is saved');
insert into public.expenses (date, category, amount, created_by)
values ('2026-01-10', 'miscellaneous', 25, auth.uid());
select is(
  (select expenses_today from public.day_closing where date = '2026-01-10'),
  1375::numeric,
  'A book expense on a saved, uncertified day refreshes expenses_today');
select is(
  (select short_today from public.day_closing where date = '2026-01-10'),
  150::numeric,
  'and recomputes its short');

create temp table bd on commit drop as
select public.get_day_closing_breakdown('2026-01-10') as b;
select is((b->>'already_saved')::boolean, true, 'Breakdown reports the saved row') from bd;
select is((b->>'expenses_today')::numeric, 1375::numeric, 'Breakdown matches the live components') from bd;

select throws_ok(
  $$ select public.save_day_closing('2026-01-11', -1, 0, null) $$,
  'P0001', null,
  'Negative night cash is rejected');

select * from finish();
rollback;
