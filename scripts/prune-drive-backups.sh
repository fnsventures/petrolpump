#!/usr/bin/env bash
# Trash month folders whose calendar year already has a full backup in Yearly/YYYY.
# Dry-run unless CONFIRM_PRUNE_DRIVE=yes.
#
# Does not touch Yearly/ or Manual/. Trash is recoverable for about 30 days.
# Does not read or write the database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOLDER_MIME="application/vnd.google-apps.folder"

# shellcheck source=scripts/lib/google-drive.sh
source "${ROOT}/scripts/lib/google-drive.sh"

require_google_drive_env
command -v jq >/dev/null 2>&1 || { echo "jq is required."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }

lookup_id() {
  local name="$1"
  local file="$2"
  awk -F '\t' -v key="${name}" '$1 == key { print $2; exit }' "${file}"
}

echo "==> List Drive backup folders"
token="$(google_drive_access_token)"
months_file="$(mktemp)"
years_file="$(mktemp)"
drop_file="$(mktemp)"
trap 'rm -f "${months_file}" "${years_file}" "${drop_file}"' EXIT

while IFS="$(printf '\t')" read -r year_id year_name year_mime; do
  [[ "${year_mime}" == "${FOLDER_MIME}" && "${year_name}" =~ ^[0-9]{4}$ ]] || continue
  printf '%s\t%s\n' "${year_name}" "${year_id}" >> "${years_file}"
  while IFS="$(printf '\t')" read -r month_id month_name month_mime; do
    [[ "${month_mime}" == "${FOLDER_MIME}" && "${month_name}" =~ ^[0-9]{4}-[0-9]{2}$ ]] || continue
    [[ "${month_name}" == "${year_name}-"* ]] || continue
    printf '%s\t%s\n' "${month_name}" "${month_id}" >> "${months_file}"
  done < <(google_drive_list_children "${year_id}" "${token}")
done < <(google_drive_list_children "${GOOGLE_DRIVE_BACKUP_FOLDER_ID}" "${token}")

if [[ ! -s "${months_file}" ]]; then
  echo "No YYYY/YYYY-MM backup folders under the Drive root. Nothing to prune."
  exit 0
fi

completed_years=""
while IFS="$(printf '\t')" read -r root_id root_name root_mime; do
  [[ "${root_mime}" == "${FOLDER_MIME}" && "${root_name}" == "Yearly" ]] || continue
  while IFS="$(printf '\t')" read -r year_id year_name year_mime; do
    [[ "${year_mime}" == "${FOLDER_MIME}" && "${year_name}" =~ ^[0-9]{4}$ ]] || continue
    if [[ -n "${completed_years}" ]]; then
      completed_years="${completed_years},${year_name}"
    else
      completed_years="${year_name}"
    fi
  done < <(google_drive_list_children "${root_id}" "${token}")
done < <(google_drive_list_children "${GOOGLE_DRIVE_BACKUP_FOLDER_ID}" "${token}")

month_csv="$(awk -F '\t' '{ names = names ? names "," $1 : $1 } END { print names }' "${months_file}")"
echo "Closed years (Yearly/ folder exists): ${completed_years:-none}"
decision="$(node "${ROOT}/scripts/lib/backup-retention.mjs" --months "${month_csv}" --completed-years "${completed_years}")"
echo "Keep: $(echo "${decision}" | jq -r '.keep | join(", ")')"
echo "Drop: $(echo "${decision}" | jq -r 'if (.drop | length) == 0 then "(none)" else .drop | join(", ") end')"

apply=0
if [[ "${CONFIRM_PRUNE_DRIVE:-}" == "yes" ]]; then
  apply=1
fi

jq -r '.drop[]' <<< "${decision}" > "${drop_file}"
while IFS= read -r month_name; do
  [[ -n "${month_name}" ]] || continue
  month_id="$(lookup_id "${month_name}" "${months_file}")"
  if [[ -z "${month_id}" ]]; then
    echo "Missing folder id for ${month_name}" >&2
    exit 1
  fi
  while IFS="$(printf '\t')" read -r file_id file_name _file_mime; do
    [[ -n "${file_id}" ]] || continue
    if [[ "${apply}" -eq 1 ]]; then
      echo "    trash ${month_name}/${file_name}"
      google_drive_trash_file "${file_id}" "${token}"
    else
      echo "    would trash ${month_name}/${file_name}"
    fi
  done < <(google_drive_list_children "${month_id}" "${token}")
  if [[ "${apply}" -eq 1 ]]; then
    echo "    trash folder ${month_name}"
    google_drive_trash_file "${month_id}" "${token}"
  else
    echo "    would trash folder ${month_name}"
  fi
done < "${drop_file}"

# Drop a year folder only when every month folder inside it was trashed.
if [[ "${apply}" -eq 1 ]]; then
  while IFS="$(printf '\t')" read -r year_name year_id; do
    [[ -n "${year_name}" ]] || continue
    remaining="$(google_drive_list_children "${year_id}" "${token}" | awk 'NF { c++ } END { print c + 0 }')"
    if [[ "${remaining}" == "0" ]]; then
      echo "    trash year folder ${year_name}"
      google_drive_trash_file "${year_id}" "${token}"
    fi
  done < "${years_file}"
fi

echo
if [[ "${apply}" -eq 1 ]]; then
  echo "Prune applied. Dropped folders are in Drive trash for about 30 days."
else
  echo "Dry run. No Drive files changed."
  echo "Re-run with CONFIRM_PRUNE_DRIVE=yes to move the dropped folders to trash."
fi
