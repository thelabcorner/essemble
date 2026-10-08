import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadCatalog, loadLock, rootDir } from "../src/catalog.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { createSourceRegistry, resolveBuildInputs, expandScriptFile } from "../src/sources.mjs";
import { createToolRegistry } from "../src/tooling.mjs";
import { loadEspackBackend } from "../src/espack-backend.mjs";
import { executeComTool, loadComToolSdk } from "../src/host.mjs";
import { liveVerifyReceipt } from "../src/live.mjs";

const cli = path.join(rootDir, "bin", "essemble.mjs");

async function withProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-consumer-"));
  try { await callback(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function command(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("external consumer can init/add/build/verify ordinary JSX without special manifests", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "lib"));
    await fs.writeFile(path.join(root, "lib", "colors.jsx"), "$.global.COLORS = { red: '#f00' };\n");
    await fs.writeFile(path.join(root, "lib", "draw.jsx"), "$.global.DRAW = { color: $.global.COLORS.red };\n");
    command(root, "init");
    command(root, "add", "./lib/colors.jsx", "./lib/draw.jsx");
    const project = JSON.parse(await fs.readFile(path.join(root, "essemble.json"), "utf8"));
    assert.deepEqual(project.entries.runtime.use, ["./lib/colors.jsx", "./lib/draw.jsx"]);
    const plan = JSON.parse(command(root, "resolve", "--entry", "runtime", "--json"));
    assert.equal(plan.sources.length, 2);
    assert.deepEqual(plan.requested, []);
    assert.ok(plan.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256)));
    command(root, "build");
    const bundle = await fs.readFile(path.join(root, "dist", "runtime.jsx"), "utf8");
    assert.ok(bundle.indexOf("COLORS =") < bundle.indexOf("DRAW ="));
    assert.doesNotMatch(bundle, /\bESPAK\b/);
    assert.ok(Buffer.byteLength(bundle, "utf8") < 1024, "plain JSX should not acquire an unnecessary runtime loader");
    assert.match(bundle, /sha256:[0-9a-f]{64}/);
    command(root, "verify", "dist/runtime.receipt.json", "--rebuild");
    const receipt = JSON.parse(await fs.readFile(path.join(root, "dist", "runtime.receipt.json"), "utf8"));
    assert.deepEqual(receipt.sources.map((source) => source.kind), ["script", "script"]);
    assert.equal(receipt.requested.length, 0);
    command(root, "remove", "./lib/colors.jsx");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "essemble.json"), "utf8")).entries.runtime.use, ["./lib/draw.jsx"]);
  });
});

test("source receipt detects changed bytes and prevents reproducibility claims", async () => {
  await withProject(async (root) => {
    const file = path.join(root, "helper.jsx");
    await fs.writeFile(file, "$.global.HELPER = true;\n");
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./helper.jsx"], {
      projectRoot: root, out: "dist/helper.jsx", manifestOut: "dist/helper.manifest.json", receiptOut: "dist/helper.receipt.json"
    });
    assert.equal((await verifyReceipt(root, "dist/helper.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
    await fs.writeFile(file, "$.global.HELPER = false;\n");
    await assert.rejects(verifyReceipt(root, "dist/helper.receipt.json", { toolRoot: rootDir }), /source drift/);
    assert.equal(built.receipt.sources[0].kind, "script");
  });
});

test("local directory providers select package entry without executing package scripts", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "vendor"));
    await fs.writeFile(path.join(root, "vendor", "package.json"), JSON.stringify({
      main: "lib.jsx", scripts: { postinstall: "exit 9" }
    }));
    await fs.writeFile(path.join(root, "vendor", "lib.jsx"), "$.global.VENDOR = 123;\n");
    const resolved = await resolveBuildInputs(root, await loadCatalog(), ["./vendor", "./vendor/lib.jsx"]);
    assert.equal(resolved.sources.length, 1);
    assert.equal(resolved.sources[0].kind, "script");
    assert.match(resolved.sources[0].text, /VENDOR/);
    await assert.rejects(resolveBuildInputs(root, await loadCatalog(), ["./vendor/package.json"]), /Unsupported script extension/);
    assert.throws(() => createSourceRegistry([{}]), /match\(spec\)/);
  });
});

