import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileWithEstc } from "../src/compiler.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { loadCatalog, loadLock, rootDir } from "../src/catalog.mjs";
import { buildProjectEntry, validateEntryOutputs } from "../src/pipeline.mjs";
import { builtInTools, createToolRegistry, discoverTools } from "../src/tooling.mjs";
import { normalizeProject } from "../src/project.mjs";

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-estc-test-"));
  const estcRoot = path.join(root, "mock-estc");
  const consumer = path.join(root, "consumer");
  try {
    await fs.mkdir(path.join(estcRoot, "src"), { recursive: true });
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(estcRoot, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(estcRoot, "src", "check-jsx.mjs"), `
      export function checkJsxText(text) {
        return { ok: Boolean(text), diagnostics: [] };
      }
    `);
    await fs.writeFile(path.join(estcRoot, "src", "config.mjs"), `
      import path from 'node:path';
      export async function loadConfig({cwd}) {
        return {entry:path.join(cwd,'source.ts'), outfile:path.join(cwd,'ignored.jsx')};
      }
    `);
    await fs.writeFile(path.join(estcRoot, "src", "build.mjs"), `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      export async function buildProject(config) {
        const original = await fs.readFile(config.entry, 'utf8');
        if (original.includes('FAIL')) throw new Error('fixture compile failure');
        const text = '#target illustrator\\n$.global.TYPED = ' + JSON.stringify(original.trim()) + ';\\n';
        await fs.writeFile(config.outfile, text);
        return {outfile:config.outfile, bytes:Buffer.byteLength(text), inputs:[config.entry],
          diagnostics:[], compatibilityTransforms:[{name:'mock-estc'}], integrations:{}};
      }
    `);
    await fs.writeFile(path.join(consumer, "extendscript.config.mjs"), "export default { entry: 'source.ts' };\n");
    await fs.writeFile(path.join(consumer, "source.ts"), "export const answer: number = 42;\n");
    await callback({ root, estcRoot, consumer });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("ESTC worker delegates compilation, produces input provenance and can be composed", async () => {
  await fixture(async ({ consumer, estcRoot }) => {
    const compiled = await compileWithEstc(rootDir, consumer, { estcRoot, out: "dist/typed.jsx" });
    assert.equal(compiled.inputs.length, 1);
    assert.equal(compiled.inputs[0].path, "source.ts");
    assert.match(await fs.readFile(compiled.outfile, "utf8"), /global.TYPED/);
    assert.match(compiled.sha256, /^[0-9a-f]{64}$/);
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./dist/typed.jsx"], {
      projectRoot: consumer, out: "dist/full.jsx", manifestOut: "dist/full.manifest.json", receiptOut: "dist/full.receipt.json"
    });
    assert.match(await fs.readFile(built.bundlePath, "utf8"), /global.TYPED/);
    assert.equal((await verifyReceipt(consumer, "dist/full.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
  });
});

test("failed ESTC compilation keeps previous published source unchanged", async () => {
  await fixture(async ({ consumer, estcRoot }) => {
    await compileWithEstc(rootDir, consumer, { estcRoot });
    const before = await fs.readFile(path.join(consumer, "dist", "estc.jsx"), "utf8");
    await fs.writeFile(path.join(consumer, "source.ts"), "FAIL");
    await assert.rejects(compileWithEstc(rootDir, consumer, { estcRoot }), /fixture compile failure/);
    assert.equal(await fs.readFile(path.join(consumer, "dist", "estc.jsx"), "utf8"), before);
  });
});

test("ESTC compile path traversal is rejected before invoking the compiler", async () => {
  await fixture(async ({ consumer, estcRoot }) => {
    await assert.rejects(compileWithEstc(rootDir, consumer, { estcRoot, out: "../outside.jsx" }), /escapes the consumer project/);
    await assert.rejects(compileWithEstc(rootDir, consumer, { estcRoot, config: "../outside.config.mjs" }), /escapes the consumer project/);
    await assert.rejects(compileWithEstc(rootDir, consumer, { estcRoot, timeoutMs: 1 }), /ESTC compile watchdog/);
  });
});

test("project compiler automatically joins the ESsemble build with verified TS provenance", async () => {
  await fixture(async ({ consumer, estcRoot }) => {
    const project = normalizeProject({ schemaVersion: 1, entries: {
      runtime: { use: [], compiler: { config: "extendscript.config.mjs", out: "dist/typed.jsx" },
        out: "dist/bundle.jsx", manifestOut: "dist/bundle.manifest.json", receipt: "dist/bundle.receipt.json" }
    } });
    const registry = createToolRegistry([...builtInTools, {
      id: "fixture-estc", capabilities: ["compile"],
      compile: async ({ toolRoot, projectRoot, options }) => compileWithEstc(toolRoot, projectRoot, { ...options, estcRoot })
    }], { providers: { compile: "fixture-estc" } });
    const built = await buildProjectEntry(rootDir, consumer, await loadCatalog(), await loadLock(),
      "runtime", project.entries.runtime, { toolRegistry: registry, allowCompileConfig: true });
    assert.equal(built.receipt.compiler.provider, "fixture-estc");
    assert.equal(built.receipt.compiler.inputs[0].path, "source.ts");
    assert.equal((await verifyReceipt(consumer, "dist/bundle.receipt.json", {
      toolRoot: rootDir, toolRegistry: registry, rebuild: true
    })).ok, true);
    await fs.writeFile(path.join(consumer, "source.ts"), "export const answer: number = 9000;\n");
    await assert.rejects(verifyReceipt(consumer, "dist/bundle.receipt.json", {
      toolRoot: rootDir
    }), /receipt compiler input drift/);
  });
});

test("project compilation refuses to overwrite the final bundle before running ESTC", async () => {
  await fixture(async ({ consumer }) => {
    const entry = normalizeProject({ schemaVersion: 1, entries: {
      runtime: { use: [], compiler: { config: "extendscript.config.mjs", out: "dist/output.jsx" },
        out: "dist/output.jsx" }
    } }).entries.runtime;
    await assert.rejects(buildProjectEntry(rootDir, consumer, await loadCatalog(), await loadLock(),
      "runtime", entry, { toolRegistry: createToolRegistry(), allowCompileConfig: true }), /conflicts with its distribution outputs/);
  });
});

test("consumer CLI compiles using installed ESTC contract then builds a compiled entry", async () => {
  await fixture(async ({ consumer, estcRoot }) => {
    const cli = path.join(rootDir, "bin", "essemble.mjs");
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: consumer, env: { ...process.env, ESTC_ROOT: estcRoot }, encoding: "utf8", timeout: 30000
    });
    const standalone = run("compile", "--out", "dist/standalone.jsx", "--json");
    assert.equal(standalone.status, 0, standalone.stderr);
    const published = JSON.parse(standalone.stdout);
    assert.equal(published.inputs[0].path, "source.ts");
    const project = { schemaVersion: 1, entries: {
      runtime: { use: [], compiler: { config: "extendscript.config.mjs", out: "dist/typed.jsx" },
        out: "dist/bundle.jsx", manifestOut: "dist/bundle.manifest.json", receipt: "dist/bundle.receipt.json" }
    } };
    await fs.writeFile(path.join(consumer, "essemble.json"), JSON.stringify(project));
    const blocked = run("build");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /--allow-plugins/);
    const built = run("build", "--allow-plugins", "--json");
    assert.equal(built.status, 0, built.stderr);
    assert.equal(JSON.parse(built.stdout).compiler.inputs[0].path, "source.ts");
    const verified = run("verify", "dist/bundle.receipt.json", "--rebuild", "--json");
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).ok, true);
  });
});

