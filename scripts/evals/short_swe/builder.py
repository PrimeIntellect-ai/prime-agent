#!/usr/bin/env python3
"""Build candidate release tarballs inside an untrusted Prime sandbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
from pathlib import Path

VERSION = "0.0.0-benchmark"
ROOT = Path("/opt/behavioral-build")
SOURCE = ROOT / "source"
RESULTS = ROOT / "results"
SNAPSHOT = RESULTS / "artifacts"
ARTIFACT_RELATIVE = Path("packages/coding-agent/release/behavioral/artifacts")
MAX_ARTIFACT_BYTES = 20_000_000
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


def open_candidate_artifacts() -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    directory = os.open(SOURCE, flags)
    try:
        for part in ARTIFACT_RELATIVE.parts:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def create_snapshot(path: Path = SNAPSHOT) -> int:
    path.mkdir(mode=0o700)
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ValueError("trusted artifact snapshot permissions are invalid")
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def snapshot_artifact(source: int, destination: int, name: str) -> dict[str, int | str]:
    try:
        metadata = os.stat(name, dir_fd=source, follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MAX_ARTIFACT_BYTES:
            raise ValueError("candidate artifact is not a bounded regular file")
        source_file = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=source,
        )
    except OSError as error:
        raise ValueError("candidate artifact could not be opened safely") from error

    destination_file = None
    try:
        opened = os.fstat(source_file)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_size != metadata.st_size
            or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino)
        ):
            raise ValueError("candidate artifact changed before its safe open")
        destination_file = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
            0o600,
            dir_fd=destination,
        )
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining:
            chunk = os.read(source_file, min(1_000_000, remaining))
            if not chunk:
                raise ValueError("candidate artifact changed while being copied")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_file, view)
                if written <= 0:
                    raise OSError("candidate artifact snapshot write failed")
                view = view[written:]
            remaining -= len(chunk)
        if os.read(source_file, 1) or os.fstat(source_file).st_size != opened.st_size:
            raise ValueError("candidate artifact changed while being copied")
        os.fsync(destination_file)
        return {"name": name, "size": opened.st_size, "sha256": digest.hexdigest()}
    except BaseException:
        if destination_file is not None:
            try:
                os.unlink(name, dir_fd=destination)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(source_file)
        if destination_file is not None:
            os.close(destination_file)


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
    expected = {
        f"prime-agent-{VERSION}.tgz",
        f"prime-agent-ai-{VERSION}.tgz",
        f"prime-agent-core-{VERSION}.tgz",
        f"prime-agent-tui-{VERSION}.tgz",
    }
    source = open_candidate_artifacts()
    destination = create_snapshot()
    try:
        found = {name for name in os.listdir(source) if name.endswith(".tgz")}
        if found != expected:
            raise RuntimeError("candidate build did not produce the expected release tarballs")
        records = [snapshot_artifact(source, destination, name) for name in sorted(expected)]
    finally:
        os.close(source)
        os.close(destination)
    (RESULTS / "artifact-manifest.json").write_text(
        json.dumps({"sha": args.sha, "artifacts": records}, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
