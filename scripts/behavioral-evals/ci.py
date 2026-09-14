#!/usr/bin/env python3
"""Trusted GitHub event resolution for the label-gated behavioral check."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from evaluator_contract import evaluator_contract_fingerprint

LABEL = "pre-release"
ROOT = Path(__file__).resolve().parent


def write_output(values: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with Path(path).open("a") as stream:
            stream.writelines(f"{key}={value}\n" for key, value in values.items())
    else:
        for key, value in values.items():
            print(f"{key}={value}")


def resolve(output: Path, harness_sha: str) -> None:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pull = event.get("pull_request")
    if not isinstance(pull, dict) or event.get("action") not in {
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
        "labeled",
        "unlabeled",
    }:
        raise ValueError("unexpected behavioral evaluation event")
    repository = os.environ["GITHUB_REPOSITORY"]
    if pull["base"]["repo"]["full_name"] != repository or pull["state"] != "open":
        raise ValueError("behavioral evaluation requires an open PR in this repository")
    labels = {item["name"] for item in pull.get("labels", [])}
    label_present = LABEL in labels and not pull.get("draft", False)
    approved_event = event["action"] == "labeled" and (event.get("label") or {}).get("name") == LABEL
    needed = label_present and approved_event
    approval_required = label_present and not approved_event
    manifest = ROOT / "short-swe.json"
    request = {
        "schema_version": 1,
        "repository": repository,
        "head_repository": pull["head"]["repo"]["full_name"],
        "pr": int(pull["number"]),
        "run_id": int(os.environ["GITHUB_RUN_ID"]),
        "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "harness_sha": harness_sha,
        "base_sha": pull["base"]["sha"],
        "head_sha": pull["head"]["sha"],
        "manifest_fingerprint": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "evaluator_contract_fingerprint": evaluator_contract_fingerprint(),
        "model": json.loads(manifest.read_text())["model"],
        "autonomous": False,
        "label": LABEL,
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "request.json").write_text(json.dumps(request, indent=2, sort_keys=True) + "\n")
    write_output(
        {
            "needed": str(needed).lower(),
            "approval_required": str(approval_required).lower(),
            "author": pull["user"]["login"],
            "pr": str(pull["number"]),
            "head_sha": pull["head"]["sha"],
            "head_repository": pull["head"]["repo"]["full_name"],
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("resolve",))
    parser.add_argument("--output", type=Path, default=Path("request"))
    parser.add_argument("--harness-sha", required=True)
    args = parser.parse_args()
    resolve(args.output, args.harness_sha)


if __name__ == "__main__":
    main()
