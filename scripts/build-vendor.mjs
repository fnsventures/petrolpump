#!/usr/bin/env node
/** Bundle the minimal login Supabase client to js/vendor/supabase-login.min.js */

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [path.join(root, "js/supabaseLoginClient.js")],
  outfile: path.join(root, "js/vendor/supabase-login.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "supabase",
  platform: "browser",
  target: ["es2020"],
  logLevel: "info",
});

console.log("Login client bundle written to js/vendor/supabase-login.min.js");
