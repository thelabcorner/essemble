import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishArtifacts } from "../src/publication.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { loadCatalog, loadLock, rootDir } from "../src/catalog.mjs";

async function withTemp(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-publication-"));
  try { await callback(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("publishArtifacts commits all three outputs and clears backup/temp files", async () => {
  await withTemp(async (root) => {
    const records = ["bundle.jsx", "manifest.json", "receipt.json"].map((name, index) => ({
      path: path.join(root, name), bytes: Buffer.from(`new-${index}`)
    }));
    await fs.writeFile(records[0].path, "old");
    await publishArtifacts(records);
    for (const [index, record] of records.entries()) {
      assert.equal(await fs.readFile(record.path, "utf8"), `new-${index}`);
    }
    assert.deepEqual((await fs.readdir(root)).sort(), records.map((item) => path.basename(item.path)).sort());
  });
});

test("publication rollback restores every original when middle rename fails", async () => {
  await withTemp(async (root) => {
    const records = ["bundle.jsx", "manifest.json", "receipt.json"].map((name, index) => ({
      path: path.join(root, name), bytes: Buffer.from(`new-${index}`)
    }));
    for (const record of records) await fs.writeFile(record.path, `before-${path.basename(record.path)}`);
    let failureInjected = false;
    await assert.rejects(publishArtifacts(records, {
      async rename(from, to) {
        if (!failureInjected && from.endsWith(".tmp") && to === records[1].path) {
          failureInjected = true;
          throw new Error("simulated disk failure");
        }
        return fs.rename(from, to);
      }
    }), /simulated disk failure/);
    assert.equal(failureInjected, true);
    for (const record of records) {
      assert.equal(await fs.readFile(record.path, "utf8"), `before-${path.basename(record.path)}`);
    }
    assert.deepEqual((await fs.readdir(root)).sort(), records.map((item) => path.basename(item.path)).sort());
  });
});

test("failed output preflight does not modify existing outputs", async () => {
  await withTemp(async (root) => {
    await fs.writeFile(path.join(root, "bundle.jsx"), "original");
    await fs.mkdir(path.join(root, "manifest.json"));
    await assert.rejects(publishArtifacts([
      { path: path.join(root, "bundle.jsx"), bytes: Buffer.from("different") },
      { path: path.join(root, "manifest.json"), bytes: Buffer.from("invalid") }
    ]), /not a regular file/);
    assert.equal(await fs.readFile(path.join(root, "bundle.jsx"), "utf8"), "original");
  });
});

test("receipt cannot read outside project or traverse output symlinks", async () => {
  await withTemp(async (root) => {
    await fs.writeFile(path.join(root, "source.jsx"), "$.global.ROOT = true;\n");
    const options = { projectRoot: root, out: "dist/a.jsx", manifestOut: "dist/a.manifest.json", receiptOut: "dist/a.receipt.json" };
    await assert.rejects(buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./source.jsx"], {
      ...options, manifestOut: "dist/a.jsx"
    }), /destinations must be distinct/);
    await assert.rejects(buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./source.jsx"], {
      ...options, out: "../leak.jsx"
    }), /escapes the consumer project/);
    await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./source.jsx"], options);
    const receiptPath = path.join(root, "dist", "a.receipt.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.outputs.bundle.path = "../../secret.jsx";
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyReceipt(root, "dist/a.receipt.json", { toolRoot: rootDir }), /escapes the consumer project/);
    await assert.rejects(verifyReceipt(root, "../another.receipt.json", { toolRoot: rootDir }), /escapes the consumer project/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-external-"));
    try {
      const link = path.join(root, "external-dir");
      await fs.symlink(outside, link, "junction");
      await assert.rejects(buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./source.jsx"], {
        ...options, out: "external-dir/leak.jsx"
      }), /symlink escapes the consumer project/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("absolute external scripts require an explicit verification opt-in", async () => {
  await withTemp(async (root) => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-source-external-"));
    try {
      const file = path.join(external, "library.jsx");
      await fs.writeFile(file, "$.global.OUTSIDE = true;\n");
      await buildComposition(rootDir, await loadCatalog(), await loadLock(), [file], {
        projectRoot: root, out: "dist/ext.jsx", manifestOut: "dist/ext.manifest.json", receiptOut: "dist/ext.receipt.json"
      });
      await assert.rejects(verifyReceipt(root, "dist/ext.receipt.json", { toolRoot: rootDir }), /escapes the consumer project/);
      const trusted = await verifyReceipt(root, "dist/ext.receipt.json", {
        toolRoot: rootDir, allowExternalSources: true, rebuild: true
      });
      assert.equal(trusted.ok, true);
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });
});