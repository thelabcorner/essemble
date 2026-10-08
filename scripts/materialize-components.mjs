import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadCatalog, loadLock, rootDir } from "../src/catalog.mjs";

const recursive = process.argv.includes("--recursive");
const catalog = await loadCatalog();
const lock = await loadLock();

let only = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--only") {
    if (i + 1 >= process.argv.length) {
      throw new Error("--only requires a comma-separated component list");
    }
    only = new Set(process.argv[++i].split(",").map((id) => id.trim()).filter(Boolean));
  } else if (arg.startsWith("--only=")) {
    only = new Set(arg.slice("--only=".length).split(",").map((id) => id.trim()).filter(Boolean));
  }
}

if (only) {
  const known = new Set(catalog.components.map((component) => component.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error("unknown --only component(s): " + unknown.join(", "));
  }
}

function run(cwd, args, stdio = "inherit") {
  return execFileSync("git", args, { cwd, stdio, encoding: stdio === "pipe" ? "utf8" : undefined });
}

for (const component of catalog.components) {
  if (only && !only.has(component.id)) continue;
  if (component.source.type !== "git") {
    console.log(`skip ${component.id}: ${component.source.type} source`);
    continue;
  }

  const locked = lock.components[component.id];
  const destination = path.resolve(rootDir, component.source.path);

  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    console.log(`clone ${component.id} -> ${component.source.path}`);
    run(rootDir, ["clone", "--no-tags", component.source.url, destination]);
  }

  const dirty = String(run(destination, ["status", "--porcelain"], "pipe")).trim();
  if (dirty) {
    throw new Error(`${component.id}: refusing to change dirty component checkout at ${component.source.path}`);
  }

  let head = String(run(destination, ["rev-parse", "HEAD"], "pipe")).trim();
  if (head !== locked.revision) {
    try {
      run(destination, ["cat-file", "-e", `${locked.revision}^{commit}`], "pipe");
    } catch {
      run(destination, ["fetch", "origin", locked.revision]);
    }
    run(destination, ["checkout", "--detach", locked.revision]);
    head = String(run(destination, ["rev-parse", "HEAD"], "pipe")).trim();
  }

  if (head !== locked.revision) {
    throw new Error(`${component.id}: expected ${locked.revision}, got ${head}`);
  }

  if (recursive) {
    run(destination, ["submodule", "update", "--init", "--recursive"]);
  }

  console.log(`locked ${component.id} @ ${head.slice(0, 12)}`);
}
