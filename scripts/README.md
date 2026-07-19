# Database maintenance scripts

Scripts for sync, migrate, and backup.

> **Day-to-day steps:** [docs/OPERATIONS.md](../docs/OPERATIONS.md)  
> **This file:** tool setup, what each script does internally, and error messages.

Prod data sync is always **read-only** on production.
---

## Quick reference

| Goal | Command | Prod | Staging |
|------|---------|------|---------|
| Test with real prod data on `/staging/` | `./scripts/db.sh sync` | read only | **replaced** |
| Check prod before migration | `./scripts/db.sh migrate` | no change | — |
| Same as migrate (alias) | `./scripts/db.sh preflight` | no change | — |
| Backup prod to local files | `./scripts/db.sh backup` | no change | — |
| Backup prod → Google Drive | `./scripts/backup-prod-to-drive.sh` | no change | — |
| Upgrade prod schema (release) | `./scripts/db.sh migrate --apply` | **schema** | — |

**Entry point:** `./scripts/db.sh help`

---

## One-time setup

### 1. Tools

- [Supabase CLI](https://supabase.com/docs/guides/cli): `brew install supabase/tap/supabase`
- **Docker Desktop** running (used for `pg_dump` / `psql` when not installed locally), **or** `brew install libpq` and add to `PATH`

### 2. Credentials

```bash
cp scripts/db.env.example scripts/db.env
```

Edit `scripts/db.env`:

| Variable | Project | Used by |
|----------|---------|---------|
| `PROD_DB_URL` | petrol pump | sync (read), migrate, backup |
| `STAGING_DB_URL` | petrol pump staging | sync (write) |

Get URIs from **Supabase → Connect → Session pooler (5432)**.  
URL-encode the password (`@` → `%40`).

Legacy env files (`sync-prod-to-staging.env`, `migrate-prod.env`) still work if `db.env` is missing.

---

## Release workflow

Follow **[docs/OPERATIONS.md](../docs/OPERATIONS.md)** — short numbered steps for sync, deploy, migrate, and go-live.

Do not use a second checklist here; this file only explains script behaviour.
---

## Commands in detail

### `./scripts/db.sh sync`

**Purpose:** Mirror production **data** into staging so you can test the new app with real DSR, credit, HR, etc.

**Runs:** `sync-prod-to-staging.sh`

| Step | Action |
|------|--------|
| 1 | Stamp staging migrations + `db push` (schema only on staging) |
| 2 | Dump prod auth, public, storage, legacy `dsr` if needed |
| 3 | Truncate staging |
| 4 | Load dumps; split legacy `dsr` → `dsr_petrol` / `dsr_diesel` when prod still uses old schema |

**Output:** `scripts/.sync-dumps/` (gitignored)

**Does not copy:** storage file bytes (photos), session tokens, edge function secrets.

---

### `./scripts/db.sh migrate`

**Purpose:** Safe preflight — shows migration status and dry-run. **No prod changes.**

**Runs:** `migrate-prod.sh` (without `CONFIRM_PROD_MIGRATE`)

---

### `./scripts/db.sh migrate --apply`

**Purpose:** Upgrade **production schema** to match repo migrations (same target as staging).

**Runs:** `migrate-prod.sh` with confirmation flag

| Step | Action |
|------|--------|
| 1 | Preflight SQL + migration counts |
| 2 | Dry-run |
| 3 | Backup schema + data → `scripts/.prod-backups/` |
| 4 | `supabase db push` on prod (includes DSR split if legacy table) |
| 5 | Verification SQL + DSR row count snapshot |

Run during a **quiet window** (no DSR / day closing entries).

**Do not** run `stamp-staging-migrations.sql` on prod (it marks DSR-split migrations as done without running them).

For **legacy prod** (built before migration tracking: `users` table, legacy `dsr` table), `migrate-prod.sh` auto-runs `stamp-prod-migrations.sql` to mark pre-split migrations as applied, then `db push` runs from `split_dsr_petrol_diesel` onward.

---

### `./scripts/db.sh backup`

**Purpose:** Standalone prod backup without migrating.

**Runs:** `backup-prod.sh`

**Output:** `scripts/.prod-backups/`

- `prod-schema-YYYYMMDD-HHMMSS.sql`
- `prod-data-YYYYMMDD-HHMMSS.sql`
- `dsr-counts-snapshot-YYYYMMDD-HHMMSS.txt`

Also use **Supabase Dashboard → Database → Backups** before major releases.

---

### `./scripts/backup-prod-to-drive.sh`

**Purpose:** Dump prod schema + data, gzip, and upload to Google Drive. Same dumps as `./scripts/db.sh backup`.

**Full documentation:** [docs/BACKUP.md](../docs/BACKUP.md) — setup, architecture, included/excluded data, verify, restore, troubleshooting.

**Quick reference:**

- **Automated:** `.github/workflows/backup-prod-db.yml` — 1st of month 03:00 UTC + manual **Run workflow**
- **Local:** `./scripts/backup-prod-to-drive.sh` (export Google secrets + `GOOGLE_DRIVE_BACKUP_FOLDER_ID`; `PROD_DB_URL` from `scripts/db.env`)
- **Drive layout:** `BackupRoot/YYYY/YYYY-MM/` → `prod-schema-*.sql.gz`, `prod-data-*.sql.gz`, `backup-manifest-*.txt`

---

## Script files

| File | Role |
|------|------|
| `db.sh` | Main entry point (sync / migrate / backup) |
| `sync-prod-to-staging.sh` | Prod → staging data copy |
| `migrate-prod.sh` | Prod schema migration |
| `backup-prod.sh` | Prod-only backup (local files) |
| `backup-prod-to-drive.sh` | Prod backup + Google Drive upload |
| `lib/google-drive.sh` | OAuth + Drive upload helpers |
| `db.env.example` | Connection URL template |
| `lib/db-client.sh` | Shared psql / Docker helpers |
| `lib/env.sh` | Load `db.env` |
| `lib/backup.sh` | Backup helpers |
| `lib/constants.sh` | Dump exclude lists |
| `stamp-staging-migrations.sql` | Staging only — marks migrations applied |
| `stamp-prod-migrations.sql` | Legacy prod only — marks pre-DSR-split migrations applied |
| `truncate-staging.sql` | Staging only — clear before import |
| `create-dsr-import-table.sql` | Staging sync — temp legacy dsr import |
| `dsr-import-from-prod.sql` | Staging sync — split into petrol/diesel |
| `migrate-prod-preflight.sql` | Prod checks before migration |
| `migrate-prod-verify.sql` | Prod checks after migration |

---

## Gitignored paths

| Path | Contents |
|------|----------|
| `scripts/db.env` | Database passwords |
| `scripts/.sync-dumps/` | Staging sync dumps |
| `scripts/.prod-backups/` | Prod backups |

Never commit these.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| Docker not running | Start Docker Desktop or `brew install libpq` |
| `no route to host` on `db.*.supabase.co` | Use **Session pooler** URI in `db.env`, not Direct |
| `tenant/user not found` | Wrong pooler region — copy exact URI from **Connect** |
| `pg_dump version mismatch` | Scripts use `postgres:17` Docker image |
| `must be owner of sequence` on staging truncate | Fixed in `truncate-staging.sql` (no RESTART IDENTITY on auth) |
| `permission denied for buckets_vectors` | Internal storage table — excluded from dumps |
| `column net_sale of relation dsr` | Legacy prod `dsr` → auto-transform on sync |
| `relation "supabase_migrations.schema_migrations" does not exist` | Prod never used `supabase db push` before — preflight treats count as 0; review dry-run before `--apply` |

---

## Related docs

- [Operations playbook](../docs/OPERATIONS.md) — sync, deploy, release, backup steps
- [Backup guide](../docs/BACKUP.md) — Drive restore and troubleshooting
- [Development](../docs/DEVELOPMENT.md) — GitHub environments
- [Project README](../README.md)
