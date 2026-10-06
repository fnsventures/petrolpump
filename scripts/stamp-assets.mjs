#!/usr/bin/env node
/**
 * Build-time cache busting for a deploy directory (never touches the repo).
 *
 * - Rewrites local JS/CSS references to `path?v=<content-hash>` in:
 *     HTML src/href attributes, CSS @import url(...), and JS string literals
 *     that are exactly "js/….js" or "css/….css".
 * - Fills sw.js CACHE_VERSION and STATIC_ASSET_PATHS from the stamped output.
 *
 * A file's hash covers its content after its own references are stamped, so a
 * change in an imported stylesheet or lazily loaded script propagates upward.
 *
 * Usage: node scripts/stamp-assets.mjs <dir> [--exclude <top-level-dir>]...
 * Run after build-html.mjs and before minify-assets.mjs.
 */

import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Never versioned or precached: generated per environment at deploy. */
const UNSTAMPED = new Set(["js/env.js", "js/env.example.js"]);

/** Source-only files that pages never load directly. */
const NOT_PRECACHED = new Set([...UNSTAMPED, "js/supabaseLoginClient.js"]);

const PRECACHE_IMAGES = [
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

const HTML_REF_RE = /((?:href|src)=["'])([^"'?#:]+\.(?:js|css))(?:\?v=[^"']*)?(["'])/g;
const CSS_IMPORT_RE = /(@import\s+url\(\s*["']?)([^"')?\s]+\.css)(?:\?v=[^"')\s]*)?(["']?\s*\))/g;
const JS_LITERAL_RE = /(["'`])((?:\.\/)?(?:js|css)\/[A-Za-z0-9._/-]+\.(?:js|css))(?:\?v=[A-Za-z0-9]*)?\1/g;

function parseArgs(argv) {
  const excludes = new Set();
  const roots = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--exclude") {
      const name = argv[++i];
      if (!name) throw new Error("--exclude requires a directory name");
      excludes.add(name);
      continue;
    }
    if (arg === "--") continue;
    roots.push(path.resolve(arg));
  }
  if (roots.length !== 1) {
    throw new Error("usage: node scripts/stamp-assets.mjs <dir> [--exclude <name>]...");
  }
  return { root: roots[0], excludes };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, relDir, suffix) {
  try {
    const entries = await readdir(path.join(root, relDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => (relDir === "." ? entry.name : `${relDir}/${entry.name}`))
      .sort();
  } catch {
    return [];
  }
}

function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

export function createStamper(root) {
  const hashes = new Map();
  const outputs = new Map();
  const inProgress = new Set();

  /** Root-relative posix path for a reference, or null if it is not a local asset we stamp. */
  function resolveRef(ref, fromRel) {
    if (/^[a-z]+:/i.test(ref) || ref.startsWith("//")) return null;
    const baseDir = fromRel ? path.posix.dirname(fromRel) : ".";
    const rel = ref.startsWith("/")
      ? ref.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, ref));
    if (rel.startsWith("..") || UNSTAMPED.has(rel)) return null;
    return rel;
  }

  async function hashOf(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    if (!(await exists(path.join(root, rel)))) return null;
    // Mutual references (a.js names b.js and vice versa): fall back to the raw content hash.
    if (inProgress.has(rel)) return shortHash(await readFile(path.join(root, rel), "utf8"));
    inProgress.add(rel);
    const source = await readFile(path.join(root, rel), "utf8");
    const stamped = await rewrite(source, rel);
    inProgress.delete(rel);
    outputs.set(rel, stamped);
    const hash = shortHash(stamped);
    hashes.set(rel, hash);
    return hash;
  }

  async function replaceAsync(text, re, fn) {
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;
    const replacements = await Promise.all(matches.map(fn));
    let out = "";
    let last = 0;
    matches.forEach((match, i) => {
      out += text.slice(last, match.index) + replacements[i];
      last = match.index + match[0].length;
    });
    return out + text.slice(last);
  }

  async function stampRef(ref, resolvedRel) {
    if (!resolvedRel) return null;
    const hash = await hashOf(resolvedRel);
    return hash ? `${ref}?v=${hash}` : null;
  }

  async function rewrite(source, rel) {
    if (rel.endsWith(".css")) {
      return replaceAsync(source, CSS_IMPORT_RE, async ([full, pre, ref, post]) => {
        const stamped = await stampRef(ref, resolveRef(ref, rel));
        return stamped ? `${pre}${stamped}${post}` : full;
      });
    }
    if (rel.endsWith(".js")) {
      return replaceAsync(source, JS_LITERAL_RE, async ([full, quote, ref]) => {
        // JS literals are resolved against the page URL, i.e. the deploy root.
        const stamped = await stampRef(ref, resolveRef(ref.replace(/^\.\//, ""), null));
        return stamped ? `${quote}${stamped}${quote}` : full;
      });
    }
    if (rel.endsWith(".html")) {
      return replaceAsync(source, HTML_REF_RE, async ([full, pre, ref, post]) => {
        const stamped = await stampRef(ref, resolveRef(ref, rel));
        return stamped ? `${pre}${stamped}${post}` : full;
      });
    }
    return source;
  }

  return { hashOf, rewrite, outputs, hashes };
}

async function main() {
  const { root, excludes } = parseArgs(process.argv.slice(2));
  const stamper = createStamper(root);

  const htmlFiles = await listFiles(root, ".", ".html");
  const assetFiles = [
    ...(await listFiles(root, "css", ".css")),
    ...(await listFiles(root, "js", ".js")),
    ...(await listFiles(root, "js/vendor", ".js")),
  ].filter((rel) => !UNSTAMPED.has(rel) && !excludes.has(rel.split("/")[0]));

  for (const rel of assetFiles) await stamper.hashOf(rel);

  let written = 0;
  for (const [rel, content] of stamper.outputs) {
    const file = path.join(root, rel);
    if ((await readFile(file, "utf8")) !== content) {
      await writeFile(file, content, "utf8");
      written += 1;
    }
  }
  for (const rel of htmlFiles) {
    const file = path.join(root, rel);
    const source = await readFile(file, "utf8");
    const stamped = await stamper.rewrite(source, rel);
    if (stamped !== source) {
      await writeFile(file, stamped, "utf8");
      written += 1;
    }
  }

  const precache = [
    ...htmlFiles,
    "manifest.json",
    ...assetFiles
      .filter((rel) => !NOT_PRECACHED.has(rel))
      .map((rel) => `${rel}?v=${stamper.hashes.get(rel)}`),
    ...(await listFiles(root, "fonts", ".woff2")),
    ...PRECACHE_IMAGES,
  ];
  for (const entry of precache) {
    if (!(await exists(path.join(root, entry.split("?")[0])))) {
      throw new Error(`Precache entry does not exist in ${root}: ${entry}`);
    }
  }

  const swFile = path.join(root, "sw.js");
  let sw = await readFile(swFile, "utf8");
  const cacheVersion = shortHash(precache.join("\n"));
  const swBefore = sw;
  sw = sw.replace(/const CACHE_VERSION = "[^"]*";/, `const CACHE_VERSION = "${cacheVersion}";`);
  sw = sw.replace(
    /const STATIC_ASSET_PATHS = \[[\s\S]*?\];/,
    `const STATIC_ASSET_PATHS = ${JSON.stringify(precache, null, 2)};`
  );
  if (sw === swBefore || !sw.includes(cacheVersion)) {
    throw new Error("sw.js is missing CACHE_VERSION / STATIC_ASSET_PATHS placeholders");
  }
  await writeFile(swFile, sw, "utf8");

  console.log(
    `Stamped ${written} file(s) under ${root}; sw.js ${cacheVersion}, ${precache.length} precache entries`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
