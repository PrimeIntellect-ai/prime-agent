#!/usr/bin/env python3
"""Validate extracted metrics, compare them, and render the PR report."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from evaluation import (
    BaselineResult,
    CandidateResult,
    ConfirmationRecord,
    Identity,
    TaskResult,
    candidate_fingerprint,
    compare,
    render_markdown,
)

MARKER = "<!-- prime-agent-behavioral-eval:v1 -->"


def write_output(name: str, value: str) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with Path(path).open("a") as stream:
            stream.write(f"{name}={value}\n")


def convert(request: dict, extracted: dict) -> CandidateResult:
    identity = Identity(
        repository=request["repository"],
        pr=request["pr"],
        head_sha=request["head_sha"],
        harness_sha=request["harness_sha"],
        manifest_fingerprint=request["manifest_fingerprint"],
        evaluator_contract_fingerprint=request["evaluator_contract_fingerprint"],
        model=request["model"],
        autonomous=request["autonomous"],
    )
    tasks = [
        TaskResult(
            task_id=f"{item['taskset']}/{item['task']}",
            resolved=item["resolved"],
            provider_output_tokens=item["output_tokens"],
            e2e_seconds=item["e2e_seconds"],
            model_calls=item["model_calls"],
            tool_calls=item["tool_calls"],
            model_timeout=item["model_timeout"],
            infrastructure_error=item["infrastructure_error"],
            retries=item.get("retries", 0),
            trace_fact_counts=item["trace_facts"],
        )
        for item in extracted["tasks"]
    ]
    systemic = []
    stages = [item.get("failure_stage") for item in extracted["tasks"]]
    for stage in ("install", "launch", "acp", "cpython", "trace_integrity", "cleanup"):
        if stages and all(value == stage for value in stages):
            systemic.append(stage)
    return CandidateResult(
        identity=identity,
        tasks=tasks,
        run_retries=extracted.get("taskset_retries", 0),
        systemic_failures=systemic,
    )


def failure(output: Path, outcomes: dict[str, str]) -> None:
    failed = [name for name, outcome in outcomes.items() if outcome != "success"]
    detail = ", ".join(failed) if failed else "candidate result validation"
    output.mkdir(parents=True, exist_ok=True)
    (output / "comment.md").write_text(
        f"{MARKER}\n## Behavioral Eval\n\n"
        f"The labeled evaluation failed during {detail}. See the workflow artifacts.\n"
    )
    (output / "verdict").write_text("fail\n")
    write_output("needs_confirmation", "false")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--baseline-generation")
    parser.add_argument("--confirmation", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--evaluator-outcome", default="success")
    parser.add_argument("--build-outcome", default="success")
    parser.add_argument("--evaluate-outcome", default="success")
    args = parser.parse_args()
    outcomes = {
        "evaluator setup": args.evaluator_outcome,
        "candidate build": args.build_outcome,
        "Short SWE execution": args.evaluate_outcome,
    }
    if not args.candidate.is_file() or any(value != "success" for value in outcomes.values()):
        failure(args.output, outcomes)
        return

    request = json.loads(args.request.read_text())
    extracted = json.loads(args.candidate.read_text())
    if any(item.get("infrastructure_error") for item in extracted.get("tasks", [])):
        failure(args.output, {"infrastructure retry": "failure"})
        return
    candidate = convert(request, extracted)
    baseline = (
        BaselineResult.model_validate_json(args.baseline.read_text())
        if args.baseline and args.baseline.is_file()
        else None
    )
    baseline_generation = args.baseline_generation or None
    if (baseline is None) != (baseline_generation is None):
        raise ValueError("baseline file and generation must be supplied together")
    confirmation = (
        ConfirmationRecord.model_validate_json(args.confirmation.read_text())
        if args.confirmation and args.confirmation.is_file()
        else None
    )
    comparison = compare(candidate, baseline, confirmation)
    artifacts_url = (
        f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
        f"{request['repository']}/actions/runs/{request['run_id']}"
    )
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "schema_version": 1,
        "candidate_fingerprint": candidate_fingerprint(candidate),
        "baseline_generation": baseline_generation,
        "baseline_source_candidate_fingerprint": (
            baseline.source_candidate_fingerprint if baseline is not None else None
        ),
        "candidate": candidate.model_dump(mode="json"),
        "comparison": comparison.model_dump(mode="json"),
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (args.output / "comment.md").write_text(
        MARKER + "\n" + render_markdown(candidate, comparison, artifacts_url)
    )
    verdict = {
        "seed": "pass",
        "pass": "pass",
        "needs_confirmation": "inconclusive",
        "fail": "fail",
    }[comparison.status]
    (args.output / "verdict").write_text(verdict + "\n")
    if comparison.status == "needs_confirmation":
        request_data = {
            "candidate_fingerprint": report["candidate_fingerprint"],
            "findings": [finding.model_dump(mode="json") for finding in comparison.findings],
        }
        (args.output / "confirmation-request.json").write_text(
            json.dumps(request_data, indent=2, sort_keys=True) + "\n"
        )
    write_output("needs_confirmation", str(comparison.status == "needs_confirmation").lower())


if __name__ == "__main__":
    main()
