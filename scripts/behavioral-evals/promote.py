#!/usr/bin/env python3
"""Validate a passing merged run and prepare durable baseline assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

from evaluation import (
    BaselineResult,
    CandidateResult,
    Comparison,
    aggregate,
    candidate_fingerprint,
    make_baseline,
)

GENERATION_RE = re.compile(r"^behavioral-eval-reference-([0-9]+)-([0-9]+)$")


def generation(run_id: int, attempt: int) -> str:
    if type(run_id) is not int or type(attempt) is not int:
        raise ValueError("source run and attempt must be integers")
    if run_id < 1 or attempt < 1:
        raise ValueError("source run and attempt must be positive")
    return f"behavioral-eval-reference-{run_id}-{attempt}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--source-run", required=True, type=int)
    parser.add_argument("--source-attempt", required=True, type=int)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--current-provenance", type=Path)
    parser.add_argument("--current-baseline", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source_generation = generation(args.source_run, args.source_attempt)
    request = json.loads(args.request.read_text())
    report = json.loads(args.report.read_text())
    if set(report) != {
        "schema_version",
        "candidate_fingerprint",
        "candidate",
        "comparison",
        "baseline_generation",
        "baseline_source_candidate_fingerprint",
    }:
        raise ValueError("unexpected report schema")
    if type(report["schema_version"]) is not int or report["schema_version"] != 1:
        raise ValueError("unsupported report schema")
    candidate = CandidateResult.model_validate(report["candidate"])
    comparison = Comparison.model_validate(report["comparison"])
    if comparison.status not in {"pass", "seed"}:
        raise ValueError("only a passing or seed result can become the baseline")
    if comparison.candidate != aggregate(candidate.tasks, candidate.run_retries):
        raise ValueError("comparison aggregate does not match the candidate")
    fingerprint = candidate_fingerprint(candidate)
    if report["candidate_fingerprint"] != fingerprint:
        raise ValueError("candidate fingerprint mismatch")
    if request.get("run_id") != args.source_run:
        raise ValueError("request/source run mismatch")
    if request.get("attempt") != args.source_attempt:
        raise ValueError("request/source attempt mismatch")
    for field in (
        "repository",
        "pr",
        "head_sha",
        "harness_sha",
        "manifest_fingerprint",
        "evaluator_contract_fingerprint",
        "model",
        "autonomous",
    ):
        if request[field] != getattr(candidate.identity, field):
            raise ValueError(f"request/report {field} mismatch")

    current_provenance = (
        json.loads(args.current_provenance.read_text())
        if args.current_provenance and args.current_provenance.is_file()
        else None
    )
    current_baseline = (
        BaselineResult.model_validate_json(args.current_baseline.read_text())
        if args.current_baseline and args.current_baseline.is_file()
        else None
    )
    if (current_provenance is None) != (current_baseline is None):
        raise ValueError("current baseline and provenance must be supplied together")
    evaluated_generation = report["baseline_generation"]
    evaluated_fingerprint = report["baseline_source_candidate_fingerprint"]
    if comparison.mode == "seed":
        if comparison.status != "seed" or comparison.baseline is not None:
            raise ValueError("seed report has comparison baseline data")
        if evaluated_generation is not None or evaluated_fingerprint is not None:
            raise ValueError("seed report identifies a baseline generation")
        if current_baseline is not None:
            raise ValueError("a behavioral reference was published after seed evaluation")
    else:
        if comparison.status != "pass" or comparison.baseline is None:
            raise ValueError("passing comparison report is malformed")
        if not isinstance(evaluated_generation, str) or not GENERATION_RE.fullmatch(evaluated_generation):
            raise ValueError("report baseline generation is invalid")
        if not isinstance(evaluated_fingerprint, str) or not re.fullmatch(
            r"[0-9a-f]{64}", evaluated_fingerprint
        ):
            raise ValueError("report baseline fingerprint is invalid")
        if current_provenance is None or current_baseline is None:
            raise ValueError("the evaluated baseline generation is no longer current")
        current_generation = generation(
            current_provenance.get("source_run_id", 0),
            current_provenance.get("source_run_attempt", 0),
        )
        if (
            evaluated_generation != current_generation
            or current_provenance.get("generation", current_generation) != current_generation
        ):
            raise ValueError("the evaluated baseline generation is no longer current")
        if (
            evaluated_fingerprint != current_baseline.source_candidate_fingerprint
            or current_provenance.get("candidate_fingerprint") != evaluated_fingerprint
        ):
            raise ValueError("the evaluated baseline fingerprint is no longer current")
        if comparison.baseline != aggregate(current_baseline.tasks, current_baseline.run_retries):
            raise ValueError("comparison does not match the evaluated baseline")

    manifest = json.loads((args.artifacts / "artifact-manifest.json").read_text())
    if manifest.get("sha") != candidate.identity.head_sha:
        raise ValueError("candidate artifact manifest revision mismatch")
    expected = {
        "prime-agent-0.0.0-benchmark.tgz",
        "prime-agent-ai-0.0.0-benchmark.tgz",
        "prime-agent-core-0.0.0-benchmark.tgz",
        "prime-agent-tui-0.0.0-benchmark.tgz",
    }
    records = manifest.get("artifacts")
    if (
        not isinstance(records, list)
        or len(records) != 4
        or {record.get("name") for record in records} != expected
    ):
        raise ValueError("candidate artifact manifest is incomplete")
    for record in records:
        source = args.artifacts / record["name"]
        if source.stat().st_size != record["size"]:
            raise ValueError("candidate artifact size mismatch")
        if hashlib.sha256(source.read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError("candidate artifact digest mismatch")
    args.output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        args.artifacts / "artifact-manifest.json",
        args.output / "artifact-manifest.json",
    )
    for record in records:
        source = args.artifacts / record["name"]
        shutil.copyfile(source, args.output / source.name)
    baseline = make_baseline(candidate)
    (args.output / "baseline.json").write_text(baseline.model_dump_json(indent=2) + "\n")
    provenance = {
        "schema_version": 1,
        "repository": candidate.identity.repository,
        "pr": candidate.identity.pr,
        "head_sha": candidate.identity.head_sha,
        "base_sha": request["base_sha"],
        "harness_sha": candidate.identity.harness_sha,
        "source_run_id": args.source_run,
        "source_run_attempt": args.source_attempt,
        "generation": source_generation,
        "candidate_fingerprint": fingerprint,
        "evaluator_contract_fingerprint": (candidate.identity.evaluator_contract_fingerprint),
        "baseline_generation": evaluated_generation,
    }
    (args.output / "provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
