#!/usr/bin/env bash
# Fail if a file that must never be committed is tracked by git.
# PR checks run this; safe to run locally (reads only file names, never contents).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

forbidden="$(git ls-files -- \
  'js/env.js' \
  'scripts/db.env' \
  'scripts/sync-prod-to-staging.env' \
  'scripts/migrate-prod.env' \
  'scripts/.prod-backups/*' \
  'scripts/.sync-dumps/*' \
  '*.dump' '*.sql.gz' '*.pem' '*.p12' '*service-account*.json' || true)"

if [[ -n "${forbidden}" ]]; then
  echo "These files must never be committed (secrets or customer data):" >&2
  echo "${forbidden}" >&2
  echo "Remove them with 'git rm --cached <file>' and rotate anything they contained (docs/SECRETS.md)." >&2
  exit 1
fi
echo "No forbidden files tracked."
