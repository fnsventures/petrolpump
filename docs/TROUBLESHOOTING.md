# Troubleshooting

Symptom, likely cause, fix. Shipping steps are [OPERATIONS.md](OPERATIONS.md). Credentials are [SECRETS.md](SECRETS.md). Restore is [RECOVERY.md](RECOVERY.md).

---

## Website / login

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Banner: config missing / copy `env.example.js` | DNS or bad `env.js` on Pages | `./scripts/check-dns-siblings.sh` then open `/js/env.js`. If DNS OK → Actions → **Deploy** → `prod`. Hard-refresh after. |
| Login works, every page empty / RLS errors | User not in `public.users` | Auth user **and** a `public.users` row ([START.md → First login](START.md#first-login)) |
| After sync: “Your account is not set up yet” | Prod has no `users.auth_user_id` yet, so the loaded rows are unlinked | Sync runs `scripts/relink-app-users.sql`. To repair a sync that already finished, run that file against staging, then sign in again |
| Staging shows prod data project (or vice versa) | Wrong GitHub env secrets | Check **staging** / **prod** `SUPABASE_URL` + `SUPABASE_ANON_KEY`, redeploy |
| Live site unchanged after merge | Deploy still running, or SW cache | Wait for Actions **Deploy**; hard-refresh / unregister SW |
| Supervisor sees Settings / Reports | Wrong role or cached role | Confirm `public.users.role`; sign out/in |
| Direct URL to admin page blocked | Expected for supervisors | `check_page_access` — use an admin account |

---

## Database scripts

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Sync / migrate cannot connect (`no route to host`, timeout, `tenant/user not found`) | Direct URL, wrong pooler region, or bad password encoding | Use the Session pooler URL — [format](SECRETS.md#a-laptop-gitignored) |
| `supabase db push` refuses: `Found local migration files to be inserted before the last migration on remote` | A migration filename sorts before one already applied (e.g. the `20250602*` files) | `supabase db push --include-all` after reviewing what it will run — [MIGRATIONS.md → Naming](MIGRATIONS.md#naming) |
| Sync OK but photos missing on staging | Expected | Sync does not copy Storage file bytes |
| Migrate says already applied but object missing | Manual stamp / drift | Do not stamp blindly; inspect `supabase_migrations.schema_migrations`; restore from backup if needed |
| Accidental destructive SQL | — | [RECOVERY.md → Lost rows](RECOVERY.md#lost-rows) |
| Docker not running | Dumps need Docker or `libpq` | Start Docker Desktop, or `brew install libpq` |
| `pg_dump version mismatch` | Host `pg_dump` is older than Postgres 17 | Scripts use the `postgres:17` Docker image |
| `must be owner of sequence` on staging truncate | Auth sequences | Fixed in `truncate-staging.sql` (no `RESTART IDENTITY` on auth) |
| `permission denied for buckets_vectors` | Internal storage table | Excluded from dumps in `scripts/lib/constants.sh` |
| `column net_sale of relation dsr` | Legacy prod `dsr` table | Sync transforms it into `dsr_petrol` / `dsr_diesel` |
| `relation "supabase_migrations.schema_migrations" does not exist` | Prod never used `db push` | Preflight treats the count as 0. Review the dry-run before `--apply` |

---

## Backup / Google Drive

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `unauthorized_client` / `Google OAuth token error` | The three OAuth values are not one set | Regenerate them together — [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client) |
| `PROD_DB_URL must be set` / `Missing Google OAuth env` | Prod environment secrets incomplete | [RECOVERY.md → Setup](RECOVERY.md#setup) |
| `Drive upload failed` | Wrong folder ID, or the refresh token lacks the Drive scope | `GOOGLE_DRIVE_BACKUP_FOLDER_ID` is the backup folder, not the invoice root in Settings |
| Workflow green but no files | Wrong folder ID, or the token’s Gmail is a different account | Same |
| Local backup works, Actions fails | Missing GitHub **prod** secrets | [SECRETS.md](SECRETS.md#b-github-environments) |
| Scheduled run never started | GitHub delays cron on free repos | **Run workflow** once to confirm setup |
| Backup succeeded, purge step failed | Migration `20261008150000_audit_log_retention` is not on production yet | Apply it ([OPERATIONS.md](OPERATIONS.md)), then re-run the workflow. The dump on Drive is already safe |
| `Drive list failed` / prune trashed nothing expected | Folder layout is not `YYYY/YYYY-MM/` | Names outside that pattern are left alone. Policy: [STORAGE_RETENTION.md](STORAGE_RETENTION.md) |

Token check (values from the shell, never hard-coded). Success is JSON with `access_token`:

```bash
curl -s https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=${GOOGLE_OAUTH_CLIENT_ID}" \
  --data-urlencode "client_secret=${GOOGLE_OAUTH_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${GOOGLE_OAUTH_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token" | jq 'has("access_token"), .error'
```

Run a backup: [OPERATIONS.md](OPERATIONS.md#4-backup-production-database). What the files contain and how to restore: [RECOVERY.md](RECOVERY.md).

---

## Invoices (supplier PDFs)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Upload fails / Drive errors | Edge secrets or OAuth | [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) troubleshooting sections |
| Function missing, UI partially works | Client fallback | Deploy `invoice-documents` on that Supabase project ([ARCHITECTURE.md → Edge functions](ARCHITECTURE.md#65-edge-functions)) |

---

## DNS / sibling apps

Several apps share `fnsventures.in`. A missing CNAME looks like “configuration missing” because HTML can be cached while `/js/env.js` fails.

```bash
./scripts/check-dns-siblings.sh
./scripts/check-dns-siblings.sh --fix   # needs GODADDY_* secrets
```

Verify:

- `https://bishnupriyafuels.fnsventures.in/js/env.js`
- `https://fnscashline.fnsventures.in/js/env.js`

Details: [OPERATIONS.md — DNS](OPERATIONS.md#dns-safety-net-fnsventuresin).

---

## Edge functions / slow pages

| Function | If missing |
|----------|------------|
| `get-dashboard-data`, `get-reports-data`, `get-pl-data` | Client falls back to direct queries (slower) |
| `invoice-documents` | Drive vault upload/download broken |
| `drive-files` | Billing/letter/staff Drive archive broken |

Deploy via Actions (on `supabase/functions/**` push) or the CLI — [ARCHITECTURE.md → Edge functions](ARCHITECTURE.md#65-edge-functions).

---

## Local development

| Symptom | Fix |
|---------|-----|
| No sidebar/topbar, page unstyled or scripts missing | Source HTML only has `<!-- @partial … -->` comments (invisible). Use `npm run dev` (expands partials), not raw `python3 -m http.server` on source |
| Stale JS/CSS after edit | Hard-refresh; unregister service worker |
| CORS / Auth weirdness | Always serve over `http://localhost` (not `file://`) |

---

## Incident quick paths

| Severity | First move |
|----------|------------|
| Site down / wrong config banner | DNS check → redeploy prod |
| Bad release (frontend only) | Revert merge on `main` or redeploy previous `ref` via Actions |
| Bad migration / data | Stop writes if you can → forward fix or restore ([RECOVERY.md](RECOVERY.md)) |
| OAuth broken | Invoices + backups both affected — rotate OAuth trio ([SECRETS.md](SECRETS.md)) |

---

## Still stuck?

1. GitHub Actions logs for the failing workflow  
2. Supabase → Logs (Auth / Postgres / Edge)  
3. Browser console + Network tab on `/js/env.js` and the failing RPC  
4. [ARCHITECTURE.md](ARCHITECTURE.md) security model if it smells like RLS  
