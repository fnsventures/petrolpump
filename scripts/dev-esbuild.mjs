#!/usr/bin/env node
/**
 * Development server with esbuild for fast rebuilds and hot reloading.
 * Usage: npm run dev:esbuild
 */

import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { readFile, access } from "node:fs/promises";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = path.join(REPO_ROOT, "_site");
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

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

async function buildForDev() {
  const entryPoints = Object.fromEntries(
    Object.entries(PAGE_ENTRIES).map(([page, entry]) => [page, path.join(REPO_ROOT, entry)])
  );

  const ctx = await esbuild.context({
    entryPoints,
    outdir: path.join(SITE_DIR, "js"),
    bundle: true,
    splitting: true,
    format: "esm",
    target: ["es2020"],
    sourcemap: "inline",
    outExtension: { ".js": ".js" },
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[name]",
    platform: "browser",
    treeShaking: true,
    legalComments: "none",
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": '"development"',
    },
    loader: {
      ".js": "js",
      ".mjs": "js",
    },
    external: [],
  });

  await ctx.watch();
  console.log("esbuild watching for changes...");

  // Also build vendor bundles
  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(REPO_ROOT, "js/supabaseLoginClient.js")],
      outfile: path.join(SITE_DIR, "js/vendor/supabase-login.min.js"),
      bundle: true,
      minify: false,
      format: "iife",
      globalName: "supabase",
      platform: "browser",
      target: ["es2020"],
      sourcemap: "inline",
      logLevel: "silent",
    }),
    esbuild.build({
      entryPoints: [path.join(REPO_ROOT, "js/supabase.js")],
      outfile: path.join(SITE_DIR, "js/vendor/supabase.min.js"),
      bundle: true,
      minify: false,
      format: "iife",
      globalName: "supabase",
      platform: "browser",
      target: ["es2020"],
      sourcemap: "inline",
      logLevel: "silent",
    }),
  ]);

  return ctx;
}

async function prepareSite() {
  await spawn("node", ["scripts/build-site.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const abs = path.resolve(SITE_DIR, rel);
  if (!abs.startsWith(SITE_DIR)) return null;
  return abs;
}

async function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(body);
}

async function main() {
  console.log("Preparing site...");
  await prepareSite();

  console.log("Starting esbuild dev server...");
  const ctx = await buildForDev();

  const server = http.createServer(async (req, res) => {
    try {
      let filePath = safePath(req.url || "/");
      if (!filePath) {
        res.writeHead(403).end("Forbidden");
        return;
      }

      try {
        await access(filePath);
      } catch {
        const fallback = path.join(SITE_DIR, "404.html");
        try {
          await access(fallback);
          await serveFile(res, fallback);
          return;
        } catch {
          res.writeHead(404).end("Not found");
          return;
        }
      }

      const stat = await import("node:fs/promises").then((m) => m.stat(filePath));
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      await serveFile(res, filePath);
    } catch (err) {
      console.error(err);
      res.writeHead(500).end("Server error");
    }
  });

  server.listen(PORT, () => {
    console.log(`Dev server ready at http://localhost:${PORT}/`);
    console.log("esbuild will rebuild on file changes.");
  });

  // Cleanup on exit
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await ctx.dispose();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});