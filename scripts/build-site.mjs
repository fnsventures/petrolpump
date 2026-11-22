#!/usr/bin/env node
/**
 * Sync repo → _site and expand HTML partials (local preview / CI mirror).
 * Usage: npm run build:site
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rsyncExcludeArgs } from "./lib/site-files.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = path.join(REPO_ROOT, "_site");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

await run("rsync", ["-a", "--delete", ...rsyncExcludeArgs(), `${REPO_ROOT}/`, `${SITE_DIR}/`]);
await run("node", ["scripts/build-html.mjs", SITE_DIR]);
await run("node", ["scripts/stamp-assets.mjs", SITE_DIR]);
console.log(`Built preview site at ${SITE_DIR}`);
