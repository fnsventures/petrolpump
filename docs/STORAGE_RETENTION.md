# Free-tier storage, indexing & lean schema plan

Stay on **Supabase free** (500 MB database) for the long term without buying Pro — by combining:

1. **Retention** — hot window in Supabase; cold years on Drive  
2. **Indexing** — only indexes that queries actually use  
3. **Flat / lean schema** — one source of truth; avoid storing the same fact twice  

This plan assumes **Bishnupriya Fuels** keeps using:

- Supabase Postgres for live operational data
- Google Drive for supplier invoice PDFs ([INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md))
- Monthly/ad-hoc DB dumps to Drive ([BACKUP.md](BACKUP.md))

> **Do first:** [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database) must already be green. Never archive, drop indexes, or strip columns without a verified Drive backup + staging dry-run.

---

## Goals

| Goal | How |
|------|-----|
| Database ≤ ~500 MB | Hot window + archive + lean indexes + less audit bloat |
| No unnecessary duplication | One SoT per fact; caches only where proven needed |
| Indexes earn their keep | Measure with `pg_stat_user_indexes`; drop unused / redundant |
| Reports still useful | Default UI = last 24–36 months; older years via restore/archive |

**Non-goals:** Replacing Supabase Auth / Edge / RLS; rewriting the whole DSR model; removing intentional accounting snapshots.

---

## Reality for this app

| Store | What grows | Counts toward 500 MB DB? |
|-------|------------|--------------------------|
| DSR, meters, shifts, day closing, credit, expenses, invoices | Rows over years | **Yes** |
| Indexes on those tables | Often 30–50%+ of table size | **Yes** |
| `audit_log` (`old_data` / `new_data` jsonb) | Full row copies on every audited write | **Yes — often the silent giant** |
| `invoice_documents` | Metadata only (files on Drive) | Yes, but tiny |
| `user-avatars`, `staff-photos` | Image bytes | **No** (Storage quota) |
| Staging Supabase project | Full copy of data | Separate free project |
| Full SQL backups on Drive | Dumps | **No** (Drive) |

For one pump, transactional rows alone usually stay well under 500 MB for several years **if** blobs stay off Postgres, indexes stay lean, audit is capped, and old years are archived.

---

## Phases overview

```
Phase 0  Measure (size + indexes + duplication)   ← do now
Phase 1  Prevention (files, staging, design rules) ← ongoing
Phase 2  Hot-window policy                         ← decide now
Phase 3  Index hygiene                             ← soon / with each migration
Phase 4  Flatten / reduce duplication              ← staged; keep intentional caches
Phase 5  Archive year N                            ← when DB ≥ ~70% or year 3+
Phase 6  Escape hatch                              ← only if still tight
```

Phases 3–4 reduce growth **before** you need Phase 5. Do not wait for 350 MB to start index hygiene.

---

## Source-of-truth map (know before you flatten)

```
Shift meters ──apply_shift_aggregate_to_dsr──► dsr_petrol / dsr_diesel  (daily SoT)
     ▲                                              │
     └──────── sync_shift_meters_from_dsr ──────────┘  (prefill only)

credit_entries / expenses ──triggers──► meter_shift_cash.credit/expense  (cache)
credit_entries / credit_payments ──► credit_customers.amount_due / prepaid  (cache)

Live ledgers + DSR ──save / sync──► day_closing snapshot columns  (accounting SoT once saved)
meter_shift_cash cash/phone ──prefill only──► day_closing.night_cash / phone_pay
```

| Layer | Source of truth | Allowed cache / copy |
|-------|-----------------|----------------------|
| Daily meters / rates / stock inputs | `dsr_petrol`, `dsr_diesel` | Shift rows for shift UX; `dsr` / `dsr_stock` **views** (not tables) |
| Credit sales & payments | `credit_entries`, `credit_payments` | `credit_customers.amount_due`, `prepaid_balance`, `amount_settled` |
| Shift short display | Ledger attributed to shift | `meter_shift_cash.credit_amount`, `expense_amount` |
| Day closing accounting | **Saved** `day_closing` snapshot | Must stay immutable once certified/collected |
| Stock reconciliation | Computed (`dsr_stock` / RPC) | **No** physical stock table (already correct) |
| Invoice PDF bytes | Google Drive | DB = metadata only |
| Station config | `pump_settings.config` (1 row) | OK |

