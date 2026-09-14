#!/usr/bin/env python3
"""Validate immutable inputs and generate exact Short SWE Verifiers configs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path

from evaluator_contract import evaluator_contract_fingerprint

ROOT = Path(__file__).resolve().parent
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def revision(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise ValueError(f"trusted compatibility patch did not match {path}")
    path.write_text(text.replace(old, new))


def pin_taskset_sources(manifest: dict, verifiers: Path, environments: Path) -> None:
    by_id = {item["id"]: item for item in manifest["tasksets"]}
    for taskset_id, module in (
        ("swebench-verified", "swebench_verified"),
        ("swebench-pro", "swebench_pro"),
    ):
        path = environments / by_id[taskset_id]["package"] / module / "taskset.py"
        unpinned = by_id[taskset_id]["dataset"].split("@", 1)[0]
        pinned = by_id[taskset_id]["dataset"]
        text = path.read_text()
        count = text.count(f'"{unpinned}"')
        if count != 2:
            raise ValueError(f"dataset pin did not match {path}")
        path.write_text(text.replace(f'"{unpinned}"', f'"{pinned}"'))

    scale = environments / by_id["scaleswe"]["package"] / "scaleswe/taskset.py"
    old = "dataset = load_dataset(self.config.dataset_name, split=self.config.split)"
    pin = manifest["scaleswe_dataset_revision"]
    new = (
        "dataset = load_dataset(\n"
        "            self.config.dataset_name,\n"
        "            split=self.config.split,\n"
        f'            revision="{pin}",\n'
        "        )"
    )
    replace_once(scale, old, new)

    # This Verifiers revision eagerly imports the optional NeMo Gym plugin from
    # tasksets.__init__. Harbor does not need it, and MCP 2.0 no longer exposes
    # that plugin's legacy import path. Keep this compatibility patch narrow.
    init = verifiers / "verifiers/v1/tasksets/__init__.py"
    text = init.read_text()
    block = "from verifiers.v1.tasksets.nemo_gym import NeMoGymConfig, NeMoGymTaskset\n"
    if block in text:
        text = text.replace(block, "")
        text = text.replace('    "NeMoGymConfig",\n    "NeMoGymTaskset",\n', "")
        init.write_text(text)


def validate_verifiers_lock(manifest: dict, verifiers: Path) -> None:
    lock = tomllib.loads((verifiers / "uv.lock").read_text())
    versions = {
        package.get("version") for package in lock.get("package", []) if package.get("name") == "harbor"
    }
    if versions != {manifest.get("harbor_version")}:
        raise ValueError("Verifiers Harbor version does not match the manifest")


def validate_manifest(manifest: dict) -> None:
    expected_limits = {
        "max_turns": 128,
        "max_output_tokens": 100_000,
        "max_total_tokens": 5_000_000,
        "rollout_timeout_seconds": 3_600,
        "max_inflight_model_calls": 1,
        "max_model_request_bytes": 16_000_000,
    }
    if (
        manifest.get("schema_version") != 1
        or manifest.get("autonomous") is not False
        or manifest.get("network_policy") != "framework-only"
        or manifest.get("limits") != expected_limits
    ):
        raise ValueError("unsupported Short SWE manifest")
    if not SHA_RE.fullmatch(manifest.get("verifiers_commit", "")):
        raise ValueError("invalid Verifiers revision")
    if not SHA_RE.fullmatch(manifest.get("environments_commit", "")):
        raise ValueError("invalid environments revision")
    expected = {"swebench-verified": 15, "swebench-pro": 8, "scaleswe": 5}
    tasksets = manifest.get("tasksets", [])
    actual = {item.get("id"): len(item.get("tasks", [])) for item in tasksets}
    if actual != expected:
        raise ValueError("Short SWE must contain the fixed 15/8/5 task slices")
    scaleswe = next(item for item in tasksets if item["id"] == "scaleswe")
    if scaleswe.get("filter_unavailable_images") is not False:
        raise ValueError("Scale-SWE image filtering must remain disabled")
    tasks = [task for item in tasksets for task in item["tasks"]]
    if len(tasks) != 28 or len(tasks) != len(set(tasks)):
        raise ValueError("Short SWE task keys must be 28 unique names")


def toml_array(values: list[str]) -> str:
    return "[" + ", ".join(json.dumps(value) for value in values) + "]"


def config_text(item: dict, manifest: dict, artifacts: Path, commit: str) -> str:
    lines = [
        f"model = {json.dumps(manifest['model'])}",
        f"num_rollouts = {manifest['num_rollouts']}",
        f"max_concurrent = {manifest['max_concurrent']}",
        "",
        "[env.agent]",
        f"max_turns = {manifest['limits']['max_turns']}",
        f"max_output_tokens = {manifest['limits']['max_output_tokens']}",
        f"max_total_tokens = {manifest['limits']['max_total_tokens']}",
        "",
        "[env.agent.timeout]",
        f"rollout = {manifest['limits']['rollout_timeout_seconds']}",
        "",
        "[env.taskset]",
        f"id = {json.dumps(item['id'])}",
    ]
    if item["id"] in {"swebench-verified", "swebench-pro"}:
        lines.append(f"tasks = {toml_array(item['tasks'])}")
    else:
        wanted = repr(tuple(item["tasks"]))
        expression = f'lambda row: row["instance_id"] in {wanted}'
        lines.extend(
            [
                f"filter_fn = {json.dumps(expression)}",
                f"filter_unavailable_images = {str(item['filter_unavailable_images']).lower()}",
            ]
        )
    lines.extend(
        [
            "",
            "[env.agent.harness]",
            'id = "prime-agent-candidate"',
            f"artifact_dir = {json.dumps(str(artifacts.resolve()))}",
            f"commit = {json.dumps(commit)}",
            "autonomous = false",
            "",
            "[env.agent.runtime]",
            'type = "prime"',
            "allow = []",
            "labels = "
            + toml_array(
                [
                    "prime-agent-behavioral-v1",
                    f"repository:{os.environ.get('GITHUB_REPOSITORY', 'local/local')}",
                    f"run:{os.environ.get('GITHUB_RUN_ID', 'local')}",
                    f"attempt:{os.environ.get('GITHUB_RUN_ATTEMPT', 'local')}",
                    "role:task",
                ]
            ),
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verifiers", required=True, type=Path)
    parser.add_argument("--environments", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest_path = ROOT / "short-swe.json"
    manifest = json.loads(manifest_path.read_text())
    validate_manifest(manifest)
    if revision(args.verifiers) != manifest["verifiers_commit"]:
        raise ValueError("Verifiers checkout does not match the manifest")
    if revision(args.environments) != manifest["environments_commit"]:
        raise ValueError("environments checkout does not match the manifest")
    validate_verifiers_lock(manifest, args.verifiers)
    if not SHA_RE.fullmatch(args.commit):
        raise ValueError("invalid candidate revision")
    pin_taskset_sources(manifest, args.verifiers, args.environments)
    args.output.mkdir(parents=True, exist_ok=True)
    for item in manifest["tasksets"]:
        (args.output / f"{item['id']}.toml").write_text(
            config_text(item, manifest, args.artifacts, args.commit)
        )
    fingerprint = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    (args.output / "manifest-fingerprint").write_text(fingerprint + "\n")
    (args.output / "evaluator-contract-fingerprint").write_text(evaluator_contract_fingerprint() + "\n")


if __name__ == "__main__":
    main()
