import fs from "node:fs";
import path from "node:path";

// These are *external* tool installations, not vendored dependencies. A
// standalone ESsemble installation can therefore orchestrate tools installed
// independently by its user or by a package manager.
const TOOLS = Object.freeze({
  espack: {
    env: "ESPACK_ROOT",
    local: "components/espack",
    siblings: ["espack"],
    packages: ["espack"],
    files: ["espack-merge.mjs", "espack-build.mjs", "espack-libraries.mjs"]
  },
  estc: {
    env: "ESTC_ROOT",
    local: "components/estc",
    siblings: ["extendscript-toolchain"],
    packages: ["extendscript-toolchain"],
    files: ["src/check-jsx.mjs"]
  },
  comtool: {
    env: "COMTOOL_ROOT",
    local: "components/comtool",
    siblings: ["comtool-v2"],
    packages: ["comtool-v2"],
    files: ["sdk/node/index.mjs"]
  }
});

const exists = (filename) => {
  try { return fs.statSync(filename).isFile(); }
  catch { return false; }
};

function candidates(frameworkRoot, spec) {
  const root = path.resolve(frameworkRoot);
  const list = [];
  if (process.env[spec.env]) list.push({ root: path.resolve(process.env[spec.env]), source: spec.env });
  list.push({ root: path.join(root, spec.local), source: "framework" });
  for (const sibling of spec.siblings) {
    list.push({ root: path.resolve(root, "..", sibling), source: "sibling" });
  }
  for (const pkg of spec.packages) {
    list.push({ root: path.join(root, "node_modules", pkg), source: "package" });
  }
  return list;
}

/** Find the first complete installation; reject a misconfigured explicit root
 * instead of silently using a completely different tool version. */
export function resolveToolInstallation(frameworkRoot, tool, options = {}) {
  const spec = TOOLS[tool];
  if (!spec) throw new Error(`Unknown ESsemble tool installation: ${tool}`);
  const choices = candidates(frameworkRoot, spec);
  const explicit = Boolean(process.env[spec.env]);
  for (const item of choices) {
    const missing = spec.files.filter((file) => !exists(path.join(item.root, file)));
    if (!missing.length) return { tool, root: item.root, source: item.source, files: spec.files };
    if (explicit && item.source === spec.env) {
      if (!options.optional) {
        throw new Error(`${spec.env} does not contain a complete ${tool} installation: missing ${missing.join(", ")} at ${item.root}`);
      }
      return null;
    }
  }
  if (options.optional) return null;
  throw new Error(`No usable ${tool} installation found. Set ${spec.env} to a separately installed ${tool} root, or install it alongside ESsemble.`);
}

export function toolchainStatus(frameworkRoot) {
  return Object.keys(TOOLS).map((tool) => {
    const installation = resolveToolInstallation(frameworkRoot, tool, { optional: true });
    return installation
      ? { tool, available: true, root: installation.root, source: installation.source }
      : { tool, available: false, environmentVariable: TOOLS[tool].env };
  });
}