---

## Phase 0 — Measure and baseline (now)

### 0.1 Database and table size

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size;

select c.relname as table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
       pg_size_pretty(pg_relation_size(c.oid)) as table_only,
       pg_size_pretty(pg_indexes_size(c.oid)) as indexes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 25;
```

Also note **Storage** for `user-avatars` / `staff-photos`.

### 0.2 Index usage (requires `pg_stat_statements` optional; stats are enough)

Run on prod (or staging after realistic use). Reset stats only if you know what you are doing (`pg_stat_reset()` wipes history).

```sql
-- Unused or barely used indexes (idx_scan = 0 are candidates to drop after review)
select schemaname, relname as table_name, indexrelname as index_name,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) as index_size
from pg_stat_user_indexes
where schemaname = 'public'
order by idx_scan asc, pg_relation_size(indexrelid) desc;

-- Index vs table ratio per table
select c.relname,
       pg_size_pretty(pg_relation_size(c.oid)) as table_size,
       pg_size_pretty(pg_indexes_size(c.oid)) as indexes_size,
       round(100.0 * pg_indexes_size(c.oid)
         / nullif(pg_total_relation_size(c.oid), 0), 1) as index_pct_of_total
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_indexes_size(c.oid) desc;
```

### 0.3 Audit bloat signal

```sql
select pg_size_pretty(pg_total_relation_size('public.audit_log')) as audit_total,
       (select count(*) from public.audit_log) as audit_rows;

