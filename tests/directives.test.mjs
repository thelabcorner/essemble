import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanDirectives } from "../src/directives.mjs";
import { composeSourceText, expandScriptFile } from "../src/sources.mjs";

test("preprocessor lexer ignores directives written in comments and quoted strings", () => {
  const text = [
    'var literal = "#include \\"nonexistent.jsx\\"";',
    '/*',
    '#include "missing.jsx"',
    '#target photoshop',
    '*/',
    '// #target aftereffects',
    '#target illustrator',
    '#include "real.jsx" // intentionally real',
    'var quotedComment = "/* not a block comment */";',
    '#targetengine core'
  ].join("\r\n");
  const tokens = scanDirectives(text);
  assert.deepEqual(tokens.map((item) => [item.kind, item.value]), [
    ["target", "illustrator"],
    ["include", "real.jsx"],
    ["targetengine", "core"]
  ]);
});

test("commented includes are inert; literal includes still expand in position", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-directives-"));
  try {
    await fs.writeFile(path.join(root, "included.jsxinc"), "var VALUE = 42;\n");
    await fs.writeFile(path.join(root, "index.jsx"), [
      "/*",
      '#include "missing.jsxinc"',
      "#target photoshop",
      "*/",
      '#include "included.jsxinc"',
      "$.global.VALUE = VALUE;",
      "#target illustrator"
    ].join("\n"));
    const expanded = await expandScriptFile(path.join(root, "index.jsx"));
    assert.equal(expanded.dependencies.length, 1);
    assert.match(expanded.text, /var VALUE = 42;/);
    const composed = composeSourceText("", [{ kind: "script", text: expanded.text, sha256: "fixture" }]);
    assert.ok(composed.startsWith("#target illustrator\n"));
    assert.match(composed, /#target photoshop/);
    assert.ok(composed.indexOf("var VALUE = 42") < composed.indexOf("$.global.VALUE = VALUE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("actual malformed include fails closed, commented malformed include does not", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-directives-"));
  try {
    const input = path.join(root, "index.jsx");
    await fs.writeFile(input, "/*\n#include not-a-real-path\n*/\nvar ok = 1;\n");
    assert.match((await expandScriptFile(input)).text, /var ok = 1/);
    await fs.writeFile(input, "#include not-a-real-path\nvar ok = 1;\n");
    await assert.rejects(expandScriptFile(input), /Unsupported or unresolved #include/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project sources reject transitive includes escaping project boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-include-boundary-"));
  try {
    const project = path.join(root, "consumer");
    await fs.mkdir(project);
    await fs.writeFile(path.join(root, "outside.jsxinc"), "var SECRET = 1;\n");
    const script = path.join(project, "main.jsx");
    await fs.writeFile(script, '#include "../outside.jsxinc"\n$.global.SECRET = SECRET;\n');
    await assert.rejects(expandScriptFile(script, project), /#include escapes the allowed source root/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repeated includes preserve evaluation semantics but deduplicate dependency identities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-repeat-include-"));
  try {
    const shared = path.join(root, "shared.jsxinc");
    const script = path.join(root, "entry.jsx");
    await fs.writeFile(shared, "$.global.LOAD_COUNT++;\n");
    await fs.writeFile(script, '#include "shared.jsxinc"\n#include "shared.jsxinc"\n');
    const expanded = await expandScriptFile(script, root);
    assert.equal(expanded.dependencies.length, 1);
    assert.equal((expanded.text.match(/LOAD_COUNT/g) || []).length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("single oversized JSX source is rejected before expansion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-source-budget-"));
  try {
    const huge = path.join(root, "large.jsx");
    await fs.writeFile(huge, Buffer.alloc(20 * 1024 * 1024 + 1, 32));
    await assert.rejects(expandScriptFile(huge, root), /source exceeds the 20 MiB safety limit/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});