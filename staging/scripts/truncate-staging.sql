-- Clears staging app data before importing a prod snapshot.
-- Run against the STAGING database only.
-- Uses session_replication_role so FK order and audit triggers do not block the load.

begin;

set session_replication_role = replica;

truncate table
  public.invoice_items,
  public.invoices,
  public.credit_payments,
  public.credit_entries,
  public.day_closing,
  public.salary_payments,
  public.employee_attendance,
  public.expenses,
  public.dsr_petrol,
  public.dsr_diesel,
  public.credit_customers,
  public.employees,
  public.products,
  public.expense_categories,
  public.pump_settings,
  public.users,
  public.audit_log
restart identity cascade;

truncate table storage.objects cascade;
truncate table storage.buckets cascade;

-- Do not use RESTART IDENTITY on auth — Supabase-owned sequences (e.g. refresh_tokens_id_seq) block it.
truncate table auth.identities, auth.users cascade;

drop table if exists public._dsr_import;

set session_replication_role = default;

commit;
