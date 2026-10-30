-- Who can read and write each table, and who can open each page.
--
-- Three layers, so that a PR which opens up access fails here whichever way it does it:
--   1. Catalog guards: every public table has RLS; the full policy list is pinned; anon cannot
--      execute any app function; client roles have no write grant on the server-only tables.
--   2. A per-role matrix: anon, a signed-in stranger (no public.users row), supervisor and admin
--      run select / insert / update / delete against each table and must get the expected
--      outcome (a row count, or 42501 for denied).
--   3. check_page_access for every page and role.
--
-- When you add a table, policy, or page on purpose, add it here in the same PR.
begin;
select plan(199);

select tests.seed_users();
select tests.seed_books();
select tests.login('supervisor');
select lives_ok($$ select public.save_day_closing('2026-01-09', 18000, 500, null) $$, 'Fixture: D1 closing saved');
select lives_ok($$ insert into public.client_errors (message, page, user_id, role, user_email)
                  values ('Fixture error', 'dsr.html', tests.uid('admin'), 'admin', 'admin@test.local') $$,
                'Fixture: supervisor reports a client error');
select tests.logout();

-- 1. Catalog guards ---------------------------------------------------------------------------

select is(
  array(select c.relname::text from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
        order by 1),
  '{}'::text[],
  'Every public table has row level security enabled');

select is(
  array(select c.relname::text from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1),
  array[
    'audit_log', 'client_errors', 'credit_customers', 'credit_entries', 'credit_payments', 'credit_statement_links', 'day_closing',
    'document_categories', 'drive_folder_cache', 'dsr_diesel', 'dsr_petrol', 'e20_quality_checks',
    'e20_testing_registers', 'e20_water_checks', 'employee_attendance', 'employees',
    'expense_categories', 'expenses', 'invoice_documents', 'invoice_items', 'invoices',
    'letterhead_letters', 'meter_shift_cash', 'meter_shift_readings', 'night_cash_collections',
    'products', 'pump_settings', 'reminders', 'runtime_flags', 'salary_lop_exclusions',
    'salary_payments', 'settlement_imports', 'settlement_lines', 'tanker_decantations', 'users',
    'write_requests'
  ],
  'Table list is pinned: a new table needs RLS cases in this file');

