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

Artifact selection uses the latest *available* manifest per shard. A rerun
that crashes before uploading a manifest cannot be inferred from artifacts;
the matrix job's own failure remains a separate required CI gate.

Usage (from the repo root, in ci.yml's test summary job):

  python3 scripts/ci_test_shard_summary.py --total 4 --dir manifests
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


def shard_of(unit_id: str, total: int) -> int:
    # Keep byte-identical with scripts/ci_test_shard.py.
    import zlib
    return zlib.crc32(unit_id.encode("utf-8")) % total


def load_manifests(manifest_dir: Path, total: int):
    """Choose the newest numeric attempt independently for each shard."""
    candidates = {}
    problems = []
    pattern = re.compile(r"shard-manifest-(\d+)(?:-attempt-(\d+))?\.json")
    for path in sorted(manifest_dir.glob("shard-manifest-*.json")):
        match = pattern.fullmatch(path.name)
        if not match:
            problems.append(f"unrecognized manifest filename: {path.name}")
            continue
        shard_number, attempt = int(match[1]), int(match[2] or 1)
        if not 1 <= shard_number <= total or attempt < 1:
            problems.append(f"invalid shard/attempt in {path.name}")
            continue
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict):
                raise ValueError("JSON root must be an object")
            recorded_attempt = manifest.get("run_attempt", 1)
            if (type(manifest["shard"]) is not int or manifest["shard"] != shard_number
                    or type(manifest["total"]) is not int or manifest["total"] != total
                    or type(recorded_attempt) is not int or recorded_attempt != attempt):
                raise ValueError("filename, shard, total, or attempt metadata disagree")
            if ((os.environ.get("GITHUB_RUN_ID") and
                 manifest.get("run_id") != os.environ["GITHUB_RUN_ID"]) or
                (os.environ.get("GITHUB_SHA") and
                 manifest.get("commit_sha") != os.environ["GITHUB_SHA"])):
                raise ValueError("run/commit identity mismatch")
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems.append(f"{path.name}: invalid manifest: {error}")
            continue
        key = (shard_number, attempt)
        if key in candidates:
            problems.append(f"shard {shard_number} attempt {attempt}: duplicate manifests "
                            f"({candidates[key][0].name}, {path.name})")
        else:
            candidates[key] = (path, manifest)
    manifests = {}
    retained = {}
    for shard in range(1, total + 1):
        attempts = sorted(attempt for number, attempt in candidates if number == shard)
        if attempts:
            manifests[shard] = candidates[(shard, attempts[-1])][1]
            retained[shard] = attempts[:-1]
    return manifests, retained, problems


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
    incomplete = []
    for shard, manifest in sorted(manifests.items()):
        if not isinstance(manifest.get("all_unit_ids"), list) or not isinstance(manifest.get("units"), list):
            problems.append(f"shard {shard}: missing enumeration or unit results")
        elif (any(not isinstance(uid, str) for uid in manifest["all_unit_ids"])
              or any(not isinstance(unit, dict) or not isinstance(unit.get("id"), str)
                     or type(unit.get("rc")) is not int
                     for unit in manifest["units"])):
            problems.append(f"shard {shard}: malformed enumeration or unit results")
        if "selected_unit_ids" in manifest and (
                not isinstance(manifest["selected_unit_ids"], list)
                or any(not isinstance(uid, str) for uid in manifest["selected_unit_ids"])):
            problems.append(f"shard {shard}: malformed selected unit ids")
        if manifest.get("complete") is not True:
            incomplete.append(f"shard {shard} is incomplete: complete must be literal true")
        scope = manifest.get("scope", {"kind": "all"})
        if (not isinstance(scope, dict) or scope.get("kind") not in ("all", "crates")
                or (scope.get("kind") == "all" and "crates" in scope)
                or (scope.get("kind") == "crates" and
                    (not isinstance(scope.get("crates"), list) or
                     any(not isinstance(crate, str) for crate in scope["crates"])))):
            problems.append(f"shard {shard}: invalid selection scope")
    if problems:
        return problems + incomplete, failed_units

    identities = {(m.get("run_id"), m.get("commit_sha")) for m in manifests.values()}
    if (len(identities) != 1 or any(not run_id or not sha for run_id, sha in identities)
            or (os.environ.get("GITHUB_RUN_ID") and
                any(run_id != os.environ["GITHUB_RUN_ID"] for run_id, _ in identities))
            or (os.environ.get("GITHUB_SHA") and
                any(sha != os.environ["GITHUB_SHA"] for _, sha in identities))):
        problems.append("selected shards have mismatched or missing run/commit identity")
        return problems + incomplete, failed_units

    id_lists = {tuple(m["all_unit_ids"]) for m in manifests.values()}
    if len(id_lists) != 1:
        problems.append("shards enumerated different unit sets — the merge "
                        "ref changed mid-run or a manifest is stale; rerun CI")
        return problems + incomplete, failed_units
    all_ids = manifests[1]["all_unit_ids"]
    if len(all_ids) != len(set(all_ids)):
        problems.append("enumeration contains duplicate unit ids")
    expected_digest = hashlib.sha256("\n".join(all_ids).encode("utf-8")).hexdigest()
    for shard, manifest in sorted(manifests.items()):
        if manifest.get("digest") != expected_digest:
            problems.append(f"shard {shard}: enumeration digest mismatch")
    if problems:
        return problems + incomplete, failed_units

    kind, crates = run_scope(manifests)
    if kind == "MIXED":
        described = sorted(json.dumps(m.get("scope"), sort_keys=True)
                           for m in manifests.values())
        problems.append("shards recorded different selection scopes — a "
                        "mixed-scope wave is a broken partition: " +
                        ", ".join(described))
        return problems + incomplete, failed_units
    selection = selected_ids(manifests[1], crates)
    selection_set = set(selection)
    expected_selection = [uid for uid in all_ids if crates is None or _unit_package(uid) in set(crates)]
    for shard, manifest in sorted(manifests.items()):
        if selected_ids(manifest, crates) != expected_selection:
            problems.append(f"shard {shard}: selected unit ids disagree with scope/enumeration")
    if problems:
        return problems + incomplete, failed_units

    executed: dict[str, str] = {}  # unit id -> shard that ran it
    for shard, manifest in sorted(manifests.items()):
        for unit in manifest["units"]:
            uid = unit["id"]
            if uid not in all_ids:
                problems.append(f"shard {shard}: executed unknown unit {uid}")
                continue
            if shard_of(uid, total) != shard - 1:
                problems.append(f"shard {shard}: unit {uid} belongs to shard {shard_of(uid, total) + 1}")
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
        if manifest.get("complete") is not True:
            assigned = [i for i in selection if shard_of(i, total) == shard - 1]
            unfinished = sorted(set(assigned) - {u["id"] for u in manifest["units"]})
            problems.append(f"shard {shard} is incomplete; units it never "
                            f"reported: {unfinished}")
    return problems + incomplete, failed_units


