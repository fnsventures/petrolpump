# Data Tables

Reference for all **database tables** used by the Petrol Pump application: purpose, key columns, relationships, and Row Level Security (RLS). Use this for schema work, RPC design, or understanding the data model. The canonical schema is `supabase/schema.sql`; this doc is a summary.

> **Documentation hub:** [README.md](README.md)

---

## Table Index

| Object | Purpose |
|--------|---------|
| [audit_log](#audit_log) | Audit trail for sensitive operations (admin-only read) |
| [users](#users) | App users (login / operator roles) |
| [dsr_petrol](#dsr_petrol) | MS meter readings — one row per date |
| [dsr_diesel](#dsr_diesel) | HSD meter readings — one row per date |
| [dsr](#dsr-view) | **View:** union of petrol + diesel (SELECT only) |
| [dsr_stock](#dsr_stock-view) | **View:** computed stock reconciliation |
| [products](#products) | Product master for lube/accessory billing |
| [invoices](#invoices) | Sales invoices / cash memos |
| [invoice_items](#invoice_items) | Line items per invoice |
| [invoice_documents](#invoice_documents) | Supplier/purchase invoice files (metadata; files in Google Drive) |
| [pump_settings](#pump_settings) | Single-row JSON station config |
| [expenses](#expenses) | Daily operating expenses |
| [expense_categories](#expense_categories) | User-managed expense categories |
| [employees](#employees) | Pump employees (for salary and attendance) |
| [salary_payments](#salary_payments) | Salary installments per employee |
| [employee_attendance](#employee_attendance) | Daily attendance (present/absent/half_day/leave) |
| [credit_customers](#credit_customers) | Credit ledger: customer master, amount_due, prepaid_balance |
| [credit_entries](#credit_entries) | One row per credit sale (transaction date = DSR date) |
| [credit_payments](#credit_payments) | Payments received from credit customers |
| [day_closing](#day_closing) | Daily closing statement (night cash, phone pay, short, snapshot) |
| [night_cash_collections](#night_cash_collections) | Register of physical night-cash pickups linked to day_closing rows |

For the DSR / stock model (tables vs views), see [DSR_TABLES.md](DSR_TABLES.md).

**Storage buckets** (Supabase Storage, not PostgreSQL tables): `user-avatars` (operator profile photos), `staff-photos` (employee ID card photos). See [Architecture §6.4](ARCHITECTURE.md#64-supabase-storage-buckets).

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
- **invoice_items:** SELECT provisioned staff; INSERT/UPDATE/DELETE denied on client — lines created only inside `save_invoice` RPC.
- **audit_log:** SELECT admin only; writes via triggers only.
- **pump_settings:** SELECT provisioned staff; INSERT/UPDATE admin only.

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

**Populated by:** Audit triggers on: users, dsr_petrol, dsr_diesel, expenses, credit_customers, employees, salary_payments, employee_attendance, credit_payments, day_closing, invoices.

---

## users

**Purpose:** App users who can log in. Roles: `admin`, `supervisor`. Display name shown in UI.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| email | text | Unique, lowercase for matching |
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
| buying_price_per_litre | numeric | Admin; cost for P&amp;L |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Index:** `(date desc)`.

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

---

## dsr_diesel

**Purpose:** HSD (diesel) meter readings — same column layout as `dsr_petrol`, default `tank_capacity` typically `20KL`. One row per date.

**RLS:** Same as `dsr_petrol`.

**RPC:** `update_dsr_buying_price(uuid, numeric)` updates `buying_price_per_litre` on whichever table contains the row id.

---

## dsr (view)

**Purpose:** Backward-compatible **SELECT-only** union of `dsr_petrol` and `dsr_diesel` with a synthetic `product` column (`petrol` \| `diesel`). Writes must go to the underlying tables.

See [DSR_TABLES.md](DSR_TABLES.md).

---

## dsr_stock (view)

**Purpose:** **Computed** stock reconciliation per (date, product): `opening_stock` (LAG of prior dip), `receipts`, `total_stock`, `net_sale`, `closing_stock`, `dip_stock`, `variation`. Not a physical table — derived from meter rows.

**RPC:** `get_dsr_stock_range(start_date, end_date)` — same logic scoped to a date range (preferred for reports).

See [DSR_TABLES.md](DSR_TABLES.md).

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

**Purpose:** **Supplier / purchase invoice** file metadata. Binary files live in **Google Drive** (year/month folders under a configured root). Not related to billing table `invoices`.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_date | date | Supplier invoice date |
| year | smallint | Folder year (from date) |
| month | smallint | Folder month 1–12 |
| title | text | Optional description |
| vendor | text | Supplier name |
| amount | numeric(14,2) | Optional amount |
| file_name | text | Stored filename |
| mime_type | text | e.g. `application/pdf` |
| file_size | bigint | Size in bytes |
| drive_file_id | text | Google Drive file ID |
| drive_folder_id | text | Month folder ID in Drive |
| drive_web_view_link | text | Optional view URL (anyone-with-link if shared on upload) |
| notes | text | Optional |
| uploaded_by | uuid | FK → auth.users |
| created_at | timestamptz | Upload time |

**RLS:** SELECT and INSERT for `is_supervisor_or_admin()`; DELETE for `is_admin()` only. Rows are inserted by edge function `invoice-documents` via service role; client reads via SELECT policy.

**Page:** `invoices.html` (Finance → Invoices). **Setup:** [Invoice documents guide](INVOICE_DOCUMENTS.md).

---

## pump_settings

**Purpose:** **Single-row** JSON configuration (`id = 1`): station branding, billing defaults, pump/tank layout, report tanks, purchase VAT %, alerts, attendance shifts, **integrations (Google Drive for invoice documents)**. Seeded from `js/appConfig.js` defaults when empty.

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
| enabled | boolean | When true, invoice uploads allowed |
| rootFolderId | string | Google Drive folder ID (URL `…/folders/ID`) |

**Other notable config keys** (see `js/appConfig.js` defaults):

| Path | Purpose |
|------|---------|
| `station.pfEstablishmentCode` | EPFO establishment code on salary slips |
| `billing.includeInGstReports` | Include lube invoices in GST sales reports |
| `reports.petrolPurchaseVatPct` / `dieselPurchaseVatPct` | Fuel purchase VAT/LST % for P&amp;L and purchase reports |
| `reports.purchaseDeliveryPerKl` | Delivery charge ₹/KL on inward fuel |
| `reports.purchaseTaxInclusive` | Whether buying price is tax-inclusive |
| `alerts.*` | Low stock, high credit, high variation, day-closing reminder thresholds |
| `shifts.*` | Morning/afternoon shift names and times for attendance |

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
| salary_payment_id | uuid | Optional FK → salary_payments.id (auto-created when recording salary; unique when set) |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Salary linkage:** When a salary payment is recorded on `salary.html`, the client inserts a matching `expenses` row (category typically “Salary”) with `salary_payment_id` set. Deleting the salary payment removes the linked expense.

**Indexes:** `(date desc)`, `(created_at desc)`.

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

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
| photo_url | text | Optional; public URL in `staff-photos` bucket (required for ID card print) |
| date_of_birth | date | Optional; shown on staff ID card |
| id_valid_from | date | ID card validity start (back of card) |
| id_valid_to | date | ID card validity end (back of card) |
| display_order | smallint | Order in lists |
| is_active | boolean | Active flag (soft-delete sets false when FK blocks hard delete) |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** SELECT/INSERT/UPDATE/DELETE **admin only**. Supervisors never query this table directly — they use RPCs `list_employees_roster()` (name, role, salary, order only) or `list_employees_salary()` (includes PII for slips).

**RPCs:** `set_employee_photo(employee_id, photo_url)` — admin updates `photo_url` after Storage upload.

**Page:** `staff.html` (admin) — roster, profile, photo upload, BPCL-style ID card preview/print (`css/staff-id-print.css`). Deep link: `staff.html#{employee_uuid}`.

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

**RLS:** Default operational pattern; DELETE admin only.

**Client:** `salary.html` groups payments by `salary_month`, shows monthly summary vs `employees.monthly_salary`, prints salary slips (`css/salary-slip-print.css`), and creates linked `expenses` row on payment.

---

## employee_attendance

**Purpose:** Daily attendance per employee: status and optional check-in/out.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| employee_id | uuid | FK → employees.id |
| date | date | Attendance date |
| status | text | `present` \| `absent` \| `half_day` \| `leave` |
| shift | text | Optional shift label |
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

**RLS:** Default operational pattern; UPDATE also allowed for supervisor or admin (contact info; balances updated by payment RPC/triggers).

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
| amount_settled | numeric | Amount already paid (FIFO allocation) |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**Constraint:** `amount_settled <= amount`.

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

**Trigger:** Updates `credit_customers.amount_due` on insert/update/delete.

---

## credit_payments

**Purpose:** Payments received from credit customers. Sum by date = collection for day-closing.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| credit_customer_id | uuid | FK → credit_customers.id |
| date | date | Settlement date |
| amount | numeric | Amount (₹) |
| note | text | Optional |
| payment_mode | text | `Cash` \| `UPI` \| `Bank` |
| created_by | uuid | auth.users.id |
| created_at | timestamptz | Created at |

**RLS:** Default operational pattern (see [RLS conventions](#rls-conventions)).

**Note:** Payment allocation to entries (FIFO) is done in RPC `record_credit_payment` (and `batch_record_credit_settlements` for multi-customer). Overpayment increases `prepaid_balance`.
---

## day_closing

**Purpose:** Daily closing statement: one row per date. Stores night_cash, phone_pay, computed short_today, and full snapshot (total_sale, collection, short_previous, credit_today, expenses_today) for accounting. `short_previous` comes from previous day’s `short_today`.

**Formula:**  
`short_today = (total_sale + collection + short_previous) - (night_cash + phone_pay + credit_today + expenses_today)`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| date | date | Unique closing date |
| night_cash | numeric | Hard cash at day end |
| phone_pay | numeric | UPI/PhonePe |
| short_today | numeric | Computed short (stored for next day’s short_previous) |
| total_sale | numeric | Snapshot at closing |
| collection | numeric | Snapshot at closing |
| short_previous | numeric | Carried from previous day |
| credit_today | numeric | New credit that day (snapshot) |
| expenses_today | numeric | Expenses that day (snapshot) |
| closing_reference | text | Unique ref (e.g. DC-2026-00001) |
| night_cash_collection_id | uuid | FK → night_cash_collections when cash was picked up |
| remarks | text | Optional |
| created_by | uuid | auth.users.id |
| created_at, updated_at | timestamptz | Timestamps |

**RLS:** Default operational pattern, with extra rules when `night_cash_collection_id` is set: supervisors cannot update/delete collected closings; admins still can.

**RPCs:**

| RPC | Behaviour |
|-----|-----------|
| `get_day_closing_breakdown(date)` | Components + `already_saved`, `can_overwrite`, `night_cash_collected` |
| `save_day_closing(date, night_cash, phone_pay, remarks?)` | Insert or admin overwrite; recascades short |
| `delete_day_closing(id)` | Admin only, **latest date only** |
| `get_night_cash_available()` | Uncollected closings ready for pickup |
| `preview_night_cash_collection(from, to)` | Preview amounts before collecting |
| `collect_night_cash(from, to, remarks?)` | Create register row and link closings |

`recascade_day_closing_short_from` is internal (not callable by clients).

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

## Entity Relationship (Simplified)

```
users (app login)
  └── created_by on: dsr_petrol, dsr_diesel, expenses, credit_*, employees,
                    salary_payments, employee_attendance, day_closing, invoices

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
| `get_user_role()` | Resolve role from JWT email → `users` | — |
| `is_admin()`, `is_supervisor_or_admin()` | Policy helpers | — |
| `require_staff_access()` | Raises if not provisioned staff | internal |
| `check_page_access(page)` | Returns `{ allowed, role, page }` | — |
| `upsert_staff(email, role, display_name, password?)` | Create/update app user | bootstrap + admin |
| `delete_staff(email)` | Remove app user | admin |
| `update_my_avatar(url)` | Set operator profile photo URL | own row |
| `get_dsr_stock_range(start, end)` | Stock reconciliation for date range | — |
| `update_dsr_buying_price(id, value)` | Set pre-VAT buying price on DSR row | — |
| `generate_invoice_number()` | Next billing invoice number | — |
| `save_invoice(...)` | Atomic invoice + line items | — |
| `list_employees_roster()` | Active employees without PII | — |
| `list_employees_salary()` | Active employees with HR fields | — |
| `set_employee_photo(id, url)` | Update employee photo URL | admin |
| `save_employee_attendance_batch(date, jsonb)` | Upsert attendance rows | — |
| `get_day_closing_breakdown(date)` | Closing components + overwrite / collected flags | — |
| `save_day_closing(date, night_cash, phone_pay, remarks?)` | Save/overwrite closing | overwrite: admin (rules apply if collected) |
| `delete_day_closing(id)` | Remove latest closing | admin |
| `compute_day_closing_components(date)` | Live component calculation | internal use |
| `get_night_cash_available()` | Uncollected night cash totals | — |
| `preview_night_cash_collection(from, to)` | Preview pickup for a date range | — |
| `collect_night_cash(from, to, remarks?)` | Record pickup; link closings | — |
| `add_credit_entry(...)` | New credit sale | — |
| `record_credit_payment(...)` | Payment + FIFO; prepaid on overpay | — |
| `batch_record_credit_settlements(...)` | Multi-customer payment in one transaction | — |
| `delete_credit_entry(id)` | Remove unsettled sale | admin |
| `delete_credit_payment(id)` | Remove payment + reallocate | admin |
| `get_credit_ledger_aggregated()` | Ledger summary list | — |
| `get_open_credit_as_of(date)` | Total open credit | — |
| `get_outstanding_credit_list_as_of(date)` | Overdue/outstanding customers | — |
| `get_customer_credit_detail_as_of(name, date)` | Customer breakdown as of date | — |
| `get_customer_credit_summary_as_of(name, date)` | Summary totals | — |
| `get_customer_credit_breakdown_as_of(name, date)` | Line-level breakdown | — |

Internal (not granted to `authenticated`): `recascade_day_closing_short_from`, `reallocate_credit_settlements`, balance sync helpers, audit trigger functions.

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment |
| [Flows](FLOWS.md) | User and data flows; page → data mapping |
| [DSR Tables](DSR_TABLES.md) | DSR vs dsr_stock in detail |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
| [Invoice documents](INVOICE_DOCUMENTS.md) | Google Drive setup, edge function, troubleshooting |
| [Backup](BACKUP.md) | Production database backup to Google Drive |
| [Documentation hub](README.md) | Index of all guides |
