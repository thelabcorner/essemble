import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveToolInstallation } from "./toolchain.mjs";

export async function loadEspackBackend(root) {
  const espackRoot = resolveToolInstallation(root, "espack").root;
  const estcRoot = resolveToolInstallation(root, "estc", { optional: true })?.root;
  const priorEstcRoot = process.env.ESTC_ROOT;
  if (estcRoot) process.env.ESTC_ROOT = estcRoot;
  try {
    const [mergeApi, buildApi, librariesApi] = await Promise.all([
      import(pathToFileURL(path.join(espackRoot, "espack-merge.mjs")).href),
      import(pathToFileURL(path.join(espackRoot, "espack-build.mjs")).href),
      import(pathToFileURL(path.join(espackRoot, "espack-libraries.mjs")).href)
    ]);
    return {
      ...mergeApi,
      ...librariesApi,
      validateManifest: buildApi.validateManifest,
      makeManifest: buildApi.makeManifest
    };
  } finally {
    if (priorEstcRoot === undefined) delete process.env.ESTC_ROOT;
    else process.env.ESTC_ROOT = priorEstcRoot;
  }
}

export async function checkComposedJsx(root, text, file = "essemble.jsx") {
  const checkerPath = path.join(resolveToolInstallation(root, "estc").root, "src", "check-jsx.mjs");
  const { checkJsxText } = await import(pathToFileURL(checkerPath).href);
  return checkJsxText(String(text), {
    file,
    mode: "conservative",
    target: "illustrator",
    requireTarget: false,
    allowIncludes: false,
    allowJson: false,
    allowedMissingBuiltins: [],
    allowedGlobalPatches: []
  });
}
