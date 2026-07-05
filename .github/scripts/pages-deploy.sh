#!/usr/bin/env bash
set -euo pipefail

cmd="${1:?usage: pages-deploy.sh build|publish <staging|prod> [commit-sha]}"
target="${2:?usage: pages-deploy.sh build|publish <staging|prod> [commit-sha]}"

case "$target" in
  staging|prod) ;;
  *)
    echo "invalid target: $target (expected staging or prod)" >&2
    exit 1
    ;;
esac

case "$cmd" in
  build)
    : "${SUPABASE_URL:?SUPABASE_URL is required}"
    : "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

    cat > js/env.js <<EOF
window.__APP_CONFIG__ = {
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}",
  APP_ENV: "${target}",
};
EOF

    [ "$target" = "staging" ] && rm -f CNAME

    mkdir -p _site
    git fetch origin gh-pages --depth=1 2>/dev/null || true
    if git rev-parse origin/gh-pages >/dev/null 2>&1; then
      git archive origin/gh-pages | tar -x -C _site
    else
      git fetch origin pages-state --depth=1 2>/dev/null || true
      if git rev-parse origin/pages-state >/dev/null 2>&1; then
        git archive origin/pages-state | tar -x -C _site
      fi
    fi

    touch _site/.nojekyll
    excludes=(--exclude _site --exclude .git --exclude .github --exclude supabase --exclude scripts --exclude docs)

    if [ "$target" = "staging" ]; then
      mkdir -p _site/staging
      rsync -a "${excludes[@]}" ./ _site/staging/
    else
      staging_backup=""
      if [ -d _site/staging ]; then
        staging_backup="$(mktemp -d)"
        mv _site/staging "$staging_backup/staging"
      fi
      rsync -a "${excludes[@]}" ./ _site/
      if [ -n "$staging_backup" ]; then
        mv "$staging_backup/staging" _site/staging
        rmdir "$staging_backup"
      fi
    fi
    ;;

  publish)
    commit_sha="${3:?commit-sha required for publish}"
    : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

    cd _site
    git init -q
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then
      echo "gh-pages unchanged, skipping push"
      exit 0
    fi
    git commit -q -m "deploy ${target}: ${commit_sha}"
    git branch -M gh-pages
    git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
    for attempt in 1 2 3 4 5; do
      if git push -f origin gh-pages; then
        exit 0
      fi
      echo "gh-pages push failed, retrying (${attempt}/5)..." >&2
      sleep $((attempt * 5))
    done
    echo "gh-pages push failed after 5 attempts" >&2
    exit 1
    ;;

  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