def merged_report(manifests: dict, total: int, problems: list[str],
                  failed_units: set[str], retained: dict | None = None) -> str:
    if problems:
        lines = [f"### test summary ({total} shards)",
                 "- attempt selection: latest available manifest per shard; the matrix job "
                 "separately reports reruns that uploaded no manifest"]
        for shard in sorted(manifests):
            older = (retained or {}).get(shard, [])
            lines.append(f"- shard {shard}: selected attempt "
                         f"{manifests[shard].get('run_attempt', 1)}; retained prior attempts: "
                         f"{', '.join(map(str, older)) if older else 'none'}")
        lines.extend(["", "**partition audit FAILED**", *(f"- {problem}" for problem in problems)])
        return "\n".join(lines)
    kind, crates = run_scope(manifests) if manifests else ("all", None)
    scope = ("full selection" if kind == "all"
             else f"crate selection: {', '.join(crates or [])}")
    selected = selected_ids(manifests.get(1, {"all_unit_ids": []}), crates)
    union_size = len(manifests.get(1, {}).get("all_unit_ids", []))
    lines = [f"### test summary ({total} shards)",
             f"- scope: {scope} — {len(selected)} of {union_size} units selected",
             "- attempt selection: latest available manifest per shard; the matrix job "
             "separately reports reruns that uploaded no manifest"]
    for shard in range(1, total + 1):
        if shard in manifests:
            attempt = manifests[shard].get("run_attempt", 1)
            older = (retained or {}).get(shard, [])
            lines.append(f"- shard {shard}: selected attempt {attempt}; retained prior attempts: "
                         f"{', '.join(map(str, older)) if older else 'none'}")
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

    manifests, retained, load_problems = load_manifests(args.dir, args.total)
    audit_problems, failed_units = audit(manifests, args.total)
    problems = load_problems + audit_problems
    report = merged_report(manifests, args.total, problems, failed_units, retained)
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
