#!/usr/bin/env bash
# Save one finished month of production activity to Google Drive. Read-only.
# On 1 November this writes October's rows into Drive 2026/2026-10/.
# Customers, staff, products, and settings are not included — they have no month.
# Used by .github/workflows/backup-prod-db.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/month-archive.XXXXXX")"

cleanup() {
  rm -rf "${BACKUP_DIR}"
}
trap cleanup EXIT

# shellcheck source=scripts/lib/db-client.sh
source "${ROOT}/scripts/lib/db-client.sh"
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
command -v node >/dev/null 2>&1 || { echo "node is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required."; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required."; exit 1; }

init_db_client

ist_today() {
  node --input-type=module -e "
    process.stdout.write(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()));
  "
}

if [[ -z "${ARCHIVE_MONTH:-}" ]]; then
  ARCHIVE_MONTH="$(node --input-type=module -e "
    import { previousMonth } from '${ROOT}/scripts/lib/backup-retention.mjs';
    process.stdout.write(previousMonth(process.argv[1]));
  " "$(ist_today)")"
fi

if [[ ! "${ARCHIVE_MONTH}" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "ARCHIVE_MONTH must be YYYY-MM (got ${ARCHIVE_MONTH})." >&2
  exit 1
fi

bounds="$(node --input-type=module -e "
  import { monthBounds } from '${ROOT}/scripts/lib/backup-retention.mjs';
  const bounds = monthBounds(process.argv[1]);
  process.stdout.write(bounds.start + ' ' + bounds.end);
" "${ARCHIVE_MONTH}")"
START="${bounds%% *}"
END="${bounds##* }"
if [[ ! "${START}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ || ! "${END}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Could not resolve dates for ${ARCHIVE_MONTH}." >&2
  exit 1
fi

manifest="${BACKUP_DIR}/month-manifest-${TIMESTAMP}.txt"
{
  echo "archive_month: ${ARCHIVE_MONTH}"
  echo "from: ${START}"
  echo "until: ${END}"
  echo "captured_utc: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "source: prod"
  echo "contents: rows whose business date falls in this month"
} > "${manifest}"

upload_paths=()

archive_query() {
  local stem="$1"
  local select_sql="$2"
  local csv="${BACKUP_DIR}/${stem}-${TIMESTAMP}.csv"
  echo "    ${stem}"
  run_psql_copy_query "${PROD_DB_URL}" "${select_sql}" "${csv}"
  local rows
  rows="$(awk 'END { print (NR > 0 ? NR - 1 : 0) }' "${csv}")"
  echo "${stem}: ${rows}" >> "${manifest}"
  gzip -c "${csv}" > "${csv}.gz"
  rm -f "${csv}"
  upload_paths+=("${csv}.gz")
}

between_dates() {
  local column="$1"
  printf '%s >= DATE '\''%s'\'' AND %s < DATE '\''%s'\''' "${column}" "${START}" "${column}" "${END}"
}

echo "==> Archive ${ARCHIVE_MONTH} (${START} up to ${END})"

archive_query "dsr_petrol" "SELECT * FROM public.dsr_petrol WHERE $(between_dates date) ORDER BY date"
archive_query "dsr_diesel" "SELECT * FROM public.dsr_diesel WHERE $(between_dates date) ORDER BY date"
archive_query "meter_shift_readings" "SELECT * FROM public.meter_shift_readings WHERE $(between_dates reading_date) ORDER BY reading_date"
archive_query "meter_shift_cash" "SELECT * FROM public.meter_shift_cash WHERE $(between_dates reading_date) ORDER BY reading_date"
archive_query "day_closing" "SELECT * FROM public.day_closing WHERE $(between_dates date) ORDER BY date"
archive_query "expenses" "SELECT * FROM public.expenses WHERE $(between_dates date) ORDER BY date"
archive_query "credit_entries" "SELECT * FROM public.credit_entries WHERE $(between_dates transaction_date) ORDER BY transaction_date"
archive_query "credit_payments" "SELECT * FROM public.credit_payments WHERE $(between_dates date) ORDER BY date"
archive_query "invoices" "SELECT * FROM public.invoices WHERE $(between_dates invoice_date) ORDER BY invoice_date"
archive_query "invoice_items" "SELECT i.* FROM public.invoice_items i INNER JOIN public.invoices n ON n.id = i.invoice_id WHERE $(between_dates n.invoice_date) ORDER BY n.invoice_date, i.sl_no"
archive_query "invoice_documents" "SELECT * FROM public.invoice_documents WHERE $(between_dates invoice_date) ORDER BY invoice_date"
archive_query "employee_attendance" "SELECT * FROM public.employee_attendance WHERE $(between_dates date) ORDER BY date"
archive_query "salary_payments" "SELECT * FROM public.salary_payments WHERE $(between_dates salary_month) ORDER BY salary_month, date"
archive_query "salary_lop_exclusions" "SELECT * FROM public.salary_lop_exclusions WHERE $(between_dates salary_month) ORDER BY salary_month"
archive_query "night_cash_collections" "SELECT * FROM public.night_cash_collections WHERE from_date < DATE '${END}' AND to_date >= DATE '${START}' ORDER BY from_date"
archive_query "e20_testing_registers" "SELECT * FROM public.e20_testing_registers WHERE $(between_dates register_date) ORDER BY register_date"
archive_query "e20_water_checks" "SELECT c.* FROM public.e20_water_checks c INNER JOIN public.e20_testing_registers r ON r.id = c.register_id WHERE $(between_dates r.register_date) ORDER BY r.register_date, c.sort_order"
archive_query "e20_quality_checks" "SELECT c.* FROM public.e20_quality_checks c INNER JOIN public.e20_testing_registers r ON r.id = c.register_id WHERE $(between_dates r.register_date) ORDER BY r.register_date, c.slot_no"
archive_query "letterhead_letters" "SELECT * FROM public.letterhead_letters WHERE $(between_dates letter_date) ORDER BY letter_date"
archive_query "audit_log" "SELECT * FROM public.audit_log WHERE performed_at >= (DATE '${START}'::timestamp AT TIME ZONE 'Asia/Kolkata') AND performed_at < (DATE '${END}'::timestamp AT TIME ZONE 'Asia/Kolkata') ORDER BY performed_at"

upload_paths+=("${manifest}")

echo
echo "==> Upload ${ARCHIVE_MONTH} to Google Drive"
token="$(google_drive_access_token)"
month_folder_id="$(google_drive_ensure_named_month_folder "${GOOGLE_DRIVE_BACKUP_FOLDER_ID}" "${token}" "${ARCHIVE_MONTH}")"
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
echo "Done. ${ARCHIVE_MONTH}: ${#upload_paths[@]} file(s) uploaded."
