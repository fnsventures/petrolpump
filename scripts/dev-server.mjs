#!/usr/bin/env node
/**
 * Local preview: sync repo → _site, expand HTML partials, serve on http://localhost:4173
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = path.join(REPO_ROOT, "_site");
const PORT = Number(process.env.PORT || 4173);

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

async function prepareSite() {
  await run("node", ["scripts/build-site.mjs"]);
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
  await prepareSite();

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
    console.log(`Preview ready at http://localhost:${PORT}/dashboard.html`);
    console.log("Re-run npm run dev after editing HTML partials.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
