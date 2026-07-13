# Flows

This document describes the main **user and data flows** in the Petrol Pump application: how features connect and in what order data is typically entered. Use it to understand end-to-end behaviour and the page → data mapping.

> **Documentation hub:** [README.md](README.md)

### Flow overview

| Flow | Section | Key pages / data |
|------|---------|-------------------|
| Auth & roles | §1 | login → users (role) → dashboard; profile avatar; `check_page_access` |
| Dashboard | §1b | snapshot, DSR summary, admin P&amp;L, alerts, tank visuals |
| Daily operations | §2 | dsr_petrol/diesel → credit → expenses → day-closing |
| Credit ledger | §3 | credit_customers, credit_entries, credit_payments |
| DSR & stock | §4 | dsr_petrol, dsr_diesel, dsr_stock view |
| Billing | §5 | products, invoices, save_invoice |
| Invoice documents | §5b | invoice_documents, invoice-documents edge function, Google Drive |
| Reports | §6 | reports.html (admin); DSR, GST, trading/P&amp;L catalog |
| Analysis | §6b | analysis.html (admin); KPIs, charts, insights |
| HR | §7 | staff.html, employees, attendance, salary, expense linkage |
| Admin & config | §8 | pump_settings, settings, audit_log |

---

## 1. Authentication and role-based access

```
User opens app (index.html / login.html)
    → Enters email + password (or uses Forgot password → reset email)
    → Supabase Auth signs in
    → auth.js: fetch role from public.users (by email) — NOT from JWT metadata
    → If no public.users row: role unset → login.html?error=unprovisioned
    → Role cached (AppCache), stored in session
    → Redirect: admin/supervisor → dashboard.html
    → requireAuth({ pageName }) on protected pages → check_page_access RPC
    → Navigation: applyRoleVisibility() — admin sees Staff, Analysis, Reports, Settings
    → Topbar user menu: profile avatar upload (user-avatars bucket), logout
```

**Important:** All data access is enforced by RLS and security-definer RPC guards in the database. A user must exist in both Auth and `public.users`. Hiding links and `check_page_access` are for UX and defense-in-depth.

### `check_page_access` page identifiers

| `pageName` | Allowed roles |
|------------|---------------|
| `settings`, `staff`, `analysis`, `reports` | admin |
| `dashboard`, `dsr`, `day-closing`, `expenses`, `credit`, `credit-overdue`, `sales-daily`, `attendance`, `salary`, `billing`, `invoices` | admin or supervisor |

Legacy page name `credit-overdue` remains in the RPC for bookmark compatibility; the UI lives on `credit.html#outstanding`.

---

## 1b. Dashboard flow

```
Open dashboard.html
    → requireAuth({ pageName: 'dashboard' })
    → Snapshot date picker (default: today)
    → Section nav (pageSections.js hash routing):

    snapshot (all roles)
        → Total sale L/₹, MS/HSD split, open credit (get_open_credit_as_of)
        → Links to Meter Reading / DSR listing

    dsr (all roles)
        → Date range filter
        → Net sale, stock, variation per product (get_dsr_stock_range + mergeDsrStock)
        → Day summary: expenses, credit entries, net cash

    pl (admin only — hidden for supervisor)
        → P&L range filter
        → Buying price alerts for receipt days missing pre-VAT cost
        → Inline ₹/KL entry → update_dsr_buying_price
        → Net sale, expenses, estimated profit

    notifications (all roles)
        → Day-closing reminder (if enabled in alerts)
        → Low stock MS/HSD vs pump_settings thresholds
        → Smart alerts: high credit, high variation
        → Admin: P&L todo banner when buying prices missing

    At a glance (aside rail)
        → MS/HSD selling rates (today's DSR or last known)
        → Animated tank meters (% of pump_settings.config.pumps tank capacity)
```

---

## 2. Daily operations flow (typical day)

A typical daily sequence:

