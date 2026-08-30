#!/usr/bin/env node
/**
 * Update HTML files to use bundled ES modules instead of individual scripts.
 * Run after build:js to update _site HTML files.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = path.join(REPO_ROOT, "_site");

const PAGE_BUNDLES = {
  "index.html": "index",
  "dashboard.html": "dashboard",
  "meter-reading.html": "meter-reading",
  "day-closing.html": "day-closing",
  "credit.html": "credit",
  "credit-customer.html": "credit-customer",
  "credit-record.html": "credit-record",
  "expenses.html": "expenses",
  "staff.html": "staff",
  "settings.html": "settings",
  "analysis.html": "analysis",
  "reports.html": "reports",
  "invoices.html": "invoices",
  "billing.html": "billing",
  "attendance.html": "attendance",
  "salary.html": "salary",
  "e20-register.html": "e20-register",
  "reminders.html": "reminders",
  "dsr.html": "dsr",
  "sales-daily.html": "sales-daily",
  "letterhead.html": "letterhead",
  "credit-overdue.html": "credit-overdue",
  "offline.html": "offline",
};

// Early scripts that must load before the bundle (topbar, nav)
const EARLY_SCRIPTS = [
  '<script src="js/roleBootstrap.js?v=17"></script>',
  '<script src="js/appNav.js?v=17"></script>',
];

const VENDOR_SCRIPTS = {
  "login.html": [
    '<script src="js/env.js"></script>',
    '<script src="js/vendor/supabase-login.min.js"></script>',
  ],
  "default": [
    '<script src="js/env.js"></script>',
    '<script src="js/vendor/supabase.min.js"></script>',
  ],
};

function getScriptTags(pageName) {
  const vendor = VENDOR_SCRIPTS[pageName] || VENDOR_SCRIPTS.default;
  const bundle = PAGE_BUNDLES[pageName];
  const bundleTag = bundle ? `<script type="module" src="js/${bundle}.js"></script>` : "";
  return [...EARLY_SCRIPTS, ...vendor, bundleTag].join("\n    ");
}

async function updateHtmlFile(filePath, pageName) {
  let content = await readFile(filePath, "utf-8");

  // Find the head section
  const headStart = content.indexOf("<head>");
  const headEnd = content.indexOf("</head>");
  if (headStart === -1 || headEnd === -1) return false;

  const headContent = content.substring(headStart + 6, headEnd);
  
  // Split head into lines and separate meta/css from scripts
  const lines = headContent.split("\n");
  const metaCssLines = [];
  const otherLines = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("<script")) {
      // Skip existing script tags - we'll replace them
      continue;
    }
    if (trimmed.startsWith("<meta") || trimmed.startsWith("<link") || trimmed.startsWith("<title")) {
      metaCssLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  const scriptTags = getScriptTags(pageName);
  const newHeadContent = 
    metaCssLines.join("\n") + "\n" +
    "    " + scriptTags + "\n" +
    otherLines.join("\n");

  const newContent = 
    content.substring(0, headStart + 6) + "\n" + 
    newHeadContent + 
    content.substring(headEnd);

  if (newContent !== content) {
    await writeFile(filePath, newContent, "utf-8");
    console.log(`Updated ${pageName}`);
    return true;
  }
  return false;
}

async function main() {
  let updated = 0;
  
  for (const [pageName, bundleName] of Object.entries(PAGE_BUNDLES)) {
    const filePath = path.join(SITE_DIR, pageName);
    try {
      if (await updateHtmlFile(filePath, pageName)) updated++;
    } catch (err) {
      console.warn(`Skipping ${pageName}: ${err.message}`);
    }
  }

  console.log(`Updated ${updated} HTML files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});