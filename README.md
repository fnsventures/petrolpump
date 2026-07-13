<div align="center">

# ⛽ Bishnupriya Fuels

### *A F&S Ventures Company*

**Daily operations · finance · HR** for a BPCL fuel station

<br />

![Stack](https://img.shields.io/badge/stack-HTML%2FJS%20%2B%20Supabase-0070c0?style=for-the-badge&logo=html5&logoColor=white)
![Deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-24292f?style=for-the-badge&logo=github&logoColor=white)
![Offline](https://img.shields.io/badge/offline-service_worker-00d4ff?style=for-the-badge)

<br />

[**📖 Open the Documentation Hub →**](docs/README.md)

</div>

---

> [!TIP]
> **Start here:** [**docs/README.md**](docs/README.md) — animated flow diagrams, quick start, release pipeline, and command recipes.  
> Everything renders **on GitHub** — open `docs/README.md` to see moving SVG flows and Mermaid diagrams.

| I want to… | Command / link |
|:--|:--|
| Run locally | `npm run dev` → `http://localhost:3000` |
| Deploy staging | Push `staging` branch |
| Ship a release | `sync` → test → `migrate --apply` → merge `main` |
| Read the full guide | [**docs/README.md**](docs/README.md) |

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

**Roles:** `admin` (full) · `supervisor` (operations + billing + HR recording; no staff / settings / reports / analysis)

---

## Documentation

| Doc | What's inside |
|:--|:--|
| [**docs/README.md**](docs/README.md) | **Hub** — animated diagrams + commands |
| [Architecture](docs/ARCHITECTURE.md) | Stack, folders, security |
| [Flows](docs/FLOWS.md) | User journeys & page → data mapping |
| [Data tables](docs/DATA_TABLES.md) | Tables, RLS, RPCs |
| [Development](docs/DEVELOPMENT.md) | Full setup & deployment |
| [scripts/README.md](scripts/README.md) | DB sync, migrate, backup |

---

## Roadmap

| Area | Direction |
|:--|:--|
| **Frontend** | Framework migration (React, Vue, or Svelte) |
| **Offline** | Fuller PWA workflows, background sync |
| **Multi-site** | Multi-tenancy for multiple pump locations |
| **Live data** | Supabase Realtime for dashboard |
| **Mobile** | Native or cross-platform operator app |

---

<div align="center">

<sub>Static HTML/JS · Supabase · GitHub Pages · service worker for forecourt offline use</sub>

</div>
