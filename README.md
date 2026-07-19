<div align="center">

# Bishnupriya Fuels

### A F&amp;S Ventures Company · BPCL fuel station ops

[![Stack](https://img.shields.io/badge/stack-HTML%2FJS%20%2B%20Supabase-0070c0?style=for-the-badge&logo=html5&logoColor=white)](docs/ARCHITECTURE.md)
[![Deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-24292f?style=for-the-badge&logo=github&logoColor=white)](docs/OPERATIONS.md)
[![Ops](https://img.shields.io/badge/playbook-OPERATIONS.md-00d4ff?style=for-the-badge)](docs/OPERATIONS.md)

<br />

<img
  src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=22&duration=3500&pause=900&color=00D4FF&center=true&vCenter=true&width=780&lines=Architecture+%C2%B7+Data+flow+%C2%B7+Entry+points;Sync+staging+%C2%B7+Deploy+%C2%B7+Release+%C2%B7+Backup;sync+%E2%89%A0+deploy+%E2%89%A0+backup+%E2%80%94+keep+them+separate;Start+here+%E2%86%92+docs%2FOPERATIONS.md"
  alt="Typing overview of architecture and operations"
/>

<br />

**Live:** `main` · **Test:** `staging` → `/staging/` · **Domain:** [bishnupriyafuels.fnsventures.in](https://bishnupriyafuels.fnsventures.in)

</div>

---

## Visual tour

*Animations play on GitHub (open this README on github.com). Click any title for the written steps.*

### 1. Architecture & entry points

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/architecture-flow.svg" alt="Architecture: Browser → GitHub Pages → Supabase" width="900" />
</p>

```mermaid
flowchart LR
  A[index / login] --> B[dashboard]
  B --> C[meter-reading]
  B --> D[credit / expenses]
  B --> E[day-closing]
  C --> F[(Supabase Postgres + RLS)]
  D --> F
  E --> F
```

**Entry:** `index.html` → `login.html` → `dashboard.html` (after Auth + `public.users` role).

---

### 2. Daily data flow

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/data-flow.svg" alt="Daily data flow: meter → credit → expenses → day closing" width="900" />
</p>

| Step | Page | Writes |
|------|------|--------|
| 1 | `meter-reading.html` | `dsr_petrol` / `dsr_diesel` |
| 2 | `credit.html` | credit entries & payments |
| 3 | `expenses.html` | expenses |
| 4 | `day-closing.html` | day closing + night-cash collection |

Deep dive: [docs/FLOWS.md](docs/FLOWS.md)

---

### 3. Sync staging with production data

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/sync-flow.svg" alt="Sync: production DB read-only into staging DB" width="900" />
</p>

```bash
./scripts/db.sh sync
```

Production is **read-only**. Staging data is **replaced**. This does **not** deploy the website.

Steps: [OPERATIONS §1](docs/OPERATIONS.md#1-sync-staging-with-production-data)

---

### 4. Deploy & release

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/deploy-path.svg" alt="Deploy path: feature → staging → production" width="700" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/release-steps.svg" alt="Release steps A B C D" width="900" />
</p>

| Step | Action | Command / trigger |
|------|--------|-------------------|
| **A** | Sync data (optional) | `./scripts/db.sh sync` |
| **B** | Deploy test site | Push / merge to `staging` |
| **C** | DB migrate (only if needed) | `./scripts/db.sh migrate` then `--apply` |
| **D** | Go live | Merge `staging` → `main` |

Full checklist: [OPERATIONS §2–3](docs/OPERATIONS.md#2-deploy-the-website-to-staging)

---

### 5. Production backup → Google Drive

<p align="center">
  <img src="https://raw.githubusercontent.com/fnsventures/petrolpump/main/docs/assets/backup-flow.svg" alt="Backup: dump → compress → OAuth → Google Drive" width="900" />
</p>

```text
GitHub Actions → Backup production database → Drive folder YYYY/YYYY-MM/
```

Or locally: `./scripts/db.sh backup` (laptop only) · `./scripts/backup-prod-to-drive.sh` (Drive).

Steps: [OPERATIONS §4](docs/OPERATIONS.md#4-backup-production-database)

---

## Do this when you ship

Open the playbook — numbered steps, no fluff:

### → [docs/OPERATIONS.md](docs/OPERATIONS.md)

| I want to… | Go to |
|------------|-------|
| Copy live data into staging | §1 Sync |
| Publish `/staging/` | §2 Deploy |
| Release to production | §3 Release |
| Back up the live DB | §4 Backup |

---

## Run locally

```bash
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Provision Auth **and** `public.users` as `admin` — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Features

| Area | Covers |
|------|--------|
| Meter reading / DSR | MS/HSD readings and stock |
| Credit | Ledger, FIFO payments, prepaid, outstanding |
| Day closing | Night cash, phone pay, short, cash collection |
| Billing / invoices | Outward GST · inward supplier PDFs (Drive) |
| Expenses · HR · Reports | Costs, attendance, salary, admin reports |

---

## Documentation map

| Document | Purpose |
|----------|---------|
| [**Operations playbook**](docs/OPERATIONS.md) | Sync · deploy · release · backup |
| [Documentation hub](docs/README.md) | Index + visual links |
| [Architecture](docs/ARCHITECTURE.md) | Folders, security, stack |
| [Flows](docs/FLOWS.md) | Page → data journeys |
| [Development](docs/DEVELOPMENT.md) | First-time setup |
| [Backup (deep)](docs/BACKUP.md) | Restore & Drive troubleshooting |
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs → Drive |

<div align="center">

<br />

<sub>Static HTML/JS · Supabase · GitHub Pages · service worker</sub>

</div>
