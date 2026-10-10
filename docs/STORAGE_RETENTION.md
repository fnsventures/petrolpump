# Storage, indexing & retention (Supabase free tier)

This is the plan for staying inside the Supabase free database (500 MB) for the life of the pump, and for what Google Drive keeps.

The free limit counts the live database only: tables, indexes, and `audit_log`. It does not count Google Drive, and it does not count the separate staging project. Invoice PDFs already live on Drive. Avatars live in Supabase Storage, which has its own quota.

Business rows (meter readings, credit, salary, expenses, invoices, day closing, customers, staff, settings) stay in Postgres. They are not deleted to save space. A restore drill on 2026-10-06 measured about 16 MB of data. The part that grows without a cap is `audit_log`, because every audited edit stores a full copy of the old row and the new row. That diary is kept for 6 months and then deleted.

Drive is the long-term copy. The calendar year is 1 January through 31 December.

| When | What is saved | Where on Drive | What is deleted |
|------|----------------|----------------|-----------------|
| 1st of February–December, 08:30 IST | Only the month that just finished | `2026/2026-10/` on 1 November holds October | Nothing on Drive. On production, audit rows older than 6 months |
| 1 January, 08:30 IST | December, then a full copy of the whole database | December in `2026/2026-12/`. Full copy in `Yearly/2026/` | After the full copy has uploaded, trash `2026-01` through `2026-12`. Those month files repeat what `Yearly/2026` already contains. Audit rows older than 6 months |
| Any day, when you ask | One month, or the whole database | Month folder, or `Manual/<timestamp>/` | Nothing, unless you run the year-end script |

> **Back up first.** [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database) must be green before you drop indexes or strip columns, and every such change needs a staging dry-run.

## The seven rules

