<div align="center">

<img src="assets/bishnupriya-fuels-logo.png" alt="Bishnupriya Fuels" width="128" />

# Bishnupriya Fuels

<p>
  <a href="https://fnsventures.in/" target="_blank" rel="noopener noreferrer">
    <img src="assets/fns-ventures-logo.png" alt="FnS Ventures" height="26" align="absmiddle" />
  </a>
  &nbsp;
  <a href="https://fnsventures.in/" target="_blank" rel="noopener noreferrer"><strong>A F&amp;S Ventures Company</strong></a>
  · Authorized BPCL dealer
</p>

<img
  src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=18&duration=3200&pause=1000&color=FF6B35&center=true&vCenter=true&width=620&lines=Architecture+%C2%B7+Sync+%C2%B7+Deploy+%C2%B7+Backup;Playbook+%E2%86%92+docs%2FOPERATIONS.md"
  alt="Typing headline"
/>

<br />

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)](docs/ARCHITECTURE.md)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=111)](docs/ARCHITECTURE.md)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](docs/ARCHITECTURE.md)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](docs/DATA_TABLES.md)
[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-222?style=flat-square&logo=github&logoColor=white)](docs/OPERATIONS.md)

<br />

[![Deploy](https://img.shields.io/github/actions/workflow/status/fnsventures/petrolpump/deploy-pages.yml?branch=main&style=flat-square&label=deploy&color=0070c0)](https://github.com/fnsventures/petrolpump/actions)
[![Commit](https://img.shields.io/github/last-commit/fnsventures/petrolpump?style=flat-square&color=00d4ff)](https://github.com/fnsventures/petrolpump/commits/main)
[![Playbook](https://img.shields.io/badge/📖_OPERATIONS-FF6B35?style=flat-square)](docs/OPERATIONS.md)

<br />

**Live** [`main`](https://bishnupriyafuels.fnsventures.in) · **Test** `staging` → `/staging/`

</div>

---

## Contents

| | Section | |
|:-:|---------|---|
| **1** | [Architecture](#1-architecture) | Browser → Pages → Supabase |
| **2** | [Sync](#2-sync-staging--production-data) | Prod data into staging |
| **3** | [Release](#3-release) | Ship A → B → C → D |
| **4** | [Backup](#4-backup--google-drive) | Dump → Google Drive |
| **5** | [Run locally](#5-run-locally) | Dev server setup |
| **6** | [Features](#6-features) | What the app covers |
| **7** | [Docs](#7-docs) | Deep guides |
| **8** | [License](#8-license) | Proprietary · F&S Ventures |

**Playbook** → [OPERATIONS.md](docs/OPERATIONS.md)
([Sync](docs/OPERATIONS.md#1-sync-staging-with-production-data) ·
[Deploy](docs/OPERATIONS.md#2-deploy-the-website-to-staging) ·
[Release](docs/OPERATIONS.md#3-release-to-production) ·
[Backup](docs/OPERATIONS.md#4-backup-production-database))

---

<a id="1-architecture"></a>

## 1 · Architecture

<p align="center">
  <img src="docs/assets/architecture-flow.png" alt="Browser → GitHub Pages → Supabase" width="780" />
</p>

<p align="center">
  <code>index.html</code> → <code>login.html</code> → <code>dashboard.html</code>
  <br />
  <sub>Supabase Auth + <code>public.users</code> role</sub>
</p>

---

<a id="2-sync-staging--production-data"></a>

## 2 · Sync staging ← production data

<p align="center">
  <img src="docs/assets/sync-flow.png" alt="Sync production into staging" width="780" />
</p>

```bash
./scripts/db.sh sync
```

| Production | Staging |
|:----------:|:-------:|
| Read-only | Data **replaced** |
| Site unchanged | Site unchanged |

Sync ≠ deploy · [full steps →](docs/OPERATIONS.md#1-sync-staging-with-production-data)

---

<a id="3-release"></a>

## 3 · Release

<p align="center">
  <img src="docs/assets/release-steps.png" alt="Release A → D" width="780" />
</p>

| | Step | Command / action |
|:-:|------|------------------|
| **A** | Sync data *(optional)* | `./scripts/db.sh sync` |
| **B** | Publish test site | push / merge → `staging` |
| **C** | Schema *(if needed)* | `./scripts/db.sh migrate --apply` |
| **D** | Go live | merge `staging` → `main` |

[Full checklist →](docs/OPERATIONS.md#3-release-to-production)

---

<a id="4-backup--google-drive"></a>

## 4 · Backup → Google Drive

<p align="center">
  <img src="docs/assets/backup-flow.png" alt="Backup flow" width="780" />
</p>

| Method | How |
|--------|-----|
| **Drive** | Actions → **Backup production database** |
| **Local** | `./scripts/db.sh backup` |

[Setup & restore →](docs/OPERATIONS.md#4-backup-production-database) · [BACKUP.md](docs/BACKUP.md)

---

<a id="5-run-locally"></a>
<a id="run-locally"></a>

## 5 · Run locally

```bash
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Create the user in **Auth**, then add them to `public.users` as `admin`.  
→ [DEVELOPMENT.md](docs/DEVELOPMENT.md)

---

<a id="6-features"></a>
<a id="features"></a>

## 6 · Features

| Area | Covers |
|------|--------|
| Meter reading / DSR | MS/HSD readings & stock |
| Credit | Ledger, payments, prepaid, outstanding |
| Day closing | Night cash, phone pay, short, cash collection |
| Billing / invoices | Outward GST · inward supplier PDFs |
| Expenses · HR · Reports | Costs, attendance, salary, admin reports |

---

<a id="7-docs"></a>
<a id="docs"></a>

## 7 · Docs

| Document | Purpose |
|----------|---------|
| [**Operations**](docs/OPERATIONS.md) | Sync · deploy · release · backup |
| [Architecture](docs/ARCHITECTURE.md) | Structure & security |
| [Development](docs/DEVELOPMENT.md) | Local setup |
| [Flows](docs/FLOWS.md) | Page → data |
| [Data tables](docs/DATA_TABLES.md) | Schema · RLS |
| [Backup](docs/BACKUP.md) | Drive restore |
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs |
| [Hub](docs/README.md) | Full index |
| [Contributing](CONTRIBUTING.md) | Branch · PR · release |

---

<a id="8-license"></a>
<a id="license"></a>

## 8 · License

<div align="center">

[![License](https://img.shields.io/badge/License-Proprietary-222222?style=for-the-badge)](LICENSE)
[![Copyright](https://img.shields.io/badge/©-F%26S_Ventures-0070c0?style=for-the-badge)](https://fnsventures.in/)

</div>

**Copyright © 2024–2026 [F&S Ventures](https://fnsventures.in/).** All rights reserved.

This repository contains proprietary software developed for **Bishnupriya Fuels** (Authorized BPCL dealer), an F&S Ventures company. Access or use constitutes acceptance of the full agreement in [`LICENSE`](LICENSE).

| | |
|--|--|
| **Type** | Proprietary software license — not open source |
| **Owner** | [F&S Ventures](https://fnsventures.in/) |
| **Grant** | Limited, non-exclusive, non-transferable, revocable — internal ops only |
| **Users** | Authorized personnel / contractors only; no credential sharing |
| **IP** | All rights reserved; feedback assigned to F&S Ventures |
| **Data** | Production & personal data must stay in approved systems; DPDP / IT Act apply |
| **Security** | Protect secrets; report incidents promptly; no unauthorized probing |
| **Third parties** | Cloud/libs keep their own terms (GitHub, Supabase, Drive, etc.) |
| **Not permitted** | Copy, redistribute, sublicense, compete with, or publicly disclose the Software |
| **Liability** | AS IS · capped liability · Licensee indemnifies for misuse |
| **Law** | Laws of India · negotiation then Indian courts |
| **Full terms** | See [`LICENSE`](LICENSE) (21 sections) |

For licensing or legal notices: [fnsventures.in](https://fnsventures.in/).

---

<div align="center">

<img src="https://user-images.githubusercontent.com/74038190/212284100-561aa473-3905-4a80-b561-0d28506553ee.gif" width="640" alt="" />

<br /><br />

<sub>HTML/JS · Supabase · GitHub Pages · © F&S Ventures</sub>

</div>
