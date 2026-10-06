#!/usr/bin/env node
/**
 * Verify relative links and #anchors in Markdown docs resolve.
 * Anchors: GitHub heading slugs plus explicit <a id="…"> tags.
 *
 * Usage: node scripts/check-doc-links.mjs   (exit 1 on any broken link)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "_site", ".deploy-test", "vendor"]);

function listMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsFor(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const anchors = new Set();
  const seen = new Map();
  const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) {
      const base = slugify(m[1]);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      anchors.add(n ? `${base}-${n}` : base);
    }
    for (const id of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(id[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

let broken = 0;
for (const file of listMarkdown(ROOT)) {
  const rel = path.relative(ROOT, file);
  for (const m of stripCode(fs.readFileSync(file, "utf8")).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const link = m[1];
    if (/^[a-z]+:/i.test(link)) continue;
    const [p, anchor] = link.split("#");
    const target = p ? path.resolve(path.dirname(file), decodeURI(p)) : file;
    if (!fs.existsSync(target)) {
      console.log(`${rel}: missing file → ${link}`);
      broken++;
    } else if (anchor && target.endsWith(".md") && !anchorsFor(target).has(anchor)) {
      console.log(`${rel}: missing anchor → ${link}`);
      broken++;
    }
  }
}

if (broken) {
  console.error(`\n${broken} broken link(s).`);
  process.exit(1);
}
console.log("All Markdown links resolve.");