```
1. Meter Reading (dsr.html)
   → Upsert dsr_petrol and/or dsr_diesel for today
   → Nozzle readings, total_sales, testing, dip/stock, receipts, rates
   → dsr_stock view recalculates opening/closing/variation automatically

2. Credit (credit.html)
   → Add credit sale → credit_entries (transaction_date = today)
   → Record payment → record_credit_payment (FIFO allocation)

3. Expenses (expenses.html)
   → Add expenses for the day → expenses

4. Day closing (day-closing.html)
   → get_day_closing_breakdown(date) — live components or saved snapshot
   → Enter night_cash, phone_pay, remarks
   → save_day_closing(...) → short_today, snapshot, closing_reference (DC-YYYY-NNNNN)
   → short_today becomes next day’s short_previous
   → Supervisor: after save, form is read-only (snapshot frozen)
   → Admin: can_overwrite=true → re-save with fresh live components; recascades short forward
   → Admin register tab: delete_day_closing (latest date only) to reopen a day
```

**Data dependencies:**

- **Total sale:** From `dsr_petrol` / `dsr_diesel` (net litres × rate).
- **Collection:** Sum of `credit_payments.amount` for that date.
- **Credit today:** Sum of `credit_entries` for `transaction_date` plus legacy `credit_customers` where applicable.
- **Expenses today:** Sum of `expenses.amount` for that date.
- **Short previous:** Previous `day_closing.short_today`.

---

## 3. Credit flow (ledger and settlement)

```
Create / identify customer
   → credit_customers
   → add_credit_entry(...) or insert credit_entries
   → Trigger updates credit_customers.amount_due

Customer detail (credit.html#…)
   → Balance hero + period filter (this month, last 30 days, custom)
   → get_customer_credit_detail_as_of(name, date) for summary and line lists

Receive payment
   → record_credit_payment(customer_id, date, amount, note, payment_mode)
   → FIFO allocation to credit_entries; insert credit_payments

Admin corrections (admin only)
   → delete_credit_entry(id) — only if amount_settled = 0
   → delete_credit_payment(id) — re-allocates remaining payments FIFO
```

- **Ledger view:** `get_credit_ledger_aggregated()`.
- **Overdue / outstanding:** `get_outstanding_credit_list_as_of(date)` on `credit.html#outstanding`.
- **Customer detail:** In-page on `credit.html` (hash routes) — not a separate page. Legacy `credit-customer.html` redirects with query/hash preserved.
- **Legacy URL:** `credit-overdue.html` redirects to `credit.html#outstanding`.

---

## 4. DSR and stock flow

- **Meter form** → `dsr_petrol` or `dsr_diesel` (one row per date per product).
- **Stock reconciliation** → read-only `dsr_stock` view (or `get_dsr_stock_range` for date ranges). Dip stock comes from the `stock` column on the meter row.
- **Union reads** → `dsr` view when code queries “all products”.
- **Dashboard:** Snapshot date picker; **At a glance** rail shows MS/HSD rates and tank visuals using `pump_settings.config.reports.tanks` capacities.

See [DSR_TABLES.md](DSR_TABLES.md).

---

## 5. Billing flow (lube / accessories)

```
Product catalog (admin: Settings → Billing → Products)
   → products: name, HSN, unit, rate, gst_percent, is_active

Create invoice (billing.html)
   → Line items with GST slabs (from AppConfig.GST_SLABS)
   → save_invoice(date, type, party, …, items jsonb)
   → invoices + invoice_items; invoice_number from sequence + prefix in pump_settings.billing
   → Print layout: css/invoice-print.css

Reports
   → GST sales summary/detail reads invoices when billing.includeInGstReports is true
   → Fuel outward treated as nil-rated in GST reports
```

Supervisors can create invoices and view history; only admins manage the product catalog (RLS).

---

## 5b. Supplier invoice documents (invoices.html)

