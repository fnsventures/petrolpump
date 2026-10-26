#!/usr/bin/env node
/**
 * Fail when a stylesheet gains a hardcoded colour (hex, rgb()/hsl() literal, named colour).
 * Rules live in .stylelintrc.json. Existing colours are grandfathered per file in
 * scripts/css-color-baseline.json, so the count can only go down.
 *
 * Usage: node scripts/check-css-colors.mjs [--update]
 */

import stylelint from "stylelint";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "scripts", "css-color-baseline.json");
const update = process.argv.includes("--update");

const { results } = await stylelint.lint({ files: "css/**/*.css", cwd: ROOT, configBasedir: ROOT });
const counts = {};
const warnings = {};
for (const r of results) {
  const rel = path.relative(ROOT, r.source);
  if (!r.warnings.length) continue;
  counts[rel] = r.warnings.length;
  warnings[rel] = r.warnings;
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
let failed = false;
for (const [file, n] of Object.entries(counts)) {
  const allowed = baseline[file] || 0;
  if (n <= allowed) continue;
  failed = true;
  console.error(`${file}: ${n} hardcoded colours (baseline ${allowed}).`);
  for (const w of warnings[file]) console.error(`  ${w.line}:${w.column} ${w.text}`);
}
const lowered = Object.entries(baseline).filter(([f, n]) => (counts[f] || 0) < n);
if (failed) {
  console.error("\nUse a token from css/tokens.css. If a new colour is genuinely needed, add a token for it.");
  process.exit(1);
}
if (lowered.length) console.log(`Colours removed from ${lowered.length} file(s). Run with --update to lock in the lower baseline.`);
console.log("CSS colours OK.");
