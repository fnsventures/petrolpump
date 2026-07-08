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
| **CI/CD** | GitHub Actions | Builds `js/env.js`, vendor bundle, HTML partials, minified assets |
| **Build** | Node (esbuild, Nunjucks) | `npm run build:vendor`, `build:html`, `minify`; see `package.json` |
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
├── dsr.html                # Meter Reading + DSR summary (merged; replaces sales-daily)
├── sales-daily.html        # Legacy redirect → dsr.html#filters
├── credit.html             # Credit ledger, customer detail, overdue tabs
├── credit-overdue.html     # Legacy URL → redirects to credit.html#outstanding
├── credit-customer.html    # Legacy URL → redirects to credit.html (preserves query/hash)
├── expenses.html           # Daily expenses by category
├── day-closing.html        # Day closing & short (night cash, phone pay, snapshot)
├── billing.html            # Lube/accessory invoicing (cash memos)
├── invoices.html           # Supplier/purchase invoice documents (Google Drive)
├── attendance.html         # Employee attendance (status, check-in/out)
├── salary.html             # Salary payments, pay-period tracking, printable slips
├── staff.html              # Employee roster, profile, photo, BPCL ID card (admin only)
├── analysis.html           # Business intelligence: KPIs, charts, insights (admin only)
├── reports.html            # Printable reports: DSR, GST, trading/P&L (admin only)
├── settings.html           # Station config, users, salaries, products, integrations (admin only)
├── about.html              # About / info page
├── 404.html                # Not found page
├── assets/                 # BPCL logo, landing images
├── CNAME                   # GitHub Pages custom domain
├── sw.js                   # Service worker (PWA / offline caching)
└── README.md               # Project overview and doc links
```

### 3.2 Styles

```
css/
├── base.css                 # Layout, typography, shared components (imports fonts.css)
├── fonts.css                # Self-hosted @font-face (DM Sans, Source Serif 4, Caveat)
├── app-core.css             # Shared shell, nav, panels
├── app-{route}.css          # Per-page styles (dashboard, dsr, credit, reports, …)
├── app.css                  # Legacy aggregator (imports all app-*.css; not linked in HTML)
├── login.css                # Login page
├── landing.css              # Public landing (index.html)
├── invoice-print.css        # Billing invoice print layout
├── salary-slip-print.css    # Salary slip print layout
├── staff-id-print.css       # Staff ID card print layout
├── reports-print.css        # Reports print layout
└── credit-summary-print.css # Credit customer summary print layout
```

```
fonts/                       # Self-hosted woff2 subsets (latin + latin-ext)
_partials/                   # Nunjucks partials (app-topbar.njk) — expanded at build time
```

### 3.3 Scripts

```
js/
├── env.js              # Runtime config — gitignored; generated in CI
├── env.example.js      # Template for local env.js
├── vendor/
│   ├── supabase.min.js           # Full client (app pages)
│   └── supabase-login.min.js     # Auth-only bundle (login.html)
├── appConfig.js        # Default pump settings, GST slabs, branding constants
├── supabase.js         # Supabase client from window.__APP_CONFIG__
├── auth.js             # Session guard, role, check_page_access, nav
├── appNav.js           # Dev fallback: inject nav when HTML partials not built
├── roleBootstrap.js    # Early role visibility from cache (FOUC prevention)
├── pumpSettings.js     # Load/cache pump_settings.config
├── utils.js            # Shared utilities (formatting, debounce, DSR/fuel stock helpers, …)
├── dsrQueries.js       # Shared DSR fetch/select helpers; receipt-history split
├── dsrSummary.js       # DSR summary section (lazy-loaded from dsr.js)
├── errorHandler.js     # Centralized error reporting
├── cache.js            # AppCache (role, reports, settings, …)
├── dateRangeFilter.js  # Shared date-range UI for reports/dashboard
├── pageSections.js     # Settings-style section tabs
├── purchaseTaxUtils.js # Fuel purchase VAT/LST helpers for reports
├── landing.js          # Landing page
├── dashboard.js        # Dashboard snapshot, lazy DSR/P&L sections, alerts
├── dsr.js              # Meter Reading + DSR summary orchestration
├── credit.js           # Credit list view, lazy tab modules
├── creditOverview.js   # Credit overview tab (lazy)
├── creditRecord.js     # Credit record tab (lazy)
├── creditCustomer.js   # Customer detail view (lazy)
├── creditCustomerDetail.js # Shared customer credit helpers
├── expenses.js         # Expenses
├── day-closing.js      # Day closing
├── billing.js          # Sales invoices → save_invoice RPC
├── invoices.js         # Supplier invoice documents → edge function
├── attendance.js       # Attendance batch save
├── salary.js           # Salary payments, pay-period tracking, expense linkage
├── staff.js            # Employee roster CRUD, photo upload, ID card (admin)
├── staffEmployees.js   # Cached employee loader (admin table vs supervisor RPCs)
├── analysis.js         # BI dashboard: KPIs, charts, insights (admin)
├── reports.js          # Report catalog and print views (admin)
└── settings.js         # pump_settings, users, salaries, products, integrations (admin)
```

**Convention:** Each feature page has a corresponding script (e.g. `dsr.html` → `js/dsr.js`). Shared behaviour lives in `auth.js`, `utils.js`, `dsrQueries.js`, `errorHandler.js`, `cache.js`, `pageSections.js` (hash-based in-page tabs on dashboard, reports, credit, billing, salary, attendance, invoices, analysis, settings).

### 3.4 Navigation (authenticated pages)

Top navigation is grouped and role-aware (`js/auth.js` → `applyRoleVisibility()`). Links marked `data-role="admin-only"` are hidden for supervisors; empty groups are removed.

| Group | Pages | Supervisor | Admin |
|-------|-------|------------|-------|
| **Operations** | Dashboard, Meter Reading (`dsr.html`) | ✓ | ✓ |
| **Finance** | Credit, Expenses, Day closing, Billing, Invoices | ✓ | ✓ |
| **HR** | Attendance, Salary, **Staff** | Attendance + Salary only | ✓ (incl. Staff) |
| **Admin** | Analysis, Reports, Settings | ✗ | ✓ |

Legacy URLs `credit-customer.html` and `credit-overdue.html` redirect into `credit.html` with query/hash preserved.

---

### 3.5 Backend (Supabase)

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
    ├── get-dashboard-data/   # Edge: batched dashboard DSR summary payload
    ├── get-reports-data/     # Edge: batched reports page data
    ├── get-pl-data/          # Edge: batched P&L (DSR + expenses + lube)
    └── invoice-documents/    # Edge: supplier invoices ↔ Google Drive
```

