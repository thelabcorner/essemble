import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rootDir, loadCatalog } from "../src/catalog.mjs";
import { resolveBuildInputs } from "../src/sources.mjs";

function median(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-git-bench-"));
try {
  const repo = path.join(root, "upstream");
  const consumer = path.join(root, "consumer");
  await fs.mkdir(repo);
  await fs.mkdir(consumer);
  const git = (...args) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git("init", "--quiet");
  await fs.mkdir(path.join(repo, "inc"));
  const count = 32;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const name = `inc/vector-${String(i).padStart(2, "0")}.jsxinc`;
    await fs.writeFile(path.join(repo, name), `var SHAPE_${i} = ${i};\n`);
    parts.push(`#include "${name}"`);
  }
  await fs.writeFile(path.join(repo, "main.jsx"), parts.join("\n") + "\n");
  git("add", ".");
  git("-c", "user.email=benchmark@example.invalid", "-c", "user.name=Benchmark",
    "commit", "--quiet", "-m", "synthetic source graph");
  const revision = git("rev-parse", "HEAD");
  const spec = `git+${pathToFileURL(repo).href}@${revision}#main.jsx`;
  const catalog = await loadCatalog();

  const measure = async () => {
    const start = performance.now();
    const result = await resolveBuildInputs(consumer, catalog, [spec]);
    if (result.sources[0].dependencies.length !== count) {
      throw new Error("Benchmark source graph failed include validation");
    }
    return { ms: performance.now() - start, sha256: result.sources[0].sha256 };
  };
  const cold = await measure();
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(await measure());
  if (warm.some((result) => result.sha256 !== cold.sha256)) {
    throw new Error("Benchmark changed resolved source identity");
  }
  const warmMedian = median(warm.map((run) => run.ms));
  console.log(JSON.stringify({
    fixture: "local Git repository, 32 tracked includes, single pinned commit",
    coldMs: Number(cold.ms.toFixed(2)),
    warmMedianMs: Number(warmMedian.toFixed(2)),
    coldToWarmRatio: Number((cold.ms / warmMedian).toFixed(2)),
    samples: warm.map((run) => Number(run.ms.toFixed(2))),
    note: "Cold includes initial bare clone; ratio is not a comparison to a previous implementation."
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}