**Not the same as billing** — this flow stores **inward** supplier/purchase invoices (PDFs, scans), not outward sales memos.

```
Admin one-time setup (Settings → Integrations + Supabase secrets + edge function deploy)
   → See docs/INVOICE_DOCUMENTS.md for full steps

Upload (invoices.html → Upload tab)
   → multipart POST to edge function invoice-documents
   → file → Google Drive (Root/YYYY/MM); metadata → invoice_documents

Library (invoices.html → Library tab)
   → SELECT invoice_documents (date filter)
   → View: drive_web_view_link | Download/Delete: edge function actions
```

**Roles:** Admin and supervisor can upload, list, view, download. **Delete** (Drive file + DB row) is **admin only**.

**Setup guide:** [Invoice documents](INVOICE_DOCUMENTS.md).

---

## 6. Reports flow (admin)

```
Reports (reports.html)
   → requireAuth({ pageName: 'reports' })
   → Section nav: About | Generate report
   → Date range filter (shared dateRangeFilter.js)
   → Report catalog (REPORT_CATALOG in reports.js):

       Operations
         → dsr — Tank-wise DSR

       GST — Sales
         → gst-sales-summary — GST Sales Summary
         → gst-sales-detail — GST Sales Detail

       GST — Purchases
         → gst-purchase-summary — GST Purchase Summary
         → gst-purchase-detail — GST Purchase Detail

       Accounts
         → trading — Trading account
         → pl — Profit & Loss

   → Data from dsr_*, invoices, expenses, pump_settings (purchase VAT %, delivery)
   → Print-friendly layout (css/reports-print.css; no-print chrome)
```

---

## 6b. Analysis flow (admin)

```
Analysis (analysis.html)
   → requireAuth({ pageName: 'analysis' })
   → Section nav: setup | metrics | charts | insights
   → setup: date range picker
   → metrics: KPI cards (sales, expenses, profit, fuel mix)
   → charts: Chart.js (CDN) — daily sales, profit trend, fuel/revenue mix pies
   → insights: text summaries derived from the selected period
   → Data via DsrQueries + expenses (same sources as dashboard/reports, different presentation)
```

**Note:** Analysis is a **business intelligence dashboard** (KPIs + charts). Printable P&amp;L register is on **Reports** (`pl`). Quick buying-price entry and live P&amp;L is on **Dashboard → P&amp;L** section.

## 7. HR flow (staff, attendance, salary)

### 7.1 Employee master (admin — staff.html)

```
Staff (staff.html) — admin only
   → requireAuth({ pageName: 'staff', allowedRoles: ['admin'] })
   → Roster sidebar + profile panel
   → CRUD on employees table (direct Supabase client — admin RLS)
   → Fields: name, job title, DOB, ID validity dates, photo, blood group,
             phone, Aadhaar, PAN, PF/UAN, address
   → Photo upload → staff-photos bucket → set_employee_photo RPC
   → BPCL-style ID card preview + print (requires photo, blood group, DOB)
   → PF contribution amount edited in Settings → Staff salaries (not on staff form)
   → Deep link: staff.html#{employee_uuid}
   → Soft-delete: is_active=false when salary/attendance FK blocks hard delete
```

Supervisors **cannot** open `staff.html` (nav hidden + `check_page_access('staff')`). They load employee names via `list_employees_roster()` or `list_employees_salary()` RPCs on attendance/salary pages.

### 7.2 Attendance

```
Attendance (attendance.html)
   → list_employees_roster() for employee picker
   → save_employee_attendance_batch(date, jsonb) or per-row upsert
   → status: present | absent | half_day | leave
   → optional shift (from pump_settings.config.shifts), check_in/out, note
   → History tab with date filter
```

### 7.3 Salary