### 3.6 Documentation

```
docs/
├── README.md       # Documentation index and how to use the docs
├── ARCHITECTURE.md # This file — structure, stack, security, deployment
├── DATA_TABLES.md  # Database tables: purpose, columns, RLS
├── FLOWS.md        # User and data flows
├── DSR_TABLES.md         # DSR petrol/diesel tables and computed stock
├── DEVELOPMENT.md        # Local setup, deployment, supervisor login
└── INVOICE_DOCUMENTS.md  # Supplier invoices + Google Drive setup (full guide)
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
│  • css/base.css, css/fonts.css, css/app-core.css + route CSS per page          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  Supabase JS client (anon key)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Supabase                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  Auth           │  │  PostgreSQL     │  │  Edge Functions (opt)   │  │
│  │  Email/Password  │  │  Tables + RLS   │  │  get-dashboard-data,    │  │
│  │  JWT → role     │  │  RPCs, Triggers │  │  get-reports-data,      │  │
│  │                 │  │                 │  │  get-pl-data,           │  │
│  │                 │  │                 │  │  invoice-documents      │  │
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

### 5.1 Entry and config

- **Entry:** Public users open `index.html` (landing); operators use `login.html` → Supabase Auth → `dashboard.html`. Legacy bookmarks (`credit-customer.html`, `credit-overdue.html`) redirect into `credit.html` with hash/query preserved.
- **Config:** `js/env.js` exposes `window.__APP_CONFIG__` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV`). In CI this file is generated from GitHub environment secrets; locally it is created from `env.example.js`. Station defaults and GST slabs live in `js/appConfig.js`; live values are merged from `pump_settings` via `js/pumpSettings.js`.
- **Supabase client:** `js/supabase.js` creates the client, registers `sw.js` on load, and exposes `clearAllCaches` / `clearApiCaches` helpers that coordinate `AppCache` and the service worker.

### 5.2 Authentication and session

- **Auth:** `js/auth.js` handles session guard, role resolution from `public.users` (never from JWT metadata), redirect to login when unauthenticated, and role-based nav.
- **`requireAuth({ pageName })`** calls RPC `check_page_access` for defense-in-depth. Role is cached via `AppCache`.
- **Unprovisioned users** (Auth account without `public.users` row) are redirected to `login.html?error=unprovisioned`.
- **Forgot password:** Login page uses Supabase `resetPasswordForEmail`.
- **Profile avatar:** Topbar user menu supports upload/remove of operator photo (max 2 MB JPG/PNG/WebP) → Storage bucket `user-avatars`, RPC `update_my_avatar`, column `users.avatar_url`.
- **Topbar UX:** BPCL logo lockup, centered page subtitle, collapsible mobile nav with accordion groups.

### 5.3 Feature pages (summary)

