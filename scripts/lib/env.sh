# Load database connection URLs from scripts/db.env (preferred) or legacy env files.

load_db_env() {
  local require_staging="${1:-false}"
  local env_file="${ROOT}/scripts/db.env"
  local sync_env="${ROOT}/scripts/sync-prod-to-staging.env"
  local migrate_env="${ROOT}/scripts/migrate-prod.env"

  if [[ -f "${env_file}" ]]; then
    # shellcheck disable=SC1090
    source "${env_file}"
  elif [[ -f "${sync_env}" ]]; then
    echo "Using ${sync_env} (consider migrating to scripts/db.env — see scripts/README.md)"
    # shellcheck disable=SC1090
    source "${sync_env}"
  elif [[ -f "${migrate_env}" ]]; then
    echo "Using ${migrate_env} (consider migrating to scripts/db.env — see scripts/README.md)"
    # shellcheck disable=SC1090
    source "${migrate_env}"
  else
    echo "Missing database env file."
    echo "  cp scripts/db.env.example scripts/db.env"
    echo "  # edit PROD_DB_URL and STAGING_DB_URL"
    exit 1
  fi

  if [[ -z "${PROD_DB_URL:-}" ]]; then
    echo "PROD_DB_URL must be set in scripts/db.env"
    exit 1
  fi

  if [[ "${require_staging}" == "true" && -z "${STAGING_DB_URL:-}" ]]; then
    echo "STAGING_DB_URL must be set in scripts/db.env for this command"
    exit 1
  fi
}
