import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadCatalog, loadLock, rootDir } from "../src/catalog.mjs";
import { resolveBuildInputs } from "../src/sources.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";

async function project(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-package-"));
  try { return await run(root); } finally { await fs.rm(root, { force: true, recursive: true }); }
}

async function put(root, name, content) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

test("package-defined JS dependency order and provenance are preserved in actual bundles", async () => {
  await project(async (root) => {
    await put(root, "vendor/package.json", JSON.stringify({
      essemble: { entry: "main.jsx", dependencies: ["file:./support.jsx"] }
    }));
    await put(root, "vendor/support.jsx", "var SHARED_CONSTANT = 41;\n");
    await put(root, "vendor/main.jsx", "$.global.COMPUTED = SHARED_CONSTANT + 1;\n");
    const inputs = await resolveBuildInputs(root, await loadCatalog(), ["./vendor"]);
    assert.deepEqual(inputs.sources.map((src) => path.basename(src.file)), ["support.jsx", "main.jsx"]);
    assert.deepEqual(inputs.sources[1].requirements, ["vendor/support.jsx"]);
    assert.equal(inputs.sources[1].dependencies.length, 1);
    assert.equal(inputs.sources[1].dependencies[0].path, "vendor/package.json");

    const options = { projectRoot: root, out: "dist/all.jsx", manifestOut: "dist/all.manifest.json", receiptOut: "dist/all.receipt.json" };
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./vendor"], options);
    const output = await fs.readFile(built.bundlePath, "utf8");
    assert.ok(output.indexOf("SHARED_CONSTANT = 41") < output.indexOf("COMPUTED = SHARED_CONSTANT"));
    assert.equal((await verifyReceipt(root, options.receiptOut, { toolRoot: rootDir, rebuild: true })).ok, true);
    await put(root, "vendor/package.json", JSON.stringify({
      essemble: { entry: "main.jsx", dependencies: [] }
    }));
    await assert.rejects(verifyReceipt(root, options.receiptOut, { toolRoot: rootDir }), /source drift/);
  });
});

test("nested packages are resolved transitively without duplicates or order reversal", async () => {
  await project(async (root) => {
    await put(root, "shared/package.json", JSON.stringify({ main: "index.jsx" }));
    await put(root, "shared/index.jsx", "var FOUNDATION = 2;\n");
    await put(root, "vendor/package.json", JSON.stringify({
      essemble: { entry: "main.jsx", dependencies: ["../shared", "../shared/index.jsx", "esuuid"] }
    }));
    await put(root, "vendor/main.jsx", "$.global.RESULT = FOUNDATION;\n");
    const result = await resolveBuildInputs(root, await loadCatalog(), ["./vendor", "./shared"]);
    assert.deepEqual(result.sources.map((item) => path.basename(item.file)), ["index.jsx", "main.jsx"]);
    assert.deepEqual(result.components.map((item) => item.id), ["esuuid"]);
  });
});

test("cyclic package declarations, invalid declarations and traversal fail closed", async () => {
  await project(async (root) => {
    const catalog = await loadCatalog();
    await put(root, "a/index.jsx", "var A = 1;\n");
    await put(root, "b/index.jsx", "var B = 2;\n");
    await put(root, "a/package.json", JSON.stringify({ essemble: { dependencies: ["../b"] } }));
    await put(root, "b/package.json", JSON.stringify({ essemble: { dependencies: ["../a"] } }));
    await assert.rejects(resolveBuildInputs(root, catalog, ["./a"]), /Cyclic ESsemble library dependency/);
    await put(root, "a/package.json", JSON.stringify({ essemble: { dependencies: ["../../outside.jsx"] } }));
    await assert.rejects(resolveBuildInputs(root, catalog, ["./a"]), /escapes consumer project/);
    await put(root, "a/package.json", JSON.stringify({ essemble: { dependencies: [17] } }));
    await assert.rejects(resolveBuildInputs(root, catalog, ["./a"]), /Invalid essemble.dependencies/);
  });
});