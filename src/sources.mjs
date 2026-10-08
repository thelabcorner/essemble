import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseComponentSpec } from "./artifacts.mjs";
import { normalizeComponentId } from "./catalog.mjs";
import { scanDirectives } from "./directives.mjs";
import { parseNpmSpec, createNpmSourceProvider } from "./npm-source.mjs";

const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".jsxinc"]);
const SHA = /^[0-9a-f]{40}$/i;

function isGitSpec(value) {
  return /^(?:github:|git\+(?:https:\/\/|file:\/\/))/.test(String(value));
}

function isLocalSpec(value) {
  const spec = String(value);
  return /^(?:\.\.?[\\/]|[\\/]|file:|[a-zA-Z]:[\\/])/.test(spec) ||
    /\.(?:jsxinc|jsx|js|manifest\.json)$/i.test(spec);
}

export function isSourceSpec(value) {
  const spec = String(value);
  return isGitSpec(spec) || isLocalSpec(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec);
}

export function canonicalSelection(catalog, value) {
  if (isSourceSpec(value)) {
    const raw = String(value).trim();
    if (isGitSpec(raw)) return raw;
    if (!isLocalSpec(raw)) return raw;
    if (raw.startsWith("file:")) {
      if (!raw.startsWith("file:./") && !raw.startsWith("file:../")) {
        throw new Error("file: sources must be project-relative; use an explicit absolute path otherwise");
      }
      return raw.slice(5).replace(/\\/g, "/");
    }
    return raw.replace(/\\/g, "/");
  }
  const spec = parseComponentSpec(value);
  const id = normalizeComponentId(catalog, spec.name);
  return spec.version ? `${id}@${spec.version}` : id;
}

export function selectionKey(catalog, value) {
  const canonical = canonicalSelection(catalog, value);
  if (isGitSpec(canonical)) {
    // A repository's identity is stable across pin updates. The selected
    // commit belongs in the value, not the add/remove matching key.
    return `source:${canonical.replace(/@[0-9a-f]{40}(?=#|$)/i, "")}`;
  }
  if (canonical.startsWith("npm:")) {
    const { name, entry } = parseNpmSpec(canonical, false);
    return `source:npm:${name}${entry === null ? "" : `#${entry}`}`;
  }
  return isSourceSpec(canonical) ? `source:${canonical}` : `component:${parseComponentSpec(canonical).name}`;
}

