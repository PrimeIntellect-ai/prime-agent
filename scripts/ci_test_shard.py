#!/usr/bin/env python3
"""Stable-hash test sharding for the ci.yml mandatory test gate.

`cargo test --workspace` runs every test binary serially in one job; at the
current suite size that phase alone bills ~13 minutes per push and per PR.
This script enumerates the workspace's test units the same way cargo does
(via `cargo metadata --no-deps`, no build) and runs the subset assigned to one
shard of N by a STABLE hash: every unit id is mapped with crc32(unit) % N,
so a unit lands in exactly one shard on every run — binaries never move
between shards when the suite grows or shrinks, keeping flake attribution
stable.

Unit kinds (the exact set `cargo test --workspace` builds and runs):
  lib   — package lib unittests            (`cargo test -p PKG --lib`)
  bin   — package bin unittests            (`cargo test -p PKG --bin NAME`)
  test  — tests/ integration target        (`cargo test -p PKG --test NAME`)
  doc   — package doctests                 (`cargo test -p PKG --doc`)
  examples/benches — compile parity targets: `cargo test --workspace` builds
          example and bench targets without running them; the owning shard
          reproduces exactly that with `--examples --no-run` / `--benches
          --no-run`.

Every unit runs as its own cargo invocation, streams live to the log, and is
recorded in the shard manifest (JSON) the summary job audits: the union of
shard manifests must equal the full enumeration, so coverage can never
silently regress when targets are added or renamed.

Usage (from the repo root, e.g. in ci.yml):

  python3 scripts/ci_test_shard.py --shard 2 --total 4 \
      --manifest shard-manifest.json
  python3 scripts/ci_test_shard.py --list   # enumerate + shard assignment
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
# `cargo test --workspace` builds examples and benches to prove they compile
# but never runs them; the owning shard repeats the same build-only contract.
COMPILE_ONLY_KINDS = ("examples", "benches")


def _target_flag(kind: str, name: str | None) -> list[str]:
    if kind == "lib":
        return ["--lib"]
    if kind == "bin":
        return ["--bin", name or ""]
    if kind == "test":
        return ["--test", name or ""]
    if kind == "doc":
        return ["--doc"]
    if kind in COMPILE_ONLY_KINDS:
        return [f"--{kind}", "--no-run"]
    raise ValueError(f"unknown unit kind {kind!r}")


def _unit_id(package: str, kind: str, name: str | None) -> str:
    if kind in COMPILE_ONLY_KINDS or kind == "doc":
        return f"{package}#{kind}"
    return f"{package}#{kind}:{name}"


def shard_of(unit_id: str, total: int) -> int:
    return zlib.crc32(unit_id.encode("utf-8")) % total


def enumerate_units() -> list[dict]:
    """The workspace's test units, exactly what `cargo test --workspace` covers.

    `cargo metadata --no-deps` reads the manifests without building; targets
    carry the same test/doctest flags cargo honors, so this enumeration is
    byte-identical to what the serial workspace test would build and run.
    """
    out = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--no-deps"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    )
    packages = json.loads(out.stdout)["packages"]
    units = []
    for pkg in packages:
        name = pkg["name"]
        has_examples = has_benches = False
        for target in pkg["targets"]:
            kinds = target["kind"]
            tname = target["name"]
            if ("lib" in kinds or "proc-macro" in kinds) and target.get("test", True):
                units.append({"package": name, "kind": "lib", "name": tname})
            if "bin" in kinds and target.get("test", True):
                units.append({"package": name, "kind": "bin", "name": tname})
            if "test" in kinds:
                units.append({"package": name, "kind": "test", "name": tname})
            if "example" in kinds:
                has_examples = True
            if "bench" in kinds:
                has_benches = True
        # Doc tests: one cargo `--doc` run covers every doctest=true target of
        # the package (lib and bins alike), matching the workspace behavior.
        if any(t.get("doctest", False) for t in pkg["targets"]):
            units.append({"package": name, "kind": "doc", "name": None})
        if has_examples:
            units.append({"package": name, "kind": "examples", "name": None})
        if has_benches:
            units.append({"package": name, "kind": "benches", "name": None})
    for unit in units:
        unit["id"] = _unit_id(unit["package"], unit["kind"], unit["name"])
        unit["target_args"] = _target_flag(unit["kind"], unit["name"])
    return sorted(units, key=lambda u: u["id"])


def run_unit(unit: dict) -> dict:
    cmd = ["cargo", "test", "--locked", "-p", unit["package"], *unit["target_args"]]
    start = time.monotonic()
    # Streaming (not capture-then-print) so a hung binary is attributable from
    # the live log: the unit header is printed before the invocation starts.
    proc = subprocess.Popen(
        cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace",
    )
    output_lines = []
    assert proc.stdout is not None
    for raw in proc.stdout:
        print(raw, end="")
        output_lines.append(raw.rstrip("\n"))
    rc = proc.wait()
    result = dict(unit)
    result["rc"] = rc
    result["seconds"] = round(time.monotonic() - start, 1)
    result["failed_tests"] = _failed_tests(output_lines)
    return result


def _failed_tests(lines: list[str]) -> list[str]:
    """Test names cargo lists under the `failures:` blocks of a red binary.

    The harness prints a `failures:` section header before the per-test
    stdout dumps and then the closing `failures:` block with the name list;
    every block is scanned, so the closing list is always found.
    """
    names, in_block = [], False
    for line in lines:
        if line.strip() == "failures:" and not in_block:
            in_block = True
            continue
        if not in_block:
            continue
        if not line.strip():
            continue  # blank lines sit around the failure name list
        if line.startswith("    ") and not line.lstrip().startswith("..."):
            names.append(line.strip())
        else:
            in_block = False  # a stdout dump or result line closes the block
    return list(dict.fromkeys(names))


def write_manifest(path: Path, shard: int, total: int, all_ids: list[str],
                   results: list[dict]) -> None:
    manifest = {
        "schema": 1,
        "shard": shard,
        "total": total,
        "all_unit_ids": all_ids,
        "digest": hashlib.sha256("\n".join(all_ids).encode("utf-8")).hexdigest(),
        "units": results,
        "complete": len(results) == sum(1 for i in all_ids if shard_of(i, total) == shard - 1),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def summary_md(shard: int, total: int, results: list[dict]) -> str:
    failed = [r for r in results if r["rc"] != 0]
    lines = [
        f"### test shard {shard}/{total}",
        f"- {len(results) - len(failed)}/{len(results)} units green",
    ]
    if failed:
        lines.append(f"- **{len(failed)} failed:**")
        lines.append("| unit | rc | seconds | failed tests |")
        lines.append("| --- | --- | --- | --- |")
        for r in failed:
            tests = "<br>".join(r["failed_tests"][:20]) or "see log"
            lines.append(f"| `{r['id']}` | {r['rc']} | {r['seconds']} | {tests} |")
    else:
        lines.append("- no failures")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--shard", type=int, required=True, help="1-based shard index")
    parser.add_argument("--total", type=int, required=True, help="shard count")
    parser.add_argument("--manifest", type=Path, default=None,
                        help="write the per-shard JSON manifest here")
    parser.add_argument("--list", action="store_true",
                        help="print the enumeration and shard assignment, run nothing")
    args = parser.parse_args()
    if not 1 <= args.shard <= args.total:
        parser.error("--shard must be in 1..--total")

    units = enumerate_units()
    all_ids = [u["id"] for u in units]
    mine = [u for u in units if shard_of(u["id"], args.total) == args.shard - 1]
    print(f"[shard {args.shard}/{args.total}] {len(mine)}/{len(units)} units")

    if args.list:
        for u in units:
            print(f"  shard {shard_of(u['id'], args.total) + 1}: {u['id']}")
        return 0

    results = []
    for u in mine:
        print(f"[shard {args.shard}/{args.total}] RUN {u['id']} "
              f"(cargo test --locked -p {u['package']} {' '.join(u['target_args'])})")
        result = run_unit(u)
        verdict = "PASS" if result["rc"] == 0 else f"FAIL rc={result['rc']}"
        print(f"[shard {args.shard}/{args.total}] {verdict} {u['id']} "
              f"in {result['seconds']}s")
        results.append(result)
        if args.manifest:
            write_manifest(args.manifest, args.shard, args.total, all_ids, results)

    if args.manifest:
        write_manifest(args.manifest, args.shard, args.total, all_ids, results)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        Path(step_summary).parent.mkdir(parents=True, exist_ok=True)
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(summary_md(args.shard, args.total, results) + "\n")

    failed = [r["id"] for r in results if r["rc"] != 0]
    if failed:
        print(f"[shard {args.shard}/{args.total}] FAILED UNITS: {', '.join(failed)}")
        return 1
    print(f"[shard {args.shard}/{args.total}] all {len(results)} units green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
