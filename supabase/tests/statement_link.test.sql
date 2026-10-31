-- Read-only statement links: only the hash is stored, the reader is service-role only, and an
-- expired or revoked link returns nothing.
begin;
select plan(15);

select tests.seed_users();
select tests.seed_books();

create temp table link (j jsonb) on commit drop;
grant all on link to anon, authenticated, service_role;
select tests.login('supervisor');
insert into link select public.create_credit_statement_link(tests.customer('Acme'), 30);
select throws_ok($$ select public.create_credit_statement_link(tests.customer('Acme'), 91) $$,
  'P0001', 'valid days must be between 1 and 90', 'Link validity is capped at 90 days');
select throws_ok($$ select public.get_credit_statement_by_token('x') $$,
  '42501', null, 'A login cannot call the token reader');
select tests.logout();

select is(
  (select count(*)::int from public.credit_statement_links l, link
   where l.token_hash = encode(sha256(convert_to(link.j->>'token', 'UTF8')), 'hex')),
  1, 'Only the token hash is stored');
select is(
  (select count(*)::int from public.credit_statement_links l, link where l.token_hash = link.j->>'token'),
  0, 'The plain token is not stored');

select tests.login('anon');
select throws_ok($$ select public.get_credit_statement_by_token('x') $$,
  '42501', null, 'anon cannot call the token reader');
select tests.logout();

create temp table st (s jsonb) on commit drop;
grant all on st to service_role;
set local role service_role;
insert into st select public.get_credit_statement_by_token(link.j->>'token') from link;
reset role;

select is((select s->>'customer_name' from st), 'Acme', 'Statement names the customer');
select is((select (s->>'balance')::numeric from st), 600::numeric, 'Balance = credit - payments');
select is((select (s->>'opening_balance')::numeric + 0 from st),
  (select case when '2026-01-10'::date < public.meter_station_today() - 90 then 600 else 0 end)::numeric,
  'Activity before the 90-day window is in the opening balance');
select ok((select s::text !~ 'created_by|note' from st), 'No staff names or notes in the statement');
select ok((select s #>> '{station,name}' <> '' from st), 'Statement carries the station letterhead name');
select is((select (s->>'opening_balance')::numeric + (s->>'period_billed')::numeric - (s->>'period_paid')::numeric from st),
  (select (s->>'balance')::numeric from st), 'Opening + billed - paid = balance');
select is((select coalesce((s->'lines'->-1->>'balance')::numeric, (s->>'opening_balance')::numeric) from st),
  (select (s->>'balance')::numeric from st), 'Running balance ends at the balance');
select is((select view_count from public.credit_statement_links), 1, 'A view is counted');

select tests.login('supervisor');
select is(public.revoke_credit_statement_links(tests.customer('Acme')), 1, 'Revoke ends the live link');
select tests.logout();

set local role service_role;
select is((select public.get_credit_statement_by_token(link.j->>'token') from link), null::jsonb,
  'A revoked link returns nothing');
reset role;

select * from finish();
rollback;
