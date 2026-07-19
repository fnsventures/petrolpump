<div align="center">

<img src="assets/bishnupriya-fuels-logo.png" alt="Bishnupriya Fuels" width="140" />

# Bishnupriya Fuels

### A F&amp;S Ventures Company · BPCL fuel station ops

<img
  src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=700&size=22&duration=2800&pause=800&color=FF6B35&center=true&vCenter=true&width=740&lines=Architecture+%C2%B7+Data+flow+%C2%B7+Entry+points;Sync+staging+%C2%B7+Deploy+%C2%B7+Release+%C2%B7+Backup;sync+%E2%89%A0+deploy+%E2%89%A0+backup;Ship+guide+%E2%86%92+docs%2FOPERATIONS.md"
  alt="Typing headline"
/>

<br />

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](docs/ARCHITECTURE.md)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111)](docs/ARCHITECTURE.md)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](docs/ARCHITECTURE.md)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](docs/DATA_TABLES.md)
[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-222222?style=for-the-badge&logo=github&logoColor=white)](docs/OPERATIONS.md)
[![Operations](https://img.shields.io/badge/🚀_OPERATIONS-FF6B35?style=for-the-badge)](docs/OPERATIONS.md)

<br />

<img src="https://skillicons.dev/icons?i=html,css,js,postgres,supabase,github,githubactions,docker&theme=dark" alt="Stack skill icons" />

<br /><br />

[![Deploy](https://img.shields.io/github/actions/workflow/status/fnsventures/petrolpump/deploy-pages.yml?branch=main&style=flat-square&label=deploy&color=0070c0)](https://github.com/fnsventures/petrolpump/actions)
[![Last commit](https://img.shields.io/github/last-commit/fnsventures/petrolpump?style=flat-square&color=00d4ff)](https://github.com/fnsventures/petrolpump/commits/main)
[![Stars](https://img.shields.io/github/stars/fnsventures/petrolpump?style=flat-square&color=FF6B35)](https://github.com/fnsventures/petrolpump)

<br />

**Live** `main` · **Test** `staging` → `/staging/` · [bishnupriyafuels.fnsventures.in](https://bishnupriyafuels.fnsventures.in)

<img src="https://user-images.githubusercontent.com/74038190/212284115-f47cd8ff-2ffb-4b04-b5bf-4d1c14c0247f.gif" width="420" alt="" />

</div>

## Jump to

[Architecture](#1-architecture) · [Sync](#2-sync-staging--production-data) · [Release](#3-release) · [Backup](#4-backup--google-drive) · [Local](#run-locally) · [Docs](#docs)

---

Daily operations, finance, and HR for a BPCL fuel station.

| | |
|--|--|
| **Stack** | HTML/JS · Supabase (Auth + Postgres + RLS) · GitHub Pages |
| **Roles** | `admin` · `supervisor` |
| **Playbook** | **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — sync ≠ deploy ≠ backup |

<div align="center">
  <a href="https://github.com/fnsventures/petrolpump"><img src="https://gh-card.dev/repos/fnsventures/petrolpump.svg?fullname=true" alt="Repo card" /></a>
</div>

---

## Visual tour

Medium dose: **four** flow diagrams + the widgets above. Steps: [OPERATIONS.md](docs/OPERATIONS.md).

### 1. Architecture

<p align="center">
  <img src="docs/assets/architecture-flow.png" alt="Browser → GitHub Pages → Supabase" width="820" />
</p>

**Entry:** `index.html` → `login.html` → `dashboard.html` *(Auth + `public.users` role)*

### 2. Sync staging ← production data

<p align="center">
  <img src="docs/assets/sync-flow.png" alt="Sync production into staging" width="820" />
</p>

```bash
./scripts/db.sh sync
```

Prod stays **read-only**. Staging data is **replaced**. Does not deploy the site.

### 3. Release

<p align="center">
  <img src="docs/assets/release-steps.png" alt="Release A → D" width="820" />
</p>

| | Action |
|--|--------|
| **A** | Sync data *(optional)* |
| **B** | Push / merge → `staging` |
| **C** | `migrate --apply` *(only if schema changes)* |
| **D** | Merge `staging` → `main` |

### 4. Backup → Google Drive

<p align="center">
  <img src="docs/assets/backup-flow.png" alt="Backup flow" width="820" />
</p>

Actions → **Backup production database** · or `./scripts/db.sh backup` on your laptop.

---

## Run locally

```bash
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Add yourself in Auth **and** `public.users` as `admin` — [DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Features

| Area | Covers |
|------|--------|
| Meter reading / DSR | MS/HSD readings and stock |
| Credit | Ledger, payments, prepaid, outstanding |
| Day closing | Night cash, phone pay, short, cash collection |
| Billing / invoices | Outward GST · inward supplier PDFs |
| Expenses · HR · Reports | Costs, attendance, salary, admin reports |

---

## Docs

| Document | Purpose |
|----------|---------|
| [**Operations**](docs/OPERATIONS.md) | Sync · deploy · release · backup |
| [Architecture](docs/ARCHITECTURE.md) | Structure & security |
| [Flows](docs/FLOWS.md) | Page → data |
| [Development](docs/DEVELOPMENT.md) | Local setup |
| [Backup](docs/BACKUP.md) | Drive restore |
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs |
| [Hub](docs/README.md) | Full index |

<div align="center">

<img src="https://user-images.githubusercontent.com/74038190/212284115-f47cd8ff-2ffb-4b04-b5bf-4d1c14c0247f.gif" width="420" alt="" />

<br />

<img src="https://user-images.githubusercontent.com/74038190/212749168-86d6c7ab-98da-409b-998f-c5b74721badd.gif" width="160" alt="" />
<img src="https://user-images.githubusercontent.com/74038190/212751818-13da6fd2-27ca-45c4-9c64-3940ccfa6fd3.gif" width="160" alt="" />
<img src="https://user-images.githubusercontent.com/74038190/212749443-0810e511-4f46-4492-96aa-3c110d7bc41a.gif" width="160" alt="" />

<br />

<img src="https://user-images.githubusercontent.com/74038190/212747657-7a8d59da-69c8-4110-8ea8-f8102fd0b413.gif" width="220" alt="" />

<br /><br />

<sub>HTML/JS · Supabase · GitHub Pages</sub>

</div>
