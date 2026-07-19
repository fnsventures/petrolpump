<div align="center">

<img src="assets/bishnupriya-fuels-logo.png" alt="Bishnupriya Fuels" width="120" />
&nbsp;&nbsp;
<a href="https://fnsventures.in/" target="_blank" rel="noopener noreferrer">
  <img src="assets/fns-ventures-logo.png" alt="FnS Ventures" width="72" />
</a>

# Bishnupriya Fuels

**[A F&amp;S Ventures Company](https://fnsventures.in/)** · BPCL fuel station ops

<img
  src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=20&duration=3000&pause=900&color=FF6B35&center=true&vCenter=true&width=680&lines=Architecture+%C2%B7+Sync+%C2%B7+Deploy+%C2%B7+Backup;Ship+with+confidence+%E2%86%92+docs%2FOPERATIONS.md"
  alt="Typing headline"
/>

<br />

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](docs/ARCHITECTURE.md)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111)](docs/ARCHITECTURE.md)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](docs/ARCHITECTURE.md)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](docs/DATA_TABLES.md)
[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-222?style=for-the-badge&logo=github&logoColor=white)](docs/OPERATIONS.md)

<br />

<img src="https://skillicons.dev/icons?i=html,css,js,postgres,supabase,github,githubactions,docker&theme=dark" alt="Stack" />

<br /><br />

