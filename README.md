<div align="center">

<img src="assets/bishnupriya-fuels-logo.png" alt="Bishnupriya Fuels" width="160" />

# Bishnupriya Fuels

### A F&amp;S Ventures Company · BPCL fuel station ops

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=20&duration=3200&pause=900&color=0070C0&center=true&vCenter=true&width=720&lines=Architecture+%C2%B7+Sync+%C2%B7+Deploy+%C2%B7+Backup;Ship+guide+%E2%86%92+docs%2FOPERATIONS.md" alt="Typing overview" />

<br />

[![Deploy](https://img.shields.io/github/actions/workflow/status/fnsventures/petrolpump/deploy-pages.yml?branch=main&style=flat-square&label=deploy)](https://github.com/fnsventures/petrolpump/actions)
[![Last commit](https://img.shields.io/github/last-commit/fnsventures/petrolpump?style=flat-square)](https://github.com/fnsventures/petrolpump/commits/main)
[![Ops](https://img.shields.io/badge/playbook-OPERATIONS.md-0070c0?style=flat-square)](docs/OPERATIONS.md)

<br />

<img src="https://skillicons.dev/icons?i=html,css,js,postgres,supabase,github,githubactions" alt="Stack icons" />

<br /><br />

**Live:** `main` · **Test:** `staging` → `/staging/` · [bishnupriyafuels.fnsventures.in](https://bishnupriyafuels.fnsventures.in)

</div>

---

Daily operations, finance, and HR for a BPCL fuel station.

| | |
|--|--|
| **Stack** | HTML/JS · Supabase (Postgres + Auth + RLS) · GitHub Pages |
| **Roles** | `admin` · `supervisor` |
| **Ship guide** | **[docs/OPERATIONS.md](docs/OPERATIONS.md)** |

---

## Visual tour

Four diagrams. Full steps: [OPERATIONS.md](docs/OPERATIONS.md).

### Architecture

<p align="center">
  <img src="docs/assets/architecture-flow.png" alt="Browser → GitHub Pages → Supabase" width="820" />
</p>

**Entry:** `index.html` → `login.html` → `dashboard.html` (after Auth + `public.users` role).

### Sync staging ← production data

<p align="center">
  <img src="docs/assets/sync-flow.png" alt="Sync production DB into staging" width="820" />
</p>

```bash
./scripts/db.sh sync
```

Prod is read-only. Staging data is replaced. Does **not** deploy the website.

### Release

<p align="center">
  <img src="docs/assets/release-steps.png" alt="Release steps A B C D" width="820" />
</p>

| Step | Action |
|------|--------|
| A | `./scripts/db.sh sync` (optional) |
| B | Push / merge to `staging` |
| C | `./scripts/db.sh migrate --apply` (only if migrations) |
| D | Merge `staging` → `main` |

### Backup → Google Drive

<p align="center">
  <img src="docs/assets/backup-flow.png" alt="Backup to Google Drive" width="820" />
</p>

Actions → **Backup production database** · or `./scripts/db.sh backup` locally.

---

## Run locally

```bash
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Provision Auth **and** `public.users` as `admin` — [DEVELOPMENT.md](docs/DEVELOPMENT.md).

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
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs → Drive |
| [Documentation hub](docs/README.md) | Full index |

<div align="center">
<sub>HTML/JS · Supabase · GitHub Pages</sub>
</div>
