import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeComponentId } from "./catalog.mjs";
import { inferManifestVariant } from "./target.mjs";
import { loadEspackBackend } from "./espack-backend.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function githubSlug(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(String(url || ""));
  if (!match) throw new Error(`Unsupported GitHub source URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}

function headers() {
  const result = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ESsemble"
  };
  if (process.env.GITHUB_TOKEN) result.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return result;
}

async function fetchOk(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

async function resolveTagCommit(slug, tag) {
  const refUrl = `https://api.github.com/repos/${slug}/git/ref/tags/${encodeURIComponent(tag)}`;
  const ref = await (await fetchOk(refUrl)).json();
  let object = ref.object;
  for (let depth = 0; depth < 4 && object?.type === "tag"; depth++) {
    const tagObject = await (await fetchOk(`https://api.github.com/repos/${slug}/git/tags/${object.sha}`)).json();
    object = tagObject.object;
  }
  if (!object || object.type !== "commit" || !/^[0-9a-f]{40}$/i.test(String(object.sha || ""))) {
    throw new Error(`${slug} ${tag}: could not resolve immutable tag commit`);
  }
  return String(object.sha).toLowerCase();
}

export function artifactCacheDir(root) {
  return path.join(root, ".artifacts", "sha256");
}

export function cachedArtifactPath(root, digest, extension = ".json") {
  return path.join(artifactCacheDir(root), digest.slice(0, 2), digest + extension);
}

export async function readComponentVersion(root, component) {
  const packagePath = path.resolve(root, component.source.path, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (!pkg.version) throw new Error(`${component.id}: package.json has no version`);
  return String(pkg.version);
}

export function parseComponentSpec(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Empty component specification");
  const match = /^([^@]+?)(?:@(\d+\.\d+\.\d+))?$/.exec(raw);
  if (!match) throw new Error(`Invalid component specification: ${value}`);
  return { name: match[1], version: match[2] || null };
}

export async function discoverReleaseManifests(root, component, options = {}) {
  if (component.source.type !== "git") {
    throw new Error(`${component.id}: release artifacts require a git-backed component`);
  }
  const slug = githubSlug(component.source.url);
  const requestedVersion = options.version || null;
  const requestedTag = options.tag || (requestedVersion ? `v${requestedVersion}` : null);
  const releaseUrl = requestedTag
    ? `https://api.github.com/repos/${slug}/releases/tags/${encodeURIComponent(requestedTag)}`
    : `https://api.github.com/repos/${slug}/releases/latest`;
  const release = await (await fetchOk(releaseUrl)).json();
  if (release.draft || release.prerelease) {
    throw new Error(`${component.id}: ${release.tag_name || requestedTag || "latest"} is not a stable published release`);
  }
  const tag = String(release.tag_name || requestedTag || "");
  const versionMatch = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!versionMatch) throw new Error(`${component.id}: stable release tag is not v<semver>: ${tag}`);
  const version = versionMatch[1];
  if (requestedVersion && version !== requestedVersion) {
    throw new Error(`${component.id}: requested ${requestedVersion}, GitHub returned ${version}`);
  }
  const tagCommit = await resolveTagCommit(slug, tag);
  const assets = (release.assets || []).filter((asset) => String(asset.name).endsWith(".manifest.json"));
  if (!assets.length) {
    throw new Error(`${component.id}@${version}: release ${tag} has no manifest-v2 asset`);
  }

  const manifests = [];
  for (const asset of assets.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const bytes = Buffer.from(await (await fetchOk(asset.browser_download_url)).arrayBuffer());
    const digest = sha256(bytes);
    const parsed = JSON.parse(bytes.toString("utf8"));
    manifests.push({
      name: String(asset.name),
      url: String(asset.browser_download_url),
      bytes: bytes.length,
      sha256: digest,
      variant: inferManifestVariant(asset.name),
      manifestVersion: Number(parsed.version),
      composer: parsed.composer ? {
        name: String(parsed.composer.name || ""),
        version: String(parsed.composer.version || "")
      } : null,
      entries: Array.isArray(parsed.entries) ? parsed.entries.map((entry) =>
        typeof entry === "string" ? { id: entry, range: "*" } : { id: String(entry.id), range: String(entry.range || "*") }
      ) : [],
      _bytes: bytes,
      _parsed: parsed
    });
  }

  return { version, tag, tagCommit, repository: slug, manifests };
}

