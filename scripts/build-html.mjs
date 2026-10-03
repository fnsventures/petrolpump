#!/usr/bin/env node
/**
 * Expand HTML comment partials at build time.
 *
 * Authenticated pages:
 *   <!-- @partial app-head -->     ← assets from _partials/app-pages.json
 *   <!-- @partial app-topbar title="Dashboard" noPrint -->
 *
 * Usage: node scripts/build-html.mjs <dir> [--exclude <top-level-dir>]...
 */

import nunjucks from "nunjucks";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTIALS_DIR = path.join(REPO_ROOT, "_partials");
const CATALOG_FILE = path.join(PARTIALS_DIR, "app-pages.json");
const VERSION_FILE = path.join(REPO_ROOT, "asset-version.json");
const PARTIAL_RE = /<!--\s*@partial\s+([\w.-]+)([\s\S]*?)-->/g;
const BUILD_TOPBAR_RE =
  /<header\s+class="topbar(?: no-print)?"[^>]*\bdata-build-topbar\b[^>]*>[\s\S]*?<\/header>/g;

const SKIP_DIRS = new Set([
  "node_modules",
  "_site",
  "_partials",
  ".git",
  "supabase",
  "docs",
  "scripts",
]);

const PARTIAL_ATTRS = {
  title: "pageTitle",
  subtitleId: "pageSubtitleId",
  noPrint: "topbarNoPrint",
};

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(PARTIALS_DIR, { noCache: true }),
  { autoescape: true }
);

function parsePartialAttrs(attrStr) {
  const ctx = {};

  for (const match of attrStr.matchAll(/(\w+)="([^"]*)"/g)) {
    const [, key, value] = match;
    ctx[PARTIAL_ATTRS[key] || key] = value;
  }

  for (const match of attrStr.matchAll(/(?:^|\s)(\w+)(?=\s|$)/g)) {
    const key = match[1];
    const ctxKey = PARTIAL_ATTRS[key] || key;
    if (!(ctxKey in ctx)) ctx[ctxKey] = true;
  }

  return ctx;
}

function decodeEntities(value) {
  let out = String(value || "");
  let prev;
  do {
    prev = out;
    out = out
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  } while (out !== prev);
  return out;
}

function extractTopbarCtx(headerHtml) {
  const pageTitle = decodeEntities(headerHtml.match(/class="page-subtitle"[^>]*>([^<]*)</)?.[1] ?? "");
  const pageSubtitleId = headerHtml.match(/class="page-subtitle"\s+id="([^"]+)"/)?.[1];
  const topbarNoPrint = /class="topbar no-print"/.test(headerHtml);
  return { pageTitle, pageSubtitleId, topbarNoPrint };
}

function versionedUrl(href, sharedSet, sharedVersion, versions) {
  const [assetPath] = String(href || "").split("?");
  if (!assetPath) return href;
  if (sharedSet.has(assetPath)) return `${assetPath}?v=${sharedVersion}`;
  const pageVersion = versions[assetPath];
  return pageVersion ? `${assetPath}?v=${pageVersion}` : assetPath;
}

function buildHeadContext(page, sharedSet, sharedVersion, versions) {
  const v = (href) => versionedUrl(href, sharedSet, sharedVersion, versions);
  const scripts = [
    ...(page.sharedJs || []),
    ...(page.beforeAuth || []),
    "js/auth.js",
    ...(page.sharedAfterAuth || []),
    ...(page.afterAuth || []),
    page.page,
  ].filter(Boolean);

  return {
    title: page.title || "Bishnupriya Fuels",
    baseCss: v("css/base.css"),
    layoutCss: v("css/app-layout.css"),
    coreCss: v("css/app-core.css"),
    roleBootstrap: v("js/roleBootstrap.js"),
    appNav: v("js/appNav.js"),
    earlyScripts: (page.earlyScripts || []).map(v),
    css: (page.css || []).map(v),
    scripts: scripts.map(v),
  };
}

function layerForFile(fileName, catalog) {
  const layers = catalog.navLayers || {};
  for (const [label, files] of Object.entries(layers)) {
    if ((files || []).includes(fileName)) return label;
  }
  return "";
}

