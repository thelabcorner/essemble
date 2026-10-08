import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { resolveSelection } from "./resolver.mjs";
import { ensureCachedManifest, cachedArtifactPath, artifactDigest, parseComponentSpec } from "./artifacts.mjs";
import { normalizeComponentId } from "./catalog.mjs";
import { assertTargetCompatible, normalizeTarget, selectManifestVariant, targetKey } from "./target.mjs";
import { loadEspackBackend } from "./espack-backend.mjs";
import { resolveBuildInputs, composeSourceText, expandScriptFile } from "./sources.mjs";
import { resolveProjectPath, resolveExternalSourcePath, canonicalProjectDestination } from "./paths.mjs";
import { publishArtifacts } from "./publication.mjs";
import { createToolRegistry } from "./tooling.mjs";
import { resolveToolInstallation } from "./toolchain.mjs";

async function toolFileIdentities(frameworkRoot, tool) {
  const installation = resolveToolInstallation(frameworkRoot, tool);
  return Promise.all(installation.files.map(async (name) => {
    const bytes = await fs.readFile(path.join(installation.root, name));
    return { path: name.replace(/\\/g, "/"), bytes: bytes.length, sha256: artifactDigest(bytes) };
  }));
}

async function outputPaths(root, options = {}) {
  const out = await resolveProjectPath(root, options.out || "dist/essemble.jsx", "bundle output");
  const manifestOut = await resolveProjectPath(root, options.manifestOut || "dist/essemble.manifest.json", "manifest output");
  const receiptOut = await resolveProjectPath(root, options.receiptOut || "dist/essemble.receipt.json", "receipt output");
  const canonical = await Promise.all([out, manifestOut, receiptOut]
    .map((item) => canonicalProjectDestination(root, item, "build output")));
  const keys = canonical.map((item) => process.platform === "win32" ? item.toLowerCase() : item);
  if (new Set(keys).size !== keys.length) {
    throw new Error("ESsemble bundle, manifest and receipt destinations must be distinct files");
  }
  return { out, manifestOut, receiptOut };
}

