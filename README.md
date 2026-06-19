# Bishnupriya Fuels (Petrol Pump)

## A F&S Ventures Company

Web application for **daily operations**, **finance**, and **HR** at a BPCL fuel station. Built with static HTML/JS and [Supabase](https://supabase.com) (PostgreSQL, Auth, Row Level Security). A **service worker** caches static assets for more reliable use on forecourt devices with patchy connectivity.

---

## Features

| Area | What it covers |
|------|----------------|
| **Meter & stock (DSR)** | Daily MS/HSD readings (`dsr_petrol`, `dsr_diesel`); computed stock reconciliation (`dsr_stock` view) |
| **Credit** | Customer ledger, per-customer detail, payments (FIFO), outstanding list |
| **Day closing** | Night cash, phone pay, short carry-forward, closing snapshot |
| **Billing** | Lube/accessory invoices (GST slabs, `save_invoice`) |
| **Expenses** | Daily expenses by category |
| **Reports** | Printable DSR, GST sales/purchases, trading account, P&L (admin) |
| **Analysis** | P&L dashboard view (admin) |
| **HR** | Employee roster (incl. Aadhaar, PAN, PF), attendance, salary installments |
| **Settings** | Station branding, pump/tank layout, billing defaults, users, alerts (admin) |

**Roles:** `admin` (full access) and `supervisor` (operations + billing; no settings, reports, or analysis). Both must be provisioned in `public.users`. Authorization is enforced by RLS, RPC guards, and `check_page_access`.

End-to-end flows and page → data mapping: [Flows](docs/FLOWS.md).

---

## Documentation

| Document | Purpose |
|----------|---------|
| [**Architecture**](docs/ARCHITECTURE.md) | Tech stack, **project structure**, system diagram, frontend/backend runtime, security, deployment |
| [**Data tables**](docs/DATA_TABLES.md) | Database reference: tables, columns, RLS, relationships (`supabase/schema.sql` is canonical) |
| [**Flows**](docs/FLOWS.md) | User and data flows: auth, daily ops, credit, DSR/stock, billing, reports, HR, settings |
| [**DSR tables**](docs/DSR_TABLES.md) | DSR model: `dsr_petrol` / `dsr_diesel`, union `dsr` view, computed `dsr_stock`, `get_dsr_stock_range` |
| [**Development guide**](docs/DEVELOPMENT.md) | Local setup, deployment (prod/staging), supervisor login |
| [**Database scripts**](scripts/README.md) | Prod → staging sync, prod migration, backup |

Full index and getting started by role: **[docs/README.md](docs/README.md)**.

---

## Getting started

- **Run locally:** [Development guide → Local development](docs/DEVELOPMENT.md#1-local-development) (env setup and local server).
- **Deploy:** [Development guide → Deployment](docs/DEVELOPMENT.md#2-deployment-prod-and-staging) (GitHub Actions, secrets, branches).
- **Release (sync / migrate / backup):** [scripts/README.md](scripts/README.md) — `./scripts/db.sh help`
- **Add an operator (supervisor):** [Development guide → Supervisor login](docs/DEVELOPMENT.md#3-supervisor--operator-login).

Project layout (pages, scripts, supabase): [Architecture → Project structure](docs/ARCHITECTURE.md#3-project-structure).

---

## Roadmap

Planned improvements for scalability, offline use, and multi-site support:

| Area | Direction |
|------|------------|
| **Frontend** | Migrate to a framework (React, Vue, or Svelte) for state and components. |
| **Offline** | Extend the existing PWA/service worker (background sync, fuller offline workflows). |
| **Multi-site** | Multi-tenancy for multiple pump locations and central reporting. |
| **Live data** | Supabase Realtime for live dashboard updates. |
| **Mobile** | Native or cross-platform app (e.g. React Native, Flutter) for operators. |
