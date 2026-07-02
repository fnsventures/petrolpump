#!/usr/bin/env bash
# Merge the current checkout into an existing gh-pages tree (keep_files behavior).
set -euo pipefail

publish_root="${1:?publish root required}"
dest_dir="${2:-}"

git fetch origin gh-pages --depth=1 2>/dev/null || true

if git rev-parse origin/gh-pages >/dev/null 2>&1; then
  git archive origin/gh-pages | tar -x -C "$publish_root"
fi

if [ -n "$dest_dir" ]; then
  mkdir -p "${publish_root}/${dest_dir}"
  rsync -a ./ "${publish_root}/${dest_dir}/" \
    --exclude "${publish_root}" \
    --exclude .git \
    --exclude .github
else
  staging_backup=""
  if [ -d "${publish_root}/staging" ]; then
    staging_backup="$(mktemp -d)"
    mv "${publish_root}/staging" "${staging_backup}/staging"
  fi

  rsync -a ./ "${publish_root}/" \
    --exclude "${publish_root}" \
    --exclude .git \
    --exclude .github

  if [ -n "$staging_backup" ]; then
    mv "${staging_backup}/staging" "${publish_root}/staging"
    rmdir "$staging_backup"
  fi
fi
