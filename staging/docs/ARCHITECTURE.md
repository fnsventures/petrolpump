# Architecture

This document describes the architecture of **Bishnupriya Fuels** (Petrol Pump): technology stack, project structure, runtime components, security, and deployment. It is the single source of truth for how the application is organized and how it runs.

**See also:** [Data Tables](DATA_TABLES.md) · [Flows](FLOWS.md) · [Development guide](DEVELOPMENT.md)

---

## 1. Overview

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | Static HTML, CSS, vanilla JavaScript | Multi-page app; auth-guarded pages; role-based navigation |
| **Backend / Data** | Supabase (PostgreSQL, Auth, RLS) | Authentication, database, Row Level Security, RPCs |
| **Deployment** | GitHub Pages + GitHub Actions | Prod (root) and Staging (`/staging/`) with env-specific config |

Data access is **enforced at the database** via Row Level Security (RLS). Client-side role checks are for UX only (e.g. hiding admin links); they do not replace server-side enforcement.

---

## 2. Tech stack

| Area | Choice | Notes |
|------|--------|-------|
| **UI** | HTML5, CSS3, JavaScript (ES6+) | No framework; each page has a dedicated script |
| **Auth** | Supabase Auth | Email/password; JWT; role from `public.users` |
| **Database** | PostgreSQL (Supabase) | Schema in `supabase/schema.sql`; migrations in `supabase/migrations/` |
| **API** | Supabase client (REST + RPC) | Tables + Row Level Security + server-side RPCs |
| **Hosting** | GitHub Pages | Static site; custom domain via `CNAME` |
| **CI/CD** | GitHub Actions | Builds `js/env.js` from secrets per environment |
| **Offline** | Service worker (`sw.js`) | Caches static assets and API patterns for forecourt use |

---

## 3. Project structure

All application and documentation files live under the repository root. Below is the canonical layout.

### 3.1 Root and pages

```
petrolPump/
├── index.html              # Public landing (hero, about); links to login.html
├── login.html              # Operator login (Supabase Auth)
├── dashboard.html          # Authenticated home (snapshot, P&L section, quick links)
├── dsr.html                # Meter Reading → dsr_petrol / dsr_diesel (stock via dsr_stock view)
├── sales-daily.html        # DSR listing / daily report view
├── credit.html             # Credit ledger, customer detail, overdue tabs
├── credit-overdue.html     # Legacy URL → redirects to credit.html#outstanding
├── credit-customer.html    # Legacy URL → redirects to credit.html (preserves query/hash)
├── expenses.html           # Daily expenses by category
├── day-closing.html        # Day closing & short (night cash, phone pay, snapshot)
├── billing.html            # Lube/accessory invoicing (cash memos)
├── attendance.html         # Employee attendance (status, check-in/out)
├── salary.html             # Salary payments (installments per employee)
├── analysis.html           # P&L / Analysis (admin only)
├── reports.html            # Printable reports: DSR, GST, trading/P&L (admin only)
├── settings.html           # Station config, users, HR, categories (admin only)
├── about.html              # About / info page
├── assets/                 # BPCL logo, landing images
├── CNAME                   # GitHub Pages custom domain
├── sw.js                   # Service worker (PWA / offline caching)
└── README.md               # Project overview and doc links
```

### 3.2 Styles

```
css/
├── base.css    # Layout, typography, shared components
├── app.css     # App shell, dashboard, forms, tables
├── login.css   # Login page
├── landing.css # Public landing (index.html)
└── style.css   # Legacy / additional styles
```

### 3.3 Scripts

```
js/
├── env.js              # Runtime config — gitignored; generated in CI
├── env.example.js      # Template for local env.js
├── appConfig.js        # Default pump settings, GST slabs, branding constants
├── supabase.js         # Supabase client from window.__APP_CONFIG__
├── auth.js             # Session guard, role, check_page_access, nav
├── pumpSettings.js     # Load/cache pump_settings.config
├── utils.js            # Shared utilities (formatting, debounce, DSR/fuel stock helpers, …)
├── dsrQueries.js       # Shared DSR fetch/select helpers; mergeDsrStock for reports/dashboard
├── errorHandler.js     # Centralized error reporting
├── cache.js            # AppCache (role, reports, settings, …)
├── dateRangeFilter.js  # Shared date-range UI for reports/dashboard
├── pageSections.js     # Settings-style section tabs
├── purchaseTaxUtils.js # Fuel purchase VAT/LST helpers for reports
├── landing.js          # Landing page
├── dashboard.js        # Dashboard snapshot, P&L, context rail (rates/tanks)
├── dsr.js              # Meter Reading → dsr_petrol / dsr_diesel
├── sales-daily.js      # DSR listing view
├── credit.js           # Credit ledger, customer detail, overdue, payments
├── creditCustomerDetail.js # Shared customer credit helpers (used by credit.js)
├── expenses.js         # Expenses
├── day-closing.js      # Day closing
├── billing.js          # Invoices → save_invoice RPC
├── attendance.js       # Attendance batch save
├── salary.js           # Salary payments
├── analysis.js         # P&L (admin)
├── reports.js          # Report catalog and print views (admin)
└── settings.js         # pump_settings, users, HR, categories (admin)
```

