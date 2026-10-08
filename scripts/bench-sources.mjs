import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadCatalog } from "../src/catalog.mjs";
import { expandScriptFile, resolveBuildInputs } from "../src/sources.mjs";

// Reproducible, source-only microbenchmark: compare the current resolver with
// the former two-pass model simulated by an additional expansion per source.
const count = Number(process.argv[2] || 120);
const samples = Number(process.argv[3] || 5);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000 ||
    !Number.isSafeInteger(samples) || samples < 1 || samples > 20) {
  throw new Error("Usage: bench-sources.mjs [source-count:1..1000] [samples:1..20]");
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-bench-sources-"));
try {
  const text = "var MAGIC = 42;\n".repeat(250);
  const specs = Array.from({ length: count }, (_, index) => `./s${index}.jsx`);
  for (let index = 0; index < count; index++) {
    await fs.writeFile(path.join(root, specs[index]), text, "utf8");
  }
  const catalog = await loadCatalog();
  const run = async (mode) => {
    const started = performance.now();
    const inputs = await resolveBuildInputs(root, catalog, specs);
    if (inputs.sources.length !== count) throw new Error("Benchmark fixture was incompletely resolved");
    if (mode === "repeat-expansion") {
      for (const source of inputs.sources) await expandScriptFile(source.file, root);
    }
    return performance.now() - started;
  };
  await run("current");
  const readings = { current: [], repeatExpansion: [] };
  for (let index = 0; index < samples; index++) {
    const order = index % 2 ? ["repeat-expansion", "current"] : ["current", "repeat-expansion"];
    for (const mode of order) {
      readings[mode === "current" ? "current" : "repeatExpansion"].push(await run(mode));
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const current = median(readings.current);
  const oldModel = median(readings.repeatExpansion);
  console.log(JSON.stringify({
    fixture: { sourceCount: count, totalBytes: count * Buffer.byteLength(text) },
    currentMedianMs: +current.toFixed(2),
    repeatedExpansionMedianMs: +oldModel.toFixed(2),
    ratio: +(oldModel / current).toFixed(2),
    samples,
    note: "The repeated-expansion case approximates the old duplicate scan; it is not a replay of an old git revision."
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}