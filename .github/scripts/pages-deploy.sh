#!/usr/bin/env bash
set -euo pipefail

cmd="${1:?usage: pages-deploy.sh build|save-state <staging|prod> [commit-sha]}"
target="${2:?usage: pages-deploy.sh build|save-state <staging|prod> [commit-sha]}"

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
    git fetch origin pages-state --depth=1 2>/dev/null || true
    if git rev-parse origin/pages-state >/dev/null 2>&1; then
      git archive origin/pages-state | tar -x -C _site
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

  save-state)
    commit_sha="${3:?commit-sha required for save-state}"
    : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

    cd _site
    git init -q
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then
      echo "pages-state unchanged, skipping push"
      exit 0
    fi
    git commit -q -m "deploy ${target}: ${commit_sha}"
    git branch -M pages-state
    git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
    git push -f origin pages-state
    ;;

  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