**Convention:** Each feature page has a corresponding script (e.g. `dsr.html` → `js/dsr.js`). Shared behaviour lives in `auth.js`, `utils.js`, `dsrQueries.js`, `errorHandler.js`, `cache.js`.

### 3.4 Backend (Supabase)

```
supabase/
├── schema.sql     # Full schema (tables, views, RLS, RPCs) — source of truth
├── migrations/    # Incremental migrations (apply in filename order)
│   ├── 20250129*_dsr_*.sql
│   ├── 202502*_credit_*.sql
│   ├── 20250526*_split_dsr_petrol_diesel.sql
│   ├── 20250526*_billing_system.sql
│   ├── 20250527*_pump_settings.sql
│   ├── 20260528100000_employee_personal_details.sql
│   ├── 20260619100000_security_loophole_mitigation.sql
│   └── …
└── functions/
    └── get-dashboard-data/   # Edge function: batched dashboard payload (optional)
```

### 3.5 Documentation

```
docs/
├── README.md       # Documentation index and how to use the docs
├── ARCHITECTURE.md # This file — structure, stack, security, deployment
├── DATA_TABLES.md  # Database tables: purpose, columns, RLS
├── FLOWS.md        # User and data flows
├── DSR_TABLES.md   # DSR petrol/diesel tables and computed stock
└── DEVELOPMENT.md  # Local setup, deployment, supervisor login
```

---

