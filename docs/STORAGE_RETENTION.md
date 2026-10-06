# Storage, indexing & retention (Supabase free tier)

The goal is to stay inside the 500 MB free database. There are three levers: a hot window of data in Postgres with cold years archived to Drive, indexes that earn their keep, and one source of truth per fact.

> **Back up first.** [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database) must be green before you archive rows, drop indexes, or strip columns, and every such change needs a staging dry-run.

**What counts toward the 500 MB:** operational tables (DSR, meters, shifts, day closing, credit, expenses, invoices), their indexes (often 30–50% of the size), and `audit_log`. Each audited write stores full `old_data`/`new_data` jsonb copies, so `audit_log` is usually the silent giant. **What doesn't count:** avatar and staff-photo buckets (Storage quota), PDFs on Drive (`invoice_documents` holds metadata only), and Drive backups. Staging is a separate free project.

## Measure (monthly, and after each migration)

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size;

-- Top tables: total / heap / indexes
select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) total,
       pg_size_pretty(pg_relation_size(c.oid)) table_only,
       pg_size_pretty(pg_indexes_size(c.oid)) indexes,
       round(100.0 * pg_indexes_size(c.oid) / nullif(pg_total_relation_size(c.oid), 0), 1) index_pct
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 25;

-- Index usage (idx_scan = 0 → drop candidate after review). pg_stat_reset() wipes this history.
select relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) size
from pg_stat_user_indexes where schemaname = 'public'
order by idx_scan, pg_relation_size(indexrelid) desc;

-- Audit bloat
select pg_size_pretty(pg_total_relation_size('public.audit_log')) audit_total, count(*) from public.audit_log;
select table_name, count(*) from public.audit_log group by 1 order by 2 desc limit 15;
```

Log the date, DB size, top tables, and audit size each time. **Thresholds:** at **≥ 350 MB**, or if `audit_log` is in the top 3, start index cleanup and audit trimming, and run an archive dry-run on staging. At **≥ 450 MB**, archive before shipping any new heavy feature.

## Retention policy

| Data | Keep live | Older |
|------|-----------|-------|
| Operational (DSR, shifts, day closing, expenses, ledgers, invoices, attendance/salary, E20, letters, done reminders) | Last **36 months** (shorten to 24 → 18 if tight) | Archive to Drive `Archive/YYYY/`, then delete |
| Masters (customers, products, employees, users, settings, categories), `invoice_documents`, open credit balances | All | — |
| `audit_log` | **6–12 months** | Delete (filter on `performed_at`) |

## Archiving a year

1. Confirm a verified full backup on Drive ([BACKUP.md](BACKUP.md)), record a baseline measurement, choose a cutoff (e.g. `< 2023-04-01`), and pick a quiet window.
2. Optionally export the year to Drive `Archive/YYYY/`.
3. Dry-run the deletes on staging, then smoke-test DSR, credit balances, day closing, and reports. Credit balances must still match after old ledger rows are removed.
4. Run the same deletes on prod in one transaction and record the row counts.
5. `VACUUM (ANALYZE);`. Avoid `VACUUM FULL` unless you accept the table locks.
6. Re-measure, and note "Archived ≤ YYYY". Stock reports then cover only the hot window.

No archive script exists yet. Write and review `scripts/archive-year.sh` when you first hit the threshold.

## Index hygiene

Every new index needs to name the query, RPC, or page it serves (ideally with `EXPLAIN (ANALYZE)` on staging). Prefer a **partial** index (open rows, uncertified, active) or a **composite** that matches the filter plus sort. Don't add an index that is a prefix of an existing composite or unique index, and don't index a low-cardinality column on its own. Recheck `pg_stat_user_indexes` 2–4 weeks after shipping.

**Keep:** `unique(date)` on DSR and day_closing, `credit_entries_open_fifo_idx`, `credit_entries_customer_date_idx`, `dsr_*_missing_buying_idx`, `day_closing_uncertified_idx`, `meter_shift_*` date/shift indexes, `employees_active_roster_idx`, `reminders_open_*`.

**Drop candidates** (confirm with stats and `EXPLAIN` first):

| Index | Reason |
|-------|--------|
| `day_closing_date_idx` | Duplicates `unique(date)` |
| `invoices_date_idx` | Prefix of `invoices_list_order_idx (invoice_date, created_at)` |
| `expenses_created_at_idx` | Day ops filter on `date`; drop if `idx_scan` ≈ 0 |
| `credit_payments_date_idx` vs `credit_payments_same_day_date_idx` | Overlap; keep whichever RPCs use |
| `reminders_status_due_idx` vs `reminders_open_*` | Keep what the dashboard `EXPLAIN` uses |
| `letterhead_letters_created_at_idx` | Drop if unused |
| `credit_customers_date_idx` | Legacy path; drop once legacy `credit_customers.date` rows move to `credit_entries` |

Procedure: staging → `DROP INDEX CONCURRENTLY` (or a migration) → smoke test → prod migration → re-measure.

## Lean schema rules

- **No file bytes in Postgres** (no `bytea`). PDFs, staff photos, and Aadhaar scans go to Drive; avatars go to Storage, resized to a ~512–1024 px edge, one per person.
- **One write path per fact.** Use views or RPCs for derived numbers. Before caching a computable value, answer: what invalidates it (trigger or RPC only)? Would a view do? Will `audit_log` double the write cost? If invalidation is unclear, don't cache.
- **Intentional caches, do not remove:** `day_closing` snapshot columns (immutable once saved or certified, and the `short_today` → next `short_previous` chain), `credit_customers.amount_due`/`prepaid_balance`, `credit_entries.amount_settled`, `invoices` totals headers, `night_cash_collections.total_amount`, and `meter_shift_cash.credit_amount`/`expense_amount` (shift UX only; the ledger is the source of truth for day closing).
- **Sync directions:** shift → DSR via `apply_shift_aggregate_to_dsr`. DSR → shift via `sync_shift_meters_from_dsr` (prefill only). Ledger → shift cash via triggers. Live ops → day closing via `save_day_closing` / `sync_saved_day_closing_for_date`. Shift cash must never feed `credit_today`, and no DSR stubs are written from shifts.
- **Audit** only tables where "who changed this?" matters. Don't audit cache-only updates such as `meter_shift_cash` totals.
- No leftover import or temp tables in prod. Sync prod → staging only when needed, and trim staging afterwards.
- **Possible later cleanups** (each needs a migration and a staging dry-run): store each rate only on its own product's DSR table, derive DSR `sales_pump*`/`total_sales` and `purchase_*_total`, and remove `DISTINCT ON (date)` from the `dsr`/`dsr_stock` views now that `unique(date)` exists.

**If storage is still tight:** shorten the hot window first, then move old years to an external archive Postgres, then move the primary DB (Neon or a VPS). Supabase Pro is the last resort.

Related: [DATA_TABLES.md](DATA_TABLES.md), [DSR_TABLES.md](DSR_TABLES.md), [MIGRATIONS.md](MIGRATIONS.md), [ARCHITECTURE.md](ARCHITECTURE.md).