function withinRoot(root, file) {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function assertPlainCachePath(root, target) {
  const relative = path.relative(root, target);
  if (!withinRoot(root, target) || relative === "") {
    throw new Error(`Git cache path escapes its project: ${target}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Git cache contains a symlink/junction: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function gitBlobDigest(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

/** Expand literal ExtendScript #include directives in-place, preserving duplicates. */
export async function expandScriptFile(entry, projectRoot = path.dirname(entry)) {
  const dependencies = new Map();
  const cachedFiles = new Map();
  const canonicalPaths = new Map();
  const budget = { bytes: 0 };
  const canonicalProject = await fs.realpath(projectRoot);
  const canonicalEntry = await fs.realpath(entry);
  // Explicit external entrypoints can include neighbors, but ordinary project
  // files cannot silently traverse into the user's unrelated filesystem.
  const boundary = withinRoot(canonicalProject, canonicalEntry)
    ? canonicalProject : path.dirname(canonicalEntry);
  async function snapshot(file) {
    let record = cachedFiles.get(file);
    if (!record) {
      const stat = await fs.stat(file);
      if (stat.size > 20 * 1024 * 1024) {
        throw new Error(`ExtendScript source exceeds the 20 MiB safety limit: ${file}`);
      }
      const bytes = await fs.readFile(file);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      record = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        body,
        directives: scanDirectives(body)
      };
      cachedFiles.set(file, record);
    }
    return record;
  }
  async function expand(file, chain) {
    const requestedPath = path.resolve(file);
    let resolved = canonicalPaths.get(requestedPath);
    if (!resolved) {
      resolved = await fs.realpath(requestedPath);
      canonicalPaths.set(requestedPath, resolved);
    }
    if (!withinRoot(boundary, resolved)) {
      throw new Error(`ExtendScript #include escapes the allowed source root: ${file}`);
    }
    if (chain.includes(resolved)) {
      throw new Error(`Cyclic ExtendScript #include: ${[...chain, resolved].join(" -> ")}`);
    }
    if (chain.length >= 64) throw new Error(`ExtendScript #include nesting limit exceeded at ${resolved}`);
    const record = await snapshot(resolved);
    budget.bytes += record.bytes;
    if (budget.bytes > 20 * 1024 * 1024) throw new Error("Expanded ExtendScript sources exceed the 20 MiB safety limit");
    if (chain.length) {
      dependencies.set(resolved, {
        // realpath() can expand Windows 8.3 aliases (e.g. SLOOSH~1) into
        // long paths. Compare canonical paths on both sides, never a mixed pair.
        path: withinRoot(canonicalProject, resolved)
          ? path.relative(canonicalProject, resolved).replace(/\\/g, "/") : resolved,
        bytes: record.bytes,
        sha256: record.sha256
      });
    }
    const body = record.body;
    let result = "";
    let previous = 0;
    for (const directive of record.directives) {
      if (directive.kind === "invalid-include") {
        throw new Error(`Unsupported or unresolved #include in ${resolved}; use a quoted relative filename`);
      }
      if (directive.kind !== "include") continue;
      result += body.slice(previous, directive.start);
      const included = directive.value;
      if (path.isAbsolute(included)) throw new Error(`Absolute #include is not portable: ${included}`);
      const target = path.resolve(path.dirname(resolved), included);
      result += await expand(target, [...chain, resolved]);
      previous = directive.end;
    }
    result += body.slice(previous);
    return result;
  }
  const text = await expand(entry, []);
  return { text, dependencies: [...dependencies.values()] };
}

export function createSourceRegistry(providers = [localFileProvider, gitSourceProvider, npmSourceProvider]) {
  if (!Array.isArray(providers) || !providers.length) throw new Error("Source registry requires providers");
  const identifiers = new Set();
  for (const provider of providers) {
    if (!provider || typeof provider.match !== "function" || typeof provider.resolve !== "function") {
      throw new Error("Source providers require match(spec) and resolve(projectRoot, spec)");
    }
    if (typeof provider.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(provider.id)) {
      throw new Error("Source provider requires a portable lowercase id");
    }
    if (identifiers.has(provider.id)) throw new Error(`Duplicate source provider: ${provider.id}`);
    identifiers.add(provider.id);
  }
  return Object.freeze([...providers]);
}

export const localFileProvider = Object.freeze({
  id: "local-file",
  match: (value) => isLocalSpec(value) && !isGitSpec(value) && !String(value).startsWith("npm:"),
  async resolve(projectRoot, spec) {
    const selected = canonicalSelectionSource(spec);
    const absolute = path.resolve(projectRoot, selected);
    let stat = await fs.stat(absolute);
    let file = absolute;
    let requirements = [];
    let metadataDependencies = [];
    if (stat.isDirectory()) {
      const packageFile = path.join(file, "package.json");
      let entry = "index.jsx";
      try {
        const packageBytes = await fs.readFile(packageFile);
        const pkg = JSON.parse(packageBytes.toString("utf8"));
        entry = pkg.essemble?.entry || pkg.main || entry;
        const declared = pkg.essemble?.dependencies || [];
        if (!Array.isArray(declared) || declared.some((item) => typeof item !== "string" || !item.trim())) {
          throw new Error(`Invalid essemble.dependencies in ${packageFile}: expected an array of non-empty source specs`);
        }
        requirements = declared.map((item) => {
          if (!isLocalSpec(item)) return item;
          const local = path.resolve(absolute, canonicalSelectionSource(item));
          if (!withinRoot(projectRoot, local)) {
            throw new Error(`Library dependency escapes consumer project: ${item}`);
          }
          return local;
        });
        metadataDependencies = [{
          path: withinRoot(projectRoot, packageFile)
            ? path.relative(projectRoot, packageFile).replace(/\\/g, "/") : packageFile,
          bytes: packageBytes.length,
          sha256: createHash("sha256").update(packageBytes).digest("hex")
        }];
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (typeof entry !== "string" || !entry.trim()) throw new Error(`Invalid library entry: ${selected}`);
      file = path.resolve(absolute, entry);
      if (!withinRoot(absolute, file)) throw new Error(`Library entry escapes its directory: ${selected}`);
      const canonicalDirectory = await fs.realpath(absolute);
      const canonicalFile = await fs.realpath(file);
      if (!withinRoot(canonicalDirectory, canonicalFile)) {
        throw new Error(`Library entry symlink escapes its directory: ${selected}`);
      }
      stat = await fs.stat(file);
    }
    if (!stat.isFile()) throw new Error(`Source is not a regular file: ${file}`);
    const kind = file.endsWith(".manifest.json") ? "manifest" : "script";
    if (kind === "script" && !SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      throw new Error(`Unsupported script extension: ${file} (supported: .jsx, .jsxinc, .js)`);
    }
    if (kind === "manifest") {
      // Do not interpret an arbitrary JSON file as executable source.
      JSON.parse(await fs.readFile(file, "utf8"));
    }
    const bytes = await fs.readFile(file);
    const expanded = kind === "script" ? await expandScriptFile(file, projectRoot) : null;
    return {
      provider: "local-file",
      spec,
      kind,
      file,
      path: withinRoot(projectRoot, file) ? path.relative(projectRoot, file).replace(/\\/g, "/") : file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: expanded?.text,
      dependencies: expanded?.dependencies || [],
      requirements,
      metadataDependencies
    };
  }
});

export const npmSourceProvider = createNpmSourceProvider(localFileProvider);

function parseGitSource(spec) {
  const input = String(spec);
  const match = /^(github:|git\+)(.+)@([0-9a-fA-F]{40})(?:#(.+))?$/.exec(input);
  if (!match || !SHA.test(match[3])) {
    throw new Error(`Git source requires a pinned 40-character commit: ${spec}`);
  }
  let url;
  if (match[1] === "github:") {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(match[2])) {
      throw new Error(`Invalid GitHub repository: ${match[2]}`);
    }
    url = `https://github.com/${match[2]}.git`;
  } else {
    url = match[2];
    const parsed = new URL(url);
    if (!["https:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Git sources support credential-free HTTPS and file URLs only");
    }
  }
  let entry = match[4] || "index.jsx";
  if (entry.includes("\\")) throw new Error("Git source entries use forward slashes");
  entry = path.posix.normalize(entry);
  if (entry.startsWith("../") || entry.startsWith("/") || entry === "..") {
    throw new Error("Git source entry must stay inside the repository");
  }
  if (!SCRIPT_EXTENSIONS.has(path.posix.extname(entry).toLowerCase())) {
    throw new Error(`Git source entry must be .jsx, .jsxinc or .js: ${entry}`);
  }
  return { url, revision: match[3].toLowerCase(), entry };
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: null, stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
    maxBuffer: 64 * 1024 * 1024, ...options
  });
}

