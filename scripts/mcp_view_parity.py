#!/usr/bin/env python3
"""The `/mcp` view's parity harness (TS `ServiceCatalogPickerComponent`).

Drives the REAL TS component (from the read-only TS checkout, through its
own tsx) and the REAL Rust view (the `mcp_view_parity_frames` example)
over identical fixtures, key sequences, and geometry, then diffs the
rendered frames line-for-line — the search field, the rows with their
trailing status, the scroll counter, the one fixed detail line, and the
hint.

Run the TS side on the box (tsx only; no Rust toolchain needed):

    python3 scripts/mcp_view_parity.py --side ts --out /tmp/mcp/ts.json

Run the Rust side where the checkout is built (the gate sandbox):

    python3 scripts/mcp_view_parity.py --side rust \
        --rust-dir /work/repo --out /tmp/mcp/rust.json

Diff the two frame sets:

    python3 scripts/mcp_view_parity.py --diff /tmp/mcp/ts.json /tmp/mcp/rust.json

The fixture is the four-card catalog the `pa-tui` unit tests use (a
connected user stdio server, a connected catalog service with a
record-carried tool count, a connectable OAuth service, and a pasteable
token service) plus the empty catalog; the scenarios cover the open
frame, navigation, the pasteable selection, a search query, and the two
empty states.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WIDTH = 110
VIEWPORT_ROWS = 19

# Canonical key ids -> the raw pi-tui key sequences the TS components take
# (the Rust side receives the canonical ids).
TS_KEY = {
    "down": "\x1b[B",
    "up": "\x1b[A",
    "enter": "\r",
    "escape": "\x1b",
}

ANSI = re.compile(
    r"\x1b\[[0-9;?]*[a-zA-Z]"
    r"|\x1b[\]_^X][^\x07\x1b]*(?:\x07|\x1b\\)"
    r"|\x1b."
)

CARDS = [
    {
        "serviceId": "fixture-echo",
        "label": "fixture-echo",
        "connectionStatus": "connected",
        "connectable": False,
        "usesOAuth": False,
        "source": "user",
        "connectionIds": ["fixture-echo"],
        "pasteToken": False,
        "aliases": [],
    },
    {
        "serviceId": "notion",
        "label": "Notion",
        "connectionStatus": "connected",
        "connectable": False,
        "usesOAuth": True,
        "source": "catalog",
        "connectionIds": ["notion"],
        "pasteToken": False,
        "aliases": [],
        "description": "Notion workflows.",
        "toolCount": 12,
    },
    {
        "serviceId": "linear",
        "label": "Linear",
        "connectionStatus": "not_connected",
        "connectable": True,
        "usesOAuth": True,
        "source": "catalog",
        "connectionIds": [],
        "pasteToken": False,
        "aliases": ["linear-app"],
        "description": "Search and update Linear issues.",
    },
    {
        "serviceId": "github",
        "label": "GitHub",
        "connectionStatus": "setup_required",
        "connectable": False,
        "usesOAuth": False,
        "source": "catalog",
        "connectionIds": [],
        "pasteToken": True,
        "aliases": [],
        "description": "Inspect repositories.",
        "setupHint": "paste a GitHub personal access token",
    },
]

BIG_CARDS = [
    {
        "serviceId": f"service-{index}",
        "label": f"Service {index}",
        "connectionStatus": "not_connected",
        "connectable": True,
        "usesOAuth": True,
        "source": "catalog",
        "connectionIds": [],
        "pasteToken": False,
        "aliases": [],
        "description": "A catalog service.",
    }
    for index in range(69)
]

SCENARIOS = [
    ("open", CARDS, []),
    ("navigate", CARDS, ["down", "down"]),
    ("pasteable", CARDS, ["down", "down", "down"]),
    ("search", CARDS, list("github")),
    ("nomatch", CARDS, list("zzz")),
    ("empty", [], []),
    ("window", BIG_CARDS, ["down"] * 10),
]

ENTRY = """
import { readFileSync } from "node:fs";
import { ServiceCatalogPickerComponent } from {component_path};
import { initTheme } from {theme_path};

initTheme("prime");

const fixturePath = process.argv[2];
const viewportRows = Number(process.argv[3]);
const width = Number(process.argv[4]);
const keys = process.argv[5]
    ? process.argv[5].split(" ").filter((key) => key && key !== "-")
    : [];
