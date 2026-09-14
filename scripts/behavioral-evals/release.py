#!/usr/bin/env python3
"""Fetch one immutable, internally bound behavioral baseline generation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from evaluation import BaselineResult

STABLE_TAG = "behavioral-eval-baseline-v1"
GENERATION_RE = re.compile(r"^behavioral-eval-reference-([0-9]+)-([0-9]+)$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
VERSION = "0.0.0-benchmark"
TARBALLS = {
    f"prime-agent-{VERSION}.tgz",
    f"prime-agent-ai-{VERSION}.tgz",
    f"prime-agent-core-{VERSION}.tgz",
    f"prime-agent-tui-{VERSION}.tgz",
}
FILES = {"baseline.json", "provenance.json", "artifact-manifest.json", *TARBALLS}


def output(name: str, value: str) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with Path(path).open("a") as stream:
            stream.write(f"{name}={value}\n")


def request_json(
    url: str,
    *,
    accept: str = "application/vnd.github+json",
    maximum: int = 5_000_000,
) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(maximum + 1)
            if len(data) > maximum:
                raise ValueError("GitHub response exceeds its size limit")
            return response.status, data
    except urllib.error.HTTPError as error:
        return error.code, error.read(100_000)


def release(repository: str, tag: str) -> dict | None:
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    quoted = urllib.parse.quote(tag, safe="")
    status, data = request_json(f"{api}/repos/{repository}/releases/tags/{quoted}")
    if status == 404:
        return None
    if status != 200:
        raise RuntimeError(f"GitHub release lookup failed with HTTP {status}")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise TypeError("GitHub release response is malformed")
    return value


def generation_tag(repository: str) -> str | None:
    stable = release(repository, STABLE_TAG)
    if stable is None:
        return None
    try:
        pointer = json.loads(stable.get("body") or "")
    except json.JSONDecodeError as error:
        raise ValueError("stable baseline pointer is malformed") from error
    if set(pointer) != {"release_tag"} or not GENERATION_RE.fullmatch(pointer["release_tag"]):
        raise ValueError("stable baseline pointer has an invalid generation")
    return pointer["release_tag"]


def fetch(repository: str, tag: str, destination: Path) -> None:
    selected = release(repository, tag)
    if selected is None:
        raise ValueError("referenced baseline generation does not exist")
    assets = selected.get("assets")
    if not isinstance(assets, list) or {asset.get("name") for asset in assets} != FILES:
        raise ValueError("baseline generation has incomplete or extra assets")
    destination.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        name = asset["name"]
        maximum = 1_000_000 if name.endswith(".json") else 20_000_000
        size = asset.get("size")
        if not isinstance(size, int) or not 0 < size <= maximum:
            raise ValueError(f"baseline asset has invalid size: {name}")
        status, data = request_json(asset["url"], accept="application/octet-stream", maximum=maximum)
        if status != 200 or len(data) != size:
            raise RuntimeError(f"baseline asset download failed: {name}")
        (destination / name).write_bytes(data)

    baseline = BaselineResult.model_validate_json((destination / "baseline.json").read_text())
    provenance = json.loads((destination / "provenance.json").read_text())
    manifest = json.loads((destination / "artifact-manifest.json").read_text())
    expected_provenance_fields = {
        "schema_version",
        "repository",
        "pr",
        "head_sha",
        "base_sha",
        "harness_sha",
        "source_run_id",
        "source_run_attempt",
        "generation",
        "candidate_fingerprint",
        "evaluator_contract_fingerprint",
        "baseline_generation",
    }
    if (
        set(provenance) != expected_provenance_fields
        or type(provenance["schema_version"]) is not int
        or provenance["schema_version"] != 1
        or type(provenance["source_run_id"]) is not int
        or type(provenance["source_run_attempt"]) is not int
    ):
        raise ValueError("baseline provenance schema mismatch")
    match = GENERATION_RE.fullmatch(tag)
    if match is None:
        raise ValueError("invalid baseline generation tag")
    run_id, attempt = (int(value) for value in match.groups())
    if (
        provenance["source_run_id"] != run_id
        or provenance["source_run_attempt"] != attempt
        or provenance["generation"] != tag
    ):
        raise ValueError("baseline provenance generation mismatch")
    if provenance["repository"] != repository:
        raise ValueError("baseline provenance repository mismatch")
    if provenance["candidate_fingerprint"] != baseline.source_candidate_fingerprint:
        raise ValueError("baseline provenance fingerprint mismatch")
    identity = baseline.identity
    for field in ("repository", "pr", "head_sha", "harness_sha"):
        if provenance[field] != getattr(identity, field):
            raise ValueError(f"baseline provenance {field} mismatch")
    if provenance["base_sha"] != identity.harness_sha:
        raise ValueError("baseline provenance base revision mismatch")
    if provenance["evaluator_contract_fingerprint"] != identity.evaluator_contract_fingerprint:
        raise ValueError("baseline provenance evaluator contract mismatch")
    prior = provenance["baseline_generation"]
    if prior is not None and (not isinstance(prior, str) or GENERATION_RE.fullmatch(prior) is None):
        raise ValueError("baseline provenance prior generation mismatch")
    if manifest.get("sha") != identity.head_sha:
        raise ValueError("baseline package revision mismatch")
    records = manifest.get("artifacts")
    if not isinstance(records, list) or len(records) != 4:
        raise ValueError("baseline package manifest is malformed")
    if {record.get("name") for record in records} != TARBALLS:
        raise ValueError("baseline package manifest has the wrong names")
    for record in records:
        path = destination / record["name"]
        if record.get("size") != path.stat().st_size:
            raise ValueError("baseline package size mismatch")
        if record.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
            raise ValueError("baseline package digest mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--tag")
    args = parser.parse_args()
    if not REPOSITORY_RE.fullmatch(args.repository):
        raise ValueError("invalid repository")
    tag = args.tag or generation_tag(args.repository)
    if tag is None:
        output("exists", "false")
        return
    if not GENERATION_RE.fullmatch(tag):
        raise ValueError("invalid baseline generation tag")
    fetch(args.repository, tag, args.output)
    output("exists", "true")
    output("generation", tag)


if __name__ == "__main__":
    main()
