# Google Drive helpers for maintenance scripts (OAuth refresh token flow).

DRIVE_API="https://www.googleapis.com/drive/v3"

require_google_drive_env() {
  if [[ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" || -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" || -z "${GOOGLE_OAUTH_REFRESH_TOKEN:-}" ]]; then
    echo "Missing Google OAuth env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN"
    exit 1
  fi
  if [[ -z "${GOOGLE_DRIVE_BACKUP_FOLDER_ID:-}" ]]; then
    echo "Missing GOOGLE_DRIVE_BACKUP_FOLDER_ID (Drive folder ID for database backups)."
    exit 1
  fi
}

google_drive_access_token() {
  local response
  response="$(curl -sS -X POST "https://oauth2.googleapis.com/token" \
    -d "client_id=${GOOGLE_OAUTH_CLIENT_ID}" \
    -d "client_secret=${GOOGLE_OAUTH_CLIENT_SECRET}" \
    -d "refresh_token=${GOOGLE_OAUTH_REFRESH_TOKEN}" \
    -d "grant_type=refresh_token")"
  local token
  token="$(echo "${response}" | jq -r '.access_token // empty')"
  if [[ -z "${token}" ]]; then
    echo "Google OAuth token error: ${response}" >&2
    exit 1
  fi
  echo "${token}"
}

google_drive_find_folder() {
  local parent_id="$1"
  local name="$2"
  local token="$3"
  local escaped_name="${name//\'/\\\'}"
  local q="mimeType='application/vnd.google-apps.folder' and '${parent_id}' in parents and name='${escaped_name}' and trashed=false"
  curl -sS -G "${DRIVE_API}/files" \
    --data-urlencode "q=${q}" \
    --data-urlencode "fields=files(id)" \
    --data-urlencode "pageSize=1" \
    -H "Authorization: Bearer ${token}" | jq -r '.files[0].id // empty'
}

google_drive_create_folder() {
  local parent_id="$1"
  local name="$2"
  local token="$3"
  curl -sS -X POST "${DRIVE_API}/files" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\",\"mimeType\":\"application/vnd.google-apps.folder\",\"parents\":[\"${parent_id}\"]}" \
    | jq -r '.id // empty'
}

google_drive_ensure_folder() {
  local parent_id="$1"
  local name="$2"
  local token="$3"
  local folder_id
  folder_id="$(google_drive_find_folder "${parent_id}" "${name}" "${token}")"
  if [[ -n "${folder_id}" ]]; then
    echo "${folder_id}"
    return 0
  fi
  folder_id="$(google_drive_create_folder "${parent_id}" "${name}" "${token}")"
  if [[ -z "${folder_id}" ]]; then
    echo "Failed to create Drive folder: ${name}" >&2
    exit 1
  fi
  echo "${folder_id}"
}

# Ensures BackupRoot/YYYY/YYYY-MM/ and returns the month folder ID.
google_drive_ensure_month_folder() {
  local root_id="$1"
  local token="$2"
  local year month year_id month_id
  year="$(date +%Y)"
  month="$(date +%Y-%m)"
  year_id="$(google_drive_ensure_folder "${root_id}" "${year}" "${token}")"
  month_id="$(google_drive_ensure_folder "${year_id}" "${month}" "${token}")"
  echo "${month_id}"
}

google_drive_upload_file() {
  local file_path="$1"
  local file_name="$2"
  local folder_id="$3"
  local token="$4"
  local mime_type="${5:-application/gzip}"
  local response file_id

  response="$(curl -sS -X POST \
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink" \
    -H "Authorization: Bearer ${token}" \
    -F "metadata={\"name\":\"${file_name}\",\"parents\":[\"${folder_id}\"]};type=application/json;charset=UTF-8" \
    -F "file=@${file_path};type=${mime_type}")"

  file_id="$(echo "${response}" | jq -r '.id // empty')"
  if [[ -z "${file_id}" ]]; then
    echo "Drive upload failed for ${file_name}: ${response}" >&2
    exit 1
  fi
  echo "${response}" | jq -r '.webViewLink // .id'
}
