#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPTS_ROOT = path.dirname(ROOT);

const estcRoot = process.env.ESTC_ROOT
  ? path.resolve(process.env.ESTC_ROOT)
  : path.join(SCRIPTS_ROOT, "extendscript-toolchain");
const estc = path.join(estcRoot, "bin", "estc.mjs");

if (!existsSync(estc)) {
  throw new Error(
    "ESTC local toolchain not found. Keep ESsemble beside ESTC or set ESTC_ROOT."
  );
}

const env = { ...process.env };
if (!env.COMTOOL_NODE_SDK_PATH && !env.COMTOOL_SDK_PATH) {
  const sdk = path.join(SCRIPTS_ROOT, "comtool-v2", "sdk", "node", "index.mjs");
  if (existsSync(sdk)) env.COMTOOL_NODE_SDK_PATH = sdk;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "essemble-engine-"));
const probe = path.join(dir, "essemble-local-ci.jsx");
writeFileSync(
  probe,
  [
    "#target illustrator",
    "({",
    '  ok: true,',
    '  framework: "essemble",',
    "  sum: 1 + 2 + 3",
    "});",
    ""
  ].join("\n"),
  "utf8"
);

try {
  const expected = JSON.stringify({
    ok: true,
    framework: "essemble",
    sum: 6
  });
  const run = spawnSync(
    process.execPath,
    [
      estc,
      "live-test",
      probe,
      "--expect-json",
      expected,
      "--launch",
      "--json"
    ],
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 180_000
    }
  );

  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      "ESsemble real-engine gate failed:\n" +
      String(run.stdout || "") +
      String(run.stderr || "")
    );
  }

  const result = JSON.parse(String(run.stdout || "").trim());
  if (
    result.ok !== true ||
    result.run?.exitCode !== 0 ||
    result.run?.classification !== "completed"
  ) {
    throw new Error("Unexpected ESTC/COMTool result: " + JSON.stringify(result));
  }

  console.log(JSON.stringify({
    ok: true,
    framework: "ESsemble",
    gate: "ESTC -> COMTool -> real ExtendScript",
    appVersion: result.appVersion || "",
    engineVersion: result.engineVersion || "",
    targetId: result.targetId || "",
    transport: result.transport || ""
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
