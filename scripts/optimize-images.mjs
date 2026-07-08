#!/usr/bin/env node
/**
 * Generate favicon, PWA icons, display logos, and WebP landing slideshow assets.
 * Requires macOS sips + cwebp (brew install webp).
 */

import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets");
const logo = path.join(assets, "bishnupriya-fuels-logo.png");
const cwebp = existsSync("/opt/homebrew/bin/cwebp")
  ? "/opt/homebrew/bin/cwebp"
  : existsSync("/usr/local/bin/cwebp")
    ? "/usr/local/bin/cwebp"
    : "cwebp";

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function resizePng(src, dest, size) {
  run("sips", ["-z", String(size), String(size), src, "--out", dest]);
}

function toWebp(src, dest, quality = 82) {
  run(cwebp, ["-q", String(quality), src, "-o", dest]);
}

function toWebpMaxWidth(src, dest, quality, maxWidth) {
  const tmp = `${dest}.tmp.jpg`;
  run("sips", ["-Z", String(maxWidth), src, "--out", tmp]);
  toWebp(tmp, dest, quality);
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
}

if (!existsSync(logo)) {
  console.error("Missing logo:", logo);
  process.exit(1);
}

console.log("Generating logo variants…");
resizePng(logo, path.join(assets, "favicon-32.png"), 32);
resizePng(logo, path.join(assets, "logo-44.png"), 44);
resizePng(logo, path.join(assets, "logo-80.png"), 80);
resizePng(logo, path.join(assets, "logo-104.png"), 104);
resizePng(logo, path.join(assets, "apple-touch-icon.png"), 180);
resizePng(logo, path.join(assets, "icon-192.png"), 192);
resizePng(logo, path.join(assets, "icon-512.png"), 512);

toWebp(path.join(assets, "logo-44.png"), path.join(assets, "logo-44.webp"), 90);
toWebp(path.join(assets, "logo-80.png"), path.join(assets, "logo-80.webp"), 90);
toWebp(path.join(assets, "logo-104.png"), path.join(assets, "logo-104.webp"), 90);

console.log("Generating landing WebP slideshow…");
for (let i = 1; i <= 4; i++) {
  const num = String(i).padStart(2, "0");
  const jpg = path.join(assets, `landing-${num}.JPG`);
  if (!existsSync(jpg)) continue;
  toWebp(jpg, path.join(assets, `landing-${num}.webp`), 80);
  toWebpMaxWidth(jpg, path.join(assets, `landing-${num}-800.webp`), 78, 800);
}

console.log("Image optimization complete.");
