#!/usr/bin/env node
/**
 * Single source of truth for shared static asset cache-busting (?v=).
 * Updates HTML href/src query strings and sw.js CACHE_VERSION + precache paths.
 *
 * Usage: node scripts/sync-asset-versions.mjs
 * Bump asset-version.json before deploy when shared JS/CSS changes.
 */

import { access, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(REPO_ROOT, "asset-version.json");
const SW_FILE = path.join(REPO_ROOT, "sw.js");
const CATALOG_FILE = path.join(REPO_ROOT, "_partials", "app-pages.json");

const SKIP_DIRS = new Set([
  "node_modules",
  "_site",
  "_partials",
  ".git",
  "supabase",
  "docs",
  "scripts",
]);

/** CSS files loaded only via @import — must stay unversioned in the SW precache. */
const IMPORTED_UNVERSIONED = [
  "css/fonts.css",
  "css/app-sidebar.css",
  "css/app-notifications.css",
];

const ALWAYS_UNVERSIONED = [
  "manifest.json",
  "css/landing.css",
  "css/login.css",
  "css/staff-id-print.css",
  "css/app-core.css",
  "css/app-staff.css",
  "css/reports-print.css",
  "css/report-watermark.css",
  "js/landing.js",
  "js/vendor/supabase-login.min.js",
  "js/vendor/supabase.min.js",
  "js/dsrFuelNav.js",
  "js/dsrLegacyRedirect.js",
  "js/dsrSections.js",
  "js/expenses.js",
  "js/billing.js",
  "js/invoices.js",
  "js/settings.js",
  "js/creditOverview.js",
  "js/creditRecord.js",
  "js/creditCustomerDetail.js",
  "js/creditCustomer.js",
];

const PRECACHE_ASSETS = [
  "assets/favicon-32.png",
  "assets/apple-touch-icon.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/logo-44.webp",
  "assets/logo-80.webp",
  "assets/logo-80.png",
  "assets/logo-104.webp",
  "assets/logo-104.png",
  "assets/logo-print.webp",
];

const SKIP_PRECACHE = new Set(["js/env.js", "js/env.example.js"]);

function versionAttr(pathRef, version) {
  const normalized = pathRef.replace(/^\//, "");
  return `${normalized}?v=${version}`;
}

function versionedUrl(assetPath, sharedSet, sharedVersion, pageVersions) {
  if (sharedSet.has(assetPath)) return versionAttr(assetPath, sharedVersion);
  const pageVersion = pageVersions[assetPath];
  return pageVersion ? versionAttr(assetPath, pageVersion) : assetPath;
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

async function listDirFiles(relDir, suffix) {
  const dir = path.join(REPO_ROOT, relDir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => `${relDir}/${entry.name}`);
  } catch {
    return [];
  }
}

function addUnique(list, value) {
  if (!value || SKIP_PRECACHE.has(value.split("?")[0])) return;
  if (!list.includes(value)) list.push(value);
}

function collectPageAssets(catalog) {
  const assets = new Set();
  for (const page of Object.values(catalog.pages || {})) {
    for (const css of page.css || []) assets.add(css);
    for (const group of ["earlyScripts", "beforeAuth", "afterAuth"]) {
      for (const src of page[group] || []) assets.add(src);
    }
    if (page.page) assets.add(page.page);
  }
  return assets;
}

function extractPrintCssHrefs(source) {
  return [...source.matchAll(/["'`](css\/[a-z0-9._-]+-print\.css(?:\?v=\d+)?)["'`]/gi)].map(
    (match) => match[1]
  );
}

async function collectCssImportTargets() {
  const files = await listDirFiles("css", ".css");
  const skipImports = new Set(["css/app.css", "css/style.css"]);
  const targets = new Set();
  for (const rel of files) {
    if (skipImports.has(rel)) continue;
    const text = await readFile(path.join(REPO_ROOT, rel), "utf8");
    const dir = path.dirname(rel);
    for (const match of text.matchAll(/@import\s+url\(["']?([^"')\s]+)["']?\)/g)) {
      const raw = match[1].split("?")[0];
      if (!raw || raw.startsWith("http")) continue;
      targets.add(path.posix.normalize(`${dir}/${raw}`));
    }
  }
  return targets;
}

async function buildPrecachePaths({ shared, version, catalog }) {
  const sharedSet = new Set(shared);
  const pageVersions = catalog.assetVersions || {};
  const paths = [];

  for (const html of await listDirFiles(".", ".html")) {
    addUnique(paths, html.replace(/^\.\//, ""));
  }

  for (const asset of ALWAYS_UNVERSIONED) addUnique(paths, asset);
  for (const asset of IMPORTED_UNVERSIONED) addUnique(paths, asset);
  for (const asset of PRECACHE_ASSETS) addUnique(paths, asset);
  for (const font of await listDirFiles("fonts", ".woff2")) addUnique(paths, font);

  for (const asset of shared) addUnique(paths, versionAttr(asset, version));

  for (const asset of collectPageAssets(catalog)) {
    addUnique(paths, versionedUrl(asset, sharedSet, version, pageVersions));
  }

  for (const [asset, pageVersion] of Object.entries(pageVersions)) {
    addUnique(paths, versionedUrl(asset, sharedSet, version, { [asset]: pageVersion }));
  }

  for (const jsFile of ["js/printUtils.js", "js/e20Register.js", "js/letterhead.js", "js/billing.js", "js/salary.js", "js/staff.js"]) {
    try {
      const source = await readFile(path.join(REPO_ROOT, jsFile), "utf8");
      for (const href of extractPrintCssHrefs(source)) addUnique(paths, href);
    } catch {
      /* optional */
    }
  }

  for (const imported of await collectCssImportTargets()) addUnique(paths, imported);

  return paths;
}

function parsePrecachePaths(sw) {
  const match = sw.match(/const STATIC_ASSET_PATHS = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("sw.js is missing STATIC_ASSET_PATHS");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function replacePrecachePaths(sw, paths) {
  const block = paths.map((entry) => `  "${entry}",`).join("\n");
  return sw.replace(
    /const STATIC_ASSET_PATHS = \[[\s\S]*?\];/,
    `const STATIC_ASSET_PATHS = [\n${block}\n];`
  );
}

async function verifyPrecache(sw, shared, version, catalog) {
  const paths = parsePrecachePaths(sw);
  const missingFiles = [];

  for (const entry of paths) {
    const assetPath = entry.split("?")[0];
    try {
      await access(path.join(REPO_ROOT, assetPath));
    } catch {
      missingFiles.push(assetPath);
    }
  }

  if (missingFiles.length) {
    throw new Error(
      `SW precache lists files that do not exist:\n  ${missingFiles.join("\n  ")}`
    );
  }

  const mismatches = [];
  for (const asset of shared) {
    const expected = versionAttr(asset, version);
    if (!paths.includes(expected)) {
      mismatches.push(`${asset} (expected ${expected})`);
    }
  }
  for (const asset of IMPORTED_UNVERSIONED) {
    const versioned = paths.find((entry) => entry.startsWith(`${asset}?`));
    if (versioned) {
      mismatches.push(`${asset} must stay unversioned (found ${versioned})`);
    } else if (!paths.includes(asset)) {
      mismatches.push(`${asset} must be precached without ?v=`);
    }
  }
  for (const html of Object.keys(catalog.pages || {})) {
    if (!paths.includes(html)) mismatches.push(`missing page shell ${html}`);
  }
  for (const shortcut of ["dsr.html", "meter-reading.html", "login.html", "dashboard.html"]) {
    if (!paths.includes(shortcut)) mismatches.push(`missing PWA shell ${shortcut}`);
  }

  if (mismatches.length) {
    throw new Error(`SW precache does not match HTML/CSS URLs:\n  ${mismatches.join("\n  ")}`);
  }
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

async function syncServiceWorker(shared, version, swCacheVersion, catalog) {
  let sw = await readFile(SW_FILE, "utf8");
  const before = sw;
  const paths = await buildPrecachePaths({ shared, version, catalog });

  sw = sw.replace(
    /const CACHE_VERSION = "v\d+";/,
    `const CACHE_VERSION = "${swCacheVersion}";`
  );
  sw = replacePrecachePaths(sw, paths);

  await verifyPrecache(sw, shared, version, catalog);

  if (sw !== before) {
    await writeFile(SW_FILE, sw, "utf8");
    console.log(`  sw.js → ${swCacheVersion}, ${paths.length} precache entries, ?v=${version}`);
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

  const catalog = JSON.parse(await readFile(CATALOG_FILE, "utf8"));

  console.log(`Syncing shared assets to ?v=${version} (SW ${swCacheVersion})…`);
  const htmlCount = await syncHtmlFiles(shared, version);
  const swUpdated = await syncServiceWorker(shared, version, swCacheVersion, catalog);

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
