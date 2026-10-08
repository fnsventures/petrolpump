#!/usr/bin/env bash
# Restore a prod schema + data dump (from scripts/lib/backup.sh) into:
#   --local              a throwaway Docker container (inspection / restore drill)
#   --target-url <URL>   an EMPTY new Supabase project (Session pooler URI)
#
# Usage:
#   ./scripts/restore-dump.sh --local <prod-schema-*.sql[.gz]> <prod-data-*.sql[.gz]>
#   CONFIRM_RESTORE=yes ./scripts/restore-dump.sh --target-url "$URL" <schema> <data>
#   ./scripts/restore-dump.sh --destroy      # remove local restore container
#
# Prints row counts only (never row contents). See docs/RECOVERY.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/constants.sh
source "${ROOT}/scripts/lib/constants.sh"
# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"

SUPABASE_PG_IMAGE="${SUPABASE_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.063}"
# Auth schema must be at least as new as the dumped prod auth tables.
GOTRUE_IMAGE="${GOTRUE_IMAGE:-public.ecr.aws/supabase/gotrue:v2.197.0}"
STORAGE_IMAGE="${STORAGE_IMAGE:-public.ecr.aws/supabase/storage-api:v1.33.0}"
RESTORE_CONTAINER="${RESTORE_CONTAINER:-restore-pg}"
RESTORE_NETWORK="${RESTORE_NETWORK:-restore-net}"
RESTORE_PORT="${RESTORE_PORT:-55432}"
LOCAL_PW="postgres"
JWT_STUB="local-restore-only-jwt-secret-at-least-32-chars"

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

now() { date +%s; }
step_done() { echo "    done in $(( $(now) - $1 ))s"; }

cat_dump() {
  case "$1" in
    *.gz) gunzip -c "$1" ;;
    *) cat "$1" ;;
  esac
}

