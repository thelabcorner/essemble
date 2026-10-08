#!/usr/bin/env node
/**
 * Validate the independently published Git submodule contract before sharing
 * ESsemble. No nested repository is staged, reset, cloned or modified.
 * --remote additionally checks public Git reachability of every exact pin.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "thelabcorner";
const execFileAsync = promisify(execFile);

export function parseSubmodules(source) {
  const records = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    const heading = /^\[submodule "([^"]+)"\]$/.exec(line.trim());
    if (heading) {
      if (current) records.push(current);
      current = { name: heading[1] };
      continue;
    }
    const field = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(line);
    if (current && field) current[field[1]] = field[2];
  }
  if (current) records.push(current);
  return records;
}

export function parseGitlinks(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = /^160000 ([0-9a-f]{40}) 0\t(.+)$/.exec(line);
    if (match) entries.set(match[2], match[1]);
  }
  return entries;
}

export function auditReferences(records, links, lock) {
  const errors = [];
  const seen = new Set();
  const componentByUrl = new Map(Object.entries(lock.components || {})
    .filter(([, value]) => value?.sourceType === "git")
    .map(([name, value]) => [value.url, { name, revision: value.revision }]));
  const seenUrls = new Set();
  for (const record of records) {
    const { path: location, name, url } = record;
    if (name !== location || !location?.startsWith("components/") ||
      !/^components\/[a-z0-9-]+$/.test(location)) {
      errors.push(`Invalid submodule path/name: ${name} / ${location}`);
    }
    if (seen.has(location)) errors.push(`Duplicate submodule: ${location}`);
    seen.add(location);
    seenUrls.add(url);
    if (!new RegExp(`^https://github\\.com/${OWNER}/[A-Za-z0-9._-]+\\.git$`).test(url || "")) {
      errors.push(`Unexpected submodule origin for ${location}: ${url}`);
    }
    const linkedSha = links.get(location);
    if (!linkedSha) errors.push(`Missing Gitlink for ${location}`);
    const component = componentByUrl.get(url);
    if (!component) errors.push(`No Git source lock entry for ${location}`);
    else if (linkedSha !== component.revision) {
      errors.push(`Pinned checkout mismatch: ${location} link=${linkedSha} lock=${component.revision}`);
    }
  }
  for (const location of links.keys()) {
    if (location.startsWith("components/") && !seen.has(location)) {
      errors.push(`Gitlink not declared in .gitmodules: ${location}`);
    }
  }
  for (const url of componentByUrl.keys()) {
    if (!seenUrls.has(url)) {
      errors.push(`Locked Git component lacks submodule: ${url}`);
    }
  }
  return { ok: errors.length === 0, errors, count: records.length };
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...options
  }).trim();
}

async function remoteGit(args, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: ROOT, timeout: 35000, maxBuffer: 1024 * 1024,
    windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...options
  });
  return stdout.trim();
}

async function verifyPinRemote(record, revision) {
  const head = (await remoteGit(["-c", "credential.helper=", "ls-remote", record.url, "HEAD"],
    { timeout: 25000 })).split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Remote HEAD is not a Git commit SHA");
  if (head === revision) return { ...record, revision, head, ok: true, source: "HEAD" };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "essemble-publication-"));
  try {
    await remoteGit(["init", "--bare", "--quiet"], { cwd: directory });
    await remoteGit([
        "-c", "credential.helper=", "fetch", "--quiet", "--depth=1",
        "--no-tags", record.url, revision
      ], { cwd: directory });
    return { ...record, revision, head, ok: true, source: "exact-commit" };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const remote = process.argv.includes("--remote");
  const json = process.argv.includes("--json");
  const [modules, lockText, readme] = await Promise.all([
    fs.readFile(path.join(ROOT, ".gitmodules"), "utf8"),
    fs.readFile(path.join(ROOT, "essemble.lock.json"), "utf8"),
    fs.readFile(path.join(ROOT, "README.md"), "utf8")
  ]);
  const records = parseSubmodules(modules);
  const links = parseGitlinks(git(["ls-files", "--stage"]));
  const report = auditReferences(records, links, JSON.parse(lockText));
  if (!readme.includes("https://github.com/thelabcorner/essemble")) {
    report.errors.push("README lacks canonical ESsemble GitHub link");
    report.ok = false;
  }
  report.remote = [];
  if (report.ok && remote) {
    // Constrain network work so GitHub isn't hammered by 19 parallel fetches.
    let index = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (index < records.length) {
        const i = index++;
        const item = records[i];
        try {
          report.remote[i] = await verifyPinRemote(item, links.get(item.path));
        } catch (error) {
          report.remote[i] = { ...item, ok: false, error: String(error.message || error).slice(0, 500) };
          report.errors.push(`Unfetchable pinned submodule ${item.path}`);
          report.ok = false;
        }
      }
    });
    await Promise.all(workers);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ESsemble publication audit: ${report.ok ? "PASS" : "FAIL"} (${report.count} Git submodules)`);
    for (const record of report.remote) console.log(`${record.ok ? "OK" : "FAIL"} ${record.path} ${record.source || record.error}`);
    for (const issue of report.errors) console.error(issue);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}