function gitTreeIndex(repository, revision) {
  let data;
  try {
    // Listing a moderate tree once eliminates one Git child process per
    // imported file. Huge trees fall back to targeted ls-tree queries.
    data = git(["--git-dir", repository, "ls-tree", "-r", "-z", revision], {
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    if (error?.code === "ENOBUFS" || /maxBuffer exceeded/i.test(String(error?.message))) {
      return null;
    }
    throw error;
  }
  const table = new Map();
  for (const row of data.toString("utf8").split("\0")) {
    if (!row) continue;
    const separator = row.indexOf("\t");
    if (separator < 0) continue;
    table.set(row.slice(separator + 1), row.slice(0, separator));
  }
  return table;
}

async function ensureBareRepository(repository, url) {
  try {
    await fs.access(path.join(repository, "HEAD"));
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(repository);
  await fs.mkdir(parent, { recursive: true });
  // Two independently running builds can materialize the same source safely:
  // each clone is private until the complete bare object database is published.
  const staged = await fs.mkdtemp(path.join(parent, ".essemble-git-"));
  try {
    git(["clone", "--quiet", "--bare", "--", url, staged]);
    try {
      await fs.rename(staged, repository);
    } catch (error) {
      // Only a fully initialized winning clone is acceptable.
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      await fs.access(path.join(repository, "HEAD"));
    }
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

/** Resolve HEAD once when a Git library is added, then save its immutable SHA. */
export function pinGitSource(spec) {
  const input = String(spec);
  if (!isGitSpec(input)) return input;
  if (/@[0-9a-f]{40}(?:#|$)/i.test(input)) return input;
  const hash = input.indexOf("#");
  const repositorySpec = hash === -1 ? input : input.slice(0, hash);
  const entry = hash === -1 ? "" : input.slice(hash);
  let url;
  if (repositorySpec.startsWith("github:")) {
    const slug = repositorySpec.slice(7);
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(slug)) {
      throw new Error(`Invalid GitHub repository: ${slug}`);
    }
    url = `https://github.com/${slug}.git`;
  } else {
    url = repositorySpec.slice(4);
    const parsed = new URL(url);
    if (!["https:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Git sources support credential-free HTTPS and file URLs only");
    }
  }
  const rows = git(["ls-remote", "--exit-code", "--", url, "HEAD"]).toString("utf8");
  const revision = /^([0-9a-f]{40})\s+HEAD$/im.exec(rows)?.[1];
  if (!revision) throw new Error(`Unable to pin Git HEAD: ${repositorySpec}`);
  return `${repositorySpec}@${revision}${entry}`;
}

export const gitSourceProvider = Object.freeze({
  id: "git-pinned",
  match: isGitSpec,
  async resolve(projectRoot, spec) {
    const { url, revision, entry } = parseGitSource(spec);
    const canonicalProject = await fs.realpath(projectRoot);
    const repositoryKey = createHash("sha256").update(url).digest("hex");
    const repository = path.join(canonicalProject, ".essemble", "git", repositoryKey);
    await assertPlainCachePath(canonicalProject, repository);
    await ensureBareRepository(repository, url);
    try {
      git(["--git-dir", repository, "cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      git(["--git-dir", repository, "fetch", "--no-tags", "--depth=1", "origin", revision]);
    }
    const indexedTree = gitTreeIndex(repository, revision);
    const fingerprint = createHash("sha256").update(`${url}\n${revision}\n${entry}`).digest("hex");
    const extractionRoot = path.join(canonicalProject, ".essemble", "sources", fingerprint);
    await assertPlainCachePath(canonicalProject, extractionRoot);
    const seenFiles = new Set();
    let totalBytes = 0;
    const materialize = async (relative, ancestors = []) => {
      const normalized = path.posix.normalize(relative);
      if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("\\")) {
        throw new Error(`Git #include escapes pinned repository: ${relative}`);
      }
      if (!SCRIPT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
        throw new Error(`Git #include is not a supported ExtendScript file: ${normalized}`);
      }
      if (ancestors.includes(normalized)) {
        throw new Error(`Cyclic Git #include: ${[...ancestors, normalized].join(" -> ")}`);
      }
      if (ancestors.length >= 64) throw new Error("Git #include nesting limit exceeded");
      if (seenFiles.has(normalized)) return;
      if (seenFiles.size >= 256) throw new Error("Git include graph exceeds 256 files");
      const record = indexedTree
        ? indexedTree.get(normalized)
        : git(["--git-dir", repository, "ls-tree", "-z", revision, "--", normalized])
          .toString("utf8").split("\0").find((row) => row.endsWith(`\t${normalized}`))
          ?.split("\t")[0];
      if (!record || !/^100(?:644|755) blob [0-9a-f]{40}$/.test(record)) {
        throw new Error(`Git source must be a regular tracked script, not a symlink/submodule: ${normalized}`);
      }
      const expectedBlob = /^100(?:644|755) blob ([0-9a-f]{40})$/.exec(record)[1];
      const file = path.resolve(extractionRoot, normalized);
      if (!withinRoot(extractionRoot, file)) throw new Error(`Git source path escaped cache: ${normalized}`);
      await assertPlainCachePath(canonicalProject, file);
      let data;
      let cachedValid = false;
      try {
        const size = (await fs.stat(file)).size;
        if (size <= 20 * 1024 * 1024) {
          const cached = await fs.readFile(file);
          if (gitBlobDigest(cached) === expectedBlob) {
            data = cached;
            cachedValid = true;
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!data) data = git(["--git-dir", repository, "show", `${revision}:${normalized}`]);
      if (gitBlobDigest(data) !== expectedBlob) {
        throw new Error(`Pinned Git blob integrity mismatch: ${normalized}`);
      }
      totalBytes += data.length;
      if (totalBytes > 20 * 1024 * 1024) throw new Error("Pinned Git source graph exceeds 20 MiB");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (!cachedValid) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await assertPlainCachePath(canonicalProject, file);
        const staging = `${file}.essemble-${randomUUID()}.tmp`;
        try {
          await fs.writeFile(staging, data, { flag: "wx" });
          // Publishing a complete file via rename prevents partially written
          // include source from being observed by another concurrent build.
          await fs.rename(staging, file);
        } finally {
          await fs.rm(staging, { force: true });
        }
      }
      seenFiles.add(normalized);
      for (const directive of scanDirectives(text)) {
        if (directive.kind === "invalid-include") {
          throw new Error(`Unsupported or unresolved Git #include in ${normalized}`);
        }
        if (directive.kind !== "include") continue;
        const imported = directive.value;
        if (imported.includes("\\") || path.posix.isAbsolute(imported)) {
          throw new Error(`Git #include must use relative POSIX paths: ${imported}`);
        }
        await materialize(path.posix.join(path.posix.dirname(normalized), imported), [...ancestors, normalized]);
      }
    };
    await materialize(entry);
    const file = path.resolve(extractionRoot, entry);
    const source = await localFileProvider.resolve(projectRoot, path.relative(projectRoot, file));
    return { ...source, spec, provider: "git-pinned", origin: { url, revision, entry } };
  }
});

function canonicalSelectionSource(value) {
  const raw = String(value).trim();
  return raw.startsWith("file:") ? raw.slice(5) : raw;
}

export async function resolveBuildInputs(projectRoot, catalog, requested, registry = createSourceRegistry()) {
  const components = [];
  const sources = [];
  const seen = new Set();
  const active = new Set();
  const canonicalProject = await fs.realpath(projectRoot);
  async function visit(raw, depth = 0, implicit = false) {
    if (depth >= 128) throw new Error("ESsemble declared dependency nesting limit exceeded");
    if (sources.length + components.length >= 2048) {
      throw new Error("ESsemble build graph exceeds 2048 unique sources/components");
    }
    const provider = registry.find((candidate) => candidate.match(raw));
    if (provider) {
      const source = await provider.resolve(projectRoot, raw);
      if (!source || !["script", "manifest"].includes(source.kind) || typeof source.file !== "string") {
        throw new Error(`${provider.id}: source adapter must return a script/manifest with a file path`);
      }
      const absolute = path.resolve(projectRoot, source.file);
      if (implicit && !withinRoot(canonicalProject, await fs.realpath(absolute))) {
        throw new Error(`Implicit library requirement escapes the consumer project: ${raw}`);
      }
      const bytes = await fs.readFile(absolute);
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (source.sha256 !== actualDigest || source.bytes !== bytes.length) {
        throw new Error(`${provider.id}: reported source identity differs from the file contents: ${absolute}`);
      }
      const metadata = source.metadataDependencies || [];
      if (!Array.isArray(metadata)) {
        throw new Error(`${provider.id}: metadataDependencies must be an array`);
      }
      if (source.kind === "script") {
        // These exact built-in provider objects already materialized and
        // expanded the script. Do not pay for a second recursive filesystem
        // traversal; third-party providers still require independent validation.
        const expanded = provider === localFileProvider || provider === gitSourceProvider || provider === npmSourceProvider
          ? { text: source.text, dependencies: source.dependencies || [] }
          : await expandScriptFile(absolute, projectRoot);
        if (source.text !== expanded.text) {
          throw new Error(`${provider.id}: source text differs from its materialized files: ${absolute}`);
        }
        source.dependencies = [...expanded.dependencies, ...metadata];
      } else {
        source.dependencies = [...(source.dependencies || []), ...metadata];
      }
      // The provenance path and provider ID are authoritative, not whatever
      // metadata a third-party adapter happened to return.
      const canonicalAbsolute = await fs.realpath(absolute);
      source.path = withinRoot(canonicalProject, canonicalAbsolute)
        ? path.relative(canonicalProject, canonicalAbsolute).replace(/\\/g, "/") : canonicalAbsolute;
      source.provider = provider.id;
      source.spec = raw;
      source.file = absolute;
      const key = `file:${canonicalAbsolute}`;
      if (active.has(key)) throw new Error(`Cyclic ESsemble library dependency: ${raw}`);
      if (seen.has(key)) return;
      const requirements = source.requirements || [];
      if (!Array.isArray(requirements) || requirements.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`${provider.id}: requirements must be an array of source specification strings`);
      }
      active.add(key);
      for (const requirement of requirements) await visit(requirement, depth + 1, true);
      active.delete(key);
      source.requirements = await Promise.all(requirements.map(async (requirement) => {
        if (!path.isAbsolute(requirement)) return requirement;
        // Windows 8.3 aliases must be compared against a canonical project
        // root or identical paths can incorrectly appear outside the project.
        const real = await fs.realpath(requirement);
        return withinRoot(canonicalProject, real)
          ? path.relative(canonicalProject, real).replace(/\\/g, "/")
          : real;
      }));
      seen.add(key);
      sources.push(source);
      return;
    }
    if (isSourceSpec(raw)) throw new Error(`No source provider for ${raw}`);
    const spec = parseComponentSpec(raw);
    const id = normalizeComponentId(catalog, spec.name);
    const key = `component:${id}`;
    if (seen.has(key)) {
      const previous = components.find((item) => item.id === id);
      if (previous.version !== spec.version) throw new Error(`Conflicting versions for ${id}`);
      return;
    }
    seen.add(key);
    components.push({ id, version: spec.version });
  }
  for (const raw of requested) await visit(raw);
  return { components, sources };
}

export function renderSourceAppendix(sources) {
  return sources.filter((source) => source.kind === "script")
    .map((source, index) => `\n;\n/* ESsemble source ${index + 1}: sha256:${source.sha256} */\n${source.text}\n`)
    .join("");
}

/** ExtendScript compiler directives must precede generated ESPACK text. */
export function composeSourceText(prefix, sources) {
  const directives = new Map();
  const scripts = sources.map((source) => {
    if (source.kind !== "script") return source;
    let text = "";
    let previous = 0;
    for (const directive of scanDirectives(source.text)) {
      if (directive.kind !== "target" && directive.kind !== "targetengine") continue;
      if (directives.has(directive.kind) && directives.get(directive.kind) !== directive.value) {
        throw new Error(`Conflicting #${directive.kind} directives: ${directives.get(directive.kind)} vs ${directive.value}`);
      }
      directives.set(directive.kind, directive.value);
      text += source.text.slice(previous, directive.start);
      previous = directive.end;
    }
    text += source.text.slice(previous);
    return { ...source, text };
  });
  const header = ["target", "targetengine"]
    .filter((type) => directives.has(type))
    .map((type) => `#${type} ${directives.get(type)}\n`).join("");
  return header + prefix + renderSourceAppendix(scripts);
}