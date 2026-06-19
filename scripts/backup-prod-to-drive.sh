#!/usr/bin/env bash
# Production backup (schema + data) uploaded to Google Drive. READ-ONLY on production.
# Used by GitHub Actions (.github/workflows/backup-prod-db.yml) and optional local runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prod-backup.XXXXXX")"

cleanup() {
  rm -rf "${BACKUP_DIR}"
}
trap cleanup EXIT

# shellcheck source=scripts/lib/constants.sh
source "${ROOT}/scripts/lib/constants.sh"
# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"
# shellcheck source=scripts/lib/backup.sh
source "${ROOT}/scripts/lib/backup.sh"
# shellcheck source=scripts/lib/google-drive.sh
source "${ROOT}/scripts/lib/google-drive.sh"

if [[ -z "${PROD_DB_URL:-}" && -f "${ROOT}/scripts/db.env" ]]; then
  # shellcheck disable=SC1090
  source "${ROOT}/scripts/db.env"
fi

if [[ -z "${PROD_DB_URL:-}" ]]; then
  echo "PROD_DB_URL must be set (env or scripts/db.env)."
  exit 1
fi

require_google_drive_env
command -v jq >/dev/null 2>&1 || { echo "jq is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required."; exit 1; }

init_db_client

echo "==> Backup production (read-only)"
backup_files=()
while IFS= read -r line; do
  backup_files+=("${line}")
done < <(backup_production "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" "")
capture_dsr_snapshot "${PROD_DB_URL}" "${BACKUP_DIR}" "${TIMESTAMP}" "snapshot"
manifest_file="${BACKUP_DIR}/backup-manifest-${TIMESTAMP}.txt"
{
  echo "backup_timestamp: ${TIMESTAMP}"
  echo "captured_utc: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "source: prod"
  if [[ -f "${BACKUP_DIR}/dsr-counts-snapshot-${TIMESTAMP}.txt" ]]; then
    cat "${BACKUP_DIR}/dsr-counts-snapshot-${TIMESTAMP}.txt"
  fi
} > "${manifest_file}"

upload_paths=()
for raw_file in "${backup_files[@]}"; do
  gz_file="${raw_file}.gz"
  echo "    Compressing → ${gz_file}"
  gzip -c "${raw_file}" > "${gz_file}"
  upload_paths+=("${gz_file}")
done
upload_paths+=("${manifest_file}")

echo
echo "==> Upload to Google Drive"
token="$(google_drive_access_token)"
month_folder_id="$(google_drive_ensure_month_folder "${GOOGLE_DRIVE_BACKUP_FOLDER_ID}" "${token}")"
echo "    Folder ID: ${month_folder_id}"

for file_path in "${upload_paths[@]}"; do
  file_name="$(basename "${file_path}")"
  mime_type="application/gzip"
  if [[ "${file_name}" == *.txt ]]; then
    mime_type="text/plain"
  fi
  echo "    Uploading ${file_name}…"
  link="$(google_drive_upload_file "${file_path}" "${file_name}" "${month_folder_id}" "${token}" "${mime_type}")"
  echo "    → ${link}"
done

echo
echo "Done. ${#upload_paths[@]} file(s) uploaded to Google Drive (${TIMESTAMP})."
