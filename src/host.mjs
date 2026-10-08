import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveToolInstallation } from "./toolchain.mjs";

/** COMTool is the runtime provider; ESsemble itself never executes JSX. */
export async function loadComToolSdk(toolRoot) {
  const installed = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "ComToolV2", "current", "sdk", "node", "index.mjs")
    : null;
  const resolved = resolveToolInstallation(toolRoot, "comtool", { optional: true });
  const paths = [...new Set([
    process.env.COMTOOL_NODE_SDK_PATH,
    process.env.COMTOOL_SDK_PATH,
    installed,
    resolved ? path.join(resolved.root, "sdk", "node", "index.mjs") : null,
    path.join(toolRoot, "components", "comtool", "sdk", "node", "index.mjs"),
    path.join(toolRoot, "..", "comtool-v2", "sdk", "node", "index.mjs")
  ].filter(Boolean).map((item) => path.resolve(item)))];
  const errors = [];
  for (const entry of paths) {
    try {
      await fs.access(entry);
      const sdk = await import(pathToFileURL(entry).href);
      if (typeof sdk.ComToolRunner !== "function") {
        errors.push(`${entry} has no ComToolRunner`);
        continue;
      }
      return { sdk, path: entry };
    } catch (error) {
      errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No compatible COMTool V2 runner SDK found. ${errors.join("; ")}`);
}

export async function executeComTool(toolRoot, scriptPath, options = {}) {
  const timeout = Number(options.timeoutMs || 60000);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3600000) {
    throw new Error("COMTool watchdog timeout must be 100..3600000 ms");
  }
  const createRunner = options.runnerFactory || (async () => {
    const { sdk } = await loadComToolSdk(toolRoot);
    return new sdk.ComToolRunner({
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      ...(options.pipeName ? { pipeName: options.pipeName } : {})
    });
  });
  const runner = await createRunner();
  try {
    const common = {
      path: path.resolve(scriptPath),
      host: options.host || "illustrator",
      targetId: options.target || undefined,
      effects: options.effects || "unknown",
      watchdogMs: timeout
    };
    if (Object.hasOwn(options, "expected")) {
      return await runner.testFile({ ...common, expected: options.expected });
    }
    return await runner.runFile(common);
  } finally {
    // Transport cleanup must never obscure an ambiguous submitted result.
    await runner.close().catch(() => {});
  }
}