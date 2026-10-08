import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function inspectSources(root, catalog, lock, componentIds = null) {
  const rows = [];
  const selected = componentIds ? new Set(componentIds) : null;

  for (const component of catalog.components) {
    if (selected && !selected.has(component.id)) continue;
    const locked = lock.components[component.id];
    const source = component.source;

    if (source.type === "workspace") {
      const absolute = path.resolve(root, source.path);
      rows.push({
        id: component.id,
        sourceType: "workspace",
        path: source.path,
        exists: fs.existsSync(absolute),
        status: fs.existsSync(absolute) ? "workspace" : "missing"
      });
      continue;
    }

    const absolute = path.resolve(root, source.path);
    if (!fs.existsSync(absolute)) {
      rows.push({
        id: component.id,
        sourceType: "git",
        path: source.path,
        exists: false,
        expected: locked?.revision || null,
        status: "missing"
      });
      continue;
    }

    try {
      const head = runGit(absolute, ["rev-parse", "HEAD"]);
      const dirty = runGit(absolute, ["status", "--porcelain"]).length > 0;
      const expected = locked?.revision || null;
      rows.push({
        id: component.id,
        sourceType: "git",
        path: source.path,
        exists: true,
        head,
        expected,
        dirty,
        status: dirty ? "dirty" : head === expected ? "locked" : "revision-mismatch"
      });
    } catch (error) {
      rows.push({
        id: component.id,
        sourceType: "git",
        path: source.path,
        exists: true,
        expected: locked?.revision || null,
        status: "not-git",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const blocking = rows.filter((row) =>
    row.sourceType === "git" && row.status !== "locked"
  );

  return { ok: blocking.length === 0, rows, blocking };
}
