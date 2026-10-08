import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "../src/catalog.mjs";
import { cachedArtifactPath } from "../src/artifacts.mjs";
import { buildComposition, verifyReceipt } from "../src/composer.mjs";
import { loadEspackBackend } from "../src/espack-backend.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("ESsemble delegates manifest-v2 linking to ESPACK and emits a reproducible receipt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-compose-"));
  const source = path.join(tmp, "APP.facade.jsx");
  await fs.writeFile(source, "$.global.APP = { ok: true };\n", "utf8");

  const backend = await loadEspackBackend(rootDir);
  const libraries = backend;
  const buildApi = backend;
  const lib = libraries.libraryFromFile({
    id: "app",
    version: "1.0.0",
    global: "APP",
    path: source,
    contract: [{ name: "ok", type: "boolean" }],
    provenance: {
      package: "app",
      repository: "https://example.invalid/app",
      commit: "0123456789abcdef0123456789abcdef01234567",
      artifact: "dist/APP.facade.jsx"
    }
  });
  const manifest = buildApi.makeManifest({
    bundleName: "app",
    cacheDir: "",
    payloads: [],
    accel: null,
    libraries: [lib],
    entries: [{ id: "app", range: "=1.0.0" }],
    capabilities: []
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const digest = sha256(manifestBytes);
  const cache = cachedArtifactPath(rootDir, digest, ".json");
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, manifestBytes);

  const catalog = {
    dependencyScopes: ["runtime", "compose"],
    components: [
      {
        id: "app", aliases: [], source: { type: "git", path: "components/app" },
        dependencies: { runtime: [], compose: ["espack"] }
      },
      {
        id: "espack", aliases: [], source: { type: "git", path: "components/espack" },
        dependencies: { runtime: [], compose: [] }
      }
    ]
  };
  const lock = {
    schemaVersion: 2,
    components: {
      app: {
        sourceType: "git",
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        release: {
          version: "1.0.0",
          tag: "v1.0.0",
          tagCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          repository: "example/app",
          manifests: [{
            name: "APP.manifest.json",
            url: "https://example.invalid/APP.manifest.json",
            bytes: manifestBytes.length,
            sha256: digest,
            variant: { arch: "any" },
            manifestVersion: 2,
            composer: { name: "espack", version: "0.5.0" },
            entries: [{ id: "app", range: "=1.0.0" }]
          }]
        }
      },
      espack: {
        sourceType: "git",
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: path.join(rootDir, "components", "espack"),
          encoding: "utf8"
        }).trim()
      }
    }
  };

  const out = path.join(tmp, "runtime.jsx");
  const manifestOut = path.join(tmp, "runtime.manifest.json");
  const receiptOut = path.join(tmp, "runtime.receipt.json");
  const built = await buildComposition(rootDir, catalog, lock, ["app"], {
    projectRoot: tmp,
    target: "illustrator-win-x64",
    out,
    manifestOut,
    receiptOut,
    name: "test-runtime"
  });

  assert.deepEqual(built.receipt.requested, ["app"]);
  assert.deepEqual(built.receipt.resolved.libraries.map((item) => item.id), ["app"]);
  assert.equal(built.receipt.inputs[0].tagCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(built.receipt.linker.name, "espack");
  assert.equal(built.receipt.linker.version, "0.5.0");
  assert.ok((await fs.readFile(out, "utf8")).includes("$.global"));
  const consumerCache = cachedArtifactPath(tmp, digest, ".json");
  assert.deepEqual(await fs.readFile(consumerCache), manifestBytes,
    "immutable release manifests must be cached in the consumer, not the installed framework");
  await fs.rm(cache, { force: true });

  const verified = await verifyReceipt(tmp, receiptOut, { toolRoot: rootDir });
  assert.equal(verified.ok, true);
  assert.equal(verified.checks.length, 3);
  const rebuilt = await verifyReceipt(tmp, receiptOut, { rebuild: true, toolRoot: rootDir });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.checks.length, verified.checks.length + built.receipt.linker.sourceFiles.length + 2);
  assert.deepEqual(
    rebuilt.checks.slice(-2).map((check) => check.kind),
    ["rebuild-bundle", "rebuild-manifest"]
  );

  await fs.writeFile(out, "tampered\n", "utf8");
  await assert.rejects(() => verifyReceipt(tmp, receiptOut, { toolRoot: rootDir }), /receipt output mismatch/);

  await fs.rm(cache, { force: true });
  await fs.rm(tmp, { recursive: true, force: true });
});