| Page | Script | Primary purpose |
|------|--------|-----------------|
| `dashboard.html` | `dashboard.js` | Snapshot (always loaded); DSR summary + P&amp;L loaded lazily per section |
| `dsr.html` | `dsr.js` | Meter Reading + DSR summary (`dsrSummary.js` lazy) |
| `sales-daily.html` | — | Redirect to `dsr.html#filters` |
| `credit.html` | `credit.js` | Ledger; overview/record/customer modules lazy-loaded |
| `expenses.html` | `expenses.js` | Daily expenses by category |
| `day-closing.html` | `day-closing.js` | Close day + register; admin overwrite/delete |
| `billing.html` | `billing.js` | Outward lube invoices via `save_invoice` |
| `invoices.html` | `invoices.js` | Supplier invoice documents → Google Drive edge function |
| `attendance.html` | `attendance.js` | Batch attendance via `save_employee_attendance_batch` |
| `salary.html` | `salary.js` | Pay-period tracking, installments, slips, linked expenses |
| `staff.html` | `staff.js` | Employee roster, photo, ID card print (admin only) |
| `analysis.html` | `analysis.js` | BI: KPIs, daily series, Chart.js charts, insights (admin) |
| `reports.html` | `reports.js` | Printable DSR, GST, trading account, P&amp;L (admin) |
| `settings.html` | `settings.js` | Station, billing, pumps, users, salaries, shifts, alerts, categories, integrations |

**Invoice documents:** Supplier/purchase invoice files upload to Google Drive via edge function `invoice-documents`; metadata in `invoice_documents`. Setup: [Invoice documents guide](INVOICE_DOCUMENTS.md).

**Dashboard sections** (side nav via `pageSections.js`): `snapshot` (all roles, loads on init), `dsr` summary (loaded when section opened), `pl` (**admin only** — loaded when section opened via `get-pl-data` edge function with client fallback), `notifications` (alerts). Aside rail **At a glance** shows MS/HSD selling rates and animated tank fill % from `pump_settings.config.pumps` capacities.

**Analysis sections:** `setup` (date range), `metrics` (KPI cards), `charts` (sales, profit, fuel/revenue mix via Chart.js CDN), `insights` (text summaries). Printable P&amp;L is on **Reports** (`pl` report) and dashboard **P&amp;L** section — Analysis is a broader BI view.

### 5.4 Caching and offline

