#!/usr/bin/env bash
set -euo pipefail

# Usage: save-pages-state.sh <staging|prod> <commit-sha>
TARGET="${1:?usage: save-pages-state.sh staging|prod <commit-sha>}"
COMMIT_SHA="${2:?usage: save-pages-state.sh staging|prod <commit-sha>}"

cd _site
git init -q
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "deploy ${TARGET}: ${COMMIT_SHA}"
git branch -M pages-state
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git push -f origin pages-state
