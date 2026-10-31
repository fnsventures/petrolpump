-- Stock variance (get_stock_variance), tanker decantation, attendant short/excess
-- (get_attendant_short_excess) and settlement matching (import_settlement_lines,
-- get_settlement_match). Fixture: tests.seed_books() in helpers.sql.
--
-- D2 (2026-01-10) MS: opening dip 5000 (D1), receipts 0, net meter sale 95 (100 - 5 testing),
-- closing dip 4900 → book 4905, variance -5 L, -5.263 %, -500 ₹ at 100/L.
-- D2 HSD: opening 8000, sale 200, dip 7800 → variance 0.
begin;
select plan(24);

select tests.seed_users();
select tests.seed_books();

-- Stock variance ------------------------------------------------------------------------------
select tests.login('supervisor');
create temp table sv on commit drop as
select * from public.get_stock_variance('2026-01-10', '2026-01-10');

select is((select book_stock from sv where product = 'petrol'), 4905::numeric, 'MS book = 5000 + 0 - 95');
select is((select variance_litres from sv where product = 'petrol'), -5::numeric, 'MS variance = dip - book = -5 L');
select is((select variance_pct from sv where product = 'petrol'), -5.263::numeric, 'MS variance % of meter sale');
select is((select variance_value from sv where product = 'petrol'), -500::numeric, 'MS variance ₹ at the day rate');
select ok((select over_tolerance from sv where product = 'petrol'), 'MS -5.3 % is over the 0.5 % default tolerance');
select is((select variance_litres from sv where product = 'diesel'), 0::numeric, 'HSD dip equals book');
select ok(not (select over_tolerance from sv where product = 'diesel'), 'HSD is within tolerance');

-- Decantation: supervisor records a short delivery; it replaces DSR receipts in the book figure.
select lives_ok($$
  insert into public.tanker_decantations
    (decant_date, product, invoice_no, invoice_qty_litres, stock_before_litres, stock_after_litres, created_by)
  values ('2026-01-10', 'petrol', 'BP-1', 1000, 4000, 4990, auth.uid())
$$, 'supervisor records a decantation');
select is((select delivery_variance_litres from public.tanker_decantations where invoice_no = 'BP-1'),
  -10::numeric, 'short delivery = (4990 - 4000) - 1000');
select is((select receipts from public.get_stock_variance('2026-01-10', '2026-01-10') where product = 'petrol'),
  1000::numeric, 'decanted invoice qty is the receipt figure');
select is((select delivery_variance_litres from public.get_stock_variance('2026-01-10', '2026-01-10') where product = 'petrol'),
  -10::numeric, 'variance rows carry the short delivery');
select throws_ok($$
  insert into public.tanker_decantations
    (decant_date, product, invoice_qty_litres, stock_before_litres, stock_after_litres, created_by)
  values (public.meter_station_today() + 1, 'diesel', 100, 0, 100, auth.uid())
$$, 'P0001', null, 'future decantation date is rejected');
select is(tests.try($$ delete from public.tanker_decantations $$), '0', 'supervisor cannot delete a decantation');
select tests.logout();

update public.pump_settings set config = jsonb_set(config, '{alerts}',
  coalesce(config->'alerts', '{}') || '{"stockVarianceTolerancePct": 2000}') where id = 1;
select tests.login('supervisor');
select ok(not (select over_tolerance from public.get_stock_variance('2026-01-10', '2026-01-10') where product = 'petrol'),
  'tolerance comes from pump_settings');

-- Attendant short / excess ------------------------------------------------------------------
select tests.logout();
insert into public.meter_shift_readings (reading_date, product, shift, employee_id, pump_no, nozzle_no, opening_meter, closing_meter, testing_litres)
values ('2026-01-10', 'petrol', 'morning', '00000000-0000-0000-0000-0000000000e1', 1, 1, 1000, 1052, 2);
select tests.login('supervisor');
create temp table se on commit drop as
select * from public.get_attendant_short_excess('2026-01-01', '2026-01-31');

select is((select expected from se where shift = 'morning'), 5000::numeric, 'expected = (52 - 2) L x 100');
select is((select handed_over from se where shift = 'morning'),
  (select cash_collected + phone_pay + credit_amount + expense_amount from public.meter_shift_cash
   where reading_date = '2026-01-10' and shift = 'morning'),
  'handed over = cash + UPI + shift credit + shift expenses');
select is((select short_excess from se where shift = 'morning'),
  (select handed_over - expected from se where shift = 'morning'), 'short_excess = handed over - expected');
select is((select count(*)::int from public.get_attendant_short_excess('2026-01-01', '2026-01-31', gen_random_uuid())),
  0, 'employee filter');

-- Settlement matching -----------------------------------------------------------------------
select throws_ok($$ select public.import_settlement_lines('SBI', null, '{}', '[{"date":"2026-01-10","amount":1}]') $$,
  'P0001', null, 'supervisor cannot import a statement');
select throws_ok($$ select * from public.get_settlement_match('2026-01-10', '2026-01-10') $$,
  'P0001', null, 'supervisor cannot view settlement matching');
select tests.logout();

select tests.login('admin');
select is(
  public.import_settlement_lines('SBI', 'jan.csv', '{"date":"Txn Date"}',
    '[{"date":"2026-01-10","amount":700,"reference":"UTR1"},{"date":"2026-01-10","amount":395,"reference":"UTR2"},{"date":"2026-01-10","amount":5,"reference":"UTR2"}]')->>'inserted',
  '2', 'import stores lines and drops a repeated reference');
select is(
  public.import_settlement_lines('sbi', 'jan-again.csv', '{}', '[{"date":"2026-01-10","amount":700,"reference":"UTR1"}]')->>'skipped',
  '1', 're-importing a reference for the same source is skipped');
-- App UPI on D2 (no closing saved): shift phone pay 700 + Acme UPI payment 400 = 1100; bank 1095.
select is(
  (select format('%s %s %s', app_digital, bank_amount, status)
   from public.get_settlement_match('2026-01-10', '2026-01-10')),
  '1100.00 1095.00 matched', 'within the default ₹10 tolerance the day matches');
select is(
  (select status from public.get_settlement_match('2026-01-10', '2026-01-10', 1)),
  'short', 'a tighter tolerance flags the ₹5 gap as short');
select tests.logout();

select * from finish();
rollback;
