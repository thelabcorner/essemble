import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyReceipt } from "./composer.mjs";
import { executeComTool, loadComToolSdk } from "./host.mjs";
import { resolveToolInstallation } from "./toolchain.mjs";

function uniqueExisting(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))]
    .filter((value) => fs.existsSync(value));
}

function estcCandidates(root) {
  return uniqueExisting([
    process.env.ESTC_ROOT ? path.join(process.env.ESTC_ROOT, "bin", "estc.mjs") : null,
    resolveToolInstallation(root, "estc", { optional: true })?.root &&
      path.join(resolveToolInstallation(root, "estc", { optional: true }).root, "bin", "estc.mjs"),
    path.join(root, "components", "estc", "bin", "estc.mjs"),
    path.join(root, "..", "extendscript-toolchain", "bin", "estc.mjs")
  ]);
}

function comtoolSdkCandidates(root, estcPath) {
  const estcRoot = path.dirname(path.dirname(estcPath));
  const estcScriptsRoot = path.dirname(estcRoot);
  const installed = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "ComToolV2", "current", "sdk", "node", "index.mjs")
    : null;
  return uniqueExisting([
    process.env.COMTOOL_NODE_SDK_PATH,
    process.env.COMTOOL_SDK_PATH,
    resolveToolInstallation(root, "comtool", { optional: true })?.root &&
      path.join(resolveToolInstallation(root, "comtool", { optional: true }).root, "sdk", "node", "index.mjs"),
    path.join(estcScriptsRoot, "comtool-v2", "sdk", "node", "index.mjs"),
    path.join(root, "..", "comtool-v2", "sdk", "node", "index.mjs"),
    installed,
    path.join(root, "components", "comtool", "sdk", "node", "index.mjs")
  ]);
}

function selectEstc(root, env) {
  const failures = [];
  for (const cli of estcCandidates(root)) {
    const probe = spawnSync(process.execPath, [cli, "--help"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15000
    });
    if (!probe.error && probe.status === 0) return cli;
    failures.push({
      cli,
      status: probe.status,
      error: probe.error?.message || String(probe.stderr || "").trim() || "unknown failure"
    });
  }
  throw new Error(
    "No runnable ESTC CLI found for live verification" +
    (failures.length ? ": " + failures.map((item) => `${item.cli} (${item.error})`).join("; ") : "")
  );
}

