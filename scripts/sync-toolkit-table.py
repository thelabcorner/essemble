#!/usr/bin/env python3
"""Deterministically synchronize the shared ES* toolkit README table.

The original workspace README skill can own broader multi-repository updates.
This project-local script regenerates its canonical table without executing
any repository code. Nested repositories are opt-in, never modified by default.

Usage:
    python scripts/sync-toolkit-table.py --write
    python scripts/sync-toolkit-table.py --check
    python scripts/sync-toolkit-table.py --check --include-components
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
START = "## Part Of The Same Toolkit"

RUNTIME = (
    ("ESON", "eson", "Strict RFC 8259 JSON for ExtendScript."),
    ("ESB64", "es-b64", "Base64 and UTF-8 utilities."),
    ("ESARR", "es-arr", "ES5+ Array compatibility methods."),
    ("ESSTR", "es-str", "String whitespace and trim methods."),
    ("ESCHARS", "es-chars", "Native bulk byte operations."),
    ("ESHTTP", "es-http", "HTTP transport for ExtendScript automation."),
    ("ESTIMER", "es-timer", "Microsecond timing for ExtendScript automation."),
    ("ESRAND", "es-rand", "Deterministic random streams and sampling for ExtendScript."),
    ("ESUUID", "es-uuid", "RFC 9562 UUID generation, parsing, and conversion for ExtendScript."),
    ("ESENV", "es-env", "Environment and capability detection for ExtendScript."),
    ("ESPATH", "es-path", "Deterministic Windows/POSIX path and RFC 8089 file-URI transformations."),
    ("ESFS", "es-fs", "Synchronous ExtendScript File/Folder I/O with explicit text, BINARY, and replacement semantics."),
    ("ESHASH", "es-hash", "CRC-32/ISO-HDLC and SHA-256 for byte strings and UTF-8 text."),
    ("ESLOG", "es-log", "Structured logging with bounded text and JSONL sinks."),
)
BUILD = (
    ("ESPACK", "espack", "Self-extracting ExternalObject bundles."),
    ("ESMIN", "es-min", "Minification for shipped JSX bundles."),
    ("ESABI", "esabi", "Modern ExternalObject ABI declarations for native integrations."),
    ("VectorIPC", "vector-ipc", "Bounded local IPC for scripting hosts and native plug-ins."),
    ("ESTC", "estc", "TypeScript-to-ExtendScript build, compatibility, and live-parse tooling."),
    ("ESDB", "esdb", "Native state and durable storage for Adobe tooling."),
    ("COMTool", "COMTool", "Guarded COM, ExtendScript, plug-in, and debugger automation for Adobe desktop apps."),
    ("ESsemble", "essemble", "Typed framework, resolver, and composition layer for the ExtendScript toolkit."),
)


def lines_for(items: tuple[tuple[str, str, str], ...]) -> list[str]:
    rows = []
    for name, repo, description in items:
        rows.extend((
            f"**[{name}](https://github.com/thelabcorner/{repo})**<br />",
            description,
            "",
        ))
    return rows


def canonical_table() -> str:
    content = [
        START,
        "",
        "> Production-grade infrastructure for Adobe ExtendScript.",
        "",
        "<table>",
        "<tr>",
        '<td width="50%" valign="top">',
        "",
        "### Runtime Primitives",
        "",
        *lines_for(RUNTIME),
        "</td>",
        '<td width="50%" valign="top">',
        "",
        "### Build & Integration Tools",
        "",
        *lines_for(BUILD),
        "</td>",
        "</tr>",
        "</table>",
    ]
    return "\n".join(content)


def rewrite(original: str, replacement: str) -> str:
    pattern = re.compile(r"(?m)^## Part Of The Same Toolkit\s*$")
    matches = list(pattern.finditer(original))
    if len(matches) != 1:
        raise ValueError("Expected exactly one 'Part Of The Same Toolkit' section")
    start = matches[0].start()
    close = original.find("</table>", start)
    if close == -1:
        raise ValueError("Toolkit table has no closing </table> tag")
    end = close + len("</table>")
    return original[:start] + replacement + original[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="Update out-of-sync tables")
    mode.add_argument("--check", action="store_true", help="Fail if a table is not canonical")
    parser.add_argument("--include-components", action="store_true",
                        help="Include nested component repositories (changes remain uncommitted)")
    options = parser.parse_args()

    targets = [ROOT / "README.md"]
    if options.include_components:
        targets.extend(sorted((ROOT / "components").glob("*/README.md")))
    changed = 0
    for target in targets:
        original = target.read_text(encoding="utf-8")
        try:
            updated = rewrite(original, canonical_table())
        except ValueError as error:
            print(f"ERROR {target.relative_to(ROOT)}: {error}", file=sys.stderr)
            return 2
        relative = target.relative_to(ROOT)
        if original == updated:
            print(f"PASS {relative}")
        elif options.check:
            print(f"DRIFT {relative}")
            changed += 1
        else:
            target.write_text(updated, encoding="utf-8", newline="\n")
            print(f"UPDATED {relative}")
            changed += 1
    print(f"Tables: {len(targets)}, changed: {changed}")
    return 1 if options.check and changed else 0


if __name__ == "__main__":
    raise SystemExit(main())