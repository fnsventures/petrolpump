#!/usr/bin/env bash
# pgTAP tests (supabase/tests/*.test.sql) against a throwaway database built from migrations.
# Local only: one Supabase Postgres container via Docker. Never touches a remote DB.
#
#   1. Start the container and add the GoTrue / Storage stand-ins (as check-schema-drift.sh)
#   2. Pre-migration baseline schema.sql + every migration in filename order (how prod was built)
#   3. supabase/tests/helpers.sql (pgTAP, logins, fixtures)
#   4. Each *.test.sql in its own psql session; every file rolls back
#
# Fails on any "not ok", a plan/count mismatch, or a SQL error. Exits 2 if setup fails.
#
# Usage:
#   ./scripts/test-db.sh                                   # all files
#   ./scripts/test-db.sh supabase/tests/rls.test.sql       # some files
#   KEEP_TEST_CONTAINER=1 ./scripts/test-db.sh             # leave the DB running (prints how to connect)
#
# Why not `supabase test db`: it runs against `supabase start`, which applies migrations to an
# empty database, and these migrations need the legacy baseline first. Its --db-url mode
# requires TLS, which the bare Postgres image does not serve.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Keep in step with check-schema-drift.sh.
SUPABASE_PG_IMAGE="${SUPABASE_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.063}"
BASELINE_COMMIT="5383acd13945501ef3281a5797efac2dc3376729"

PG_PASSWORD="postgres"
CONTAINER="pgtap-$$"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/test-db.XXXXXX")"

cleanup() {
  if [[ "${KEEP_TEST_CONTAINER:-}" == "1" ]]; then
    echo "Container kept: ${CONTAINER}"
    echo "  docker exec -it -e PGPASSWORD=${PG_PASSWORD} ${CONTAINER} psql -h localhost -U postgres -d postgres"
  else
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

run_sql() {
  local user="$1"
  shift
  docker exec -i -e PGPASSWORD="${PG_PASSWORD}" ${PGOPTIONS:+-e PGOPTIONS="${PGOPTIONS}"} \
    "${CONTAINER}" psql -h localhost -U "${user}" -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

apply_file() {
  local user="$1" file="$2"
  if ! run_sql "${user}" --single-transaction <"${file}" >"${WORK_DIR}/apply.log" 2>&1; then
    echo "FAILED applying $(basename "${file}"):"
    grep -v 'NOTICE' "${WORK_DIR}/apply.log" | head -20
    exit 2
  fi
}

# Same stand-ins as check-schema-drift.sh: Storage tables and auth.jwt() come from services the
# bare image does not run.
install_service_stubs() {
  sed -n '/^install_service_stubs() {/,/^SQL$/p' "${ROOT}/scripts/check-schema-drift.sh" \
    | sed '1,2d;$d' >"${WORK_DIR}/stubs.sql"
  apply_file supabase_admin "${WORK_DIR}/stubs.sql"
}

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 2; }
SECONDS=0

if [[ $# -gt 0 ]]; then
  TEST_FILES=("$@")
else
  TEST_FILES=()
  while IFS= read -r f; do TEST_FILES+=("${f}"); done \
    < <(ls "${ROOT}"/supabase/tests/*.test.sql | LC_ALL=C sort)
fi

echo "==> 1/4 Start throwaway database (${SUPABASE_PG_IMAGE})"
docker run -d --name "${CONTAINER}" -e POSTGRES_PASSWORD="${PG_PASSWORD}" "${SUPABASE_PG_IMAGE}" >/dev/null
for i in $(seq 1 120); do
  run_sql supabase_admin -tAc 'select 1' >/dev/null 2>&1 && break
  [[ $i -eq 120 ]] && { echo "Timed out waiting for Postgres"; docker logs "${CONTAINER}" 2>&1 | tail -20; exit 2; }
  sleep 1
done
install_service_stubs

echo "==> 2/4 Baseline + migrations"
if ! git -C "${ROOT}" cat-file -e "${BASELINE_COMMIT}:supabase/schema.sql" 2>/dev/null; then
  git -C "${ROOT}" fetch --quiet --no-tags --depth=1 origin "${BASELINE_COMMIT}"
fi
git -C "${ROOT}" show "${BASELINE_COMMIT}:supabase/schema.sql" >"${WORK_DIR}/baseline.sql"
PGOPTIONS="-c check_function_bodies=off" apply_file postgres "${WORK_DIR}/baseline.sql"
count=0
while IFS= read -r file; do
  apply_file postgres "${ROOT}/supabase/migrations/${file}"
  count=$((count + 1))
done < <(ls "${ROOT}/supabase/migrations" | grep '\.sql$' | LC_ALL=C sort)
echo "    Applied ${count} migrations"

echo "==> 3/4 Test helpers"
apply_file supabase_admin "${ROOT}/supabase/tests/helpers.sql"

echo "==> 4/4 Tests"
failed=0
total=0
for file in "${TEST_FILES[@]}"; do
  name="$(basename "${file}")"
  out="${WORK_DIR}/${name}.tap"
  status=0
  run_sql postgres -X -tA <"${file}" >"${out}" 2>&1 || status=$?
  # TAP lines only; psql prints a blank line after each result.
  grep -vE '^(NOTICE|$)' "${out}" >"${out}.clean" || true

  plan="$(grep -m1 -oE '^1\.\.[0-9]+' "${out}.clean" | cut -d. -f3 || true)"
  passed="$(grep -cE '^ok ' "${out}.clean" || true)"
  not_ok="$(grep -cE '^not ok ' "${out}.clean" || true)"
  ran=$((passed + not_ok))
  total=$((total + ran))

  if [[ ${status} -ne 0 || ${not_ok} -gt 0 || -z "${plan}" || "${plan}" -ne ${ran} ]] \
     || grep -qE '^(ERROR|psql:)' "${out}.clean"; then
    failed=$((failed + 1))
    echo "  FAIL ${name} (${passed}/${plan:-?} passed)"
    grep -E '^(not ok|#|ERROR|psql:|DETAIL|CONTEXT)' "${out}.clean" | sed 's/^/    /' | head -60
  else
    echo "  ok   ${name} (${passed})"
  fi
done

echo
if [[ ${failed} -gt 0 ]]; then
  echo "${failed} of ${#TEST_FILES[@]} test files failed (${total} checks ran, ${SECONDS}s)."
  exit 1
fi
echo "All ${#TEST_FILES[@]} test files passed (${total} checks, ${SECONDS}s)."