export async function cacheManifestArtifact(root, artifact) {
  const destination = cachedArtifactPath(root, artifact.sha256, ".json");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await fs.readFile(destination);
    if (sha256(existing) !== artifact.sha256) {
      throw new Error(`Cache corruption at ${destination}`);
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    const bytes = artifact._bytes || Buffer.from(await (await fetchOk(artifact.url)).arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== artifact.sha256) {
      throw new Error(`Artifact SHA-256 mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${digest}`);
    }
    await fs.writeFile(destination, bytes);
  }
  return destination;
}

export async function ensureCachedManifest(root, artifact, options = {}) {
  const destination = cachedArtifactPath(root, artifact.sha256, ".json");
  try {
    const bytes = await fs.readFile(destination);
    const digest = sha256(bytes);
    if (digest !== artifact.sha256 || bytes.length !== artifact.bytes) {
      throw new Error(`Cached artifact mismatch for ${artifact.name}`);
    }
    return destination;
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  // A legacy development checkout may already have this exact immutable
  // artifact. Reuse its validated bytes without writing into a globally
  // installed ESsemble package. All new builds cache under the consumer root.
  if (options.fallbackRoot && path.resolve(options.fallbackRoot) !== path.resolve(root)) {
    const fallback = cachedArtifactPath(options.fallbackRoot, artifact.sha256, ".json");
    try {
      const bytes = await fs.readFile(fallback);
      const digest = sha256(bytes);
      if (digest !== artifact.sha256 || bytes.length !== artifact.bytes) {
        throw new Error(`Fallback artifact cache is corrupt: ${fallback}`);
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
      return destination;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const bytes = Buffer.from(await (await fetchOk(artifact.url)).arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== artifact.sha256 || bytes.length !== artifact.bytes) {
    throw new Error(`Downloaded artifact mismatch for ${artifact.name}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  return destination;
}

export async function lockReleaseManifests(root, catalog, lock, requestedValues, options = {}) {
  const result = structuredClone(lock);
  const rows = [];
  const { validateManifest } = await loadEspackBackend(root);
  for (const value of requestedValues) {
    const spec = parseComponentSpec(value);
    const id = normalizeComponentId(catalog, spec.name);
    const component = catalog.components.find((item) => item.id === id);
    const release = await discoverReleaseManifests(root, component, { version: spec.version });
    for (const manifest of release.manifests) {
      if (manifest.manifestVersion !== 2) {
        throw new Error(`${id}: ${manifest.name} is manifest v${manifest.manifestVersion}, expected v2`);
      }
      validateManifest(manifest._parsed, `${id}:${manifest.name}`);
      if (manifest.composer?.name !== "espack") {
        throw new Error(`${id}: ${manifest.name} is not an ESPACK-composed manifest`);
      }
      if (!manifest.entries.some((entry) => entry.id === id)) {
        throw new Error(`${id}: ${manifest.name} does not expose ${id} as an entry root`);
      }
      await cacheManifestArtifact(options.cacheRoot || root, manifest);
    }
    const clean = {
      version: release.version,
      tag: release.tag,
      tagCommit: release.tagCommit,
      repository: release.repository,
      manifests: release.manifests.map(({ _bytes, _parsed, ...manifest }) => manifest)
    };
    result.components[id] = { ...result.components[id], release: clean };
    rows.push({ id, ...clean });
  }
  result.schemaVersion = 2;
  result.generatedAt = new Date().toISOString().slice(0, 10);
  return { lock: result, rows };
}

export async function writeLock(root, lock) {
  await fs.writeFile(path.join(root, "essemble.lock.json"), JSON.stringify(lock, null, 2) + "\n", "utf8");
}

export function artifactDigest(bytes) {
  return sha256(bytes);
}