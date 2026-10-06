#!/usr/bin/env python3
"""Audit the shard manifests and merge their failure summaries (ci.yml).

The overall test gate is green only when EVERY shard reported and the union
of their executed units still covers the run's SELECTION — the full
enumeration on push runs (main is the authority), or the touched crates'
subset on the PR smoke (`--crates`, recorded by every shard as the run's
`scope`). This script verifies exactly that, so sharding can never silently
drop coverage when test targets are added, renamed, or move packages — and a
narrowed run can never masquerade as a full one:

  1. every shard produced a manifest;
  2. all shards enumerated the same unit set (digest match);
  3. all shards record the SAME selection scope (a mixed-scope wave is a
     broken partition; the summary names it instead of auditing a chimera);
  4. shard assignments are disjoint and their union is the selected set
     (nothing selected is skipped, nothing outside the selection ran);
  5. every shard completed all of its selected units;
  6. every executed unit passed.

It then prints ONE merged report: the scope, which binaries failed, in which
shard, with their failing test names — the single place a lane looks when a
PR run goes red, instead of crawling the job logs.

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


def run_scope(manifests: dict) -> tuple[str, list[str] | None]:
    """The wave's selection scope, from the manifests (one source of truth)."""
    scopes = {json.dumps(m.get("scope", {"kind": "all"}), sort_keys=True)
              for m in manifests.values()}
    if len(scopes) != 1:
        return "MIXED", None
    scope = json.loads(next(iter(scopes)))
    return scope.get("kind", "all"), scope.get("crates")


def selected_ids(manifest: dict, crates: list[str] | None) -> list[str]:
    """The selected universe: the manifest's recorded selection, or (older
    manifests without one) the full enumeration."""
    if "selected_unit_ids" in manifest:
        return manifest["selected_unit_ids"]
    all_ids = manifest["all_unit_ids"]
    if crates is None:
        return all_ids
    packages = set(crates)
    return [i for i in all_ids if _unit_package(i) in packages]


def _unit_package(unit_id: str) -> str:
    return unit_id.split("#", 1)[0]


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

    kind, crates = run_scope(manifests)
    if kind == "MIXED":
        described = sorted(json.dumps(m.get("scope"), sort_keys=True)
                           for m in manifests.values())
        problems.append("shards recorded different selection scopes — a "
                        "mixed-scope wave is a broken partition: " +
                        ", ".join(described))
        return problems, failed_units
    selection = selected_ids(manifests[1], crates)
    selection_set = set(selection)

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

    missing = sorted(selection_set - set(executed))
    if missing:
        problems.append(f"selected units no shard ran: {missing}")
    extra = sorted(set(executed) - selection_set)
    if extra:
        problems.append(f"units outside the selection ran: {extra}")
    outside = sorted(set(executed) - set(all_ids))
    if outside:
        problems.append(f"assigned outside the enumeration: {outside}")

    for shard, manifest in sorted(manifests.items()):
        if not manifest.get("complete", False):
            assigned = [i for i in selection if shard_of(i, total) == shard - 1]
            unfinished = sorted(set(assigned) - {u["id"] for u in manifest["units"]})
            problems.append(f"shard {shard} is incomplete; units it never "
                            f"reported: {unfinished}")
    return problems, failed_units


def merged_report(manifests: dict, total: int, problems: list[str],
                  failed_units: set[str]) -> str:
    kind, crates = run_scope(manifests)
    scope = ("full selection" if kind == "all"
             else f"crate selection: {', '.join(crates or [])}")
    selected = selected_ids(manifests.get(1, {"all_unit_ids": []}), crates)
    union_size = len(manifests.get(1, {}).get("all_unit_ids", []))
    lines = [f"### test summary ({total} shards)",
             f"- scope: {scope} — {len(selected)} of {union_size} units selected"]
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
