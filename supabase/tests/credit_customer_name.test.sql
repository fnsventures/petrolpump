-- Credit customer names are stored with inner whitespace collapsed, so a name typed with
-- extra spaces finds the existing customer instead of creating a second one.
begin;
select plan(5);

select tests.seed_users();
select tests.seed_books();

insert into public.credit_customers (customer_name, mobile, date)
values ('  Raja   (Areikana) ', '9000000020', '2026-01-05');

select is(
  (select customer_name from public.credit_customers where mobile = '9000000020'),
  'Raja (Areikana)',
  'insert stores the name trimmed with single spaces');

select tests.login('supervisor');
select public.add_credit_entry('RAJA  (AREIKANA)', '2026-01-06', 300, p_mobile => '9000000020');
select public.add_credit_entry('raja (areikana)', '2026-01-06', 200);
select tests.logout();

select is(
  (select count(*)::int from public.credit_customers where lower(customer_name) = 'raja (areikana)'),
  1,
  'extra spaces and a missing mobile match the same customer');
select is(
  (select amount_due from public.credit_customers where mobile = '9000000020'),
  500::numeric,
  'both sales are on that customer');

update public.credit_customers set customer_name = 'Raja    Areikana' where mobile = '9000000020';
select is(
  (select customer_name from public.credit_customers where mobile = '9000000020'),
  'Raja Areikana',
  'update stores the name with single spaces');

-- Two names that differ only in spacing collide on (name, mobile) once stored.
select throws_ok(
  $$ insert into public.credit_customers (customer_name, mobile, date)
     values ('Raja  Areikana', '9000000020', '2026-01-05') $$,
  '23505', null,
  'a second row with the same name and mobile is rejected');

select * from finish();
rollback;
