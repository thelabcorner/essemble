import fs from "node:fs/promises";
import path from "node:path";

export function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A consumer artifact may not traverse above the project, including through
 * an existing symlink/junction at any level of the destination path. */
export async function resolveProjectPath(root, requested, label = "artifact") {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error(`${label}: path must be a nonempty string`);
  }
  const base = path.resolve(root);
  const candidate = path.resolve(base, requested);
  if (!isWithinRoot(base, candidate) || candidate === base) {
    throw new Error(`${label}: path escapes the consumer project: ${requested}`);
  }
  const canonicalRoot = await fs.realpath(base);
  let ancestor = candidate;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!isWithinRoot(canonicalRoot, real) && real !== canonicalRoot) {
        throw new Error(`${label}: symlink escapes the consumer project: ${requested}`);
      }
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

/** Normalize an existing ancestor's aliases even if the output does not exist. */
export async function canonicalProjectDestination(root, requested, label = "artifact") {
  const candidate = await resolveProjectPath(root, requested, label);
  let ancestor = candidate;
  while (true) {
    try {
      return path.resolve(await fs.realpath(ancestor), path.relative(ancestor, candidate));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

export async function resolveExternalSourcePath(root, source, options = {}) {
  try {
    return await resolveProjectPath(root, source.path, "receipt source");
  } catch (error) {
    if (!options.allowExternalSources || !path.isAbsolute(source.path) ||
        (!path.isAbsolute(source.spec || "") && source.spec !== source.path)) throw error;
    return path.resolve(source.path);
  }
}