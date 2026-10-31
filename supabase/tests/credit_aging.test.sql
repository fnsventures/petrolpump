-- Aging windows match the customer page Activity: outstanding = credit taken minus
-- settlements dated in the window, the same as get_customer_credit_detail_as_of for those dates.
begin;
select plan(5);

select tests.seed_users();
select tests.seed_books();

create temp table aging as select * from public.get_credit_aging('2026-01-10') limit 0;
grant all on aging to authenticated;
select tests.login('supervisor');
insert into aging select * from public.get_credit_aging('2026-01-10');
select tests.logout();

select is((select outstanding from aging where customer_name = 'Acme' and bucket = '0-30'),
  600::numeric, 'Acme 0-30: 1000 credit - 400 settled');
select is((select outstanding from aging where customer_name = 'Prepaid Co' and bucket = '0-30'),
  -400::numeric, 'Prepaid Co 0-30: 200 credit - 600 paid shows as a 400 advance');
select is((select count(*)::int from aging where bucket <> '0-30'), 0,
  'Nothing older than 30 days in the seed');
select is(
  (select sum(outstanding) from aging),
  (select sum(e.amount) from public.credit_entries e where e.status = 'posted' and e.transaction_date <= '2026-01-10')
  - (select sum(p.amount) from public.credit_payments p where p.status = 'posted' and p.date <= '2026-01-10'),
  'Windows add up to all credit minus all settlements');

select tests.login('supervisor');
select is(
  (select remaining from public.get_customer_credit_detail_as_of('Old Co', a.period_to, a.period_from))
    , (select outstanding from aging a2 where a2.customer_name = 'Old Co' and a2.bucket = '0-30'),
  'Old Co matches the customer page for the same dates')
from aging a where a.customer_name = 'Old Co' and a.bucket = '0-30';
select tests.logout();

select * from finish();
