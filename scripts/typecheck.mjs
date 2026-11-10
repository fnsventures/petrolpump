#!/usr/bin/env node
// Type-check every `// @ts-check` script in js/ against types/db.d.ts.
//
// Classic scripts share one global scope, so checking all of js/ at once gives false
// "cannot redeclare" errors between page scripts. Instead this runs tsc once per page, with
// exactly the scripts that page loads (from _partials/app-pages.json, in build-html.mjs order).
// Pages whose own scripts are all unchecked are skipped; shared checked scripts (utils.js, …)
// are covered by every run, and errors are de-duplicated.
//
//   npm run typecheck              # all pages with checked scripts
//   npm run typecheck -- salary    # only pages whose name contains "salary"

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const catalog = JSON.parse(readFileSync(path.join(root, "_partials/app-pages.json"), "utf8"));
const outDir = path.join(root, "node_modules/.cache/typecheck");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const filter = process.argv[2] || "";

// Vendored bundles and the generated env.js are not ours to check (and are huge or secret).
const SKIP = new Set(["js/env.js"]);
const isCheckable = (file) => file.startsWith("js/") && !file.startsWith("js/vendor/") && !SKIP.has(file);

const checked = new Map();
function isChecked(file) {
  if (!checked.has(file)) {
    let first = "";
    try {
      first = readFileSync(path.join(root, file), "utf8").split("\n", 1)[0];
    } catch {
      /* missing file: build-html reports it */
    }
    checked.set(file, first.trim() === "// @ts-check");
  }
  return checked.get(file);
}

// Scripts a page loads later with loadScript() (not in app-pages.json). Keep in step with
// loadCreditModule() calls in js/credit.js.
const LAZY = {
  "credit.html": ["js/creditOverview.js", "js/creditRecord.js", "js/creditCustomerDetail.js", "js/creditCustomer.js"],
};

/** Same order as scripts/build-html.mjs pageScripts(), then lazily loaded modules. */
function pageScripts(name, page) {
  return [
    ...(catalog.earlyJs || []),
    ...(page.earlyScripts || []),
    ...(catalog.sharedJs || []),
    ...(page.beforeAuth || []),
    "js/auth.js",
    ...(catalog.sharedAfterAuth || []),
    ...(page.afterAuth || []),
    page.page,
    ...(LAZY[name] || []),
  ].filter(Boolean);
}

const shared = new Set([...(catalog.earlyJs || []), ...(catalog.sharedJs || []), "js/auth.js", ...(catalog.sharedAfterAuth || [])]);

const runs = [];
for (const [name, page] of Object.entries(catalog.pages)) {
  if (filter && !name.includes(filter)) continue;
  const files = [...new Set(pageScripts(name, page).filter(isCheckable))];
  const ownChecked = files.filter((f) => !shared.has(f) && isChecked(f));
  runs.push({ name, files, ownChecked });
}
const selected = runs.filter((r) => r.ownChecked.length > 0);
if (selected.length === 0) {
  console.error(`No page with a // @ts-check page script matches "${filter}".`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

function runTsc({ name, files }) {
  const config = {
    extends: path.join(root, "jsconfig.json"),
    files: [path.join(root, "types/globals.d.ts"), ...files.map((f) => path.join(root, f))],
  };
  const configPath = path.join(outDir, `${name.replace(/\W+/g, "_")}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsc, "-p", configPath, "--pretty", "false"], { cwd: root });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ name, code, out }));
  });
}

const results = await Promise.all(selected.map(runTsc));

const seen = new Set();
const errors = [];
for (const { name, code, out } of results) {
  // tsc prints one diagnostic per line starting with the file path; continuation lines are indented.
  let current = null;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    if (/^\S.*\(\d+,\d+\): error TS\d+/.test(line)) {
      current = line.startsWith(root) ? path.relative(root, line) : line;
      if (!seen.has(current)) {
        seen.add(current);
        errors.push({ page: name, text: current });
      } else {
        current = null;
      }
    } else if (current) {
      errors[errors.length - 1].text += "\n" + line;
    } else if (code !== 0 && !/^\s/.test(line)) {
      errors.push({ page: name, text: line });
    }
  }
}

for (const e of errors) console.log(`${e.text}  [${e.page}]`);
const pages = selected.map((r) => r.name).join(", ");
if (errors.length) {
  console.error(`\n${errors.length} type error(s). Checked pages: ${pages}`);
  process.exit(1);
}
console.log(`Type check passed: ${pages}`);
