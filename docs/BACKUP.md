# Production database backup (Google Drive)

Deep reference for **automated / manual prod DB backups** to Google Drive and troubleshooting. **Restore:** [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) (tested runbook).

> **Simple steps first:** [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database)  
> **Local backup only:** `./scripts/db.sh backup`

**Scope:** Production database **schema + row data** only. Staging is never backed up by this workflow.

**Not covered here:** Supplier invoice PDFs — see [Invoice documents](INVOICE_DOCUMENTS.md).

---

## Table of contents

1. [What the backup does](#1-what-the-backup-does)
2. [Three ways to back up prod](#2-three-ways-to-back-up-prod)
3. [Architecture](#3-architecture)
4. [What is included and excluded](#4-what-is-included-and-excluded)
5. [One-time setup](#5-one-time-setup)
6. [How the automated backup runs](#6-how-the-automated-backup-runs)
7. [Manual backup (GitHub or local)](#7-manual-backup-github-or-local)
8. [Verify a backup succeeded](#8-verify-a-backup-succeeded)
9. [Restore from a backup](#9-restore-from-a-backup) → [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)
10. [Troubleshooting](#10-troubleshooting)
11. [Security](#11-security)
12. [Related documentation](#12-related-documentation)

---

## 1. What the backup does

Each backup run:

1. Connects to **production** Postgres (read-only dump — no writes, no migrations).
2. Exports **schema** (tables, views, functions, RLS, etc.) to SQL.
3. Exports **data** from `public`, `auth`, and `storage` schemas to SQL.
4. Records DSR row counts in a small manifest file (sanity check).
5. Compresses SQL files with **gzip**.
6. Uploads to your **Google Drive backup folder** under `YYYY/YYYY-MM/`.

Each run is a **full snapshot** — not incremental. Every monthly file is self-contained and can be restored on its own.

---

## 2. Three ways to back up prod

| Method | Command / trigger | Output location | When to use |
|--------|-------------------|-----------------|-------------|
| **Automated (recommended)** | GitHub Actions — `.github/workflows/backup-prod-db.yml` | Google Drive | Monthly off-site copy; set-and-forget |
| **Manual → Drive** | Actions → **Backup production database** → Run workflow | Google Drive | Ad-hoc backup before a risky change |
| **Local only** | `./scripts/db.sh backup` | `scripts/.prod-backups/` (gitignored) | Before `./scripts/db.sh migrate --apply`; quick local copy |

The Drive upload script (`./scripts/backup-prod-to-drive.sh`) uses the **same dump logic** as `./scripts/db.sh backup`.

Migration (`./scripts/db.sh migrate --apply`) also backs up to `scripts/.prod-backups/` automatically before applying schema changes — but does **not** upload to Drive unless you run the Drive script separately.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  GitHub Actions (prod environment)                                       │
│  .github/workflows/backup-prod-db.yml                                    │
│  • schedule: 1st of month, 03:00 UTC                                     │
│  • workflow_dispatch: manual Run workflow                                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  scripts/backup-prod-to-drive.sh                                         │
│  ├── scripts/lib/backup.sh        → supabase db dump (schema + data)    │
│  ├── scripts/lib/db-client.sh     → psql for DSR counts                 │
│  └── scripts/lib/google-drive.sh  → OAuth + upload                        │
└───────────────┬───────────────────────────────┬─────────────────────────┘
                │ read-only                     │ upload
                ▼                               ▼
┌───────────────────────────┐     ┌───────────────────────────────────────┐
│  Prod Supabase Postgres   │     │  Google Drive (your Gmail)            │
│  Session pooler :5432     │     │  BackupRoot/YYYY/YYYY-MM/*.sql.gz     │
└───────────────────────────┘     └───────────────────────────────────────┘
```

**Secrets flow**

| Secret | Stored in | Used by |
|--------|-----------|---------|
| `PROD_DB_URL` | GitHub **prod** environment | Dump only (read) |
| `GOOGLE_OAUTH_CLIENT_ID` | GitHub **prod** + Supabase Edge Functions | Drive upload |
| `GOOGLE_OAUTH_CLIENT_SECRET` | GitHub **prod** + Supabase Edge Functions | Drive upload |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | GitHub **prod** + Supabase Edge Functions | Drive upload |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | GitHub **prod** only | Target folder for DB backups |

Google OAuth secrets are **shared** with the invoice-documents edge function (same Gmail account). The **backup folder ID** is separate from the invoice root folder configured in Settings.

The frontend and GitHub Pages deploy **never** receive `PROD_DB_URL` or Google OAuth secrets.

---

## 4. What is included and excluded

### Included in each backup

| File | Contents |
|------|----------|
| `prod-schema-*.sql.gz` | Full DB structure: tables, views, indexes, functions, RLS policies, triggers, etc. |
| `prod-data-*.sql.gz` | Row data for schemas **`public`**, **`auth`**, **`storage`** |
| `backup-manifest-*.txt` | Timestamp, UTC capture time, DSR row counts |

**`public` schema** includes all operational data: DSR (`dsr_petrol`, `dsr_diesel`), optional shift register (`meter_shift_readings`, `meter_shift_cash`), credit, billing, expenses, day closing, HR, `pump_settings`, `invoice_documents` metadata, etc.

**`auth` schema** includes user accounts (needed to restore logins). Session/token tables are not required for restore and may be omitted depending on dump behaviour.

**`storage` schema** includes bucket and object **metadata** (paths, permissions). Actual file bytes live in Supabase Storage, not in the SQL dump.

### Excluded (by design)

| Item | Reason |
|------|--------|
| **Supabase Storage file bytes** | Avatars, staff photos — metadata only in dump; re-upload or use Supabase dashboard export if needed |
| **Invoice PDFs in Google Drive** | Already stored separately; not in Postgres |
| **Edge function secrets** | Set manually in Supabase Dashboard |
| **Staging database** | Backup workflow targets prod only |
| **Incremental / delta dumps** | Full snapshot each run — simpler and safer to restore |
| Internal storage tables | e.g. `storage.buckets_vectors` — excluded to avoid permission errors (`STORAGE_DUMP_EXCLUDES` in `scripts/lib/constants.sh`) |

---

## 5. One-time setup

### Step 1 — Google Drive backup folder

1. Sign in to [Google Drive](https://drive.google.com/) with the **same Gmail** used for invoice OAuth.
2. Create a folder, e.g. `Database Backups - Bishnupriya Fuels`.
3. Open the folder. URL format:

   ```
   https://drive.google.com/drive/folders/1abcXYZexampleFolderId
   ```

4. Copy the ID after `/folders/` → this is `GOOGLE_DRIVE_BACKUP_FOLDER_ID`.

This folder is **independent** from the invoice root folder in **Settings → Integrations**.

### Step 2 — Google OAuth credentials

If invoice uploads already work, reuse the same OAuth client and refresh token (setup: [Invoice documents §3.4–3.5](INVOICE_DOCUMENTS.md#34-create-oauth-client-credentials)).

| Secret | Where to get it |
|--------|-----------------|
| `GOOGLE_OAUTH_CLIENT_ID` | [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → OAuth 2.0 Client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same client (reset secret if lost) |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | [OAuth Playground](https://developers.google.com/oauthplayground) — scope `https://www.googleapis.com/auth/drive` |

Lost or mismatched values: [SECRETS.md → Google OAuth](SECRETS.md#google-oauth-unauthorized_client).

### Step 3 — Production database URL

Same Session pooler URI as `PROD_DB_URL` in `scripts/db.env` — format and encoding: [SECRETS.md](SECRETS.md#a-laptop-gitignored).

### Step 4 — GitHub prod environment secrets

Repo → **Settings → Environments → prod → Environment secrets**:

| Secret | Value |
|--------|--------|
| `PROD_DB_URL` | Session pooler URI (step 3) |
| `GOOGLE_OAUTH_CLIENT_ID` | From Google Cloud |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From Google Cloud |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | From OAuth Playground |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Backup folder ID (step 1) |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` (already used for Pages deploy) are **not** enough for backup — you must add the five secrets above.

### Step 5 — Merge workflow and test

Ensure `.github/workflows/backup-prod-db.yml` is on the default branch, then:

**Actions → Backup production database → Run workflow**

First successful run creates `BackupRoot/YYYY/YYYY-MM/` in Drive with three files.

---

## 6. How the automated backup runs

**Workflow file:** `.github/workflows/backup-prod-db.yml`

| Setting | Value |
|---------|--------|
| Schedule | `0 3 1 * *` — **1st of each month, 03:00 UTC** (08:30 IST) |
| Manual trigger | `workflow_dispatch` |
| Environment | `prod` (protected secrets) |
| Concurrency | One backup at a time (`prod-db-backup` group) |

**Runner steps:**

1. Checkout repository
2. Install `postgresql-client`, `jq`
3. Install Supabase CLI
4. Run `bash scripts/backup-prod-to-drive.sh` with prod secrets

**Drive folder layout after a run:**

```
Database Backups - Bishnupriya Fuels/     ← GOOGLE_DRIVE_BACKUP_FOLDER_ID
  2026/
    2026-06/
      prod-schema-20260601-030012.sql.gz
      prod-data-20260601-030012.sql.gz
      backup-manifest-20260601-030012.txt
```

If you run twice in the same month, both sets of files appear in the same `YYYY-MM` folder (different timestamps).

Temp files on the GitHub runner are deleted when the job ends. **Only Google Drive retains the backup.**

---

## 7. Manual backup (GitHub or local)

### From GitHub (uploads to Drive)

1. **Actions → Backup production database**
2. **Run workflow** → branch `main` → **Run workflow**
3. Wait for green checkmark; open job logs for Drive links

### Local → Drive (optional)

Export secrets in your shell (or rely on `scripts/db.env` for `PROD_DB_URL` only):

```bash
export GOOGLE_OAUTH_CLIENT_ID="..."
export GOOGLE_OAUTH_CLIENT_SECRET="..."
export GOOGLE_OAUTH_REFRESH_TOKEN="..."
export GOOGLE_DRIVE_BACKUP_FOLDER_ID="..."
./scripts/backup-prod-to-drive.sh
```

Requires: Supabase CLI, `jq`, `curl`, `gzip`, and PostgreSQL client (or Docker — see [scripts/README.md](../scripts/README.md)).

### Local only (no Drive)

```bash
./scripts/db.sh backup
```

Output: `scripts/.prod-backups/` (gitignored).

---

## 8. Verify a backup succeeded

| Check | Expected |
|-------|----------|
| GitHub Actions job | Status **Success**; log shows `Done. 3 file(s) uploaded` |
| Google Drive | Files under `BackupRoot/YYYY/YYYY-MM/` |
| `backup-manifest-*.txt` | Reasonable DSR counts; timestamp matches run time |
| File sizes | Schema + data `.sql.gz` are non-trivial (not 0 bytes) |

Compare DSR counts to live prod (optional):

```sql
select count(*) from public.dsr_petrol;
select count(*) from public.dsr_diesel;
```

---

## 9. Restore from a backup

Full tested runbook: **[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)** (last drill, scenarios, post-restore checklist, schema rollback).

1. Download a matching `prod-schema-<ts>.sql.gz` + `prod-data-<ts>.sql.gz` pair (Drive `BackupRoot/YYYY/YYYY-MM/` or `scripts/.prod-backups/`). Skip 0-byte files.
2. Restore with the helper (reads `.sql` or `.sql.gz`):

   ```bash
   # Inspect / drill — throwaway Docker container
   ./scripts/restore-dump.sh --local <schema> <data>
   # New, empty Supabase project (Session pooler URI)
   CONFIRM_RESTORE=yes ./scripts/restore-dump.sh --target-url "$NEW_DB_URL" <schema> <data>
   ```

3. The helper verifies every table's row count against the dump. Then work through [DISASTER_RECOVERY.md §4](DISASTER_RECOVERY.md#4-post-restore-checklist-new-project).

| Do not | Why |
|--------|-----|
| Paste into SQL Editor | Data file is `COPY … FROM stdin`, ~15 MB |
| Run `psql -f` without `-v ON_ERROR_STOP=1 --single-transaction` | psql exits 0 while skipping whole tables (drill: `auth.users` came back empty) |
| Restore over live prod | Untested; use a new project or copy back single tables ([DISASTER_RECOVERY.md §6.1](DISASTER_RECOVERY.md#61-accidental-data-delete-or-corruption)) |

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `PROD_DB_URL must be set` | Missing GitHub secret | Add `PROD_DB_URL` to prod environment |
| `Missing Google OAuth env` | OAuth secrets not in GitHub | Add all three OAuth secrets to prod environment |
| `Google OAuth token error` / `unauthorized_client` | Client ID/secret do not match the refresh token, or secret was rotated | Regenerate all three together — [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client). Check with the token test below before re-running |
| `Drive upload failed` | Wrong folder ID or token scope | Verify `GOOGLE_DRIVE_BACKUP_FOLDER_ID`; ensure Drive scope on refresh token |
| `no route to host` / timeout / `tenant/user not found` | Wrong DB URL or pooler region | [TROUBLESHOOTING.md → Database scripts](TROUBLESHOOTING.md#database-scripts) |
| `permission denied for buckets_vectors` | Internal storage table | Already excluded in scripts; update repo if you see this on old workflow |
| Workflow did not run on schedule | GitHub cron delay | Free repos can delay scheduled workflows; use manual **Run workflow** to confirm setup |
| Job succeeds but no files in Drive | Wrong backup folder ID | Confirm folder ID from Drive URL; check Gmail account matches OAuth token |

**OAuth token test** (values from your shell env; never hard-code them). Success returns JSON with `access_token`; failure shows `error`:

```bash
curl -s https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=${GOOGLE_OAUTH_CLIENT_ID}" \
  --data-urlencode "client_secret=${GOOGLE_OAUTH_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${GOOGLE_OAUTH_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token" | jq 'has("access_token"), .error'
```

**Lost OAuth values:** Supabase and GitHub never display stored secrets — regenerate per [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client).

**Invoice folder ID vs backup folder ID:** Settings → Integrations shows the **invoice** root folder. Backups use **`GOOGLE_DRIVE_BACKUP_FOLDER_ID`** in GitHub only — a separate Drive folder.

---

## 11. Security

- **Read-only on prod:** Dumps use `pg_dump` / `supabase db dump` — no `INSERT`, `UPDATE`, `DELETE`, or migrations.
- **Secrets isolation:** `PROD_DB_URL` and Google tokens live in GitHub **prod** environment and/or Supabase Edge secrets — never in the static frontend or `js/env.js`.
- **Separate Drive folder:** DB backups are not mixed with supplier invoice documents.
- **Gitignored local backups:** `scripts/.prod-backups/` and `scripts/db.env` must never be committed.
- **Restore caution:** Backup files contain full prod data (DSR, credit, user emails). Treat Drive folder access like production data access.

Also consider **Supabase Dashboard → Database → Backups** (plan-dependent) before major releases — this Drive backup is an additional copy under your control.

---

## 12. Related documentation

| Document | Description |
|----------|-------------|
| [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) | Tested restore, scenarios, schema rollback |
| [SECRETS.md](SECRETS.md) | Where every secret lives, rotation |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Connection / pooler / OAuth fixes |
| [scripts/README.md](../scripts/README.md) | Command quick reference (`db.sh backup`, migrate backup step) |
| [DEVELOPMENT.md §2](DEVELOPMENT.md#2-deployment-prod-and-staging) | GitHub environments, deploy flow, prod secrets list |
| [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) | Google OAuth setup (shared credentials) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | App structure and Supabase model |
| [DATA_TABLES.md](DATA_TABLES.md) | Tables included in `public` schema dump |
| [STORAGE_RETENTION.md](STORAGE_RETENTION.md) | Free-tier 500 MB: retention, indexes, lean schema |

**Source files**

| File | Role |
|------|------|
| `.github/workflows/backup-prod-db.yml` | Scheduled + manual GitHub workflow |
| `scripts/backup-prod-to-drive.sh` | Dump, gzip, upload orchestration |
| `scripts/backup-prod.sh` | Local-only backup |
| `scripts/restore-dump.sh` | Restore a dump locally or into a new project |
| `scripts/lib/backup.sh` | `supabase db dump` helpers |
| `scripts/lib/google-drive.sh` | OAuth token + Drive upload |
| `scripts/lib/constants.sh` | Storage dump exclusions |
