import path from "node:path";
import { buildComposition } from "./composer.mjs";
import { resolveProjectPath, canonicalProjectDestination } from "./paths.mjs";

/** Detect cross-entry clobbering before starting any expensive compilers. */
export async function validateEntryOutputs(projectRoot, project, names) {
  const owners = new Map();
  for (const name of names) {
    const entry = project.entries[name];
    if (!entry) throw new Error(`Unknown project entry: ${name}`);
    const paths = [
      ["bundle", entry.out], ["manifest", entry.manifestOut], ["receipt", entry.receipt],
      ...(entry.compiler ? [["compiled", entry.compiler.out]] : [])
    ];
    for (const [role, pathname] of paths) {
      const absolute = await canonicalProjectDestination(projectRoot, pathname, `${name} ${role}`);
      const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
      const previous = owners.get(key);
      if (previous) throw new Error(`Project artifact collision: ${previous} and ${name}.${role} both use ${pathname}`);
      owners.set(key, `${name}.${role}`);
    }
  }
  return owners.size;
}

/** Orchestrate compiler and linker without reimplementing either engine. */
export async function buildProjectEntry(toolRoot, projectRoot, catalog, lock, entryName, entry, options = {}) {
  const registry = options.toolRegistry;
  const output = await resolveProjectPath(projectRoot, options.out || entry.out, "entry output");
  const manifestOut = await resolveProjectPath(projectRoot, options.manifestOut || entry.manifestOut, "entry manifest");
  const receiptOut = await resolveProjectPath(projectRoot, options.receiptOut || entry.receipt, "entry receipt");
  const requested = [...entry.use];
  let compiler = null;
  if (entry.compiler) {
    if (!options.allowCompileConfig) {
      throw new Error(`Entry ${entryName} has an executable ESTC configuration; pass --allow-plugins for a trusted project`);
    }
    if (!registry?.invoke || !registry?.providerId) throw new Error("Entry compiler requires a tool registry");
    const compiledPath = await resolveProjectPath(projectRoot, entry.compiler.out, "compiled source");
    if ([output, manifestOut, receiptOut].includes(compiledPath)) {
      throw new Error(`Compiler output for entry ${entryName} conflicts with its distribution outputs`);
    }
    const produced = await registry.invoke("compile", {
      toolRoot, projectRoot,
      options: { config: entry.compiler.config, out: entry.compiler.out }
    });
    if (path.resolve(produced.outfile) !== compiledPath) {
      throw new Error(`Compiler provider produced unexpected output: ${produced.outfile}`);
    }
    const relative = path.relative(projectRoot, compiledPath).replace(/\\/g, "/");
    requested.push(`./${relative}`);
    compiler = {
      provider: registry.providerId("compile"),
      config: produced.config,
      inputs: produced.inputs || [],
      output: { path: relative, bytes: produced.bytes, sha256: produced.sha256 }
    };
  }
  if (!requested.length) throw new Error(`Project entry ${entryName} has neither sources nor a compiler`);
  return buildComposition(toolRoot, catalog, lock, requested, {
    ...options, projectRoot,
    out: output, manifestOut, receiptOut,
    compiler,
    name: options.name || entryName
  });
}