test("pinned Git source resolves immutable source bytes and records revision", async () => {
  await withProject(async (root) => {
    const repo = path.join(root, "upstream");
    const consumer = path.join(root, "consumer");
    await fs.mkdir(repo);
    await fs.mkdir(consumer);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await fs.writeFile(path.join(repo, "index.jsx"), "$.global.UPSTREAM = 1;\n");
    git("add", "index.jsx");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "first");
    const sha = git("rev-parse", "HEAD");
    const spec = `git+${pathToFileURL(repo).href}@${sha}#index.jsx`;
    command(consumer, "init");
    command(consumer, "add", `git+${pathToFileURL(repo).href}#index.jsx`);
    const pinnedProject = JSON.parse(await fs.readFile(path.join(consumer, "essemble.json"), "utf8"));
    assert.deepEqual(pinnedProject.entries.runtime.use, [spec]);
    command(consumer, "remove", `git+${pathToFileURL(repo).href}#index.jsx`);
    const unselected = JSON.parse(await fs.readFile(path.join(consumer, "essemble.json"), "utf8"));
    assert.deepEqual(unselected.entries.runtime.use, []);
    const catalog = await loadCatalog();
    const first = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.match(first.sources[0].text, /UPSTREAM = 1/);
    assert.equal(first.sources[0].origin.revision, sha.toLowerCase());
    await fs.writeFile(path.join(repo, "index.jsx"), "$.global.UPSTREAM = 2;\n");
    git("add", "index.jsx");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "second");
    const repeated = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.match(repeated.sources[0].text, /UPSTREAM = 1/);
    assert.equal(repeated.sources[0].sha256, first.sources[0].sha256);
    await assert.rejects(resolveBuildInputs(consumer, catalog, ["github:user/repo"]), /pinned 40-character commit/);
    await assert.rejects(resolveBuildInputs(consumer, catalog, [`git+${pathToFileURL(repo).href}@${sha}#../outside.jsx`]), /inside the repository/);
  });
});

test("nested ExtendScript includes expand deterministically and detect drift/cycles", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "inc"));
    await fs.writeFile(path.join(root, "inc", "constants.jsxinc"), "var MAGIC = 42;\n");
    await fs.writeFile(path.join(root, "main.jsx"), "#target illustrator\n#include \"inc/constants.jsxinc\"\n$.global.VALUE = MAGIC;\n");
    assert.match(command(root, "check", "./main.jsx"), /PASS/);
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./main.jsx"], {
      projectRoot: root, out: "dist/main.jsx", manifestOut: "dist/main.manifest.json", receiptOut: "dist/main.receipt.json"
    });
    const bundle = await fs.readFile(built.bundlePath, "utf8");
    assert.ok(bundle.startsWith("#target illustrator\n"));
    assert.ok(bundle.indexOf("var MAGIC") < bundle.indexOf("$.global.VALUE"));
    assert.equal(built.receipt.sources[0].dependencies.length, 1);
    assert.equal((await verifyReceipt(root, "dist/main.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
    await fs.writeFile(path.join(root, "inc", "constants.jsxinc"), "var MAGIC = 43;\n");
    await assert.rejects(verifyReceipt(root, "dist/main.receipt.json", { toolRoot: rootDir }), /source drift/);
    await fs.writeFile(path.join(root, "inc", "constants.jsxinc"), "#include \"../main.jsx\"\n");
    await assert.rejects(expandScriptFile(path.join(root, "main.jsx")), /Cyclic ExtendScript/);
  });
});

