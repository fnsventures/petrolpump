#!/usr/bin/env node
/**
 * Bundle JavaScript for each page using esbuild with code splitting.
 * Creates optimized, tree-shaken bundles per page.
 * Usage: npm run build:js
 */

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, writeFile, mkdir, rm } from "node:fs/promises";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_SRC = path.join(REPO_ROOT, "js");
const DIST_JS = path.join(REPO_ROOT, "_site", "js");

// Pages and their required modules (shared deps will be auto-split)
const PAGE_ENTRIES = {
  "login": "js/supabaseLoginClient.js",
  "dashboard": "js/dashboard.js",
  "meter-reading": "js/meterReading.js",
  "day-closing": "js/day-closing.js",
  "credit": "js/credit.js",
  "credit-customer": "js/creditCustomer.js",
  "credit-record": "js/creditRecord.js",
  "expenses": "js/expenses.js",
  "staff": "js/staffEmployees.js",
  "settings": "js/pumpSettings.js",
  "analysis": "js/analysis.js",
  "reports": "js/reports.js",
  "invoices": "js/invoices.js",
  "billing": "js/billing.js",
  "attendance": "js/attendance.js",
  "salary": "js/salary.js",
  "e20-register": "js/e20Register.js",
  "reminders": "js/reminders.js",
  "dsr": "js/dsr.js",
  "sales-daily": "js/dsrSalesBreakdown.js",
  "letterhead": "js/letterhead.js",
  "credit-overdue": "js/creditCustomerDetail.js",
  "offline": "js/pwa.js",
  "index": "js/landing.js",
};

// Shared modules that should be split into common chunks
const SHARED_MODULES = [
  "js/utils.js",
  "js/cache.js",
  "js/errorHandler.js",
  "js/appConfig.js",
  "js/supabase.js",
  "js/pumpSettings.js",
  "js/purchaseTaxUtils.js",
  "js/taskUtils.js",
  "js/dateRangeFilter.js",
  "js/pageSections.js",
  "js/auth.js",
  "js/dsrQueries.js",
  "js/printUtils.js",
];

async function buildPageEntries() {
  console.log("Building page bundles with code splitting...");

  // Clean dist directory
  await rm(DIST_JS, { recursive: true, force: true });
  await mkdir(DIST_JS, { recursive: true });

  const entryPoints = Object.fromEntries(
    Object.entries(PAGE_ENTRIES).map(([page, entry]) => [page, path.join(REPO_ROOT, entry)])
  );

  await esbuild.build({
    entryPoints,
    outdir: DIST_JS,
    bundle: true,
    splitting: true,
    format: "esm",
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
    minify: true,
    sourcemap: true,
    outExtension: { ".js": ".js" },
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[name]",
    platform: "browser",
    treeShaking: true,
    legalComments: "none",
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    banner: {
      js: `// Bundled by esbuild - ${new Date().toISOString()}`,
    },
    loader: {
      ".js": "js",
      ".mjs": "js",
    },
    external: [],
  });

  console.log("Page bundles built successfully");
}

async function buildVendorBundles() {
  console.log("Building vendor bundles...");

  // Build supabase vendor bundle (for login page)
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, "js/supabaseLoginClient.js")],
    outfile: path.join(DIST_JS, "vendor/supabase-login.min.js"),
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "supabase",
    platform: "browser",
    target: ["es2020"],
    logLevel: "silent",
  });

  // Build main supabase bundle (for app pages) - tree-shaken
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, "js/supabase.js")],
    outfile: path.join(DIST_JS, "vendor/supabase.min.js"),
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "supabase",
    platform: "browser",
    target: ["es2020"],
    logLevel: "silent",
  });

  console.log("Vendor bundles built");
}

async function copyStaticAssets() {
  console.log("Copying static assets...");
  
  // Copy vendor files that aren't bundled
  const vendorSrc = path.join(REPO_ROOT, "js", "vendor");
  const vendorDest = path.join(DIST_JS, "vendor");
  await mkdir(vendorDest, { recursive: true });
  
  // Copy any remaining vendor files
  try {
    const entries = await readdir(vendorSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.endsWith(".min.js")) {
        await import("node:fs/promises").then(fs => 
          fs.copyFile(path.join(vendorSrc, entry.name), path.join(vendorDest, entry.name))
        );
      }
    }
  } catch {
    // vendor dir might not exist
  }
  
  console.log("Static assets copied");
}

async function main() {
  const start = Date.now();
  
  try {
    await Promise.all([
      buildVendorBundles(),
      buildPageEntries(),
    ]);
    await copyStaticAssets();
    
    console.log(`Build completed in ${Date.now() - start}ms`);
  } catch (err) {
    console.error("Build failed:", err);
    process.exit(1);
  }
}

main();