export async function buildComposition(root, catalog, lock, requestedValues, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || root);
  const registry = options.toolRegistry || createToolRegistry();
  const requested = requestedValues || [];
  if (!requested.length) throw new Error("build requires at least one requested component or source");
  const resolvedInputs = await resolveBuildInputs(projectRoot, catalog, requested, options.sourceRegistry);
  const sources = resolvedInputs.sources;
  const requestedSpecs = resolvedInputs.components.map((spec) => {
    const id = spec.id;
    const lockedVersion = lock.components[id]?.release?.version || null;
    if (spec.version && lockedVersion !== spec.version) {
      throw new Error(
        `${id}: project requests ${spec.version}, lock contains ${lockedVersion || "no release"}; run "essemble lock --use ${id}@${spec.version}"`
      );
    }
    return { id, version: spec.version };
  });
  const requestedIds = [...new Set(requestedSpecs.map((spec) => spec.id))].sort();
  const target = normalizeTarget(options.target);
  const nativePolicy = String(options.nativePolicy || "prefer");
  const plan = resolveSelection(catalog, requestedIds, ["runtime", "compose"]);
  const { mergeManifests, validateManifest, makeManifest } = await loadEspackBackend(root);
  const inputManifests = [];
  const inputs = [];
  const targetReports = [];

  for (const id of plan.requested) {
    const locked = lock.components[id];
    if (!locked?.release?.manifests?.length) {
      throw new Error(`${id}: no locked release manifest; run "essemble lock --use ${id}" first`);
    }
    const artifact = selectManifestVariant(locked.release.manifests, target);
    const cachedPath = await ensureCachedManifest(projectRoot, artifact, { fallbackRoot: root });
    const parsed = JSON.parse(await fs.readFile(cachedPath, "utf8"));
    validateManifest(parsed, `${id}:${artifact.name}`);
    targetReports.push(assertTargetCompatible(parsed, target, `${id}:${artifact.name}`, { nativePolicy }));
    inputManifests.push(cachedPath);
    inputs.push({
      component: id,
      version: locked.release.version,
      tag: locked.release.tag,
      tagCommit: locked.release.tagCommit,
      manifest: {
        name: artifact.name,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        variant: artifact.variant
      }
    });
  }

  for (const source of sources.filter((item) => item.kind === "manifest")) {
    const parsed = JSON.parse(await fs.readFile(source.file, "utf8"));
    validateManifest(parsed, source.path);
    targetReports.push(assertTargetCompatible(parsed, target, source.path, { nativePolicy }));
    inputManifests.push(source.file);
  }

  const name = options.name || "essemble";
  const preview = inputManifests.length
    ? mergeManifests(inputManifests, { name })
    : makeManifest({
      bundleName: name, cacheDir: "", payloads: [], accel: null, libraries: [], entries: [], capabilities: []
    });
  const mergedTargetReport = assertTargetCompatible(preview, target, "merged manifest", { nativePolicy });
  const paths = await outputPaths(projectRoot, options);
  for (const source of sources) {
    const sourceReal = await fs.realpath(source.file);
    const destinationReal = await Promise.all([paths.out, paths.manifestOut, paths.receiptOut]
      .map((item) => canonicalProjectDestination(projectRoot, item, "build artifact")));
    if (destinationReal.includes(sourceReal) ||
      (source.dependencies || []).some((included) => destinationReal.includes(path.resolve(projectRoot, included.path)))) {
      throw new Error(`Refusing to overwrite build input: ${source.path}`);
    }
  }
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-build-"));
  const stageBundle = path.join(stageRoot, "bundle.jsx");
  const stageManifest = path.join(stageRoot, "manifest.json");
  let built;
  let estc;
  let manifestBytes;
  try {
    built = await registry.invoke("compose", {
      toolRoot: root,
      options: {
        manifests: inputManifests.length ? inputManifests : [preview],
        out: stageBundle,
        manifestOut: stageManifest,
        name,
        deferB64: true
      }
    });
    // Plain JSX never needs ESPACK's runtime composition control plane.
    // ESPACK still owns canonical manifest production for the receipt.
    built.text = composeSourceText(inputManifests.length ? built.text : "", sources);
    await fs.writeFile(stageBundle, built.text, "utf8");
    estc = await registry.invoke("check", {
      toolRoot: root, text: built.text, file: path.basename(paths.out)
    });
    if (!estc.ok) {
      const detail = estc.diagnostics
        .filter((item) => item.severity === "error")
        .map((item) => `${item.code} ${item.line || 0}:${item.column || 0} ${item.message}`)
        .join("; ");
      throw new Error(`ESTC rejected composed bundle: ${detail || "unknown compatibility error"}`);
    }
    manifestBytes = await fs.readFile(stageManifest);
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
  const outputBytes = Buffer.from(built.text, "utf8");
  const relative = (file) => path.relative(projectRoot, file).replace(/\\/g, "/");

  const receipt = {
    schemaVersion: 1,
    tool: { name: "essemble", version: "0.2.0" },
    toolAdapters: {
      compose: registry.providerId("compose"),
      check: registry.providerId("check")
    },
    plugins: options.pluginFiles || [],
    target: { ...target, key: targetKey(target), nativePolicy },
    requested: plan.requested,
    requestedSpecs: requestedSpecs.map((spec) => spec.version ? `${spec.id}@${spec.version}` : spec.id).sort(),
    closure: plan.components,
    compositionGroups: plan.groups,
    inputs,
    ...(options.compiler ? { compiler: options.compiler } : {}),
    sources: sources.map(({ spec, kind, provider, path: file, bytes, sha256, origin, dependencies }) => ({
      spec, kind, provider, path: file, bytes, sha256,
      ...(origin ? { origin } : {}), ...(dependencies?.length ? { dependencies } : {})
    })),
    linker: {
      name: built.manifest.composer?.name || "espack",
      version: built.manifest.composer?.version || null,
      sourceRevision: resolveToolInstallation(root, "espack").source === "framework"
        ? lock.components.espack?.revision || null : null,
      sourceFiles: await toolFileIdentities(root, "espack")
    },
    composition: {
      name
    },
    validation: {
      estc: {
        ok: true,
        diagnostics: (estc?.diagnostics || []).map((item) => ({
          severity: item.severity,
          code: item.code,
          line: item.line || null,
          column: item.column || null,
          message: item.message
        }))
      }
    },
    resolved: {
      entries: built.entries,
      libraries: built.libraries.map((lib) => ({
        id: lib.id,
        version: lib.version,
        artifact: { fileName: lib.artifact.fileName, len: lib.artifact.len, sha256: lib.artifact.sha256 },
        provenance: lib.provenance || {}
      })),
      capabilities: built.capabilities,
      payloads: built.payloads.map((payload) => ({
        name: payload.name,
        version: payload.version,
        fileName: payload.fileName,
        len: payload.len
      })),
      accelerator: built.accel ? {
        name: built.accel.name,
        version: built.accel.version,
        fileName: built.accel.fileName,
        len: built.accel.len
      } : null,
      diagnostics: built.diagnostics || []
    },
    targetResolution: {
      inputs: targetReports,
      merged: mergedTargetReport
    },
    verification: {
      estc: {
        ok: true,
        errors: estc.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        warnings: estc.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length
      }
    },
    outputs: {
      bundle: { path: relative(paths.out), bytes: outputBytes.length, sha256: artifactDigest(outputBytes) },
      manifest: { path: relative(paths.manifestOut), bytes: manifestBytes.length, sha256: artifactDigest(manifestBytes) }
    }
  };
  await publishArtifacts([
    { path: paths.out, bytes: outputBytes },
    { path: paths.manifestOut, bytes: manifestBytes },
    { path: paths.receiptOut, bytes: Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8") }
  ]);
  return { receipt, receiptPath: paths.receiptOut, bundlePath: paths.out, manifestPath: paths.manifestOut };
}

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export async function verifyReceipt(root, receiptPath, options = {}) {
  const toolRoot = options.toolRoot || root;
  const registry = options.toolRegistry || createToolRegistry();
  const absoluteReceipt = await resolveProjectPath(root, receiptPath, "receipt");
  const receipt = JSON.parse(await fs.readFile(absoluteReceipt, "utf8"));
  const checks = [];
  for (const plugin of receipt.plugins || []) {
    const file = await resolveProjectPath(root, plugin.path, "receipt plugin");
    const bytes = await fs.readFile(file);
    const digest = artifactDigest(bytes);
    const ok = bytes.length === plugin.bytes && digest === plugin.sha256;
    checks.push({ kind: "plugin", path: plugin.path, ok, bytes: bytes.length, sha256: digest });
    if (!ok) throw new Error(`receipt plugin drift: ${plugin.path}`);
  }
  for (const key of ["bundle", "manifest"]) {
    const record = receipt.outputs?.[key];
    if (!record) throw new Error(`receipt missing outputs.${key}`);
    const artifactPath = await resolveProjectPath(root, record.path, `receipt ${key}`);
    const bytes = await fs.readFile(artifactPath);
    const digest = artifactDigest(bytes);
    const ok = bytes.length === record.bytes && digest === record.sha256;
    checks.push({ kind: key, path: record.path, ok, bytes: bytes.length, sha256: digest });
    if (!ok) throw new Error(`receipt output mismatch: ${record.path}`);
  }
  for (const input of receipt.inputs || []) {
    const locked = input.manifest;
    const cache = cachedArtifactPath(root, locked.sha256);
    const bytes = await fs.readFile(cache);
    const digest = artifactDigest(bytes);
    const ok = bytes.length === locked.bytes && digest === locked.sha256;
    checks.push({ kind: "input-manifest", component: input.component, path: cache, ok, bytes: bytes.length, sha256: digest });
    if (!ok) throw new Error(`receipt input mismatch: ${input.component}/${locked.name}`);
  }
  for (const source of receipt.sources || []) {
    const file = await resolveExternalSourcePath(root, source, options);
    const bytes = await fs.readFile(file);
    const digest = artifactDigest(bytes);
    const ok = bytes.length === source.bytes && digest === source.sha256;
    checks.push({ kind: `source-${source.kind}`, path: source.path, ok, bytes: bytes.length, sha256: digest });
    if (!ok) throw new Error(`receipt source drift: ${source.path}`);
    for (const include of source.dependencies || []) {
      const includedPath = await resolveExternalSourcePath(root, { ...include, spec: source.spec }, options);
      const includedBytes = await fs.readFile(includedPath);
      const includedDigest = artifactDigest(includedBytes);
      const includedOk = includedBytes.length === include.bytes && includedDigest === include.sha256;
      checks.push({ kind: "source-include", path: include.path, ok: includedOk, bytes: includedBytes.length, sha256: includedDigest });
      if (!includedOk) throw new Error(`receipt source drift: ${include.path}`);
    }
  }
  if (receipt.compiler) {
    for (const input of [receipt.compiler.config, ...(receipt.compiler.inputs || [])]) {
      if (!input) throw new Error("Compiler receipt is missing an input record");
      const absolute = await resolveProjectPath(root, input.path, "compiler input");
      const bytes = await fs.readFile(absolute);
      const digest = artifactDigest(bytes);
      const ok = digest === input.sha256 && (input.bytes === undefined || bytes.length === input.bytes);
      checks.push({ kind: "compiler-input", path: input.path, ok, bytes: bytes.length, sha256: digest });
      if (!ok) throw new Error(`receipt compiler input drift: ${input.path}`);
    }
    const output = receipt.compiler.output;
    const source = (receipt.sources || []).find((record) => record.path === output?.path);
    if (!source || source.sha256 !== output.sha256 || source.bytes !== output.bytes) {
      throw new Error("Receipt compiler output has no matching compiled source record");
    }
  }
  if (options.rebuild) {
    for (const capability of ["compose", "check"]) {
      const expectedProvider = receipt.toolAdapters?.[capability];
      if (expectedProvider && registry.providerId(capability) !== expectedProvider) {
        throw new Error(`receipt requires ${capability} provider ${expectedProvider}, selected ${registry.providerId(capability)}`);
      }
    }
    const espackInstallation = resolveToolInstallation(toolRoot, "espack");
    const espackRoot = espackInstallation.root;
    for (const input of receipt.linker?.sourceFiles || []) {
      if (!input || !["espack-merge.mjs", "espack-build.mjs", "espack-libraries.mjs"].includes(input.path)) {
        throw new Error("receipt contains an unsupported linker module identity");
      }
      const bytes = await fs.readFile(path.join(espackRoot, input.path));
      const sha256 = artifactDigest(bytes);
      if (sha256 !== input.sha256 || bytes.length !== input.bytes) {
        throw new Error(`rebuild linker module drift: ${input.path}`);
      }
      checks.push({ kind: "linker-module", path: input.path, ok: true, bytes: bytes.length, sha256 });
    }
    if (receipt.linker?.sourceRevision) {
      const current = gitHead(espackRoot);
      if (current !== receipt.linker.sourceRevision) {
        throw new Error(
          `rebuild linker drift: receipt uses ESPACK ${receipt.linker.sourceRevision}, materialized checkout is ${current}`
        );
      }
    }
    const { makeManifest } = await loadEspackBackend(toolRoot);
    const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-verify-"));
    try {
      const bundleOut = path.join(stageRoot, "bundle.jsx");
      const manifestOut = path.join(stageRoot, "manifest.json");
      const manifests = (receipt.inputs || []).map((input) =>
        cachedArtifactPath(root, input.manifest.sha256)
      );
      for (const source of receipt.sources || []) {
        if (source.kind === "manifest") {
          manifests.push(await resolveExternalSourcePath(root, source, options));
        }
      }
      const hasLinkedManifest = manifests.length > 0;
      if (!manifests.length) manifests.push(makeManifest({
        bundleName: receipt.composition?.name || "essemble", cacheDir: "", payloads: [], accel: null,
        libraries: [], entries: [], capabilities: []
      }));
      const built = await registry.invoke("compose", {
        toolRoot,
        options: {
          manifests,
          out: bundleOut,
          manifestOut,
          name: receipt.composition?.name || "essemble",
          deferB64: true
        }
      });
      const rebuiltSources = await Promise.all((receipt.sources || []).filter((source) => source.kind === "script")
        .map(async (source) => ({
          ...source, text: (await expandScriptFile(await resolveExternalSourcePath(root, source, options), root)).text
        })));
      const rebuiltText = composeSourceText(hasLinkedManifest ? built.text : "", rebuiltSources);
      await fs.writeFile(bundleOut, rebuiltText, "utf8");
      const estc = await registry.invoke("check", {
        toolRoot, text: rebuiltText, file: "receipt-rebuild.jsx"
      });
      if (!estc.ok) {
        const errors = estc.diagnostics.filter((item) => item.severity === "error");
        throw new Error(`receipt rebuild failed ESTC validation: ${errors.map((item) => item.code).join(", ")}`);
      }
      for (const [kind, file] of [["bundle", bundleOut], ["manifest", manifestOut]]) {
        const bytes = await fs.readFile(file);
        const digest = artifactDigest(bytes);
        const expected = receipt.outputs?.[kind];
        const ok = !!expected && bytes.length === expected.bytes && digest === expected.sha256;
        checks.push({ kind: `rebuild-${kind}`, path: expected?.path || file, ok, bytes: bytes.length, sha256: digest });
        if (!ok) throw new Error(`receipt rebuild mismatch: ${kind}`);
      }
    } finally {
      await fs.rm(stageRoot, { recursive: true, force: true });
    }
  }
  return { ok: true, receipt, checks };
}