```
Settings → Staff salaries (admin)
   → Set monthly_salary and fixed pf_contribution (₹/month) per employee

Salary (salary.html)
   → list_employees_salary() for employee data + slips
   → Select salary_month (pay period — first of month) separate from payment date
   → Record installment → salary_payments (date = when paid, salary_month = period)
   → Auto-creates linked expenses row (category Salary, salary_payment_id FK)
   → Monthly summary: paid vs monthly_salary per employee for selected month
   → Printable salary slips (css/salary-slip-print.css) with PF, establishment code
   → Admin can delete payment → removes linked expense
```

---

## 8. Admin-only flows

### Settings (settings.html)

Side nav sections (hash routing via `pageSections.js`):

| Section | Configures |
|---------|------------|
| `station` | Display/legal name, tagline, address, GSTIN, license, **PF establishment code**, contacts |
| `billing` | Invoice prefix, default party, fuel GST %, MS/HSD purchase VAT %, delivery ₹/KL, tax-inclusive flag, **include billing in GST reports**, receipt history start, **product master CRUD** |
| `pumps` | Petrol/diesel pump count, nozzles, tank labels/capacities |
| `users` | Email, display name, role, password → `upsert_staff` |
| `salaries` | Per-employee monthly salary + **fixed PF contribution (₹/month)** |
| `attendance` | Morning/afternoon shift names and times |
| `alerts` | Low stock MS/HSD, high credit, high variation, day-closing reminder |
| `expenses` | Expense category add/delete |
| `integrations` | Google Drive enable + root folder ID (see [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md)) |
| `access` | Read-only list of provisioned `users` |

Persists to `pump_settings.config` (and direct table writes for `users`, `employees`, `expense_categories`, `products`).

**Note:** Employee personal profile (photo, blood group, ID card) is on **`staff.html`**, not Settings.

### Other admin-only pages

- **Staff (`staff.html`):** Roster, ID cards — see §7.1.
- **Analysis (`analysis.html`):** BI dashboard — see §6b.
- **Reports (`reports.html`):** Printable registers — see §6.
- **Dashboard P&amp;L section:** Inline buying price — see §1b.
- **Audit log:** Admins read `audit_log`; writes via triggers only.

---

## 9. Page → data mapping (quick reference)

| Page | Primary tables / RPCs |
|------|------------------------|
| Login | Supabase Auth, public.users (role), forgot password |
| Dashboard | dsr_petrol, dsr_diesel, dsr_stock, day_closing, expenses, credit_entries, pump_settings, get_dsr_stock_range, get_open_credit_as_of, get_day_closing_breakdown, update_dsr_buying_price |
| Meter Reading (DSR) | dsr_petrol, dsr_diesel |
| DSR listing (sales-daily) | dsr view, dsr_stock, get_dsr_stock_range |
| Credit | credit_*, add_credit_entry, record_credit_payment, get_customer_credit_detail_as_of, delete_credit_entry, delete_credit_payment |
| Outstanding | get_outstanding_credit_list_as_of (credit.html#outstanding) |
| Billing | products, invoices, save_invoice |
| Invoice documents | invoice_documents, edge function invoice-documents, pump_settings.integrations.googleDrive |
| Expenses | expenses, expense_categories |
| Day closing | day_closing, get_day_closing_breakdown, save_day_closing, delete_day_closing |
| Staff | employees, set_employee_photo, staff-photos bucket (admin) |
| Attendance | employee_attendance, list_employees_roster, save_employee_attendance_batch |
| Salary | salary_payments, expenses (salary_payment_id), list_employees_salary, employees |
| Reports | dsr_*, invoices, expenses, pump_settings (admin) |
| Analysis | dsr_*, expenses via DsrQueries (admin) |
| Settings | pump_settings, users, employees, products, expense_categories, upsert_staff, delete_staff (admin) |

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment |
| [Data Tables](DATA_TABLES.md) | Table reference and RLS |
| [DSR Tables](DSR_TABLES.md) | DSR tables and computed stock |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
| [Invoice documents](INVOICE_DOCUMENTS.md) | Google Drive setup, edge function, troubleshooting |
