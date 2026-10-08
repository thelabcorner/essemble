#!/usr/bin/env python3
"""Synchronize canonical ES* README toolkit tables across independent GitHub repositories.

The canonical table is defined by sync-toolkit-table.py. Reads and writes use
the authenticated GitHub CLI's Contents API, not local working trees, to avoid
staging or overwriting unrelated edits in independently active repositories.
All remote writes use the current content SHA as an optimistic concurrency
lease, and each write is verified with a fresh remote read.

Usage:
  python scripts/sync-es-repo-readmes.py --check
  python scripts/sync-es-repo-readmes.py --publish
  python scripts/sync-es-repo-readmes.py --check --repos eson,essemble
"""

from __future__ import annotations

import argparse
import base64
import difflib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys

SKILL = runpy.run_path(str(Path(__file__).with_name("sync-toolkit-table.py")))
TABLE = SKILL["canonical_table"]()
ALL_REPOSITORIES = tuple(
    name for _label, name, _description in
    (*SKILL["RUNTIME"], *SKILL["BUILD"])
)
OWNER = "thelabcorner"
TITLE = "## Part Of The Same Toolkit"


def github_api(endpoint: str, *, method: str = "GET", data: dict | None = None) -> dict:
    command = ["gh", "api", "-H", "Accept: application/vnd.github+json", endpoint]
    if method != "GET":
        command.extend(["--method", method, "--input", "-"])
    try:
        result = subprocess.run(
            command, input=json.dumps(data) if data is not None else None,
            capture_output=True, text=True, encoding="utf-8", timeout=60,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"GitHub CLI unavailable: {error}") from error
    if result.returncode:
        raise RuntimeError(
            f"GitHub {method} {endpoint}: {result.stderr.strip() or result.stdout.strip()}"
        )
    return json.loads(result.stdout)


def read_remote(repository: str) -> tuple[str, str]:
    doc = github_api(f"repos/{OWNER}/{repository}/contents/README.md")
    if doc.get("type") != "file" or doc.get("encoding") != "base64":
        raise ValueError(f"{repository}: expected a base64 README.md file")
    content = base64.b64decode(doc["content"]).decode("utf-8")
    return content, doc["sha"]


def rewrite(original: str) -> str:
    matches = list(re.finditer(r"(?m)^## Part Of The Same Toolkit[ \t]*\r?$", original))
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one '{TITLE}' heading (found {len(matches)})")
    start = matches[0].start()
    end = original.find("</table>", start)
    if end < 0:
        raise ValueError("No closing </table> after toolkit heading")
    end += len("</table>")
    replacement = TABLE.replace("\n", "\r\n") if "\r\n" in original else TABLE
    return original[:start] + replacement + original[end:]


def synchronize(repository: str, *, publish: bool, verbose: bool) -> str:
    original, sha = read_remote(repository)
    updated = rewrite(original)
    if updated == original:
        print(f"PASS    {OWNER}/{repository}: already canonical")
        return "pass"
    before = original.count("\n")
    after = updated.count("\n")
    if verbose:
        print("".join(difflib.unified_diff(
            original.splitlines(keepends=True), updated.splitlines(keepends=True),
            fromfile=f"{repository}/README.md", tofile=f"{repository}/README.md"
        )))
    if not publish:
        print(f"DRIFT   {OWNER}/{repository}: {before} -> {after} lines")
        return "drift"

    # A content-SHA lease prevents racing another author's new README commit.
    github_api(
        f"repos/{OWNER}/{repository}/contents/README.md",
        method="PUT",
        data={
            "message": "docs: synchronize ES* toolkit README table",
            "content": base64.b64encode(updated.encode("utf-8")).decode("ascii"),
            "sha": sha,
        },
    )
    confirmed, _new_sha = read_remote(repository)
    if confirmed != updated:
        raise RuntimeError(f"{repository}: post-publication README verification failed")
    print(f"UPDATED {OWNER}/{repository}: remote README verified")
    return "updated"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Read-only GitHub drift audit")
    mode.add_argument("--publish", action="store_true", help="Commit changed README tables on GitHub")
    parser.add_argument("--repos", help="Comma-separated repository names; default is all public toolkit entries")
    parser.add_argument("--diff", action="store_true", help="Print proposed text changes")
    args = parser.parse_args()
    names = tuple(name.strip() for name in args.repos.split(",")) if args.repos else ALL_REPOSITORIES
    if not names or len(set(names)) != len(names) or any(name not in ALL_REPOSITORIES for name in names):
        parser.error("Repository names must be unique entries from the canonical toolkit")
    counts = {"pass": 0, "drift": 0, "updated": 0, "failed": 0}
    for name in names:
        try:
            result = synchronize(name, publish=args.publish, verbose=args.diff)
            counts[result] += 1
        except (RuntimeError, ValueError, KeyError, UnicodeError) as error:
            counts["failed"] += 1
            print(f"ERROR   {OWNER}/{name}: {error}", file=sys.stderr)
    print(f"SUMMARY repositories={len(names)} " +
          " ".join(f"{key}={value}" for key, value in counts.items()))
    return 1 if counts["failed"] or (args.check and counts["drift"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())