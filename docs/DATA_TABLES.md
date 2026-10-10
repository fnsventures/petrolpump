# Data tables

Tables, views, RLS, and RPCs. The canonical schema is `supabase/schema.sql`. This page is the reading copy, including the meter and stock model.

Index: [README.md](README.md). How pages write these tables: [FLOWS.md](FLOWS.md).

## Table Index

| Object | Purpose |
|--------|---------|
| [audit_log](#audit_log) | Audit trail for sensitive operations (admin-only read) |
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
| [reminders](#reminders) | Station tasks: dated reminders + undated todos |
| [day_closing](#day_closing) | Daily closing statement (night cash, phone pay, short, snapshot) |
| [night_cash_collections](#night_cash_collections) | Register of physical night-cash pickups linked to day_closing rows |
| [write_requests](#write_requests) | Results of money RPCs keyed by client request id (retry safety) |

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

**Exceptions:**

- **users:** SELECT provisioned staff; INSERT admin, or first-admin bootstrap (own email, role `admin` only); UPDATE/DELETE admin. Prefer `upsert_staff` / `delete_staff`. Avatar URL updated via `update_my_avatar`.
- **expense_categories, products, employees:** SELECT admin only on `employees` (supervisors use `list_employees_roster` / `list_employees_salary` RPCs); mutations admin only on all three.
- **invoices, invoice_items:** SELECT provisioned staff; INSERT/UPDATE denied on client — header and lines are created only inside `save_invoice` RPC. DELETE admin only.
- **salary_payments:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `record_salary_payment` / `delete_salary_payment`.
- **credit_entries:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `add_credit_entry`. DELETE admin only.
- **credit_payments:** SELECT provisioned staff; INSERT/UPDATE denied on client — use `record_credit_payment` / `batch_record_credit_settlements`. DELETE admin only.
- **day_closing:** SELECT provisioned staff; INSERT/UPDATE/DELETE denied on client — use `save_day_closing`, `set_day_closing_certified`, `collect_night_cash`, and `delete_day_closing`.
- **expenses:** INSERT/UPDATE cannot set `salary_payment_id` or category `salary` (those rows come from `record_salary_payment`); admins cannot delete a salary-linked expense directly.
- **write_requests:** no client access; written by money RPCs.
- **audit_log:** SELECT admin only; writes via triggers only.
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
| old_data | jsonb | Snapshot before (UPDATE/DELETE) |
| new_data | jsonb | Snapshot after (INSERT/UPDATE) |
| performed_by | uuid | auth.users.id |
| performed_by_email | text | Email at time of action |
| performed_at | timestamptz | When the action occurred |

**RLS:** SELECT only for admin; no direct INSERT/UPDATE/DELETE (only via triggers).

**Populated by:** Audit triggers on: users, dsr_petrol, dsr_diesel, meter_shift_readings, meter_shift_cash (insert, delete, and updates of cash, phone pay, remarks, date, shift, or employee — not cache-only refreshes of `credit_amount` / `expense_amount`), expenses, credit_customers, credit_entries, employees, salary_payments, salary_lop_exclusions, employee_attendance, credit_payments, day_closing, invoices.

**Retention:** Production rows older than 6 months are deleted by `purge_audit_log_batch` (maintenance script only, not granted to app roles) after the monthly Drive backup. Staging sets `runtime_flags.audit = off`, so the trigger writes nothing there, and sync empties the table. See [STORAGE_RETENTION.md](STORAGE_RETENTION.md).

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

**RPCs:** `get_meter_shift_readings`, `save_meter_shift_readings`, `delete_meter_shift_readings` (admin), `get_meter_shift_prior_closings`, `get_shift_aggregated_daily_meters`, `apply_shift_aggregate_to_dsr`, `sync_shift_meters_from_dsr`, `meter_shift_lock_info`, `require_meter_shift_writable`, `get_meter_sales_breakdown`.

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

**Purpose:** Backward-compatible **SELECT-only** union of `dsr_petrol` and `dsr_diesel` with a synthetic `product` column (`petrol` \| `diesel`). Writes must go to the underlying tables. This view does not include `buying_price_per_litre`, so meter, stock, and day-closing reads work for supervisors. Profit and purchase cost use `dsr_cost`, which returns rows only when `is_admin()`.

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
| amount | numeric | Amount (₹) |
| salary_payment_id | uuid | Optional FK → salary_payments.id (set by `record_salary_payment`; unique when set; ON DELETE CASCADE) |
| employee_id | uuid | Optional staff whose till paid this expense during a shift |
| shift | text | `morning` \| `afternoon` when entered from the shift register; otherwise null |
| client_request_id | uuid | Expenses form request id; unique when set so a retried insert cannot duplicate |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Salary linkage:** `record_salary_payment` inserts the payment and its `expenses` row (category `salary`, `salary_payment_id` set) in one transaction. Deleting the payment removes the linked expense through the cascading foreign key; `delete_salary_payment` also removes an exact-match unlinked expense left by payments recorded before the link existed.

**Indexes:** `(date desc)`, `(created_at desc)`, `(category)`, partial `(date, shift, employee_id)`, partial unique on `salary_payment_id` and on `client_request_id`.

**RLS:** SELECT as the default pattern. INSERT/UPDATE cannot set `salary_payment_id` or category `salary` (those rows come from `record_salary_payment`). Admins cannot delete a salary-linked expense; a supervisor can delete their own shift expense. `ledger_guard_certified_day` rejects a write whose date is certified, then refreshes an uncertified saved closing. See [RLS exceptions](#rls-conventions).

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

**RLS:** SELECT/INSERT/UPDATE for supervisor or admin; DELETE admin only.

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

**Writes:** `record_salary_payment(employee_id, date, salary_month, amount, note?, allow_overpay?, request_id?)` — locks the employee + month, recomputes take-home on the server (`salary_month_payable`: salary + over duty − loss of pay − PF, same rules as `js/payrollRules.js`) and raises hint `salary_overpay` when the amount exceeds what remains, unless `allow_overpay`. `delete_salary_payment(id)` (admin) removes the payment and its expense.

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

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

---

## credit_customers

**Purpose:** Credit ledger: customer master. `amount_due` and `prepaid_balance` are kept in sync with entries/payments by RPC/triggers. Net balance = `amount_due − prepaid_balance`. `date` is used for legacy/day-closing “credit today” when there are no entries yet.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| customer_name | text | Customer name |
| vehicle_no | text | Optional |
| mobile | text | Optional contact number |
| address | text | Optional address |
| amount_due | numeric | Current outstanding from unsettled sales (synced) |
| prepaid_balance | numeric | Advance from overpayment (≥ 0); net = amount_due − prepaid |
| date | date | Used for day-closing credit_today legacy |
| last_payment | date | Last payment date |
| notes | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** Default operational pattern. Supervisors and admins may update contact fields. `authenticated` has no insert or update on `amount_due` or `prepaid_balance`; `sync_credit_customer_balances` (security definer) writes them.

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
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Constraint:** `amount_settled <= amount`.

**RLS:** SELECT provisioned staff; INSERT and UPDATE denied on client (`authenticated` has no insert or update grant). `add_credit_entry` writes the sale, including `amount`, and applies prepaid. Payment RPCs write `amount_settled`. DELETE admin only.

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
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT provisioned staff; INSERT and UPDATE denied on client — same pattern as `salary_payments`. `record_credit_payment` and `batch_record_credit_settlements` insert the row. DELETE admin only.

**Note:** Payment allocation to entries (LIFO — newest open sale on or before the payment date first) is done in RPC `record_credit_payment` (and `batch_record_credit_settlements` for multi-customer). Both lock the customer row (`for update`) before allocating. Overpayment increases `prepaid_balance`. A certified payment date is rejected. A direct insert or update is denied, so it cannot skip the customer lock, LIFO allocation, prepaid, or the future-date check.
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

**UI:** `reminders.html` (Tasks: Credit collection + Todo) · Dashboard landing popup · Credit customer “Schedule call” (auto title `Call <name>`). Open tasks support one-tap **+3 days**, **More…** (quick choices + custom date), and Call/WhatsApp. Duplicate open credit calls are blocked at schedule time.

Migration: `supabase/migrations/20260801120000_reminders.sql`.

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
| `upsert_staff(email, role, display_name, password?)` | Create/update app user | bootstrap + admin |
| `delete_staff(email)` | Remove app user | admin |
| `update_my_avatar(url)` | Set operator profile photo URL | own row |
| `get_dsr_stock_range(start, end)` | Stock reconciliation for date range | — |
| `update_dsr_buying_price(id, value)` | Set pre-VAT buying price on DSR row (Meter Reading → Purchase cost) | — |
| `generate_invoice_number()` | Next billing invoice number. Provisioned staff only | — |
| `meter_station_today()` | Station calendar date (IST); use instead of `current_date` (UTC) | — |
| `save_invoice(..., request_id?)` | Atomic invoice + line items; rejects qty/rate ≤ 0, invalid GST, discount < 0 or > subtotal | — |
| `list_employees_roster()` | Active employees without PII | — |
| `list_employees_salary()` | Active employees with HR fields | — |
| `set_employee_photo(id, url)` | Update employee photo URL | admin |
| `save_employee_attendance_batch(date, jsonb)` | Upsert attendance rows | — |
| `get_day_closing_breakdown(date)` | Closing components + overwrite / collected / certified flags | — |
| `save_day_closing(date, night_cash, phone_pay, remarks?)` | Save/overwrite closing (rejects if certified) | overwrite: until certified; after collected, admin only |
| `set_day_closing_certified(date, certified)` | Certify (lock everyone) or revoke | admin |
| `delete_day_closing(id)` | Remove latest uncertified closing | admin |
| `compute_day_closing_components(date)` | Live component calculation | internal use |
| `get_night_cash_available()` | Uncollected night cash totals | — |
| `preview_night_cash_collection(from, to)` | Preview pickup for a date range | — |
| `collect_night_cash(from, to, remarks?)` | Record pickup; link closings | — |
| `add_credit_entry(..., request_id?)` | New credit sale; locks the customer row; rejects a certified day | — |
| `record_credit_payment(..., request_id?)` | Payment + LIFO; locks the customer row; prepaid on overpay; rejects a certified day | — |
| `batch_record_credit_settlements(..., request_id?)` | Multi-customer payment in one transaction; locks those rows; rejects a certified day | — |
| `add_shift_expense(..., request_id?)` | Shift register expense; rejects a certified day | — |
| `record_salary_payment(...)` | Salary payment + linked expense; server overpay check; rejects a certified payment date | — |
| `delete_salary_payment(id)` | Payment + linked expense; rejects a certified payment date | admin |
| `delete_credit_entry(id)` | Remove unsettled sale | admin |
| `delete_credit_payment(id)` | Remove payment + reallocate | admin |
| `get_credit_ledger_aggregated()` | Ledger summary list | — |
| `get_open_credit_as_of(date)` | Total open credit | — |
| `get_outstanding_credit_list_as_of(date)` | Overdue/outstanding customers | — |
| `get_customer_credit_detail_as_of(name, date)` | Customer breakdown as of date | — |
| `get_customer_credit_summary_as_of(name, date)` | Summary totals | — |
| `get_customer_credit_breakdown_as_of(name, date)` | Line-level breakdown | — |

Internal (not granted to `authenticated`): `recascade_day_closing_short_from`, `reallocate_credit_settlements`, balance sync helpers, audit trigger functions, `purge_audit_log_batch` (deletes `audit_log` rows older than 6 months; one batch per call), `salary_month_payable`, `write_request_replay` / `write_request_store`.

**Retry safety:** money RPCs marked `request_id?` take an optional `p_request_id uuid`. The client sends the same id while a form's values are unchanged (`formRequestId` in `js/utils.js`); a repeat call with that id returns the stored result from `write_requests` instead of writing again. Ids are kept 14 days.

**Dates:** future-date checks compare with `meter_station_today()` (IST). `current_date` on Supabase is UTC, which rejected today's entries between 00:00 and 05:30 IST.