test("Git provider materializes transitive includes from the same pinned commit", async () => {
  await withProject(async (root) => {
    const repo = path.join(root, "library");
    const consumer = path.join(root, "consumer");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.mkdir(path.join(repo, "inc"));
    await fs.mkdir(consumer);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await fs.writeFile(path.join(repo, "src", "main.jsx"), '#include "../inc/value.jsxinc"\n$.global.GIT_VALUE = GIT_VALUE;\n');
    await fs.writeFile(path.join(repo, "inc", "value.jsxinc"), 'var GIT_VALUE = 27;\n');
    git("add", "src/main.jsx", "inc/value.jsxinc");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "one");
    const sha = git("rev-parse", "HEAD");
    const spec = `git+${pathToFileURL(repo).href}@${sha}#src/main.jsx`;
    const catalog = await loadCatalog();
    const inputs = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.match(inputs.sources[0].text, /GIT_VALUE = 27/);
    assert.equal(inputs.sources[0].dependencies.length, 1);
    const cachedEntry = inputs.sources[0].file;
    const cachedInclude = path.join(consumer, inputs.sources[0].dependencies[0].path);
    const oldTime = new Date("2001-01-01T00:00:00.000Z");
    await fs.utimes(cachedEntry, oldTime, oldTime);
    await fs.utimes(cachedInclude, oldTime, oldTime);
    const warm = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.equal((await fs.stat(cachedEntry)).mtime.getUTCFullYear(), 2001, "pinned cache must avoid rewriting valid entry");
    assert.equal((await fs.stat(cachedInclude)).mtime.getUTCFullYear(), 2001, "pinned cache must avoid rewriting valid include");
    assert.equal(warm.sources[0].sha256, inputs.sources[0].sha256);
    await fs.writeFile(cachedInclude, "var GIT_VALUE = -999;\n");
    const repaired = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.match(repaired.sources[0].text, /GIT_VALUE = 27/);
    assert.match(await fs.readFile(cachedInclude, "utf8"), /GIT_VALUE = 27/);
    const built = await buildComposition(rootDir, catalog, await loadLock(), [spec], {
      projectRoot: consumer, out: "dist/git.jsx", manifestOut: "dist/git.manifest.json", receiptOut: "dist/git.receipt.json"
    });
    assert.equal(built.receipt.sources[0].origin.revision, sha.toLowerCase());
    assert.equal((await verifyReceipt(consumer, "dist/git.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
    await fs.writeFile(path.join(repo, "inc", "value.jsxinc"), 'var GIT_VALUE = 28;\n');
    git("add", "inc/value.jsxinc");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "two");
    const again = await resolveBuildInputs(consumer, catalog, [spec]);
    assert.match(again.sources[0].text, /GIT_VALUE = 27/);
    assert.equal((await verifyReceipt(consumer, "dist/git.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
  });
});

test("Git provider refuses relative includes escaping the repository root", async () => {
  await withProject(async (root) => {
    const repo = path.join(root, "upstream");
    await fs.mkdir(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await fs.writeFile(path.join(repo, "index.jsx"), '#include "../escape.jsx"\n$.global.TEST = true;\n');
    git("add", "index.jsx");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "traversal");
    const spec = `git+${pathToFileURL(repo).href}@${git("rev-parse", "HEAD")}#index.jsx`;
    await assert.rejects(resolveBuildInputs(root, await loadCatalog(), [spec]), /escapes pinned repository/);
  });
});

test("Git cache refuses pre-planted directory links without modifying their destinations", async (t) => {
  await withProject(async (root) => {
    const repository = path.join(root, "gitlib");
    const consumer = path.join(root, "consumer");
    const outside = path.join(root, "outside");
    await fs.mkdir(repository);
    await fs.mkdir(consumer);
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "index.jsx");
    await fs.writeFile(sentinel, "DO_NOT_OVERWRITE");
    const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await fs.writeFile(path.join(repository, "index.jsx"), "$.global.REMOTE = 1;\n");
    git("add", "index.jsx");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture",
      "commit", "--quiet", "-m", "pinned");
    const sha = git("rev-parse", "HEAD");
    const url = pathToFileURL(repository).href;
    const fingerprint = createHash("sha256").update(`${url}\n${sha}\nindex.jsx`).digest("hex");
    const cacheRoot = path.join(consumer, ".essemble", "sources", fingerprint);
    await fs.mkdir(path.dirname(cacheRoot), { recursive: true });
    try {
      await fs.symlink(outside, cacheRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("symlink creation unavailable");
      throw error;
    }
    const spec = `git+${url}@${sha}#index.jsx`;
    await assert.rejects(resolveBuildInputs(consumer, await loadCatalog(), [spec]),
      /Git cache contains a symlink\/junction/);
    assert.equal(await fs.readFile(sentinel, "utf8"), "DO_NOT_OVERWRITE");
  });
});

test("concurrent first-use Git imports publish one complete shared cache", async () => {
  await withProject(async (root) => {
    const repo = path.join(root, "gitlib");
    const consumer = path.join(root, "consumer");
    await fs.mkdir(repo);
    await fs.mkdir(consumer);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    await fs.writeFile(path.join(repo, "index.jsx"), "$.global.CONCURRENT = true;\n");
    git("add", "index.jsx");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Fixture",
      "commit", "--quiet", "-m", "first");
    const spec = `git+${pathToFileURL(repo).href}@${git("rev-parse", "HEAD")}#index.jsx`;
    const catalog = await loadCatalog();
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      resolveBuildInputs(consumer, catalog, [spec])));
    assert.equal(new Set(results.map((result) => result.sources[0].sha256)).size, 1);
    assert.ok(results.every((result) => result.sources[0].text.includes("CONCURRENT = true")));
    const bareRoots = await fs.readdir(path.join(consumer, ".essemble", "git"));
    assert.equal(bareRoots.length, 1, "no abandoned staged clones should remain");
    assert.ok(!bareRoots[0].startsWith(".essemble-git-"));
  });
});