select table_name, count(*) as rows
from public.audit_log
group by table_name
order by rows desc
limit 15;
```

### 0.4 Log a baseline

| Date | DB size | Top tables | Index % notes | Audit size | Action |
|------|---------|------------|---------------|------------|--------|
| YYYY-MM-DD | e.g. 42 MB | … | … | … | Baseline |

### 0.5 Monitoring cadence

| When | Check |
|------|--------|
| **Monthly** | DB size, top tables, audit size, unused indexes |
| **After migrations** | New indexes justified? Size delta? |
| **Alert** | DB **≥ 350 MB** or audit among top 3 tables → accelerate Phases 3–5 |
| **Hard** | DB **≥ 450 MB** → archive before new heavy features |

### 0.6 Free-tier gotchas

| Risk | Mitigation |
|------|------------|
| Free project **pauses** | Regular use or light health ping |
| **Staging** second free project | Sync only when testing; trim after large syncs |
| Egress | Prefer aggregate RPCs; avoid huge date-range downloads |

---

## Phase 1 — Prevention (ongoing rules)

### 1.1 Files stay off Postgres

| Content | Where |
|---------|--------|
| Supplier / purchase PDFs | Google Drive only |
| Operator / staff photos | Storage buckets; compressed; overwrite, no versioning |
| DB backups | Google Drive |

**Never** add `bytea` or “store PDF in table”.

### 1.2 Design rules (flat by default)

When adding features:

1. **One write path** for each fact (prefer RPC that owns inserts/updates).
2. **Views / RPCs** for derived numbers — do not create a second physical table.
3. **Caches** only if a measured query is too slow or you need an immutable snapshot (day closing).
4. **No long-lived import/staging tables** in prod.
5. **New indexes** require: the query pattern, and preferably `EXPLAIN (ANALYZE)` on staging.
6. **Audit** only tables where “who changed this?” matters for ops/compliance — not every cache refresh.

### 1.3 Staging hygiene

| Practice | Why |
|----------|-----|
| Sync prod → staging only when needed | Second free quota |
| Reset/trim staging after big sync tests | Avoid two multi-year DBs |
| Schema experiments locally first | [DEVELOPMENT.md](DEVELOPMENT.md) |

### 1.4 Photo hygiene

Resize before upload (max edge ~512–1024 px). One current photo per person.

---

## Phase 2 — Hot-window policy (decide now)

### 2.1 Retention (recommended default)

| Data class | Live in Supabase | Older than window |
|------------|------------------|-------------------|
| **Operational hot** | Last **36 months** | Archive then remove |
| **Masters** | Keep all | — |
| **Open credit / balances** | Keep all open state | Closed ancient history with sales |
| **Invoice PDF metadata** | Keep all (tiny) | Files on Drive |
| **Reminders / letterhead** | Recent + open | Optional archive |
| **`audit_log`** | Last **6–12 months** (or less) | Delete older always |

**Hot window: 36 months** for ops data. Shorter if size climbs early.

### 2.2 App behaviour (when archive is live)

| Screen | Default | Older history |
|--------|---------|---------------|
| Dashboard, DSR, day closing, P&amp;L, credit overview | 12–36 months | Restore from Drive if needed |
| Credit master + current due | Always live | — |
| Vault invoices | Unchanged | — |

### 2.3 What “archive” means

1. Verified full backup on Drive.  
2. Optional year dump/CSV → Drive `Archive/YYYY/`.  
3. Delete cold rows from live only after staging dry-run.  

Archive ≠ delete without backup.

---

## Phase 3 — Index hygiene (soon; every migration)

Indexes speed reads but **cost storage and write amplification**. Free tier cares about both.

### 3.1 Rules for every new index

| Rule | Detail |
|------|--------|
| Justify | Name the query / RPC / page that needs it |
| Prefer **partial** indexes | e.g. open credit only, uncertified closings only |
| Prefer **composite** that matches filter + sort | Avoid separate single-column indexes that are prefixes of another |
| Avoid indexing low-cardinality columns alone | e.g. boolean without a selective `WHERE` |
| After ship | Recheck `pg_stat_user_indexes` in 2–4 weeks |

### 3.2 Keep (intentional / high value)

| Index pattern | Why |
|---------------|-----|
| `unique(date)` on DSR / day_closing | Integrity + lookup |
| `credit_entries_open_fifo_idx` (partial) | Settlement scans |
| `credit_entries_customer_date_idx` | Customer history |
| `dsr_*_missing_buying_idx` / receipts partials | Purchase alerts |
| `day_closing_uncertified_idx` (partial) | Ops queue |
| `meter_shift_*_date_shift_idx` | Shift load/save |
| `employees_active_roster_idx` | Roster |
| `reminders_open_*` partials | Dashboard |

### 3.3 Drop candidates (validate with stats + `EXPLAIN` first)

| Index | Concern | Likely action |
|-------|---------|---------------|
| `day_closing_date_idx` | Overlaps **`unique (date)`** | **Drop** after confirm |
| `invoices_date_idx` | Prefix of `invoices_list_order_idx (invoice_date, created_at)` | Drop if list index covers queries |
| `expenses_created_at_idx` | Day ops use `date`, not `created_at` | Drop if `idx_scan` ≈ 0 |
| `credit_payments_date_idx` vs `credit_payments_same_day_date_idx` | Overlap | Keep customer+date; revisit which date index RPCs need |
| `reminders_status_due_idx` vs open partials | Possible overlap | Keep the ones dashboard `EXPLAIN` uses |
| `letterhead_letters_created_at_idx` | If unused | Drop |
| `credit_customers_date_idx` | Legacy “credit today” path | Drop after legacy customers migrated (Phase 4) |

**Procedure:** staging → `DROP INDEX CONCURRENTLY` (or migration) → smoke test → prod migration → re-measure size.

### 3.4 Index checklist for new migrations

- [ ] Query pattern documented in migration comment  
- [ ] Not redundant with an existing unique/composite  
- [ ] Partial `WHERE` used when filter is stable (open rows, active, etc.)  
- [ ] Added to mental “watch list” for next monthly Phase 0 check  

---

## Phase 4 — Flat storage & reduce duplication

Goal: **one SoT**, fewer sync chains, less audit noise — without breaking certified accounting or shift UX.

### 4.1 Already flat / good — do not “fix”

| Design | Status |
|--------|--------|
| Stock as **view/RPC**, not a table | Keep ([DSR_TABLES.md](DSR_TABLES.md)) |
| `dsr` as **union view** | Keep (no extra storage) |
| Invoice PDFs on Drive | Keep |
| `pump_settings` single JSON row | Keep |
| Invoice header totals from `save_invoice` | Keep (standard header/lines) |
| `night_cash_collections.total_amount` at pickup | Keep (immutable receipt) |

### 4.2 Keep on purpose (intentional denormalization)

Do **not** remove these without a full redesign:

| Cache | Why it stays |
|-------|----------------|
| `day_closing` snapshot columns (`total_sale`, `collection`, `credit_today`, …) | Immutable accounting once saved/certified |
| `day_closing.short_today` → next `short_previous` | Carry chain / recascade |
| `credit_customers.amount_due`, `prepaid_balance` | Fast lists; synced from ledger |
| `credit_entries.amount_settled` | Settlement without replaying all payments |
| `invoices` tax/total headers | Written with line items in one RPC |
| `meter_shift_cash.credit_amount` / `expense_amount` *(for now)* | Shift short UX; ledger remains SoT for day closing |

### 4.3 Reduce / avoid — staged work

Ordered by **value vs risk**. Implement only with migration + staging dry-run.

#### A. High value, lower risk (do first)

| Item | Action | Why |
|------|--------|-----|
| **`audit_log` retention** | Delete rows older than 6–12 months on a schedule; or stop auditing pure cache tables | Biggest avoidable growth; full jsonb row copies |
| **Audit scope** | Do not audit every `meter_shift_cash` cache-only update if ledger is already audited | Cuts write amplification |
| **Redundant indexes** | Phase 3 drops | Storage + faster writes |
| **Import / temp tables** | Never leave in prod | Dead weight |

#### B. Medium effort (schema clarity, modest space)

| Item | Action | Caution |
|------|--------|---------|
| **DSR `sales_pump1/2`, `total_sales`** | Prefer **generated columns** from nozzle open/close/testing, or document “always derived in RPC” | Shift rollup must stay consistent |
| **Cross-product rates** (`petrol_rate` on diesel table and vice versa) | Store rate only on owning product table; fix day-closing readers | Touches RPCs + clients |
| **`purchase_*_total` vs per_kl × qty** | Derive in reports if totals are never independently edited | Confirm admin edit UX first |
| **`credit_customers.date` legacy** | Migrate stragglers to `credit_entries`; remove day-closing fallback | Then drop legacy index/column path |
| **`DISTINCT ON (date)` in `dsr` / `dsr_stock` views** | Remove now that `unique(date)` exists | Read-path cleanup, not storage |

#### C. Optional later (only if measured pain)

| Item | Action | When |
|------|--------|------|
| **`meter_shift_cash` credit/expense cache** | Replace with view/RPC aggregate at read time; drop trigger sync | If audit/trigger churn dominates size or bugs |
| **Salary → expense dual row** | Keep link (`salary_payment_id`) but ensure one writer owns both | Do not store salary twice without FK link |
| **Wide DSR rows** | Avoid adding more “convenient” numeric copies | Prefer compute at read for rare fields |

### 4.4 Rules for new features (anti-duplication gate)

Before merging a migration that stores a number already computable elsewhere, answer:

1. Is there already a SoT table/column?  
2. If caching: what invalidates it? (trigger / RPC only — no “update in two UIs”)  
3. Will `audit_log` double the cost of every write?  
4. Can a **view** or existing RPC return it instead?  

If (2) is unclear → **do not cache**.

### 4.5 Sync directions (document; do not invent reverse paths)

| Direction | Mechanism | Allowed? |
|-----------|-----------|----------|
| Shift meters → daily DSR | `apply_shift_aggregate_to_dsr` | Yes (updates existing daily sheet) |
| Daily DSR → shift | `sync_shift_meters_from_dsr` | Prefill / align only |
| Ledger → shift cash totals | Triggers | Cache only |
| Live ops → saved day closing | `save_day_closing` / `sync_saved_day_closing_for_date` | Snapshot maintenance |
| Shift cash → day closing credit_today | — | **No** (ledger is SoT for credit_today) |

Do not reintroduce dropped paths like writing DSR **stubs** from shifts only.

---

## Phase 5 — Archive year N (when ≥ ~70% or year 3+)

### 5.1 Preconditions

- [ ] Latest Drive backup OK  
- [ ] Phase 0 baseline recorded  
- [ ] Cutoff date chosen (e.g. `< 2023-04-01`)  
- [ ] Quiet window  
- [ ] Staging dry-run + smoke test  

### 5.2 Archive candidates (after backup)

| Priority | Objects | Typical date column |
|----------|---------|---------------------|
| 1 | `audit_log` (trim anytime) | `performed_at` |
| 2 | `dsr_petrol`, `dsr_diesel` | `date` |
| 3 | `meter_shift_readings`, `meter_shift_cash` | date / shift |
| 4 | `day_closing`, `night_cash_collections` | date |
| 5 | `expenses` | date |
| 6 | `credit_entries`, `credit_payments` | transaction / payment date |
| 7 | `invoices`, `invoice_items` | invoice date |
| 8 | `employee_attendance`, `salary_payments` | date / month |
| 9 | `e20_*`, `letterhead_letters`, done `reminders` | dates |

**Keep live:** `credit_customers`, products, employees, users, settings, categories, `invoice_documents` metadata; open balances continuity.

### 5.3 Procedure (high level)

1. Backup prod → Drive.  
2. Optional year export → Drive `Archive/YYYY/`.  
3. Dry-run deletes on staging; test DSR, credit, day closing, reports.  
4. Same deletes on prod in a transaction; record counts.  
5. `VACUUM (ANALYZE);` — avoid `VACUUM FULL` unless you accept locks.  
6. Re-measure Phase 0; log “Archived ≤ YYYY”.  

Prefer a reviewed `scripts/archive-year.sh` (+ SQL) when you first hit the threshold.

### 5.4 Continuity

- Credit balances must still match after removing old ledger rows — dry-run required.  
- Stock reports may only cover the hot window — document that.  

---

## Phase 6 — Escape hatch

| Option | When | Notes |
|--------|------|-------|
| **A. Shorter hot window** | First lever | 36 → 24 → 18 months |
| **B. External archive Postgres** | Need in-app old years | Route old date ranges there |
| **C. Move primary DB** | Other free limits block you | Neon / VPS / etc. |
| **D. Supabase Pro** | Last resort | Explicitly avoided for space |

Prefer **A → B → C**. Use **D** only if the business chooses paid convenience.

---

## Ownership and calendar

| Cadence | Task |
|---------|------|
| Monthly | Phase 0: size + audit + unused indexes |
| Each migration | Phase 3 checklist; Phase 4 anti-duplication gate |
| Quarterly | Review drop-candidate indexes; audit retention job |
| Yearly (FY close) | Decide archive of closed year |
| At ≥ 350 MB | Phase 5 dry-run on staging |
| Continuous | Phase 1 rules on new features |

---

## Definition of done

- [ ] Phase 0 baseline (size + indexes + audit) recorded; monthly habit  
- [ ] Phase 1 rules followed on new work  
- [ ] Hot window chosen (default **36 months**); audit retention chosen (**6–12 months**)  
- [ ] At least one pass of Phase 3 (drop confirmed-redundant indexes on staging→prod)  
- [ ] No new feature merged that duplicates SoT without a documented cache + invalidation  
- [ ] Drive backups reliable  
- [ ] When size warrants: Phase 5 archive with staging dry-run  
- [ ] No Pro purchase required for storage reasons  

---

## Related docs

| Doc | Role |
|-----|------|
| [BACKUP.md](BACKUP.md) | Dump → Drive (required before archive/drops) |
| [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) | PDFs off-DB |
| [OPERATIONS.md](OPERATIONS.md) | Backups / sync |
| [DATA_TABLES.md](DATA_TABLES.md) | Tables, RLS |
| [DSR_TABLES.md](DSR_TABLES.md) | Meters vs stock views |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Storage buckets vs Postgres |
| [MIGRATIONS.md](MIGRATIONS.md) | How to ship schema changes safely |

---

## Out of scope until thresholds / measured need

Not required on day one:

- UI “archived year” banners  
- `scripts/archive-year.sh`  
- Second archive database  
- Removing `day_closing` snapshots or credit balance caches  
- Migrating off Supabase  

**Do start now:** Phase 0 measurement, Phase 3 index review, Phase 4A audit retention decision.
