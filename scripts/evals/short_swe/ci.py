#!/usr/bin/env python3
"""Resolve one exact label-approved PR comparison from a trusted workflow."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

LABEL = "pre-release"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def resolve(output: Path, harness_sha: str) -> dict:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pull = event.get("pull_request")
    if (
        event.get("action") != "labeled"
        or (event.get("label") or {}).get("name") != LABEL
        or not isinstance(pull, dict)
    ):
        raise ValueError("behavioral evaluation requires the pre-release label event")
    repository = os.environ["GITHUB_REPOSITORY"]
    head_repository = (pull.get("head", {}).get("repo") or {}).get("full_name", "")
    values = {
        "schema_version": 1,
        "repository": repository,
        "head_repository": head_repository,
        "pr": pull.get("number"),
        "run_id": int(os.environ["GITHUB_RUN_ID"]),
        "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "harness_sha": harness_sha,
        "base_sha": pull.get("base", {}).get("sha"),
        "head_sha": pull.get("head", {}).get("sha"),
    }
    if (
        pull.get("state") != "open"
        or pull.get("base", {}).get("repo", {}).get("full_name") != repository
        or not REPO_RE.fullmatch(repository)
        or not REPO_RE.fullmatch(head_repository)
        or not isinstance(values["pr"], int)
        or values["pr"] <= 0
        or any(not SHA_RE.fullmatch(str(values[key])) for key in ("harness_sha", "base_sha", "head_sha"))
        or values["harness_sha"] != values["base_sha"]
    ):
        raise ValueError("invalid pull request identity")
    output.mkdir(parents=True, exist_ok=True)
    (output / "request.json").write_text(json.dumps(values, indent=2, sort_keys=True) + "\n")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a") as stream:
            for key in ("pr", "head_repository", "base_sha", "head_sha"):
                stream.write(f"{key}={values[key]}\n")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("request"))
    parser.add_argument("--harness-sha", required=True)
    args = parser.parse_args()
    resolve(args.output, args.harness_sha)


if __name__ == "__main__":
    main()
