#!/usr/bin/env node
/** Bundle the login Supabase client and the in-page PDF preview. */

import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
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

const pdfDir = path.join(root, "js/pdf");
await mkdir(pdfDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, "js/pdfPreviewClient.js")],
  outfile: path.join(pdfDir, "pdf-preview.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  logLevel: "info",
});
await copyFile(
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(pdfDir, "pdf.worker.min.js")
);

console.log("Vendor bundles written to js/vendor and js/pdf");
