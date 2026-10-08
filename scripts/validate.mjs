import fs from "node:fs/promises";
import path from "node:path";
import { loadCatalog, loadLock, loadProfiles, rootDir } from "../src/catalog.mjs";

const errors = [];
const catalog = await loadCatalog();
const lock = await loadLock();
const profiles = await loadProfiles();

if (![1, 2].includes(lock.schemaVersion)) {
  errors.push(`unsupported lock schemaVersion: ${lock.schemaVersion}`);
}

const scopes = new Set(catalog.dependencyScopes);
const ids = new Set();
const names = new Map();

function claimName(name, owner) {
  const key = name.toLowerCase();
  if (names.has(key)) {
    errors.push(`duplicate id/alias "${name}" on ${owner}; already owned by ${names.get(key)}`);
  } else {
    names.set(key, owner);
  }
}

for (const component of catalog.components) {
  if (ids.has(component.id)) errors.push(`duplicate component id: ${component.id}`);
  ids.add(component.id);
  claimName(component.id, component.id);
  for (const alias of component.aliases || []) claimName(alias, component.id);
}

for (const component of catalog.components) {
  for (const [scope, dependencies] of Object.entries(component.dependencies)) {
    if (!scopes.has(scope)) errors.push(`${component.id}: unknown dependency scope ${scope}`);
    if (!Array.isArray(dependencies)) {
      errors.push(`${component.id}: dependency scope ${scope} must be an array`);
      continue;
    }
    for (const dependency of dependencies) {
      const target = names.get(String(dependency).toLowerCase());
      if (!target) errors.push(`${component.id}: ${scope} references unknown component ${dependency}`);
    }
  }

  const locked = lock.components[component.id];
  if (!locked) errors.push(`${component.id}: missing lock entry`);
  if (component.source.type === "git" && locked?.sourceType !== "git") {
    errors.push(`${component.id}: catalog source is git but lock source is ${locked?.sourceType}`);
  }
  if (component.source.type === "workspace" && locked?.sourceType !== "workspace") {
    errors.push(`${component.id}: catalog source is workspace but lock source is ${locked?.sourceType}`);
  }
  if (locked?.release) {
    if (locked.sourceType !== "git") errors.push(`${component.id}: release artifacts require git source`);
    if (!/^\d+\.\d+\.\d+$/.test(String(locked.release.version || ""))) {
      errors.push(`${component.id}: release.version must be stable SemVer`);
    }
    if (!/^[0-9a-f]{40}$/.test(String(locked.release.tagCommit || ""))) {
      errors.push(`${component.id}: release.tagCommit must be a 40-hex commit`);
    }
    if (!Array.isArray(locked.release.manifests) || !locked.release.manifests.length) {
      errors.push(`${component.id}: release.manifests must be non-empty`);
    } else {
      for (const manifest of locked.release.manifests) {
        if (!/^[0-9a-f]{64}$/.test(String(manifest.sha256 || ""))) {
          errors.push(`${component.id}: invalid release manifest sha256 for ${manifest.name || "(unnamed)"}`);
        }
        if (manifest.manifestVersion !== 2) {
          errors.push(`${component.id}: locked composition manifest must be version 2`);
        }
        if (manifest.composer?.name !== "espack") {
          errors.push(`${component.id}: locked composition manifest composer must be espack`);
        }
        if (!Array.isArray(manifest.entries) || !manifest.entries.some((entry) => entry.id === component.id)) {
          errors.push(`${component.id}: locked composition manifest must expose ${component.id} as an entry root`);
        }
      }
    }
  }
}

for (const id of Object.keys(lock.components)) {
  if (!ids.has(id)) errors.push(`lock contains unknown component: ${id}`);
}

const profileNames = new Set();
for (const profile of profiles) {
  if (profileNames.has(profile.name)) errors.push(`duplicate profile: ${profile.name}`);
  profileNames.add(profile.name);

  for (const id of profile.selection) {
    if (!ids.has(id)) errors.push(`profile ${profile.name}: unknown component ${id}`);
  }
  for (const scope of profile.scopes) {
    if (!scopes.has(scope)) errors.push(`profile ${profile.name}: unknown scope ${scope}`);
  }
}

const gitmodules = await fs.readFile(path.join(rootDir, ".gitmodules"), "utf8");
for (const component of catalog.components.filter((item) => item.source.type === "git")) {
  if (!gitmodules.includes(`path = ${component.source.path}`)) {
    errors.push(`${component.id}: .gitmodules missing path ${component.source.path}`);
  }
  if (!gitmodules.includes(`url = ${component.source.url}`)) {
    errors.push(`${component.id}: .gitmodules missing URL ${component.source.url}`);
  }
}

if (errors.length) {
  console.error("ESsemble validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`ESsemble validation passed: ${catalog.components.length} components, ${profiles.length} profiles, ${catalog.dependencyScopes.length} dependency scopes`);
}
