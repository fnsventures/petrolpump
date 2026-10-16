import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("js files do not declare the same function name", () => {
  const dir = path.join(process.cwd(), "js");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".js"));
  const owners = new Map();
  const declaration = /(?:^|\n)function\s+([A-Za-z0-9_]+)\s*\(/g;

  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of text.matchAll(declaration)) {
      const name = match[1];
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(file);
    }
  }

  const duplicates = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([name, set]) => `${name} (${[...set].join(", ")})`);

  assert.deepEqual(duplicates, []);
});
