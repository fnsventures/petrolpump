#!/usr/bin/env bash
# Delete production audit_log rows older than AUDIT_KEEP_MONTHS (default 6).
# Allowed windows: 1, 2, 3, or 6 months. Dry-run unless CONFIRM_PURGE_AUDIT=yes.
# Does not touch operational tables.
# .github/workflows/purge-audit-log.yml calls this at 1, 2, or 3 months when started by hand,
# and at 6 months after the scheduled backup workflow succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"

if [[ -z "${PROD_DB_URL:-}" && -f "${ROOT}/scripts/db.env" ]]; then
  # shellcheck disable=SC1090
  source "${ROOT}/scripts/db.env"
fi

if [[ -z "${PROD_DB_URL:-}" ]]; then
  echo "PROD_DB_URL must be set (env or scripts/db.env)."
  exit 1
fi

keep_months="${AUDIT_KEEP_MONTHS:-6}"
case "${keep_months}" in
  1|2|3|6) ;;
  *)
    echo "AUDIT_KEEP_MONTHS must be 1, 2, 3, or 6 (got '${keep_months}')." >&2
    exit 1
    ;;
esac

if [[ "${keep_months}" == "1" ]]; then
  keep_label="1 month"
else
  keep_label="${keep_months} months"
fi

init_db_client

echo "==> audit_log before (older than ${keep_label})"
run_psql_query "${PROD_DB_URL}" \
  "select pg_size_pretty(pg_database_size(current_database())) || ' database, ' || pg_size_pretty(pg_total_relation_size('public.audit_log')) || ' audit_log, ' || count(*) || ' rows, ' || count(*) filter (where performed_at < timezone('utc', now()) - interval '${keep_months} months') || ' older than ${keep_label}' from public.audit_log"

if [[ "${CONFIRM_PURGE_AUDIT:-}" != "yes" ]]; then
  echo
  echo "Dry run. No rows deleted."
  echo "Re-run with CONFIRM_PURGE_AUDIT=yes to delete audit_log rows older than ${keep_label}."
  exit 0
fi

ready="$(run_psql_query "${PROD_DB_URL}" "select to_regprocedure('public.purge_audit_log_batch(interval, integer)') is not null")"
if [[ "${ready}" != "t" ]]; then
  echo "purge_audit_log_batch is missing. Apply migration 20261008150000_audit_log_retention first." >&2
  exit 1
fi

echo
echo "==> Deleting audit_log rows older than ${keep_label}"
total=0
while true; do
  deleted="$(run_psql_query "${PROD_DB_URL}" "select public.purge_audit_log_batch(interval '${keep_months} months', 5000)")"
  if [[ ! "${deleted}" =~ ^[0-9]+$ ]]; then
    echo "Unexpected purge result: ${deleted}" >&2
    exit 1
  fi
  total=$((total + deleted))
  echo "    batch deleted ${deleted} (total ${total})"
  [[ "${deleted}" == "0" ]] && break
done

echo
echo "==> VACUUM (ANALYZE) audit_log"
set +e
run_psql_query "${PROD_DB_URL}" "vacuum (analyze) public.audit_log"
vacuum_status=$?
set -e
if [[ "${vacuum_status}" -ne 0 ]]; then
  echo "VACUUM did not run (the session pooler sometimes rejects it). Deleted rows stay deleted; autovacuum will reuse the space."
fi

echo
echo "==> audit_log after"
run_psql_query "${PROD_DB_URL}" \
  "select pg_size_pretty(pg_database_size(current_database())) || ' database, ' || pg_size_pretty(pg_total_relation_size('public.audit_log')) || ' audit_log, ' || count(*) || ' rows' from public.audit_log"
echo "Deleted ${total} audit row(s) older than ${keep_label}. Operational tables were not changed."
echo "Reusable space may not shrink pg_database_size. A one-time VACUUM FULL on audit_log, in a quiet window, returns that space to the free-tier quota."