test("conflicting ExtendScript target directives are rejected", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "a.jsx"), "#target illustrator\n$.global.A = 1;\n");
    await fs.writeFile(path.join(root, "b.jsx"), "#target photoshop\n$.global.B = 1;\n");
    await assert.rejects(buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./a.jsx", "./b.jsx"], {
      projectRoot: root
    }), /Conflicting #target directives/);
  });
});

test("unmodified third-party ESPACK manifest combines with plain scripts", async () => {
  await withProject(async (root) => {
    const libraryPath = path.join(root, "external.jsx");
    await fs.writeFile(libraryPath, "$.global.EXTERNAL = { ok: 1 };\n");
    await fs.writeFile(path.join(root, "consumer.jsx"), "$.global.CONSUMER = $.global.EXTERNAL.ok;\n");
    const backend = await loadEspackBackend(rootDir);
    const lib = backend.libraryFromFile({
      id: "external", version: "1.0.0", global: "EXTERNAL", path: libraryPath,
      contract: [{ name: "ok", type: "number" }]
    });
    const manifest = backend.makeManifest({
      bundleName: "external", cacheDir: "", payloads: [], accel: null,
      libraries: [lib], entries: [{ id: "external", range: "=1.0.0" }], capabilities: []
    });
    const file = path.join(root, "external.manifest.json");
    await fs.writeFile(file, JSON.stringify(manifest));
    const built = await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./external.manifest.json", "./consumer.jsx"], {
      projectRoot: root, out: "dist/mixed.jsx", manifestOut: "dist/mixed.manifest.json", receiptOut: "dist/mixed.receipt.json"
    });
    assert.equal(built.receipt.resolved.libraries[0].id, "external");
    assert.deepEqual(built.receipt.sources.map((source) => source.kind), ["manifest", "script"]);
    assert.equal((await verifyReceipt(root, "dist/mixed.receipt.json", { toolRoot: rootDir, rebuild: true })).ok, true);
  });
});

test("tool capability registry rejects duplicate or absent implementations", async () => {
  const registry = createToolRegistry([{ id: "my-checker", capabilities: ["check"], async check({ text }) {
    return { ok: text === "ok", diagnostics: [] };
  } }]);
  assert.equal((await registry.invoke("check", { text: "ok" })).ok, true);
  await assert.rejects(registry.invoke("compose", {}), /No tool adapter/);
  assert.throws(() => createToolRegistry([
    { id: "a", capabilities: ["check"], check() {} },
    { id: "b", capabilities: ["check"], check() {} }
  ]), /multiple providers/);
});

test("modern COMTool adapter loads the actual SDK and correctly preserves test/lease semantics", async () => {
  const loaded = await loadComToolSdk(rootDir);
  assert.equal(typeof loaded.sdk.ComToolRunner, "function");
  const calls = [];
  const fake = {
    async testFile(options) {
      calls.push({ method: "testFile", options });
      return { verdict: "passed", classification: "completed", exitCode: 0, value: options.expected };
    },
    async runFile(options) {
      calls.push({ method: "runFile", options });
      return { classification: "completed", exitCode: 0, value: 42 };
    },
    async close() { calls.push({ method: "close" }); }
  };
  const common = { target: "adobe-fixture", timeoutMs: 90000, runnerFactory: async () => fake };
  const tested = await executeComTool(rootDir, "dummy.jsx", { ...common, expected: { ok: true } });
  assert.equal(tested.verdict, "passed");
  assert.deepEqual(calls.map((item) => item.method), ["testFile", "close"]);
  assert.equal(calls[0].options.targetId, "adobe-fixture");
  assert.equal(calls[0].options.watchdogMs, 90000);
  calls.length = 0;
  assert.equal((await executeComTool(rootDir, "dummy.jsx", common)).value, 42);
  assert.deepEqual(calls.map((item) => item.method), ["runFile", "close"]);
  const ambiguous = await executeComTool(rootDir, "dummy.jsx", { runnerFactory: async () => ({
    async runFile() { return { classification: "transport_ambiguous", exitCode: 2, ambiguous: true }; },
    async close() { throw new Error("unimportant transport cleanup failure"); }
  }) });
  assert.equal(ambiguous.classification, "transport_ambiguous");
  assert.equal(ambiguous.exitCode, 2);
  await assert.rejects(executeComTool(rootDir, "dummy.jsx", { timeoutMs: 1 }), /watchdog timeout/);
});

