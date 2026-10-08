import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, loadLock, loadProfiles } from "../src/catalog.mjs";
import { resolveSelection } from "../src/resolver.mjs";

const catalog = await loadCatalog();

test("alias normalization resolves ESTC by its legacy repository name", () => {
  const result = resolveSelection(catalog, ["extendscript-toolchain"], ["runtime"]);
  assert.deepEqual(result.components, ["estc"]);
});

test("runtime-only selection does not import construction dependencies", () => {
  const result = resolveSelection(catalog, ["eson"], ["runtime"]);
  assert.deepEqual(result.components, ["eson"]);
});

test("ESTC validation closure includes COMTool without making it a runtime dependency", () => {
  const validation = resolveSelection(catalog, ["estc"], ["validation"]);
  assert.ok(validation.components.includes("comtool"));

  const runtime = resolveSelection(catalog, ["estc"], ["runtime"]);
  assert.deepEqual(runtime.components, ["estc"]);
});

test("ESHTTP construction closure includes typed build/native/composition dependencies", () => {
  const result = resolveSelection(catalog, ["eshttp"], ["build", "compose", "native"]);
  for (const id of ["eshttp", "estc", "esabi", "eson", "esb64", "espack"]) {
    assert.ok(result.components.includes(id), `missing ${id}`);
  }
});

test("ESB64 and ESPACK remain one explicit strongly connected component", () => {
  const result = resolveSelection(catalog, ["esb64"], ["compose"]);
  assert.ok(result.cycles.some((group) =>
    group.length === 2 && group[0] === "esb64" && group[1] === "espack"
  ));
});

test("optional runtime dependencies are opt-in", () => {
  const base = resolveSelection(catalog, ["esuuid"], ["runtime"]);
  assert.deepEqual(base.components, ["esuuid"]);

  const optional = resolveSelection(catalog, ["esuuid"], ["runtime", "optionalRuntime"]);
  assert.deepEqual(optional.components, ["esrand", "esuuid"]);
});

test("ESUUID composition hard-closes over ESRAND and ESPACK without changing standalone runtime fallback", () => {
  const composed = resolveSelection(catalog, ["esuuid"], ["compose"]);
  for (const id of ["esuuid", "esrand", "espack", "esb64"]) {
    assert.ok(composed.components.includes(id), `missing ${id}`);
  }
});

test("ESLOG runtime requires ESON while composed distribution also closes over ESPACK", () => {
  const runtime = resolveSelection(catalog, ["eslog"], ["runtime"]);
  assert.deepEqual(runtime.components, ["eslog", "eson"]);

  const composed = resolveSelection(catalog, ["eslog"], ["runtime", "compose"]);
  for (const id of ["eslog", "eson", "espack", "esb64"]) {
    assert.ok(composed.components.includes(id), `missing ${id}`);
  }
});

test("ESFS and ESHASH composition close over ESB64/ESPACK while native construction closes over ESABI", () => {
  for (const id of ["esfs", "eshash"]) {
    const composed = resolveSelection(catalog, [id], ["compose"]);
    for (const dependency of [id, "esb64", "espack"]) {
      assert.ok(composed.components.includes(dependency), `${id} compose missing ${dependency}`);
    }

    const native = resolveSelection(catalog, [id], ["native"]);
    assert.ok(native.components.includes(id), `${id} native closure missing root`);
    assert.ok(native.components.includes("esabi"), `${id} native closure missing esabi`);
  }
});

