# Bishnupriya Fuels

Operations web app for Bishnupriya Fuels (Authorized BPCL dealer), a [F&S Ventures](https://fnsventures.in/) company.

**Live** [`main`](https://bishnupriyafuels.fnsventures.in) · **Test** `staging` → `/staging/` · [![Deploy](https://img.shields.io/github/actions/workflow/status/fnsventures/petrolpump/deploy-pages.yml?branch=main&style=flat-square&label=deploy)](https://github.com/fnsventures/petrolpump/actions)

The app is a static HTML/JS site on GitHub Pages, backed by Supabase (Auth, Postgres with RLS, Edge Functions) and Google Drive for PDFs and DB backups. It covers meter readings and DSR (MS/HSD stock), the credit ledger (payments, prepaid, outstanding), day closing (night cash, phone pay, short, collection), outward GST billing and the inward supplier-invoice vault, expenses, HR (attendance, salary), and admin reports.

The day-to-day playbook is [OPERATIONS.md](docs/OPERATIONS.md). If you're maintaining this without Cursor, start with [ONBOARDING.md](docs/ONBOARDING.md), then [SECRETS.md](docs/SECRETS.md) and [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

<a id="1-architecture"></a>
<a id="visual-tour"></a>

## 1 · Architecture

Pages flow `index.html` → `login.html` → `dashboard.html`. Access comes from Supabase Auth plus the user's role in `public.users`. Layout, security, and the file tree: [ARCHITECTURE.md](docs/ARCHITECTURE.md). Diagrams: [docs index → Visual assets](docs/README.md#visual-assets).

<a id="2-sync-staging--production-data"></a>
<a id="3-release"></a>
<a id="4-backup--google-drive"></a>
<a id="4-google-drive-invoices--db-backups"></a>

## 2 · Sync, release, backup

| Task | Command / action | Details |
|------|------------------|---------|
| Sync prod data into staging (prod is read-only; staging data is **replaced**; neither site is deployed) | `./scripts/db.sh sync` | [OPERATIONS §1](docs/OPERATIONS.md#1-sync-staging-with-production-data) |
| Apply migrations on staging only (staging data kept) | `supabase db push --db-url "$STAGING_DB_URL"` | [OPERATIONS](docs/OPERATIONS.md#apply-migrations-to-staging-only) |
| Release | A sync *(optional)* → B push/merge to `staging` → C `./scripts/db.sh migrate --apply` *(if schema changed)* → D merge `staging` → `main` | [OPERATIONS §3](docs/OPERATIONS.md#3-release-to-production) |
| Backup to Drive | Actions → **Backup production database** | [OPERATIONS §4](docs/OPERATIONS.md#4-backup-production-database), [BACKUP.md](docs/BACKUP.md) |
| Backup locally | `./scripts/db.sh backup` | [BACKUP.md](docs/BACKUP.md) |

Supplier invoices and other PDFs go to Google Drive through Supabase Edge Functions. Setup is in [INVOICE_DOCUMENTS.md](docs/INVOICE_DOCUMENTS.md).

<a id="5-run-locally"></a>
<a id="run-locally"></a>

## 3 · Run locally

```bash
# Node 22 (see .nvmrc)
cp js/env.example.js js/env.js   # Supabase URL + anon key
npm ci
npm run dev                      # http://localhost:3000
```

Create the user in Supabase **Auth**, then add them to `public.users` as `admin`. More: [DEVELOPMENT.md](docs/DEVELOPMENT.md); the full day-1 guide is [ONBOARDING.md](docs/ONBOARDING.md).

<a id="6-features"></a>
<a id="features"></a>
<a id="7-docs"></a>
<a id="docs"></a>

## 4 · Docs

[**docs/README.md**](docs/README.md) is the full index. The most-used guides:

| Doc | Purpose |
|-----|---------|
| [Onboarding](docs/ONBOARDING.md) | Day 1; maintaining without Cursor |
| [Operations](docs/OPERATIONS.md) | Sync, deploy, release, backup |
| [Secrets](docs/SECRETS.md) / [Troubleshooting](docs/TROUBLESHOOTING.md) | Credentials; common failures |
| [Architecture](docs/ARCHITECTURE.md) / [Flows](docs/FLOWS.md) / [Data tables](docs/DATA_TABLES.md) | Structure, page → data, schema and RLS |
| [Development](docs/DEVELOPMENT.md) / [Migrations](docs/MIGRATIONS.md) | Local setup; schema changes |
| [Backup](docs/BACKUP.md) / [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Drive backups and restore; supplier PDFs |
| [Checklists](docs/CHECKLISTS.md) | Add a page / migration / edge function / user |
| [Disaster recovery](docs/DISASTER_RECOVERY.md) | Tested restore, schema rollback |
| [Contributing](CONTRIBUTING.md) / [CLAUDE.md](CLAUDE.md) | Branch, PR, CI checks; agent rules |

<a id="8-license"></a>
<a id="license"></a>

## 5 · License

Proprietary, not open source. **Copyright © 2024–2026 [F&S Ventures](https://fnsventures.in/).** All rights reserved. Use is limited to authorized personnel and contractors for Bishnupriya Fuels' internal operations. Copying, redistribution, sublicensing, and public disclosure are not permitted. Production and personal data must stay in approved systems (DPDP Act and IT Act apply). The governing law is that of India. The full terms are in [`LICENSE`](LICENSE).
