# Recovery

Backups, restore, and what to do when data, schema, the Supabase project, secrets, or hosting is lost.

How to **run** a backup is [OPERATIONS.md → Backup](OPERATIONS.md#4-backup-production-database). Where secrets live is [SECRETS.md](SECRETS.md). Invoice PDFs are a different Drive tree — [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md).

> **Last tested:** 2026-10-06, using `scripts/.prod-backups/prod-schema-20260823-213726.sql` and `prod-data-20260823-213726.sql` (the automatic pre-migrate backup from 2026-08-23). Local restore: all 51 dumped tables matched their row counts, `auth.users` = 6, `public.users` = 6, and every `public.users` row matched an auth user.
> Re-test each quarter ([Restore drill](#restore-drill)) and update this line.

## What a backup is

A whole-database backup is `./scripts/db.sh backup` or `./scripts/backup-prod-to-drive.sh`. The monthly Actions run is a different file: one finished month, as CSV. This section describes the whole-database files.

Each whole-database run dumps production only. Staging is never included. The dump is read-only: no writes, no migrations. It is a **full snapshot**, not an incremental. Any one pair of files can be restored on its own.

| File | Contents |
|------|----------|
| `prod-schema-*.sql.gz` | `public` structure: tables, views, functions, RLS, triggers, grants. No `auth` or `storage` table definitions — those come from the target platform |
| `prod-data-*.sql.gz` | `COPY` data for `public`, `auth`, and `storage`. Starts with `SET session_replication_role = replica` so triggers and foreign keys stay off during load |
| `backup-manifest-*.txt` | Timestamp and DSR row counts. Local `db.sh backup` writes `dsr-counts-snapshot-*.txt` instead |

`public` holds the station: DSR, shift register, credit, billing, expenses, day closing, HR, `pump_settings`, invoice metadata. `auth` holds logins. `storage` holds bucket and object **metadata**. The bytes (avatars, staff photos) are not in the SQL. Invoice PDFs already live on Drive. Edge Function secrets are not dumped. Internal tables such as `storage.buckets_vectors` are excluded (`STORAGE_DUMP_EXCLUDES` in `scripts/lib/constants.sh`).

Zero-byte files are failed attempts. Always pair a schema file and a data file with the **same timestamp**.

## Where copies live

| Source | When | Where | What you get back |
|--------|------|-------|-------------------|
| Actions **Backup production database** | 1st of the month, 03:00 UTC (08:30 IST). 1 November writes October | Drive `YYYY/YYYY-MM/` | That month’s activity. Kept until 1 January, when the year’s full copy replaces them |
| Actions, 1 January | After December is uploaded | Drive `Yearly/YYYY/` | The whole database as it stood at the start of 1 January. This is the copy that remains |
| `./scripts/backup-prod-to-drive.sh` | When you run it | Drive `Manual/<timestamp>/` | The whole database. Not removed by the year-end cleanup |
| `YEAR=2026 ./scripts/backup-year-to-drive.sh` | When you run it for a finished year | Drive `Yearly/2026/`, then trash `2026-01`…`2026-12` | The whole database |
| `./scripts/db.sh migrate --apply` | Every production migration | Laptop `scripts/.prod-backups/` | The whole database, since the last release |
| `./scripts/db.sh backup` | When you run it | Same folder | The whole database |
| Supabase dashboard backups | Plan-dependent | Supabase | Useless if the project itself is gone |

A month folder cannot rebuild logins, customers, or staff. Use `Yearly/`, `Manual/`, or a laptop `prod-schema` / `prod-data` pair for that. After the 1st-of-the-month upload succeeds, the workflow deletes production `audit_log` rows older than 6 months. Month folders are trashed only after `Yearly/YYYY` for that year has uploaded. Trash can be restored for about 30 days. The calendar and the file list: [STORAGE_RETENTION.md](STORAGE_RETENTION.md).

The real recovery point for the whole station is the **newest whole-database file** (`Yearly/`, `Manual/`, or the laptop pair). Before risky work, run `./scripts/backup-prod-to-drive.sh`.

Workflow `.github/workflows/backup-prod-db.yml` uses the `prod` environment, one run at a time. It checks out the repo and installs `postgresql-client` and `jq`. A full or year-end run also installs the Supabase CLI. The runner deletes its temp files. **Only Drive keeps that copy.**

```
Database Backups - Bishnupriya Fuels/
  2026/2026-10/
    dsr_petrol-20261101-030012.csv.gz
    credit_entries-20261101-030012.csv.gz
    month-manifest-20261101-030012.txt
```

Older month folders may still contain a whole-database `prod-schema-*.sql.gz` and `prod-data-*.sql.gz` from before this change. Those files age out with the folder.

`./scripts/backup-prod-to-drive.sh` uses the same dump as `./scripts/db.sh backup`. Local output is `scripts/.prod-backups/` (gitignored): `prod-schema-*.sql`, `prod-data-*.sql`, and a DSR count file.

<a id="setup"></a>

## Setup

Do this once. If invoice upload already works, reuse that OAuth client and refresh token ([INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md#34-create-oauth-client-credentials)).

1. In the same Gmail, create a Drive folder such as `Database Backups - Bishnupriya Fuels`. The ID after `/folders/` in the URL is `GOOGLE_DRIVE_BACKUP_FOLDER_ID`. This folder is not the invoice root in **Settings → Integrations**.
2. Collect `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` (Playground scope `https://www.googleapis.com/auth/drive`). The three values are one set. Rotate them together — [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client).
3. `PROD_DB_URL` is the same Session pooler URI as in `scripts/db.env` — [format](SECRETS.md#a-laptop-gitignored).
4. GitHub → **Settings → Environments → prod**:

| Secret | Value |
|--------|--------|
| `PROD_DB_URL` | Session pooler URI |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth Playground |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Backup folder ID |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` deploy the website. They do not back up the database.

5. With `.github/workflows/backup-prod-db.yml` on the default branch: **Actions → Backup production database → Run workflow**. The first success creates `YYYY/YYYY-MM/` with three files.

From a laptop, export the four Google variables ( `PROD_DB_URL` comes from `scripts/db.env` ) and run `./scripts/backup-prod-to-drive.sh`. Needs the Supabase CLI, `jq`, `curl`, `gzip`, and a PostgreSQL client or Docker.

### A good backup

| Check | Expected |
|-------|----------|
| Actions | **Success**, log says `Done. 3 file(s) uploaded` |
| Drive | Files under `YYYY/YYYY-MM/` |
| Manifest | DSR counts look right; timestamp matches the run |
| Sizes | Schema and data `.sql.gz` are not 0 bytes |

```sql
select count(*) from public.dsr_petrol;
select count(*) from public.dsr_diesel;
```

Symptoms (`unauthorized_client`, empty Drive folder, cron that never fired): [TROUBLESHOOTING.md → Backup](TROUBLESHOOTING.md#backup--google-drive).

The dump does not write to production. `PROD_DB_URL` and Google tokens stay in the GitHub **prod** environment and Supabase Edge secrets — never in `js/env.js`. Treat the Drive folder as production data. Supabase’s own backups, if the plan has them, are an extra copy.

## If something is wrong

| Situation | First move | Then |
|-----------|------------|------|
| Bad migration | Stop releasing. Prefer a forward fix | [Schema rollback](#schema-rollback) |
| Accidental delete or bad UPDATE | Stop writes on that screen. Do not improvise on prod | [Lost rows](#lost-rows) |
| Supabase project gone | New project, latest dump | [Restore](#restore-a-dump), then [After a new project](#after-a-new-project) |
| Secrets leaked | Rotate first, then audit | [Leaked secrets](#leaked-secrets) |
| Pages or DNS down | `./scripts/check-dns-siblings.sh` | [Hosting](#hosting) |

| Step | Drill, 2026-10-06 | New hosted project |
|------|-------------------|--------------------|
| Download and gunzip | — | ~5 min |
| Create the project | — | ~5 min |
| Schema + data (~0.3 MB + ~15.6 MB) | < 1 s local | 1–2 min over the pooler |
| Row counts | ~1 s | ~1 min |
| Secrets, functions, deploy | — | 30–60 min |
| **Total** | 16 s local | **about 1–2 hours** |

<a id="restore-a-dump"></a>

## Restore a dump

Backups come from `scripts/lib/backup.sh` (`supabase db dump`). The helper reads `.sql` or `.sql.gz`.

These rules each come from a real failure ([What the naive restore got wrong](#what-the-naive-restore-got-wrong)):

| | Rule |
|--|------|
| 1 | **psql** with `-v ON_ERROR_STOP=1 --single-transaction`. Without both, psql reports success while skipping whole tables |
| 2 | Schema first, then data |
| 3 | The target already has Supabase `auth` and `storage` schemas **at least as new as prod**. A new hosted project has them. A local container needs GoTrue and Storage migrations (the helper runs them) |
| 4 | Do not use the SQL Editor. The data file is `COPY … FROM stdin` and about 15 MB |
| 5 | The target is **empty**. Never restore over live prod. Partial copies are [Lost rows](#lost-rows) |

```bash
# Drive: BackupRoot/YYYY/YYYY-MM/  or  ls -lt scripts/.prod-backups/
```

### Local (inspect, drill, pull a few rows back)

```bash
./scripts/restore-dump.sh --local \
  scripts/.prod-backups/prod-schema-<ts>.sql \
  scripts/.prod-backups/prod-data-<ts>.sql

docker exec -it restore-pg psql -U postgres -h localhost   # also localhost:55432, password postgres
./scripts/restore-dump.sh --destroy
```

The helper starts `public.ecr.aws/supabase/postgres:17.6.1.063` as `restore-pg` on `127.0.0.1:55432`, runs GoTrue (`gotrue:v2.197.0`) and Storage (`storage-api:v1.33.0`) migrations, loads schema, checks every dumped table exists, loads data, and compares row counts to the `COPY` blocks. Only counts are printed.

If `auth.*` tables are missing, prod’s auth is newer than the image. Example: `GOTRUE_IMAGE=public.ecr.aws/supabase/gotrue:v2.198.0 ./scripts/restore-dump.sh --local …`.

### New Supabase project

1. **New project**, same region (for example `ap-south-1`). Save the database password.
2. **Connect → Session pooler** (`:5432`). Encode the password ([SECRETS.md](SECRETS.md#a-laptop-gitignored)).
3. Restore. The helper refuses if `public` already has tables.

```bash
export NEW_DB_URL='postgresql://postgres.<new-ref>:<pw>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
CONFIRM_RESTORE=yes ./scripts/restore-dump.sh --target-url "$NEW_DB_URL" \
  prod-schema-<ts>.sql.gz prod-data-<ts>.sql.gz
```

Plain psql, same flags and order:

```bash
psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f prod-schema-<ts>.sql
psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f prod-data-<ts>.sql
```

4. `supabase_migrations` is not in the dump, so the new project has no history. Stamp the versions **inside** the backup, then push anything newer:

```bash
supabase migration repair --db-url "$NEW_DB_URL" --status applied <v1> <v2> …
supabase db push --db-url "$NEW_DB_URL" --dry-run   # only migrations newer than the backup
supabase db push --db-url "$NEW_DB_URL"
```

A pre-migrate backup contains everything **before** that release. For a monthly backup, `git log --until=<backup date> -- supabase/migrations` on `main` shows the cut-off.

5. [After a new project](#after-a-new-project).

The 2026-10-06 drill ran the local path end to end. The hosted path uses the same files, flags, and order. It was not run against a remote project (no remote connections during the drill). Expect pooler latency, not different errors.

<a id="after-a-new-project"></a>

## After a new project

None of this is in the SQL dump.

| | Item | Where |
|--|------|-------|
| 1 | Site URL and redirect URLs (`https://bishnupriyafuels.fnsventures.in`, `/staging/`, `localhost`) | Authentication → URL Configuration |
| 2 | Providers, SMTP, templates if you customised them. **Turn off public sign-up.** A restored project may turn it back on | Authentication → Sign In / Up |
| 3 | Log in with an old password (`encrypted_password` is restored). Old sessions die because the JWT secret is new | One admin login |
| 4 | Edge secrets: Google OAuth trio and Drive folders | Edge Functions → Secrets |
| 5 | Deploy `get-dashboard-data`, `get-reports-data`, `get-pl-data`, `invoice-documents`, `drive-files` | Update `SUPABASE_PROJECT_REF`, then Actions → **Deploy Supabase Functions** |
| 6 | Storage **bytes** are gone. Metadata is restored. Copy files from the old project if it is still reachable, or re-upload | Storage |
| 7 | Review `pump_settings` row `id = 1`: integrations, Drive folder IDs, VAT | App → Settings |
| 8 | GitHub **prod**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PROJECT_REF`, `PROD_DB_URL` | [SECRETS.md](SECRETS.md#b-github-environments) |
| 9 | Laptop `scripts/db.env` and `js/env.js` | [SECRETS.md](SECRETS.md#a-laptop-gitignored) |
| 10 | Actions → **Deploy** → `prod` (rewrites `js/env.js`). Hard-refresh | GitHub Actions |
| 11 | Dashboard, DSR, credit, a report, one invoice upload | Live site |
| 12 | Actions → **Backup production database** on the new project | GitHub Actions |

<a id="restore-drill"></a>

## Restore drill

1. Newest non-empty schema + data pair (Drive or `scripts/.prod-backups/`).
2. `./scripts/restore-dump.sh --local <schema> <data>`. Expect `OK: all N dumped tables match.`
3. `public.dsr` (the view) matches the `dsr rows:` line in the manifest.
4. `./scripts/restore-dump.sh --destroy`.
5. Update **Last tested** at the top. If an image is too old, bump the defaults in `scripts/restore-dump.sh`.

2026-10-06 (Supabase CLI 2.72.7, images already pulled): container 4–5 s, GoTrue (75 migrations) ≤ 1 s, Storage 2–3 s, schema < 1 s, data < 1 s, 51 tables ~1 s. **16–17 s.** The first pull adds about 20 s per image.

<a id="lost-rows"></a>

## Lost rows

Use the smallest fix that works.

**A. `public.audit_log`.** Works for audited tables: `credit_*`, `day_closing`, `dsr_petrol`, `dsr_diesel`, `employee_attendance`, `employees`, `expenses`, `invoices`, `meter_shift_*`, `salary_payments`, `users`. Every DELETE or UPDATE stores `old_data`. Tested on the restored copy:

```sql
begin;
select count(*) from public.audit_log
where table_name = 'expenses' and action = 'DELETE'
  and performed_at > '2026-10-06 09:00+05:30';

insert into public.expenses
select (jsonb_populate_record(null::public.expenses, a.old_data)).*
from public.audit_log a
where a.table_name = 'expenses' and a.action = 'DELETE'
  and a.performed_at > '2026-10-06 09:00+05:30'
on conflict (id) do nothing;
-- check counts, then commit;  or rollback;
```

A bad UPDATE is the same pattern: `update … from audit_log` and set columns from `old_data`.

**B. Copy rows from a backup.** For tables without auditing, or losses older than the audit log.

1. Restore the newest good dump locally (above).
2. Export one table:

```bash
docker exec restore-pg pg_dump -U postgres -h localhost --data-only \
  --column-inserts --on-conflict-do-nothing --table=public.<table> postgres > /tmp/<table>-fix.sql
```

3. Trim the file to the rows you need. Test it on **staging**.
4. `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f /tmp/<table>-fix.sql`. Delete the file.

**C. Full restore** only when the damage is widespread. Restore into a **new project** and switch secrets ([After a new project](#after-a-new-project)). Every write since the backup is lost — export anything newer first (B, in reverse). An in-place restore over the live project has not been tested and is not supported.

<a id="leaked-secrets"></a>

## Leaked secrets

| Leaked | Rotate | Then |
|--------|--------|------|
| Database password / `PROD_DB_URL` | Supabase → Database → reset password | `scripts/db.env` and GitHub `PROD_DB_URL` ([SECRETS.md](SECRETS.md#database-password-changed)) |
| Service-role key or JWT secret | Supabase → Settings → API | `SUPABASE_ANON_KEY` everywhere, redeploy ([SECRETS.md](SECRETS.md#supabase-anon-key-or-url-changed)). Everyone signs in again |
| Google OAuth trio | All three together | [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client) |
| `SUPABASE_ACCESS_TOKEN` | Revoke at Account → Access Tokens | [SECRETS.md](SECRETS.md#supabase-access-token-expired) |
| `GODADDY_*` | Revoke at developer.godaddy.com/keys | Update repo secrets |
| A Drive dump | Treat as a full data leak | Rotate the DB password. Restrict sharing |

Then look for unexpected `auth.users` rows, changed `public.users.role` values, and recent `audit_log` entries. Take a fresh backup.

<a id="hosting"></a>

## Hosting

1. `./scripts/check-dns-siblings.sh` (`--fix` if `GODADDY_*` is set). [TROUBLESHOOTING.md → DNS](TROUBLESHOOTING.md#dns--sibling-apps).
2. If DNS is fine, check [githubstatus.com](https://www.githubstatus.com/) and re-run Actions → **Deploy** → `prod`.
3. The database is not on GitHub. A Pages outage does not touch it.
4. A long outage: serve the `gh-pages` branch from any static host, point the CNAME there, and add the origin to Supabase Auth redirect URLs.

<a id="schema-rollback"></a>

## Schema rollback

There are no down-migrations. In order:

| Option | When | Data since the migration |
|--------|------|--------------------------|
| **Forward fix** | Almost always | Kept |
| **Inverse migration** | The change itself must be undone | Kept |
| **Pre-migrate backup** | The migration rewrote data and a forward fix cannot | Lost. Re-enter, or copy rows back ([Lost rows](#lost-rows)) |

### Inverse migration

`supabase/migrations/<YYYYMMDDHHMMSS>_revert_<original_name>.sql`. Test on staging, then the normal release (`./scripts/db.sh migrate`, then `--apply`).

```sql
-- Revert <original_version>_<original_name>.
-- Previous definitions: scripts/.prod-backups/prod-schema-<ts>.sql
-- db push wraps each migration in a transaction.

alter table public.<table> drop column if exists <new_column>;
drop index if exists public.<new_index>;

create or replace function public.<fn>(<args>) returns <type>
language plpgsql security definer set search_path = public as $$
  -- previous body, copied from the dump
$$;

drop policy if exists "<new_policy>" on public.<table>;
create policy "<old_policy>" on public.<table> for <cmd> to authenticated using (<old_expr>);
```

Keep the original file. History should show the change and the revert. `scripts/rollback-buying-price-changes.sql` is a worked preview → apply → verify for a data transform.

`./scripts/db.sh migrate --apply` writes `prod-schema-<ts>.sql`, `prod-data-<ts>.sql`, and `dsr-counts-before-<ts>.txt` to `scripts/.prod-backups/` immediately before `db push`. Use them for a local inspect, a new project, or a single-table copy.

### `supabase migration repair`

```bash
supabase migration repair --db-url "$PROD_DB_URL" --status reverted <version>
supabase migration repair --db-url "$PROD_DB_URL" --status applied  <version>
```

`repair` only edits `supabase_migrations.schema_migrations`. It does not run or undo SQL. Use `reverted` after you have undone the SQL, or when a migration failed and left nothing, so `db push` will try again. Use `applied` to stamp history after a restore. Confirm with `supabase db push --db-url … --dry-run`.

<a id="what-the-naive-restore-got-wrong"></a>

## What the naive restore got wrong

These errors came from `psql -f` schema, then `psql -f` data, against a plain `supabase/postgres` container, using the 2026-08-23 dump.

| | What happened | Fix |
|--|---------------|-----|
| 1 | Schema failed on `auth.jwt()` (policy `users_insert_admin`) because the bare image has a stub `auth` schema. psql still exited 0 | GoTrue migrations first. `ON_ERROR_STOP=1` |
| 2 | Data: 24 errors. Fifteen `auth.*` tables missing, `auth.users` columns missing, `storage.buckets` missing, then COPY rows parsed as SQL. psql exited 0. `public` loaded and **`auth.users` = 0** | Real auth and storage schemas, plus `--single-transaction` |
| 3 | GoTrue **v2.185.0** (what the CLI pinned) still missed `auth.custom_oauth_providers`, `auth.webauthn_challenges`, `auth.webauthn_credentials` | Auth schema ≥ prod. v2.197.0 worked. The helper names missing tables |
| 4 | SQL Editor cannot load `COPY … FROM stdin` at ~15 MB | psql only |
| 5 | Matching three DSR counts in the manifest missed the other tables | The helper checks every table against the dump |
| 6 | No migration history (`supabase_migrations` is not dumped) | `migration repair --status applied` |

Not problems: object owner (`postgres` exists on Supabase), extensions (`pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault` are in the image), and `session_replication_role` (the dump sets it, and `postgres` may).

## Source files

| File | Role |
|------|------|
| `.github/workflows/backup-prod-db.yml` | 1st: finished month, then audit purge. 1 January: also full copy and removal of that year’s month folders |
| `scripts/backup-month-to-drive.sh` | One month of activity, gzipped CSV, upload |
| `scripts/backup-prod-to-drive.sh` | Whole database into `Manual/<timestamp>/` |
| `scripts/backup-year-to-drive.sh` | Whole database into `Yearly/YYYY/`, then trash that year’s month folders |
| `scripts/disable-staging-audit.sh` | Staging only: stop audit and empty `audit_log` |
| `scripts/purge-audit-log.sh` | Delete `audit_log` rows older than 6 months |
| `scripts/prune-drive-backups.sh` | Trash month folders whose year already has `Yearly/YYYY` |
| `scripts/backup-prod.sh` | Local backup |
| `scripts/restore-dump.sh` | Local or new-project restore |
| `scripts/lib/backup.sh` | `supabase db dump` |
| `scripts/lib/google-drive.sh` | OAuth token and upload |
| `scripts/lib/constants.sh` | Storage dump exclusions |
