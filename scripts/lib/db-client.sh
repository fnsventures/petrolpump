# Shared psql / Docker helpers for Supabase maintenance scripts.

PG_DOCKER_IMAGE="${PG_DOCKER_IMAGE:-postgres:17}"

resolve_psql() {
  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi
  for candidate in \
    /opt/homebrew/opt/libpq/bin/psql \
    /usr/local/opt/libpq/bin/psql; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_pg_dump() {
  if [[ -n "${PSQL_BIN:-}" ]]; then
    local pg_dump_bin="${PSQL_BIN/psql/pg_dump}"
    if [[ -x "${pg_dump_bin}" ]]; then
      echo "${pg_dump_bin}"
      return 0
    fi
  fi
  if command -v pg_dump >/dev/null 2>&1; then
    command -v pg_dump
    return 0
  fi
  for candidate in \
    /opt/homebrew/opt/libpq/bin/pg_dump \
    /usr/local/opt/libpq/bin/pg_dump; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

docker_is_running() {
  docker info >/dev/null 2>&1
}

require_database_client() {
  if resolve_psql >/dev/null 2>&1; then
    return 0
  fi
  if docker_is_running; then
    return 0
  fi
  echo "No psql found and Docker is not running."
  echo
  echo "Fix one of the following, then run this script again:"
  echo "  1. Start Docker Desktop, or"
  echo "  2. Install psql:  brew install libpq"
  echo "     then add to PATH:  export PATH=\"/opt/homebrew/opt/libpq/bin:\$PATH\""
  echo
  echo "See scripts/README.md for the full guide."
  exit 1
}

init_db_client() {
  require_database_client
  PSQL_BIN="$(resolve_psql 2>/dev/null || true)"
  PG_DUMP_BIN="$(resolve_pg_dump 2>/dev/null || true)"
}

run_psql() {
  local db_url="$1"
  local file="$2"
  if [[ -n "${PSQL_BIN}" ]]; then
    "${PSQL_BIN}" "${db_url}" -v ON_ERROR_STOP=1 -f "${file}"
  else
    docker run --rm -i \
      -v "${file}:/tmp/script.sql:ro" \
      "${PG_DOCKER_IMAGE}" \
      psql "${db_url}" -v ON_ERROR_STOP=1 -f /tmp/script.sql
  fi
}

run_psql_stdin() {
  local db_url="$1"
  if [[ -n "${PSQL_BIN}" ]]; then
    "${PSQL_BIN}" "${db_url}" -v ON_ERROR_STOP=1
  else
    docker run --rm -i "${PG_DOCKER_IMAGE}" psql "${db_url}" -v ON_ERROR_STOP=1
  fi
}

run_psql_query() {
  local db_url="$1"
  local query="$2"
  if [[ -n "${PSQL_BIN}" ]]; then
    "${PSQL_BIN}" "${db_url}" -v ON_ERROR_STOP=1 -At -c "${query}"
  else
    docker run --rm -i "${PG_DOCKER_IMAGE}" \
      psql "${db_url}" -v ON_ERROR_STOP=1 -At -c "${query}"
  fi
}

run_pg_dump() {
  local db_url="$1"
  shift
  if [[ -n "${PG_DUMP_BIN}" ]]; then
    "${PG_DUMP_BIN}" "${db_url}" "$@"
  else
    docker run --rm -i "${PG_DOCKER_IMAGE}" pg_dump "${db_url}" "$@"
  fi
}

run_pg_dump_table() {
  local db_url="$1"
  local table="$2"
  local outfile="$3"
  run_pg_dump "${db_url}" \
    --data-only --no-owner --no-privileges --table="${table}" > "${outfile}"
}

prepare_legacy_dsr_dump() {
  local raw="$1"
  local ready="$2"
  sed \
    -e 's/COPY "public"."dsr"/COPY "public"."_dsr_import"/' \
    -e 's/COPY public\.dsr /COPY public._dsr_import /' \
    "${raw}" > "${ready}"
}

count_local_migrations() {
  local count=0
  for f in "${ROOT}"/supabase/migrations/*.sql; do
    [[ -f "${f}" ]] && count=$((count + 1))
  done
  echo "${count}"
}

dsr_schema_status() {
  local db_url="$1"
  local kind
  kind="$(run_psql_query "${db_url}" \
    "select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'dsr'")"
  case "${kind}" in
    r) echo "legacy table (split migration will migrate data)" ;;
    v) echo "view (new schema)" ;;
    *) echo "unknown (${kind})" ;;
  esac
}
