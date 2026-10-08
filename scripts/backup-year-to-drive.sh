#!/usr/bin/env bash
# Close a finished calendar year on Google Drive.
# 1. Upload a full copy of production to Yearly/YYYY.
# 2. Only after that upload succeeds, trash YYYY/YYYY-01 … YYYY-12.
#    Those month files are redundant once the full copy exists.
#
#   YEAR=2026 ./scripts/backup-year-to-drive.sh
# On 1 January, YEAR can be omitted and the previous calendar year is used.
# Refuses the current year, so a run in October cannot delete this year's months.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

this_year="$(TZ=Asia/Kolkata date +%Y)"
if [[ -z "${YEAR:-}" ]]; then
  this_month="$(TZ=Asia/Kolkata date +%m)"
  if [[ "${this_month}" != "01" ]]; then
    echo "Set YEAR to a finished calendar year, for example YEAR=2026." >&2
    echo "On 1 January the previous year is selected automatically." >&2
    exit 1
  fi
  YEAR="$((this_year - 1))"
fi

if [[ ! "${YEAR}" =~ ^[0-9]{4}$ ]]; then
  echo "YEAR must be a four-digit calendar year (got ${YEAR})." >&2
  exit 1
fi

if (( YEAR >= this_year )); then
  echo "YEAR=${YEAR} is not a finished year (today's year in IST is ${this_year})." >&2
  echo "Month folders for the current year stay until 1 January." >&2
  exit 1
fi

echo "==> Full backup of production into Yearly/${YEAR}"
export DRIVE_BACKUP_SUBPATH="Yearly/${YEAR}"
bash "${ROOT}/scripts/backup-prod-to-drive.sh"

echo
echo "==> Remove redundant ${YEAR} month folders"
export CONFIRM_PRUNE_DRIVE=yes
bash "${ROOT}/scripts/prune-drive-backups.sh"
