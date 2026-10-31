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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Supabase Edge secrets (optional) | `invoice-documents`, `drive-files` — used **only if** the OAuth trio is not fully set | Google Cloud → IAM → Service account key (JSON). Needs a Shared Drive — [INVOICE_DOCUMENTS.md §5](INVOICE_DOCUMENTS.md#5-alternative-service-account-workspace--shared-drive) |
| Invoice Drive folder / roots | Settings + Edge secrets | `invoice-documents`, `drive-files` | See [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| `CRON_SECRET` | GitHub env **prod** / **staging** + Supabase Edge secrets (same value) | `weekly-credit-sms` caller check | Any long random string (`openssl rand -hex 32`); change both places together |
| `SMS_GATE_USERNAME` / `SMS_GATE_PASSWORD` | Supabase Edge secrets | `weekly-credit-sms` → SMS Gate cloud API | SMS Gate app on the Android phone → Home → Cloud server credentials |
| `SITE_URL` | Supabase Edge secrets | `weekly-credit-sms` statement link base | Prod `https://bishnupriyafuels.fnsventures.in`; staging adds `/staging` |
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

**DB URL format (canonical — other docs link here):** Supabase → project → **Connect** → **Session pooler** (port **5432**), *not* Direct (Direct is IPv6-only and fails from most laptops and GitHub runners). URL-encode the password (`@` → `%40`, `#` → `%23`). Copy the exact host — a wrong pooler region gives `tenant/user not found`.

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

Dashboard → Edge Functions → Secrets (per project). Used by `invoice-documents` and `drive-files`.

| Secret | Notes |
|--------|-------|
| `GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | Preferred. Wins when all three are set (`resolveDriveAuthMode` in `supabase/functions/_shared/googleDrive.ts`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Fallback when the OAuth trio is incomplete. Full key JSON on one line |
| `CRON_SECRET`, `SMS_GATE_USERNAME`, `SMS_GATE_PASSWORD`, `SITE_URL` | `weekly-credit-sms`. Optional: `SMS_GATE_URL` (local-mode URL), `MIN_BALANCE` (default 1), `MAX_SMS_PER_RUN` (default 90), `STATEMENT_LINK_DAYS` (default 14), `SMS_TEST_TO` (**set on staging**: all SMS go to this number, max 3 a run) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Injected by Supabase automatically — do not set |

If neither OAuth nor the service account is configured, Drive features fail with a configuration error. **Not** the same place as GitHub secrets — see [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md).

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

### JWT secret

The anon key in `js/env.js` is a JWT signed by the project's legacy JWT secret. So is `SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects into Edge Functions. This repo does not check that secret itself. Do one project at a time, staging first. Do not paste the JWT secret or the service-role key into `js/env.js` or GitHub.

Supabase no longer mints a new legacy secret and a new anon key together. Use **Project Settings → JWT Keys**.

**Bring the current secret into signing keys.** Click **Migrate JWT secret**. The current secret is imported and a standby key is created. The website, existing sessions, and the anon key keep working. Stop here if the secret was not leaked and you only wanted it on the new screen.

**Sign new sessions with the standby key.** Click **Rotate keys**. People who are already signed in stay signed in. New tokens use the new key. Leave the old key under **Previously used**. Do not click **Revoke** in the same sitting.

**Revoke is a different step, and this app is not ready for it.** Revoking the legacy secret makes every token it signed fail. That includes the anon key Deploy writes into `js/env.js` and the service-role key the functions use. The dashboard will not issue a replacement legacy anon key. The site and Drive uploads fail until a new key is deployed. Leave the legacy secret in **Previously used** unless the secret is actively leaked and a replacement key is already in GitHub.

**After a rotate, check the functions.** They are deployed with the platform JWT check left on (`supabase functions deploy` does not turn it off). Open the dashboard, a report, and one invoice upload while signed in. A 401 means that check is still expecting the old signature. In **Edge Functions**, turn **Verify JWT** off for `get-reports-data`, `get-pl-data`, `invoice-documents`, and `drive-files`. Each function still requires the caller's session in its own code.

**If you do revoke** (an active leak only): everyone must sign in again. Copy the API key the project still accepts into GitHub `SUPABASE_ANON_KEY` for that environment, redeploy the website ([anon key or URL changed](#supabase-anon-key-or-url-changed)), and run **Deploy Supabase Functions** so the functions pick up the injected service-role key. `PROD_DB_URL` does not change. The database password is a separate secret.

### Supabase anon key or URL changed

1. Update GitHub env secrets for **prod** and/or **staging**.
2. Re-run Actions → **Deploy** for that environment (regenerates `js/env.js` on `gh-pages`).
3. Update local `js/env.js` if you develop against that project.
4. Hard-refresh the site (service worker may cache HTML).

### Database password changed

1. Update the Session pooler URI in `scripts/db.env` ([format](#a-laptop-gitignored)).
2. Update GitHub **prod** secret `PROD_DB_URL`.
3. Re-test: `./scripts/db.sh backup` (read-only).

### Google OAuth `unauthorized_client`

All three OAuth values must be regenerated **together** (Playground: “Use your own OAuth credentials”). Update:

1. GitHub **prod** secrets (backup), and  
2. Supabase Edge Function secrets (invoices).

Then re-run backup / try one invoice upload. [OPERATIONS.md → Backup](OPERATIONS.md#4-backup-production-database), [RECOVERY.md → Setup](RECOVERY.md#setup).

### Supabase access token expired

Create a new personal access token → update `SUPABASE_ACCESS_TOKEN` on both environments → re-run **Deploy Supabase functions** if needed.

---

First-time laptop files: [START.md](START.md). Drive backup setup: [RECOVERY.md](RECOVERY.md#setup). Invoice OAuth: [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md).
