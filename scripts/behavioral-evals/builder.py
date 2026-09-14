#!/usr/bin/env python3
"""Build candidate release tarballs inside an untrusted Prime sandbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import re
import subprocess
from pathlib import Path

VERSION = "0.0.0-benchmark"
ROOT = Path("/opt/behavioral-build")
SOURCE = ROOT / "source"
RESULTS = ROOT / "results"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def run_as_builder(args: list[str], cwd: Path, timeout: int = 600) -> None:
    env = {
        **os.environ,
        "HOME": "/home/builder",
        "CI": "1",
        "npm_config_audit": "false",
        "npm_config_fund": "false",
    }
    with (RESULTS / "build.log").open("a") as log:
        result = subprocess.run(
            ["runuser", "-u", "builder", "--", *args],
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            check=False,
        )
    if result.returncode:
        raise RuntimeError(f"candidate build command failed with exit {result.returncode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    if not REPO_RE.fullmatch(args.repository) or not SHA_RE.fullmatch(args.sha):
        raise ValueError("invalid source repository or revision")

    RESULTS.mkdir(parents=True, exist_ok=True)
    SOURCE.mkdir(parents=True, exist_ok=True)
    builder = pwd.getpwnam("builder")
    os.chown(SOURCE, builder.pw_uid, builder.pw_gid)
    source_url = f"https://github.com/{args.repository}.git"
    for command in (
        ["git", "init", "--quiet"],
        ["git", "fetch", "--depth=1", source_url, args.sha],
        ["git", "checkout", "--detach", "FETCH_HEAD"],
        ["npm", "ci", "--no-audit", "--no-fund"],
    ):
        run_as_builder(command, SOURCE)
    actual = subprocess.run(
        ["runuser", "-u", "builder", "--", "git", "rev-parse", "HEAD"],
        cwd=SOURCE,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != args.sha:
        raise RuntimeError("candidate checkout resolved to another revision")

    for package in ("tui", "ai", "agent", "coding-agent"):
        run_as_builder(
            [str(SOURCE / "node_modules/.bin/tsgo"), "-p", "tsconfig.build.json"],
            SOURCE / "packages" / package,
            timeout=240,
        )
    agent = SOURCE / "packages/coding-agent"
    run_as_builder(["chmod", "+x", "dist/cli.js"], agent)
    for script in ("copy-assets", "bundle"):
        run_as_builder(["npm", "run", script], agent, timeout=240)
    run_as_builder(
        [
            "node",
            "scripts/pack-prime-agent-release.mjs",
            "--base-url",
            "https://invalid.local/releases",
            "--version",
            VERSION,
            "--out-dir",
            "packages/coding-agent/release/behavioral",
        ],
        SOURCE,
        timeout=240,
    )
    artifacts = agent / "release/behavioral/artifacts"
    expected = {
        f"prime-agent-{VERSION}.tgz",
        f"prime-agent-ai-{VERSION}.tgz",
        f"prime-agent-core-{VERSION}.tgz",
        f"prime-agent-tui-{VERSION}.tgz",
    }
    found = {path.name for path in artifacts.glob("*.tgz")}
    if found != expected:
        raise RuntimeError("candidate build did not produce the expected release tarballs")
    records = []
    for path in sorted(artifacts.glob("*.tgz")):
        records.append(
            {
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    (RESULTS / "artifact-manifest.json").write_text(
        json.dumps({"sha": args.sha, "artifacts": records}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