[![Deploy](https://img.shields.io/github/actions/workflow/status/fnsventures/petrolpump/deploy-pages.yml?branch=main&style=flat-square&label=deploy&color=0070c0)](https://github.com/fnsventures/petrolpump/actions)
[![Commit](https://img.shields.io/github/last-commit/fnsventures/petrolpump?style=flat-square&color=00d4ff)](https://github.com/fnsventures/petrolpump/commits/main)
[![Ops](https://img.shields.io/badge/playbook-OPERATIONS-FF6B35?style=flat-square)](docs/OPERATIONS.md)

<br />

`main` live · `staging` → `/staging/` · [bishnupriyafuels.fnsventures.in](https://bishnupriyafuels.fnsventures.in)

<img src="https://user-images.githubusercontent.com/74038190/212284115-f47cd8ff-2ffb-4b04-b5bf-4d1c14c0247f.gif" width="360" alt="" />

</div>

---

## Jump to

<div align="center">

[![1 Architecture](https://img.shields.io/badge/1-Architecture-0070c0?style=for-the-badge)](#1-architecture)
[![2 Sync](https://img.shields.io/badge/2-Sync-00d4ff?style=for-the-badge)](#2-sync-staging--production-data)
[![3 Release](https://img.shields.io/badge/3-Release-FF6B35?style=for-the-badge)](#3-release)
[![4 Backup](https://img.shields.io/badge/4-Backup-3ECF8E?style=for-the-badge)](#4-backup--google-drive)
[![Local](https://img.shields.io/badge/▶-Local-222222?style=for-the-badge)](#run-locally)
[![Features](https://img.shields.io/badge/-Features-6b7280?style=for-the-badge)](#features)
[![Docs](https://img.shields.io/badge/📚-Docs-6b7280?style=for-the-badge)](#docs)

</div>

---

## Contents

<details open>
<summary><strong>Table of contents</strong> — categories · links · sublinks</summary>

<br />

### I. Visual tour (this README)

| # | Chapter | What’s inside |
|:-:|---------|---------------|
| 1 | [Architecture](#1-architecture) | Entry points · Browser → Pages → Supabase |
| 2 | [Sync](#2-sync-staging--production-data) | Prod data → staging · `db.sh sync` |
| 3 | [Release](#3-release) | A → B → C → D ship path |
| 4 | [Backup](#4-backup--google-drive) | Drive upload · local dump |
| 5 | [Run locally](#run-locally) | `env.js` · `npm run dev` · first admin |
| 6 | [Features](#features) | Product areas at a glance |
| 7 | [Docs](#docs) | Deep guides (below) |

### II. Operations playbook

- [**docs/OPERATIONS.md**](docs/OPERATIONS.md) — day-to-day shipping
  - [§1 Sync staging](docs/OPERATIONS.md#1-sync-staging-with-production-data)
  - [§2 Deploy staging](docs/OPERATIONS.md#2-deploy-the-website-to-staging)
  - [§3 Release to production](docs/OPERATIONS.md#3-release-to-production)
  - [§4 Backup production](docs/OPERATIONS.md#4-backup-production-database)
  - [§5 Command cheat sheet](docs/OPERATIONS.md#5-which-command-should-i-run)
  - [§6 Common problems](docs/OPERATIONS.md#6-common-problems)

### III. Engineering guides

| Guide | Topic |
|-------|-------|
| [Architecture](docs/ARCHITECTURE.md) | Folders · security · stack |
| [Development](docs/DEVELOPMENT.md) | Local setup · GitHub · edge functions |
| [Flows](docs/FLOWS.md) | Page → data journeys |
| [Data tables](docs/DATA_TABLES.md) | Schema · RLS · RPCs |
| [DSR tables](docs/DSR_TABLES.md) | Meter readings · stock math |
| [Scripts](scripts/README.md) | `db.sh` internals |

### IV. Integrations & process

| Guide | Topic |
|-------|-------|
| [Backup (deep)](docs/BACKUP.md) | Drive restore · OAuth troubleshooting |
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs → Google Drive |
| [Documentation hub](docs/README.md) | Full index |
| [Contributing](CONTRIBUTING.md) | Branch · PR · release |

</details>

---

## 1. Architecture

<p align="center">
  <img src="docs/assets/architecture-flow.png" alt="Browser → GitHub Pages → Supabase" width="800" />
</p>

<p align="center">
  <code>index.html</code> → <code>login.html</code> → <code>dashboard.html</code>
  <br />
  <sub>Requires Supabase Auth <strong>and</strong> a <code>public.users</code> role</sub>
</p>

---

## 2. Sync staging ← production data

<p align="center">
  <img src="docs/assets/sync-flow.png" alt="Sync production into staging" width="800" />
</p>

```bash
./scripts/db.sh sync
```

| Production | Staging |
|------------|---------|
| Read-only | Data **replaced** |
| Website unchanged | Website unchanged |

> Sync ≠ deploy. Full steps → [OPERATIONS §1](docs/OPERATIONS.md#1-sync-staging-with-production-data)

---

## 3. Release

<p align="center">
  <img src="docs/assets/release-steps.png" alt="Release A → D" width="800" />
</p>

| Step | What you do |
|:----:|-------------|
| **A** | Sync data *(optional)* — `./scripts/db.sh sync` |
| **B** | Publish test site — push / merge → `staging` |
| **C** | Schema upgrade *(if needed)* — `./scripts/db.sh migrate --apply` |
| **D** | Go live — merge `staging` → `main` |

> Full checklist → [OPERATIONS §3](docs/OPERATIONS.md#3-release-to-production)

---

## 4. Backup → Google Drive

<p align="center">
  <img src="docs/assets/backup-flow.png" alt="Backup flow" width="800" />
</p>

| Method | How |
|--------|-----|
| **Drive (recommended)** | Actions → **Backup production database** |
| **Local only** | `./scripts/db.sh backup` |

> Setup & restore → [OPERATIONS §4](docs/OPERATIONS.md#4-backup-production-database) · [BACKUP.md](docs/BACKUP.md)

---

## Run locally

```bash
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Then create the user in **Auth** and add them to `public.users` as `admin`.  
Details: [DEVELOPMENT.md](docs/DEVELOPMENT.md)

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

---

<div align="center">

<img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="720" alt="" />

<br />

<img src="https://user-images.githubusercontent.com/74038190/212749168-86d6c7ab-98da-409b-998f-c5b74721badd.gif" width="140" alt="" />
&nbsp;
<img src="https://user-images.githubusercontent.com/74038190/212751818-13da6fd2-27ca-45c4-9c64-3940ccfa6fd3.gif" width="140" alt="" />
&nbsp;
<img src="https://user-images.githubusercontent.com/74038190/212749443-0810e511-4f46-4492-96aa-3c110d7bc41a.gif" width="140" alt="" />

<br />

<img src="https://user-images.githubusercontent.com/74038190/212747657-7a8d59da-69c8-4110-8ea8-f8102fd0b413.gif" width="200" alt="" />

<br /><br />

<sub>HTML/JS · Supabase · GitHub Pages</sub>

</div>
