# Documentation — Bishnupriya Fuels (Petrol Pump)

This folder contains the technical documentation for the Petrol Pump application: architecture, data model, user and data flows, and development/deployment. Use this index to find the right document for your task.

---

## Documentation index

| Document | Purpose |
|----------|---------|
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | **Tech stack**, **project structure** (folders, pages, scripts, supabase, docs), system diagram, frontend/backend runtime, security model, deployment overview. Single source of truth for how the app is built and organized. |
| [**DATA_TABLES.md**](DATA_TABLES.md) | **Database reference**: all tables with purpose, main columns, RLS behaviour, and relationships. Canonical schema remains `supabase/schema.sql`. |
| [**FLOWS.md**](FLOWS.md) | **User and data flows**: auth, dashboard, daily ops, credit, DSR/stock, billing, invoice documents, reports, analysis, HR (staff/attendance/salary), admin/settings. Page → data mapping. |
| [**DSR_TABLES.md**](DSR_TABLES.md) | **DSR model**: `dsr_petrol` / `dsr_diesel`, union `dsr` view, computed `dsr_stock`, and `get_dsr_stock_range`. |
| [**DEVELOPMENT.md**](DEVELOPMENT.md) | **Setup and operations**: local development (env, server, first login), deployment (prod/staging, GitHub secrets, deploy flow), supervisor/operator login. |
| [**INVOICE_DOCUMENTS.md**](INVOICE_DOCUMENTS.md) | **Supplier invoice documents + Google Drive**: full setup from scratch (Google Cloud OAuth, Supabase secrets, edge function deploy, Settings, troubleshooting). |
| [**BACKUP.md**](BACKUP.md) | **Production DB backup**: monthly GitHub Actions → Google Drive, setup, what is included/excluded, verify, restore, troubleshooting. |
| [**../scripts/README.md**](../scripts/README.md) | **Database scripts**: prod → staging sync, prod migration, backup — which command to run and when. |

---

## Getting started by role

- **New to the project**  
  Start with [Architecture](ARCHITECTURE.md) (structure and stack) and [Flows](FLOWS.md) (how features connect). Then use [Development guide](DEVELOPMENT.md) to run and deploy.

- **Working on schema, RPCs, billing, or reporting**  
  Use [Data Tables](DATA_TABLES.md) (includes [RLS conventions](DATA_TABLES.md#rls-conventions), [RPC reference](DATA_TABLES.md#rpc-reference)) and [DSR Tables](DSR_TABLES.md). Billing uses `products`, `invoices`, `save_invoice`; reports are admin-only on `reports.html`.

- **Working on HR (staff, attendance, salary)**  
  Employee master and ID cards: [Flows §7](FLOWS.md#7-hr-flow-staff-attendance-salary) and `staff.html`. Salary pay-period vs payment date, PF, and expense linkage are documented there and in [Data Tables → employees / salary_payments](DATA_TABLES.md#employees).

- **Setting up locally or deploying**  
  Follow [Development guide](DEVELOPMENT.md) for env config, local server, GitHub Actions, and supervisor setup.

- **Setting up supplier invoice storage (Google Drive)**  
  Follow [Invoice documents guide](INVOICE_DOCUMENTS.md) — step-by-step for Google Cloud, Supabase edge function, and app integration.

- **Production database backup (monthly Drive upload)**  
  Follow [Backup guide](BACKUP.md) — GitHub Actions setup, secrets, restore, and troubleshooting.

- **Understanding a feature end-to-end**  
  Use [Flows](FLOWS.md) for dashboard, daily ops, credit, billing, invoice documents, day closing (incl. admin overwrite), reports, analysis, HR, and settings — including the page → data table.

---

## Document conventions

- **Cross-references:** Each doc ends with a “Related documentation” section linking to sibling docs.
- **Single source of truth:** Project structure lives in [Architecture § Project structure](ARCHITECTURE.md#3-project-structure); setup and deploy details in [Development guide](DEVELOPMENT.md). The main [README](../README.md) links here and does not duplicate structure or step-by-step instructions.
- **Schema:** The canonical database schema is `supabase/schema.sql`; [Data Tables](DATA_TABLES.md) summarizes it for quick reference.
