import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createSourceRegistry, localFileProvider, gitSourceProvider, npmSourceProvider } from "./sources.mjs";
import { createToolRegistry, builtInTools } from "./tooling.mjs";

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Loading plugin modules executes Node.js code with the caller's privileges.
 * Never activate project plugins unless trust has been granted explicitly.
 */
export async function loadProjectExtensions(projectRoot, project, options = {}) {
  const requested = project?.plugins || [];
  if (requested.length && !options.allowPlugins) {
    throw new Error("Project declares executable ESsemble plugins. Pass --allow-plugins only for trusted projects.");
  }
  const providers = [];
  const tools = [];
  const pluginFiles = [];
  const root = await fs.realpath(projectRoot);
  for (const spec of requested) {
    if (typeof spec !== "string" || !spec.startsWith("./") || !spec.endsWith(".mjs")) {
      throw new Error(`Plugin must be a relative .mjs file: ${spec}`);
    }
    const file = await fs.realpath(path.resolve(root, spec));
    if (!within(root, file)) throw new Error(`Plugin escapes project directory: ${spec}`);
    const bytes = await fs.readFile(file);
    pluginFiles.push({
      path: path.relative(root, file).replace(/\\/g, "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    const module = await import(pathToFileURL(file).href);
    const extension = module.default;
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      throw new Error(`${spec}: default export must be a plugin object`);
    }
    if (extension.sourceProviders && !Array.isArray(extension.sourceProviders)) {
      throw new Error(`${spec}: sourceProviders must be an array`);
    }
    if (extension.tools && !Array.isArray(extension.tools)) {
      throw new Error(`${spec}: tools must be an array`);
    }
    providers.push(...(extension.sourceProviders || []));
    tools.push(...(extension.tools || []));
  }
  return {
    pluginFiles,
    sourceRegistry: createSourceRegistry([...providers, localFileProvider, gitSourceProvider, npmSourceProvider]),
    toolRegistry: createToolRegistry([...builtInTools, ...tools], { providers: project?.toolProviders })
  };
}