-- Views run with the caller's rights (dsr, dsr_stock) or filter to admin (dsr_cost).
select is(
  array(select c.relname || ':' || coalesce(array_to_string(c.reloptions, ','), '') from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' order by 1),
  array['dsr:security_invoker=true', 'dsr_cost:security_invoker=false,security_barrier=true', 'dsr_stock:security_invoker=true'],
  'View security options are pinned');

-- Every policy, verbatim. Changing a USING / WITH CHECK clause changes this list.
select set_eq(
  $$ select tablename || ' | ' || policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',')
            || ' | ' || coalesce(qual, '') || ' | ' || coalesce(with_check, '')
     from pg_policies where schemaname = 'public' $$,
  $$ values
    ('audit_log | audit_log_no_direct_write | ALL | authenticated | false | false'),
    ('audit_log | audit_log_select_admin | SELECT | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('client_errors | client_errors_insert_own | INSERT | authenticated |  | (user_id = ( SELECT auth.uid() AS uid))'),
    ('client_errors | client_errors_select_admin | SELECT | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('credit_customers | credit_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('credit_customers | credit_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('credit_customers | credit_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('credit_customers | credit_update_by_role | UPDATE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('credit_entries | credit_entries_delete_admin | DELETE | authenticated | false | '),
    ('credit_entries | credit_entries_insert_own | INSERT | authenticated |  | false'),
    ('credit_entries | credit_entries_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('credit_entries | credit_entries_update_by_role | UPDATE | authenticated | false | false'),
    ('credit_payments | credit_payments_delete_admin | DELETE | authenticated | false | '),
    ('credit_statement_links | credit_statement_links_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('credit_payments | credit_payments_insert_own | INSERT | authenticated |  | false'),
    ('credit_payments | credit_payments_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('credit_payments | credit_payments_update_by_role | UPDATE | authenticated | false | false'),
    ('day_closing | day_closing_delete_admin | DELETE | authenticated | false | '),
    ('day_closing | day_closing_insert_own | INSERT | authenticated |  | false'),
    ('day_closing | day_closing_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('day_closing | day_closing_update_by_role | UPDATE | authenticated | false | false'),
    ('document_categories | document_categories_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('document_categories | document_categories_insert_admin | INSERT | authenticated |  | ( SELECT is_admin() AS is_admin)'),
    ('document_categories | document_categories_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('document_categories | document_categories_update_admin | UPDATE | authenticated | ( SELECT is_admin() AS is_admin) | ( SELECT is_admin() AS is_admin)'),
    ('dsr_diesel | dsr_diesel_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('dsr_diesel | dsr_diesel_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)) AND (( SELECT is_admin() AS is_admin) OR (NOT meter_day_is_locked(date))))'),
    ('dsr_diesel | dsr_diesel_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('dsr_diesel | dsr_diesel_update_by_role | UPDATE | authenticated | (( SELECT is_admin() AS is_admin) OR (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (NOT meter_day_is_locked(date)) AND (NOT dsr_meter_row_is_complete(diesel_rate, dip_reading, stock, receipts)))) | (( SELECT is_admin() AS is_admin) OR (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (NOT meter_day_is_locked(date))))'),
    ('dsr_petrol | dsr_petrol_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('dsr_petrol | dsr_petrol_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)) AND (( SELECT is_admin() AS is_admin) OR (NOT meter_day_is_locked(date))))'),
    ('dsr_petrol | dsr_petrol_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('dsr_petrol | dsr_petrol_update_by_role | UPDATE | authenticated | (( SELECT is_admin() AS is_admin) OR (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (NOT meter_day_is_locked(date)) AND (NOT dsr_meter_row_is_complete(petrol_rate, dip_reading, stock, receipts)))) | (( SELECT is_admin() AS is_admin) OR (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (NOT meter_day_is_locked(date))))'),
    ('e20_quality_checks | e20_quality_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('e20_quality_checks | e20_quality_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('e20_testing_registers | e20_registers_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('e20_testing_registers | e20_registers_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('e20_testing_registers | e20_registers_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('e20_testing_registers | e20_registers_update_staff | UPDATE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('e20_water_checks | e20_water_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('e20_water_checks | e20_water_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('employee_attendance | employee_attendance_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('employee_attendance | employee_attendance_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('employee_attendance | employee_attendance_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('employee_attendance | employee_attendance_update_own | UPDATE | authenticated | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))) | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))'),
    ('employees | employees_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('employees | employees_insert_staff | INSERT | authenticated |  | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('employees | employees_select_staff | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('employees | employees_update_staff | UPDATE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('expense_categories | expense_categories_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('expense_categories | expense_categories_insert_admin | INSERT | authenticated |  | ( SELECT is_admin() AS is_admin)'),
    ('expense_categories | expense_categories_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('expense_categories | expense_categories_update_admin | UPDATE | authenticated | ( SELECT is_admin() AS is_admin) | ( SELECT is_admin() AS is_admin)'),
    ('expenses | expenses_delete_admin | DELETE | authenticated | ((( SELECT is_admin() AS is_admin) AND (salary_payment_id IS NULL)) OR (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)) AND (employee_id IS NOT NULL) AND (shift IS NOT NULL))) | '),
    ('expenses | expenses_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)) AND (salary_payment_id IS NULL) AND (lower(COALESCE(category, ''''::text)) <> ''salary''::text))'),
    ('expenses | expenses_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('expenses | expenses_update_by_role | UPDATE | authenticated | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)) AND (salary_payment_id IS NULL)) | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)) AND (salary_payment_id IS NULL) AND (lower(COALESCE(category, ''''::text)) <> ''salary''::text))'),
    ('invoice_documents | invoice_documents_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('invoice_documents | invoice_documents_insert | INSERT | authenticated |  | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('invoice_documents | invoice_documents_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('invoice_items | invoice_items_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('invoice_items | invoice_items_insert_own | INSERT | authenticated |  | false'),
    ('invoice_items | invoice_items_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('invoice_items | invoice_items_update_by_role | UPDATE | authenticated | false | false'),
    ('invoices | invoices_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('invoices | invoices_insert_own | INSERT | authenticated |  | false'),
    ('invoices | invoices_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('invoices | invoices_update_by_role | UPDATE | authenticated | false | false'),
    ('letterhead_letters | letterhead_letters_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('letterhead_letters | letterhead_letters_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('letterhead_letters | letterhead_letters_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('letterhead_letters | letterhead_letters_update_by_role | UPDATE | authenticated | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))) | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))'),
    ('meter_shift_cash | meter_shift_cash_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('meter_shift_readings | meter_shift_readings_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('night_cash_collections | night_cash_collections_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('products | products_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('products | products_insert_admin | INSERT | authenticated |  | ( SELECT is_admin() AS is_admin)'),
    ('products | products_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('products | products_update_admin | UPDATE | authenticated | ( SELECT is_admin() AS is_admin) | ( SELECT is_admin() AS is_admin)'),
    ('pump_settings | pump_settings_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('pump_settings | pump_settings_upsert_admin | ALL | authenticated | ( SELECT is_admin() AS is_admin) | ( SELECT is_admin() AS is_admin)'),
    ('reminders | reminders_delete_staff | DELETE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('reminders | reminders_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('reminders | reminders_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('reminders | reminders_update_staff | UPDATE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('salary_lop_exclusions | salary_lop_exclusions_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('salary_lop_exclusions | salary_lop_exclusions_insert_admin | INSERT | authenticated |  | (( SELECT is_admin() AS is_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('salary_lop_exclusions | salary_lop_exclusions_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('salary_payments | salary_payments_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('salary_payments | salary_payments_insert_own | INSERT | authenticated |  | false'),
    ('salary_payments | salary_payments_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('salary_payments | salary_payments_update_by_role | UPDATE | authenticated | false | false'),
    ('settlement_imports | settlement_imports_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('settlement_imports | settlement_imports_select_admin | SELECT | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('settlement_lines | settlement_lines_select_admin | SELECT | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('tanker_decantations | tanker_decantations_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('tanker_decantations | tanker_decantations_insert_own | INSERT | authenticated |  | (( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) AND (created_by = ( SELECT auth.uid() AS uid)))'),
    ('tanker_decantations | tanker_decantations_select | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('tanker_decantations | tanker_decantations_update_staff | UPDATE | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin)'),
    ('users | users_delete_admin | DELETE | authenticated | ( SELECT is_admin() AS is_admin) | '),
    ('users | users_insert_admin | INSERT | authenticated |  | (( SELECT is_admin() AS is_admin) OR ((COALESCE(current_setting(''app.allow_first_admin''::text, true), ''''::text) = ''on''::text) AND (NOT (EXISTS ( SELECT 1
   FROM users u
  WHERE (u.role = ''admin''::text)))) AND (lower(TRIM(BOTH FROM email)) = lower(TRIM(BOTH FROM COALESCE((( SELECT auth.jwt() AS jwt) ->> ''email''::text), ''''::text)))) AND (role = ''admin''::text)))'),
    ('users | users_select_authenticated | SELECT | authenticated | ( SELECT is_supervisor_or_admin() AS is_supervisor_or_admin) | '),
    ('users | users_update_admin | UPDATE | authenticated | ( SELECT is_admin() AS is_admin) | ( SELECT is_admin() AS is_admin)')
  $$,
  'Policy list is pinned: a changed USING / WITH CHECK needs a matching case below');

-- Without a login is_admin() is null and require_staff_access() returns early, so a function
-- anon can execute runs with no role check at all.
select is(
  array(select p.oid::regprocedure::text from pg_proc p
        left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
        where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
          and d.objid is null and p.prorettype <> 'trigger'::regtype
          and has_function_privilege('anon', p.oid, 'execute')
        order by 1),
  '{}'::text[],
  'anon cannot execute any public app function');

select is(
  array(select format('%s:%s', t, priv)
        from unnest(array['day_closing', 'credit_entries', 'credit_payments', 'invoices', 'invoice_items',
                          'salary_payments', 'meter_shift_cash', 'meter_shift_readings', 'runtime_flags',
                          'write_requests']) t,
             unnest(array['INSERT', 'UPDATE']) priv
        where has_table_privilege('authenticated', 'public.' || t, priv)
          and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t
                      and p.cmd in (priv, 'ALL') and coalesce(p.with_check, p.qual) <> 'false')
        order by 1),
  '{}'::text[],
  'Server-only tables have no insert/update path for a client (no grant, or a false policy)');

-- 2. Role matrix ------------------------------------------------------------------------------
-- tests.try returns the row count, or the SQLSTATE: 42501 = denied. A '0' means RLS filtered
-- every row. 'none' accepts either: anon and the stranger must see nothing, and whether that is
-- a missing grant or an empty policy result does not matter.

create temp table matrix (who text, op text, tbl text, stmt text, expected text) on commit drop;
grant all on matrix to anon, authenticated;

insert into matrix (who, op, tbl, stmt, expected)
select who, 'select', t, format('select * from public.%I', t), exp
from (values
  -- table                  anon     stranger  supervisor  admin
  ('audit_log',             'none',  'none',   '0',        '>0'),
  ('client_errors',         'none',  'none',   '0',        '>0'),
  ('credit_customers',      'none',  'none',   '>0',       '>0'),
  ('credit_entries',        'none',  'none',   '>0',       '>0'),
  ('credit_payments',       'none',  'none',   '>0',       '>0'),
  ('credit_statement_links','none',  'none',   '0',        '0'),
  ('day_closing',           'none',  'none',   '>0',       '>0'),
  ('dsr_petrol',            'none',  'none',   '>0',       '>0'),
  ('dsr_diesel',            'none',  'none',   '>0',       '>0'),
  ('dsr',                   'none',  'none',   '>0',       '>0'),
  ('dsr_stock',             'none',  'none',   '>0',       '>0'),
  ('dsr_cost',              'none',  'none',   '0',        '>0'),
  ('employees',             'none',  'none',   '>0',       '>0'),
  ('expenses',              'none',  'none',   '>0',       '>0'),
  ('meter_shift_cash',      'none',  'none',   '>0',       '>0'),
  ('pump_settings',         'none',  'none',   '>0',       '>0'),
  ('salary_payments',       'none',  'none',   '>0',       '>0'),
  ('users',                 'none',  'none',   '>0',       '>0'),
  ('runtime_flags',         '42501', '42501',  '42501',    '42501'),
  ('write_requests',        '42501', '42501',  '42501',    '42501')
) v(t, a, s, sup, adm)
cross join lateral (values ('anon', a), ('stranger', s), ('supervisor', sup), ('admin', adm)) w(who, exp);

-- Writes no client may make directly: money and closing rows only change through RPCs.
-- 'blocked' = denied (42501) or filtered to 0 rows; either way nothing changes.
insert into matrix (who, op, tbl, stmt, expected)
select who, op, t, stmt, 'blocked'
from (values
  ('day_closing', 'insert', $$insert into public.day_closing (date, night_cash) values ('2026-01-01', 1)$$),
  ('day_closing', 'update', $$update public.day_closing set night_cash = 1$$),
  ('credit_entries', 'insert', $$insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount) values (tests.customer('Acme'), '2026-01-10', 'MS', 1, 1)$$),
  ('credit_entries', 'update', $$update public.credit_entries set amount = amount + 1$$),
  ('credit_payments', 'insert', $$insert into public.credit_payments (credit_customer_id, date, amount) values (tests.customer('Acme'), '2026-01-10', 1)$$),
  ('credit_payments', 'update', $$update public.credit_payments set amount = amount + 1$$),
  ('salary_payments', 'insert', $$insert into public.salary_payments (employee_id, date, salary_month, amount) values ('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 1)$$),
  ('salary_payments', 'update', $$update public.salary_payments set amount = amount + 1$$),
  ('invoices', 'insert', $$insert into public.invoices (invoice_number) values ('X-1')$$),
  ('meter_shift_cash', 'update', $$update public.meter_shift_cash set cash_collected = 1$$),
  ('audit_log', 'insert', $$insert into public.audit_log (table_name, action) values ('x', 'INSERT')$$),
  ('audit_log', 'delete', $$delete from public.audit_log$$),
  ('day_closing', 'delete', $$delete from public.day_closing$$),
  ('credit_entries', 'delete', $$delete from public.credit_entries$$),
  ('credit_payments', 'delete', $$delete from public.credit_payments$$)
) v(t, op, stmt)
cross join unnest(array['supervisor', 'admin']) who;

-- Supervisor vs admin on the tables where they differ.
insert into matrix (who, op, tbl, stmt, expected) values
  ('supervisor', 'insert', 'expenses',
   $$insert into public.expenses (date, category, amount, created_by) values ('2026-01-10', 'salary', 1, auth.uid())$$, '42501'),
  ('supervisor', 'insert', 'expenses',
   $$insert into public.expenses (date, category, amount, created_by) values ('2026-01-10', 'miscellaneous', 1, tests.uid('admin'))$$, '42501'),
  ('supervisor', 'insert', 'expenses',
   $$insert into public.expenses (date, category, amount, created_by) values ('2026-01-10', 'miscellaneous', 1, auth.uid())$$, '1'),
  ('supervisor', 'update', 'expenses',
   $$update public.expenses set description = 'x' where salary_payment_id is not null$$, '0'),
  ('admin', 'update', 'expenses',
   $$update public.expenses set description = 'x' where salary_payment_id is not null$$, '0'),
  ('supervisor', 'delete', 'expenses',
   $$delete from public.expenses where description = 'Pump repair'$$, '0'),
  ('admin', 'delete', 'expenses',
   $$delete from public.expenses where description = 'Pump repair'$$, '1'),
  ('supervisor', 'delete', 'credit_customers', $$delete from public.credit_customers where customer_name = 'Legacy Co'$$, '0'),
  ('admin', 'delete', 'credit_customers', $$delete from public.credit_customers where customer_name = 'Legacy Co'$$, '1'),
  ('supervisor', 'insert', 'credit_customers',
   $$insert into public.credit_customers (customer_name, created_by) values ('Spoof Co', tests.uid('admin'))$$, '42501'),
  ('supervisor', 'insert', 'credit_customers',
   $$insert into public.credit_customers (customer_name, created_by) values ('New Co', auth.uid())$$, '1'),
  ('supervisor', 'update', 'dsr_petrol', $$update public.dsr_petrol set remarks = 'x' where date = '2026-01-10'$$, '0'),
  ('admin', 'update', 'dsr_petrol', $$update public.dsr_petrol set remarks = 'x' where date = '2026-01-10'$$, '1'),
  ('supervisor', 'delete', 'dsr_petrol', $$delete from public.dsr_petrol where date = '2026-01-10'$$, '0'),
  ('supervisor', 'update', 'pump_settings', $$update public.pump_settings set id = id$$, '0'),
  ('admin', 'update', 'pump_settings', $$update public.pump_settings set id = id$$, '1'),
  ('supervisor', 'insert', 'expense_categories', $$insert into public.expense_categories (name, label) values ('x', 'X')$$, '42501'),
  ('admin', 'insert', 'expense_categories', $$insert into public.expense_categories (name, label) values ('x', 'X')$$, '1'),
  ('supervisor', 'insert', 'products', $$insert into public.products (name) values ('Coolant')$$, '42501'),
  ('admin', 'insert', 'products', $$insert into public.products (name) values ('Coolant')$$, '1'),
  ('supervisor', 'update', 'users', $$update public.users set role = 'admin' where email = 'supervisor@test.local'$$, '0'),
  -- users_insert_admin reads public.users inside its own check, which Postgres rejects as
  -- recursive (42P17) for every caller. Staff are added through upsert_staff.
  ('supervisor', 'insert', 'users', $$insert into public.users (email, role) values ('x@test.local', 'admin')$$, '42P17'),
  ('admin', 'insert', 'users', $$insert into public.users (email, role) values ('x@test.local', 'supervisor')$$, '42P17'),
  ('admin', 'update', 'users', $$update public.users set display_name = 'S' where email = 'supervisor@test.local'$$, '1'),
  ('supervisor', 'update', 'employees', $$update public.employees set monthly_salary = 99999$$, 'P0001'),
  ('admin', 'update', 'employees', $$update public.employees set monthly_salary = 31000$$, '1'),
  ('supervisor', 'delete', 'employees', $$delete from public.employees$$, '0'),
  ('supervisor', 'delete', 'salary_payments', $$delete from public.salary_payments$$, '0'),
  ('supervisor', 'insert', 'salary_lop_exclusions',
   $$insert into public.salary_lop_exclusions (employee_id, salary_month, created_by) values ('00000000-0000-0000-0000-0000000000e1', '2026-01-01', auth.uid())$$, '42501'),
  ('admin', 'insert', 'salary_lop_exclusions',
   $$insert into public.salary_lop_exclusions (employee_id, salary_month, created_by) values ('00000000-0000-0000-0000-0000000000e1', '2026-01-01', auth.uid())$$, '1'),
  ('stranger', 'insert', 'credit_customers',
   $$insert into public.credit_customers (customer_name, created_by) values ('Stranger Co', auth.uid())$$, '42501'),
  ('stranger', 'insert', 'expenses',
   $$insert into public.expenses (date, amount, created_by) values ('2026-01-10', 1, auth.uid())$$, '42501'),
  ('stranger', 'update', 'credit_customers', $$update public.credit_customers set amount_due = 0$$, 'none'),
  ('anon', 'insert', 'expenses', $$insert into public.expenses (date, amount) values ('2026-01-10', 1)$$, '42501'),
  ('anon', 'insert', 'client_errors', $$insert into public.client_errors (message) values ('x')$$, '42501'),
  ('stranger', 'insert', 'client_errors', $$insert into public.client_errors (message) values ('x')$$, '1'),
  ('supervisor', 'insert', 'client_errors', $$insert into public.client_errors (message) values ('x')$$, '1'),
  ('supervisor', 'insert', 'client_errors',
   $$insert into public.client_errors (message, user_id) values ('spoof', tests.uid('admin'))$$, '1'),
  ('supervisor', 'update', 'client_errors', $$update public.client_errors set message = 'x'$$, '42501'),
  ('supervisor', 'delete', 'client_errors', $$delete from public.client_errors$$, '42501'),
  ('admin', 'update', 'client_errors', $$update public.client_errors set message = 'x'$$, '42501'),
  ('admin', 'delete', 'client_errors', $$delete from public.client_errors$$, '42501'),
  ('supervisor', 'insert', 'settlement_lines',
   $$insert into public.settlement_lines (import_id, source, txn_date, amount) values (gen_random_uuid(), 'x', '2026-01-10', 1)$$, '42501'),
  ('admin', 'insert', 'settlement_lines',
   $$insert into public.settlement_lines (import_id, source, txn_date, amount) values (gen_random_uuid(), 'x', '2026-01-10', 1)$$, '42501'),
  ('admin', 'insert', 'settlement_imports', $$insert into public.settlement_imports (source) values ('x')$$, '42501'),
  ('stranger', 'insert', 'tanker_decantations',
   $$insert into public.tanker_decantations (decant_date, product, invoice_qty_litres, stock_before_litres, stock_after_litres) values ('2026-01-10', 'petrol', 1, 0, 1)$$, '42501'),
  ('supervisor', 'insert', 'tanker_decantations',
   $$insert into public.tanker_decantations (decant_date, product, invoice_qty_litres, stock_before_litres, stock_after_litres) values ('2026-01-10', 'petrol', 1, 0, 1)$$, '1'),
  ('anon', 'update', 'credit_customers', $$update public.credit_customers set amount_due = 0$$, 'none'),
  ('anon', 'delete', 'credit_customers', $$delete from public.credit_customers$$, 'none');

-- Staff RPCs refuse anon (no EXECUTE grant) and an unprovisioned login (require_staff_access).
insert into matrix (who, op, tbl, stmt, expected)
select who, 'rpc', fn, stmt, case who when 'anon' then '42501' else 'P0001' end
from (values
  ('add_credit_entry', $$select public.add_credit_entry('X', '2026-01-10', 1)$$),
  ('record_credit_payment', $$select public.record_credit_payment(tests.customer('Acme'), '2026-01-10', 1)$$),
  ('add_shift_expense', $$select public.add_shift_expense('2026-01-10', 'afternoon', '00000000-0000-0000-0000-0000000000e1', 'staff_food', 1)$$),
  ('save_day_closing', $$select public.save_day_closing('2026-01-10', 1, 1, null)$$),
  ('compute_day_closing_components', $$select public.compute_day_closing_components('2026-01-10')$$),
  ('get_credit_aging', $$select public.get_credit_aging('2026-01-10')$$),
  ('get_customer_credit_detail_as_of', $$select public.get_customer_credit_detail_as_of('Acme', '2026-01-10', null)$$),
  ('get_dashboard_snapshot', $$select public.get_dashboard_snapshot('2026-01-01', '2026-01-31')$$),
  ('set_day_closing_certified', $$select public.set_day_closing_certified('2026-01-09', true)$$),
  ('create_credit_statement_link', $$select public.create_credit_statement_link(tests.customer('Acme'), 30)$$),
  ('revoke_credit_statement_links', $$select public.revoke_credit_statement_links(tests.customer('Acme'))$$)
) v(fn, stmt)
cross join unnest(array['anon', 'stranger']) who;

-- Admin-only RPCs refuse a supervisor.
insert into matrix (who, op, tbl, stmt, expected) values
  ('supervisor', 'rpc', 'set_day_closing_certified', $$select public.set_day_closing_certified('2026-01-09', true)$$, 'P0001'),
  ('supervisor', 'rpc', 'delete_day_closing', $$select public.delete_day_closing(gen_random_uuid())$$, 'P0001'),
  ('supervisor', 'rpc', 'record_salary_payment',
   $$select public.record_salary_payment('00000000-0000-0000-0000-0000000000e1', '2026-01-10', '2026-01-01', 99999)$$, 'P0001');

-- Run each case as its login, inside a savepoint so a successful write does not leak into the
-- next case. Results go to a temp table and are asserted as postgres.
create temp table outcome (who text, op text, tbl text, stmt text, expected text, got text) on commit drop;
grant all on outcome to anon, authenticated;

create function pg_temp.run_matrix() returns void language plpgsql as $$
declare
  m record;
  v_got text;
  v_results text[] := '{}';
  i int := 0;
begin
  for m in select mx.* from matrix mx order by mx.who, mx.tbl, mx.op, mx.stmt loop
    i := i + 1;
    begin
      perform tests.login(m.who);
      v_got := tests.try(m.stmt);
      perform tests.logout();
      raise exception using errcode = 'P0099', message = v_got;
    exception when sqlstate 'P0099' then
      perform tests.logout();
      v_results := v_results || sqlerrm;
    end;
  end loop;
  insert into outcome
  select x.who, x.op, x.tbl, x.stmt, x.expected, v_results[x.n]
  from (select mx.*, row_number() over (order by mx.who, mx.tbl, mx.op, mx.stmt) n from matrix mx) x;
end;
$$;

select pg_temp.run_matrix();

select case
  when expected = '>0' then ok(got ~ '^[0-9]+$' and got::int > 0, format('%s %s %s reads rows (got %s)', who, op, tbl, got))
  when expected in ('none', 'blocked') then ok(got in ('0', '42501'), format('%s %s %s is %s (got %s)', who, op, tbl, expected, got))
  else is(got, expected, format('%s %s %s -> %s', who, op, tbl, case expected
    when '42501' then 'denied' when 'P0001' then 'rejected by RPC' when '42P17' then 'recursive policy'
    else expected || ' row' end))
  end
from outcome
order by who, tbl, op, stmt;

-- 3. check_page_access ------------------------------------------------------------------------

create temp table pages (page text, admin_ok boolean, supervisor_ok boolean) on commit drop;
grant all on pages to anon, authenticated;
insert into pages values
  ('settings', true, false), ('analysis', true, false), ('reports', true, false),
  ('staff', true, true), ('dashboard', true, true), ('dsr', true, true), ('day-closing', true, true),
  ('expenses', true, true), ('credit-overdue', true, true), ('credit', true, true),
  ('sales-daily', true, true), ('attendance', true, true), ('salary', true, true),
  ('billing', true, true), ('invoices', true, true), ('letterhead', true, true),
  ('reminders', true, true), ('e20-register', true, true), ('no-such-page', false, false);

create temp table page_outcome (who text, page text, expected boolean, got boolean) on commit drop;
grant all on page_outcome to anon, authenticated;

select tests.login('admin');
insert into page_outcome select 'admin', page, admin_ok, (public.check_page_access(page)->>'allowed')::boolean from pages;
select tests.logout();
select tests.login('supervisor');
insert into page_outcome select 'supervisor', page, supervisor_ok, (public.check_page_access(page)->>'allowed')::boolean from pages;
select tests.logout();
select tests.login('stranger');
insert into page_outcome select 'stranger', page, false, coalesce((public.check_page_access(page)->>'allowed')::boolean, false) from pages;
select tests.logout();

select is(
  array(select format('%s %s: expected %s, got %s', who, page, expected, got)
        from page_outcome where got is distinct from expected order by 1),
  '{}'::text[],
  'check_page_access: admin, supervisor and stranger get the expected verdict on every page');

select tests.login('anon');
select throws_ok($$ select public.check_page_access('dsr') $$, '42501', null, 'anon cannot call check_page_access');
select throws_ok($$ select public.get_page_session('dsr') $$, '42501', null, 'anon cannot call get_page_session');
select tests.logout();

select tests.login('supervisor');
select is(public.get_page_session('settings')->>'allowed', 'false', 'get_page_session denies a supervisor the settings page');
select is(public.get_page_session('dsr')->>'role', 'supervisor', 'get_page_session reports the role');
select tests.logout();

-- client_errors: the trigger takes user, email and role from the session, not the payload.
select is(
  (select format('%s %s %s', user_id = tests.uid('supervisor'), user_email, role)
   from public.client_errors where message = 'Fixture error'),
  't supervisor@test.local supervisor',
  'client_errors stamps user, email and role from the session');

select tests.login('supervisor');
create function pg_temp.burst() returns void language plpgsql as $$
begin
  for i in 1..40 loop
    insert into public.client_errors (message) values ('loop ' || i);
  end loop;
end;
$$;
select pg_temp.burst();
select tests.logout();
select is(
  (select count(*)::int from public.client_errors where user_id = tests.uid('supervisor')),
  30,
  'client_errors keeps at most 30 rows per user per minute');

select * from finish();
rollback;
