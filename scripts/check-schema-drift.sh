#!/usr/bin/env bash
# Check that supabase/schema.sql (greenfield snapshot) matches what supabase/migrations/ produce.
# Local only: runs two throwaway Supabase Postgres containers via Docker. Never touches a remote DB.
#
#   DB "migrations": pre-migration baseline schema.sql (from git) + every migration in filename order
#   DB "snapshot"  : supabase/schema.sql alone
#
# Then dumps the public schema (+ storage buckets/policies) from both, normalizes, and diffs.
# Exits 1 on drift, 2 if SQL fails to apply.
#
# Usage:
#   ./scripts/check-schema-drift.sh
#   KEEP_DRIFT_CONTAINERS=1 ./scripts/check-schema-drift.sh   # leave containers running for inspection
#
# GitHub Actions: works on ubuntu-latest with Docker. The baseline commit is fetched if the
# checkout is shallow.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Match the Postgres image the Supabase CLI uses (supabase/.temp/postgres-version locally).
SUPABASE_PG_IMAGE="${SUPABASE_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.063}"

# The first migrations were written against schema.sql as it was before migrations existed.
BASELINE_COMMIT="5383acd13945501ef3281a5797efac2dc3376729"

# Functions created by early migrations whose signatures later changed without a matching
# DROP. They exist only in migration-built (and prod) databases; schema.sql deliberately omits
# them. Remove entries here once a migration drops them.
# (20261006054630_money_write_integrity dropped the last four.)
LEGACY_OVERLOADS=()

PG_PASSWORD="postgres"
SUFFIX="$$"
DB_MIGRATIONS="drift-migrations-${SUFFIX}"
DB_SNAPSHOT="drift-snapshot-${SUFFIX}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/schema-drift.XXXXXX")"

cleanup() {
  if [[ "${KEEP_DRIFT_CONTAINERS:-}" == "1" ]]; then
    echo "Containers kept: ${DB_MIGRATIONS} ${DB_SNAPSHOT}"
  else
    docker rm -f "${DB_MIGRATIONS}" "${DB_SNAPSHOT}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

# psql inside a container over TCP (the image's unix-socket auth is peer-only).
run_sql() {
  local container="$1" user="$2"
  shift 2
  docker exec -i -e PGPASSWORD="${PG_PASSWORD}" ${PGOPTIONS:+-e PGOPTIONS="${PGOPTIONS}"} \
    "${container}" psql -h localhost -U "${user}" -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

apply_file() {
  local container="$1" file="$2"
  if ! run_sql "${container}" postgres --single-transaction <"${file}" >"${WORK_DIR}/apply.log" 2>&1; then
    echo "FAILED applying $(basename "${file}") to ${container}:"
    grep -v 'NOTICE' "${WORK_DIR}/apply.log" | head -20
    exit 2
  fi
}

start_db() {
  docker run -d --name "$1" -e POSTGRES_PASSWORD="${PG_PASSWORD}" "${SUPABASE_PG_IMAGE}" >/dev/null
}

wait_for_db() {
  local container="$1" i
  for i in $(seq 1 120); do
    if run_sql "${container}" supabase_admin -tAc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${container}"
  docker logs "${container}" 2>&1 | tail -20
  exit 2
}

# The bare Postgres image has auth.uid()/role()/email() but no Storage tables and no auth.jwt()
# (those come from the GoTrue / Storage services). Minimal stand-ins so migrations apply.
install_service_stubs() {
  run_sql "$1" supabase_admin <<'SQL'
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to postgres, service_role;
grant select on storage.buckets, storage.objects to anon, authenticated;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.jwt() to postgres, anon, authenticated, service_role;
SQL
}

dump_schema() {
  local container="$1" out="$2"
  docker exec -e PGPASSWORD="${PG_PASSWORD}" "${container}" \
    pg_dump -h localhost -U postgres -d postgres --schema-only --schema=public --no-owner \
    >"${out}.raw"
  run_sql "${container}" postgres -tA -F ' | ' >>"${out}.raw" <<'SQL'
select 'storage policy', policyname, cmd, array_to_string(roles, ','), permissive,
       coalesce(qual, ''), coalesce(with_check, '')
from pg_policies where schemaname = 'storage' order by policyname;
select 'storage bucket', id, name, public, file_size_limit, allowed_mime_types
from storage.buckets order by id;
select 'extension', extname from pg_extension order by extname;
SQL
  # Drop comments, blank lines, trailing whitespace, and pg_dump session noise (\restrict tokens are random).
  sed -e 's/[[:space:]]*$//' "${out}.raw" \
    | grep -v -E '^[[:space:]]*(--.*)?$' \
    | grep -v -E '^(\\(un)?restrict |SET |SELECT pg_catalog\.set_config)' >"${out}" || true
}

command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 2; }
SECONDS=0

echo "==> 1/5 Start throwaway databases (${SUPABASE_PG_IMAGE})"
start_db "${DB_MIGRATIONS}"
start_db "${DB_SNAPSHOT}"
wait_for_db "${DB_MIGRATIONS}"
wait_for_db "${DB_SNAPSHOT}"
install_service_stubs "${DB_MIGRATIONS}"
install_service_stubs "${DB_SNAPSHOT}"

echo "==> 2/5 Baseline + migrations (filename order)"
if ! git -C "${ROOT}" cat-file -e "${BASELINE_COMMIT}:supabase/schema.sql" 2>/dev/null; then
  git -C "${ROOT}" fetch --quiet --no-tags --depth=1 origin "${BASELINE_COMMIT}"
fi
git -C "${ROOT}" show "${BASELINE_COMMIT}:supabase/schema.sql" >"${WORK_DIR}/baseline.sql"
# The legacy baseline defines SQL functions before the tables they read.
PGOPTIONS="-c check_function_bodies=off" apply_file "${DB_MIGRATIONS}" "${WORK_DIR}/baseline.sql"
count=0
while IFS= read -r file; do
  apply_file "${DB_MIGRATIONS}" "${ROOT}/supabase/migrations/${file}"
  count=$((count + 1))
done < <(ls "${ROOT}/supabase/migrations" | grep '\.sql$' | LC_ALL=C sort)
echo "    Applied ${count} migrations"
for fn in ${LEGACY_OVERLOADS[@]+"${LEGACY_OVERLOADS[@]}"}; do
  run_sql "${DB_MIGRATIONS}" postgres -c "drop function if exists ${fn};"
done

echo "==> 3/5 schema.sql"
apply_file "${DB_SNAPSHOT}" "${ROOT}/supabase/schema.sql"

echo "==> 4/5 Dump + normalize"
dump_schema "${DB_MIGRATIONS}" "${WORK_DIR}/migrations.sql"
dump_schema "${DB_SNAPSHOT}" "${WORK_DIR}/snapshot.sql"

echo "==> 5/5 Diff (- migrations, + schema.sql)"
if diff -u --label migrations --label schema.sql \
  "${WORK_DIR}/migrations.sql" "${WORK_DIR}/snapshot.sql" >"${WORK_DIR}/drift.diff"; then
  echo "    No drift. (${SECONDS}s)"
  exit 0
fi

cat "${WORK_DIR}/drift.diff"
echo
echo "Schema drift: supabase/schema.sql does not match supabase/migrations/ (${SECONDS}s)."
echo "Update schema.sql to mirror the migrations, then re-run this script."
exit 1
