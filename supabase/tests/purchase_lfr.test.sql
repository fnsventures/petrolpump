-- update_dsr_purchase_lfr: Purchase cost saves the shared LFR invoice for a receipt day on its
-- own, on both products' receipt rows, without touching buying price or delivery.
begin;
select plan(10);

select tests.seed_users();
insert into public.dsr_petrol (date, opening_pump1_nozzle1, closing_pump1_nozzle1, petrol_rate, dip_reading, stock, receipts)
values ('2026-02-01', 100, 200, 100, 1, 9000, 4000);
insert into public.dsr_diesel (date, opening_pump1_nozzle1, closing_pump1_nozzle1, diesel_rate, dip_reading, stock, receipts)
values ('2026-02-01', 100, 200, 90, 1, 9000, 8000),
       ('2026-02-02', 200, 300, 90, 1, 8900, 0);

select tests.login('supervisor');
select throws_like($$ select public.update_dsr_purchase_lfr('2026-02-01', 2133, 12, 209.72) $$,
  '%Admin access required%', 'supervisor rejected');
select tests.logout();

select tests.login('anon');
select throws_ok($$ select public.update_dsr_purchase_lfr('2026-02-01', 2133, 12, 209.72) $$,
  '42501', null, 'anon cannot execute');
select tests.logout();

select tests.login('admin');
select is(
  public.update_dsr_purchase_lfr('2026-02-01', 2133, 12, 209.72),
  '{"date": "2026-02-01", "petrol": true, "diesel": true}'::jsonb,
  'admin saves LFR for both products');
select tests.logout();

select is(
  (select row(purchase_lfr_total, purchase_lfr_qty_kl, purchase_lfr_per_kl)::text from public.dsr_petrol where date = '2026-02-01'),
  '(2133.00,12.0000,209.7200)',
  'petrol row has the LFR');
select is(
  (select purchase_lfr_per_kl from public.dsr_diesel where date = '2026-02-01'), 209.72::numeric(12,4),
  'diesel row has the LFR');
select is(
  (select row(buying_price_per_litre, purchase_delivery_per_kl)::text from public.dsr_petrol where date = '2026-02-01'),
  row(null::numeric, null::numeric)::text,
  'buying price and delivery untouched');

select tests.login('admin');
select throws_like($$ select public.update_dsr_purchase_lfr('2026-02-02', 2133, 12, 209.72) $$,
  '%No fuel receipt%', 'day without receipts rejected');
select throws_like($$ select public.update_dsr_purchase_lfr('2026-02-01', 2133, 0, 209.72) $$,
  '%greater than 0%', 'zero quantity rejected');

-- Buying-price save with null LFR args keeps the LFR saved above.
select lives_ok(
  $$ select public.update_dsr_buying_price(
       (select id from public.dsr_petrol where date = '2026-02-01'), 81.41646, null, null, null, 608.95,
       p_purchase_delivery_total => 2435.8, p_purchase_delivery_qty_kl => 4) $$,
  'product save without LFR args');
select tests.logout();
select is(
  (select row(buying_price_per_litre, purchase_lfr_per_kl)::text from public.dsr_petrol where date = '2026-02-01'),
  '(81.41646,209.7200)', 'rate saved, LFR kept');

select * from finish();
rollback;
