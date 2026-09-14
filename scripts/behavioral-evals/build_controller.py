#!/usr/bin/env python3
"""Build a PR revision in an isolated Prime sandbox and collect opaque tarballs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import time
from pathlib import Path

from prime_sandboxes import APIClient, CreateSandboxRequest, SandboxClient

ROOT = Path(__file__).resolve().parent
REMOTE = "/opt/behavioral-build"
OWNER_LABEL = "prime-agent-behavioral-v1"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
VERSION = "0.0.0-benchmark"
EXPECTED = {
    f"prime-agent-{VERSION}.tgz",
    f"prime-agent-ai-{VERSION}.tgz",
    f"prime-agent-core-{VERSION}.tgz",
    f"prime-agent-tui-{VERSION}.tgz",
}
MAX_ARTIFACT_BYTES = 20_000_000
BUILD_SANDBOX_TIMEOUT_MINUTES = 120
PROVISION_TIMEOUT_SECONDS = 300
SETUP_TIMEOUT_SECONDS = 180
MAX_BUILD_SECONDS = 4_800
CONTROL_COMMAND_TIMEOUT_SECONDS = 30
COMMAND_TIMEOUT_LIMIT_SECONDS = 900
BUILD_POLL_SECONDS = 10


def labels(repository: str, run_id: int, attempt: int) -> list[str]:
    return [
        OWNER_LABEL,
        f"repository:{repository}",
        f"run:{run_id}",
        f"attempt:{attempt}",
        "role:builder",
    ]


def wait_running(
    client: SandboxClient,
    sandbox_id: str,
    timeout: int = PROVISION_TIMEOUT_SECONDS,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = client.get(sandbox_id).status
        if status == "RUNNING":
            return
        if status in {"ERROR", "FAILED", "TERMINATED", "STOPPED", "TIMEOUT"}:
            raise RuntimeError("candidate build sandbox failed during provisioning")
        time.sleep(2)
    raise TimeoutError("candidate build sandbox provisioning timed out")


def run_builder(client: SandboxClient, sandbox_id: str, command: str) -> int:
    results = f"{REMOTE}/results"
    exit_path = f"{results}/build.exit"
    controller_log = f"{results}/controller.log"
    script = f"{command}; code=$?; printf '%s\\n' \"$code\" > {exit_path}.tmp; mv {exit_path}.tmp {exit_path}"
    deadline = time.monotonic() + MAX_BUILD_SECONDS
    start = client.execute_command(
        sandbox_id,
        f"mkdir -p {results}; rm -f {exit_path} {exit_path}.tmp; "
        f"nohup sh -c {shlex.quote(script)} > {controller_log} 2>&1 </dev/null &",
        timeout=CONTROL_COMMAND_TIMEOUT_SECONDS,
    )
    if start.exit_code:
        raise RuntimeError("candidate release build could not start")

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 124
        status = client.execute_command(
            sandbox_id,
            f"if test -f {exit_path}; then cat {exit_path}; else echo running; fi",
            timeout=min(CONTROL_COMMAND_TIMEOUT_SECONDS, max(1, int(remaining))),
        )
        if status.exit_code:
            raise RuntimeError("candidate release build status check failed")
        value = status.stdout.strip()
        if value != "running":
            if not re.fullmatch(r"[0-9]{1,3}", value):
                raise RuntimeError("candidate release build returned an invalid status")
            return int(value)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 124
        time.sleep(min(BUILD_POLL_SECONDS, remaining))


def build(
    repository: str,
    source_repository: str,
    sha: str,
    run_id: int,
    attempt: int,
    output: Path,
) -> None:
    if not REPO_RE.fullmatch(repository) or not REPO_RE.fullmatch(source_repository):
        raise ValueError("invalid repository")
    if not SHA_RE.fullmatch(sha):
        raise ValueError("invalid candidate revision")
    config = json.loads((ROOT.parent / "benchmarks/config.json").read_text())
    client = SandboxClient(APIClient(api_key=os.environ["PRIME_SANDBOX_API_KEY"]))
    sandbox = client.create(
        CreateSandboxRequest(
            name=f"behavioral-build-{run_id}-{attempt}",
            docker_image=config["image"],
            cpu_cores=config["cpu_cores"],
            memory_gb=config["memory_gb"],
            disk_size_gb=config["disk_gb"],
            vm=False,
            region=config["region"],
            timeout_minutes=BUILD_SANDBOX_TIMEOUT_MINUTES,
            team_id=os.environ.get("PRIME_TEAM_ID") or None,
            labels=labels(repository, run_id, attempt),
            idempotency_key=f"behavioral-build-{repository}-{run_id}-{attempt}",
        )
    )
    try:
        wait_running(client, sandbox.id)
        setup = (
            "set -eu; apt-get update -qq; "
            "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git util-linux; "
            f"mkdir -p {REMOTE}; useradd --create-home --uid 1500 --shell /bin/bash builder"
        )
        result = client.execute_command(sandbox.id, setup, timeout=SETUP_TIMEOUT_SECONDS)
        if result.exit_code:
            raise RuntimeError("candidate build sandbox setup failed")
        client.upload_file(sandbox.id, f"{REMOTE}/builder.py", str(ROOT / "builder.py"))
        command = shlex.join(
            [
                "python3",
                f"{REMOTE}/builder.py",
                "--repository",
                source_repository,
                "--sha",
                sha,
            ]
        )
        exit_code = run_builder(client, sandbox.id, command)
        client.execute_command(
            sandbox.id,
            "pkill -KILL -u builder || true",
            timeout=CONTROL_COMMAND_TIMEOUT_SECONDS,
        )
        output.mkdir(parents=True, exist_ok=True)
        tail = client.execute_command(
            sandbox.id,
            f"(tail -c 900000 -- {REMOTE}/results/build.log 2>/dev/null || true; "
            f"tail -c 100000 -- {REMOTE}/results/controller.log 2>/dev/null || true) "
            f"> {REMOTE}/results/build-tail.log",
            timeout=CONTROL_COMMAND_TIMEOUT_SECONDS,
        )
        if tail.exit_code == 0:
            client.download_file(
                sandbox.id,
                f"{REMOTE}/results/build-tail.log",
                str(output / "build.log"),
            )
        if exit_code:
            raise RuntimeError("candidate release build failed; see the build log artifact")
        client.download_file(
            sandbox.id,
            f"{REMOTE}/results/artifact-manifest.json",
            str(output / "artifact-manifest.json"),
        )
        manifest_path = output / "artifact-manifest.json"
        if manifest_path.stat().st_size > 100_000:
            raise ValueError("candidate artifact manifest exceeds its size limit")
        manifest = json.loads(manifest_path.read_text())
        records = manifest.get("artifacts") if manifest.get("sha") == sha else None
        if (
            not isinstance(records, list)
            or len(records) != 4
            or {record.get("name") for record in records} != EXPECTED
        ):
            raise ValueError("candidate artifact manifest is incomplete")
        source = f"{REMOTE}/source/packages/coding-agent/release/behavioral/artifacts"
        for record in records:
            name = record["name"]
            size = record.get("size")
            digest = record.get("sha256")
            if not isinstance(size, int) or not 0 < size <= MAX_ARTIFACT_BYTES:
                raise ValueError("candidate artifact size is invalid")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("candidate artifact digest is invalid")
            target = output / name
            client.download_file(sandbox.id, f"{source}/{name}", str(target))
            if target.stat().st_size != size:
                raise ValueError("candidate artifact size changed after the build")
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("candidate artifact digest changed after the build")
    finally:
        client.delete(sandbox.id)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--source-repository", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    build(
        args.repository,
        args.source_repository,
        args.sha,
        args.run_id,
        args.attempt,
        args.output,
    )


if __name__ == "__main__":
    main()
