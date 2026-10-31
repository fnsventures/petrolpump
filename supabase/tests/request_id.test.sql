-- Money RPCs are retry-safe: a repeated p_request_id replays the first response and writes
-- nothing new (write_request_replay / write_request_store). A browser retry after a timeout
-- must never post a sale, payment, expense, invoice or salary twice.
begin;
select plan(24);

select tests.seed_users();
select tests.seed_books();
select tests.login('supervisor');

-- add_credit_entry
create temp table r1 on commit drop as
select public.add_credit_entry('Retry Co', '2026-01-10', 111, p_mobile => '9000000009',
  p_request_id => '10000000-0000-0000-0000-000000000001') as a,
       public.add_credit_entry('Retry Co', '2026-01-10', 111, p_mobile => '9000000009',
  p_request_id => '10000000-0000-0000-0000-000000000001') as b;
select is(b, a, 'add_credit_entry replay returns the first response') from r1;
select is(
  (select count(*) from public.credit_entries where credit_customer_id = tests.customer('Retry Co'))::int, 1,
  'add_credit_entry wrote one entry');
select is(
  (select amount_due from public.credit_customers where id = tests.customer('Retry Co')), 111::numeric,
  'and amount_due counts it once');

-- record_credit_payment
select ok(public.record_credit_payment(tests.customer('Retry Co'), '2026-01-10', 11, p_request_id => '10000000-0000-0000-0000-000000000002') is not null, 'first payment');
select ok(public.record_credit_payment(tests.customer('Retry Co'), '2026-01-10', 11, p_request_id => '10000000-0000-0000-0000-000000000002') is not null, 'replayed payment');
select is(
  (select count(*) from public.credit_payments where credit_customer_id = tests.customer('Retry Co'))::int, 1,
  'record_credit_payment wrote one payment');
select is(
  (select amount_due from public.credit_customers where id = tests.customer('Retry Co')), 100::numeric,
  'and amount_due is reduced once');

-- batch_record_credit_settlements
select ok(public.batch_record_credit_settlements(array[tests.customer('Retry Co')], tests.customer('Retry Co'),
  '2026-01-10', 20, p_request_id => '10000000-0000-0000-0000-000000000003') is not null, 'first batch');
select ok(public.batch_record_credit_settlements(array[tests.customer('Retry Co')], tests.customer('Retry Co'),
  '2026-01-10', 20, p_request_id => '10000000-0000-0000-0000-000000000003') is not null, 'replayed batch');
select is(
  (select count(*) from public.credit_payments where credit_customer_id = tests.customer('Retry Co'))::int, 2,
  'batch_record_credit_settlements wrote one more payment');

-- add_shift_expense
select ok(public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 33,
  'Retry', '10000000-0000-0000-0000-000000000004') is not null, 'first expense');
select ok(public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 33,
  'Retry', '10000000-0000-0000-0000-000000000004') is not null, 'replayed expense');
select is(
  (select count(*) from public.expenses where description = 'Retry')::int, 1,
  'add_shift_expense wrote one expense');

-- save_invoice
create temp table r5 on commit drop as
select public.save_invoice('2026-01-10', 'CASH', 'Walk-in', p_items => '[{"item_name":"Engine oil","quantity":2,"rate":250}]',
  p_request_id => '10000000-0000-0000-0000-000000000005') as a,
       public.save_invoice('2026-01-10', 'CASH', 'Walk-in', p_items => '[{"item_name":"Engine oil","quantity":2,"rate":250}]',
  p_request_id => '10000000-0000-0000-0000-000000000005') as b;
select is(b, a, 'save_invoice replay returns the first response') from r5;
select is((select count(*) from public.invoices where party_name = 'Walk-in')::int, 1, 'save_invoice wrote one invoice');
select is(
  (select count(*) from public.invoice_items i join public.invoices v on v.id = i.invoice_id where v.party_name = 'Walk-in')::int, 1,
  'and one line item');

-- The day's figures count each write once: 1025 + 111 credit, 1350 + 33 expense.
select is(
  (public.compute_day_closing_components('2026-01-10')->>'credit_today')::numeric, 1136::numeric,
  'credit_today counts the retried sale once');
select is(
  (public.compute_day_closing_components('2026-01-10')->>'expenses_today')::numeric, 1383::numeric,
  'expenses_today counts the retried expense once');
select tests.logout();

-- record_salary_payment (admin)
select tests.login('admin');
select ok(public.record_salary_payment('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 500,
  'Retry', false, '10000000-0000-0000-0000-000000000006') is not null, 'first salary');
select ok(public.record_salary_payment('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 500,
  'Retry', false, '10000000-0000-0000-0000-000000000006') is not null, 'replayed salary');
select is((select count(*) from public.salary_payments where note = 'Retry')::int, 1, 'record_salary_payment wrote one payment');
select is(
  (select count(*) from public.expenses e join public.salary_payments s on s.id = e.salary_payment_id where s.note = 'Retry')::int, 1,
  'and one salary expense');

-- A request id is bound to its action and its caller.
select throws_like(
  $$ select public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 1,
       null, '10000000-0000-0000-0000-000000000006') $$,
  '%different action%', 'Reusing a request id for another RPC is rejected');
select tests.logout();

select tests.login('supervisor');
select throws_like(
  $$ select public.record_salary_payment('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 500,
       'Retry', false, '10000000-0000-0000-0000-000000000006') $$,
  '%different action%', 'Another user cannot replay someone else''s request id');

select * from finish();
rollback;
