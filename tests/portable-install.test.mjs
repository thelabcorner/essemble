import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rootDir } from "../src/catalog.mjs";
import { resolveToolInstallation } from "../src/toolchain.mjs";

const run = (exe, args, options = {}) => {
  const result = spawnSync(exe, args, {
    encoding: "utf8", timeout: 45000, windowsHide: true, ...options
  });
  if (result.error) throw result.error;
  return result;
};

test("packed npm archive carries no component source and builds external projects", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-standalone-"));
  try {
    const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary];
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    let packed;
    try {
      await fs.access(npmCli);
      packed = run(process.execPath, [npmCli, ...args], { cwd: rootDir });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // The Windows npm launcher is a .cmd wrapper, not a directly spawnable
      // executable. Keep the fallback command fully under test control.
      packed = process.platform === "win32"
        ? run(process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", `npm pack --ignore-scripts --json --pack-destination "${temporary}"`],
          { cwd: rootDir })
        : run("npm", args, { cwd: rootDir });
    }
    assert.equal(packed.status, 0, packed.stderr);
    const packages = JSON.parse(packed.stdout);
    assert.equal(packages.length, 1);
    assert.ok(packages[0].files.some((item) => item.path === "src/toolchain.mjs"));
    assert.ok(packages[0].files.some((item) => item.path === "bin/essemble.mjs"));
    assert.ok(!packages[0].files.some((item) => item.path.startsWith("components/")));
    assert.ok(packages[0].size < 250_000, "package must not accidentally vendor component sources");

    const destination = path.join(temporary, "unpacked");
    await fs.mkdir(destination);
    const extracted = run("tar", [
      "-xzf", path.join(temporary, packages[0].filename), "-C", destination
    ]);
    assert.equal(extracted.status, 0, extracted.stderr);
    const installedRoot = path.join(destination, "package");
    await assert.rejects(fs.access(path.join(installedRoot, "components", "espack")));

    const consumer = path.join(temporary, "consumer-project");
    await fs.mkdir(consumer);
    const installedBin = path.join(installedRoot, "bin", "essemble.mjs");
    const env = {
      ...process.env,
      ESPACK_ROOT: path.join(rootDir, "components", "espack"),
      ESTC_ROOT: path.join(rootDir, "components", "estc"),
      COMTOOL_NODE_SDK_PATH: path.join(rootDir, "components", "comtool", "sdk", "node", "index.mjs")
    };
    const invoke = (...args) => run(process.execPath, [installedBin, ...args], {
      cwd: consumer, env
    });
    assert.equal(invoke("init").status, 0);
    await fs.writeFile(path.join(consumer, "main.jsx"),
      "#target illustrator\n$.global.PORTABLE_INSTALL = 123;\n");
    assert.equal(invoke("add", "./main.jsx").status, 0);
    const tools = invoke("tools", "--json");
    assert.equal(tools.status, 0, tools.stderr);
    const discovered = JSON.parse(tools.stdout);
    assert.equal(discovered.find((item) => item.id === "espack").installationSource, "ESPACK_ROOT");
    assert.equal(discovered.find((item) => item.id === "estc").installationSource, "ESTC_ROOT");
    assert.equal(discovered.find((item) => item.id === "comtool").installationSource, "COMTOOL_NODE_SDK_PATH");
    assert.equal(invoke("build").status, 0);
    const compiled = await fs.readFile(path.join(consumer, "dist", "runtime.jsx"), "utf8");
    assert.match(compiled, /PORTABLE_INSTALL = 123/);
    const verified = invoke("verify", "dist/runtime.receipt.json", "--rebuild");
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const checked = invoke("check", "dist/runtime.jsx");
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    const receiptPath = path.join(consumer, "dist", "runtime.receipt.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    assert.equal(receipt.linker.sourceRevision, null, "non-Git external installations must not claim a checkout commit");
    assert.equal(receipt.linker.sourceFiles.length, 3);

    // A different installed ESPACK implementation must invalidate the receipt
    // even when its entry-point filenames still satisfy the toolchain contract.
    const modifiedEspack = path.join(temporary, "different-espack");
    await fs.mkdir(modifiedEspack);
    for (const file of receipt.linker.sourceFiles) {
      await fs.copyFile(path.join(env.ESPACK_ROOT, file.path), path.join(modifiedEspack, file.path));
    }
    await fs.appendFile(path.join(modifiedEspack, "espack-merge.mjs"), "\n// changed tool identity\n");
    const changedTool = run(process.execPath,
      [installedBin, "verify", "dist/runtime.receipt.json", "--rebuild"], {
        cwd: consumer, env: { ...env, ESPACK_ROOT: modifiedEspack }
      });
    assert.notEqual(changedTool.status, 0);
    assert.match(changedTool.stderr, /rebuild linker module drift/);

    receipt.linker.sourceFiles[0].sha256 = "0".repeat(64);
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    const invalid = invoke("verify", "dist/runtime.receipt.json", "--rebuild");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /rebuild linker module drift/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("explicit installation roots fail closed instead of silently falling back", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-tool-env-"));
  const before = process.env.ESPACK_ROOT;
  try {
    process.env.ESPACK_ROOT = temporary;
    assert.throws(() => resolveToolInstallation(rootDir, "espack"),
      /ESPACK_ROOT does not contain a complete espack installation/);
    assert.equal(resolveToolInstallation(rootDir, "espack", { optional: true }), null);
    delete process.env.ESPACK_ROOT;
    assert.equal(resolveToolInstallation(rootDir, "espack").source, "framework");
  } finally {
    if (before === undefined) delete process.env.ESPACK_ROOT;
    else process.env.ESPACK_ROOT = before;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});