- **`sw.js`:** Precaches HTML/CSS/JS/fonts (versioned `CACHE_VERSION`, currently `v102`) and applies network-first caching for Supabase REST/Functions URLs. Sensitive financial tables and RPCs are never cached. Works for prod root and `/staging/` scope.
- **`js/cache.js` (`AppCache`):** Short-lived API snapshots in `localStorage` (role, reports, settings, etc.).

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
- **Page access:** `check_page_access(page)` — see [Flows §1](FLOWS.md#1-authentication-and-role-based-access) for the full page list.
- **Staff / HR RPCs:** `list_employees_roster()` (no PII — attendance/salary pickers), `list_employees_salary()` (full HR fields for slips), `set_employee_photo(uuid, url)` (admin), `save_employee_attendance_batch(date, jsonb)`.
- **Operator profile:** `update_my_avatar(url)`, `my_avatar_storage_folder()` (path helper for Storage RLS).
- **Credit RPCs:** `add_credit_entry`, `record_credit_payment`, `batch_record_credit_settlements`, `get_credit_ledger_aggregated`, `get_open_credit_as_of`, `get_outstanding_credit_list_as_of`, `get_customer_credit_detail_as_of`, `delete_credit_entry` (admin), `delete_credit_payment` (admin).
- **Day closing RPCs:** `get_day_closing_breakdown(date)` (returns `already_saved`, `can_overwrite` for admins), `save_day_closing(...)`, `compute_day_closing_components(date)`, `delete_day_closing(uuid)` (admin — latest date only), `recascade_day_closing_short_from(date)` (internal).
- **Billing:** `generate_invoice_number()`, `save_invoice(...)` — atomic header + line items; `invoice_items` client mutations denied by RLS.
- **DSR admin:** `update_dsr_buying_price(uuid, value)` — pre-VAT cost per litre for P&amp;L.
- **User management:** `upsert_staff(...)`, `delete_staff(email)` — admin staff provisioning with bootstrap rules.
- **Audit:** Triggers on users, dsr_petrol, dsr_diesel, expenses, credit_customers, employees, salary_payments, employee_attendance, credit_payments, day_closing, invoices → `audit_log`.

### 6.4 Supabase Storage buckets

| Bucket | Purpose | Upload policy |
|--------|---------|---------------|
| `user-avatars` | Operator profile photos (`users.avatar_url`) | Authenticated user writes to own folder (`my_avatar_storage_folder()`) |
| `staff-photos` | Employee ID card photos (`employees.photo_url`) | Admin only; RPC `set_employee_photo` updates DB after upload |

Bucket policies are created in migrations `20260528300000_user_avatar.sql` and `20260528500000_employee_photo.sql`.

### 6.5 Edge functions

| Function | Purpose | Deploy |
|----------|---------|--------|
| `get-dashboard-data` | Batched dashboard DSR summary (DSR, stock, expenses, credit) | GitHub Actions or Supabase CLI |
| `get-reports-data` | Batched reports page payload | GitHub Actions or Supabase CLI |
| `get-pl-data` | Batched P&amp;L (DSR + receipt history, expenses, lube sales) | GitHub Actions or Supabase CLI |
| `invoice-documents` | Supplier invoice upload/download/delete/status ↔ Google Drive | GitHub Actions or Supabase CLI |

Deploy workflow: `.github/workflows/deploy-supabase-functions.yml`. Requires `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` per environment. See [Development guide §2.5](DEVELOPMENT.md#25-edge-functions).

Full RPC and table reference: [Data Tables](DATA_TABLES.md).

---

## 7. Security model

- **Enforcement:** RLS and security-definer RPC guards are the primary authorization layer. Client-side checks only affect the UI.
- **Provisioned staff:** A user must exist in both Supabase Auth **and** `public.users` with role `admin` or `supervisor`. Authenticated users without a `public.users` row cannot read or write application data — policies and RPCs use `is_supervisor_or_admin()` / `require_staff_access()`.
- **Roles:**

| Capability | Admin | Supervisor |
|------------|-------|------------|
| Operations + Finance pages (DSR, credit, expenses, day closing, billing, invoices) | ✓ | ✓ |
| Attendance + salary recording | ✓ | ✓ |
| Staff roster / ID cards (`staff.html`) | ✓ | ✗ |
| Settings, Analysis, Reports | ✓ | ✗ |
| Dashboard P&amp;L section + buying price entry | ✓ | ✗ |
| Product catalog edit (Settings → Billing) | ✓ | ✗ (can bill using existing products) |
| Employee master mutations (`employees` table) | ✓ | ✗ (reads via `list_employees_*` RPCs) |
| Day closing overwrite after save | ✓ | ✗ (read-only snapshot) |
| Delete latest day closing | ✓ | ✗ |
| Delete credit entries / payments | ✓ | ✗ |
| Delete supplier invoice documents | ✓ | ✗ |
| Delete salary payments | ✓ | ✗ |

- **Default policy pattern (operational tables):** SELECT for provisioned staff; INSERT with `is_supervisor_or_admin()` and `created_by = auth.uid()`; UPDATE for provisioned staff on own row or admin; DELETE admin only. Admin-only tables (e.g. `expense_categories`, `products`, `employees`) and exceptions are documented in [Data Tables](DATA_TABLES.md).
- **Admin bootstrap:** When no admin exists, the first user may self-provision via `upsert_staff` or the matching RLS INSERT — only their own JWT email, role must be `admin`. Prevents arbitrary email escalation before an admin is established.
- **Admin delete pattern:** `js/utils.js` → `AdminDelete` shows destructive actions only for admins (credit entries, day closing register, salary payments, etc.).
- **Shared client helpers:** `js/utils.js` exposes `formatNumericDate`, `formatNumberPlain`, `sumByProduct`, and `resolveDayFuelStock` for consistent report/dashboard formatting and fuel-stock resolution (prefer `dsr_stock.dip_stock` when present, else meter `stock`).

---

## 8. Deployment

- **Hosting:** GitHub Pages (custom domain via `CNAME`).
- **Environments:**
  - **Prod:** `main` branch → root URL (e.g. `https://bishnupriyafuels.fnsventures.in/`).
  - **Staging:** `staging` branch → `/staging/` path.
- **CI:** `.github/workflows/deploy-pages.yml` — builds env, vendor bundle, HTML partials, minifies assets, pushes to **`gh-pages`** (staging → `/staging/`, prod → root). Edge functions: `.github/workflows/deploy-supabase-functions.yml`.
- **Details:** Step-by-step local setup, deploy flow, and supervisor login are in [Development guide](DEVELOPMENT.md).

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Data Tables](DATA_TABLES.md) | Tables, columns, relationships, RLS |
| [Flows](FLOWS.md) | User and data flows (auth, daily ops, credit, HR, admin) |
| [DSR Tables](DSR_TABLES.md) | `dsr_petrol` / `dsr_diesel`, views, stock reconciliation |
| [Development guide](DEVELOPMENT.md) | Local development, deployment, supervisor login |
| [Invoice documents](INVOICE_DOCUMENTS.md) | Google Drive integration, edge function, full setup |
