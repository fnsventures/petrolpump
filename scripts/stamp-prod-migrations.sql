-- Mark legacy prod migrations as already applied when the schema was built manually
-- (Dashboard SQL / schema.sql) before supabase_migrations tracking existed.
-- Safe to re-run. Does NOT execute migration SQL.
--
-- Stamps through 20250426120000 — prod has users/employees/credit/DSR legacy table but
-- not yet dsr_petrol/diesel, billing, or 2026 employee features.
-- Do not add split_dsr or later migrations here; db push must run those.

insert into supabase_migrations.schema_migrations (version, name, statements)
values
  ('20250130000000', 'fix_buying_price_update', array[]::text[]),
  ('20250130100000', 'day_closing_and_credit_payments', array[]::text[]),
  ('20250130110000', 'expense_categories', array[]::text[]),
  ('20250131100000', 'day_closing_no_duplicate', array[]::text[]),
  ('20250131110000', 'staff_attendance', array[]::text[]),
  ('20250202100000', 'credit_customers_credit_date', array[]::text[]),
  ('20250203100000', 'users_display_name_and_rename', array[]::text[]),
  ('20250203110000', 'day_closing_accounting_snapshot', array[]::text[]),
  ('20250210100000', 'credit_management_module', array[]::text[]),
  ('20250211100000', 'add_credit_customers_amount_due', array[]::text[]),
  ('20250211110000', 'fix_day_closing_credit_today', array[]::text[]),
  ('20250214100000', 'customer_credit_summary_as_of', array[]::text[]),
  ('20250214200000', 'customer_credit_breakdown_as_of', array[]::text[]),
  ('20250214300000', 'customer_credit_detail_combined', array[]::text[]),
  ('20250219100000', 'backfill_dsr_stock_from_dsr', array[]::text[]),
  ('20250219110000', 'dsr_stock_closing_variation_formula', array[]::text[]),
  ('20250220100000', 'employee_attendance_shift', array[]::text[]),
  ('20250322100000', 'outstanding_list_last_credit_sale_date', array[]::text[]),
  ('20250426120000', 'employees_mutation_admin_only', array[]::text[])
on conflict (version) do nothing;
