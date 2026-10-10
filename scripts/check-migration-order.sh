#!/usr/bin/env bash
# Fail when a migration added since BASE_REF sorts before the newest migration on BASE_REF.
# `supabase db push` refuses such files once later versions are applied on the remote.
#
# Usage:
#   ./scripts/check-migration-order.sh                 # compare against origin/staging
#   BASE_REF=origin/main ./scripts/check-migration-order.sh
set -euo pipefail

BASE_REF="${BASE_REF:-origin/staging}"
DIR="supabase/migrations"
NAME_RE='^[0-9]{14}_[a-z0-9_]+\.sql$'

cd "$(dirname "$0")/.."

status=0

for f in "${DIR}"/*.sql; do
  name="$(basename "$f")"
  if ! [[ "$name" =~ $NAME_RE ]]; then
    echo "::error file=${f}::Bad migration name '${name}' (want YYYYMMDDHHMMSS_snake_case.sql)"
    status=1
  fi
done

dupes="$(ls "${DIR}" | cut -c1-14 | sort | uniq -d)"
if [ -n "$dupes" ]; then
  echo "::error::Duplicate migration versions: ${dupes}"
  status=1
fi

if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  echo "Base ref ${BASE_REF} not found — skipping order check (fetch it first)."
  exit "$status"
fi

latest_base="$(git ls-tree --name-only "${BASE_REF}" "${DIR}/" | xargs -n1 basename | sort | tail -1)"
added="$(git diff --name-only --diff-filter=A "${BASE_REF}...HEAD" -- "${DIR}/" | xargs -rn1 basename | sort)"

for name in $added; do
  if [[ "$name" < "$latest_base" ]]; then
    echo "::error file=${DIR}/${name}::${name} sorts before ${latest_base} (newest on ${BASE_REF}). Rename it with a current timestamp: supabase migration new <name>"
    status=1
  fi
done

[ "$status" -eq 0 ] && echo "Migration names and order OK (newest on ${BASE_REF}: ${latest_base})."
exit "$status"