const views = JSON.parse(readFileSync(fixturePath, "utf8"));
const picker = new ServiceCatalogPickerComponent(
    views,
    () => {},
    () => {},
    { getRows: () => viewportRows },
);
picker.focused = true;
for (const key of keys) picker.handleInput(key);
for (const line of picker.render(width)) console.log(line);
"""


def normalize(raw_lines: list[str]) -> list[str]:
    """One plain-text trimmed line per rendered row (the diff shape)."""
    return [ANSI.sub("", line).rstrip() for line in raw_lines]


def run(command: list[str], cwd: Path | None = None, env: dict | None = None) -> list[str]:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.splitlines()


def ts_key(key: str) -> str:
    return TS_KEY.get(key, key)


def ts_side(out: Path, ts_checkout: Path) -> None:
    tsx = ts_checkout / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        sys.exit(f"no tsx in the checkout: {tsx}")
    scratch = Path(tempfile.mkdtemp(prefix="mcp-parity-ts-"))
    home = scratch / "home"
    home.mkdir()
    try:
        entry = scratch / "entry.mts"
        component_path = json.dumps(
            str(
                ts_checkout
                / "packages/coding-agent/src/modes/interactive/components/service-catalog-picker.ts"
            )
        )
        theme_path = json.dumps(
            str(
                ts_checkout
                / "packages/coding-agent/src/modes/interactive/theme/theme.ts"
            )
        )
        entry.write_text(
            ENTRY.replace("{component_path}", component_path).replace(
                "{theme_path}", theme_path
            )
        )
        frames: dict[str, list[str]] = {}
        for name, cards, keys in SCENARIOS:
            fixture = scratch / f"{name}.json"
            fixture.write_text(json.dumps(cards))
            raw = run(
                [
                    str(tsx),
                    str(entry),
                    str(fixture),
                    str(VIEWPORT_ROWS),
                    str(WIDTH),
                    " ".join(ts_key(key) for key in keys) or "-",
                ],
                cwd=scratch,
                env={
                    **dict(__import__("os").environ),
                    "HOME": str(home),
                },
            )
            frames[name] = normalize(raw)
        out.write_text(json.dumps(frames, indent=2))
        print(f"TS frames written to {out}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def rust_side(out: Path, rust_dir: Path) -> None:
    frames: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory(prefix="mcp-parity-rust-") as tmp:
        scratch = Path(tmp)
        for name, cards, keys in SCENARIOS:
            fixture = scratch / f"{name}.json"
            fixture.write_text(json.dumps({"connections": [], "services": cards}))
            raw = run(
                [
                    "cargo",
                    "run",
                    "-q",
                    "-p",
                    "pa-tui",
                    "--example",
                    "mcp_view_parity_frames",
                    "--",
                    str(fixture),
                    str(VIEWPORT_ROWS),
                    str(WIDTH),
                    " ".join(keys) or "-",
                ],
                cwd=rust_dir,
            )
            frames[name] = normalize(raw)
    out.write_text(json.dumps(frames, indent=2))
    print(f"Rust frames written to {out}")


def diff_sides(ts_path: Path, rust_path: Path) -> int:
    ts_frames = json.loads(Path(ts_path).read_text())
    rust_frames = json.loads(Path(rust_path).read_text())
    failures = 0
    for name, _cards, _keys in SCENARIOS:
        ts_lines = ts_frames.get(name, [])
        rust_lines = rust_frames.get(name, [])
        if ts_lines == rust_lines:
            print(f"PASS {name}")
            continue
        failures += 1
        print(f"FAIL {name}")
        for index in range(max(len(ts_lines), len(rust_lines))):
            ts_line = ts_lines[index] if index < len(ts_lines) else "<missing>"
            rust_line = rust_lines[index] if index < len(rust_lines) else "<missing>"
            if ts_line != rust_line:
                print(f"  line {index}:")
                print(f"    ts:   {ts_line!r}")
                print(f"    rust: {rust_line!r}")
    if failures:
        print(f"{failures}/{len(SCENARIOS)} scenarios differ")
        return 1
    print(f"all {len(SCENARIOS)} scenarios byte-identical")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", choices=["ts", "rust"])
    parser.add_argument("--diff", nargs=2, metavar=("TS", "RUST"))
    parser.add_argument("--out", type=Path, default=Path("/tmp/mcp-parity.json"))
    parser.add_argument("--ts-checkout", type=Path, default=Path("/home/ubuntu/prime-agent"))
    parser.add_argument("--rust-dir", type=Path, default=Path("."))
    args = parser.parse_args()
    if args.diff:
        return diff_sides(args.diff[0], args.diff[1])
    if not args.side:
        parser.error("one of --side or --diff is required")
    if args.side == "ts":
        ts_side(args.out, args.ts_checkout)
    else:
        rust_side(args.out, args.rust_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
