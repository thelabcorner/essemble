const ARCH_ALIASES = new Map([
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["x64", "x64"],
  ["ia32", "x86"],
  ["i386", "x86"],
  ["x86", "x86"]
]);

const PLATFORM_ALIASES = new Map([
  ["win", "windows"],
  ["windows", "windows"],
  ["darwin", "macos"],
  ["mac", "macos"],
  ["macos", "macos"],
  ["linux", "linux"]
]);

export function normalizeTarget(value = "illustrator-win-x64") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const host = String(value.host || "illustrator").toLowerCase();
    const platform = PLATFORM_ALIASES.get(String(value.platform || "windows").toLowerCase());
    const arch = ARCH_ALIASES.get(String(value.arch || "x64").toLowerCase());
    if (!platform) throw new Error(`Unknown target platform: ${value.platform}`);
    if (!arch) throw new Error(`Unknown target architecture: ${value.arch}`);
    return { host, platform, arch };
  }

  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return { host: "illustrator", platform: "windows", arch: "x64" };
  const tokens = raw.split(/[-/]+/).filter(Boolean);
  let host = "illustrator";
  let platform = null;
  let arch = null;
  for (const token of tokens) {
    if (token === "illustrator" || token === "extendscript") host = "illustrator";
    if (PLATFORM_ALIASES.has(token)) platform = PLATFORM_ALIASES.get(token);
    if (ARCH_ALIASES.has(token)) arch = ARCH_ALIASES.get(token);
  }
  if (!platform) {
    if (raw === "x64" || raw === "x86" || raw === "amd64" || raw === "ia32") platform = "windows";
    else throw new Error(`Target must identify a platform: ${value}`);
  }
  if (!arch) throw new Error(`Target must identify an architecture: ${value}`);
  return { host, platform, arch };
}

export function targetKey(target) {
  const t = normalizeTarget(target);
  const platform = t.platform === "windows" ? "win" : t.platform;
  return `${t.host}-${platform}-${t.arch}`;
}

export function inferManifestVariant(assetName) {
  const name = String(assetName || "").toLowerCase();
  if (/(^|[._-])x64([._-]|$)/.test(name)) return { arch: "x64" };
  if (/(^|[._-])x86([._-]|$)/.test(name)) return { arch: "x86" };
  return { arch: "any" };
}

export function selectManifestVariant(manifests, target) {
  const list = (manifests || []).slice();
  if (!list.length) throw new Error("No locked manifest artifacts are available");
  if (list.length === 1) return list[0];

  const t = normalizeTarget(target);
  const exact = list.filter((item) => (item.variant?.arch || inferManifestVariant(item.name).arch) === t.arch);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Multiple manifest variants match ${targetKey(t)}: ${exact.map((item) => item.name).join(", ")}`);
  }

  const generic = list.filter((item) => (item.variant?.arch || inferManifestVariant(item.name).arch) === "any");
  if (generic.length === 1) return generic[0];

  throw new Error(
    `No unique manifest variant matches ${targetKey(t)}; available: ${list.map((item) => item.name).join(", ")}`
  );
}

function peArchitecture(payload) {
  const fileName = String(payload?.fileName || "");
  if (!/\.(dll|exe)$/i.test(fileName) || typeof payload?.b64 !== "string") return null;
  const bytes = Buffer.from(payload.b64, "base64");
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length) return null;
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return "x64";
  if (machine === 0x014c) return "x86";
  if (machine === 0xaa64) return "arm64";
  return `machine-0x${machine.toString(16)}`;
}

function capabilityNativeFiles(manifest, cap) {
  const payloadByName = new Map((manifest.payloads || []).map((payload) => [payload.name, payload]));
  return (cap.payloads || [])
    .map((name) => payloadByName.get(name))
    .filter(Boolean)
    .filter((payload) => /\.(dll|exe)$/i.test(String(payload.fileName || "")));
}

export function inspectTargetCompatibility(manifest, target, options = {}) {
  const t = normalizeTarget(target);
  const nativePolicy = String(options.nativePolicy || "prefer");
  if (!["prefer", "portable", "require"].includes(nativePolicy)) {
    throw new Error(`Unknown native policy: ${nativePolicy}`);
  }
  const diagnostics = [];
  const capabilities = [];

  for (const cap of manifest.capabilities || []) {
    const nativePayloads = capabilityNativeFiles(manifest, cap);
    const native = nativePayloads.length > 0 || !!cap.accel;
    if (!native) continue;
    const arches = [...new Set(nativePayloads.map(peArchitecture).filter(Boolean))];
    const row = {
      id: cap.id,
      provider: cap.provider,
      mode: cap.mode,
      payloads: nativePayloads.map((payload) => ({
        name: payload.name,
        fileName: payload.fileName,
        arch: peArchitecture(payload)
      })),
      accelerator: cap.accel || null,
      compatible: true
    };

    if (t.platform !== "windows") {
      row.compatible = false;
      if (cap.mode === "required" || nativePolicy !== "prefer") {
        const prefix = cap.mode === "required"
          ? `${options.label || "manifest"} requires Windows-native capability ${cap.id}`
          : `${options.label || "manifest"} cannot satisfy ${cap.mode} Windows-native capability ${cap.id}`;
        throw new Error(`${prefix} on ${targetKey(t)}`);
      }
      diagnostics.push(`optional capability ${cap.id} carries Windows-native payloads on ${targetKey(t)}; fallback semantics remain as shipped`);
    }

    if (t.platform === "windows" && arches.length && !arches.includes(t.arch)) {
      row.compatible = false;
      const message = `capability ${cap.id} payload architecture ${arches.join("/")} does not match ${t.arch}`;
      if (cap.mode === "required" || nativePolicy !== "prefer") throw new Error(`${options.label || "manifest"}: ${message}`);
      diagnostics.push(`optional ${message}; fallback semantics remain as shipped`);
    }

    if (nativePolicy === "portable") {
      throw new Error(`${options.label || "manifest"} is not portable: capability ${cap.id} ships native payloads`);
    }
    if (nativePolicy === "require" && cap.mode !== "required") {
      throw new Error(
        `${options.label || "manifest"} cannot enforce native=require: capability ${cap.id} is optional in the published artifact`
      );
    }
    capabilities.push(row);
  }

  return { target: t, nativePolicy, diagnostics, capabilities };
}

export function assertTargetCompatible(manifest, target, label = "manifest", options = {}) {
  return inspectTargetCompatibility(manifest, target, { ...options, label });
}