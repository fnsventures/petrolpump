#!/usr/bin/env node
/**
 * Expand HTML comment partials (e.g. shared app topbar) at build time.
 * Comments are invisible in the browser when opening source files locally.
 *
 * Usage: node scripts/build-html.mjs <dir> [--exclude <top-level-dir>]...
 */

import nunjucks from "nunjucks";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTIALS_DIR = path.join(REPO_ROOT, "_partials");
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
  { autoescape: false }
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

function extractTopbarCtx(headerHtml) {
  const pageTitle = headerHtml.match(/class="page-subtitle"[^>]*>([^<]*)</)?.[1] ?? "";
  const pageSubtitleId = headerHtml.match(/class="page-subtitle"\s+id="([^"]+)"/)?.[1];
  const topbarNoPrint = /class="topbar no-print"/.test(headerHtml);
  return { pageTitle, pageSubtitleId, topbarNoPrint };
}

function renderTopbar(ctx) {
  return env.render("app-topbar.njk", ctx).trim();
}

function expandPartials(source) {
  let output = source.replace(PARTIAL_RE, (match, name, attrs) => {
    const template = name.endsWith(".njk") ? name : `${name}.njk`;
    return renderTopbar(parsePartialAttrs(attrs));
  });

  output = output.replace(BUILD_TOPBAR_RE, (headerHtml) => renderTopbar(extractTopbarCtx(headerHtml)));

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

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
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

async function buildRoot(root, excludes) {
  const files = await collectHtmlFiles(root, excludes);
  let built = 0;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes("@partial") && !source.includes("data-build-topbar")) continue;

    const output = expandPartials(source);
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
  let total = 0;

  for (const root of roots) {
    total += await buildRoot(root, excludes);
  }

  if (!total) {
    console.log("No HTML templates expanded");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
