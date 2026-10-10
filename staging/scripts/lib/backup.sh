# Production backup helpers (schema + data dumps).

backup_production() {
  local db_url="$1"
  local backup_dir="$2"
  local timestamp="$3"
  local label="${4:-}"

  mkdir -p "${backup_dir}"
  local schema_file="${backup_dir}/prod-schema-${timestamp}${label}.sql"
  local data_file="${backup_dir}/prod-data-${timestamp}${label}.sql"

  echo "    Schema → ${schema_file}" >&2
  supabase db dump --db-url "${db_url}" -f "${schema_file}"

  echo "    Data   → ${data_file}" >&2
  supabase db dump --data-only --db-url "${db_url}" --use-copy \
    --schema public,auth,storage \
    --exclude "${STORAGE_DUMP_EXCLUDES}" \
    -f "${data_file}"

  echo "${schema_file}"
  echo "${data_file}"
}

capture_dsr_snapshot() {
  local db_url="$1"
  local backup_dir="$2"
  local timestamp="$3"
  local phase="$4"
  local outfile="${backup_dir}/dsr-counts-${phase}-${timestamp}.txt"

  {
    echo "phase: ${phase}"
    echo "captured: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "dsr rows: $(run_psql_query "${db_url}" "select count(*) from public.dsr")"
    if [[ "$(run_psql_query "${db_url}" "select to_regclass('public.dsr_petrol') is not null")" == "t" ]]; then
      echo "dsr_petrol: $(run_psql_query "${db_url}" "select count(*) from public.dsr_petrol")"
    else
      echo "dsr_petrol: n/a"
    fi
    if [[ "$(run_psql_query "${db_url}" "select to_regclass('public.dsr_diesel') is not null")" == "t" ]]; then
      echo "dsr_diesel: $(run_psql_query "${db_url}" "select count(*) from public.dsr_diesel")"
    else
      echo "dsr_diesel: n/a"
    fi
  } | tee "${outfile}"
}
