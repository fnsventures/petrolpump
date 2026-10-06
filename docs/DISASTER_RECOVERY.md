# Disaster recovery and restore runbook

What to do when production data, schema, project, secrets or hosting is lost or broken. Backups themselves are covered in [BACKUP.md](BACKUP.md). Secret locations are in [SECRETS.md](SECRETS.md).

> **Last tested:** 2026-10-06, using `scripts/.prod-backups/prod-schema-20260823-213726.sql` and `prod-data-20260823-213726.sql` (the automatic pre-migrate backup from 2026-08-23). Local restore drill: all 51 dumped tables matched their row counts, `auth.users` = 6, `public.users` = 6, and every `public.users` row matched an auth user.
> **Re-test quarterly** (see [Restore drill](#5-restore-drill-quarterly)), and update this line each time.

---

## Contents

1. [Scenarios at a glance](#1-scenarios-at-a-glance)
2. [RPO / RTO](#2-rpo--rto)
3. [Restore a dump (tested procedure)](#3-restore-a-dump-tested-procedure)
4. [Post-restore checklist (new project)](#4-post-restore-checklist-new-project)
5. [Restore drill (quarterly)](#5-restore-drill-quarterly)
6. [Scenario runbooks](#6-scenario-runbooks)
7. [Schema rollback](#schema-rollback)
8. [What the untested procedure got wrong](#8-what-the-untested-procedure-got-wrong)

---

## 1. Scenarios at a glance

| Scenario | First move | Runbook |
|----------|-----------|---------|
| Bad migration | Stop releasing. Write a forward fix | [Schema rollback](#schema-rollback) |
| Accidental delete / bad UPDATE | Stop writes to the affected screen. Do **not** run more fixes on prod yet | [6.1](#61-accidental-data-delete-or-corruption) |
| Supabase project lost / unusable | Create a new project and restore the latest dump | [3](#3-restore-a-dump-tested-procedure), then [4](#4-post-restore-checklist-new-project) |
| Secrets leaked | Rotate the leaked secret first, then audit | [6.2](#62-compromised-secrets) |
| GitHub Pages / DNS down | `./scripts/check-dns-siblings.sh` | [6.3](#63-github-pages-or-dns-down) |

---

## 2. RPO / RTO

| Backup source | Frequency | Where | Worst-case data loss (RPO) |
|---------------|-----------|-------|----------------------------|
| GitHub Action **Backup production database** | 1st of month, 03:00 UTC (plus manual runs) | Google Drive `YYYY/YYYY-MM/` | Up to ~31 days |
| Pre-migrate backup (`./scripts/db.sh migrate --apply`) | Every prod migration | Laptop `scripts/.prod-backups/` | Time since the last release |
| `./scripts/db.sh backup` | Manual | Laptop `scripts/.prod-backups/` | Time since you ran it |
| Supabase dashboard backups / PITR | **Plan-dependent** (check Dashboard → Database → Backups) | Supabase | Per plan. Not available if the project itself is lost |

The real RPO is the **newest** of these. Before risky work, run a manual Drive backup to shorten it.

| Step | Measured (2026-10-06 drill) | Realistic for a new project |
|------|----------------------------|-----------------------------|
| Download + gunzip from Drive | — | 5 min |
| Create Supabase project | — | 5 min |
| Schema + data load (~0.3 MB + ~15.6 MB SQL) | < 1 s each (local) | 1–2 min over the pooler |
| Row-count verification | 1 s | 1 min |
| Post-restore checklist (secrets, functions, deploy) | — | 30–60 min |
| **Total (RTO)** | 16 s local, end to end | **about 1–2 h** |

---

## 3. Restore a dump (tested procedure)

Backups are two plain-SQL files from `scripts/lib/backup.sh` (`supabase db dump`):

| File | Contents | Notes |
|------|----------|-------|
| `prod-schema-<ts>.sql` | `public` schema: tables, views, functions, RLS, triggers, grants, extensions | No `auth`/`storage` table definitions. Those come from the target platform |
| `prod-data-<ts>.sql` | `COPY` data for `public`, `auth`, `storage` | Starts with `SET session_replication_role = replica` (no triggers or FK checks during load) |

Files with 0 bytes are failed attempts. Always pick a schema and data file with the **same timestamp**.

**Rules that make it work** (each one comes from a real failure, see [§8](#8-what-the-untested-procedure-got-wrong)):

| # | Rule |
|---|------|
| 1 | Use **psql** with `-v ON_ERROR_STOP=1 --single-transaction`. Without those flags, psql reports success even when it skips whole tables |
| 2 | Load schema first, then data |
| 3 | The target must already have Supabase's `auth` and `storage` schemas **at least as new as prod's**. A new hosted project has them. A local container needs the GoTrue and Storage migrations run first (the helper does this) |
| 4 | Do not use the SQL Editor. The data file uses `COPY … FROM stdin` and is ~15 MB |
| 5 | Target must be **empty**. Never restore over live prod (see [6.1](#61-accidental-data-delete-or-corruption) for partial restores) |

### 3.1 Get the files

```bash
# From Drive: BackupRoot/YYYY/YYYY-MM/ → download prod-schema-*.sql.gz, prod-data-*.sql.gz, backup-manifest-*.txt
# Or local: ls -lt scripts/.prod-backups/
```

The helper reads `.sql` or `.sql.gz` directly, so you do not need to gunzip first.

### 3.2 Local restore (inspection, drill, partial recovery)

```bash
./scripts/restore-dump.sh --local \
  scripts/.prod-backups/prod-schema-<ts>.sql \
  scripts/.prod-backups/prod-data-<ts>.sql

docker exec -it restore-pg psql -U postgres -h localhost   # inspect (also localhost:55432, password postgres)
./scripts/restore-dump.sh --destroy                        # remove container + network
```

The helper does the following:

1. Starts `public.ecr.aws/supabase/postgres:17.6.1.063` (same image as the Supabase CLI) as `restore-pg` on `127.0.0.1:55432`.
2. Runs `gotrue migrate` (`public.ecr.aws/supabase/gotrue:v2.197.0`) and Storage boot migrations (`storage-api:v1.33.0`). These create the real `auth` and `storage` tables.
3. Loads the schema, then checks that every table in the data dump exists, then loads the data. Both loads run single-transaction and stop on error.
4. Compares every table's row count against the `COPY` blocks in the dump. Only counts are printed.

If step 3 reports missing `auth.*` tables, prod's auth has moved ahead. Re-run with a newer image, e.g. `GOTRUE_IMAGE=public.ecr.aws/supabase/gotrue:v2.198.0 ./scripts/restore-dump.sh --local …`.

### 3.3 Restore to a new Supabase project

1. Supabase → **New project** (same region, e.g. `ap-south-1`). Save the DB password.
2. Project → **Connect** → **Session pooler** URI (`:5432`). Encode special characters in the password ([SECRETS.md](SECRETS.md#a-laptop-gitignored)).
3. Restore:

   ```bash
   export NEW_DB_URL='postgresql://postgres.<new-ref>:<pw>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
   CONFIRM_RESTORE=yes ./scripts/restore-dump.sh --target-url "$NEW_DB_URL" \
     prod-schema-<ts>.sql.gz prod-data-<ts>.sql.gz
   ```

   The helper refuses to run if `public` already contains tables. The same steps with plain psql:

   ```bash
   psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f prod-schema-<ts>.sql
   psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f prod-data-<ts>.sql
   ```

4. Rebuild migration history. `supabase_migrations` is **not** in the dump, so the new project has no history:

   ```bash
   # versions already contained in the dump (all migrations up to that release)
   supabase migration repair --db-url "$NEW_DB_URL" --status applied <v1> <v2> …
   supabase db push --db-url "$NEW_DB_URL" --dry-run   # should list only migrations newer than the backup
   supabase db push --db-url "$NEW_DB_URL"             # apply those
   ```

   To find the cut-off, a pre-migrate backup contains everything **before** that release's migrations. For a monthly backup, use `git log --until=<backup date> -- supabase/migrations` against `main`.

5. Work through [§4](#4-post-restore-checklist-new-project).

> The drill tested §3.2 end to end. §3.3 uses the same files, flags and order against a hosted target, but it was not run against a remote project during the drill (no remote connections were allowed). Expect pooler latency, not different errors.

---

## 4. Post-restore checklist (new project)

None of these items are in the SQL dump.

| # | Item | Where |
|---|------|-------|
| 1 | **Auth URL config**: Site URL + redirect URLs (`https://bishnupriyafuels.fnsventures.in`, `/staging/`, `localhost`) | Supabase → Authentication → URL Configuration |
| 2 | Auth providers / SMTP / email templates if customised | Supabase → Authentication |
| 3 | Users can log in with their old passwords (`encrypted_password` is restored). Old sessions are invalid because the JWT secret is new | Test one admin login |
| 4 | **Edge Function secrets**: Google OAuth trio, Drive folder settings | Supabase → Edge Functions → Secrets ([INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md)) |
| 5 | **Deploy edge functions** (`get-dashboard-data`, `get-reports-data`, `get-pl-data`, `invoice-documents`, `drive-files`) | Update `SUPABASE_PROJECT_REF` → Actions → **Deploy Supabase Functions** → Run workflow |
| 6 | **Storage files**: bucket rows and object metadata are restored, file bytes are not. Recreate files from the old project if it is reachable, or re-upload avatars and photos | Supabase → Storage |
| 7 | **`pump_settings`** (row `id = 1`): review integrations, Drive folder IDs, VAT % in **Settings** | App → Settings |
| 8 | **GitHub env secrets (prod)**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PROJECT_REF`, `PROD_DB_URL` | [SECRETS.md](SECRETS.md#b-github-environments) |
| 9 | Laptop: `scripts/db.env` `PROD_DB_URL`, local `js/env.js` | [SECRETS.md](SECRETS.md#a-laptop-gitignored) |
| 10 | **Redeploy site**: Actions → **Deploy** → `prod` (regenerates `js/env.js`). Hard-refresh to clear the service-worker cache | GitHub Actions |
| 11 | Smoke test: dashboard, DSR, credit, a report, one invoice upload | Live site |
| 12 | Take a fresh backup of the new project: Actions → **Backup production database** | GitHub Actions |

---

## 5. Restore drill (quarterly)

1. Pick the newest non-empty schema + data pair (Drive or `scripts/.prod-backups/`).
2. `./scripts/restore-dump.sh --local <schema> <data>`. Expect `OK: all N dumped tables match.`
3. Check that `public.dsr (view)` equals the `dsr rows:` value in the matching `dsr-counts-*` / `backup-manifest-*` file.
4. `./scripts/restore-dump.sh --destroy`.
5. Update **Last tested** at the top of this file. If an image is too old, bump the defaults in `scripts/restore-dump.sh`.

Drill results on 2026-10-06 (Supabase CLI 2.72.7, Docker images pulled beforehand):

| Step | Time |
|------|------|
| Start Postgres container | 4–5 s |
| GoTrue migrate (75 migrations) | ≤ 1 s |
| Storage migrations | 2–3 s |
| Schema load | < 1 s |
| Data load | < 1 s |
| Verify 51 tables | ~1 s |
| **Total** | **16–17 s** |

The first image pull adds about 20 s per image.

---

## 6. Scenario runbooks

### 6.1 Accidental data delete or corruption

Choose the smallest fix that works.

**A. Recover from `public.audit_log`**: works for audited tables (`credit_*`, `day_closing`, `dsr_petrol`, `dsr_diesel`, `employee_attendance`, `employees`, `expenses`, `invoices`, `meter_shift_*`, `salary_payments`, `users`). Every DELETE or UPDATE stores `old_data`. This was tested on the restored copy:

```sql
begin;
-- preview
select count(*) from public.audit_log
where table_name = 'expenses' and action = 'DELETE'
  and performed_at > '2026-10-06 09:00+05:30';

insert into public.expenses
select (jsonb_populate_record(null::public.expenses, a.old_data)).*
from public.audit_log a
where a.table_name = 'expenses' and a.action = 'DELETE'
  and a.performed_at > '2026-10-06 09:00+05:30'
on conflict (id) do nothing;
-- check counts, then: commit;  (or rollback;)
```

To undo a bad UPDATE, use `update … from audit_log` and set columns from `old_data` the same way.

**B. Copy rows back from a backup.** Use this for tables without auditing, or for losses older than the audit log.

1. Restore the newest good dump locally ([§3.2](#32-local-restore-inspection-drill-partial-recovery)).
2. Export only the affected table/rows:

   ```bash
   docker exec restore-pg pg_dump -U postgres -h localhost --data-only \
     --column-inserts --on-conflict-do-nothing --table=public.<table> postgres > /tmp/<table>-fix.sql
   ```

3. Review the file, trim it to the rows you need, and test it on **staging** first.
4. Apply to prod: `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f /tmp/<table>-fix.sql`. Then delete the file.

**C. Full restore.** Use this only if the damage is widespread. Restore into a **new project** ([§3.3](#33-restore-to-a-new-supabase-project)) and switch secrets over ([§4](#4-post-restore-checklist-new-project)). Every write since the backup is lost, so export anything newer first (option B in reverse). An in-place restore over the live project has not been tested and is not supported.

### 6.2 Compromised secrets

| Leaked | Rotate | Then |
|--------|--------|------|
| DB password / `PROD_DB_URL` | Supabase → Database → Settings → Reset password | Update `scripts/db.env` + GitHub `PROD_DB_URL` ([SECRETS.md](SECRETS.md#database-password-changed)) |
| Service-role key or JWT secret | Supabase → Settings → API → rotate JWT secret / keys | Update `SUPABASE_ANON_KEY` everywhere, redeploy ([SECRETS.md](SECRETS.md#supabase-anon-key-or-url-changed)). All users must log in again |
| Google OAuth trio | Regenerate all three together | [SECRETS.md](SECRETS.md#google-oauth-unauthorized_client) |
| `SUPABASE_ACCESS_TOKEN` | Revoke at Account → Access Tokens | [SECRETS.md](SECRETS.md#supabase-access-token-expired) |
| `GODADDY_*` | Revoke at developer.godaddy.com/keys | Update repo secrets |
| A Drive backup folder / dump file | Treat as a full data leak | Rotate the DB password. Restrict Drive sharing. Review who has access |

After any rotation, audit for misuse: check for unexpected rows in `auth.users`, changed `public.users.role` values, and recent `public.audit_log` entries. Take a fresh backup.

### 6.3 GitHub Pages or DNS down

1. `./scripts/check-dns-siblings.sh` (add `--fix` with `GODADDY_*` set). See [TROUBLESHOOTING.md — DNS](TROUBLESHOOTING.md#dns--sibling-apps).
2. If DNS is fine, check [githubstatus.com](https://www.githubstatus.com/). Re-run Actions → **Deploy** → `prod`.
3. Data is not at risk. Supabase is separate, and the app is static.
4. Long Pages outage: serve the `gh-pages` branch from any static host, point the CNAME at it, and add the new origin to Supabase Auth redirect URLs.

---

## Schema rollback

There are **no down-migrations** in `supabase/migrations/`. Rollback options, in order of preference:

| Option | When | Data since migration |
|--------|------|----------------------|
| **1. Forward fix** | Almost always. Fix the bug in a new migration | Kept |
| **2. Inverse migration** | The change itself must be undone (new column/function/policy is wrong) | Kept |
| **3. Restore pre-migrate backup** | The migration destroyed or rewrote data and options 1–2 cannot recover it | **Lost**: re-enter or copy back ([6.1 B](#61-accidental-data-delete-or-corruption)) |

### Inverse migration template

Create `supabase/migrations/<YYYYMMDDHHMMSS>_revert_<original_name>.sql`, test it on staging, then release normally (`./scripts/db.sh migrate` → `--apply`).

```sql
-- Revert <original_version>_<original_name>.
-- Previous definitions copied from the pre-migrate dump:
--   scripts/.prod-backups/prod-schema-<ts>.sql  (grep the function / policy name)
-- db push already wraps each migration in a transaction; no begin/commit needed.

-- Added column / table / index → drop it (check nothing depends on it first)
alter table public.<table> drop column if exists <new_column>;
drop index if exists public.<new_index>;

-- Changed function → restore the previous body verbatim from the dump
create or replace function public.<fn>(<args>) returns <type>
language plpgsql security definer set search_path = public as $$
  -- previous body
$$;

-- Changed policy → drop the new one, recreate the old one from the dump
drop policy if exists "<new_policy>" on public.<table>;
create policy "<old_policy>" on public.<table> for <cmd> to authenticated using (<old_expr>);

-- Data transform → apply the inverse (see scripts/rollback-buying-price-changes.sql
-- for a worked preview → apply → verify example)
```

Keep the original migration file. History should show both the change and its revert.

### Restore from the automatic pre-migrate backup

`./scripts/db.sh migrate --apply` writes `prod-schema-<ts>.sql`, `prod-data-<ts>.sql` and `dsr-counts-before-<ts>.txt` to `scripts/.prod-backups/` just before `db push`. Use them with [§3](#3-restore-a-dump-tested-procedure) (local for inspection, or new project for a full rollback) or [§6.1 B](#61-accidental-data-delete-or-corruption) (copy back specific tables).

### `supabase migration repair`

```bash
supabase migration repair --db-url "$PROD_DB_URL" --status reverted <version>
supabase migration repair --db-url "$PROD_DB_URL" --status applied  <version>
```

`repair` **only edits `supabase_migrations.schema_migrations`** (history). It does not run or undo any SQL. Use `reverted` only after you have undone the SQL by hand, or for a migration that failed and left nothing behind, so that `db push` will run it again. Use `applied` to stamp history after a restore ([§3.3 step 4](#33-restore-to-a-new-supabase-project)). Verify with `supabase db push --db-url … --dry-run`.

---

## 8. What the untested procedure got wrong

These errors came from following the old BACKUP.md §9 literally ("psql -f schema, then psql -f data") against a plain `supabase/postgres` container, using the 2026-08-23 dump.

| # | What happened | Fix |
|---|---------------|-----|
| 1 | Schema: 1 error (`function auth.jwt() does not exist`, policy `users_insert_admin`) because the bare image has only a stub `auth` schema. psql exited 0 | Run GoTrue migrations first. Use `ON_ERROR_STOP=1` |
| 2 | Data: **24 errors**. 15 `auth.*` tables were missing, `auth.users` had missing columns, `storage.buckets` was missing, and COPY rows were then parsed as SQL. psql still exited 0. Result: all `public` data loaded but **`auth.users` = 0**, so nobody could log in | Real auth/storage schemas (GoTrue + Storage migrations) + `ON_ERROR_STOP=1 --single-transaction` |
| 3 | With GoTrue **v2.185.0** (the version the CLI pins), 3 tables were still missing (`auth.custom_oauth_providers`, `auth.webauthn_challenges`, `auth.webauthn_credentials`) | The auth schema must be ≥ prod's. v2.197.0 worked. The helper prechecks and names the missing tables |
| 4 | "Paste into SQL Editor" cannot work: the data file is `COPY … FROM stdin` and ~15 MB | psql only |
| 5 | "Confirm DSR counts match manifest" only covers 3 numbers | The helper verifies every table against the dump's own `COPY` row counts |
| 6 | No migration history after restore (`supabase_migrations` is not dumped) | `supabase migration repair --status applied` ([§3.3](#33-restore-to-a-new-supabase-project)) |

Not an issue: role ownership (all objects are owned by `postgres`, which exists on Supabase), extensions (`pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault` are present in the image), and `session_replication_role` (the dump sets it and the `postgres` role is allowed to).
