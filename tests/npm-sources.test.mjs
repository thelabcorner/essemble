import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { rootDir, loadCatalog, loadLock } from "../src/catalog.mjs";
import { pinNpmSource, parseNpmSpec } from "../src/npm-source.mjs";
import { resolveBuildInputs, selectionKey } from "../src/sources.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { loadEspackBackend } from "../src/espack-backend.mjs";

const cli = path.join(rootDir, "bin", "essemble.mjs");
async function inProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-npm-"));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function save(root, filename, content) {
  const file = path.join(root, filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
function cliRun(root, ...argv) {
  return spawnSync(process.execPath, [cli, ...argv], { cwd: root, encoding: "utf8", timeout: 30000 });
}

test("npm installed library resolves exact version and transitive package dependencies", async () => {
  await inProject(async (root) => {
    await save(root, "node_modules/vector-math/package.json", JSON.stringify({
      name: "vector-math", version: "1.2.3", main: "main.jsx",
      scripts: { postinstall: "exit 99" },
      essemble: { dependencies: ["./base.jsx"] }
    }));
    await save(root, "node_modules/vector-math/base.jsx", "var VECTOR_BASE = 21;\n");
    await save(root, "node_modules/vector-math/main.jsx", "$.global.VECTOR_RESULT = VECTOR_BASE * 2;\n");
    assert.equal(await pinNpmSource(root, "npm:vector-math"), "npm:vector-math@1.2.3");
    const pinned = "npm:vector-math@1.2.3";
    const inputs = await resolveBuildInputs(root, await loadCatalog(), [pinned]);
    assert.deepEqual(inputs.sources.map((x) => path.basename(x.file)), ["base.jsx", "main.jsx"]);
    assert.equal(inputs.sources[1].origin.type, "npm");
    assert.equal(inputs.sources[1].origin.version, "1.2.3");
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), [pinned], {
      projectRoot: root, out: "dist/vector.jsx", manifestOut: "dist/vector.manifest.json",
      receiptOut: "dist/vector.receipt.json"
    });
    const output = await fs.readFile(built.bundlePath, "utf8");
    assert.ok(output.indexOf("VECTOR_BASE = 21") < output.indexOf("VECTOR_RESULT = VECTOR_BASE"));
    assert.equal((await verifyReceipt(root, "dist/vector.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
    await save(root, "node_modules/vector-math/package.json", JSON.stringify({
      name: "vector-math", version: "1.2.3", main: "main.jsx"
    }));
    await assert.rejects(verifyReceipt(root, "dist/vector.receipt.json", { toolRoot: rootDir }), /source drift/);
  });
});

test("CLI adds a pinned npm package and removes it without an install script", async () => {
  await inProject(async (root) => {
    await save(root, "node_modules/widget-tool/package.json", JSON.stringify({
      name: "widget-tool", version: "0.4.5", main: "index.jsx"
    }));
    await save(root, "node_modules/widget-tool/index.jsx", "var WIDGET_TOOL = 1;\n");
    assert.equal(cliRun(root, "init").status, 0);
    const added = cliRun(root, "add", "npm:widget-tool");
    assert.equal(added.status, 0, added.stderr);
    const configFile = path.join(root, "essemble.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    assert.deepEqual(config.entries.runtime.use, ["npm:widget-tool@0.4.5"]);
    const built = cliRun(root, "build");
    assert.equal(built.status, 0, built.stderr);
    assert.equal(cliRun(root, "verify", "dist/runtime.receipt.json", "--rebuild").status, 0);
    assert.equal(cliRun(root, "remove", "npm:widget-tool").status, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile, "utf8")).entries.runtime.use, []);
  });
});

test("project resolution includes ES* components declared transitively by npm libraries", async () => {
  await inProject(async (root) => {
    await save(root, "node_modules/dependency-demo/package.json", JSON.stringify({
      name: "dependency-demo", version: "1.0.0", main: "index.jsx",
      essemble: { dependencies: ["eson"] }
    }));
    await save(root, "node_modules/dependency-demo/index.jsx", "$.global.DEPENDENCY_DEMO = 1;\n");
    assert.equal(cliRun(root, "init").status, 0);
    assert.equal(cliRun(root, "add", "npm:dependency-demo").status, 0);
    const planned = cliRun(root, "resolve", "--entry", "runtime", "--json");
    assert.equal(planned.status, 0, planned.stderr);
    const report = JSON.parse(planned.stdout);
    assert.deepEqual(report.sourceRequirements, ["eson"]);
    assert.ok(report.requested.includes("eson"));
    assert.ok(report.components.includes("eson"));
    assert.equal(report.sources[0].provider, "npm-installed");
    assert.equal(report.sources[0].origin.version, "1.0.0");
  });
});

test("scoped packages support explicit ExtendScript entrypaths and reject version drift", async () => {
  await inProject(async (root) => {
    await save(root, "node_modules/@vector/geometry/package.json", JSON.stringify({
      name: "@vector/geometry", version: "2.3.4", main: "node-only.mjs"
    }));
    await save(root, "node_modules/@vector/geometry/compat.jsx", "$.global.GEOMETRY = true;\n");
    const spec = "npm:@vector/geometry@2.3.4#compat.jsx";
    assert.equal((await pinNpmSource(root, "npm:@vector/geometry#compat.jsx")), spec);
    assert.deepEqual(parseNpmSpec(spec), {
      name: "@vector/geometry", version: "2.3.4", entry: "compat.jsx"
    });
    assert.equal(selectionKey({}, spec), selectionKey({}, "npm:@vector/geometry#compat.jsx"));
    const result = await resolveBuildInputs(root, await loadCatalog(), [spec]);
    assert.match(result.sources[0].text, /GEOMETRY = true/);
    await assert.rejects(resolveBuildInputs(root, await loadCatalog(),
      ["npm:@vector/geometry@2.3.5#compat.jsx"]), /pinned 2.3.5, installed 2.3.4/);
    await assert.rejects(resolveBuildInputs(root, await loadCatalog(),
      ["npm:@vector/geometry@2.3.4#..%2Foutside.jsx"]), /ENOENT/);
  });
});

test("unpinned npm builds, traversal paths and unsupported version ranges are rejected", async () => {
  await inProject(async (root) => {
    const catalog = await loadCatalog();
    await assert.rejects(resolveBuildInputs(root, catalog, ["npm:missing-package"]), /Unpinned npm source/);
    assert.throws(() => parseNpmSpec("npm:tool@^1.0.0"), /exact semver/);
    assert.throws(() => parseNpmSpec("npm:tool@1.2.3#../escape.jsx"), /inside the package/);
    assert.throws(() => parseNpmSpec("npm:tool@1.2.3#/escape.jsx"), /inside the package/);
  });
});

test("npm package metadata is bounded before parsing", async () => {
  await inProject(async (root) => {
    await save(root, "node_modules/oversize/package.json", Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    await save(root, "node_modules/oversize/index.jsx", "var SAFE = true;\n");
    await assert.rejects(pinNpmSource(root, "npm:oversize"), /metadata exceeds the 2 MiB safety limit/);
  });
});

test("npm packages may publish ESPACK manifests with recorded package metadata", async () => {
  await inProject(async (root) => {
    const backend = await loadEspackBackend(rootDir);
    const manifest = backend.makeManifest({
      bundleName: "manifest-package", cacheDir: "", payloads: [], accel: null,
      libraries: [], entries: [], capabilities: []
    });
    await save(root, "node_modules/adobe-manifest/package.json", JSON.stringify({
      name: "adobe-manifest", version: "3.0.0", main: "dist/bundle.manifest.json"
    }));
    await save(root, "node_modules/adobe-manifest/dist/bundle.manifest.json", JSON.stringify(manifest));
    const requested = ["npm:adobe-manifest@3.0.0"];
    const inputs = await resolveBuildInputs(root, await loadCatalog(), requested);
    assert.equal(inputs.sources[0].kind, "manifest");
    assert.deepEqual(inputs.sources[0].dependencies.map((item) => item.path), [
      "node_modules/adobe-manifest/package.json"
    ]);
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), requested, {
      projectRoot: root, out: "dist/runtime.jsx", manifestOut: "dist/runtime.manifest.json",
      receiptOut: "dist/runtime.receipt.json"
    });
    assert.equal(built.receipt.sources[0].kind, "manifest");
    assert.equal((await verifyReceipt(root, "dist/runtime.receipt.json", {
      toolRoot: rootDir, rebuild: true
    })).ok, true);
    await save(root, "node_modules/adobe-manifest/package.json", JSON.stringify({
      name: "adobe-manifest", version: "3.0.1", main: "dist/bundle.manifest.json"
    }));
    await assert.rejects(verifyReceipt(root, "dist/runtime.receipt.json", {
      toolRoot: rootDir
    }), /source drift/);
  });
});