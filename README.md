# Bishnupriya Fuels

Daily operations, finance, and HR for a BPCL fuel station.

| | |
|--|--|
| **Stack** | HTML/JS · Supabase (Postgres, Auth, RLS) · GitHub Pages · service worker |
| **Production** | `main` → site root |
| **Staging** | `staging` → `/staging/` |
| **Roles** | `admin` (full) · `supervisor` (operations; no settings, reports, analysis, or staff roster edits) |
| **Schema** | `supabase/schema.sql` |

**Documentation hub:** [docs/README.md](docs/README.md)

---

## Features

| Area | What it covers |
|------|----------------|
| Meter reading | Daily MS/HSD nozzle readings (`meter-reading.html`) |
| DSR | Stock reconciliation and daily listing (`dsr.html`) |
| Credit | Customer ledger, FIFO payments, prepaid overpayment, outstanding |
| Day closing | Night cash, phone pay, short carry-forward, night-cash collection |
| Billing | Outward lube/accessory invoices (GST) |
| Invoice documents | Inward supplier PDFs in Google Drive |
| Expenses | Daily expenses by category |
| Reports / Analysis | DSR, GST, trading, P&L, KPIs *(admin)* |
| HR | Staff roster, attendance, salary, PF slips |
| Settings | Station config, users, products, integrations *(admin)* |

---

## 1. Quick start (local)

**Prerequisites:** Node.js, a Supabase project, schema applied (`supabase/schema.sql` or migrations in order).

### Step 1 — Configure

```bash
cp js/env.example.js js/env.js
```

Edit `js/env.js` with values from Supabase → **Project Settings → API**:

```javascript
window.__APP_CONFIG__ = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
  APP_ENV: "development",
};
```

### Step 2 — Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Step 3 — Provision the first admin

1. Supabase → **Authentication → Users** → create email + password.
2. Add the app role (Auth alone is not enough):

```sql
insert into public.users (email, role)
values ('you@example.com', 'admin')
on conflict (email) do update set role = 'admin';
```

Full detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## 2. Everyday commands

| Goal | Command |
|------|---------|
| Run locally | `npm run dev` |
| Build site mirror | `npm run build:site` |
| Copy prod data → staging | `./scripts/db.sh sync` |
| Review migrations (safe) | `./scripts/db.sh migrate` |
| Apply prod migrations | `./scripts/db.sh migrate --apply` |
| Local prod backup | `./scripts/db.sh backup` |
| Prod backup → Google Drive | `./scripts/backup-prod-to-drive.sh` |
| DB help | `./scripts/db.sh help` |

One-time DB credentials:

```bash
cp scripts/db.env.example scripts/db.env
# Set PROD_DB_URL and STAGING_DB_URL (Session pooler, port 5432)
```

---

## 3. Release to production

Run in this order:

| Step | Action | Effect |
|------|--------|--------|
| 1 | `./scripts/db.sh sync` | Prod data onto staging (prod read-only) |
| 2 | Push `staging` | Test at `/staging/` |
| 3 | `./scripts/db.sh migrate` | Dry-run / review (no prod writes) |
| 4 | `./scripts/db.sh migrate --apply` | Quiet window; auto-backup then schema upgrade |
| 5 | Merge `staging` → `main` | Frontend goes live |

Deploy also runs from Actions → **Deploy** (`staging` or `prod`). Needs environment secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

When `supabase/functions/**` changes, Actions deploys edge functions (needs `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`).

---

## 4. Google Drive (invoices + DB backups)

| Feature | Guide | Folder config |
|---------|-------|---------------|
| Supplier invoice PDFs | [docs/INVOICE_DOCUMENTS.md](docs/INVOICE_DOCUMENTS.md) | App → **Settings → Integrations** |
| Monthly DB backups | [docs/BACKUP.md](docs/BACKUP.md) | GitHub secret `GOOGLE_DRIVE_BACKUP_FOLDER_ID` |

Both share the same OAuth client and Gmail account. Store these three secrets in **GitHub prod** and **Supabase Edge Function secrets**:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

**Get a matching refresh token**

1. Enable **Google Drive API** in Google Cloud.
2. Create an OAuth client (**Web application**).
3. Add redirect URI: `https://developers.google.com/oauthplayground`
4. Open [OAuth Playground](https://developers.google.com/oauthplayground) → gear → **Use your own OAuth credentials** → paste Client ID + Secret.
5. Authorize scope `https://www.googleapis.com/auth/drive` → exchange code → copy the refresh token.
6. Update all three secrets together (they must match).

**If backup fails with `unauthorized_client`:** the refresh token was issued for a different client. Regenerate with step 4 enabled, then update all three secrets and re-run. Verify:

```bash
curl -sS -X POST "https://oauth2.googleapis.com/token" \
  -d "client_id=$GOOGLE_OAUTH_CLIENT_ID" \
  -d "client_secret=$GOOGLE_OAUTH_CLIENT_SECRET" \
  -d "refresh_token=$GOOGLE_OAUTH_REFRESH_TOKEN" \
  -d "grant_type=refresh_token"
```

Success returns an `access_token`.

---

## 5. Documentation map

| Document | Use when you need… |
|----------|-------------------|
| [docs/README.md](docs/README.md) | Full documentation index and how-to paths |
| [Architecture](docs/ARCHITECTURE.md) | Folders, security, components |
| [Development](docs/DEVELOPMENT.md) | Setup, GitHub Pages, edge functions, supervisors |
| [Flows](docs/FLOWS.md) | Page → data journeys |
| [Data tables](docs/DATA_TABLES.md) | Tables, RLS, RPCs |
| [DSR tables](docs/DSR_TABLES.md) | Meter readings and stock math |
| [Invoice documents](docs/INVOICE_DOCUMENTS.md) | Supplier PDFs → Google Drive |
| [Backup](docs/BACKUP.md) | Prod DB → Drive, restore, troubleshooting |
| [scripts/README.md](scripts/README.md) | DB script internals |
| [Contributing](CONTRIBUTING.md) | Branch and PR workflow |

---

## Roadmap

| Area | Direction |
|------|-----------|
| Frontend | Framework migration (React / Vue / Svelte) |
| Offline | Fuller PWA + background sync |
| Multi-site | Multi-tenancy for multiple pumps |
| Live data | Supabase Realtime on dashboard |
| Mobile | Native or cross-platform operator app |
