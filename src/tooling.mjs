import fs from "node:fs/promises";
import path from "node:path";
import { checkComposedJsx, loadEspackBackend } from "./espack-backend.mjs";
import { liveVerifyReceipt } from "./live.mjs";
import { executeComTool } from "./host.mjs";
import { createRequire } from "node:module";
import { compileWithEstc } from "./compiler.mjs";
import { resolveToolInstallation } from "./toolchain.mjs";

/** Adapters delegate to independently maintained tools. Third-party tool
 * adapters are trusted executable code and must be registered explicitly. */
export const builtInTools = Object.freeze([
  Object.freeze({
    id: "estc", capabilities: ["check", "compile"],
    relativePath: "components/estc/src/check-jsx.mjs",
    async check({ toolRoot, text, file }) { return checkComposedJsx(toolRoot, text, file); },
    async compile({ toolRoot, projectRoot, options }) {
      return compileWithEstc(toolRoot, projectRoot, options);
    }
  }),
  Object.freeze({
    id: "espack", capabilities: ["compose"],
    relativePath: "components/espack/espack-merge.mjs",
    async compose({ toolRoot, options }) {
      const { merge } = await loadEspackBackend(toolRoot);
      return merge(options);
    }
  }),
  Object.freeze({
    id: "comtool", capabilities: ["live", "run"],
    relativePath: "components/comtool/sdk/node/index.mjs",
    async live({ projectRoot, receipt, options, toolRoot }) {
      return liveVerifyReceipt(projectRoot, receipt, { ...options, toolRoot });
    },
    async run({ toolRoot, script, options }) {
      return executeComTool(toolRoot, script, options);
    }
  })
]);

export function createToolRegistry(adapters = builtInTools, options = {}) {
  const byId = new Map();
  const candidates = new Map();
  for (const adapter of adapters) {
    if (!adapter || !/^[a-z][a-z0-9-]*$/.test(String(adapter.id || ""))) {
      throw new Error("Tool adapter requires a portable id");
    }
    if (byId.has(adapter.id)) throw new Error(`Duplicate tool adapter: ${adapter.id}`);
    if (!Array.isArray(adapter.capabilities) || !adapter.capabilities.length) {
      throw new Error(`${adapter.id}: tool adapter requires capabilities`);
    }
    for (const capability of adapter.capabilities) {
      if (typeof adapter[capability] !== "function") {
        throw new Error(`${adapter.id}: missing ${capability} implementation`);
      }
      if (!candidates.has(capability)) candidates.set(capability, []);
      candidates.get(capability).push(adapter);
    }
    byId.set(adapter.id, adapter);
  }
  const selection = options.providers || {};
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("Tool provider selections must be an object");
  }
  for (const capability of Object.keys(selection)) {
    if (!candidates.has(capability)) {
      throw new Error(`Cannot select unknown tool capability: ${capability}`);
    }
  }
  const byCapability = new Map();
  for (const [capability, providers] of candidates) {
    const selected = selection[capability];
    if (selected !== undefined && (typeof selected !== "string" ||
      !providers.some((provider) => provider.id === selected))) {
      throw new Error(`Provider ${String(selected)} does not implement ${capability}`);
    }
    if (selected === undefined && providers.length > 1) {
      throw new Error(`Capability ${capability} has multiple providers; select one explicitly`);
    }
    byCapability.set(capability, providers.find((provider) => provider.id === selected) || providers[0]);
  }
  return Object.freeze({
    list: () => [...byId.values()].map((adapter) => ({ id: adapter.id, capabilities: [...adapter.capabilities] })),
    get: (id) => byId.get(id) || null,
    providerId: (capability) => byCapability.get(capability)?.id || null,
    async invoke(capability, context) {
      const adapter = byCapability.get(capability);
      if (!adapter) throw new Error(`No tool adapter provides capability: ${capability}`);
      return adapter[capability](context);
    }
  });
}

export async function discoverTools(toolRoot, registry = createToolRegistry()) {
  const output = [];
  for (const row of registry.list()) {
    const adapter = registry.get(row.id);
    let available = false;
    const installation = ["estc", "espack", "comtool"].includes(row.id)
      ? resolveToolInstallation(toolRoot, row.id, { optional: true }) : null;
    const relative = adapter.relativePath?.replace(/^components\/[a-z0-9-]+\//, "");
    const explicitSdk = row.id === "comtool"
      ? process.env.COMTOOL_NODE_SDK_PATH || process.env.COMTOOL_SDK_PATH : null;
    const file = explicitSdk ? path.resolve(explicitSdk)
      : installation ? path.join(installation.root, relative)
      : adapter.relativePath ? path.join(toolRoot, adapter.relativePath) : null;
    if (file) {
      try { await fs.access(file); available = Boolean(explicitSdk || installation || !adapter.relativePath?.startsWith("components/")); }
      catch { /* optional integration */ }
    }
    const item = { ...row, available, path: file,
      ...(explicitSdk ? { installationSource: process.env.COMTOOL_NODE_SDK_PATH
        ? "COMTOOL_NODE_SDK_PATH" : "COMTOOL_SDK_PATH" } :
        installation ? { installationSource: installation.source } : {}) };
    if (row.id === "estc" && row.capabilities.includes("compile")) {
      const pkg = path.join(installation?.root || toolRoot, "package.json");
      const require = createRequire(pkg);
      const missingDependencies = [];
      for (const name of ["esbuild", "typescript", "uglify-js", "types-for-adobe", "acorn"]) {
        try { require.resolve(name); }
        catch { missingDependencies.push(name); }
      }
      item.readiness = { check: available, compile: available && !missingDependencies.length };
      item.missingDependencies = missingDependencies;
    }
    output.push(item);
  }
  return output;
}