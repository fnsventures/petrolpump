# Documentation

Professional guides for **Bishnupriya Fuels** — local setup, deployment, database maintenance, Google Drive, and the data model.

Start at the [project README](../README.md) for a one-page overview. Use this hub to pick the right deep guide.

---

## How to use these docs

| If you want to… | Open |
|-----------------|------|
| Run the app for the first time | [§1 Quick start](#1-quick-start) → [Development](DEVELOPMENT.md) |
| Understand the system | [Architecture](ARCHITECTURE.md) → [Flows](FLOWS.md) |
| Ship a release | [§2 Release checklist](#2-release-checklist) → [scripts/README](../scripts/README.md) |
| Change schema / tables | [Data tables](DATA_TABLES.md) · [DSR tables](DSR_TABLES.md) |
| Set up supplier invoice PDFs | [Invoice documents](INVOICE_DOCUMENTS.md) |
| Automate prod DB backups to Drive | [Backup](BACKUP.md) |
| Fix a common failure | [§4 Troubleshooting](#4-troubleshooting) |

---

## 1. Quick start

### Step 1 — Configure Supabase

```bash
cp js/env.example.js js/env.js
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` from Supabase → **Project Settings → API**.  
Apply `supabase/schema.sql` (or migrations in filename order).

### Step 2 — Start the app

```bash
npm run dev
```

Open **http://localhost:3000**.

### Step 3 — Create the first admin

1. Supabase → **Authentication → Users** → add email/password.
2. Insert into `public.users` with role `admin` (see [README](../README.md#1-quick-start-local)).

Without step 3, login works but RLS returns empty data.

**More detail:** [Development §1](DEVELOPMENT.md#1-local-development)

---

## 2. Release checklist

| # | Command / action | Prod impact |
|---|------------------|-------------|
| 1 | `./scripts/db.sh sync` | None (read-only); staging data replaced |
| 2 | Push / merge to `staging` | Staging site updated |
| 3 | `./scripts/db.sh migrate` | None (preflight only) |
| 4 | `./scripts/db.sh migrate --apply` | Schema write — use a quiet window |
| 5 | Merge `staging` → `main` | Production frontend live |

**Before step 4:** optional `./scripts/db.sh backup` or confirm monthly Drive backup is healthy.

**Edge functions:** pushes that change `supabase/functions/**` deploy via Actions (secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`). Manual alternative in [Development §2.5](DEVELOPMENT.md#25-edge-functions).

```
feature → staging (test) → migrate --apply → main (live)
```

---

## 3. Documentation library

### Setup and operations

| Document | Contents |
|----------|----------|
| [Development](DEVELOPMENT.md) | Local setup, GitHub Pages, environments, edge functions, supervisor onboarding |
| [scripts/README](../scripts/README.md) | `db.sh` sync / migrate / backup — internals and errors |
| [Backup](BACKUP.md) | Monthly prod dump → Google Drive, restore, OAuth secrets |
| [Invoice documents](INVOICE_DOCUMENTS.md) | Supplier PDFs → Drive, edge function API, Settings |

### Product and data

| Document | Contents |
|----------|----------|
| [Architecture](ARCHITECTURE.md) | Stack, folders, security matrix, deployment overview |
| [Flows](FLOWS.md) | Auth, daily ops, credit, day closing, billing, HR |
| [Data tables](DATA_TABLES.md) | Tables, columns, RLS, RPC index |
| [DSR tables](DSR_TABLES.md) | Meter tables, views, stock reconciliation math |

### Contributing

| Document | Contents |
|----------|----------|
| [Contributing](../CONTRIBUTING.md) | Branch model, PRs, what not to commit |
| [PR template](../.github/pull_request_template.md) | Checklist for pull requests |

---

## 4. Troubleshooting

| Symptom | Likely cause | Where to fix |
|---------|--------------|--------------|
| Login OK, empty pages | No `public.users` row | [Development §1.4](DEVELOPMENT.md#14-first-login) |
| Stale UI after deploy | Service worker cache | Hard-refresh; bump `CACHE_VERSION` in `sw.js` |
| Staging looks wrong | Wrong env secrets | GitHub **staging** → `SUPABASE_URL` / `SUPABASE_ANON_KEY` |
| `migrate` / dump connection errors | Direct DB URL instead of pooler | Use **Session pooler** URI in `scripts/db.env` |
| Backup: `unauthorized_client` | OAuth client ≠ refresh token | [Backup §10](BACKUP.md#10-troubleshooting) · [README §4](../README.md#4-google-drive-invoices--db-backups) |
| Invoice upload fails | Drive secrets or Settings folder | [Invoice documents §11](INVOICE_DOCUMENTS.md#11-troubleshooting) |
| Edge function 404 | Not deployed | [Development §2.5](DEVELOPMENT.md#25-edge-functions) |

---

## 5. Secrets cheat sheet

| Secret | Location | Used for |
|--------|----------|----------|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | GitHub **staging** + **prod** | Pages deploy (`js/env.js`) |
| `PROD_DB_URL`, `STAGING_DB_URL` | Local `scripts/db.env` (gitignored) | sync / migrate / backup |
| `PROD_DB_URL` | GitHub **prod** | Automated Drive backup |
| `GOOGLE_OAUTH_*` (three values) | GitHub **prod** + Supabase Edge secrets | Drive upload (backup + invoices) |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | GitHub **prod** only | DB backup folder |
| Invoice root folder ID | App **Settings → Integrations** | Invoice PDF folders |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | GitHub staging + prod | Edge function deploy |

Never commit `js/env.js`, `scripts/db.env`, OAuth tokens, or database dumps.

---

## 6. Page map (operators)

| Page | Role | Purpose |
|------|------|---------|
| `meter-reading.html` | admin, supervisor | Enter MS/HSD meter readings |
| `dsr.html` | admin, supervisor | DSR listing and stock summary |
| `credit.html` | admin, supervisor | Ledger, payments, outstanding |
| `expenses.html` | admin, supervisor | Daily expenses |
| `day-closing.html` | admin, supervisor | Close the day; night-cash collection |
| `billing.html` | admin, supervisor | Outward lube invoices |
| `invoices.html` | admin, supervisor | Supplier invoice PDFs |
| `attendance.html` / `salary.html` | admin, supervisor | HR recording |
| `staff.html` | admin | Employee roster |
| `reports.html` / `analysis.html` / `settings.html` | admin | Reports, BI, configuration |

Legacy redirects: `sales-daily.html` → DSR; `credit-overdue.html` / `credit-customer.html` → credit tabs.

---

## Conventions

| Topic | Source of truth |
|-------|-----------------|
| Schema | `supabase/schema.sql` + `supabase/migrations/` |
| Human table reference | [Data tables](DATA_TABLES.md) |
| DB scripts | [scripts/README](../scripts/README.md) |
| Deploy & local setup | [Development](DEVELOPMENT.md) |
| Project entry | [../README.md](../README.md) |
