#!/usr/bin/env bash
# Staging only: stop writing audit_log, and delete every audit row already there.
# Production is untouched. Sync calls this after loading a prod copy.
#
#   ./scripts/disable-staging-audit.sh                  # show what would change
#   CONFIRM_STAGING_AUDIT=yes ./scripts/disable-staging-audit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"

if [[ -z "${STAGING_DB_URL:-}" && -f "${ROOT}/scripts/db.env" ]]; then
  # shellcheck disable=SC1090
  source "${ROOT}/scripts/db.env"
fi

if [[ -z "${STAGING_DB_URL:-}" ]]; then
  echo "STAGING_DB_URL must be set (env or scripts/db.env)." >&2
  exit 1
fi

if [[ -n "${PROD_DB_URL:-}" && "${STAGING_DB_URL}" == "${PROD_DB_URL}" ]]; then
  echo "STAGING_DB_URL and PROD_DB_URL are the same. Refusing to change audit on that database." >&2
  exit 1
fi

init_db_client

echo "==> Staging audit"
run_psql_query "${STAGING_DB_URL}" \
  "select current_database() || ' has ' || count(*) || ' audit_log rows' from public.audit_log"

if [[ "${CONFIRM_STAGING_AUDIT:-}" != "yes" && "${CONFIRM_STAGING_AUDIT:-}" != "from-sync" ]]; then
  echo
  echo "Dry run. No rows deleted, and new staging edits would still be logged until you confirm."
  echo "Re-run with CONFIRM_STAGING_AUDIT=yes"
  exit 0
fi

run_psql "${STAGING_DB_URL}" "${ROOT}/scripts/disable-staging-audit.sql"
echo "Staging audit is off. audit_log is empty. New playground edits are not logged."
echo "Production is unchanged."
