import test from "node:test";
import assert from "node:assert/strict";
import { parseSubmodules, parseGitlinks, auditReferences } from "../scripts/audit-publication.mjs";

const modules = '[submodule "components/alpha"]\n\tpath = components/alpha\n\turl = https://github.com/thelabcorner/alpha.git\n';
const pin = "a".repeat(40);
const staged = `100644 ${"b".repeat(40)} 0\tREADME.md\n160000 ${pin} 0\tcomponents/alpha\n`;
const lock = { components: { alpha: { sourceType: "git", url: "https://github.com/thelabcorner/alpha.git", revision: pin } } };

test("publication audit accepts exact Gitlinks that match the lock and canonical origin", () => {
  const parsed = parseSubmodules(modules);
  assert.deepEqual(parsed, [{ name: "components/alpha", path: "components/alpha",
    url: "https://github.com/thelabcorner/alpha.git" }]);
  assert.deepEqual(auditReferences(parsed, parseGitlinks(staged), lock),
    { ok: true, errors: [], count: 1 });
});

test("publication audit rejects missing Gitlinks, unexpected origins and revision drift", () => {
  const records = parseSubmodules(modules);
  assert.match(auditReferences(records, new Map(), lock).errors.join("; "), /Missing Gitlink/);
  assert.match(auditReferences(records, parseGitlinks(staged.replace(pin, "c".repeat(40))), lock)
    .errors.join("; "), /Pinned checkout mismatch/);
  const bad = [{ ...records[0], url: "https://example.invalid/alpha.git" }];
  assert.match(auditReferences(bad, parseGitlinks(staged), lock).errors.join("; "),
    /Unexpected submodule origin/);
});