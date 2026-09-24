#!/usr/bin/env python3
"""Max-LOC ratchet: keep tracked Rust files from growing past their ceiling.

Whole-file physical line count (the number you see when you open the file).
The ceiling discipline has two halves:

* New or unlisted files are held to the default ceiling (scripts/loc-baseline.json).
* Files that already exceed it when the ratchet landed are frozen at their
  measured size in the same file; the entry can only go DOWN. A PR that
  shrinks a frozen file must re-record the win with
  `scripts/check_loc.py --update-baseline` (the stale ratchet failure), so
  the win becomes the new ceiling and cannot be given back.

Raising a ceiling is never done by the script: it is a hand-edited
loc-baseline.json diff carrying a non-empty `reason`, and the diff is the
review surface (CI fails entries without a reason). This mirrors the TS
repo's frozen test-policy debt baseline (TS PR #2495): counts can only go
down, wins must be recorded, exceptions must be justified inline.

Not part of the product.

Usage:
    python3 scripts/check_loc.py                     # check (CI / make loc)
    python3 scripts/check_loc.py --update-baseline    # record ratchet wins
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "loc-baseline.json"


def tracked_rust_files(repo_root: Path) -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.rs"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [repo_root / line for line in out.splitlines() if line]


def line_count(path: Path) -> int:
    with path.open(encoding="utf-8", errors="replace") as fh:
        return sum(1 for _ in fh)


def load_baseline() -> dict:
    with BASELINE.open() as fh:
        return json.load(fh)


def save_baseline(data: dict) -> None:
    entries = data["files"]
    data["files"] = dict(sorted(entries.items()))
    with BASELINE.open("w") as fh:
        json.dump(data, fh, indent=1, sort_keys=False)
        fh.write("\n")


def effective(ceiling: int | None, default_ceiling: int) -> int:
    return default_ceiling if ceiling is None else ceiling


def check(repo_root: Path, baseline: dict) -> int:
    default_ceiling = baseline["default_ceiling"]
    files = baseline["files"]
    counts = {str(p.relative_to(repo_root)): line_count(p) for p in tracked_rust_files(repo_root)}

    failures: list[str] = []
    for path, loc in sorted(counts.items()):
        entry = files.get(path)
        ceiling = effective(entry["ceiling"] if entry else None, default_ceiling)
        if entry and loc < entry["ceiling"]:
            failures.append(
                f"stale ratchet: {path} shrank {entry['ceiling']} -> {loc}; "
                "record the win: scripts/check_loc.py --update-baseline"
            )
        elif loc > ceiling:
            hint = (
                "split the module (or move tests out), or justify a baseline entry"
                if not entry
                else "shrink the file, split the module, or hand-edit a higher ceiling with a reason"
            )
            failures.append(f"over ceiling: {path} is {loc} lines, ceiling {ceiling} ({hint})")
        if entry and entry["ceiling"] > default_ceiling and not entry.get("reason", "").strip():
            failures.append(f"unjustified exception: {path} needs a non-empty reason in loc-baseline.json")

    for path in sorted(files):
        if path not in counts:
            failures.append(f"stale entry: {path} no longer exists; remove it from loc-baseline.json")

    total = sum(counts.values())
    over = {p: c for p, c in counts.items() if c > default_ceiling}
    print(f"{len(counts)} tracked .rs files, {total} lines, {len(over)} files over the {default_ceiling}-line default ceiling")
    headroom = sum(files[p]["ceiling"] - c for p, c in counts.items() if p in files)
    print(f"ratchet headroom: {headroom} lines below frozen ceilings")
    if over:
        top = sorted(over.items(), key=lambda kv: -kv[1])[:10]
        print("largest files:")
        for path, loc in top:
            print(f"  {loc:6d}  {path}")
    if failures:
        print()
        for f in failures:
            print(f"FAIL: {f}")
        print(f"\n{len(failures)} LOC-ratchet violation(s)")
        return 1
    print("LOC ratchet: green")
    return 0


def update_baseline(repo_root: Path, baseline: dict) -> int:
    """Record wins only: lower ceilings to the measured count, add missing
    over-ceiling files (with an empty reason the check then rejects), drop
    entries for deleted files. Never raises a ceiling."""
    default_ceiling = baseline["default_ceiling"]
    files = baseline["files"]
    counts = {str(p.relative_to(repo_root)): line_count(p) for p in tracked_rust_files(repo_root)}

    dropped, lowered, added, refused = [], [], [], []
    for path in sorted(files):
        if path not in counts:
            dropped.append(path)
            del files[path]
    for path, loc in sorted(counts.items()):
        entry = files.get(path)
        if entry is None:
            if loc > default_ceiling:
                files[path] = {"ceiling": loc, "reason": ""}
                added.append(f"{path} ({loc} lines over the {default_ceiling} default; fill in the reason)")
            continue
        if loc < entry["ceiling"]:
            lowered.append(f"{path}: {entry['ceiling']} -> {loc}")
            if loc <= default_ceiling:
                # graduated: the file is back under the default ceiling, the
                # default governs it again and the entry retires
                del files[path]
                lowered[-1] = f"{path}: {entry['ceiling']} -> {loc} (graduated; entry removed)"
            else:
                entry["ceiling"] = loc
        elif loc > entry["ceiling"]:
            refused.append(f"{path} is {loc} lines, ceiling {entry['ceiling']}: fix the growth or hand-edit a justified ceiling")

    if dropped:
        print("removed entries for deleted files:")
        for p in dropped:
            print(f"  {p}")
    if lowered:
        print("recorded ratchet wins:")
        for line in lowered:
            print(f"  {line}")
    if added:
        print("added over-ceiling files (fill in the reason or shrink them):")
        for line in added:
            print(f"  {line}")
    if refused:
        print("refused (update never raises a ceiling):")
        for line in refused:
            print(f"  {line}")

    save_baseline(baseline)
    if refused or added:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update-baseline", action="store_true", help="record ratchet wins into loc-baseline.json")
    args = parser.parse_args()

    repo_root = HERE.parent
    baseline = load_baseline()
    if args.update_baseline:
        return update_baseline(repo_root, baseline)
    return check(repo_root, baseline)


if __name__ == "__main__":
    sys.exit(main())
