import { loadCatalog, loadLock, loadProfiles, normalizeComponentId, rootDir } from "./catalog.mjs";
import { resolveSelection } from "./resolver.mjs";
import { inspectSources } from "./doctor.mjs";
import { lockReleaseManifests, writeLock } from "./artifacts.mjs";
import { buildComposition, verifyReceipt } from "./composer.mjs";
import { normalizeTarget } from "./target.mjs";
import { parseComponentSpec } from "./artifacts.mjs";
import {
  createProject,
  loadProject,
  projectSpecs,
  updateProjectSelection
} from "./project.mjs";
import path from "node:path";
import { isSourceSpec, expandScriptFile, composeSourceText, resolveBuildInputs } from "./sources.mjs";
import fs from "node:fs/promises";
import { discoverTools } from "./tooling.mjs";
import { loadProjectExtensions } from "./extensions.mjs";
import { buildProjectEntry, validateEntryOutputs } from "./pipeline.mjs";

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}

function csv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function has(args, name) {
  return args.includes(name);
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function positionalValues(args, start = 1, valueFlags = []) {
  const needsValue = new Set(valueFlags);
  const out = [];
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (needsValue.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

function printHelp() {
  console.log(`ESsemble

Usage:
  essemble init
  essemble add <component[@version]|./script.jsx|./library/>... [--entry NAME]
  essemble remove <component>... [--entry NAME]
  essemble list [--json]
  essemble profiles [--json]
  essemble tools [--json]
  essemble check [FILE] [--entry NAME] [--json]
  essemble compile [--config extendscript.config.mjs] [--out dist/estc.jsx] [--timeout-ms MS] [--json]
  essemble run [FILE] [--entry NAME] [--timeout-ms MS] [--target ID] [--host illustrator] [--effects CLASS] [--json]
  essemble resolve [--entry NAME] [--profile NAME] [--use a,b,c] [--scopes runtime,build,...] [--json]
  essemble lock [--use a,b,c] [--entry NAME] [--json]
  essemble build [--entry NAME] [--use a,b,c] [--target illustrator-win-x64] [--native prefer|portable|require] [--out FILE] [--manifest-out FILE] [--receipt FILE] [--name NAME] [--json]
  essemble verify [RECEIPT] [--rebuild] [--allow-external-sources] [--json]
  essemble live [RECEIPT] [--launch] [--timeout-ms MS] [--target ID] [--evidence FILE] [--allow-external-sources] [--json]
  essemble doctor [--profile NAME] [--use a,b,c] [--scopes runtime,build,...] [--all] [--json]

Dependency scopes:
  runtime, build, compose, native, optionalRuntime, validation,
  benchmark, prototype, integration

Project commands run in the current directory by default; use --project-dir PATH to override.
Projects with executable plugins require the explicit --allow-plugins trust flag.
`);
}

function resolveRequest(catalog, profiles, args, defaultScopes = ["runtime"], extraRequested = []) {
  const profileName = flagValue(args, "--profile") || "minimal";
  const profile = profiles.find((item) => item.name === profileName);
  if (!profile) throw new Error(`Unknown ESsemble profile: ${profileName}`);
  const allRequested = [...profile.selection, ...extraRequested, ...csv(flagValue(args, "--use"))];
  const requested = allRequested.filter((spec) => !isSourceSpec(spec));
  const sourceSpecs = allRequested.filter(isSourceSpec);
  const scopeOverride = csv(flagValue(args, "--scopes"));
  const scopes = scopeOverride.length ? scopeOverride : (profile.scopes.length ? profile.scopes : defaultScopes);
  const requestedIds = requested.map((spec) => parseComponentSpec(spec).name);
  return {
    profileName, requested, sourceSpecs, scopes,
    result: resolveSelection(catalog, requestedIds, scopes)
  };
}

export async function main(args) {
  const command = args[0] || "help";
  const projectRoot = path.resolve(flagValue(args, "--project-dir") || process.cwd());
  const catalog = await loadCatalog();
  const projectLock = async () => {
    if (projectRoot === rootDir) return loadLock(rootDir);
    try { return await loadLock(projectRoot); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return loadLock(rootDir);
    }
  };
  const extensions = async () => loadProjectExtensions(projectRoot, await loadProject(projectRoot), {
    allowPlugins: has(args, "--allow-plugins")
  });

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const file = await createProject(projectRoot, { force: has(args, "--force") });
    console.log(`created ${file}`);
    return;
  }

  if (command === "add" || command === "remove") {
    const values = positionalValues(args, 1, ["--entry", "--project-dir"]);
    if (!values.length) throw new Error(`${command} requires at least one component`);
    const result = await updateProjectSelection(projectRoot, catalog, command, values, {
      entry: flagValue(args, "--entry") || "runtime"
    });
    console.log(`${result.entry}: ${result.use.join(", ") || "(empty)"}`);
    return;
  }

  if (command === "list") {
    const rows = catalog.components
      .map(({ id, displayName, kind, status, capabilities }) => ({
        id, displayName, kind, status, capabilities
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (has(args, "--json")) {
      printJson(rows);
      return;
    }

    for (const row of rows) {
      console.log(`${row.id.padEnd(12)} ${row.status.padEnd(7)} ${row.kind.padEnd(20)} ${row.capabilities.join(", ")}`);
    }
    return;
  }

  if (command === "tools") {
    const rows = await discoverTools(rootDir, (await extensions()).toolRegistry);
    if (has(args, "--json")) printJson(rows);
    else for (const row of rows) {
      const warning = row.readiness?.compile === false
        ? ` (compile unavailable: ${row.missingDependencies.join(", ")})` : "";
      console.log(`${row.id.padEnd(12)} ${row.available ? "installed" : "not-installed"}  ${row.capabilities.join(", ")}${warning}`);
    }
    return;
  }

  if (command === "check") {
    const files = positionalValues(args, 1, ["--entry", "--project-dir"]);
    if (!files.length) {
      const project = await loadProject(projectRoot, { required: true });
      const selected = flagValue(args, "--entry");
      for (const name of selected ? [selected] : Object.keys(project.entries).sort()) {
        if (!project.entries[name]) throw new Error(`Unknown project entry: ${name}`);
        files.push(project.entries[name].out);
      }
    }
    const registry = (await extensions()).toolRegistry;
    const reports = [];
    for (const file of files) {
      const absolute = path.resolve(projectRoot, file);
      const expanded = await expandScriptFile(absolute, projectRoot);
      const source = composeSourceText("", [{ kind: "script", text: expanded.text, sha256: "source-check" }]);
      const checked = await registry.invoke("check", { toolRoot: rootDir, text: source, file: path.basename(absolute) });
      reports.push({ file, ok: checked.ok, diagnostics: checked.diagnostics });
    }
    if (has(args, "--json")) printJson(reports);
    else for (const report of reports) console.log(`${report.ok ? "PASS" : "FAIL"} ${report.file}: ${report.diagnostics.filter((d) => d.severity === "error").length} error(s)`);
    if (reports.some((report) => !report.ok)) process.exitCode = 1;
    return;
  }

  if (command === "compile") {
    const { toolRegistry } = await extensions();
    const compiled = await toolRegistry.invoke("compile", {
      toolRoot: rootDir, projectRoot,
      options: {
        config: flagValue(args, "--config") || "extendscript.config.mjs",
        out: flagValue(args, "--out") || "dist/estc.jsx",
        timeoutMs: flagValue(args, "--timeout-ms") || 120000
      }
    });
    if (has(args, "--json")) printJson(compiled);
    else console.log(`ESTC compiled ${compiled.outfile} (${compiled.bytes} bytes) sha256:${compiled.sha256}`);
    return;
  }

  if (command === "run") {
    const files = positionalValues(args, 1, ["--entry", "--project-dir", "--timeout-ms", "--target", "--host", "--effects"]);
    if (files.length > 1) throw new Error("run accepts exactly one JSX bundle");
    if (!files.length) {
      const project = await loadProject(projectRoot, { required: true });
      const names = Object.keys(project.entries);
      const chosen = flagValue(args, "--entry") || (names.includes("runtime") ? "runtime" : names.length === 1 ? names[0] : null);
      if (!chosen || !project.entries[chosen]) throw new Error("Choose an existing project entry with --entry");
      files.push(project.entries[chosen].out);
    }
    const script = path.resolve(projectRoot, files[0]);
    await fs.access(script);
    const result = await (await extensions()).toolRegistry.invoke("run", {
      toolRoot: rootDir, script,
      options: {
        timeoutMs: flagValue(args, "--timeout-ms"),
        target: flagValue(args, "--target"),
        host: flagValue(args, "--host") || "illustrator",
        effects: flagValue(args, "--effects") || "unknown"
      }
    });
    if (has(args, "--json")) printJson(result);
    else {
      console.log(`COMTool: ${result.classification} (exit ${result.exitCode})`);
      if (result.exitCode === 0) console.log(JSON.stringify(result.value ?? null));
      if (result.ambiguous) console.error("COMTool outcome is ambiguous; no automatic retry was performed.");
    }
    process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 3;
    return;
  }

  if (command === "profiles") {
    const profiles = await loadProfiles();
    if (has(args, "--json")) {
      printJson(profiles);
      return;
    }
    for (const profile of profiles) {
      console.log(`${profile.name.padEnd(10)} ${String(profile.selection.length).padStart(2)} components  scopes=${profile.scopes.join(",")}`);
    }
    return;
  }

  if (command === "resolve") {
    const profiles = await loadProfiles();
    const selectedEntry = flagValue(args, "--entry");
    const project = selectedEntry ? await loadProject(projectRoot, { required: true }) : null;
    if (selectedEntry && !project.entries[selectedEntry]) throw new Error(`Unknown project entry: ${selectedEntry}`);
    const { profileName, result: directPlan, sourceSpecs } = resolveRequest(
      catalog, profiles, args, ["runtime"], project ? project.entries[selectedEntry].use : []
    );
    const sourceRegistry = sourceSpecs.length ? (await extensions()).sourceRegistry : null;
    const external = sourceSpecs.length
      ? await resolveBuildInputs(projectRoot, catalog, sourceSpecs, sourceRegistry)
      : { sources: [], components: [] };
    const sourceRequirements = external.components.map(({ id, version }) =>
      version ? `${id}@${version}` : id);
    // A package may bring ES* components as transitive requirements. Include
    // them in the same typed dependency plan shown to the developer.
    const result = sourceRequirements.length
      ? resolveSelection(catalog, [
          ...directPlan.requested,
          ...external.components.map((component) => component.id)
        ], directPlan.scopes)
      : directPlan;
    const sources = external.sources.map(
        ({ text, file, ...metadata }) => metadata
      );

    if (has(args, "--json")) {
      printJson({ profile: profileName, ...result, sourceRequirements, sources });
      return;
    }

    console.log(`profile:    ${profileName}`);
    console.log(`requested:  ${result.requested.join(", ") || "(none)"}`);
    if (sourceRequirements.length) console.log(`from packages: ${sourceRequirements.join(", ")}`);
    console.log(`scopes:     ${result.scopes.join(", ")}`);
    console.log(`components: ${result.components.join(", ") || "(none)"}`);
    for (const source of sources) console.log(`source:     ${source.provider} ${source.path} sha256:${source.sha256}`);
    console.log("order:");
    result.groups.forEach((group, index) => {
      const marker = group.length > 1 ? " [cycle]" : "";
      console.log(`  ${String(index + 1).padStart(2)}. ${group.join(" + ")}${marker}`);
    });
    return;
  }

  if (command === "lock") {
    let requested = csv(flagValue(args, "--use"));
    if (!requested.length) {
      const project = await loadProject(projectRoot, { required: true });
      const entryName = flagValue(args, "--entry");
      requested = projectSpecs(project, entryName ? [entryName] : null);
    }
    const sourceSpecs = requested.filter(isSourceSpec);
    requested = requested.filter((value) => !isSourceSpec(value));
    if (sourceSpecs.length) {
      const sourceRegistry = (await extensions()).sourceRegistry;
      const external = await resolveBuildInputs(projectRoot, catalog, sourceSpecs, sourceRegistry);
      requested.push(...external.components.map(({ id, version }) =>
        version ? `${id}@${version}` : id));
      requested = [...new Set(requested)];
    }
    if (!requested.length) {
      console.log("Local sources are content-hashed during build; no release lock required.");
      return;
    }
    const lock = await projectLock();
    const locked = await lockReleaseManifests(rootDir, catalog, lock, requested, { cacheRoot: projectRoot });
    await writeLock(projectRoot, locked.lock);
    if (has(args, "--json")) {
      printJson(locked.rows);
    } else {
      for (const row of locked.rows) {
        console.log(`${row.id}@${row.version} ${row.tag}: ${row.manifests.map((item) => item.name + " sha256:" + item.sha256.slice(0, 12)).join(", ")}`);
      }
      console.log("lockfile updated");
    }
    return;
  }

  if (command === "build") {
    const lock = await projectLock();
    const { sourceRegistry, toolRegistry, pluginFiles } = await extensions();
    const adHoc = csv(flagValue(args, "--use"));
    const builds = [];
    if (adHoc.length) {
      const target = normalizeTarget(flagValue(args, "--target") || "illustrator-win-x64");
      builds.push(await buildComposition(rootDir, catalog, lock, adHoc, {
        projectRoot,
        sourceRegistry,
        toolRegistry,
        pluginFiles,
        target,
        nativePolicy: flagValue(args, "--native") || "prefer",
        out: flagValue(args, "--out"),
        manifestOut: flagValue(args, "--manifest-out"),
        receiptOut: flagValue(args, "--receipt"),
        name: flagValue(args, "--name")
      }));
    } else {
      const project = await loadProject(projectRoot, { required: true });
      const selectedEntry = flagValue(args, "--entry");
      const names = selectedEntry ? [selectedEntry] : Object.keys(project.entries).sort();
      // When multiple entries build together, prevent an earlier valid entry
      // from being overwritten by a later entry's bundle/manifest/receipt.
      if (!flagValue(args, "--out") && !flagValue(args, "--manifest-out") && !flagValue(args, "--receipt")) {
        await validateEntryOutputs(projectRoot, project, names);
      } else if (names.length > 1) {
        throw new Error("Custom output overrides require selecting one entry with --entry");
      }
      for (const entryName of names) {
        const entry = project.entries[entryName];
        if (!entry) throw new Error(`Unknown project entry: ${entryName}`);
        if (!entry.use.length && !entry.compiler) continue;
        builds.push(await buildProjectEntry(rootDir, projectRoot, catalog, lock, entryName, entry, {
          projectRoot,
          sourceRegistry,
          toolRegistry,
          pluginFiles,
          allowCompileConfig: has(args, "--allow-plugins"),
          target: flagValue(args, "--target") || entry.target,
          nativePolicy: flagValue(args, "--native") || entry.native,
          out: flagValue(args, "--out") || entry.out,
          manifestOut: flagValue(args, "--manifest-out") || entry.manifestOut,
          receiptOut: flagValue(args, "--receipt") || entry.receipt,
          name: flagValue(args, "--name") || entryName
        }));
      }
      if (!builds.length) throw new Error("project has no non-empty entries to build");
    }
    if (has(args, "--json")) {
      printJson(builds.length === 1 ? builds[0].receipt : builds.map((item) => item.receipt));
    } else {
      for (const built of builds) {
        console.log(`target:   ${built.receipt.target.key}`);
        console.log(`bundle:   ${built.receipt.outputs.bundle.path} (${built.receipt.outputs.bundle.bytes} B) sha256:${built.receipt.outputs.bundle.sha256}`);
        console.log(`manifest: ${built.receipt.outputs.manifest.path} sha256:${built.receipt.outputs.manifest.sha256}`);
        console.log(`receipt:  ${built.receiptPath}`);
        console.log(`libraries: ${built.receipt.resolved.libraries.map((item) => item.id + "@" + item.version).join(" -> ")}`);
      }
    }
    return;
  }

  if (command === "verify") {
    const receipt = args[1] && !args[1].startsWith("--") ? args[1] : "dist/essemble.receipt.json";
    const rebuild = has(args, "--rebuild");
    const toolRegistry = rebuild ? (await extensions()).toolRegistry : undefined;
    const verified = await verifyReceipt(projectRoot, receipt, {
      rebuild, toolRoot: rootDir, toolRegistry,
      allowExternalSources: has(args, "--allow-external-sources")
    });
    if (has(args, "--json")) {
      printJson(verified);
    } else {
      for (const check of verified.checks) {
        console.log(`ok ${check.kind.padEnd(14)} ${check.component ? check.component + " " : ""}${check.path} sha256:${check.sha256}`);
      }
      console.log("receipt verification: PASS");
    }
    return;
  }

  if (command === "live") {
    const receipt = args[1] && !args[1].startsWith("--") ? args[1] : "dist/essemble.receipt.json";
    const evidence = await (await extensions()).toolRegistry.invoke("live", {
      projectRoot, toolRoot: rootDir, receipt,
      options: {
        launch: has(args, "--launch"),
        timeoutMs: flagValue(args, "--timeout-ms"),
        target: flagValue(args, "--target"),
        evidenceOut: flagValue(args, "--evidence"),
        allowExternalSources: has(args, "--allow-external-sources")
      }
    });
    if (has(args, "--json")) {
      printJson(evidence);
    } else {
      console.log("live receipt verification: PASS");
      console.log(`host: ${evidence.host.appVersion} / ExtendScript ${evidence.host.engineVersion}`);
      console.log(`transport: ${evidence.host.transport}`);
      console.log(`libraries: ${evidence.libraries.map((item) => item.id + "@" + item.version).join(" -> ")}`);
    }
    return;
  }

  if (command === "doctor") {
    const lock = await loadLock();
    let componentIds = null;
    if (!has(args, "--all") && (flagValue(args, "--profile") || flagValue(args, "--use"))) {
      const profiles = await loadProfiles();
      const request = resolveRequest(catalog, profiles, args);
      componentIds = request.result.components;
    } else if (!has(args, "--all")) {
      const project = await loadProject(projectRoot);
      if (project) {
        const ids = projectSpecs(project).filter((value) => !isSourceSpec(value)).map((value) => {
          const spec = parseComponentSpec(value);
          return normalizeComponentId(catalog, spec.name);
        });
        componentIds = resolveSelection(catalog, ids, ["runtime", "compose"]).components;
      }
    }
    const result = inspectSources(rootDir, catalog, lock, componentIds);

    if (has(args, "--json")) {
      printJson(result);
    } else {
      for (const row of result.rows) {
        console.log(`${row.id.padEnd(12)} ${row.status}`);
      }
      console.log(result.ok ? "source state: clean + locked" : `source state: ${result.blocking.length} blocking issue(s)`);
    }

    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown ESsemble command: ${command}`);
}
