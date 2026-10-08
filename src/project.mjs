import fs from "node:fs/promises";
import path from "node:path";
import { normalizeComponentId } from "./catalog.mjs";
import { parseComponentSpec } from "./artifacts.mjs";
import { normalizeTarget } from "./target.mjs";
import { canonicalSelection, selectionKey, isSourceSpec, pinGitSource } from "./sources.mjs";
import { pinNpmSource } from "./npm-source.mjs";

export const PROJECT_FILE = "essemble.json";

function nativePolicy(value) {
  const policy = String(value || "prefer");
  if (!["prefer", "portable", "require"].includes(policy)) {
    throw new Error(`Unknown native policy: ${policy}`);
  }
  return policy;
}

export async function loadProject(root, options = {}) {
  const file = path.join(root, options.file || PROJECT_FILE);
  try {
    const project = JSON.parse(await fs.readFile(file, "utf8"));
    return normalizeProject(project);
  } catch (error) {
    if (error?.code === "ENOENT" && !options.required) return null;
    if (error?.code === "ENOENT") throw new Error(`ESsemble project not found: ${file}`);
    throw error;
  }
}

export function normalizeProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("ESsemble project must be an object");
  }
  if (project.schemaVersion !== 1) {
    throw new Error(`Unsupported ESsemble project schemaVersion: ${project.schemaVersion}`);
  }
  const target = normalizeTarget(project.target || "illustrator-win-x64");
  const native = nativePolicy(project.native);
  const plugins = project.plugins || [];
  if (!Array.isArray(plugins) || plugins.some((item) => typeof item !== "string")) {
    throw new Error("ESsemble plugins must be an array of project-relative module paths");
  }
  const toolProviders = project.toolProviders || {};
  if (!toolProviders || typeof toolProviders !== "object" || Array.isArray(toolProviders) ||
    Object.entries(toolProviders).some(([capability, provider]) =>
      !/^[a-z][a-z0-9-]*$/.test(capability) || !/^[a-z][a-z0-9-]*$/.test(String(provider)))) {
    throw new Error("ESsemble toolProviders must map capability names to provider IDs");
  }
  const entries = project.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length) {
    throw new Error("ESsemble project entries must be a non-empty object");
  }
  const normalizedEntries = {};
  for (const name of Object.keys(entries).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`Invalid ESsemble entry name: ${name}`);
    }
    const entry = entries[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Project entry ${name} must be an object`);
    }
    if (!Array.isArray(entry.use)) throw new Error(`Project entry ${name}.use must be an array`);
    const compiler = entry.compiler;
    if (compiler !== undefined && (!compiler || typeof compiler !== "object" || Array.isArray(compiler) ||
      typeof compiler.config !== "string" || !compiler.config.trim() ||
      typeof compiler.out !== "string" || !compiler.out.trim())) {
      throw new Error(`Project entry ${name}.compiler requires config and out paths`);
    }
    normalizedEntries[name] = {
      // Script evaluation order is meaningful: preserve the consumer's order.
      use: [...new Set(entry.use.map((value) => String(value)))],
      target: entry.target ? normalizeTarget(entry.target) : target,
      native: nativePolicy(entry.native || native),
      out: String(entry.out || `dist/${name}.jsx`),
      manifestOut: String(entry.manifestOut || `dist/${name}.manifest.json`),
      receipt: String(entry.receipt || `dist/${name}.receipt.json`),
      ...(compiler ? { compiler: { config: compiler.config, out: compiler.out } } : {})
    };
  }
  return {
    schemaVersion: 1,
    target,
    native,
    plugins: [...new Set(plugins)],
    toolProviders: { ...toolProviders },
    entries: normalizedEntries
  };
}

export async function createProject(root, options = {}) {
  const file = path.join(root, options.file || PROJECT_FILE);
  try {
    await fs.access(file);
    if (!options.force) throw new Error(`Refusing to overwrite existing ${path.basename(file)}`);
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error?.message || "").startsWith("Refusing to overwrite")) throw error;
    if (String(error?.message || "").startsWith("Refusing to overwrite")) throw error;
  }
  const project = {
    schemaVersion: 1,
    target: "illustrator-win-x64",
    native: "prefer",
    entries: {
      runtime: {
        use: [],
        out: "dist/runtime.jsx"
      }
    }
  };
  await fs.writeFile(file, JSON.stringify(project, null, 2) + "\n", "utf8");
  return file;
}

function canonicalSpec(catalog, value) {
  return canonicalSelection(catalog, value);
}

function specId(catalog, value) {
  return selectionKey(catalog, value);
}

export async function updateProjectSelection(root, catalog, action, values, options = {}) {
  const file = path.join(root, options.file || PROJECT_FILE);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  if (!raw.entries || typeof raw.entries !== "object") raw.entries = {};
  const entryName = options.entry || "runtime";
  if (!raw.entries[entryName]) raw.entries[entryName] = { use: [], out: `dist/${entryName}.jsx` };
  const current = Array.isArray(raw.entries[entryName].use) ? raw.entries[entryName].use.slice() : [];
  if (action === "add") {
    for (const value of values) {
      const next = canonicalSpec(catalog, await pinNpmSource(root, pinGitSource(value)));
      const id = specId(catalog, next);
      const index = current.findIndex((item) => specId(catalog, item) === id);
      if (index >= 0) current[index] = next;
      else current.push(next);
    }
  } else if (action === "remove") {
    const remove = new Set(values.map((value) => specId(catalog, value)));
    for (let i = current.length - 1; i >= 0; i--) {
      if (remove.has(specId(catalog, current[i]))) current.splice(i, 1);
    }
  } else {
    throw new Error(`Unknown project selection action: ${action}`);
  }
  raw.entries[entryName].use = [...new Set(current)];
  normalizeProject(raw);
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return { file, entry: entryName, use: raw.entries[entryName].use };
}

export function projectSpecs(project, entryNames = null) {
  const names = entryNames?.length ? entryNames : Object.keys(project.entries).sort();
  const byId = new Map();
  for (const name of names) {
    const entry = project.entries[name];
    if (!entry) throw new Error(`Unknown project entry: ${name}`);
    for (const value of entry.use) {
      if (isSourceSpec(value)) {
        byId.set(`source:${value}`, { name: value, version: null });
        continue;
      }
      const spec = parseComponentSpec(value);
      const prior = byId.get(spec.name);
      if (prior && prior.version && spec.version && prior.version !== spec.version) {
        throw new Error(`Conflicting project versions for ${spec.name}: ${prior.version} vs ${spec.version}`);
      }
      byId.set(spec.name, spec.version ? spec : prior || spec);
    }
  }
  return [...byId.values()]
    .map((spec) => spec.version ? `${spec.name}@${spec.version}` : spec.name);
}