import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** npm:@scope/name@1.2.3#src/index.jsx and npm:name@1.2.3.
 * The package must already exist locally. No npm commands are executed.
 */
export function parseNpmSpec(spec, requireVersion = true) {
  const raw = String(spec);
  if (!raw.startsWith("npm:")) throw new Error(`Not an npm source: ${raw}`);
  const value = raw.slice(4);
  const fragment = value.indexOf("#");
  const descriptor = fragment < 0 ? value : value.slice(0, fragment);
  const entry = fragment < 0 ? null : value.slice(fragment + 1);
  const at = descriptor.lastIndexOf("@");
  const name = at > 0 ? descriptor.slice(0, at) : descriptor;
  const version = at > 0 ? descriptor.slice(at + 1) : null;
  if (!/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name)) {
    throw new Error(`Invalid npm library name: ${name}`);
  }
  if (requireVersion && !version) throw new Error(`Unpinned npm source ${raw}; use essemble add to pin its version`);
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`npm source requires an exact semver version: ${version}`);
  }
  if (entry !== null && (!entry || entry.includes("\\") || path.posix.isAbsolute(entry) ||
    path.posix.normalize(entry) === ".." || path.posix.normalize(entry).startsWith("../"))) {
    throw new Error(`npm source entry must stay inside the package: ${entry}`);
  }
  return { name, version, entry };
}

async function installedPackage(projectRoot, name) {
  const root = await fs.realpath(projectRoot);
  const directory = path.join(root, "node_modules", ...name.split("/"));
  let canonical;
  try { canonical = await fs.realpath(directory); }
  catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`npm package ${name} is not installed under ${projectRoot}/node_modules`);
    }
    throw error;
  }
  if (!within(root, canonical)) {
    throw new Error(`npm package symlink escapes project: ${name}; use an explicit local library path`);
  }
  const metadataFile = path.join(canonical, "package.json");
  if (!within(canonical, await fs.realpath(metadataFile))) {
    throw new Error(`npm package metadata symlink escapes package: ${name}`);
  }
  if ((await fs.stat(metadataFile)).size > 2 * 1024 * 1024) {
    throw new Error(`npm package metadata exceeds the 2 MiB safety limit: ${name}`);
  }
  const metadata = await fs.readFile(metadataFile);
  const pkg = JSON.parse(metadata.toString("utf8"));
  if (pkg.name !== name || typeof pkg.version !== "string") {
    throw new Error(`Installed npm package identity does not match ${name}`);
  }
  return { root, directory: canonical, metadataFile, metadata, pkg };
}

export async function pinNpmSource(projectRoot, spec) {
  if (!String(spec).startsWith("npm:")) return spec;
  const parsed = parseNpmSpec(spec, false);
  const installed = await installedPackage(projectRoot, parsed.name);
  if (parsed.version && parsed.version !== installed.pkg.version) {
    throw new Error(`npm ${parsed.name}: requested ${parsed.version}, installed ${installed.pkg.version}`);
  }
  parseNpmSpec(`npm:${parsed.name}@${installed.pkg.version}`);
  return `npm:${parsed.name}@${installed.pkg.version}${parsed.entry === null ? "" : `#${parsed.entry}`}`;
}

export function createNpmSourceProvider(localFileProvider) {
  return Object.freeze({
    id: "npm-installed",
    match: (spec) => String(spec).startsWith("npm:"),
    async resolve(projectRoot, spec) {
      const parsed = parseNpmSpec(spec);
      const installed = await installedPackage(projectRoot, parsed.name);
      if (installed.pkg.version !== parsed.version) {
        throw new Error(`npm ${parsed.name}: pinned ${parsed.version}, installed ${installed.pkg.version}`);
      }
      // npm package metadata is data, not executable Node code.
      const configuredEntry = parsed.entry || installed.pkg.essemble?.entry || installed.pkg.main || "index.jsx";
      if (typeof configuredEntry !== "string" || !configuredEntry.trim() || configuredEntry.includes("\\") ||
        path.isAbsolute(configuredEntry) || path.posix.normalize(configuredEntry).startsWith("../")) {
        throw new Error(`Invalid npm ExtendScript entry: ${configuredEntry}`);
      }
      const target = path.resolve(installed.directory, configuredEntry);
      if (!within(installed.directory, target) || !within(installed.directory, await fs.realpath(target))) {
        throw new Error(`npm source entry escapes installed package: ${configuredEntry}`);
      }
      const source = await localFileProvider.resolve(projectRoot, target);
      const dependencies = installed.pkg.essemble?.dependencies || [];
      if (!Array.isArray(dependencies) ||
        dependencies.some((dependency) => typeof dependency !== "string" || !dependency.trim())) {
        throw new Error(`Invalid essemble.dependencies for npm package ${parsed.name}`);
      }
      const requirements = dependencies.map((dependency) => {
        const relative = dependency.startsWith("file:") ? dependency.slice(5) : dependency;
        if (!/^(?:\.\.?[\\/])/.test(relative)) return dependency;
        const resolved = path.resolve(installed.directory, relative);
        if (!within(installed.root, resolved)) throw new Error(`npm dependency escapes consumer project: ${dependency}`);
        return resolved;
      });
      return {
        ...source,
        requirements,
        metadataDependencies: [{
          path: path.relative(installed.root, installed.metadataFile).replace(/\\/g, "/"),
          bytes: installed.metadata.length, sha256: checksum(installed.metadata)
        }],
        origin: {
          type: "npm", name: parsed.name, version: parsed.version,
          entry: path.relative(installed.directory, target).replace(/\\/g, "/")
        }
      };
    }
  });
}