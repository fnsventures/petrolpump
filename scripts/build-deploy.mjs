#!/usr/bin/env node
/**
 * Build the GitHub Pages tree exactly as it ships. Used by Deploy and by PR checks,
 * so a green PR build means the deploy build works too.
 *
 * Usage: node scripts/build-deploy.mjs <staging|prod> <out-dir>
 *
 *   prod     repo → <out-dir>/ ; an existing <out-dir>/staging/ is left as it is
 *   staging  repo → <out-dir>/staging/ (no CNAME); the prod root is left as it is
 *
 * js/env.js must already exist (Deploy writes it from environment secrets; PR checks
 * copy js/env.example.js). <out-dir> may already hold the current gh-pages tree.
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rsyncExcludeArgs } from "./lib/site-files.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
    );
  });
}

const [target, outArg] = process.argv.slice(2);
if (!["staging", "prod"].includes(target) || !outArg) {
  console.error("usage: node scripts/build-deploy.mjs <staging|prod> <out-dir>");
  process.exit(1);
}

try {
  await access(path.join(REPO_ROOT, "js/env.js"));
} catch {
  console.error("js/env.js is missing. Deploy writes it from secrets; for a dry build copy js/env.example.js.");
  process.exit(1);
}

const outDir = path.resolve(REPO_ROOT, outArg);
const siteRoot = target === "staging" ? path.join(outDir, "staging") : outDir;
// Root-anchored: staging has no custom domain, and prod must not overwrite /staging/.
const targetExcludes = target === "staging" ? ["--exclude=/CNAME"] : ["--exclude=/staging"];
const buildExcludes = target === "staging" ? [] : ["--exclude", "staging"];

await mkdir(siteRoot, { recursive: true });
await writeFile(path.join(outDir, ".nojekyll"), "");

await run("node", ["scripts/build-vendor.mjs"]);
await run("rsync", ["-a", ...rsyncExcludeArgs(), ...targetExcludes, `${REPO_ROOT}/`, `${siteRoot}/`]);
await run("node", ["scripts/build-html.mjs", siteRoot, ...buildExcludes]);
await run("node", ["scripts/stamp-assets.mjs", siteRoot, ...buildExcludes]);
await run("node", ["scripts/minify-assets.mjs", siteRoot, ...buildExcludes]);

console.log(`Built ${target} site at ${siteRoot}`);
