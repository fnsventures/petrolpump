# Bishnupriya Fuels

### A F&S Ventures Company

Web application for **daily operations**, **finance**, and **HR** at a BPCL fuel station.

**Stack:** Static HTML/JS · [Supabase](https://supabase.com) (PostgreSQL, Auth, RLS) · GitHub Pages · Service worker for forecourt offline resilience.

---

## Documentation

**[docs/index.html](docs/index.html)** — interactive docs hub with quick start, command palette, and release pipeline.

| | |
|---|---|
| Run locally | `npm run dev` → [localhost:4173](http://localhost:4173) |
| Deploy staging | Push `staging` branch |
| Ship release | `./scripts/db.sh sync` → test → `migrate --apply` → merge `main` |

Plain-text fallback: [docs/README.md](docs/README.md)

---

## Features

| Area | What it covers |
|------|----------------|
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

End-to-end flows: [docs/FLOWS.md](docs/FLOWS.md)

---

## Documentation

| Priority | Document | Purpose |
|----------|----------|---------|
| **Start here** | [**docs/index.html**](docs/index.html) | Interactive hub — search, command palette, release pipeline |
| Fallback | [docs/README.md](docs/README.md) | Plain-text version of the hub |
| Reference | [Architecture](docs/ARCHITECTURE.md) | Stack, project structure, security |
| Reference | [Flows](docs/FLOWS.md) | User and data flows |
| Reference | [Data tables](docs/DATA_TABLES.md) | Database tables, RLS, RPCs |
| Reference | [DSR tables](docs/DSR_TABLES.md) | DSR model and stock views |
| Setup | [Development](docs/DEVELOPMENT.md) | Full local setup and deployment detail |
| One-time | [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Google Drive for supplier invoices |
| One-time | [Backup](docs/BACKUP.md) | Monthly prod DB → Google Drive |
| Scripts | [scripts/README.md](scripts/README.md) | DB sync, migrate, backup internals |

---

## Roadmap

| Area | Direction |
|------|-----------|
| **Frontend** | Framework migration (React, Vue, or Svelte) |
| **Offline** | Fuller PWA workflows, background sync |
| **Multi-site** | Multi-tenancy for multiple pump locations |
| **Live data** | Supabase Realtime for dashboard |
| **Mobile** | Native or cross-platform operator app |
