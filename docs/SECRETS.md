# Secrets inventory

One map of every credential this app needs, where it lives, and how to rotate it.

**Never commit:** `js/env.js`, `scripts/db.env`, dump folders, OAuth tokens, service-role keys.

---

## Quick map

| Secret | Stored in | Used by | Rotate / source |
|--------|-----------|---------|-----------------|
| `SUPABASE_URL` | GitHub env **prod** / **staging** | Deploy → `js/env.js` | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | GitHub env **prod** / **staging** | Deploy → `js/env.js` | Same (anon/public key) |
| Local `js/env.js` | Laptop only (gitignored) | `npm run dev` | Copy from `js/env.example.js` |
| `PROD_DB_URL` | GitHub **prod** + local `scripts/db.env` | Backup, migrate, sync (read) | Supabase → Connect → **Session pooler** `:5432` |
| `STAGING_DB_URL` | Local `scripts/db.env` only | Sync (write) | Staging project → Session pooler |
| `SUPABASE_ACCESS_TOKEN` | GitHub env **prod** / **staging** | Deploy Edge Functions | [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_REF` | GitHub env **prod** / **staging** | Deploy Edge Functions | Project Settings → General |
| `GOOGLE_OAUTH_CLIENT_ID` | GitHub **prod** + Supabase Edge secrets | Drive backup + invoices | Google Cloud Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same | Same | Same |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Same | Same | Regenerate with **matching** client ID/secret |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | GitHub **prod** | DB backup upload | Drive folder URL after `/folders/` |
| Invoice Drive folder / roots | Supabase Edge Function secrets | `invoice-documents` | See [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| `GODADDY_API_KEY` | GitHub repo secrets (optional) | DNS sibling auto-fix | [developer.godaddy.com/keys](https://developer.godaddy.com/keys) |
| `GODADDY_API_SECRET` | Same | Same | Same |

---

## By location

### A. Laptop (gitignored)

| File | Contents |
|------|----------|
| `js/env.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV` |
| `scripts/db.env` | `PROD_DB_URL`, `STAGING_DB_URL` |

Templates: `js/env.example.js`, `scripts/db.env.example`.

Password in DB URLs: URL-encode (`@` → `%40`, `#` → `%23`). Use **Session pooler**, not Direct.

### B. GitHub Environments

**Settings → Environments → prod / staging**

| Secret | staging | prod |
|--------|:-------:|:----:|
| `SUPABASE_URL` | ✓ | ✓ |
| `SUPABASE_ANON_KEY` | ✓ | ✓ |
| `SUPABASE_ACCESS_TOKEN` | ✓ | ✓ |
| `SUPABASE_PROJECT_REF` | ✓ | ✓ |
| `PROD_DB_URL` | | ✓ |
| `GOOGLE_OAUTH_*` (3) | | ✓ |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | | ✓ |

Repo-level (required on `petrolpump` for the hourly DNS job; optional on `fns-cashline` for manual runs): `GODADDY_API_KEY`, `GODADDY_API_SECRET` — see [OPERATIONS.md](OPERATIONS.md#dns-safety-net-fnsventuresin).

### C. Supabase Edge Function secrets

Dashboard → Edge Functions → Secrets (per project). Used by `invoice-documents` (Google OAuth + Drive paths). **Not** the same place as GitHub secrets — see [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md).

Do **not** put the service-role key in the frontend. Anon key in `env.js` is expected; RLS protects data.

---

## Minimum to operate

| Goal | Secrets required |
|------|------------------|
| Deploy website | `SUPABASE_URL` + `SUPABASE_ANON_KEY` (that env) |
| Sync / migrate / local backup | `scripts/db.env` (`PROD_DB_URL` + `STAGING_DB_URL`) |
| Drive backup (Actions) | Prod: `PROD_DB_URL` + Google OAuth trio + folder ID |
| Deploy edge functions | `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` |
| Invoice PDF upload | Edge secrets on Supabase (see invoice guide) |
| DNS auto-fix | `GODADDY_*` |

---

## Rotation recipes

### Supabase anon key or URL changed

1. Update GitHub env secrets for **prod** and/or **staging**.
2. Re-run Actions → **Deploy** for that environment (regenerates `js/env.js` on `gh-pages`).
3. Update local `js/env.js` if you develop against that project.
4. Hard-refresh the site (service worker may cache HTML).

### Database password changed

1. Update Session pooler URI in `scripts/db.env`.
2. Update GitHub **prod** secret `PROD_DB_URL`.
3. Re-test: `./scripts/db.sh backup` (read-only).

### Google OAuth `unauthorized_client`

All three OAuth values must be regenerated **together** (Playground: “Use your own OAuth credentials”). Update:

1. GitHub **prod** secrets (backup), and  
2. Supabase Edge Function secrets (invoices).

Then re-run backup / try one invoice upload. Details: [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database), [BACKUP.md](BACKUP.md).

### Supabase access token expired

Create a new personal access token → update `SUPABASE_ACCESS_TOKEN` on both environments → re-run **Deploy Supabase functions** if needed.

---

## Related

| Doc | Topic |
|-----|-------|
| [DEVELOPMENT.md](DEVELOPMENT.md) | First-time env wiring |
| [OPERATIONS.md](OPERATIONS.md) | Backup secrets + DNS |
| [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) | Full Google OAuth + Drive setup |
| [BACKUP.md](BACKUP.md) | Restore + OAuth troubleshooting |
