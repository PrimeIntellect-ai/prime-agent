#!/usr/bin/env python3
"""Run focused baseline/candidate confirmation for crossed drastic thresholds."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from evaluation import (
    BaselineResult,
    CandidateResult,
    ConfirmationRecord,
    FindingConfirmation,
)
from prepare import config_text

ROOT = Path(__file__).resolve().parent


def narrowed_manifest(full: dict, task_ids: set[str]) -> dict:
    tasksets = []
    for item in full["tasksets"]:
        prefix = item["id"] + "/"
        tasks = [task for task in item["tasks"] if prefix + task in task_ids]
        if tasks:
            tasksets.append({**item, "tasks": tasks})
    return {**full, "tasksets": tasksets}


def write_configs(
    manifest: dict,
    artifacts: Path,
    commit: str,
    output: Path,
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    for item in manifest["tasksets"]:
        (output / f"{item['id']}.toml").write_text(config_text(item, manifest, artifacts, commit))


def command(
    executable: Path,
    configs: Path,
    artifacts: Path,
    commit: str,
    output: Path,
    result: Path,
    manifest: Path,
) -> list[str]:
    return [
        sys.executable,
        str(ROOT / "evaluate.py"),
        "--eval",
        str(executable),
        "--configs",
        str(configs),
        "--artifacts",
        str(artifacts),
        "--commit",
        commit,
        "--output",
        str(output),
        "--result",
        str(result),
        "--manifest",
        str(manifest),
    ]


def keyed(extracted: dict) -> dict[str, dict]:
    return {f"{item['taskset']}/{item['task']}": item for item in extracted["tasks"]}


def total(items: list[dict], field: str) -> float:
    return sum(item[field] for item in items)


def confirmed(code: str, candidate: list[dict], baseline: list[dict]) -> bool:
    resolved_delta = total(candidate, "resolved") - total(baseline, "resolved")
    if code == "resolved_losses":
        return resolved_delta <= -5
    if code == "model_timeouts":
        return total(candidate, "model_timeout") - total(baseline, "model_timeout") >= 3
    if code == "output_tokens":
        before = total(baseline, "output_tokens")
        return before > 0 and total(candidate, "output_tokens") >= 2 * before and resolved_delta <= 0
    if code == "e2e_seconds":
        before = total(baseline, "e2e_seconds")
        return before > 0 and total(candidate, "e2e_seconds") >= 2 * before and resolved_delta <= 0
    if code == "critical_safety":
        return any(item.get("deterministic_critical_safety_violation", False) for item in candidate)
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", required=True, type=Path)
    parser.add_argument("--confirmation-request", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate-artifacts", required=True, type=Path)
    parser.add_argument("--baseline-artifacts", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    report = json.loads(args.report.read_text())
    candidate_result = CandidateResult.model_validate(report["candidate"])
    baseline_result = BaselineResult.model_validate_json(args.baseline.read_text())
    confirmation_request = json.loads(args.confirmation_request.read_text())
    findings = confirmation_request["findings"]
    task_ids = {task for finding in findings for task in finding["task_ids"]}
    full = json.loads((ROOT / "short-swe.json").read_text())
    subset = narrowed_manifest(full, task_ids)
    args.output.mkdir(parents=True, exist_ok=True)
    subset_path = args.output / "manifest.json"
    subset_path.write_text(json.dumps(subset, indent=2) + "\n")
    candidate_configs = args.output / "candidate-configs"
    baseline_configs = args.output / "baseline-configs"
    write_configs(
        subset,
        args.candidate_artifacts,
        candidate_result.identity.head_sha,
        candidate_configs,
    )
    write_configs(
        subset,
        args.baseline_artifacts,
        baseline_result.identity.head_sha,
        baseline_configs,
    )

    candidate_json = args.output / "candidate.json"
    baseline_json = args.output / "baseline.json"
    processes = [
        subprocess.Popen(
            command(
                args.eval,
                candidate_configs,
                args.candidate_artifacts,
                candidate_result.identity.head_sha,
                args.output / "candidate-raw",
                candidate_json,
                subset_path,
            )
        ),
        subprocess.Popen(
            command(
                args.eval,
                baseline_configs,
                args.baseline_artifacts,
                baseline_result.identity.head_sha,
                args.output / "baseline-raw",
                baseline_json,
                subset_path,
            )
        ),
    ]
    return_codes = [process.wait() for process in processes]
    if any(return_codes) or not candidate_json.is_file() or not baseline_json.is_file():
        raise RuntimeError("focused paired confirmation did not complete")
    candidate_items = keyed(json.loads(candidate_json.read_text())) if candidate_json.is_file() else {}
    baseline_items = keyed(json.loads(baseline_json.read_text())) if baseline_json.is_file() else {}
    if any(item.get("infrastructure_error") for item in candidate_items.values()) or any(
        item.get("infrastructure_error") for item in baseline_items.values()
    ):
        raise RuntimeError("focused paired confirmation retained infrastructure failures")
    confirmations = []
    for finding in findings:
        ids = finding["task_ids"]
        paired = all(task in candidate_items and task in baseline_items for task in ids)
        reproduced = paired and confirmed(
            finding["code"],
            [candidate_items[task] for task in ids],
            [baseline_items[task] for task in ids],
        )
        if finding["code"].startswith("systemic_"):
            stage = finding["code"].removeprefix("systemic_").removesuffix("_failure")
            candidate_stages = [candidate_items[task].get("failure_stage") for task in ids]
            baseline_stages = [baseline_items[task].get("failure_stage") for task in ids]
            reproduced = all(value == stage for value in candidate_stages) and not all(
                value == stage for value in baseline_stages
            )
        confirmations.append(
            FindingConfirmation(
                code=finding["code"],
                confirmed=reproduced,
                task_ids=ids,
                note=(
                    "Focused paired rerun reproduced the threshold."
                    if reproduced
                    else "Focused paired rerun did not reproduce the threshold."
                ),
            )
        )
    record = ConfirmationRecord(
        candidate_fingerprint=confirmation_request["candidate_fingerprint"],
        findings=confirmations,
    )
    (args.output / "confirmation.json").write_text(record.model_dump_json(indent=2) + "\n")


if __name__ == "__main__":
    main()
