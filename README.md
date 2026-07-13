# Bishnupriya Fuels

### A F&S Ventures Company

Web application for **daily operations**, **finance**, and **HR** at a BPCL fuel station.

![Stack](https://img.shields.io/badge/stack-HTML%2FJS%20%2B%20Supabase-0070c0?style=flat-square)
![Deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-24292f?style=flat-square)
![Offline](https://img.shields.io/badge/PWA-service_worker-34d399?style=flat-square)

**Stack:** Static HTML/JS · [Supabase](https://supabase.com) (PostgreSQL, Auth, RLS) · GitHub Pages · Service worker for forecourt offline resilience.

---

## Documentation

### **[docs/README.md](docs/README.md)** — start here

Quick start, release pipeline, command recipes, and full doc index — optimized for browsing on GitHub.

| | |
|:--|:--|
| Run locally | `npm run dev` → `http://localhost:4173` |
| Deploy staging | Push `staging` branch |
| Ship release | `sync` → test → `migrate --apply` → merge `main` |

| Document | Purpose |
|:--|:--|
| [**docs/README.md**](docs/README.md) | **Hub** — quick access, commands, release workflow |
| [Architecture](docs/ARCHITECTURE.md) | Stack, project structure, security |
| [Flows](docs/FLOWS.md) | User and data flows |
| [Data tables](docs/DATA_TABLES.md) | Database tables, RLS, RPCs |
| [Development](docs/DEVELOPMENT.md) | Full local setup and deployment |
| [scripts/README.md](scripts/README.md) | DB sync, migrate, backup |

---

## Features

| Area | What it covers |
|:--|:--|
| **Meter & stock (DSR)** | Daily MS/HSD readings; computed stock reconciliation |
| **Credit** | Customer ledger, payments (FIFO), outstanding list |
| **Day closing** | Night cash, phone pay, short carry-forward |
| **Billing** | Lube/accessory invoices (GST slabs) |
| **Invoice documents** | Supplier PDFs in Google Drive |
| **Expenses** | Daily expenses by category |
| **Reports** | DSR, GST, trading account, P&L *(admin)* |
| **Analysis** | KPIs, charts, insights *(admin)* |
| **HR** | Staff roster, attendance, salary, PF slips |
| **Settings** | Station config, users, products, integrations *(admin)* |

**Roles:** `admin` (full) · `supervisor` (operations + billing + HR recording; no staff/settings/reports/analysis).

---

## Roadmap

| Area | Direction |
|:--|:--|
| **Frontend** | Framework migration (React, Vue, or Svelte) |
| **Offline** | Fuller PWA workflows, background sync |
| **Multi-site** | Multi-tenancy for multiple pump locations |
| **Live data** | Supabase Realtime for dashboard |
| **Mobile** | Native or cross-platform operator app |
