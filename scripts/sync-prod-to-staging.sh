#!/usr/bin/env bash
# Copy prod data → staging for pre-release testing. READ-ONLY on production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP_DIR="${ROOT}/scripts/.sync-dumps"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck source=scripts/lib/constants.sh
source "${ROOT}/scripts/lib/constants.sh"
# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"
# shellcheck source=scripts/lib/env.sh
source "${ROOT}/scripts/lib/env.sh"

init_db_client
load_db_env true
mkdir -p "${DUMP_DIR}"

echo "==> 1/4 Staging schema"
echo "    Stamp migration history (schema.sql bootstrap)..."
run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/stamp-staging-migrations.sql"
echo "    Apply pending migrations..."
supabase db push --db-url "${STAGING_DB_URL}" --yes

echo "==> 2/4 Dump from production (read-only)"
AUTH_DUMP="${DUMP_DIR}/prod-auth-${TIMESTAMP}.sql"
PUBLIC_DUMP="${DUMP_DIR}/prod-public-${TIMESTAMP}.sql"
STORAGE_DUMP="${DUMP_DIR}/prod-storage-${TIMESTAMP}.sql"
DSR_DUMP="${DUMP_DIR}/prod-dsr-${TIMESTAMP}.sql"
DSR_DUMP_READY="${DUMP_DIR}/prod-dsr-${TIMESTAMP}-ready.sql"

supabase db dump --data-only --db-url "${PROD_DB_URL}" --use-copy \
  --schema auth --exclude "${AUTH_DUMP_EXCLUDES}" -f "${AUTH_DUMP}"

supabase db dump --data-only --db-url "${PROD_DB_URL}" --use-copy \
  --schema public --exclude "${PUBLIC_SYNC_EXCLUDES}" -f "${PUBLIC_DUMP}"

if [[ "$(run_psql_query "${PROD_DB_URL}" "select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'dsr'")" == "r" ]]; then
  echo "    Legacy prod dsr table → will transform for staging dsr_petrol/dsr_diesel"
  run_pg_dump_table "${PROD_DB_URL}" "public.dsr" "${DSR_DUMP}"
  prepare_legacy_dsr_dump "${DSR_DUMP}" "${DSR_DUMP_READY}"
  NEED_DSR_IMPORT=1
else
  echo "    Prod uses new DSR schema (dsr_petrol/dsr_diesel included in public dump)"
  NEED_DSR_IMPORT=0
fi

supabase db dump --data-only --db-url "${PROD_DB_URL}" --use-copy \
  --schema storage --exclude "${STORAGE_DUMP_EXCLUDES}" -f "${STORAGE_DUMP}"

echo "==> 3/4 Clear staging"
run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/truncate-staging.sql"

echo "==> 4/4 Load into staging"
run_psql_stdin "${STAGING_DB_URL}" < "${AUTH_DUMP}"
run_psql_stdin "${STAGING_DB_URL}" < "${STORAGE_DUMP}"
run_psql_stdin "${STAGING_DB_URL}" < "${PUBLIC_DUMP}"

if [[ "${NEED_DSR_IMPORT:-0}" == "1" ]]; then
  echo "    Import DSR → dsr_petrol / dsr_diesel"
  run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/create-dsr-import-table.sql"
  {
    echo "SET session_replication_role = replica;"
    cat "${DSR_DUMP_READY}"
    echo "SET session_replication_role = DEFAULT;"
  } | run_psql_stdin "${STAGING_DB_URL}"
  run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/dsr-import-from-prod.sql"
fi

echo
echo "Done. Staging mirrors production data."
echo "    Reseed vault document types (not in older prod dumps)…"
run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/seed-document-categories.sql"
echo "Dumps: ${DUMP_DIR}/"
echo "Next: test at /staging/ → then scripts/db.sh migrate --apply → merge staging → main"
echo "Guide: scripts/README.md"
