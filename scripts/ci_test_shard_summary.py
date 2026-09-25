#!/usr/bin/env python3
"""Audit the shard manifests and merge their failure summaries (ci.yml).

The overall test gate is green only when EVERY shard reported and the union of
their executed units still covers the full enumeration. This script verifies
exactly that, so sharding can never silently drop coverage when test targets
are added, renamed, or move packages:

  1. every shard produced a manifest;
  2. all shards enumerated the same unit set (digest match);
  3. shard assignments are disjoint and their union is the whole set;
  4. every shard completed all of its assigned units;
  5. every executed unit passed.

It then prints ONE merged report: which binaries failed, in which shard, with
their failing test names — the single place a lane looks when a PR run goes
red, instead of crawling four job logs.

Usage (from the repo root, in ci.yml's test summary job):

  python3 scripts/ci_test_shard_summary.py --total 4 --dir manifests
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def shard_of(unit_id: str, total: int) -> int:
    # Keep byte-identical with scripts/ci_test_shard.py.
    import zlib
    return zlib.crc32(unit_id.encode("utf-8")) % total


def load_manifests(manifest_dir: Path, total: int):
    manifests = {}
    for path in sorted(manifest_dir.glob("shard-manifest-*.json")):
        shard = json.loads(path.read_text(encoding="utf-8"))
        manifests[shard["shard"]] = shard
    return manifests


def audit(manifests: dict, total: int) -> tuple[list[str], set[str]]:
    """Structural audit failures and the set of failing unit ids."""
    problems = []
    failed_units: set[str] = set()
    for shard in range(1, total + 1):
        if shard not in manifests:
            problems.append(f"shard {shard}: no manifest — the shard job "
                            "crashed, timed out, or was cancelled before "
                            "finishing (see that job's log)")
    if problems:
        return problems, failed_units

    id_lists = {tuple(m["all_unit_ids"]) for m in manifests.values()}
    if len(id_lists) != 1:
        problems.append("shards enumerated different unit sets — the merge "
                        "ref changed mid-run or a manifest is stale; rerun CI")
        return problems, failed_units
    all_ids = manifests[1]["all_unit_ids"]

    executed: dict[str, str] = {}  # unit id -> shard that ran it
    for shard, manifest in sorted(manifests.items()):
        for unit in manifest["units"]:
            uid = unit["id"]
            if uid not in all_ids:
                problems.append(f"shard {shard}: executed unknown unit {uid}")
                continue
            if uid in executed:
                problems.append(f"unit {uid} ran in shards {executed[uid]} "
                                f"and {shard} — assignments must be disjoint")
                continue
            executed[uid] = shard
            if unit["rc"] != 0:
                failed_units.add(uid)

    missing = sorted(set(all_ids) - set(executed))
    if missing:
        problems.append(f"unassigned units (no shard ran them): {missing}")
    extra = sorted(set(executed) - set(all_ids))
    if extra:
        problems.append(f"assigned outside the enumeration: {extra}")

    for shard, manifest in sorted(manifests.items()):
        if not manifest.get("complete", False):
            assigned = [i for i in all_ids if shard_of(i, total) == shard - 1]
            unfinished = sorted(set(assigned) - {u["id"] for u in manifest["units"]})
            problems.append(f"shard {shard} is incomplete; units it never "
                            f"reported: {unfinished}")
    return problems, failed_units


def merged_report(manifests: dict, total: int, problems: list[str],
                  failed_units: set[str]) -> str:
    lines = [f"### test summary ({total} shards)"]
    for shard in sorted(manifests):
        manifest = manifests[shard]
        units = manifest["units"]
        failed = [u for u in units if u["rc"] != 0]
        lines.append(f"- shard {shard}: {len(units) - len(failed)}/{len(units)} "
                     f"units green" + (f", **{len(failed)} failed**" if failed else ""))
    if failed_units:
        lines.append("")
        lines.append(f"**{len(failed_units)} failing test binaries**")
        lines.append("| shard | unit | rc | seconds | failed tests |")
        lines.append("| --- | --- | --- | --- | --- |")
        for shard in sorted(manifests):
            for unit in manifests[shard]["units"]:
                if unit["rc"] == 0:
                    continue
                tests = "<br>".join(unit.get("failed_tests", [])[:20]) or "see log"
                lines.append(f"| {shard} | `{unit['id']}` | {unit['rc']} | "
                             f"{unit['seconds']} | {tests} |")
    if problems:
        lines.append("")
        lines.append("**partition audit FAILED**")
        for problem in problems:
            lines.append(f"- {problem}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--total", type=int, required=True, help="shard count")
    parser.add_argument("--dir", type=Path, required=True,
                        help="directory with shard-manifest-*.json files")
    args = parser.parse_args()

    manifests = load_manifests(args.dir, args.total)
    problems, failed_units = audit(manifests, args.total)
    report = merged_report(manifests, args.total, problems, failed_units)
    print(report)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        Path(step_summary).parent.mkdir(parents=True, exist_ok=True)
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(report + "\n")

    if failed_units:
        print(f"test summary: {len(failed_units)} failing binaries: "
              f"{sorted(failed_units)}")
    if problems:
        print("test summary: PARTITION AUDIT FAILED")
        return 1
    if failed_units:
        return 1
    print(f"test summary: all {sum(len(m['units']) for m in manifests.values())} "
          f"units green across {len(manifests)} shards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
