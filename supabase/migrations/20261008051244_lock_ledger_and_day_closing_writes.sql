-- Staff console writes must not skip the money RPCs.
--
-- credit_payments: same pattern as salary_payments. Insert and update policies
-- are false. record_credit_payment and batch_record_credit_settlements are
-- security definer, so they still insert. Select and admin delete stay.
--
-- credit_entries: 20261007143600 revoked table insert/update, then granted
-- columns back (including amount). No page writes those columns. A table-level
-- revoke does not remove column grants, so revoke both, and do not grant
-- columns back. Insert and update policies are false as well. Select and
-- admin delete stay. add_credit_entry still writes the row.
--
-- day_closing: insert and update policies are false, so a console write cannot
-- store night cash or short without save_day_closing. Select stays. Delete is
-- false on the client; delete_day_closing (security definer) is the only delete.

-- ─── credit_payments ────────────────────────────────────────────────────────

drop policy if exists "credit_payments_insert_own" on public.credit_payments;
create policy "credit_payments_insert_own" on public.credit_payments
  for insert to authenticated with check (false);

drop policy if exists "credit_payments_update_by_role" on public.credit_payments;
create policy "credit_payments_update_by_role" on public.credit_payments
  for update to authenticated using (false) with check (false);

-- ─── credit_entries ─────────────────────────────────────────────────────────

revoke insert, update on table public.credit_entries from public, anon, authenticated;

revoke insert (
  credit_customer_id,
  transaction_date,
  fuel_type,
  quantity,
  amount,
  created_by,
  employee_id,
  shift
) on table public.credit_entries from public, anon, authenticated;

revoke update (
  credit_customer_id,
  transaction_date,
  fuel_type,
  quantity,
  created_by,
  employee_id,
  shift
) on table public.credit_entries from public, anon, authenticated;

drop policy if exists "credit_entries_insert_own" on public.credit_entries;
create policy "credit_entries_insert_own" on public.credit_entries
  for insert to authenticated with check (false);

drop policy if exists "credit_entries_update_by_role" on public.credit_entries;
create policy "credit_entries_update_by_role" on public.credit_entries
  for update to authenticated using (false) with check (false);

comment on column public.credit_entries.amount_settled is
  'Amount already paid against this sale. Payment RPCs write it. authenticated has no insert or update on credit_entries.';

-- ─── day_closing ────────────────────────────────────────────────────────────

drop policy if exists "day_closing_insert_own" on public.day_closing;
create policy "day_closing_insert_own" on public.day_closing
  for insert to authenticated with check (false);

drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated using (false) with check (false);

drop policy if exists "day_closing_delete_admin" on public.day_closing;
create policy "day_closing_delete_admin" on public.day_closing
  for delete to authenticated using (false);
