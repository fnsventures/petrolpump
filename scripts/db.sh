#!/usr/bin/env bash
# Database maintenance entry point. See scripts/README.md for the full guide.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-help}"
shift || true

usage() {
  cat <<'EOF'
Bishnupriya Fuels — database scripts

Setup (once):
  cp scripts/db.env.example scripts/db.env
  # Edit PROD_DB_URL and STAGING_DB_URL (Session pooler URIs from Supabase Connect)

Commands:
  sync              Copy prod data → staging for testing (prod read-only)
  migrate           Preflight + dry-run prod migration (no changes)
  migrate --apply   Backup + apply migrations + verify on prod
  backup            Standalone prod backup (schema + data)
  preflight         Prod preflight checks only
  help              Show this message

Release order:
  1. ./scripts/db.sh sync
  2. Push to staging branch → test /staging/
  3. ./scripts/db.sh migrate          (review output)
  4. ./scripts/db.sh migrate --apply  (quiet window)
  5. Merge staging → main → smoke-test live site

Docs: scripts/README.md
EOF
}

case "${CMD}" in
  sync)
    exec "${ROOT}/scripts/sync-prod-to-staging.sh" "$@"
    ;;
  migrate)
    if [[ "${1:-}" == "--apply" ]]; then
      export CONFIRM_PROD_MIGRATE=yes
    fi
    exec "${ROOT}/scripts/migrate-prod.sh" "$@"
    ;;
  backup)
    exec "${ROOT}/scripts/backup-prod.sh" "$@"
    ;;
  preflight)
    export CONFIRM_PROD_MIGRATE=
    exec "${ROOT}/scripts/migrate-prod.sh" "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: ${CMD}"
    echo
    usage
    exit 1
    ;;
esac
