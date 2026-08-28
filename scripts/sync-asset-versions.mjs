#!/usr/bin/env node
/**
 * Single source of truth for shared static asset cache-busting (?v=).
 * Updates HTML href/src query strings and sw.js CACHE_VERSION + precache paths.
 *
 * Usage: node scripts/sync-asset-versions.mjs
 * Bump asset-version.json before deploy when shared JS/CSS changes.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(REPO_ROOT, "asset-version.json");
const SW_FILE = path.join(REPO_ROOT, "sw.js");

const SKIP_DIRS = new Set([
  "node_modules",
  "_site",
  "_partials",
  ".git",
  "supabase",
  "docs",
  "scripts",
]);

function versionAttr(pathRef, version) {
  const normalized = pathRef.replace(/^\//, "");
  return `${normalized}?v=${version}`;
}

function syncAssetUrl(html, assetPath, version) {
  const escaped = assetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `((?:href|src)=["'])(${escaped})(?:\\?v=\\d+)?(["'])`,
    "g"
  );
  return html.replace(re, `$1${versionAttr(assetPath, version)}$3`);
}

async function collectHtmlFiles(root) {
  const files = [];

  async function walk(dir) {
    const rel = path.relative(root, dir);
    if (rel) {
      const top = rel.split(path.sep)[0];
      if (SKIP_DIRS.has(top)) return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        files.push(full);
      }
    }
  }

  await walk(root);
  return files;
}

async function syncHtmlFiles(shared, version) {
  const files = await collectHtmlFiles(REPO_ROOT);
  let updated = 0;

  for (const file of files) {
    let html = await readFile(file, "utf8");
    let next = html;
    for (const asset of shared) {
      next = syncAssetUrl(next, asset, version);
    }
    if (next !== html) {
      await writeFile(file, next, "utf8");
      updated += 1;
      console.log(`  ${path.relative(REPO_ROOT, file)}`);
    }
  }

  return updated;
}

async function syncServiceWorker(shared, version, swCacheVersion) {
  let sw = await readFile(SW_FILE, "utf8");
  const before = sw;

  sw = sw.replace(
    /const CACHE_VERSION = "v\d+";/,
    `const CACHE_VERSION = "${swCacheVersion}";`
  );

  for (const asset of shared) {
    const versioned = versionAttr(asset, version);
    const unversioned = `"${asset}"`;
    const withVersion = `"${versioned}"`;
    if (sw.includes(unversioned)) {
      sw = sw.replace(unversioned, withVersion);
    } else {
      const versionedOld = new RegExp(
        `"${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?v=\\d+"`
      );
      sw = sw.replace(versionedOld, `"${versioned}"`);
    }
  }

  if (sw !== before) {
    await writeFile(SW_FILE, sw, "utf8");
    console.log(`  sw.js → ${swCacheVersion}, precache ?v=${version}`);
    return true;
  }
  return false;
}

async function main() {
  const config = JSON.parse(await readFile(VERSION_FILE, "utf8"));
  const { version, swCacheVersion, shared } = config;

  if (!version || !swCacheVersion || !Array.isArray(shared) || !shared.length) {
    throw new Error("asset-version.json must define version, swCacheVersion, and shared[]");
  }

  console.log(`Syncing shared assets to ?v=${version} (SW ${swCacheVersion})…`);
  const htmlCount = await syncHtmlFiles(shared, version);
  const swUpdated = await syncServiceWorker(shared, version, swCacheVersion);

  if (!htmlCount && !swUpdated) {
    console.log("All files already in sync.");
  } else {
    console.log(`Updated ${htmlCount} HTML file(s)${swUpdated ? " and sw.js" : ""}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