1. **Stay inside the free database.** Sales, credit, salary, and the other books stay in Supabase. Only the change diary is thrown away, and only after 6 months. Drive holds a full copy at the end of each calendar year, so the live database does not have to be emptied to make room.
2. **Delete audit logs after 6 months.** On the 1st, after that month’s Drive upload has succeeded, production deletes `audit_log` rows older than 6 months. The sales row itself stays.
3. **On the 1st, back up only last month.** 1 November writes October’s activity and nothing else. Customers, staff, products, and settings are not in that file. They have no month. They remain in Supabase, and they are inside the yearly full copy.
4. **At year end, one full backup, then remove the monthly files.** 1 January writes a full copy of production into `Yearly/2026` (the year that just ended). Only after that upload succeeds, the twelve month folders for 2026 are moved to Drive trash. Trash can be restored for about 30 days. `Yearly/2026` is kept. The next year’s month folders (`2027-01` onward) are kept until 1 January 2028.
5. **On-demand scripts.** You can save one month, or the whole database, or close a finished year, without waiting for the 1st. Commands are below.
6. **Staging stores no audit log.** Staging is the test copy. A switch (`runtime_flags.audit = off`) makes the audit trigger do nothing there. Every prod → staging sync also empties `audit_log` on staging, so a playground session does not fill staging’s own 500 MB.
7. **This page is the procedure.** Recovery of a whole database is [RECOVERY.md](RECOVERY.md). Day-to-day commands are [OPERATIONS.md](OPERATIONS.md#4-backup-production-database).

## A full year, as folders

```
Database Backups - Bishnupriya Fuels/
  2026/
    2026-01/          January only, written 1 February 2026
    2026-02/          February only
    …
    2026-12/          December only, written 1 January 2027
  2027/
    2027-01/          January 2027 only, written 1 February 2027
  Yearly/
    2026/             whole database, written 1 January 2027
    2025/             whole database, written 1 January 2026
  Manual/
    20261008-213045/  a full copy you asked for on 8 October 2026
```

On 1 January 2027 the job does three things, in this order:

1. Write December 2026 into `2026/2026-12/`. If the full copy fails later, December is already on Drive.
2. Write the whole database into `Yearly/2026/`.
3. Trash `2026-01` … `2026-12`, including the December folder from step 1. `Yearly/2026` and `Manual/` stay. `2027` does not exist yet.

During 2027 the month folders accumulate again. They are removed on 1 January 2028, after `Yearly/2027` exists.

## What a month file contains

CSV files, gzipped, for rows whose business date falls in that month:

| File | Which rows |
|------|------------|
| `dsr_petrol`, `dsr_diesel` | Meter readings (`date`) |
| `meter_shift_readings`, `meter_shift_cash` | Shift register (`reading_date`) |
| `day_closing` | Day closing (`date`) |
| `expenses` | Expenses (`date`) |
| `credit_entries` | Credit sales (`transaction_date`) |
| `credit_payments` | Payments (`date`) |
| `invoices`, `invoice_items` | Bills dated that month, and their lines |
| `invoice_documents` | Supplier-invoice metadata (`invoice_date`). The PDF is already on Drive |
| `employee_attendance` | Attendance (`date`) |
| `salary_payments`, `salary_lop_exclusions` | Salary for that pay period (`salary_month`) |
| `night_cash_collections` | Pickups that overlap the month |
| `e20_testing_registers` and the water and quality lines | E20 register (`register_date`) |
| `letterhead_letters` | Letters (`letter_date`) |
| `audit_log` | Diary rows whose time falls in that month (IST) |
| `month-manifest-*.txt` | Row counts |

Customers, employees, products, users, and pump settings are not in the month file.

## What a full file contains

`Yearly/YYYY/` and `Manual/<timestamp>/` hold the same pair the restore guide describes: `prod-schema-*.sql.gz`, `prod-data-*.sql.gz`, and a manifest. One pair restores the station, including logins and customers. How to restore: [RECOVERY.md](RECOVERY.md).

A month folder cannot rebuild the station by itself.

## Audit log (production)

Triggers write `audit_log` when someone changes an audited table. Admins can read it. The app cannot insert into it directly.

Kept for **6 months**, measured from `performed_at`. On the 1st, after the Drive upload succeeds, `scripts/purge-audit-log.sh` deletes older rows in batches of 5,000. A failed upload does not delete the diary.

Shift cash and phone pay are still logged. Updates that only refresh the cached credit and expense totals on `meter_shift_cash` are not, because those totals are copied from the ledger.

Deleting rows makes the space reusable. The number Supabase shows for database size can stay high until a one-time `VACUUM FULL public.audit_log` in a quiet window. That lock also blocks writes to every audited table, so it is not part of the monthly job.

Apply migration `20261008150000_audit_log_retention` before the purge can succeed. Until it is on production, the 1st still uploads the month file, and the purge step fails with a clear message.

Preview without deleting:

```bash
./scripts/purge-audit-log.sh
```

Delete:

```bash
CONFIRM_PURGE_AUDIT=yes ./scripts/purge-audit-log.sh
```

## Staging

Staging is a second free project, used to try changes. It must not fill up with a diary of test edits.

The audit trigger reads `public.runtime_flags`. Production has no `audit` row, so logging stays on. Staging has one row, `audit = off`. The trigger then returns without writing. Staff cannot change that table (RLS is on and there is no policy).

`./scripts/db.sh sync` copies production into staging, then runs the staging switch: it sets `audit = off` and empties `audit_log`, including the diary rows that arrived inside the copy.

Run it once on the current staging database after the migration is applied there, and again any time you want to be sure:

```bash
./scripts/disable-staging-audit.sh
CONFIRM_STAGING_AUDIT=yes ./scripts/disable-staging-audit.sh
```

The script reads `STAGING_DB_URL` only. It stops if that URL is the same as `PROD_DB_URL`.

## Commands

Google Drive variables (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_BACKUP_FOLDER_ID`) come from the GitHub **prod** environment for Actions, or from your shell for a laptop run. `PROD_DB_URL` can come from `scripts/db.env`. None of these commands write business rows.

| I want… | Command |
|---------|---------|
| Last finished month, uploaded | `./scripts/backup-month-to-drive.sh` |
| A chosen month, uploaded | `ARCHIVE_MONTH=2026-10 ./scripts/backup-month-to-drive.sh` |
| Whole database, uploaded under `Manual/` | `./scripts/backup-prod-to-drive.sh` |
| Whole database, on this laptop only | `./scripts/db.sh backup` |
| Close a finished year (full copy, then trash that year’s month folders) | `YEAR=2026 ./scripts/backup-year-to-drive.sh` |
| See which month folders would be trashed | `./scripts/prune-drive-backups.sh` |
| Trash month folders for years that already have `Yearly/YYYY` | `CONFIRM_PRUNE_DRIVE=yes ./scripts/prune-drive-backups.sh` |
| See how many audit rows are older than 6 months | `./scripts/purge-audit-log.sh` |
| Delete those audit rows on production | `CONFIRM_PURGE_AUDIT=yes ./scripts/purge-audit-log.sh` |
| Turn staging audit off and empty its diary | `CONFIRM_STAGING_AUDIT=yes ./scripts/disable-staging-audit.sh` |

Actions → **Backup production database** → Run workflow, and choose `month`, `full`, or `year-end`. The scheduled run needs no choice: every 1st it saves the finished month and deletes old audit rows; on 1 January it also closes the year.

`backup-year-to-drive.sh` refuses the current calendar year. In October 2026 you cannot close 2026, because November and December do not exist yet and the month folders are not redundant.

## If the database later nears 350 MB

Measure with the queries below. Then, in order: confirm the 1st-of-the-month audit purge is running, drop unused indexes, and only then consider moving a closed year out of Postgres. That last step is not part of this job. It needs its own script, a staging dry-run, and a check that credit balances and day closing still match.

**Thresholds:** at **≥ 350 MB**, or if `audit_log` is in the top 3, do the purge check and the index review. At **≥ 450 MB**, do that before shipping any new heavy feature.

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

Log the date, DB size, top tables, and audit size each time. **Thresholds:** at **≥ 350 MB**, or if `audit_log` is in the top 3, confirm the monthly purge is running and start index cleanup. At **≥ 450 MB**, do that before shipping any new heavy feature.

## Retention policy

Business rows stay in Postgres. On the 1st, Drive receives a copy of the month that just finished (on 1 November, October’s sales, readings, credit, expenses, salary, and closing). Customers, staff, and settings stay in Supabase only. Drive then keeps **13** of those month folders. Older folders go to trash.

| Data | Where it lives | What happens to the old copy |
|------|----------------|------------------------------|
| Operational tables and masters | Postgres, kept | Still in the app. Drive also has the last 13 finished months, one folder each |
| Drive month folders | `YYYY/YYYY-MM/` | The finished month, plus the 12 before it. Folder `2026-10` is October only |
| `audit_log` | Postgres, **6 months** | Deleted after that month’s copy is on Drive. Cache-only refreshes of `meter_shift_cash` credit and expense totals are not written here |

`scripts/purge-audit-log.sh` deletes audit rows. `scripts/prune-drive-backups.sh` applies the Drive window. Both are dry-run until `CONFIRM_PURGE_AUDIT=yes` or `CONFIRM_PRUNE_DRIVE=yes`. The monthly **Backup production database** workflow runs the backup first, then both confirms. Apply migration `20261008150000_audit_log_retention` before that purge step can succeed.

A purge makes space **reusable**. `pg_database_size` may not fall until a one-time `VACUUM FULL public.audit_log` in a quiet window, because that rewrite locks writes to every audited table.

## If the database later nears 350 MB

Measure first. Then, in order: confirm the audit purge is running, drop unused indexes (below), and only then consider moving a closed financial year out of Postgres. That last step needs its own script, a staging dry-run, and a check that credit balances and day closing still match. It is not part of the monthly job.

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
- No leftover import or temp tables in prod. Sync prod → staging only when needed. Sync turns staging audit off and empties staging `audit_log`.
- **Possible later cleanups** (each needs a migration and a staging dry-run): store each rate only on its own product's DSR table, derive DSR `sales_pump*`/`total_sales` and `purchase_*_total`, and remove `DISTINCT ON (date)` from the `dsr`/`dsr_stock` views now that `unique(date)` exists.

**If storage is still tight after the audit purge and index cleanup:** move a closed financial year to an external archive Postgres, then move the primary DB (Neon or a VPS). Supabase Pro is the last resort.