## 4. System diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Browser (User)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Frontend (Static)                                                        │
│  • HTML pages (landing, dashboard, dsr, credit, billing, reports, …)      │
│  • js/env.js → window.__APP_CONFIG__ (Supabase URL, anon key)             │
│  • js/supabase.js (client + SW register), js/auth.js, js/*.js per page   │
│  • sw.js — static + API cache; AppCache in js/cache.js (localStorage)     │
│  • css/base.css, css/app.css, css/login.css, css/landing.css              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  Supabase JS client (anon key)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Supabase                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  Auth           │  │  PostgreSQL     │  │  Edge Functions (opt)   │  │
│  │  Email/Password  │  │  Tables + RLS   │  │  e.g. get-dashboard-data │  │
│  │  JWT → role     │  │  RPCs, Triggers │  │                          │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Deployment                                                               │
│  GitHub Actions → js/env.js from secrets → GitHub Pages (prod / staging)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Frontend (runtime)

- **Entry:** Public users open `index.html` (landing); operators use `login.html` → Supabase Auth → `dashboard.html`. Legacy bookmarks (`credit-customer.html`, `credit-overdue.html`) redirect into `credit.html` with hash/query preserved.
- **Config:** `js/env.js` exposes `window.__APP_CONFIG__` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV`). In CI this file is generated from GitHub environment secrets; locally it is created from `env.example.js`. Station defaults and GST slabs live in `js/appConfig.js`; live values are merged from `pump_settings` via `js/pumpSettings.js`.
- **Auth:** `js/auth.js` handles session guard, role resolution from `public.users`, redirect to login when unauthenticated, and role-based nav. `requireAuth({ pageName })` calls RPC `check_page_access` for defense-in-depth (e.g. `reports`, `analysis`, `settings`). Role is cached via `AppCache`.
- **Supabase client:** `js/supabase.js` creates the client, registers `sw.js` on load, and exposes `clearAllCaches` / `clearApiCaches` helpers that coordinate `AppCache` and the service worker.
- **Pages:** Each feature has its own HTML and JS; navigation is grouped (Operations, Finance, HR, Admin) and role-aware. Supervisors get operational pages including **billing**; **reports**, **analysis**, and **settings** are admin-only.
- **Dashboard:** Section nav (snapshot, DSR summary, P&amp;L, notifications) plus **At a glance** (selling rates, tank fill from dip vs `pump_settings.reports.tanks`). May call edge function `get-dashboard-data` for a batched payload.
- **Caching:** `sw.js` precaches HTML/CSS/JS (versioned `CACHE_VERSION`) and applies network-first caching for Supabase REST/Functions URLs; `js/cache.js` (`AppCache`) holds short-lived API snapshots in `localStorage`.

---

## 6. Backend (Supabase)

### 6.1 Authentication

- **Provider:** Supabase Auth (email/password).
- **App roles:** Stored in `public.users` (email, role, display_name). Role is resolved by matching `auth.jwt() ->> 'email'` to `users.email` (case-insensitive). Roles: `admin`, `supervisor`.

### 6.2 Database

- **Engine:** PostgreSQL (Supabase).
- **Schema:** Defined in `supabase/schema.sql`; changes are applied via migrations under `supabase/migrations/`.
- **Security:** RLS is enabled on all application tables. Policies use helper functions `get_user_role()`, `is_admin()`, `is_supervisor_or_admin()`, and `require_staff_access()` (security definer). Only users provisioned in `public.users` (admin or supervisor) can read or write operational data.
- **Audit:** Audit triggers on sensitive tables write to `audit_log` (table_name, record_id, action, old_data, new_data, performed_by, performed_at). Only admins can read `audit_log`.

### 6.3 Key server-side constructs

- **DSR storage:** Physical tables `dsr_petrol` and `dsr_diesel`; views `dsr` (union) and `dsr_stock` (computed reconciliation); RPC `get_dsr_stock_range(start, end)`.
- **RPCs (examples):** `check_page_access(page)`, `require_staff_access()` (internal guard), `get_day_closing_breakdown(date)`, `save_day_closing(...)`, `compute_day_closing_components(date)`, `add_credit_entry(...)`, `record_credit_payment(...)`, `get_credit_ledger_aggregated()`, `get_open_credit_as_of(date)`, `get_customer_credit_detail_as_of(name, date)`, `update_dsr_buying_price(uuid, value)`, `save_invoice(...)`, `save_employee_attendance_batch(date, jsonb)`, `upsert_staff(...)`, `delete_staff(...)`. Most security-definer RPCs call `require_staff_access()` at entry.
- **Billing integrity:** `invoice_items` line rows are inserted only inside `save_invoice`; direct client INSERT/UPDATE/DELETE on `invoice_items` is denied by RLS.
- **Internal RPCs:** `recascade_day_closing_short_from(date)` is not granted to `authenticated` — only invoked from `save_day_closing` (security definer).
- **Triggers:** `credit_entries_sync_trigger` on `credit_entries`; audit triggers on users, dsr_petrol, dsr_diesel, expenses, credit_customers, employees, salary_payments, employee_attendance, credit_payments, day_closing, invoices.

Full table and RPC reference: [Data Tables](DATA_TABLES.md).

---

## 7. Security model

- **Enforcement:** RLS and security-definer RPC guards are the primary authorization layer. Client-side checks only affect the UI.
- **Provisioned staff:** A user must exist in both Supabase Auth **and** `public.users` with role `admin` or `supervisor`. Authenticated users without a `public.users` row cannot read or write application data — policies and RPCs use `is_supervisor_or_admin()` / `require_staff_access()`.
- **Roles:**
  - **admin:** Full access (settings, reports, analysis, employee HR mutations, product catalog, delete).
  - **supervisor:** Operational pages including **billing**; no settings, reports, or analysis; insert/update own records; no delete.
- **Default policy pattern (operational tables):** SELECT for provisioned staff; INSERT with `is_supervisor_or_admin()` and `created_by = auth.uid()`; UPDATE for provisioned staff on own row or admin; DELETE admin only. Admin-only tables (e.g. `expense_categories`, `products`, `employees`) and exceptions are documented in [Data Tables](DATA_TABLES.md).
- **Admin bootstrap:** When no admin exists, the first user may self-provision via `upsert_staff` or the matching RLS INSERT — only their own JWT email, role must be `admin`. Prevents arbitrary email escalation before an admin is established.
- **Shared client helpers:** `js/utils.js` exposes `formatNumericDate`, `formatNumberPlain`, `sumByProduct`, and `resolveDayFuelStock` for consistent report/dashboard formatting and fuel-stock resolution (prefer `dsr_stock.dip_stock` when present, else meter `stock`).

---

## 8. Deployment

- **Hosting:** GitHub Pages (custom domain via `CNAME`).
- **Environments:**
  - **Prod:** `main` branch → root URL (e.g. `https://bishnupriyafuels.fnsventures.in/`).
  - **Staging:** `staging` branch → `/staging/` path.
- **CI:** `.github/workflows/deploy-pages.yml` builds `js/env.js` from environment secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) so prod and staging each use their own Supabase project, then deploys static assets to GitHub Pages.
- **Details:** Step-by-step local setup, deploy flow, and supervisor login are in [Development guide](DEVELOPMENT.md).

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Data Tables](DATA_TABLES.md) | Tables, columns, relationships, RLS |
| [Flows](FLOWS.md) | User and data flows (auth, daily ops, credit, HR, admin) |
| [DSR Tables](DSR_TABLES.md) | `dsr_petrol` / `dsr_diesel`, views, stock reconciliation |
| [Development guide](DEVELOPMENT.md) | Local development, deployment, supervisor login |