test("tool discovery reports compiler dependencies separately from checker installation", async () => {
  const rows = await discoverTools(rootDir);
  const estc = rows.find((row) => row.id === "estc");
  assert.ok(estc);
  assert.equal(estc.readiness.check, estc.available);
  assert.equal(estc.readiness.compile, estc.available && estc.missingDependencies.length === 0);
  assert.ok(estc.missingDependencies.every((name) => typeof name === "string"));
});

test("multi-entrypoint output collisions fail before any build can overwrite another entry", async () => {
  await fixture(async ({ consumer }) => {
    const project = normalizeProject({ schemaVersion: 1, entries: {
      first: { use: ["./source.jsx"], out: "dist/shared.jsx" },
      second: { use: ["./source.jsx"], out: "dist/shared.jsx" }
    } });
    await assert.rejects(validateEntryOutputs(consumer, project, ["first", "second"]), /Project artifact collision/);
    const unique = normalizeProject({ schemaVersion: 1, entries: {
      first: { use: ["./source.jsx"], out: "dist/a.jsx" },
      second: { use: ["./source.jsx"], out: "dist/b.jsx" }
    } });
    assert.equal(await validateEntryOutputs(consumer, unique, ["first", "second"]), 6);
    const mixed = normalizeProject({ schemaVersion: 1, entries: {
      first: { use: [], compiler: { config: "extendscript.config.mjs", out: "dist/a.jsx" }, out: "dist/a-bundle.jsx" },
      second: { use: ["./source.jsx"], out: "dist/a.jsx" }
    } });
    await assert.rejects(validateEntryOutputs(consumer, mixed, ["first", "second"]), /Project artifact collision/);
    await fs.mkdir(path.join(consumer, "dist", "real"), { recursive: true });
    await fs.symlink(path.join(consumer, "dist", "real"), path.join(consumer, "dist", "alias"), "junction");
    const aliased = normalizeProject({ schemaVersion: 1, entries: {
      first: { use: [], out: "dist/real/bundle.jsx" },
      second: { use: [], out: "dist/alias/bundle.jsx" }
    } });
    await assert.rejects(validateEntryOutputs(consumer, aliased, ["first", "second"]), /Project artifact collision/);
  });
});