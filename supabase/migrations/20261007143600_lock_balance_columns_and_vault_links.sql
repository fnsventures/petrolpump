-- Stop supervisors writing ledger balances through the table, and record when a
-- vault file's "anyone" permission has been removed.
--
-- Customer-row locks and certified-day rejection already live in
-- 20261006054630_money_write_integrity (add_credit_entry, record_credit_payment,
-- ledger_guard_certified_day, dsr_validate_meter_row). This file does not
-- redefine those functions.
--
-- Table-level UPDATE includes every column, so a column-level revoke would not
-- stick. Drop table-level insert/update for the browser roles, then grant back
-- every column except the balances. Sale amount cannot be updated either:
-- lowering it would shrink the debt without a payment. Security-definer RPCs
-- run as the table owner and can still write the balances.

revoke insert, update on table public.credit_customers from public, anon, authenticated;
revoke insert, update on table public.credit_entries from public, anon, authenticated;

grant insert (
  customer_name,
  vehicle_no,
  last_payment,
  notes,
  created_by,
  date,
  mobile,
  address
) on table public.credit_customers to authenticated;

grant update (
  customer_name,
  vehicle_no,
  last_payment,
  notes,
  date,
  mobile,
  address
) on table public.credit_customers to authenticated;

grant insert (
  credit_customer_id,
  transaction_date,
  fuel_type,
  quantity,
  amount,
  created_by,
  employee_id,
  shift
) on table public.credit_entries to authenticated;

grant update (
  credit_customer_id,
  transaction_date,
  fuel_type,
  quantity,
  created_by,
  employee_id,
  shift
) on table public.credit_entries to authenticated;

comment on column public.credit_customers.amount_due is
  'Outstanding from unsettled sales. Not granted to authenticated; sync_credit_customer_balances writes it.';

comment on column public.credit_customers.prepaid_balance is
  'Advance from overpayment. Not granted to authenticated; sync_credit_customer_balances writes it. Net = amount_due - prepaid_balance.';

comment on column public.credit_entries.amount_settled is
  'Amount already paid against this sale. Not granted to authenticated; payment RPCs write it.';

alter table public.invoice_documents
  add column if not exists public_link_revoked_at timestamptz;

comment on column public.invoice_documents.public_link_revoked_at is
  'When the file-level anyone-with-the-link permission was confirmed absent. Null until that check runs.';

comment on column public.invoice_documents.drive_web_view_link is
  'Drive URL for the file. Vault uploads are not shared with anyone; open them through the invoice-documents function.';