test("live receipt verification delegates to modern COMTool without invoking ESTC CLI", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "main.jsx"), "$.global.LIVE = 42;\n");
    await buildComposition(rootDir, await loadCatalog(), await loadLock(), ["./main.jsx"], {
      projectRoot: root, out: "dist/main.jsx", manifestOut: "dist/main.manifest.json", receiptOut: "dist/main.receipt.json"
    });
    let submitted;
    const evidence = await liveVerifyReceipt(root, "dist/main.receipt.json", {
      toolRoot: rootDir, evidenceOut: "dist/live-evidence.json", runnerFactory: async () => ({
        async testFile(options) {
          submitted = await fs.readFile(options.path, "utf8");
          return {
            classification: "completed", exitCode: 0, verdict: "passed",
            value: options.expected, target: { target: { id: "test-illustrator" } }
          };
        },
        async close() {}
      })
    });
    assert.match(submitted, /\$\.global\.LIVE = 42/);
    assert.match(submitted, /supportsLibraryComposition: false/);
    assert.equal(evidence.host.transport, "comtool-v2");
    assert.equal(evidence.host.targetId, "test-illustrator");
    assert.equal(evidence.run.classification, "completed");
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "dist", "live-evidence.json"))).run.exitCode, 0);
  });
});

test("source providers cannot forge a SHA identity or claim mismatched emitted bytes", async () => {
  await withProject(async (root) => {
    const file = path.join(root, "real.jsx");
    const bytes = Buffer.from("$.global.REAL = 1;\n");
    await fs.writeFile(file, bytes);
    const catalogue = await loadCatalog();
    const registry = createSourceRegistry([{
      id: "untrustworthy",
      match: (name) => name === "custom:real",
      async resolve() {
        return { kind: "script", file, bytes: bytes.length, sha256: "0".repeat(64), text: bytes.toString("utf8") };
      }
    }]);
    await assert.rejects(resolveBuildInputs(root, catalogue, ["custom:real"], registry), /identity differs/);
    const accurate = createSourceRegistry([{
      id: "inconsistent",
      match: (name) => name === "custom:real",
      async resolve() {
        return {
          kind: "script", file, bytes: bytes.length,
          sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
          text: "$.global.FAKE = true;"
        };
      }
    }]);
    await assert.rejects(resolveBuildInputs(root, catalogue, ["custom:real"], accurate), /text differs/);
  });
});

test("trusted consumer plugin extends source resolution without modifying ESsemble core", async () => {
  await withProject(async (root) => {
    command(root, "init");
    await fs.writeFile(path.join(root, "custom.jsx"), "$.global.CUSTOM_PLUGIN = true;\n");
    const pluginSource = [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      'import { createHash } from "node:crypto";',
      'export default { sourceProviders: [{',
      '  id: "virtual", match: (spec) => spec === "virtual:hello",',
      '  async resolve(root, spec) {',
      '    const file = path.join(root, "custom.jsx");',
      '    const bytes = await fs.readFile(file);',
      '    return { provider: "virtual", spec, kind: "script", file, path: "custom.jsx",',
      '      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") };',
      '  }',
      '}] };'
    ].join("\n");
    await fs.writeFile(path.join(root, "my-plugin.mjs"), pluginSource);
    const projectFile = path.join(root, "essemble.json");
    const project = JSON.parse(await fs.readFile(projectFile, "utf8"));
    project.plugins = ["./my-plugin.mjs"];
    await fs.writeFile(projectFile, JSON.stringify(project));
    command(root, "add", "virtual:hello");
    const blocked = spawnSync(process.execPath, [cli, "build"], { cwd: root, encoding: "utf8" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /--allow-plugins/);
    const resolved = JSON.parse(command(root, "resolve", "--entry", "runtime", "--allow-plugins", "--json"));
    assert.equal(resolved.sources[0].provider, "virtual");
    command(root, "build", "--allow-plugins");
    command(root, "verify", "dist/runtime.receipt.json", "--rebuild", "--allow-plugins");
    const output = await fs.readFile(path.join(root, "dist", "runtime.jsx"), "utf8");
    assert.match(output, /CUSTOM_PLUGIN/);
  });
});