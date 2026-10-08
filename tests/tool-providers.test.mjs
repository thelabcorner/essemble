import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rootDir, loadCatalog, loadLock } from "../src/catalog.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { builtInTools, createToolRegistry } from "../src/tooling.mjs";

const cli = path.join(rootDir, "bin", "essemble.mjs");

async function tempProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-adapters-"));
  try { return await callback(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("provider selection requires explicit choice and correct capability", () => {
  const custom = { id: "audit-check", capabilities: ["check"], async check() {
    return { ok: true, diagnostics: [] };
  } };
  assert.throws(() => createToolRegistry([...builtInTools, custom]), /multiple providers/);
  assert.throws(() => createToolRegistry([...builtInTools, custom], {
    providers: { check: "espack" }
  }), /does not implement check/);
  assert.throws(() => createToolRegistry([...builtInTools, custom], {
    providers: { unknown: "audit-check" }
  }), /unknown tool capability/);
  const registry = createToolRegistry([...builtInTools, custom], { providers: { check: "audit-check" } });
  assert.equal(registry.providerId("check"), "audit-check");
  assert.equal(registry.providerId("compose"), "espack");
});

test("composition actually invokes the selected checker and pins it to the receipt", async () => {
  await tempProject(async (projectRoot) => {
    await fs.writeFile(path.join(projectRoot, "main.jsx"), "$.global.ADAPTER = 17;\n");
    let invocations = 0;
    const custom = {
      id: "audit-check", capabilities: ["check"],
      async check({ text }) {
        invocations++;
        assert.match(text, /ADAPTER = 17/);
        return { ok: true, diagnostics: [] };
      }
    };
    const toolRegistry = createToolRegistry([...builtInTools, custom], { providers: { check: "audit-check" } });
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./main.jsx"], {
      projectRoot, toolRegistry,
      out: "dist/main.jsx", manifestOut: "dist/main.manifest.json",
      receiptOut: "dist/main.receipt.json"
    });
    assert.equal(built.receipt.toolAdapters.check, "audit-check");
    assert.equal(built.receipt.toolAdapters.compose, "espack");
    assert.equal(invocations, 1);
    await assert.rejects(
      verifyReceipt(projectRoot, "dist/main.receipt.json", { toolRoot: rootDir, rebuild: true }),
      /requires check provider audit-check/
    );
    const result = await verifyReceipt(projectRoot, "dist/main.receipt.json", {
      toolRoot: rootDir, rebuild: true, toolRegistry
    });
    assert.equal(result.ok, true);
    assert.equal(invocations, 2);
  });
});

test("a selected third-party composer is invoked for builds and reproducible rebuilds", async () => {
  await tempProject(async (projectRoot) => {
    await fs.writeFile(path.join(projectRoot, "main.jsx"), "$.global.CUSTOM_COMPOSER = true;\n");
    let invocations = 0;
    const backend = builtInTools.find((adapter) => adapter.id === "espack");
    const custom = {
      id: "custom-composer", capabilities: ["compose"],
      async compose(context) { invocations++; return backend.compose(context); }
    };
    const toolRegistry = createToolRegistry([...builtInTools, custom], {
      providers: { compose: "custom-composer" }
    });
    const options = {
      projectRoot, toolRegistry,
      out: "dist/all.jsx", manifestOut: "dist/all.manifest.json", receiptOut: "dist/all.receipt.json"
    };
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./main.jsx"], options);
    assert.equal(built.receipt.toolAdapters.compose, "custom-composer");
    assert.equal(invocations, 1);
    await assert.rejects(
      verifyReceipt(projectRoot, options.receiptOut, { toolRoot: rootDir, rebuild: true }),
      /requires compose provider custom-composer/
    );
    assert.equal((await verifyReceipt(projectRoot, options.receiptOut, {
      toolRoot: rootDir, rebuild: true, toolRegistry
    })).ok, true);
    assert.equal(invocations, 2);
  });
});

test("project-owned provider overrides ESTC only when trust and explicit selection are supplied", async () => {
  await tempProject(async (dir) => {
    const exec = (...args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, encoding: "utf8", timeout: 30000
    });
    assert.equal(exec("init").status, 0);
    await fs.writeFile(path.join(dir, "main.jsx"), "$.global.CUSTOM_CHECK = true;\n");
    assert.equal(exec("add", "./main.jsx").status, 0);
    await fs.writeFile(path.join(dir, "checker.mjs"), [
      "export default { tools: [{",
      '  id: "custom-check", capabilities: ["check"],',
      "  async check({ text }) {",
      '    if (!text.includes("CUSTOM_CHECK")) return { ok: false, diagnostics: [{ severity: "error", code: "MISSING", message: "Missing fixture" }] };',
      "    return { ok: true, diagnostics: [] };",
      "  }",
      "}] };"
    ].join("\n"));
    const configFile = path.join(dir, "essemble.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    config.plugins = ["./checker.mjs"];
    config.toolProviders = { check: "custom-check" };
    await fs.writeFile(configFile, JSON.stringify(config));
    assert.match(exec("build").stderr, /--allow-plugins/);
    assert.equal(exec("build", "--allow-plugins").status, 0);
    const receipt = JSON.parse(await fs.readFile(path.join(dir, "dist", "runtime.receipt.json"), "utf8"));
    assert.equal(receipt.toolAdapters.check, "custom-check");
    assert.equal(exec("verify", "dist/runtime.receipt.json").status, 0);
    assert.notEqual(exec("verify", "dist/runtime.receipt.json", "--rebuild").status, 0);
    assert.equal(exec("verify", "dist/runtime.receipt.json", "--rebuild", "--allow-plugins").status, 0);
    assert.equal(receipt.plugins.length, 1);
    assert.match(receipt.plugins[0].sha256, /^[0-9a-f]{64}$/);
    await fs.appendFile(path.join(dir, "checker.mjs"), "\n// changed after build\n");
    const drift = exec("verify", "dist/runtime.receipt.json");
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /receipt plugin drift/);
  });
});