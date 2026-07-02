#!/usr/bin/env bash
set -euo pipefail

# Usage: build-pages-site.sh <staging|prod>
TARGET="${1:?usage: build-pages-site.sh staging|prod}"

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

cat > js/env.js <<EOF
window.__APP_CONFIG__ = {
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}",
  APP_ENV: "${TARGET}",
};
EOF

if [ "$TARGET" = "staging" ]; then
  rm -f CNAME
fi

mkdir -p _site
git fetch origin pages-state --depth=1 2>/dev/null || true

if git rev-parse origin/pages-state >/dev/null 2>&1; then
  git archive origin/pages-state | tar -x -C _site
fi

touch _site/.nojekyll
rsync_excludes=(--exclude _site --exclude .git --exclude .github --exclude supabase --exclude scripts --exclude docs)

if [ "$TARGET" = "staging" ]; then
  mkdir -p _site/staging
  rsync -a "${rsync_excludes[@]}" ./ _site/staging/
else
  staging_backup=""
  if [ -d _site/staging ]; then
    staging_backup="$(mktemp -d)"
    mv _site/staging "$staging_backup/staging"
  fi
  rsync -a "${rsync_excludes[@]}" ./ _site/
  if [ -n "$staging_backup" ]; then
    mv "$staging_backup/staging" _site/staging
    rmdir "$staging_backup"
  fi
fi
