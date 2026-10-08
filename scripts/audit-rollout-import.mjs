import fs from "node:fs/promises";
import path from "node:path";
import { loadCatalog, rootDir } from "../src/catalog.mjs";

const graphPath = path.resolve(
  rootDir,
  "..",
  "agent-skills",
  "es-ecosystem-rollout",
  "references",
  "dependency-graph.json"
);

try {
  await fs.access(graphPath);
} catch {
  console.error(`rollout graph not found: ${graphPath}`);
  console.error("This audit is workspace-only; the portable ESsemble resolver does not depend on /scripts.");
  process.exit(2);
}

const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
const catalog = await loadCatalog();
const byId = new Map(catalog.components.map((component) => [component.id, component]));

const graphToEssemble = new Map([
  ["extendscript-toolchain", "estc"],
  ["esabi", "esabi"],
  ["esb64", "esb64"],
  ["espack", "espack"],
  ["esarr", "esarr"],
  ["eschars", "eschars"],
  ["eson", "eson"],
  ["esstr", "esstr"],
  ["eshttp", "eshttp"],
  ["esrand", "esrand"],
  ["esuuid", "esuuid"],
  ["estimer", "estimer"],
  ["esdb", "esdb"],
  ["esmin", "esmin"],
  ["esobf", "esobf"],
  ["esenv", "esenv"],
  ["espath", "espath"],
  ["esfs", "esfs"],
  ["eshash", "eshash"],
  ["eslog", "eslog"],
  ["vector-ipc", "vector-ipc"],
  ["comtool", "comtool"]
]);

const kindToScope = new Map([
  ["build-toolchain", "build"],
  ["native-abi", "native"],
  ["vendored-artifact", "compose"],
  ["composed-bundle", "compose"],
  ["optional-runtime", "optionalRuntime"],
  ["release-test-only", "validation"],
  ["benchmark-only", "benchmark"],
  ["prototype-only", "prototype"],
  ["integration-vendor", "integration"]
]);

const expected = new Set();
for (const edge of [...graph.edges, ...(graph.externalEdges || [])]) {
  const upstream = graphToEssemble.get(edge.from);
  const downstream = graphToEssemble.get(edge.to);
  const scope = kindToScope.get(edge.kind);
  if (!upstream || !downstream || !scope) continue;
  expected.add(`${downstream}|${scope}|${upstream}`);
}

for (const [providerName, provider] of Object.entries(graph.validationProviders || {})) {
  const providerId = graphToEssemble.get(providerName);
  const viaId = graphToEssemble.get(provider.via);
  if (!providerId || !viaId) continue;
  expected.add(`${viaId}|validation|${providerId}`);
}

// ESsemble is a consumer-resolution model, not a flat projection of the
// rollout graph. Some host-time relationships are meaningful to callers even
// though they do not propagate releases. Keep these deliberate resolver-only
// edges explicit so the audit still rejects accidental catalog drift.
const resolverOnly = new Set([
  "esuuid|optionalRuntime|esrand"
]);

const actual = new Set();
for (const component of catalog.components) {
  for (const [scope, dependencies] of Object.entries(component.dependencies)) {
    if (scope === "runtime") continue;
    for (const dependency of dependencies) {
      actual.add(`${component.id}|${scope}|${dependency}`);
    }
  }
}

const missing = [...expected].filter((key) => !actual.has(key)).sort();
const unsupported = [...actual].filter((key) => !expected.has(key) && !resolverOnly.has(key)).sort();

for (const key of resolverOnly) {
  if (!actual.has(key)) {
    console.error("ESsemble rollout-import audit failed.");
    console.error(`- missing intentional resolver-only edge: ${key}`);
    process.exit(1);
  }
}

if (missing.length || unsupported.length) {
  console.error("ESsemble rollout-import audit failed.");
  for (const key of missing) console.error(`- missing imported edge: ${key}`);
  for (const key of unsupported) console.error(`- catalog edge lacks rollout evidence: ${key}`);
  process.exitCode = 1;
} else {
  console.log(
    `ESsemble rollout-import audit passed: ${expected.size} rollout relationships + ` +
    `${resolverOnly.size} intentional resolver-only relationship(s)`
  );
}