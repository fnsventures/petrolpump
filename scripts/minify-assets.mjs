#!/usr/bin/env node
/**
 * Minify all .js and .css files under a deploy directory in place.
 * Used by CI after rsync to _site (see .github/workflows/deploy-pages.yml).
 *
 * Usage: node scripts/minify-assets.mjs <dir> [--exclude <top-level-dir>]...
 */

import * as esbuild from "esbuild";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function collectAssetFiles(root, excludes) {
  const files = [];

  async function walk(dir) {
    const rel = path.relative(root, dir);
    if (rel) {
      const topSegment = rel.split(path.sep)[0];
      if (excludes.has(topSegment)) return;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(js|css)$/i.test(entry.name)) {
        files.push(full);
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
    roots.push(arg);
  }

  if (!roots.length) {
    throw new Error("usage: node scripts/minify-assets.mjs <dir> [--exclude <name>]...");
  }

  return { roots, excludes };
}

async function minifyRoot(root, excludes) {
  const absRoot = path.resolve(root);
  const files = await collectAssetFiles(absRoot, excludes);
  if (!files.length) {
    console.log(`No JS/CSS files under ${root}`);
    return 0;
  }

  await esbuild.build({
    entryPoints: files,
    outbase: absRoot,
    outdir: absRoot,
    minify: true,
    allowOverwrite: true,
    logLevel: "info",
  });

  console.log(`Minified ${files.length} files under ${root}`);
  return files.length;
}

async function main() {
  const { roots, excludes } = parseArgs(process.argv.slice(2));
  let total = 0;

  for (const root of roots) {
    total += await minifyRoot(root, excludes);
  }

  if (!total) {
    console.log("No JS/CSS files to minify");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
