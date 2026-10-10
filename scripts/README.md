# Database scripts

What each script does internally. The order to run them is [docs/OPERATIONS.md](../docs/OPERATIONS.md). Restore is [docs/RECOVERY.md](../docs/RECOVERY.md).

Production is read-only except `./scripts/db.sh migrate --apply` and `CONFIRM_PURGE_AUDIT=yes ./scripts/purge-audit-log.sh`. `disable-staging-audit.sh` writes staging only.

Entry point: `./scripts/db.sh help`.

## Tools and credentials

- [Supabase CLI](https://supabase.com/docs/guides/cli): `brew install supabase/tap/supabase`
- Docker Desktop (used for `pg_dump` / `psql` when they are not installed), or `brew install libpq`

```bash
cp scripts/db.env.example scripts/db.env
```

| Variable | Used by |
|----------|---------|
| `PROD_DB_URL` | sync (read), migrate, backup |
| `STAGING_DB_URL` | sync (write), staging schema push |

Session pooler format: [docs/SECRETS.md → Laptop](../docs/SECRETS.md#a-laptop-gitignored). Legacy env files (`sync-prod-to-staging.env`, `migrate-prod.env`) still work if `db.env` is missing.

## `./scripts/db.sh sync`

Runs `sync-prod-to-staging.sh`. Mirrors production **data** into staging.

| Step | Action |
|------|--------|
| 1 | Stamp staging migrations, then `db push` (schema only on staging) |
| 2 | Dump prod auth, public, storage, and legacy `dsr` if needed |
| 3 | Truncate staging |
| 4 | Load dumps. Split legacy `dsr` into `dsr_petrol` / `dsr_diesel` when prod still has the old table |

Output: `scripts/.sync-dumps/` (gitignored). Does not copy storage file bytes, session tokens, or edge function secrets.

There is no `db.sh` subcommand for schema only. Sync always continues into the data replace. To push SQL and keep staging rows: [docs/OPERATIONS.md → Staging schema](../docs/OPERATIONS.md#apply-migrations-to-staging-only).

## `./scripts/db.sh migrate`

Runs `migrate-prod.sh` without `CONFIRM_PROD_MIGRATE`. Preflight and dry-run. No production change. `preflight` is the same command.

## `./scripts/db.sh migrate --apply`

Runs `migrate-prod.sh` with the confirmation flag. Upgrades **production schema**.

| Step | Action |
|------|--------|
| 1 | Preflight SQL and migration counts |
| 2 | Dry-run |
| 3 | Backup schema and data to `scripts/.prod-backups/` |
| 4 | `supabase db push` on prod (includes the DSR split if the legacy table is still there) |
| 5 | Verification SQL and a DSR row-count snapshot |

Run in a quiet window. Do not run `stamp-staging-migrations.sql` on prod (it marks the DSR-split migrations done without running them).

For a legacy prod that predates migration tracking (`users` table, legacy `dsr` table), `migrate-prod.sh` runs `stamp-prod-migrations.sql` to mark pre-split migrations applied, then `db push` continues from `split_dsr_petrol_diesel`.

## Backup and restore

| Command | Result |
|---------|--------|
| `./scripts/db.sh backup` | `scripts/.prod-backups/prod-schema-*.sql`, `prod-data-*.sql`, `dsr-counts-snapshot-*.txt`. Runs `backup-prod.sh` |
| `./scripts/backup-month-to-drive.sh` | Finished month only (CSV), uploaded. `ARCHIVE_MONTH=2026-10` picks the month. Scheduled on the 1st |
| `./scripts/backup-prod-to-drive.sh` | Whole database, uploaded to `Manual/<timestamp>/` |
| `./scripts/backup-year-to-drive.sh` | `YEAR=2026`: whole database to `Yearly/2026/`, then trash that year’s month folders |
| `./scripts/purge-audit-log.sh` | Dry-run. `CONFIRM_PURGE_AUDIT=yes` deletes production `audit_log` rows older than 6 months |
| `./scripts/prune-drive-backups.sh` | Dry-run. `CONFIRM_PRUNE_DRIVE=yes` trashes month folders whose year already has `Yearly/YYYY` |
| `./scripts/disable-staging-audit.sh` | Dry-run. `CONFIRM_STAGING_AUDIT=yes` turns audit off on staging and empties `audit_log` |
| `./scripts/restore-dump.sh --local` | Inspect or drill in Docker |
| `CONFIRM_RESTORE=yes ./scripts/restore-dump.sh --target-url …` | New, empty project |

Contents, setup, and the tested restore: [docs/RECOVERY.md](../docs/RECOVERY.md).

## Other checks

| Command | Effect |
|---------|--------|
| `./scripts/check-dns-siblings.sh` | Sibling Pages DNS and `/js/env.js`. `--fix` restores CNAMEs (needs `GODADDY_*`) |
| `./scripts/check-schema-drift.sh` | `schema.sql` matches migrations (Docker) |
| `./scripts/check-migration-order.sh` | New migrations sort last |
| `node scripts/check-doc-links.mjs` | Markdown links and anchors |

## Files

| File | Role |
|------|------|
| `db.sh` | sync / migrate / backup |
| `sync-prod-to-staging.sh` | Prod → staging data copy |
| `migrate-prod.sh` | Prod schema migration |
| `backup-prod.sh` | Local backup |
| `backup-month-to-drive.sh` | One finished month, uploaded to Drive |
| `backup-prod-to-drive.sh` | Whole database, uploaded to Drive `Manual/` |
| `backup-year-to-drive.sh` | Year-end full copy, then trash that year’s month folders |
| `purge-audit-log.sh` | Delete old `audit_log` rows on production |
| `prune-drive-backups.sh` | Trash month folders for years that have a full copy |
| `disable-staging-audit.sh` | Staging only: stop audit and empty `audit_log` |
| `lib/backup-retention.mjs` | Which month folders the prune keeps |
| `restore-dump.sh` | Local or new-project restore |
| `lib/backup.sh` | `supabase db dump` |
| `lib/google-drive.sh` | OAuth and upload |
| `lib/db-client.sh` | psql / Docker |
| `lib/env.sh` | Load `db.env` |
| `lib/constants.sh` | Dump exclude lists |
| `stamp-staging-migrations.sql` | Staging only — mark history applied |
| `stamp-prod-migrations.sql` | Legacy prod only — mark pre-DSR-split history applied |
| `truncate-staging.sql` | Staging only — clear before import |
| `relink-app-users.sql` | Staging sync — set `users.auth_user_id` from Auth emails |
| `create-dsr-import-table.sql` | Staging sync — temp legacy `dsr` import |
| `dsr-import-from-prod.sql` | Staging sync — split into petrol/diesel |
| `migrate-prod-preflight.sql` | Checks before a production migration |
| `migrate-prod-verify.sql` | Checks after |

## Never commit

| Path | Contents |
|------|----------|
| `scripts/db.env` | Database passwords |
| `scripts/.sync-dumps/` | Staging sync dumps |
| `scripts/.prod-backups/` | Production backups |

Failures: [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).
