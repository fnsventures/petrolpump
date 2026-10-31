# Data tables

Tables, views, RLS, and RPCs. The canonical schema is `supabase/schema.sql`. This page is the reading copy, including the meter and stock model.

Index: [README.md](README.md). How pages write these tables: [FLOWS.md](FLOWS.md).

## Table Index

| Object | Purpose |
|--------|---------|
| [audit_log](#audit_log) | Audit trail for sensitive operations (admin-only read) |
| [client_errors](#client_errors) | Browser errors from `AppError.report` (any login inserts, admin reads) |
| [runtime_flags](#runtime_flags) | Switches. Staging sets `audit=off` so the playground stores no audit rows |
| [users](#users) | App users (login / operator roles) |
| [dsr_petrol](#dsr_petrol) | MS meter readings — one row per date |
| [dsr_diesel](#dsr_diesel) | HSD meter readings — one row per date |
| [meter_shift_readings](#meter_shift_readings) | Optional shift nozzle readings with staff (per date · shift · meter) |
| [meter_shift_cash](#meter_shift_cash) | Optional staff cash + phone + cached credit/expenses per shift (for short) |
| [dsr](#dsr-view) | **View:** union of petrol + diesel (SELECT only) |
| [dsr_stock](#dsr_stock-view) | **View:** computed stock reconciliation |
| [products](#products) | Product master for lube/accessory billing |
| [invoices](#invoices) | Sales invoices / cash memos |
| [invoice_items](#invoice_items) | Line items per invoice |
| [letterhead_letters](#letterhead_letters) | Official letters (metadata; files in Google Drive) |
| [pump_settings](#pump_settings) | Single-row JSON station config |
| [expenses](#expenses) | Daily operating expenses |
| [expense_categories](#expense_categories) | User-managed expense categories |
| [employees](#employees) | Pump employees (for salary and attendance) |
| [salary_payments](#salary_payments) | Salary installments per employee |
| [salary_lop_exclusions](#salary_lop_exclusions) | Admin exclusion of calculated loss of pay for one employee and month |
| [employee_attendance](#employee_attendance) | Daily attendance (present/absent/half_day/leave) |
| [credit_customers](#credit_customers) | Credit ledger: customer master, amount_due, prepaid_balance |
| [credit_entries](#credit_entries) | One row per credit sale (transaction date = DSR date) |
| [credit_payments](#credit_payments) | Payments received from credit customers |
| [credit_statement_links](#credit_statement_links) | Expiring read-only statement links for customers (hash only) |
| [reminders](#reminders) | Station tasks: dated reminders + undated todos |
| [e20_testing_registers](#e20_testing_registers) | Daily E-20 testing sheet (outlet, dealer certification) |
| [e20_water_checks](#e20_water_checks) | Part A — morning water dip, one row per tank |
| [e20_quality_checks](#e20_quality_checks) | Part B — petrol appearance every 2 hours, 12 slots |
| [day_closing](#day_closing) | Daily closing statement (night cash, phone pay, short, snapshot) |
| [night_cash_collections](#night_cash_collections) | Register of physical night-cash pickups linked to day_closing rows |
| [write_requests](#write_requests) | Results of money RPCs keyed by client request id (retry safety) |
| [tanker_decantations](#tanker_decantations) | Tanker unloading: dip before/after, invoice qty, density, temperature, short delivery |
| [settlement_imports / settlement_lines](#settlement_imports--settlement_lines) | Uploaded bank / UPI statement credits for settlement matching (admin) |

**Storage buckets** (Supabase Storage, not PostgreSQL tables): `user-avatars` (operator profile photos). Staff photos and Aadhaar scans are stored in Google Drive (see `drive-files` edge function). Legacy `staff-photos` bucket may still hold older ID photos.

---

## RLS conventions

All application tables have RLS enabled. Unless noted otherwise:

| Operation | Rule |
|-----------|------|
| **SELECT** | Provisioned staff only — `is_supervisor_or_admin()` (row must match a `public.users` email to JWT) |
| **INSERT** | Provisioned staff + `created_by = auth.uid()` |
| **UPDATE** | Provisioned staff + (own row or admin) |
| **DELETE** | Admin only |

**Provisioned staff** means the signed-in user has a row in `public.users` with role `admin` or `supervisor`. Auth-only users (in `auth.users` but not `public.users`) are denied.

**Security-definer RPCs** (credit, day closing, billing, DSR stock range, employee roster, etc.) call `require_staff_access()` at entry — same gate as RLS.

**Function EXECUTE:** `anon` and `PUBLIC` cannot execute any function in `public` (`20261013092142_revoke_anon_function_execute`, `20261029161130_revoke_public_function_execute`). With no login the role helpers return null and `require_staff_access()` returns early, so this revoke is what keeps the anon key out. A new function needs an explicit `grant execute on function … to authenticated`; the global default privilege for `postgres` no longer grants PUBLIC. (The first migration's `in schema public` defaults could not remove the global PUBLIC grant, so functions re-created between 20261013 and 20261029, including `set_day_closing_certified` and `get_credit_aging`, were anon-callable until the second.) `supabase/tests/rls.test.sql` fails if any app function is executable by anon.

**Exceptions:**

- **users:** SELECT provisioned staff; INSERT admin, or first-admin bootstrap (own email, role `admin` only); UPDATE/DELETE admin. Prefer `upsert_staff` / `delete_staff`. Avatar URL updated via `update_my_avatar`. A direct client INSERT currently fails for every caller with `42P17 infinite recursion` (the policy's bootstrap branch reads `public.users`); staff are added through `upsert_staff`, which is unaffected.
- **expense_categories, products, employees:** SELECT admin only on `employees` (supervisors use `list_employees_roster` / `list_employees_salary` RPCs); mutations admin only on all three.
- **invoices, invoice_items:** SELECT provisioned staff; INSERT/UPDATE denied on client — header and lines are created only inside `save_invoice` RPC. DELETE admin only.
- **salary_payments:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `record_salary_payment` / `delete_salary_payment`.
- **credit_entries:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `add_credit_entry`. DELETE admin only.
- **credit_payments:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `record_credit_payment` / `batch_record_credit_settlements`. DELETE admin only.
- **day_closing:** SELECT provisioned staff; INSERT/UPDATE/DELETE denied on client — use `save_day_closing`, `set_day_closing_certified`, `collect_night_cash`, and `delete_day_closing`.
- **expenses:** INSERT/UPDATE cannot set `salary_payment_id` or category `salary` (those rows come from `record_salary_payment`). A new amount must be greater than 0 (`expenses_guard_amount`); a historical non-positive amount can stay when the update does not change it. Admins cannot delete a salary-linked expense directly. A shift-attributed write is rejected for a supervisor once day closing is saved (`expenses_guard_shift_write`).
- **write_requests:** no client access; written by money RPCs.
- **audit_log:** SELECT admin only; writes via triggers only.
- **client_errors:** INSERT any login (`user_id` must be the caller; the trigger overwrites it anyway); SELECT admin only; no UPDATE/DELETE.
- **pump_settings:** SELECT provisioned staff; INSERT/UPDATE admin only.
- **dsr_petrol / dsr_diesel `buying_price_per_litre`:** not granted to `authenticated` for select, insert, or update. Staff still read the other meter columns. Profit reads `dsr_cost` (admin only). `update_dsr_buying_price` writes the column.
- **reminders:** SELECT/INSERT as default; UPDATE allowed for any provisioned staff (shared ops board); DELETE admin only.

Migration: `supabase/migrations/20260619100000_security_loophole_mitigation.sql`.

---

## audit_log

**Purpose:** Audit trail for sensitive operations. Only admins can read.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| table_name | text | Table that was modified |
| record_id | uuid | Id of the row |
| action | text | INSERT, UPDATE, DELETE |
| old_data | jsonb | DELETE: whole row. UPDATE: changed columns, values before |
| new_data | jsonb | INSERT: whole row. UPDATE: changed columns, values after |
| performed_by | uuid | auth.users.id |
| performed_by_email | text | Email at time of action |
| performed_at | timestamptz | When the action occurred |

**RLS:** SELECT only for admin; no direct INSERT/UPDATE/DELETE (only via triggers).

**Populated by:** Audit triggers on: users, dsr_petrol, dsr_diesel, meter_shift_readings, meter_shift_cash (insert, delete, and updates of cash, phone pay, remarks, date, shift, or employee — not cache-only refreshes of `credit_amount` / `expense_amount`), expenses, credit_customers, credit_entries, employees, salary_payments, salary_lop_exclusions, employee_attendance, credit_payments, day_closing, invoices.

**Retention:** Production rows older than 6 months are deleted by `purge_audit_log_batch` (maintenance script only, not granted to app roles), run weekly by `.github/workflows/purge-audit-log.yml`. The same workflow, started by hand, can pass a keep of 3, 2, or 1 month. Staging sets `runtime_flags.audit = off`, so the trigger writes nothing there, and sync empties the table. See [STORAGE_RETENTION.md](STORAGE_RETENTION.md).

---

## client_errors

**Purpose:** Errors from staff browsers and phones, so an admin can see a failure nobody reported. Written by `AppError.report` in `js/errorHandler.js`; shown in **Settings → App errors** (last 7 days).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| created_at | timestamptz | When the server received the row |
| occurred_at | timestamptz | When the browser saw the error (client clock; capped at `created_at` + 5 min) |
| user_id | uuid | auth.uid() of the sender (set by trigger) |
| user_email | text | JWT email (set by trigger) |
| role | text | `get_user_role()` at insert; null for an unprovisioned login (set by trigger) |
| page | text | File name, e.g. `dsr.html` |
| message, code, name, stack | text | From the error object |
| context | jsonb | The `context` argument passed to `AppError.report` |
| app_version | text | Service worker `CACHE_VERSION` (null before the worker controls the page) |
| app_env | text | `APP_ENV` from `js/env.js` |
| user_agent | text | Browser user agent |

**RLS:** INSERT for any authenticated user; SELECT admin only; no UPDATE/DELETE grant.

**Trigger `client_errors_before_insert`:** sets `id`, `created_at`, `user_id`, `user_email`, `role` from the session; trims long text; drops rows past 30 per user per minute; deletes rows older than 90 days.

**Client:** errors are queued in `localStorage` (`bpf_client_error_queue`, at most 50), deduplicated per page and message for 10 s, and inserted in one batch about 5 s after the first error, when the tab is hidden, or when the browser comes back online. Without a session the queue waits for the next signed-in page.

**Weekly query** (SQL editor):

```sql
select page, message, count(*) as hits, count(distinct user_id) as users,
       max(created_at) as last_seen, max(app_version) as version
from public.client_errors
where created_at > now() - interval '7 days'
group by page, message
order by hits desc
limit 50;
```

---

## runtime_flags

**Purpose:** Switches read by security-definer functions. One row `key = audit`, `value = off` disables audit logging. Production leaves this table empty, so logging stays on.

| Column | Type | Description |
|--------|------|-------------|
| key | text | Primary key. `audit` is the audit switch |
| value | text | `off` disables the matching behaviour |

**RLS:** Enabled. No policies, and `anon` / `authenticated` have no grants. The audit trigger reads it as the table owner.

**Staging:** `scripts/disable-staging-audit.sh` upserts `audit=off` and truncates `audit_log`. `./scripts/db.sh sync` does the same after the copy.

---

## users

**Purpose:** App users who can log in. Roles: `admin`, `supervisor`. Display name shown in UI.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| email | text | Unique, lowercase login email |
| auth_user_id | uuid | `auth.users.id`. Role checks use this, not the email claim. Filled when the Auth user and this row refer to the same email |
| role | text | `admin` \| `supervisor` |
| display_name | text | Optional; shown in app |
| avatar_url | text | Optional; public URL in `user-avatars` Storage bucket |
| created_at | timestamptz | Created at |

**RLS:** SELECT provisioned staff; INSERT admin, or first-admin bootstrap (own JWT email, role `admin` only); UPDATE/DELETE admin. Staff changes should use RPCs `upsert_staff`, `delete_staff`. Avatar: RPC `update_my_avatar(p_avatar_url)`.

---

## dsr_petrol

**Purpose:** MS (petrol) meter readings — **one row per date**. Filled by the Meter Reading form (`js/dsr.js` → table `dsr_petrol`). Used for day closing, dashboard, analysis, and reports.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Business date |
| tank_capacity | text | e.g. `15KL` (from pump settings) |
| opening_pump*_nozzle* | numeric | Opening meter readings |
| closing_pump*_nozzle* | numeric | Closing meter readings |
| sales_pump1, sales_pump2 | numeric | Sales per pump |
| total_sales | numeric | Total sales (L) |
| testing | numeric | Testing (L) |
| dip_reading | numeric | Dip reading |
| stock | numeric | Dip stock (L) — feeds `dsr_stock.dip_stock` |
| receipts | numeric | Fuel received (L) |
| petrol_rate, diesel_rate | numeric | Selling rates (₹/L) |
| buying_price_per_litre | numeric | Admin; pre-VAT cost for P&amp;L / purchase GST |
| supplier_invoice_no | text | BPCL / supplier invoice no (purchase GST register) |
| supplier_gstin | text | Supplier GSTIN for this receipt (else Settings default) |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Index / constraint:** `unique (date)` — one MS row per business date (prevents day-closing and stock double-count).

**RLS:** SELECT provisioned staff on every column except `buying_price_per_litre` (that column is not granted). INSERT/UPDATE of meter columns for supervisor or admin; DELETE admin only. A certified day rejects insert, update, and delete for everyone, including admin (`dsr_validate_meter_row`).

---

## meter_shift_readings

**Purpose:** Optional **shift-wise** nozzle meter readings with staff assignment. Does **not** replace daily `dsr_petrol` / `dsr_diesel` (those remain the source of truth for day closing, stock, and reports).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| reading_date | date | Business date |
| product | text | `petrol` \| `diesel` |
| shift | text | `morning` \| `afternoon` (labels from Settings → Attendance shifts) |
| employee_id | uuid | → employees |
| pump_no, nozzle_no | smallint | Meter identity (P1·N1 …) |
| opening_meter, closing_meter | numeric | Shift open/close |
| testing_litres | numeric | Testing attributed to this nozzle |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Audit |

**Unique:** `(reading_date, product, shift, pump_no, nozzle_no)`.

**RPCs:** `get_meter_shift_readings`, `save_meter_shift_readings`, `delete_meter_shift_readings` (admin), `get_meter_shift_prior_closings`, `get_shift_aggregated_daily_meters`, `apply_shift_aggregate_to_dsr`, `sync_shift_meters_from_dsr`, `meter_shift_lock_info`, `require_meter_shift_writable`, `get_meter_sales_breakdown`. Shift credit and expenses on the same screen: `get_shift_staff_ledger`, `delete_shift_credit_entry`, `delete_shift_expense`. Lock checks used by those RPCs and by the daily-sheet policies: `meter_day_is_locked`, `meter_day_has_closing`, `meter_day_has_daily_entry`, `meter_shift_has_readings`, `require_meter_day_writable`, `dsr_meter_row_is_complete`.

**Ownership:** Shift save writes `meter_shift_*` (via RPC; clients have SELECT only) and refreshes meter columns on existing `dsr_*` rows via `apply_shift_aggregate_to_dsr` (never inserts stubs). Daily MS/HSD save writes dip/stock/rate on `dsr_*`. Shift meters also prefill the meter sheet via `get_shift_aggregated_daily_meters`. Daily layout is fixed **2 pumps × 2 nozzles** (matches `dsr_*` columns).

**Lock:** Supervisors can re-save a shift with updated values until day closing is saved for that date; afterwards only an admin can change shifts. Certified day / night-cash collected also locks meter sync for supervisors.

**UI:** Meter Reading → **Shift register** (`js/meterShiftReading.js`). Period views on **DSR** → Sales detail (`js/dsrSalesBreakdown.js`). Reports: pump / shift / salesman sales.

---

## meter_shift_cash

**Purpose:** Cash handed over by staff for a shift. Stores **hard cash**, **phone pay** (UPI), and **cached** credit/expense totals. **Total** = cash_collected + phone_pay + credit_amount + expense_amount. Expected ₹ = assigned nozzle net litres × day selling rates (from daily DSR when present). **Short** = expected − total. Credit/expense caches are synced from attributed `credit_entries` / `expenses` rows (day closing reads the ledger for credit/expense). Day closing shows shift `cash_collected` / `phone_pay` (plus Cash/UPI settlements) as a hint. The supervisor types Night cash and Phone pay; the form does not prefill them. Formula: [DAY_CLOSING.md](DAY_CLOSING.md).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| reading_date | date | Business date |
| shift | text | `morning` \| `afternoon` |
| employee_id | uuid | → employees |
| cash_collected | numeric | Hard cash handed over (₹) |
| phone_pay | numeric | PhonePe / UPI for the shift (₹) |
| credit_amount | numeric | Cached sum of shift-attributed credit sales (₹) |
| expense_amount | numeric | Cached sum of shift-attributed expenses (₹) |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Audit |

**Unique:** `(reading_date, shift, employee_id)`.

---

## dsr_diesel

**Purpose:** HSD (diesel) meter readings — same column layout as `dsr_petrol`, default `tank_capacity` typically `20KL`. **One row per date** (`unique (date)`).

**RLS:** Same as `dsr_petrol`.

**RPC:** `update_dsr_buying_price(uuid, numeric, text, text)` updates `buying_price_per_litre` and optional `supplier_invoice_no` / `supplier_gstin` on whichever table contains the row id.

---

## dsr (view)

**Purpose:** Backward-compatible **SELECT-only** union of `dsr_petrol` and `dsr_diesel` with a synthetic `product` column (`petrol` \| `diesel`). Writes must go to the underlying tables. This view does not include `buying_price_per_litre`, so meter, stock, and day-closing reads work for supervisors. Profit and purchase cost use `dsr_cost`, which returns rows only when `is_admin()`. Both views read the tables directly (one row per date is enforced by `dsr_*_date_unique`), so a date filter uses the date index.

```sql
select ..., 'petrol' as product from dsr_petrol
union all
select ..., 'diesel' as product from dsr_diesel;
```

---

## dsr_stock (view)

**Purpose:** **Computed** stock reconciliation per (date, product). Not a physical table. There is no Stock form and no `sync_dsr_receipts_from_stock` step. Dip entered on the meter row is enough.

| Field | Formula |
|-------|---------|
| `dip_stock` | `stock` on the meter row |
| `net_sale` | `greatest(total_sales - testing, 0)` |
| `opening_stock` | previous day’s `dip_stock` (`LAG` per product) |
| `closing_stock`, `variation` | opening, receipts, net sale, and dip |

**RPC:** `get_dsr_stock_range(start_date, end_date)` — same logic, but `LAG` is scoped to the range plus one prior day per product. Prefer it for a date picker so the report does not scan full history. Requires `require_staff_access()`. The client combines meter rows and stock fields with `mergeDsrStock` in `js/dsrQueries.js`.

Dashboard and sales-daily read `dsr_stock` (or the RPC). Tank fill % uses `pump_settings.config.pumps` (`petrol.tankCapacity` / `diesel.tankCapacity`). `reports.tanks` is one section per product for the tank-wise DSR printout.

**Dip vs book variance (owner view):** `get_stock_variance(start, end)` returns, per product and day, `book_stock = opening_dip + receipts − meter_sales`, `variance_litres = closing_dip − book_stock` (negative = loss; note the sign is the opposite of `variation`), `variance_pct` of meter sale, `variance_value` at that day's selling rate, and `over_tolerance` against `stock_variance_tolerance_pct()` (`pump_settings.config.alerts.stockVarianceTolerancePct`, default 0.5). When a [tanker decantation](#tanker_decantations) exists for the day, its invoice quantity replaces `dsr_*.receipts` as the receipt figure and `delivery_variance_litres` carries the short delivery. Shown on DSR → Stock variance and the dashboard tile.

**Tank-wise DSR columns:** Open, Buy, **Short** (`max(0, variation)` = book − dip when the book is higher), **Total** (open + buy − short), Test, Meter, Actual, Cum, Dip sale, Close, Var, CumV, Rate, **TVA** (configured capacity − closing dip).

### Why two tables

| Choice | Why |
|--------|-----|
| `dsr_petrol` and `dsr_diesel` | Per-tank defaults (15KL vs 20KL), simpler forms, buying price per product |
| `dsr` view | One shape for “all products” reads |
| Computed `dsr_stock` | No duplicate stock rows, no sync job, variation always matches the latest meter row |
| `meter_shift_*` | Staff and shift accountability. Day closing, stock, and reports still read the daily tables |

Trigger `dsr_validate_meter_row` (before insert or update) rejects a closing below its opening, a negative meter or sales/testing/stock/receipts value, or testing above total sales. An update that leaves those columns alone (buying price, supplier invoice) is not checked, so an older bad row can still be edited. A certified day rejects the write for everyone, including admin.

A single table with a `product` column would match today’s view plus two tables. Worth it only if you need a cross-product constraint in one physical table.

---

## products

**Purpose:** Product master for **billing** (lubricants, accessories, etc.).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Product name |
| hsn_code | text | HSN/SAC (optional) |
| unit | text | e.g. `Pcs`, `Ltr` |
| default_rate | numeric | Default rate (₹) |
| gst_percent | numeric | GST % (default 18) |
| is_active | boolean | Active flag |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** SELECT provisioned staff; INSERT/UPDATE/DELETE **admin only**.

---

## invoices

**Purpose:** Sales invoices / cash memos (lube billing). Header totals and party details.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_number | text | Unique (from sequence + prefix in settings) |
| invoice_date | date | Invoice date |
| invoice_type | text | `CASH` \| `CREDIT` |
| party_name, party_address, party_gstin | text | Customer |
| vehicle_no, mobile, km_reading | text | Optional |
| subtotal, discount, round_off, total_amount | numeric | Amounts |
| cgst_total, sgst_total, igst_total | numeric | GST breakdown |
| non_gst_total, nil_rate_total | numeric | Non-GST / nil lines |
| notes | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |
| drive_file_id, drive_folder_id, drive_file_name | text | Archived cash memo PDF in Google Drive (`Billing invoices / Year / invoice name`). No month folder |
| drive_web_view_link | text | Drive view link |

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

**RPC:** `save_invoice(...)` — atomic insert of header + line items (`jsonb` array); calls `require_staff_access()`.

**Audit:** `audit_invoices_trigger`.

---

## invoice_items

**Purpose:** Line items for each invoice.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_id | uuid | FK → invoices.id (cascade delete) |
| sl_no | int | Line number |
| product_id | uuid | FK → products.id (optional) |
| item_name | text | Description |
| hsn_code, unit | text | Line metadata |
| quantity, rate | numeric | Qty and rate |
| gst_percent, amount | numeric | Tax and line total |
| created_at | timestamptz | Created at |

**RLS:** SELECT provisioned staff; INSERT/UPDATE/DELETE **denied** on client (`with check (false)` / `using (false)`). Line rows are created only inside `save_invoice` (security definer).

---

## invoice_documents

**Purpose:** **Supplier / purchase invoice** file metadata. Binary files live in **Google Drive** (`Purchase invoices / Year`; other types: `Other documents / Year`, file named from the title). Not related to billing table `invoices`.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_date | date | Supplier invoice date |
| year | smallint | Folder year (from date) |
| month | smallint | Calendar month 1–12 from the document date. Not used as a Drive folder |
| title | text | Optional description |
| vendor | text | Supplier name |
| amount | numeric(14,2) | Optional amount |
| file_name | text | Stored filename |
| mime_type | text | e.g. `application/pdf` |
| file_size | bigint | Size in bytes |
| drive_file_id | text | Google Drive file ID |
| drive_folder_id | text | Drive folder ID (the year folder: `Purchase invoices / Year` or `Other documents / Year`) |
| drive_web_view_link | text | Drive URL. Not shared publicly; View and Download go through the edge function |
| public_link_revoked_at | timestamptz | When the file-level anyone permission was confirmed absent |
| notes | text | Optional |
| uploaded_by | uuid | FK → auth.users |
| created_at | timestamptz | Upload time |

**RLS:** SELECT and INSERT for `is_supervisor_or_admin()`; DELETE for `is_admin()` only. Rows are inserted by edge function `invoice-documents` via service role; client reads via SELECT policy.

**Page:** `invoices.html` (Finance → Invoices). **Setup:** [Invoice documents guide](INVOICE_DOCUMENTS.md).

---

## letterhead_letters

**Purpose:** Index of typed station letters. The PDF is stored in Google Drive (`Letters`, no year folder). `body` is held only until archive succeeds, then cleared so Postgres stays small.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| letter_date | date | Letter date |
| subject | text | History list title (not the full letter) |
| body | text | Temporary; cleared after the Drive PDF is stored |
| export_type | text | `save` \| `print` \| `word` |
| include_sign | boolean | Signature footer on the letter |
| drive_file_id, drive_folder_id, drive_file_name, mime_type | text | Google Drive archive |
| drive_web_view_link | text | Drive view link |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT supervisor/admin; INSERT own rows; DELETE admin only. Drive uploads insert via `drive-files` (service role).

**Page:** `letterhead.html` (Letter Desk).

---

## pump_settings

**Purpose:** **Single-row** JSON configuration (`id = 1`): station branding, billing defaults, pump/tank layout, report tanks, purchase VAT %, alerts, attendance shifts, **integrations (Google Drive for invoices, letters, and staff files)**. Seeded from `js/appConfig.js` defaults when empty.

| Column | Type | Description |
|--------|------|-------------|
| id | int | Always `1` |
| config | jsonb | Full settings object |
| updated_at | timestamptz | Last change |
| updated_by | uuid | auth.users.id |

**RLS:** SELECT provisioned staff; INSERT/UPDATE **admin only**.

**Client:** `js/pumpSettings.js` loads/caches config; Settings page and dashboard/reports consume it.

**Integrations (`config.integrations.googleDrive`):**

| Key | Type | Description |
|-----|------|-------------|
| enabled | boolean | When true, Drive uploads are allowed |
| rootFolderId | string | Google Drive folder ID (URL `…/folders/ID`) |

**Other notable config keys** (see `js/appConfig.js` defaults):

| Path | Purpose |
|------|---------|
| `station.pfEstablishmentCode` | EPFO establishment code on salary slips |
| `billing.includeInGstReports` | Include lube invoices in GST sales reports |
| `reports.petrolPurchaseVatPct` / `dieselPurchaseVatPct` | Fuel purchase VAT/LST % for P&amp;L and purchase reports |
| `reports.purchaseDeliveryPerKl` | Delivery charge ₹/KL on inward fuel |
| `reports.purchaseTaxInclusive` | Whether buying price is tax-inclusive |
| `alerts.*` | Low stock, credit/variation, day-closing, shortage/surplus, night cash, missing meter/rate/dip, stale credit, unpaid salary, attendance, expense ratio, missing invoice |
| `alerts.stockVarianceTolerancePct` | Dip vs book tolerance, % of meter sale (default 0.5). Read by `get_stock_variance` |
| `alerts.settlementTolerance` | ₹ difference still counted as matched in `get_settlement_match` (default 10). No longer editable in Settings |
| `shifts.*` | Morning/afternoon shift names and times for attendance |
| `payroll.lossOfPayEnabled` | Deduct pay for leave beyond the monthly allowance, and half-days. An admin can exclude that deduction for one employee and month (`salary_lop_exclusions`) |
| `payroll.paidLeaveDaysPerMonth` | Paid leave days allowed each month (default 2) |
| `payroll.overDutyEnabled` | Add one day of salary for each present day marked over duty |
| `payroll.dayRateBasis` / `payroll.fixedDaysInMonth` | Day rate divisor: calendar days in the month, or a fixed count |

Defaults in `js/appConfig.js`. Edge function reads `integrations.googleDrive` for upload path. Full setup: [Invoice documents guide](INVOICE_DOCUMENTS.md).

---

## expenses

**Purpose:** Daily operating expenses for P&L and day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Expense date |
| category | text | References expense_categories (logical) |
| description | text | Optional |
| amount | numeric | Amount (₹). New rows must be greater than 0 (`expenses_guard_amount`). Older non-positive rows are left as recorded |
| salary_payment_id | uuid | Optional FK → salary_payments.id (set by `record_salary_payment`; unique when set; ON DELETE CASCADE) |
| employee_id | uuid | Optional staff whose till paid this expense during a shift |
| shift | text | `morning` \| `afternoon` when entered from the shift register; otherwise null |
| client_request_id | uuid | Expenses form request id; unique when set so a retried insert cannot duplicate |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Salary linkage:** `record_salary_payment` inserts the payment and its `expenses` row (category `salary`, `salary_payment_id` set) in one transaction. Deleting the payment removes the linked expense through the cascading foreign key; `delete_salary_payment` also removes an exact-match unlinked expense left by payments recorded before the link existed.

**Indexes:** `(date desc)`, `(created_at desc)`, `(category)`, partial `(date, shift, employee_id)`, partial unique on `salary_payment_id` and on `client_request_id`.

**RLS:** SELECT as the default pattern. INSERT/UPDATE cannot set `salary_payment_id` or category `salary` (those rows come from `record_salary_payment`). Admins cannot delete a salary-linked expense; a supervisor can delete their own shift expense. `expenses_guard_amount` rejects a new amount that is not greater than 0, and leaves a historical non-positive amount in place when an update does not change it. `expenses_guard_shift_write` applies the shift-register lock to any shift-attributed insert, update, or delete: a supervisor is blocked once day closing is saved, or the day is certified or night cash is collected. Book expenses (no shift) are not covered by that lock. `ledger_guard_certified_day` rejects a write whose date is certified, then refreshes an uncertified saved closing. See [RLS exceptions](#rls-conventions).

---

## expense_categories

**Purpose:** User-managed expense categories (used in Expenses form and Settings).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Unique internal name |
| label | text | Display label |
| sort_order | int | Display order |
| created_at | timestamptz | Created at |

**RLS:** SELECT provisioned staff; INSERT/UPDATE/DELETE admin only.

---

## employees

**Purpose:** Pump employees who receive salary and have attendance (distinct from app users).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Employee name |
| role_display | text | Role label (e.g. Supervisor) |
| monthly_salary | numeric | Monthly salary (₹) |
| aadhar_number | text | Optional 12-digit Aadhaar |
| address | text | Optional address (max 500 chars) |
| phone_number | text | Optional 10-digit mobile |
| pan_number | text | Optional PAN (`ABCDE1234F`) |
| pf_number | text | Optional PF / UAN (max 30 chars) |
| pf_contribution | numeric | Fixed monthly PF deduction (₹) — set in Settings → Staff salaries; shown on salary slips |
| blood_group | text | Optional: `A+`, `A-`, `B+`, `B-`, `AB+`, `AB-`, `O+`, `O-` (required for ID card print) |
| photo_url | text | Optional; Drive image URL for ID card (required for ID card print) |
| photo_drive_file_id | text | Google Drive file ID for the staff photo image (ID cards). A letterhead PDF copy is stored as `Photo (letterhead).pdf` in the same folder |
| aadhaar_drive_file_id | text | Google Drive file ID for the Aadhaar card (private letterhead PDF, or original PDF) |
| aadhaar_file_name | text | Stored Aadhaar file name |
| date_of_birth | date | Optional; shown on staff ID card |
| id_valid_from | date | ID card validity start (back of card) |
| id_valid_to | date | ID card validity end (back of card) |
| display_order | smallint | Order in lists |
| is_active | boolean | Employment status — inactive staff excluded app-wide |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT/INSERT/UPDATE for supervisor or admin; DELETE admin only. `employees_guard_salary_columns` rejects a supervisor insert or update that sets `monthly_salary` or `pf_contribution`. Those two columns are changed from Settings → Staff salaries (admin).

**RPCs:**
- `list_employees_roster()` / `list_employees_salary()` — active staff only
- `set_employee_active(id, is_active)` — admin soft-deactivate / reactivate
- `get_employees_by_ids(ids)` — lookup including inactive (history display)
- `set_employee_photo(employee_id, photo_url)` — active employees only (clears Drive file id when URL is empty)

**Page:** `staff.html` (admin + supervisor) — roster with Active/Inactive filter (admin), profile, photo + Aadhaar card upload to Google Drive, ID card. Deep link: `staff.html#{employee_uuid}`.

---

## salary_payments

**Purpose:** Salary installments: one row per payment (e.g. partial salary on different dates). **`salary_month`** is the pay period (first day of month); **`date`** is when cash was actually paid.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| date | date | Payment date (when cash was paid) |
| salary_month | date | Pay period — first day of the month being paid (e.g. `2026-06-01` for June salary) |
| amount | numeric | Amount (₹) |
| note | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Indexes:** `(employee_id, date desc)`, `(date desc)`, `(salary_month desc, employee_id)`.

**RLS:** SELECT provisioned staff; INSERT/UPDATE denied on client; DELETE admin only.

**Writes:** `record_salary_payment(employee_id, date, salary_month, amount, note?, allow_overpay?, request_id?)` — locks the employee + month, recomputes take-home on the server (`salary_month_payable`: salary + over duty − loss of pay − PF, same rules as `js/payrollRules.js`) and raises hint `salary_overpay` when the amount exceeds what remains. `allow_overpay` is honored for an admin only; a supervisor cannot turn the cap off. `delete_salary_payment(id)` (admin) removes the payment and its expense.

**Client:** `salary.html` groups payments by `salary_month`, shows monthly summary vs `employees.monthly_salary`, and prints salary slips (`css/salary-slip-print.css`).

---

## salary_lop_exclusions

**Purpose:** Admin choice to leave a calculated loss of pay out of one employee's salary for one month. No row means the calculated amount is deducted.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| salary_month | date | Pay period — first day of the month |
| note | text | Optional |
| created_by | uuid | auth.users.id (admin) |
| created_at | timestamptz | Created at |

**Unique:** `(employee_id, salary_month)`.

**RLS:** SELECT supervisor or admin. INSERT and DELETE admin only.

**Client:** `salary.html` — **Exclude from salary** / **Include in salary** on the month summary and staff detail. Payable, slips, and the unpaid-salary alert use the exclusion.

---

## employee_attendance

**Purpose:** Daily attendance per employee: status and optional check-in/out.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| date | date | Attendance date |
| status | text | `present` \| `half_day` \| `leave`. Older `absent` rows are treated as leave |
| shift | text | Optional shift label |
| over_duty | boolean | Extra duty on a present day. Adds one day of salary when over-duty pay is on |
| check_in | time | Optional |
| check_out | time | Optional |
| note | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**Unique:** `(employee_id, date)`.

**Writes:** `save_employee_attendance_batch`. A salary payment for that month does not lock attendance while the month is still open, and yesterday can still be saved the next morning. Once the month has ended, a payment locks earlier days for a supervisor. An admin is not blocked by a salary payment.

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

---

## credit_customers

**Purpose:** Credit ledger: customer master. The same name may belong to more than one customer. A name plus a mobile number is unique. `amount_due` and `prepaid_balance` are kept in sync with posted entries and payments. Net balance = `amount_due − prepaid_balance`. A customer is not both owing and in advance. `date` is fixed at creation. Carried-over balances are opening credit entries.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| customer_name | text | Customer name |
| vehicle_no | text | Optional |
| mobile | text | Optional contact number |
| address | text | Optional address |
| amount_due | numeric | Current outstanding from unsettled sales (synced) |
| prepaid_balance | numeric | Advance from overpayment (≥ 0); net = amount_due − prepaid |
| date | date | Fixed at creation. Not granted for update |
| credit_limit | numeric | Optional. A sale over it warns; it is not rejected. Only an admin can change it |
| last_payment | date | Last payment date |
| notes | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** Default operational pattern. Supervisors and admins may update contact fields. `credit_limit` is granted on the table, and `credit_customers_guard_limit` rejects a change unless the caller is an admin. `authenticated` has no insert or update on `amount_due` or `prepaid_balance`; `sync_credit_customer_balances` (security definer) writes them.

**Trigger / sync:** Entry and payment RPCs keep `amount_due` and `prepaid_balance` consistent.
---

## credit_entries

**Purpose:** One row per credit sale. Transaction date = DSR (business) date; drives “credit today” in day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id |
| transaction_date | date | Business date of fuel delivery |
| fuel_type | text | `MS` \| `HSD` |
| quantity | numeric | Quantity (L) |
| amount | numeric | Amount (₹) |
| amount_settled | numeric | Amount already paid. Payments allocate newest-open-first (LIFO). Prepaid is applied oldest-first when a new sale is saved |
| employee_id | uuid | Optional staff for a shift-register sale |
| shift | text | `morning` \| `afternoon`, or null. Set together with `employee_id` or leave both null |
| status | text | `posted`, or `cancelled` only for a leftover row from before admin delete removed the record. Cancelled rows stay out of balances until an admin deletes them |
| entry_kind | text | `sale`, or `opening` when a carried-over balance was turned into a normal entry |
| cancelled_at | timestamptz | Set when status becomes `cancelled` |
| cancelled_by | uuid | auth.users.id of the person who cancelled |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Constraint:** `amount_settled <= amount`.

**RLS:** SELECT provisioned staff; INSERT, UPDATE, and DELETE denied on the client. `add_credit_entry` writes the sale. Payment RPCs write `amount_settled`. Admin delete goes through `delete_credit_entry`, which removes the row.

**Trigger:** `credit_entries_sync_amount_due` calls `sync_credit_customer_balances` (`amount_due` and `prepaid_balance`), unless the RPC set `app.skip_credit_sync`. `ledger_guard_certified_day` rejects a certified sale date. An update that only changes `amount_settled` is still allowed inside those RPCs, so a later payment can settle that sale.

---

## credit_payments

**Purpose:** Payments received from credit customers. Day-closing **collection** is the sum for that date where `same_day_settlement` is false. Flagged rows are excluded from collection and show up as Night cash (Cash) or Phone pay (UPI).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id |
| date | date | Settlement date |
| amount | numeric | Amount (₹) |
| note | text | Optional |
| payment_mode | text | `Cash` \| `UPI` \| `Bank` |
| same_day_settlement | boolean | True when the payment settles same-day credit (excluded from collection) |
| status | text | `posted`, or `cancelled` only for a leftover row from before admin delete removed the record. Cancelled payments stay out of balances until an admin deletes them |
| cancelled_at | timestamptz | Set when status becomes `cancelled` |
| cancelled_by | uuid | auth.users.id of the person who cancelled |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT provisioned staff; INSERT and UPDATE denied on client — same pattern as `salary_payments`. `record_credit_payment` and `batch_record_credit_settlements` insert the row. Direct DELETE is denied. Admin delete goes through `delete_credit_payment`, which removes the row.

**Note:** A sale or payment that is not backdated settles only the open rows it touches. A backdated write, and every admin delete, runs `reallocate_credit_settlements`: newest open sale on or before the payment date first, then any leftover advance settles the oldest open sale. A payment refreshes day closing once. A certified payment date is rejected. Deleting a same-day Cash or UPI payment subtracts it from night cash or phone pay.

---

## credit_statement_links

**Purpose:** Read-only statement links a customer opens without a login (`statement.html#t=<token>`). Credit → customer → **Share link** creates one valid 30 days and sends it on WhatsApp. The WhatsApp and SMS contact icons (credit header, Tasks, dashboard, notifications) also create one when tapped (one per customer per page load) and add it to the balance message.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id (cascade) |
| token_hash | text | sha256 hex of the token. The token itself is returned once and never stored |
| expires_at | timestamptz | 1–90 days after creation |
| revoked_at | timestamptz | Set by `revoke_credit_statement_links` |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |
| last_viewed_at / view_count | timestamptz / int | Updated on each successful open |

**RLS:** SELECT provisioned staff; no client writes. `create_credit_statement_link(customer_id, days)` and `revoke_credit_statement_links(customer_id)` (whole name group) are staff RPCs. `get_credit_statement_by_token(token)` is **service_role only**: the public page calls the `credit-statement` Edge Function, so anon still executes no app function. The statement covers the customer's name group: station letterhead fields (`station`: name, tagline, address, GSTIN, mobile, email from `pump_settings`), balance, opening balance, period billed/paid, ledger `lines` with a running balance for the last 90 days, and every open bill with its age. No staff names or payment notes.

---

## reminders

**Purpose:** Station tasks — dated reminders and undated todos (credit follow-ups, calls, general work). Shared across admin and supervisor. Due/overdue items and high-priority undated todos surface on Dashboard (login popup + Daily Snapshot strip + Notifications).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| title | text | What needs doing (1–200 chars) |
| notes | text | Optional detail |
| due_date | date | Optional. Set = reminder; null = backlog todo |
| priority | text | `low` \| `normal` \| `high` (high undated todos also alert on dashboard) |
| reminder_type | text | `general` \| `todo` \| `credit_followup` \| `call` \| `payment` \| `other` |
| status | text | `open` \| `done` \| `cancelled` |
| credit_customer_id | uuid | Optional FK → credit_customers.id |
| completed_at | timestamptz | Set when status = done |
| completed_by | uuid | auth.users.id who completed |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** SELECT provisioned staff; INSERT own; UPDATE any provisioned staff; DELETE admin only.

**UI:** `reminders.html` (Tasks: Credit collection + Todo) · Dashboard landing popup · Credit customer “Schedule call” (auto title `Call <name>`). Open tasks support one-tap **+3 days**, **More…** (quick choices + custom date), and Call/WhatsApp. **Done** sets `status` to `done` and keeps the row; the toast offers **Undo**, which opens it again. **Delete** removes it permanently. Duplicate open credit calls are blocked at schedule time.

Migration: `supabase/migrations/20260801120000_reminders.sql`.

---

## e20_testing_registers

**Purpose:** One E-20 testing sheet per day (`e20-register.html`, `js/e20Register.js`). This certification is the dealer’s sign-off on the fuel tests. It is not `day_closing.certified`, and it does not lock meters or money.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| register_date | date | Unique business date |
| retail_outlet_name | text | Outlet name on the sheet |
| cc_code | text | Customer / outlet code |
| certified | boolean | Dealer has signed the sheet |
| certified_at | timestamptz | When it was signed. Null while `certified` is false |
| dealer_sign_name | text | Name on the dealer line |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** SELECT and UPDATE for provisioned staff. INSERT only with `created_by = auth.uid()`. DELETE admin only. The page does not write the header directly.

**RPC:** `save_e20_testing_register(date, outlet, cc_code, water_checks, quality_checks, certified, certified_at, dealer_sign_name, remarks)` upserts this row and replaces both child tables. `e20_parse_yes_no` turns the yes/no text in that JSON into booleans. Staff only.

---

## e20_water_checks

**Purpose:** Part A of that sheet. One row per tank: morning dip and whether water was found.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| register_id | uuid | → e20_testing_registers, cascade delete |
| check_time | time | Time of the dip |
| tank_no | text | Tank label |
| opening_dip_mm | numeric | Opening dip (mm) |
| water_finding_mm | numeric | Water found (mm) |
| water_present | boolean | Yes/no |
| corrective_action | text | What was done |
| tested_by | text | Name |
| manager_signed | boolean | Manager line ticked |
| sort_order | smallint | Row order on the sheet |
| created_at | timestamptz | Created at |

**RLS:** SELECT for provisioned staff. No client insert or update. DELETE admin only, so an admin delete of the header can cascade. Writes go through `save_e20_testing_register`, which deletes and reinserts the lines.

---

## e20_quality_checks

**Purpose:** Part B. Up to 12 slots, one every two hours, for how the petrol looked.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| register_id | uuid | → e20_testing_registers, cascade delete |
| slot_no | smallint | 1–12, unique per register |
| check_time | time | Slot time |
| visual_appearance | text | `clear_bright` or `hazy` |
| water_separation | boolean | Water separated |
| action_taken | text | What was done |
| tested_by | text | Name |
| tester_signed | boolean | Tester line ticked |
| created_at | timestamptz | Created at |

**RLS:** Same as `e20_water_checks`.

---

## day_closing

**Purpose:** Daily closing statement: one row per date. Stores night_cash, phone_pay, computed short_today, and full snapshot (total_sale, collection, short_previous, credit_today, expenses_today) for accounting. `short_previous` comes from previous day’s `short_today`.

**Formula:**  
`short_today = (total_sale + collection + short_previous) - (night_cash + phone_pay + credit_today + expenses_today)`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Unique closing date |
| night_cash | numeric | Hard cash the supervisor types. Shift cash plus Cash settlements are a hint only; the form does not prefill them |
| phone_pay | numeric | UPI the supervisor types. Shift phone pay plus UPI settlements are a hint only |
| short_today | numeric | Computed short (stored for next day’s short_previous) |
| total_sale | numeric | Snapshot at closing |
| collection | numeric | Snapshot at closing |
| short_previous | numeric | Carried from previous day |
| credit_today | numeric | New credit that day (snapshot) |
| expenses_today | numeric | Expenses that day (snapshot) |
| closing_reference | text | Unique ref (e.g. DC-2026-00001) |
| night_cash_collection_id | uuid | FK → night_cash_collections when cash was picked up |
| certified | boolean | True after an admin acknowledges the saved statement |
| certified_at | timestamptz | When certified |
| certified_by | uuid | auth.users.id of the certifying admin |
| certified_by_name | text | Display name (or email) snapshot at certify time |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** SELECT provisioned staff. INSERT and UPDATE denied on client, so night cash and short are stored only by `save_day_closing`. DELETE denied on client — `delete_day_closing` removes the latest uncertified, uncollected closing. `set_day_closing_certified` and `collect_night_cash` update the row. Certified closings stay frozen until revoke; supervisors cannot overwrite a collected closing.

**RPCs:**

| RPC | Behaviour |
|-----|-----------|
| `get_day_closing_breakdown(date)` | Components + `already_saved`, `can_overwrite`, `shift_cash_total`, `shift_phone_pay_total`, `night_cash_collected`, `certified`, `can_certify`. Certified days return the frozen snapshot; `can_overwrite` is false for everyone. |
| `save_day_closing(date, night_cash, phone_pay, remarks?)` | Insert or overwrite; **rejects certified** dates until revoke; recascades short on later uncertified days |
| `set_day_closing_certified(date, certified)` | Admin-only: certify (lock) or revoke (unlock for edit, then recertify) |
| `delete_day_closing(id)` | Admin only, **latest uncertified date only** (also blocked if night cash collected) |
| `get_night_cash_available()` | Uncollected closings ready for pickup |
| `preview_night_cash_collection(from, to)` | Preview amounts before collecting |
| `collect_night_cash(from, to, remarks?)` | Create register row and link closings (allowed while certified) |

`recascade_day_closing_short_from` is internal (not callable by clients). Snapshot sync (`sync_saved_day_closing_for_date`) **rejects certified** dates instead of clearing the seal.

---

## night_cash_collections

**Purpose:** Immutable (via app) register of physical night-cash pickups from the pump. Each collection covers a date range of `day_closing` rows.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| collection_reference | text | Unique ref (e.g. NCC-2026-00001) |
| from_date | date | First closing date included |
| to_date | date | Last closing date included |
| day_count | int | Number of linked days |
| total_amount | numeric | Sum of `night_cash` from linked closings |
| remarks | text | Optional (max 500) |
| collected_by | uuid | auth.users.id |
| collected_at | timestamptz | When recorded |
| created_at | timestamptz | Created at |

**RLS:** SELECT for provisioned staff. Inserts go through `collect_night_cash` (security definer).

**Page:** `day-closing.html` collection UI.

---

## write_requests

**Purpose:** Result of each money-writing RPC call made with `p_request_id`, so a retried call (timeout, lost response, double submit) returns the first result instead of writing twice.

| Column | Type | Description |
|--------|------|-------------|
| request_id | uuid | Primary key — client-generated id |
| kind | text | RPC name (`save_invoice`, `record_credit_payment`, …); a reused id for a different RPC is rejected |
| created_by | uuid | auth.uid() of the caller; a reused id from another user is rejected |
| response | jsonb | RPC return value |
| created_at | timestamptz | Rows older than 14 days are pruned on write |

**RLS:** enabled, no client policies or grants. Written only by `write_request_store()` inside the RPC's transaction.

---

## tanker_decantations

**Purpose:** One row per tanker compartment unloaded into a tank (DSR → Tanker decantation). Migration `20261030125449_tanker_decantation`.

| Column | Description |
|--------|-------------|
| decant_date, product | Business date and tank (`petrol` / `diesel`) |
| invoice_no, invoice_document_id | Supplier invoice; optional link to the vault PDF (`invoice_documents`, set null on delete) |
| truck_no | Tanker registration |
| invoice_qty_litres | Quantity on the invoice (> 0) |
| dip_before_cm, stock_before_litres | Dip and chart stock before unloading |
| dip_after_cm, stock_after_litres | Dip and chart stock after unloading (≥ before) |
| density_kg_m3, invoice_density_kg_m3, temperature_c | Observed vs invoice density, product temperature |
| received_litres | **Generated:** after − before |
| delivery_variance_litres | **Generated:** received − invoice qty. Negative = short delivery |

**RLS:** select / insert (own `created_by`) / update: provisioned staff. Delete: admin. Trigger `tanker_decantations_guard` rejects a future date and, for a supervisor, a day whose meters are locked (`meter_day_is_locked`). Audited.

## settlement_imports / settlement_lines

**Purpose:** Bank or UPI-app statement credits for settlement matching (admin). **No UI:** the DSR → Settlement tab was removed; the tables and RPCs remain in the schema. `import_settlement_lines(source, file_name, column_map, lines)` stores the credit lines. A `reference` is unique per source (case-insensitive), so re-uploading an overlapping statement skips lines already imported. Migration `20261030125452_settlement_matching`.

**RLS:** admin select; admin delete of an import (cascades to its lines). No client insert or update.

**Matching:** `get_settlement_match(start, end, tolerance?, lag_days?)` (admin) compares, per business date, `day_closing.phone_pay` (or shift UPI + UPI credit payments when the day has no closing) with statement lines dated `date + lag_days`. Status `matched` (|difference| ≤ tolerance), `short`, `excess`, `missing_bank`, `bank_only`. Tolerance defaults to `pump_settings.config.alerts.settlementTolerance` (₹10). Card payments are recorded as UPI; there is no card column.

---

## Entity Relationship (Simplified)

```
users (app login)
  └── created_by on: dsr_petrol, dsr_diesel, expenses, credit_*, employees,
                    salary_payments, salary_lop_exclusions, employee_attendance, day_closing, invoices

dsr_petrol / dsr_diesel
  └── dsr (view), dsr_stock (view)

products
  └── invoice_items.product_id (optional)

invoices
  └── invoice_items.invoice_id

pump_settings (id=1)
  └── config JSON used by UI (station, billing, reports, pumps, alerts, integrations.googleDrive)

invoice_documents
  └── uploaded_by → auth.users; files in Google Drive (see INVOICE_DOCUMENTS.md)

employees
  ├── salary_payments.employee_id
  ├── salary_lop_exclusions.employee_id
  └── employee_attendance.employee_id

credit_customers
  ├── amount_due, prepaid_balance
  ├── credit_entries → sync balances
  └── credit_payments

e20_testing_registers (one per register_date)
  ├── e20_water_checks
  └── e20_quality_checks

day_closing
  ├── short_previous = prev day’s short_today
  └── night_cash_collection_id → night_cash_collections

expenses
  └── optional salary_payment_id → salary_payments (salary → expense auto-link)
```

---

## RPC reference

Security-definer RPCs callable by `authenticated` (unless noted). Most call `require_staff_access()` at entry.

| RPC | Purpose | Admin-only mutations |
|-----|---------|----------------------|
| `get_user_role()` | Resolve role from `auth.uid()` → `users.auth_user_id` | — |
| `is_admin()`, `is_supervisor_or_admin()` | Policy helpers. False for a login that is not provisioned; null when there is no login | — |
| `require_staff_access()` | Raises if a login is not provisioned staff. No-op when there is no login | internal |
| `check_page_access(page)` | Returns `{ allowed, role, page }` | — |
| `get_page_session(page)` | Page start in one call: `{ role, display_name, avatar_url, page, allowed }`. `allowed` comes from `check_page_access` | — |
| `upsert_staff(email, role, display_name, password?)` | Create/update app user | bootstrap + admin |
| `delete_staff(email)` | Remove app user | admin |
| `update_my_avatar(url)` | Set operator profile photo URL | own row |
| `get_dsr_stock_range(start, end)` | Stock reconciliation for date range | — |
| `get_stock_variance(start, end)` | Dip vs book per tank and day: litres, %, ₹, over tolerance, short delivery ([dsr_stock](#dsr_stock-view)) | — |
| `stock_variance_tolerance_pct()` | `alerts.stockVarianceTolerancePct` or 0.5 | — |
| `get_attendant_short_excess(start, end, employee_id?)` | Per shift and attendant: expected (net litres × rate), handed over (cash + UPI + shift credit + shift expenses), `short_excess` = handed over − expected | — |
| `import_settlement_lines(source, file, map, lines)` | Store statement credit lines; skips repeat references | admin |
| `get_settlement_match(start, end, tolerance?, lag?)` | Daily app UPI vs statement totals | admin |
| `sum_expenses(start, end, exclude_salary?)` | Sum of expense amounts. `exclude_salary` matches the expenses page | — |
| `expense_totals_by_category(start, end)` | Expense totals grouped by category (jsonb) | — |
| `expense_totals_by_day(start, end)` | Expense totals grouped by day and category (jsonb) | — |
| `sum_credit_given(start, end)` | Sum of credit sale amounts in the range | — |
| `billing_totals_by_date(start, end)` | Billing invoice totals grouped by date (jsonb) | — |
| `purchase_totals_by_date(start, end)` | Purchase-document totals grouped by date (jsonb) | — |
| `get_invoice_document_category_counts(start?, end?)` | Invoice vault outline: `category`, `doc_count`, `latest_date` per category. Security invoker, so `invoice_documents` RLS applies | — |
| `update_dsr_buying_price(id, value)` | Set pre-VAT buying price on DSR row (Meter Reading → Purchase cost) | — |
| `generate_invoice_number()` | Next billing invoice number. Provisioned staff only | — |
| `meter_station_today()` | Station calendar date (IST); use instead of `current_date` (UTC) | — |
| `save_invoice(..., request_id?)` | Atomic invoice + line items; rejects qty/rate ≤ 0, invalid GST, discount < 0 or > subtotal | — |
| `list_employees_roster()` | Active employees without PII | — |
| `list_employees_salary()` | Active employees with HR fields | — |
| `set_employee_photo(id, url)` | Update employee photo URL | admin |
| `save_employee_attendance_batch(date, jsonb)` | Upsert attendance rows. For a supervisor, a salary payment locks days before yesterday in a finished month. An admin is not blocked by a salary payment | — |
| `get_day_closing_breakdown(date)` | Closing components + overwrite / collected / certified flags | — |
| `save_day_closing(date, night_cash, phone_pay, remarks?)` | Save/overwrite closing (rejects if certified) | overwrite: until certified; after collected, admin only |
| `set_day_closing_certified(date, certified)` | Certify (lock everyone) or revoke | admin |
| `delete_day_closing(id)` | Remove latest uncertified closing | admin |
| `compute_day_closing_components(date)` | Live component calculation | internal use |
| `get_night_cash_available()` | Uncollected night cash totals | — |
| `preview_night_cash_collection(from, to)` | Preview pickup for a date range | — |
| `collect_night_cash(from, to, remarks?)` | Record pickup; link closings | — |
| `add_credit_entry(..., request_id?)` | New credit sale; without a mobile, matches the same-name customer (mobile-less row, else its only mobile); locks the customer row; rejects a certified day | — |
| `record_credit_payment(..., request_id?)` | Payment + LIFO; locks the customer row; prepaid on overpay; rejects a certified day | — |
| `batch_record_credit_settlements(..., request_id?)` | Multi-customer payment in one transaction; locks those rows; rejects a certified day | — |
| `add_shift_expense(..., request_id?)` | Shift register expense; rejects a certified day | — |
| `record_salary_payment(...)` | Salary payment + linked expense; server overpay check (admin-only override); rejects a certified payment date | — |
| `delete_salary_payment(id)` | Payment + linked expense; rejects a certified payment date | admin |
| `delete_credit_entry(id)` | Delete a sale (row is removed) and reallocate. Locks the customer first | admin |
| `delete_credit_payment(id)` | Delete a payment (row is removed) and reallocate. Locks the customer first | admin |
| `get_credit_aging(date)` | Date windows 0–30, 31–60, 61–90, 90+ days back: one row per customer name (all its rows summed; `customer_id` is the row that owes most) per window with `credit_taken`, `settlement_done`, `outstanding` (credit minus settlements dated in the window, same as customer Activity for those dates; negative = advance) | — |
| `check_credit_balances()` | Compare stored balances with posted entries and payments | admin |
| `get_credit_ledger_aggregated()` | Ledger summary list | — |
| `get_open_credit_as_of(date)` | Total open credit | — |
| `get_outstanding_credit_list_as_of(date)` | Overdue/outstanding customers | — |
| `get_customer_credit_detail_as_of(name, date, from?)` | Statement for a date range: opening, totals, closing, and lines | — |
| `get_customer_credit_summary_as_of(name, date)` | Summary totals | — |
| `get_customer_credit_breakdown_as_of(name, date)` | Line-level breakdown | — |
| `get_credit_overview_period(from, to)` | Credit overview totals and per-customer rows for a range (`from` null = all time) | — |
| `save_e20_testing_register(...)` | Upsert the E-20 sheet and replace its water and quality lines | — |
| `get_shift_staff_ledger(date, shift)` | Shift-register credit sales and expenses | — |
| `delete_shift_credit_entry(id)` | Remove an unsettled shift-register credit sale. Creator or admin, and the shift must still be writable | — |
| `delete_shift_expense(id)` | Remove a shift-register expense. Same lock | — |
| `enqueue_drive_pdf_archive(kind, id)` | Ask `drive-files` to archive a sales invoice or letter. Returns immediately; a failure is a warning | invoice and letter triggers |

Triggers and helpers (not a page call). `recascade_day_closing_short_from`, `reallocate_credit_settlements`, `sync_credit_customer_balances`, `credit_entries_sync_amount_due`, `purge_audit_log_batch` (one batch of `audit_log` rows older than 6 months), `salary_month_payable`, and `write_request_replay` / `write_request_store` are not granted to `authenticated`.

| Function | What calls it |
|----------|----------------|
| `dsr_meter_row_is_complete(rate, dip, stock, receipts)` | Daily-sheet policies. True when the selling rate is set and dip or stock is entered. Receipts alone do not count |
| `meter_day_is_locked(date)` | True when that day’s closing is certified or night cash was collected |
| `meter_day_has_closing(date)` | True when a `day_closing` row exists. Supervisors cannot re-save shifts after that |
| `meter_day_has_daily_entry(date)` | True when a finished MS or HSD sheet exists |
| `meter_shift_has_readings(date, shift)` | True when that shift already has nozzle rows |
| `require_meter_day_writable(date)` | Raises for a non-admin on a locked day. `require_meter_shift_writable` calls it, then also blocks a supervisor once day closing is saved |
| `dsr_refresh_open_day_closing()` | After a meter-row change, refreshes an open day closing. A certified day is already rejected by `dsr_validate_meter_row` |
| `e20_parse_yes_no(text)` | Yes/no text inside `save_e20_testing_register` |
| `enqueue_drive_pdf_from_invoice()`, `enqueue_drive_pdf_from_letter()` | After an invoice or letter insert, call `enqueue_drive_pdf_archive` |
| `set_app_user_auth_id()` | On `users` email insert or update, copy `auth.users.id` when the emails match |
| `link_app_user_auth_id()` | On a new Auth user, fill `users.auth_user_id` on the matching email if it is still empty |
| `audit_trigger_fn()` | Writes `audit_log` unless `runtime_flags.audit` is `off`. UPDATE rows keep only changed columns; an update that changes nothing but `updated_at` is skipped |
| `sync_meter_shift_cash_ledger_totals(date, shift, employee)` | Rewrites the cached credit and expense totals on `meter_shift_cash` |
| `trg_sync_shift_cash_from_credit_entries()`, `trg_sync_shift_cash_from_expenses()` | After a shift-attributed credit or expense change, call that refresh |

**Retry safety:** money RPCs marked `request_id?` take an optional `p_request_id uuid`. The client sends the same id while a form's values are unchanged (`formRequestId` in `js/utils.js`); a repeat call with that id returns the stored result from `write_requests` instead of writing again. Ids are kept 14 days.

**Dates:** future-date checks compare with `meter_station_today()` (IST). `current_date` on Supabase is UTC, which rejected today's entries between 00:00 and 05:30 IST.
