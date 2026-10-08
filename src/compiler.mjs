import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveProjectPath } from "./paths.mjs";
import { publishArtifacts } from "./publication.mjs";
import { resolveToolInstallation } from "./toolchain.mjs";

const WORKER = fileURLToPath(new URL("./estc-worker.mjs", import.meta.url));

async function executeWorker(argv, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...argv], {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const receive = (sink) => (buffer) => {
      size += buffer.length;
      if (size > 2 * 1024 * 1024) {
        child.kill();
      } else sink.push(buffer);
    };
    child.stdout.on("data", receive(stdout));
    child.stderr.on("data", receive(stderr));
    child.on("error", (error) => { clearTimeout(watchdog); reject(error); });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (timedOut) return reject(new Error(`ESTC exceeded the ${timeoutMs} ms compile watchdog`));
      if (size > 2 * 1024 * 1024) return reject(new Error("ESTC exceeded the 2 MiB diagnostics limit"));
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(new Error(`ESTC compiler failed (exit ${code}): ${err || out}`));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`ESTC worker returned invalid JSON: ${out.slice(0, 500)}`)); }
    });
  });
}

export async function compileWithEstc(toolRoot, projectRoot, options = {}) {
  const config = await resolveProjectPath(projectRoot, options.config || "extendscript.config.mjs", "ESTC configuration");
  const out = await resolveProjectPath(projectRoot, options.out || "dist/estc.jsx", "ESTC output");
  if (config === out) throw new Error("ESTC output cannot overwrite its configuration");
  await fs.access(config);
  const estcRoot = path.resolve(options.estcRoot || resolveToolInstallation(toolRoot, "estc").root);
  const timeoutMs = Number(options.timeoutMs || 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) {
    throw new Error("ESTC compile watchdog must be 100..3600000 ms");
  }
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-estc-"));
  try {
    const stagedOut = path.join(stageRoot, "compiled.jsx");
    const result = await executeWorker([estcRoot, projectRoot, config, stagedOut], projectRoot, timeoutMs);
    const bytes = await fs.readFile(stagedOut);
    if (result.bytes !== bytes.length) throw new Error("ESTC reported an inconsistent output length");
    const inputs = [];
    for (const file of result.inputs || []) {
      const absolute = await resolveProjectPath(projectRoot, file, "ESTC input");
      const data = await fs.readFile(absolute);
      inputs.push({
        path: path.relative(projectRoot, absolute).replace(/\\/g, "/"),
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex")
      });
    }
    const configuration = await fs.readFile(config);
    await publishArtifacts([{ path: out, bytes }]);
    return {
      outfile: out,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      config: {
        path: path.relative(projectRoot, config).replace(/\\/g, "/"),
        sha256: createHash("sha256").update(configuration).digest("hex")
      },
      inputs,
      diagnostics: result.diagnostics || [],
      compatibilityTransforms: result.compatibilityTransforms || [],
      integrations: result.integrations || {}
    };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}