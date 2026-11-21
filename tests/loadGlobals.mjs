import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export function createSandbox(extra = {}) {
  const sandbox = {
    console,
    ...extra,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

export function loadScripts(sandbox, files) {
  for (const file of files) {
    const abs = path.join(root, file);
    const code = readFileSync(abs, "utf8");
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}
