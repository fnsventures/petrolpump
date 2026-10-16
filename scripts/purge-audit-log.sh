#!/usr/bin/env bash
# Delete production audit_log rows older than the keep window.
# Default is 1 month. AUDIT_KEEP_MONTHS (1–24) or AUDIT_KEEP_DAYS (30–3650)
# overrides it. Days win when both are set. Dry-run unless CONFIRM_PURGE_AUDIT=yes.
# Does not touch operational tables.
# .github/workflows/purge-audit-log.yml calls this at 1 month after the
# scheduled backup succeeds, and with a chosen month or day count when started by hand.
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

keep_days="$(printf '%s' "${AUDIT_KEEP_DAYS:-}" | tr -d '[:space:]')"
keep_months="$(printf '%s' "${AUDIT_KEEP_MONTHS:-}" | tr -d '[:space:]')"

if [[ -n "${keep_days}" ]]; then
  if [[ ! "${keep_days}" =~ ^[0-9]+$ ]] || (( 10#${keep_days} < 30 || 10#${keep_days} > 3650 )); then
    echo "AUDIT_KEEP_DAYS must be a whole number from 30 to 3650 (got '${AUDIT_KEEP_DAYS:-}')." >&2
    exit 1
  fi
  keep_sql="interval '${keep_days} days'"
  keep_label="${keep_days} days"
else
  if [[ -z "${keep_months}" ]]; then
    keep_months="1"
  fi
  if [[ ! "${keep_months}" =~ ^[0-9]+$ ]] || (( 10#${keep_months} < 1 || 10#${keep_months} > 24 )); then
    echo "AUDIT_KEEP_MONTHS must be a whole number from 1 to 24 (got '${AUDIT_KEEP_MONTHS:-}')." >&2
    exit 1
  fi
  keep_sql="interval '${keep_months} months'"
  if [[ "${keep_months}" == "1" ]]; then
    keep_label="1 month"
  else
    keep_label="${keep_months} months"
  fi
fi

init_db_client

echo "==> audit_log before (older than ${keep_label})"
run_psql_query "${PROD_DB_URL}" \
  "select pg_size_pretty(pg_database_size(current_database())) || ' database, ' || pg_size_pretty(pg_total_relation_size('public.audit_log')) || ' audit_log, ' || count(*) || ' rows, ' || count(*) filter (where performed_at < timezone('utc', now()) - ${keep_sql}) || ' older than ${keep_label}' from public.audit_log"

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
  deleted="$(run_psql_query "${PROD_DB_URL}" "select public.purge_audit_log_batch(${keep_sql}, 5000)")"
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
echo "Reusable space may not shrink pg_database_size. A one-time VACUUM FULL on audit_log, in a quiet window, returns that space to the free-tier quota. See docs/STORAGE_RETENTION.md."
