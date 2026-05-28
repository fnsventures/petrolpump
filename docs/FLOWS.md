# Flows

This document describes the main **user and data flows** in the Petrol Pump application: how features connect and in what order data is typically entered. Use it to understand end-to-end behaviour and the page → data mapping.

### Flow overview

| Flow | Section | Key pages / data |
|------|---------|-------------------|
| Auth & roles | §1 | login → users (role) → dashboard; `check_page_access` |
| Daily operations | §2 | dsr_petrol/diesel → credit → expenses → day-closing |
| Credit ledger | §3 | credit_customers, credit_entries, credit_payments |
| DSR & stock | §4 | dsr_petrol, dsr_diesel, dsr_stock view |
| Billing | §5 | products, invoices, save_invoice |
| Reports | §6 | reports.html (admin); DSR, GST, trading/P&L |
| HR | §7 | employees, attendance, salary |
| Admin & config | §8 | pump_settings, settings, analysis, audit_log |

---

## 1. Authentication and role-based access

```
User opens app (index.html / login.html)
    → Enters email + password
    → Supabase Auth signs in
    → auth.js: fetch role from public.users (by email)
    → Role cached (AppCache), stored in session
    → Redirect: admin/supervisor → dashboard.html
    → requireAuth() on protected pages; optional pageName → check_page_access RPC
    → Navigation: admin sees Analysis, Reports, Settings; supervisor sees ops + billing only
```

**Important:** All data access is enforced by RLS in the database. Hiding links and `check_page_access` are for UX and defense-in-depth.

| Page | `check_page_access` |
|------|---------------------|
| settings, analysis, reports | admin only |
| dashboard, dsr, credit, expenses, day-closing, sales-daily, attendance, salary, billing | admin or supervisor |

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
   → get_day_closing_breakdown(date) or compute_day_closing_components
   → Enter night_cash, phone_pay, remarks
   → save_day_closing(...) → short_today, snapshot, closing_reference
   → short_today becomes next day’s short_previous
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
```

- **Ledger view:** `get_credit_ledger_aggregated()`.
- **Overdue:** `get_outstanding_credit_list_as_of(date)` on credit-overdue / outstanding list.
- **Legacy URL:** `credit-customer.html` redirects to `credit.html` with the same query/hash.

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
Products (admin maintains catalog in DB / future UI)
   → products: name, HSN, unit, rate, gst_percent

Create invoice (billing.html)
   → Line items with GST slabs (from AppConfig.GST_SLABS)
   → save_invoice(date, type, party, …, items jsonb)
   → invoices + invoice_items; invoice_number from sequence + prefix in pump_settings.billing

Reports
   → GST sales summary/detail reads invoices for outward supply
```

Supervisors can create invoices; only admins manage the product catalog (RLS).

---

## 6. Reports flow (admin)

```
Reports (reports.html)
   → requireAuth({ pageName: 'reports' })
   → Date range filter (shared dateRangeFilter.js)
   → Catalog: tank-wise DSR, GST sales/purchase, trading account, P&L
   → Data from dsr_*, invoices, expenses, pump_settings (purchase VAT %)
   → Print-friendly layout (no-print chrome)
```

Analysis (`analysis.html`) remains a separate admin P&L view; Reports consolidates printable registers.

---

## 7. HR flow (attendance and salary)

```
Employees (Settings → Staff HR, admin only)
   → employees: name, role_display, monthly_salary, personal fields
     (aadhar, address, phone, PAN, PF), display_order, is_active

Attendance (attendance.html)
   → save_employee_attendance_batch(date, jsonb) or per-row upsert
   → status: present | absent | half_day | leave; optional shift, check_in/out

Salary (salary.html)
   → salary_payments: installments per employee_id
```

Supervisors can record attendance and salary payments; **employee master data** is admin-only (RLS).

---

## 8. Admin-only flows

- **Settings (settings.html):** Sections — station & branding, billing defaults, pumps & tanks, users, staff HR, attendance shifts, alerts, expense categories, access notes. Persists to `pump_settings.config` (and `users` / `employees` / `expense_categories` tables).
- **Analysis (analysis.html):** P&L; uses DSR buying price, expenses, credit.
- **Reports (reports.html):** See §6.
- **Dashboard P&L section:** Admin-only panel; buying price via `update_dsr_buying_price`.
- **Audit log:** Admins read `audit_log`; writes via triggers only.

---

## 9. Page → data mapping (quick reference)

| Page | Primary tables / RPCs |
|------|------------------------|
| Login | Supabase Auth, public.users (role) |
| Dashboard | dsr_petrol, dsr_diesel, dsr_stock, day_closing, pump_settings, get_day_closing_breakdown, update_dsr_buying_price |
| Meter Reading (DSR) | dsr_petrol, dsr_diesel |
| DSR (sales-daily) | dsr view, dsr_stock, get_dsr_stock_range |
| Credit | credit_*, add_credit_entry, record_credit_payment, get_customer_credit_detail_as_of |
| Overdue | get_outstanding_credit_list_as_of |
| Billing | products, invoices, save_invoice |
| Expenses | expenses, expense_categories |
| Day closing | day_closing, get_day_closing_breakdown, save_day_closing |
| Attendance | employee_attendance, employees, save_employee_attendance_batch |
| Salary | salary_payments, employees |
| Reports | dsr_*, invoices, expenses, pump_settings (admin) |
| Analysis | dsr_*, expenses, day_closing, credit_* (admin) |
| Settings | pump_settings, users, employees, expense_categories, upsert_staff, delete_staff (admin) |

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment |
| [Data Tables](DATA_TABLES.md) | Table reference and RLS |
| [DSR Tables](DSR_TABLES.md) | DSR tables and computed stock |
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, supervisor login |