function expandPartials(source, { fileName, catalog, sharedSet, sharedVersion }) {
  const page = catalog.pages?.[fileName];
  const versions = catalog.assetVersions || {};
  const pageDefaults = page
    ? {
        pageTitle: page.pageTitle || "",
        topbarNoPrint: Boolean(page.noPrint),
        pageLayer: page.layer || layerForFile(fileName, catalog),
      }
    : { pageLayer: layerForFile(fileName, catalog) };

  let output = source.replace(PARTIAL_RE, (match, name, attrs) => {
    const template = name.endsWith(".njk") ? name : `${name}.njk`;
    const attrCtx = parsePartialAttrs(attrs);
    if (name === "app-head" || template === "app-head.njk") {
      if (!page) {
        throw new Error(`${fileName}: <!-- @partial app-head --> needs an entry in _partials/app-pages.json`);
      }
      return env.render(template, buildHeadContext(page, sharedSet, sharedVersion, versions)).trim();
    }
    return env.render(template, { ...pageDefaults, ...attrCtx }).trim();
  });

  output = output.replace(BUILD_TOPBAR_RE, (headerHtml) =>
    env.render("app-topbar.njk", { ...pageDefaults, ...extractTopbarCtx(headerHtml) }).trim()
  );

  return output;
}

async function collectHtmlFiles(root, excludes = new Set()) {
  const files = [];

  async function walk(dir) {
    const rel = path.relative(root, dir);
    if (rel) {
      const topSegment = rel.split(path.sep)[0];
      if (excludes.has(topSegment)) return;
    }

    const dirents = await readdir(dir, { withFileTypes: true });
    for (const entry of dirents) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".html")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(root);
  return files;
}

function parseArgs(argv) {
  const excludes = new Set();
  const roots = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--exclude") {
      const name = argv[++i];
      if (!name) {
        throw new Error("--exclude requires a directory name");
      }
      excludes.add(name);
      continue;
    }
    if (arg === "--") continue;
    roots.push(arg);
  }

  if (!roots.length) {
    throw new Error("usage: node scripts/build-html.mjs <dir> [--exclude <name>]...");
  }

  return {
    roots: roots.map((root) => path.resolve(root)),
    excludes,
  };
}

async function loadBuildConfig() {
  const catalog = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
  const versionConfig = JSON.parse(await readFile(VERSION_FILE, "utf8"));
  const sharedSet = new Set(versionConfig.shared || []);
  for (const asset of catalog.sharedCss || []) sharedSet.add(asset);
  for (const asset of catalog.earlyJs || []) sharedSet.add(asset);
  for (const asset of catalog.sharedJs || []) {
    if (!asset.includes("vendor/") && asset !== "js/env.js") sharedSet.add(asset);
  }
  for (const asset of catalog.sharedAfterAuth || []) sharedSet.add(asset);
  sharedSet.add("css/app-layout.css");
  return {
    catalog: {
      ...catalog,
      pages: Object.fromEntries(
        Object.entries(catalog.pages || {}).map(([file, page]) => [
          file,
          { ...page, sharedJs: catalog.sharedJs, sharedAfterAuth: catalog.sharedAfterAuth },
        ])
      ),
    },
    sharedSet,
    sharedVersion: versionConfig.version,
  };
}

async function buildRoot(root, excludes, config) {
  const files = await collectHtmlFiles(root, excludes);
  let built = 0;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes("@partial") && !source.includes("data-build-topbar")) continue;

    const output = expandPartials(source, {
      fileName: path.basename(file),
      ...config,
    });
    if (output === source) continue;

    await writeFile(file, output, "utf8");
    built += 1;
    console.log(`built ${path.relative(root, file)}`);
  }

  if (!built) {
    console.log(`No templated HTML under ${root}`);
  } else {
    console.log(`Expanded ${built} HTML file(s) under ${root}`);
  }

  return built;
}

async function main() {
  const { roots, excludes } = parseArgs(process.argv.slice(2));
  const config = await loadBuildConfig();
  let total = 0;

  for (const root of roots) {
    total += await buildRoot(root, excludes, config);
  }

  if (!total) {
    console.log("No HTML templates expanded");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
