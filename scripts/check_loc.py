#!/usr/bin/env python3
"""Max-LOC guidance: whole-file line counts vs. per-file ceilings (soft ratchet).

The check REPORTS, it does not block: over-ceiling files, growth past a
frozen ceiling, and unrecorded ratchet wins are printed (and, under GitHub
Actions, surfaced as file annotations on the PR) - the humans and agents
reviewing the change decide what to do. The only mechanical invariant is the
bookkeeping: `--update-baseline` records ratchet wins and never raises a
ceiling, so the frozen numbers can only go down when anyone chooses to
record them.

Whole-file physical line count (the number you see when you open the file).
New or unlisted files are guided to the default ceiling
(scripts/loc-baseline.json); files above it when the ratchet landed are
frozen at their measured size there. Mirrors the TS repo's frozen
test-policy debt baseline (TS PR #2495): counts only go down, wins get
recorded, exceptions carry reasons inline.

Not part of the product.

Usage:
    python3 scripts/check_loc.py                     # report (CI / make loc)
    python3 scripts/check_loc.py --update-baseline    # record ratchet wins
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "loc-baseline.json"

# GitHub caps annotations at 10 per job per type; annotate the worst offenders.
MAX_ANNOTATIONS = 10


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


def check(repo_root: Path, baseline: dict) -> int:
    default_ceiling = baseline["default_ceiling"]
    files = baseline["files"]
    counts = {str(p.relative_to(repo_root)): line_count(p) for p in tracked_rust_files(repo_root)}

    over: list[tuple[str, int, int, str]] = []  # path, loc, ceiling, hint
    wins: list[tuple[str, int, int]] = []  # path, ceiling, loc
    for path, loc in sorted(counts.items()):
        entry = files.get(path)
        ceiling = default_ceiling if entry is None else entry["ceiling"]
        if entry and loc < entry["ceiling"]:
            wins.append((path, entry["ceiling"], loc))
        elif loc > ceiling:
            hint = (
                "new or unlisted file over the default ceiling - split the module, move tests out, or add a justified loc-baseline.json entry"
                if entry is None
                else "grew past its frozen ceiling - shrink/split it, or hand-edit a higher ceiling with a reason (review surface)"
            )
            over.append((path, loc, ceiling, hint))
        if entry and entry["ceiling"] > default_ceiling and not entry.get("reason", "").strip():
            over.append((path, loc, entry["ceiling"], "frozen entry above the default ceiling without a reason - fill it in or drop the entry"))

    stale_entries = [path for path in sorted(files) if path not in counts]

    total = sum(counts.values())
    print(f"{len(counts)} tracked .rs files, {total} lines, {len(over)} files over the {default_ceiling}-line default ceiling (guidance, not a gate)")
    if over:
        print("over-ceiling files (largest first):")
        for path, loc, ceiling, hint in sorted(over, key=lambda t: -(t[1] - t[2]))[:10]:
            print(f"  WARN {loc:6d} > {ceiling:6d}  {path}  ({hint})")
        if len(over) > 10:
            print(f"  ... and {len(over) - 10} more (see the full list in the job log)")
    if wins:
        print(f"{len(wins)} unrecorded ratchet win(s) - record with scripts/check_loc.py --update-baseline, e.g.:")
        for path, ceiling, loc in wins[:5]:
            print(f"  NOTE {path}: {ceiling} -> {loc}")
        if len(wins) > 5:
            print(f"  ... and {len(wins) - 5} more")
    if stale_entries:
        print(f"{len(stale_entries)} stale baseline entr(ies) for files that no longer exist - remove with --update-baseline")

    in_github = os.environ.get("GITHUB_ACTIONS") == "true"
    if in_github:
        for path, loc, ceiling, hint in sorted(over, key=lambda t: -(t[1] - t[2]))[:MAX_ANNOTATIONS]:
            print(f"::warning file={path},line=1,title=LOC guidance::{loc} lines vs ceiling {ceiling} - {hint}")
        for path, ceiling, loc in wins[:MAX_ANNOTATIONS]:
            print(f"::notice file={path},line=1,title=LOC ratchet win::shrank {ceiling} -> {loc}; record with scripts/check_loc.py --update-baseline")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as fh:
                fh.write(f"\n### LOC guidance\n\n{len(counts)} tracked .rs files, {total} lines. "
                         f"**{len(over)} over** the {default_ceiling}-line default ceiling, "
                         f"**{len(wins)} unrecorded ratchet win(s)**, {len(stale_entries)} stale entries. "
                         "(soft ratchet: reports, never blocks; record wins with `scripts/check_loc.py --update-baseline`)\n")

    print("LOC check: report complete (soft ratchet - informational, never blocks)")
    return 0


def update_baseline(repo_root: Path, baseline: dict) -> int:
    """Record wins only: lower ceilings to the measured count, add missing
    over-ceiling files (with an empty reason to fill in), drop entries for
    deleted files. Never raises a ceiling."""
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
            if loc <= default_ceiling:
                del files[path]
                lowered.append(f"{path}: {entry['ceiling']} -> {loc} (graduated; entry removed)")
            else:
                lowered.append(f"{path}: {entry['ceiling']} -> {loc}")
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
