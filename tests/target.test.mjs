import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTargetCompatible,
  inferManifestVariant,
  inspectTargetCompatibility,
  normalizeTarget,
  selectManifestVariant,
  targetKey
} from "../src/target.mjs";

function pePayload(machine, fileName = "native.dll") {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  return { name: "native", fileName, b64: bytes.toString("base64") };
}

test("target normalization accepts the supported Windows architecture aliases", () => {
  assert.deepEqual(normalizeTarget("illustrator-win-x64"), {
    host: "illustrator",
    platform: "windows",
    arch: "x64"
  });
  assert.deepEqual(normalizeTarget("windows-amd64"), {
    host: "illustrator",
    platform: "windows",
    arch: "x64"
  });
  assert.deepEqual(normalizeTarget("win-x86"), {
    host: "illustrator",
    platform: "windows",
    arch: "x86"
  });
  assert.equal(targetKey("illustrator-windows-x64"), "illustrator-win-x64");
});

test("manifest variant inference and selection are explicit for multi-arch releases", () => {
  const manifests = [
    { name: "eshttp.accel-x64.manifest.json", variant: inferManifestVariant("eshttp.accel-x64.manifest.json") },
    { name: "eshttp.accel-x86.manifest.json", variant: inferManifestVariant("eshttp.accel-x86.manifest.json") }
  ];
  assert.equal(selectManifestVariant(manifests, "illustrator-win-x64").name, "eshttp.accel-x64.manifest.json");
  assert.equal(selectManifestVariant(manifests, "illustrator-win-x86").name, "eshttp.accel-x86.manifest.json");
});

test("required Windows native capabilities fail before composition on a non-Windows target", () => {
  const manifest = {
    payloads: [{ name: "worker", fileName: "worker.exe" }],
    capabilities: [{ id: "app.worker", provider: "app", mode: "required", payloads: ["worker"], accel: null }]
  };
  assert.throws(
    () => assertTargetCompatible(manifest, { host: "illustrator", platform: "macos", arch: "x64" }, "app"),
    /requires Windows-native capability/
  );
});

test("required native payload architecture must match the selected target", () => {
  const manifest = {
    payloads: [pePayload(0x8664)],
    capabilities: [{ id: "app.native", provider: "app", mode: "required", payloads: ["native"], accel: null }]
  };
  const ok = inspectTargetCompatibility(manifest, "illustrator-win-x64", { nativePolicy: "prefer" });
  assert.equal(ok.capabilities[0].payloads[0].arch, "x64");
  assert.throws(
    () => inspectTargetCompatibility(manifest, "illustrator-win-x86", { nativePolicy: "prefer", label: "app" }),
    /payload architecture x64 does not match x86/
  );
});

test("portable and require policies fail closed instead of rewriting published capability semantics", () => {
  const manifest = {
    payloads: [pePayload(0x8664)],
    capabilities: [{ id: "app.native", provider: "app", mode: "optional", payloads: ["native"], accel: null }]
  };
  assert.throws(
    () => inspectTargetCompatibility(manifest, "illustrator-win-x64", { nativePolicy: "portable", label: "app" }),
    /is not portable/
  );
  assert.throws(
    () => inspectTargetCompatibility(manifest, "illustrator-win-x64", { nativePolicy: "require", label: "app" }),
    /cannot enforce native=require/
  );
});