test("published and workspace runtime primitives use the correct source model and typed dependency lanes", async () => {
  const lock = await loadLock();
  const profiles = await loadProfiles();
  const full = profiles.find((item) => item.name === "full");
  const profile = profiles.find((item) => item.name === "runtime");
  const minimal = profiles.find((item) => item.name === "minimal");
  const simpleIds = ["esenv", "espath"];
  const simpleDependencies = {
    runtime: [],
    build: ["estc"],
    compose: [],
    native: [],
    optionalRuntime: [],
    validation: [],
    benchmark: [],
    prototype: [],
    integration: []
  }

  const published = {
    esfs: {
      url: "https://github.com/thelabcorner/es-fs.git",
      revision: "8310631082ea99d3ea203f5a75f77036b37fbb54"
    },
    eshash: {
      url: "https://github.com/thelabcorner/es-hash.git",
      revision: "9f53d2cd6fb4d9991708f2dd27d693e6293e20b2"
    }
  };

  for (const id of ["esfs", "eshash"]) {
    const component = catalog.components.find((item) => item.id === id);
    const sourcePath = `components/${id}`;
    assert.ok(component, `missing catalog entry for ${id}`);
    assert.equal(component.kind, "runtime-primitive");
    assert.equal(component.status, "stable");
    assert.deepEqual(component.source, {
      type: "git",
      url: published[id].url,
      path: sourcePath
    });
    assert.deepEqual(component.dependencies, {
      runtime: [],
      build: ["estc"],
      compose: ["esb64", "espack"],
      native: ["esabi"],
      optionalRuntime: [],
      validation: [],
      benchmark: [],
      prototype: [],
      integration: []
    });
    assert.deepEqual(
      {
        sourceType: lock.components[id].sourceType,
        url: lock.components[id].url,
        branch: lock.components[id].branch,
        revision: lock.components[id].revision
      },
      {
        sourceType: "git",
        url: published[id].url,
        branch: "main",
        revision: published[id].revision
      }
    );
    if (lock.components[id].release) {
      assert.equal(lock.components[id].release.tag, "v0.2.0");
      assert.equal(lock.components[id].release.version, "0.2.0");
      assert.match(lock.components[id].release.tagCommit, /^[0-9a-f]{40}$/);
      assert.ok(lock.components[id].release.manifests.some((manifest) =>
        manifest.entries.some((entry) => entry.id === id)
      ));
    }
    assert.ok(full.selection.includes(id), `full profile is missing ${id}`);
    assert.ok(profile.selection.includes(id), `runtime profile is missing ${id}`);
    assert.ok(catalog.components.find((item) => item.id === "estc").dependencies.validation.includes(id));
  };

  for (const id of simpleIds) {
    const component = catalog.components.find((item) => item.id === id);
    const sourcePath = `../${id}`;
    assert.ok(component, `missing catalog entry for ${id}`);
    assert.equal(component.kind, "runtime-primitive");
    assert.equal(component.status, "stable");
    assert.deepEqual(component.source, { type: "workspace", path: sourcePath });
    assert.deepEqual(component.dependencies, simpleDependencies);
    assert.deepEqual(lock.components[id], {
      sourceType: "workspace",
      path: sourcePath,
      revision: null
    });
    assert.ok(full.selection.includes(id), `full profile is missing ${id}`);
    assert.ok(profile.selection.includes(id), `runtime profile is missing ${id}`);
    assert.ok(catalog.components.find((item) => item.id === "estc").dependencies.validation.includes(id));
  }

  const eslog = catalog.components.find((item) => item.id === "eslog");
  assert.ok(eslog, "missing catalog entry for eslog");
  assert.deepEqual(eslog.source, {
    type: "git",
    url: "https://github.com/thelabcorner/es-log.git",
    path: "components/eslog"
  });
  assert.deepEqual(eslog.dependencies, {
    runtime: ["eson"],
    build: ["estc"],
    compose: ["eson", "espack"],
    native: [],
    optionalRuntime: [],
    validation: [],
    benchmark: [],
    prototype: [],
    integration: []
  });
  assert.deepEqual(
    {
      sourceType: lock.components.eslog.sourceType,
      url: lock.components.eslog.url,
      branch: lock.components.eslog.branch,
      revision: lock.components.eslog.revision
    },
    {
      sourceType: "git",
      url: "https://github.com/thelabcorner/es-log.git",
      branch: "main",
      revision: "1cc3fa7fffb1e0e4d281f643564c106b01ebbb38"
    }
  );
  if (lock.components.eslog.release) {
    assert.equal(lock.components.eslog.release.version, "0.2.0");
    assert.equal(lock.components.eslog.release.tag, "v0.2.0");
    assert.match(lock.components.eslog.release.tagCommit, /^[0-9a-f]{40}$/);
    assert.ok(lock.components.eslog.release.manifests.some((manifest) =>
      manifest.entries.some((entry) => entry.id === "eslog")
    ));
  }
  assert.ok(full.selection.includes("eslog"));
  assert.ok(profile.selection.includes("eslog"));
  assert.ok(catalog.components.find((item) => item.id === "estc").dependencies.validation.includes("eslog"));

  assert.deepEqual(minimal.selection, []);
});

test("runtime profile resolves to all fourteen primitives deterministically", async () => {
  const profiles = await loadProfiles();
  const profile = profiles.find((item) => item.name === "runtime");
  const result = resolveSelection(catalog, profile.selection, profile.scopes);
  const reordered = resolveSelection(catalog, [...profile.selection].reverse(), [...profile.scopes].reverse());
  assert.deepEqual(result, reordered);
  assert.equal(result.components.length, 14);
  assert.deepEqual(result.components, [
    "esarr", "esb64", "eschars", "esenv", "esfs", "eshash", "eshttp", "eslog", "eson", "espath", "esrand", "esstr", "estimer", "esuuid"
  ]);
});
