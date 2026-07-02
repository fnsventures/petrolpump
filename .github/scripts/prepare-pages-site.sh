#!/usr/bin/env bash
# Build the static site artifact, merging with the gh-pages state branch when needed.
set -euo pipefail

publish_root="${1:?publish root required}"
deploy_target="${DEPLOY_TARGET:?DEPLOY_TARGET is required (prod or staging)}"

git fetch origin gh-pages --depth=1 2>/dev/null || true

if git rev-parse origin/gh-pages >/dev/null 2>&1; then
  git archive origin/gh-pages | tar -x -C "$publish_root"
fi

touch "${publish_root}/.nojekyll"

rsync_common=(
  -a
  --exclude _site
  --exclude .git
  --exclude .github
)

if [ "$deploy_target" = "staging" ]; then
  mkdir -p "${publish_root}/staging"
  rsync "${rsync_common[@]}" ./ "${publish_root}/staging/"
else
  staging_backup=""
  if [ -d "${publish_root}/staging" ]; then
    staging_backup="$(mktemp -d)"
    mv "${publish_root}/staging" "${staging_backup}/staging"
  fi

  rsync "${rsync_common[@]}" ./ "${publish_root}/"

  if [ -n "$staging_backup" ]; then
    mv "${staging_backup}/staging" "${publish_root}/staging"
    rmdir "$staging_backup"
  fi
fi