async function selectCompatibleComToolSdk(root, estcPath) {
  const failures = [];
  for (const entry of comtoolSdkCandidates(root, estcPath)) {
    try {
      const sdk = await import(pathToFileURL(entry).href);
      if (typeof sdk.ComToolLocalRuntime?.start === "function") return entry;
      failures.push(`${entry} (missing ComToolLocalRuntime.start)`);
    } catch (error) {
      failures.push(`${entry} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(
    "No COMTool Node SDK compatible with ESTC live verification was found" +
    (failures.length ? ": " + failures.join("; ") : "")
  );
}

function makeProbe(bundle, receipt) {
  const rows = receipt.resolved.libraries.map((lib) => ({
    id: lib.id,
    version: lib.version,
    sha256: lib.artifact.sha256
  }));
  const requested = receipt.requested.slice();
  const rowLiteral = JSON.stringify(rows);
  const requestedLiteral = JSON.stringify(requested);
  const usesComposition = (receipt.inputs || []).length > 0 ||
    (receipt.sources || []).some((source) => source.kind === "manifest");
  const probe = [
    "#target illustrator",
    bundle,
    "",
    "(function () {",
    "  var g = $.global;",
    "  var expected = " + rowLiteral + ";",
    "  var requested = " + requestedLiteral + ";",
    "  var active = [];",
    "  var i, info;",
    `  if (${usesComposition} && (!g.ESPAK || g.ESPAK.supportsLibraryComposition !== true || typeof g.ESPAK.libraryInfo !== \"function\")) {`,
    "    return { ok: false, error: \"ESPAK composition control plane missing\" };",
    "  }",
    "  for (i = 0; i < expected.length; i++) {",
    "    info = g.ESPAK.libraryInfo(expected[i].id);",
    "    if (!info) return { ok: false, error: \"missing library \" + expected[i].id };",
    "    if (info.version !== expected[i].version) return { ok: false, error: \"version mismatch \" + expected[i].id };",
    "    if (info.sha256 !== expected[i].sha256) return { ok: false, error: \"sha256 mismatch \" + expected[i].id };",
    "    active[active.length] = info.id + \"@\" + info.version + \"#\" + info.sha256;",
    "  }",
    "  for (i = 0; i < requested.length; i++) {",
    "    if (!g.ESPAK.libraryInfo(requested[i])) return { ok: false, error: \"requested root inactive \" + requested[i] };",
    "  }",
    `  return { ok: true, supportsLibraryComposition: ${usesComposition}, requested: requested, active: active };`,
    "}());",
    ""
  ].join("\n");
  const expected = {
    ok: true,
    supportsLibraryComposition: usesComposition,
    requested,
    active: rows.map((row) => `${row.id}@${row.version}#${row.sha256}`)
  };
  return { probe, expected };
}

export async function liveVerifyReceipt(root, receiptPath, options = {}) {
  const toolRoot = options.toolRoot || root;
  const verified = await verifyReceipt(root, receiptPath, {
    toolRoot, allowExternalSources: options.allowExternalSources === true
  });
  const receipt = verified.receipt;
  const bundlePath = path.resolve(root, receipt.outputs.bundle.path);
  const bundle = await fsp.readFile(bundlePath, "utf8");
  const { probe, expected } = makeProbe(bundle, receipt);

  // COMTool V2 runs JSX directly and does not require ESTC's older live-test
  // CLI. Preserve the older ESTC integration only for explicit --launch.
  if (!options.launch) {
    let compatible = !!options.runnerFactory;
    if (!compatible) {
      try { await loadComToolSdk(toolRoot); compatible = true; }
      catch { /* older installations can use the ESTC compatibility path */ }
    }
    if (compatible) {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "essemble-live-v2-"));
      try {
        const probePath = path.join(dir, "receipt-probe.jsx");
        await fsp.writeFile(probePath, probe, "utf8");
        const result = await executeComTool(toolRoot, probePath, {
          expected,
          timeoutMs: options.timeoutMs || 180000,
          target: options.target,
          host: "illustrator",
          runnerFactory: options.runnerFactory
        });
        if (result.exitCode !== 0 || result.classification !== "completed" || result.verdict !== "passed") {
          throw new Error(`COMTool V2 receipt verification ${result.classification}: ${JSON.stringify({
            verdict: result.verdict, classification: result.classification,
            exitCode: result.exitCode, assertionError: result.assertionError, error: result.error,
            ambiguous: result.ambiguous
          })}`);
        }
        const evidence = {
          schemaVersion: 1,
          receipt: path.relative(root, path.resolve(root, receiptPath)).replace(/\\/g, "/"),
          bundle: receipt.outputs.bundle,
          requested: receipt.requested,
          libraries: receipt.resolved.libraries.map(({ id, version, artifact }) => ({ id, version, sha256: artifact.sha256 })),
          host: {
            appVersion: "", engineVersion: "",
            targetId: result.target?.target?.id || "", transport: "comtool-v2"
          },
          run: { exitCode: result.exitCode, classification: result.classification }
        };
        if (options.evidenceOut) {
          const out = path.resolve(root, options.evidenceOut);
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await fsp.writeFile(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
        }
        return evidence;
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
  }

  const env = { ...process.env };
  const estc = selectEstc(toolRoot, env);
  const sdk = await selectCompatibleComToolSdk(toolRoot, estc);
  env.COMTOOL_NODE_SDK_PATH = sdk;
  delete env.COMTOOL_SDK_PATH;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "essemble-live-"));
  const probePath = path.join(dir, "receipt-probe.jsx");
  await fsp.writeFile(probePath, probe, "utf8");

  const timeoutMs = Number(options.timeoutMs || 180000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) {
    throw new Error("live timeout must be an integer from 100 through 3600000 ms");
  }

  try {
    const args = [
      estc,
      "live-test",
      probePath,
      "--expect-json",
      JSON.stringify(expected),
      "--timeout-ms",
      String(timeoutMs),
      "--json"
    ];
    if (options.launch) args.push("--launch");
    if (options.target) args.push("--target", String(options.target));

    const run = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: timeoutMs + 30000
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(
        "ESsemble live receipt verification failed:\n" +
        String(run.stdout || "") +
        String(run.stderr || "")
      );
    }

    const result = JSON.parse(String(run.stdout || "").trim());
    if (result.ok !== true || result.run?.exitCode !== 0 || result.run?.classification !== "completed") {
      throw new Error("Unexpected ESTC/COMTool live result: " + JSON.stringify(result));
    }

    const evidence = {
      schemaVersion: 1,
      receipt: path.relative(root, path.resolve(root, receiptPath)).replace(/\\/g, "/"),
      bundle: receipt.outputs.bundle,
      requested: receipt.requested,
      libraries: receipt.resolved.libraries.map((lib) => ({
        id: lib.id,
        version: lib.version,
        sha256: lib.artifact.sha256
      })),
      host: {
        appVersion: result.appVersion || "",
        engineVersion: result.engineVersion || "",
        targetId: result.targetId || "",
        transport: result.transport || ""
      },
      run: {
        exitCode: result.run.exitCode,
        classification: result.run.classification
      }
    };

    if (options.evidenceOut) {
      const out = path.resolve(root, options.evidenceOut);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    }
    return evidence;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
