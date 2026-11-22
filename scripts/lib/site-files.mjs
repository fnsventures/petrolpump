/**
 * The one list of repo paths that never ship to GitHub Pages.
 * Used by build-site.mjs (local preview) and build-deploy.mjs (PR checks + Deploy),
 * so the PR build and the deployed site cannot drift apart.
 */

export const SITE_EXCLUDES = [
  "_site",
  ".git",
  ".github",
  "node_modules",
  "supabase",
  "docs",
  "scripts",
  "_partials",
  "tests",
  "types",
  "package.json",
  "package-lock.json",
  "jsconfig.json",
  "eslint.config.mjs",
  ".stylelintrc.json",
  ".nvmrc",
  ".gitignore",
  ".gitleaks.toml",
  ".hold-priv-check.sql",
  ".DS_Store",
  "*.md",
];

export const rsyncExcludeArgs = () => SITE_EXCLUDES.map((name) => `--exclude=${name}`);
