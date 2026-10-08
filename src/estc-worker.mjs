import path from "node:path";
import { pathToFileURL } from "node:url";

// Isolation boundary: ESTC and its own dependencies load in this child
// process. ESsemble never duplicates ESTC's TypeScript->ES3 transformations.
const [estcRoot, projectRoot, configFile, stagedOutput] = process.argv.slice(2);
try {
  const { loadConfig } = await import(pathToFileURL(path.join(estcRoot, "src", "config.mjs")).href);
  const { buildProject } = await import(pathToFileURL(path.join(estcRoot, "src", "build.mjs")).href);
  const config = await loadConfig({ cwd: projectRoot, configPath: configFile });
  // Force ESTC's final JSX to a staging file. We publish only on success.
  config.outfile = stagedOutput;
  const result = await buildProject(config);
  process.stdout.write(JSON.stringify({ ...result, outfile: stagedOutput }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    diagnostics: error?.diagnostics || null
  }) + "\n");
  process.exitCode = 1;
}