# Expected row counts per table, from the COPY blocks in the data dump.
expected_counts() {
  cat_dump "$1" | awk '
    /^COPY /{t=$2; gsub(/"/, "", t); n=0; inb=1; next}
    inb && /^\\\.$/ {print t, n; inb=0; next}
    inb {n++}'
}

destroy_local() {
  docker rm -f "${RESTORE_CONTAINER}" restore-storage >/dev/null 2>&1 || true
  docker network rm "${RESTORE_NETWORK}" >/dev/null 2>&1 || true
  echo "Removed ${RESTORE_CONTAINER} and ${RESTORE_NETWORK}."
}

# ---- psql runners -----------------------------------------------------------

local_psql() {
  docker exec -i "${RESTORE_CONTAINER}" psql -U postgres -h localhost -d postgres "$@"
}

target_psql() {
  if [[ -n "${PSQL_BIN}" ]]; then
    "${PSQL_BIN}" "${TARGET_URL}" "$@"
  else
    docker run --rm -i "${PG_DOCKER_IMAGE}" psql "${TARGET_URL}" "$@"
  fi
}

db_psql() {
  if [[ "${MODE}" == "local" ]]; then local_psql "$@"; else target_psql "$@"; fi
}

# Single scalar query. stdin is detached so `docker exec -i` cannot swallow
# the input of a surrounding `while read` loop.
db_query() {
  db_psql -v ON_ERROR_STOP=1 -Atc "$1" </dev/null
}

# ---- local container bootstrap ---------------------------------------------

start_local() {
  if docker ps -a --format '{{.Names}}' | grep -qx "${RESTORE_CONTAINER}"; then
    echo "Container ${RESTORE_CONTAINER} already exists. Run: $0 --destroy"
    exit 1
  fi
  docker network create "${RESTORE_NETWORK}" >/dev/null 2>&1 || true

  local t; t="$(now)"
  echo "==> Start ${SUPABASE_PG_IMAGE} as ${RESTORE_CONTAINER} (localhost:${RESTORE_PORT})"
  docker run -d --name "${RESTORE_CONTAINER}" --network "${RESTORE_NETWORK}" \
    -e POSTGRES_PASSWORD="${LOCAL_PW}" -p "127.0.0.1:${RESTORE_PORT}:5432" \
    "${SUPABASE_PG_IMAGE}" >/dev/null
  # The image restarts Postgres once during init; require two consecutive successes.
  local ok=0
  for _ in $(seq 1 120); do
    if local_psql -Atc 'select 1' </dev/null >/dev/null 2>&1; then
      ok=$((ok + 1)); (( ok >= 3 )) && break
    else
      ok=0
    fi
    sleep 1
  done
  (( ok >= 3 )) || { echo "Postgres did not become ready."; exit 1; }
  docker exec "${RESTORE_CONTAINER}" psql -U supabase_admin -h localhost -d postgres -q -c \
    "alter role supabase_auth_admin password '${LOCAL_PW}'; alter role supabase_storage_admin password '${LOCAL_PW}';"
  step_done "${t}"

  # The bare image only has a stub auth/storage schema; hosted Supabase runs
  # the GoTrue and Storage migrations. Do the same so the data dump fits.
  t="$(now)"
  echo "==> Auth schema (${GOTRUE_IMAGE} migrate)"
  docker run --rm --network "${RESTORE_NETWORK}" \
    -e GOTRUE_DB_DRIVER=postgres \
    -e DATABASE_URL="postgres://supabase_auth_admin:${LOCAL_PW}@${RESTORE_CONTAINER}:5432/postgres" \
    -e GOTRUE_JWT_SECRET="${JWT_STUB}" -e API_EXTERNAL_URL=http://localhost \
    -e GOTRUE_SITE_URL=http://localhost \
    "${GOTRUE_IMAGE}" gotrue migrate 2>&1 | grep -E 'migrations applied|error' || true
  step_done "${t}"

  t="$(now)"
  echo "==> Storage schema (${STORAGE_IMAGE} boot migrations)"
  docker run -d --name restore-storage --network "${RESTORE_NETWORK}" \
    -e DATABASE_URL="postgres://supabase_storage_admin:${LOCAL_PW}@${RESTORE_CONTAINER}:5432/postgres" \
    -e DB_INSTALL_ROLES=false -e ANON_KEY=stub -e SERVICE_KEY=stub \
    -e AUTH_JWT_SECRET="${JWT_STUB}" -e PGRST_JWT_SECRET="${JWT_STUB}" \
    -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/tmp/storage \
    -e TENANT_ID=stub -e REGION=local -e GLOBAL_S3_BUCKET=stub \
    "${STORAGE_IMAGE}" >/dev/null
  local up=false
  for _ in $(seq 1 90); do
    if docker logs restore-storage 2>&1 | grep -q 'Server listening'; then up=true; break; fi
    sleep 1
  done
  docker rm -f restore-storage >/dev/null
  [[ "${up}" == "true" ]] || { echo "Storage migrations did not finish."; exit 1; }
  step_done "${t}"
}

# ---- restore ----------------------------------------------------------------

preflight_tables() {
  local data_file="$1" missing=()
  local table
  while read -r table _; do
    if [[ "$(db_query "select to_regclass('${table}') is not null")" != "t" ]]; then
      missing+=("${table}")
    fi
  done < <(expected_counts "${data_file}")
  if (( ${#missing[@]} > 0 )); then
    echo "Target is missing tables the data dump needs (schema too old):"
    printf '    %s\n' "${missing[@]}"
    if [[ "${MODE}" == "local" ]]; then
      echo "Use a newer GoTrue/Storage image: GOTRUE_IMAGE=... STORAGE_IMAGE=... $0 --local ..."
    fi
    exit 1
  fi
}

load_file() {
  local label="$1" file="$2" t
  t="$(now)"
  echo "==> ${label} ← $(basename "${file}")"
  cat_dump "${file}" | db_psql -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null
  step_done "${t}"
}

verify_counts() {
  local data_file="$1" table expected actual bad=0 n=0
  echo "==> Verify row counts vs dump"
  while read -r table expected; do
    actual="$(db_query "select count(*) from ${table}")"
    n=$((n + 1))
    if [[ "${actual}" != "${expected}" ]]; then
      echo "    MISMATCH ${table}: expected ${expected}, got ${actual}"
      bad=$((bad + 1))
    fi
  done < <(expected_counts "${data_file}")
  for table in auth.users public.users public.dsr_petrol public.dsr_diesel public.pump_settings; do
    printf '    %-22s %s\n' "${table}" "$(db_query "select count(*) from ${table}")"
  done
  printf '    %-22s %s\n' "public.dsr (view)" "$(db_query "select count(*) from public.dsr")"
  printf '    %-22s %s\n' "users matched to auth" \
    "$(db_query "select count(*) from public.users u join auth.users a on lower(a.email) = lower(u.email)")"
  if (( bad > 0 )); then
    echo "FAILED: ${bad}/${n} tables differ."
    exit 1
  fi
  echo "    OK: all ${n} dumped tables match."
}

# ---- main -------------------------------------------------------------------

MODE=""
TARGET_URL=""
case "${1:-}" in
  --local) MODE="local"; shift ;;
  --target-url) MODE="target"; TARGET_URL="${2:-}"; shift 2 || usage ;;
  --destroy) destroy_local; exit 0 ;;
  *) usage ;;
esac
[[ $# -eq 2 ]] || usage
SCHEMA_FILE="$1"
DATA_FILE="$2"
for f in "${SCHEMA_FILE}" "${DATA_FILE}"; do
  [[ -s "${f}" ]] || { echo "Missing or empty dump file: ${f}"; exit 1; }
done

T_START="$(now)"
if [[ "${MODE}" == "local" ]]; then
  docker_is_running || { echo "Docker is not running."; exit 1; }
  start_local
else
  [[ -n "${TARGET_URL}" ]] || usage
  if [[ "${CONFIRM_RESTORE:-}" != "yes" ]]; then
    echo "Refusing to write to a remote database without CONFIRM_RESTORE=yes."
    echo "Target must be an EMPTY new Supabase project — never live prod."
    exit 1
  fi
  init_db_client
  existing="$(db_query "select count(*) from pg_tables where schemaname = 'public'")"
  if [[ "${existing}" != "0" ]]; then
    echo "Target already has ${existing} table(s) in public — expected an empty project. Aborting."
    exit 1
  fi
fi

load_file "Schema" "${SCHEMA_FILE}"
preflight_tables "${DATA_FILE}"
load_file "Data" "${DATA_FILE}"
verify_counts "${DATA_FILE}"

echo
echo "Restore finished in $(( $(now) - T_START ))s."
if [[ "${MODE}" == "local" ]]; then
  echo "Inspect: docker exec -it ${RESTORE_CONTAINER} psql -U postgres -h localhost"
  echo "Remove : $0 --destroy"
else
  echo "Next: post-restore checklist in docs/RECOVERY.md"
fi
