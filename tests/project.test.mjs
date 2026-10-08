import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalog } from "../src/catalog.mjs";
import {
  createProject,
  loadProject,
  normalizeProject,
  projectSpecs,
  updateProjectSelection
} from "../src/project.mjs";
import { parseComponentSpec } from "../src/artifacts.mjs";

test("component specs accept exact stable versions and reject ranges", () => {
  assert.deepEqual(parseComponentSpec("eslog"), { name: "eslog", version: null });
  assert.deepEqual(parseComponentSpec("eslog@0.2.0"), { name: "eslog", version: "0.2.0" });
  assert.throws(() => parseComponentSpec("eslog@^0.2.0"), /Invalid component specification/);
});

test("project normalization makes entrypoint intent deterministic", () => {
  const project = normalizeProject({
    schemaVersion: 1,
    target: "illustrator-win-x64",
    native: "prefer",
    entries: {
      network: { use: ["eshttp"], out: "dist/network.jsx" },
      core: { use: ["esuuid", "eslog", "eslog"] }
    }
  });
  assert.deepEqual(Object.keys(project.entries), ["core", "network"]);
  assert.deepEqual(project.entries.core.use, ["esuuid", "eslog"]);
  assert.equal(project.entries.core.manifestOut, "dist/core.manifest.json");
  assert.equal(project.entries.core.receipt, "dist/core.receipt.json");
});

test("project specs reject conflicting exact versions across entrypoints", () => {
  const project = normalizeProject({
    schemaVersion: 1,
    entries: {
      a: { use: ["eslog@0.2.0"] },
      b: { use: ["eslog@0.3.0"] }
    }
  });
  assert.throws(() => projectSpecs(project), /Conflicting project versions for eslog/);
});

test("init/add/remove canonicalize aliases and replace version intent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-project-"));
  const catalog = await loadCatalog();
  await createProject(tmp);
  await updateProjectSelection(tmp, catalog, "add", ["es-b64@1.3.0", "eslog"], { entry: "runtime" });
  await updateProjectSelection(tmp, catalog, "add", ["esb64"], { entry: "runtime" });
  let project = await loadProject(tmp, { required: true });
  assert.deepEqual(project.entries.runtime.use, ["esb64", "eslog"]);
  await updateProjectSelection(tmp, catalog, "remove", ["es-b64"], { entry: "runtime" });
  project = await loadProject(tmp, { required: true });
  assert.deepEqual(project.entries.runtime.use, ["eslog"]);
  await fs.rm(tmp, { recursive: true, force: true });
});
