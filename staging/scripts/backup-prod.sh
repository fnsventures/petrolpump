#!/usr/bin/env bash
# Standalone production backup (schema + data). READ-ONLY on production.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${ROOT}/scripts/.prod-backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# shellcheck source=scripts/lib/constants.sh
source "${ROOT}/scripts/lib/constants.sh"
# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"
# shellcheck source=scripts/lib/env.sh
source "${ROOT}/scripts/lib/env.sh"
# shellcheck source=scripts/lib/backup.sh
source "${ROOT}/scripts/lib/backup.sh"

init_db_client
load_db_env false

echo "==> Backup production (read-only)"
backup_production "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" ""
capture_dsr_snapshot "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" "snapshot"

echo
echo "Done. Files in ${BACKUP_DIR}/"
echo "Also consider Supabase Dashboard → Database → Backups before major releases."
