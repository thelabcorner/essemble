import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function loadCatalog(root = rootDir) {
  return readJson(path.join(root, "registry", "catalog.json"));
}

export async function loadLock(root = rootDir) {
  return readJson(path.join(root, "essemble.lock.json"));
}

export async function loadProfiles(root = rootDir) {
  const dir = path.join(root, "profiles");
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const profiles = [];
  for (const name of names) {
    profiles.push(await readJson(path.join(dir, name)));
  }
  return profiles;
}

export function indexCatalog(catalog) {
  const byId = new Map();
  const aliases = new Map();

  for (const component of catalog.components) {
    byId.set(component.id, component);
    aliases.set(component.id, component.id);
    for (const alias of component.aliases || []) {
      aliases.set(alias, component.id);
    }
  }

  return { byId, aliases };
}

export function normalizeComponentId(catalog, value) {
  const { aliases } = indexCatalog(catalog);
  const id = aliases.get(String(value).toLowerCase());
  if (!id) {
    throw new Error(`Unknown ESsemble component: ${value}`);
  }
  return id;
}
