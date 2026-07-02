#!/usr/bin/env bash
# Keep gh-pages in sync with the live artifact so future prod/staging merges stay correct.
set -euo pipefail

site_dir="${1:?site directory required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"

cd "$site_dir"

git init -q
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "deploy: ${SOURCE_SHA}"
git branch -M gh-pages
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git push -f origin gh-pages
