#!/usr/bin/env python3
"""Validate immutable inputs and generate exact Short SWE Verifiers configs."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
CANDIDATE_TARBALLS = {
    f"{name}-0.0.0-benchmark.tgz"
    for name in ("prime-agent", "prime-agent-ai", "prime-agent-core", "prime-agent-tui")
}


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


def strip_task_runtime_credentials(verifiers: Path) -> None:
    """Patch the pinned Harbor task boundary before it populates a sandbox environment."""
    harbor = verifiers / "verifiers/v1/tasksets/harbor/taskset.py"
    old = "    def runtime_env(self) -> dict[str, str]:\n        return resolve_env(self.data.env)"
    new = (
        "    def runtime_env(self) -> dict[str, str]:\n"
        "        env = resolve_env(self.data.env)\n"
        '        for name in ("PRIME_API_KEY", "PRIME_SANDBOX_API_KEY", '
        '"GITHUB_TOKEN", "GH_TOKEN", "HF_TOKEN"):\n'
        "            env.pop(name, None)\n"
        "        return env"
    )
    replace_once(harbor, old, new)


def install_verified_verifier(manifest: dict, environments: Path) -> None:
    # Tests run in a fresh, network-free verifier. Their bounded log is parsed here,
    # outside candidate control, against the trusted task package's config.
    by_id = {item["id"]: item for item in manifest["tasksets"]}
    package = environments / by_id["swebench-verified"]["package"] / "swebench_verified"
    taskset = package / "taskset.py"
    replace_once(
        taskset,
        "`SWEBenchVerifiedTask` (a `HarborTask` whose `finalize` ensures uv before harbor's verifier runs).",
        "`SWEBenchVerifiedTask` (a `HarborTask` graded in a fresh offline verifier sandbox).",
    )
    replace_once(taskset, "from verifiers.v1.runtimes import Runtime\n", "")
    replace_once(taskset, "from verifiers.v1.runtimes.base import _ENSURE_UV\n", "")
    replace_once(
        taskset,
        "from verifiers.v1.tasksets.harbor import HarborConfig, HarborTask, HarborTaskset\n",
        "from verifiers.v1.tasksets.harbor import HarborConfig, HarborTask, HarborTaskset\n"
        "from verifiers.v1.tasksets.harbor.taskset import CollectHook, VerifierConfig\n"
        "from verifiers.v1.utils.artifacts import Artifact\n"
        "from secure_harbor import SecureVerifiedMixin\n"
        "from verified_verifier import patch_collect_command\n",
    )
    old = """class SWEBenchVerifiedTask(HarborTask):
    async def finalize(self, trace: vf.Trace, runtime: Runtime) -> None:
        # The SWE-bench verifier runs `uv run parser.py` but never installs uv, relying on the
        # harness to leave one on PATH. rlm pins uv off PATH, so the grader hits `uv: command not
        # found` and scores 0 even for correct fixes. Ensure uv before scoring, under any harness.
        await runtime.run(["sh", "-c", _ENSURE_UV], {})
        await super().finalize(trace, runtime)
"""
    new = """class SWEBenchVerifiedTask(SecureVerifiedMixin, HarborTask):
    pass
"""
    replace_once(taskset, old, new)
    old_data = 'data = task.data.model_copy(update={"image": image, "workdir": "/testbed"})'
    new_data = """if task.data.artifacts or task.data.collect or task.data.verifier is not None:
                raise ValueError(f"{task.data.name}: unexpected verifier transfer configuration")
            data = task.data.model_copy(
                update={
                    "image": image,
                    "workdir": "/testbed",
                    "artifacts": [Artifact(source="/tmp/prime-agent.patch")],
                    "collect": [
                        CollectHook(
                            command=patch_collect_command(Path(task.data.task_dir))
                        )
                    ],
                    "verifier": VerifierConfig(fresh_copy=True, network_allow=[]),
                }
            )"""
    replace_once(taskset, old_data, new_data)


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

    install_verified_verifier(manifest, environments)
    strip_task_runtime_credentials(verifiers)

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
        "max_model_request_bytes": 16_000_000,
    }
    if (
        manifest.get("schema_version") != 1
        or manifest.get("autonomous") is not False
        or manifest.get("network_policy") != "framework-only"
        or manifest.get("limits") != expected_limits
    ):
        raise ValueError("unsupported Short SWE manifest")
    if not all(isinstance(manifest.get(key), str) and manifest[key] for key in ("model", "backup_model")):
        raise ValueError("Short SWE must pin the model and its backup")
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


def config_text(item: dict) -> str:
    """Minimal TOML: the hosted flow globs these file stems, never their content."""
    return f"id = {json.dumps(item['id'])}\n"


def toml_array(values: list[str]) -> str:
    return "[" + ", ".join(json.dumps(value) for value in values) + "]"


def oracle_config_text(manifest: dict) -> str:
    return "\n".join(
        [
            f"model = {json.dumps(manifest['model'])}",
            "num_rollouts = 1",
            "max_concurrent = 1",
            "",
            "[env]",
            'id = "secure_harbor"',
            "",
            "[env.timeout]",
            "finalize = 600",
            "",
            "[env.verifier]",
            "retries = 0",
            "",
            "[env.verifier.runtime]",
            'type = "prime"',
            "allow = []",
            "vm = true",
            "labels = "
            + toml_array(
                [
                    "prime-agent-behavioral-v1",
                    f"repository:{os.environ.get('GITHUB_REPOSITORY', 'local/local')}",
                    f"run:{os.environ.get('GITHUB_RUN_ID', 'local')}",
                    f"attempt:{os.environ.get('GITHUB_RUN_ATTEMPT', 'local')}",
                    "role:oracle-verifier",
                ]
            ),
            "",
            "[env.agent]",
            "max_turns = 4",
            "max_output_tokens = 20000",
            "max_total_tokens = 100000",
            "",
            "[env.agent.timeout]",
            "rollout = 600",
            "scoring = 600",
            "",
            "[env.taskset]",
            'id = "swebench-verified"',
            'tasks = ["astropy__astropy-14096"]',
            "",
            "[env.agent.harness]",
            'id = "oracle_harness"',
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
                    "role:oracle",
                ]
            ),
            "",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verifiers", required=True, type=Path)
    parser.add_argument("--environments", required=True, type=Path)
    parser.add_argument("--base-artifacts", required=True, type=Path)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-artifacts", required=True, type=Path)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "short-swe.json").read_text())
    validate_manifest(manifest)
    if revision(args.verifiers) != manifest["verifiers_commit"]:
        raise ValueError("Verifiers checkout does not match the manifest")
    if revision(args.environments) != manifest["environments_commit"]:
        raise ValueError("environments checkout does not match the manifest")
    validate_verifiers_lock(manifest, args.verifiers)
    if not SHA_RE.fullmatch(args.base_sha) or not SHA_RE.fullmatch(args.head_sha):
        raise ValueError("invalid evaluated revision")
    pin_taskset_sources(manifest, args.verifiers, args.environments)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "oracle.toml").write_text(oracle_config_text(manifest))
    for side in ("base", "head"):
        target = args.output / side
        target.mkdir(parents=True, exist_ok=True)
        for item in manifest["tasksets"]:
            (target / f"{item['id']}.toml").write_text(config_text(item))


if __name__ == "__main__":
    main()
