#!/usr/bin/env bash
# Production schema migration: preflight → backup → push migrations → verify.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${ROOT}/scripts/.prod-backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck source=scripts/lib/constants.sh
source "${ROOT}/scripts/lib/constants.sh"
# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"
# shellcheck source=scripts/lib/env.sh
source "${ROOT}/scripts/lib/env.sh"
# shellcheck source=scripts/lib/backup.sh
source "${ROOT}/scripts/lib/backup.sh"

init_db_client
load_db_env false

LOCAL_MIGRATION_COUNT="$(count_local_migrations)"

echo "==> 1/5 Preflight"
run_psql "${PROD_DB_URL}" "${ROOT}/scripts/migrate-prod-preflight.sql"

HAS_MIGRATION_HISTORY="$(run_psql_query "${PROD_DB_URL}" \
  "select exists (select 1 from information_schema.tables where table_schema = 'supabase_migrations' and table_name = 'schema_migrations')")"
if [[ "${HAS_MIGRATION_HISTORY}" == "t" ]]; then
  APPLIED_COUNT="$(run_psql_query "${PROD_DB_URL}" "select count(*) from supabase_migrations.schema_migrations")"
else
  APPLIED_COUNT=0
fi
PENDING=$((LOCAL_MIGRATION_COUNT - APPLIED_COUNT))
(( PENDING < 0 )) && PENDING=0

LEGACY_USERS="$(run_psql_query "${PROD_DB_URL}" "select to_regclass('public.users') is not null")"
LEGACY_STAFF="$(run_psql_query "${PROD_DB_URL}" "select to_regclass('public.staff') is not null")"
LEGACY_DSR="$(run_psql_query "${PROD_DB_URL}" \
  "select c.relkind = 'r' from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'dsr'")"
if [[ "${LEGACY_USERS}" == "t" && "${LEGACY_STAFF}" == "f" && "${LEGACY_DSR}" == "t" && "${APPLIED_COUNT}" -lt 19 ]]; then
  echo
  echo "    Legacy prod schema (users table, legacy dsr) — stamping pre-split migrations..."
  run_psql "${PROD_DB_URL}" "${ROOT}/scripts/stamp-prod-migrations.sql"
  APPLIED_COUNT="$(run_psql_query "${PROD_DB_URL}" "select count(*) from supabase_migrations.schema_migrations")"
  PENDING=$((LOCAL_MIGRATION_COUNT - APPLIED_COUNT))
  (( PENDING < 0 )) && PENDING=0
fi

echo
echo "    Repo migrations : ${LOCAL_MIGRATION_COUNT}"
echo "    Applied on prod : ${APPLIED_COUNT}"
echo "    Approx pending  : ${PENDING}"
echo "    DSR status      : $(dsr_schema_status "${PROD_DB_URL}")"

echo
echo "==> 2/5 Dry run (no changes)"
supabase db push --db-url "${PROD_DB_URL}" --dry-run

if [[ "${CONFIRM_PROD_MIGRATE:-}" != "yes" ]]; then
  echo
  echo "Preflight complete — production unchanged."
  echo "To backup, migrate, and verify:"
  echo "  CONFIRM_PROD_MIGRATE=yes ./scripts/migrate-prod.sh"
  echo "  # or: ./scripts/db.sh migrate --apply"
  exit 0
fi

echo
echo "==> 3/5 Backup production"
backup_production "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" ""
capture_dsr_snapshot "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" "before"

echo
echo "==> 4/5 Apply migrations (live DB — Ctrl+C within 5s to abort)"
sleep 5
supabase db push --db-url "${PROD_DB_URL}" --yes

echo
echo "==> 5/5 Verify"
run_psql "${PROD_DB_URL}" "${ROOT}/scripts/migrate-prod-verify.sql"
capture_dsr_snapshot "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" "after"

echo
echo "Production migration complete."
echo "Backups: ${BACKUP_DIR}/"
echo "Next: merge staging → main, deploy, smoke-test live site."
echo "Guide: scripts/README.md"
