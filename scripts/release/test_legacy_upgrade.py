#!/usr/bin/env python3
"""Exercise an unchanged TS installer against real candidate release archives.

This is an opt-in integration gate, not a mocked-binary unit test. Example:
  python3 scripts/release/test_legacy_upgrade.py \
    --archive /tmp/prime-agent-1.0.0-darwin-arm64.tar.gz \
    --installer-ref v0.9.8 --previous-archive /tmp/prime-agent-0.9.8-darwin-arm64.tar.gz

Supply one --installer-ref per verified Prime release, or --installer-file to
use exact bytes extracted from a published artifact. Do not assume every old
Git tag belongs to Prime Agent: the repository includes upstream project tags.
The JSON report distinguishes installer execution from CLI/TUI update coverage.
All download requests use a local HTTP server, and all installation/user paths
live in a temporary directory. Kernel bootstrap is deliberately disabled; that
requires its own real-runtime migration test.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import tarfile

REPO = Path(__file__).resolve().parents[2]
ARCHIVE_NAME = re.compile(r"prime-agent-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(darwin|linux)-(arm64|x64)([^/]*)\.tar\.gz$")


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def archive_identity(path: Path) -> tuple[str, str]:
    match = ARCHIVE_NAME.fullmatch(path.name)
    if not match:
        raise ValueError(f"Expected a versioned native release archive: {path.name}")
    version, system, architecture, suffix = match.groups()
    return version, f"{system}-{architecture}{suffix}"


@contextlib.contextmanager
def release_server(root: Path):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def publish_archive(feed: Path, archive: Path) -> Path:
    version, _ = archive_identity(archive)
    directory = feed / "releases" / f"v{version}"
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(archive, directory / archive.name)
    checksums = directory / "SHA256SUMS"
    checksums.write_text(f"{digest(archive)}  {archive.name}\n")
    return checksums


def isolated_environment(root: Path, base_url: str, layout: str = "custom") -> dict[str, str]:
    # An allowlist prevents inheriting credentials, daemon addresses, package
    # roots, update overrides, or user-specific runtime paths from the host.
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT") if name in os.environ}
    for name, relative in {
        "HOME": "home", "TMPDIR": "tmp", "XDG_DATA_HOME": "data",
        "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache",
        "XDG_RUNTIME_DIR": "run", "PRIME_AGENT_CODING_AGENT_DIR": "home/.prime/agent",
        "PRIME_AGENT_INSTALL_DIR": "install root", "PRIME_AGENT_BIN_DIR": "public bin",
    }.items():
        path = root / relative
        path.mkdir(parents=True, exist_ok=True)
        env[name] = str(path)
    if layout == "standard":
        for name, relative in {"XDG_DATA_HOME": "home/.local/share", "PRIME_AGENT_INSTALL_DIR": "home/.local/share/prime-agent", "PRIME_AGENT_BIN_DIR": "home/.local/bin"}.items():
            path = root / relative
            path.mkdir(parents=True, exist_ok=True)
            env[name] = str(path)
    env["npm_config_prefix"] = str(root / "npm")
    env["npm_config_userconfig"] = str(root / "npmrc")
    env.update({
        "SHELL": "/bin/sh", "DO_NOT_TRACK": "1", "TERM": "dumb",
        "PRIME_AGENT_DOWNLOAD_BASE_URL": base_url,
        "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS": "1",
        "PRIME_AGENT_INSTALL_METHOD": "binary", "PRIME_AGENT_INSTALLER_NONINTERACTIVE": "1",
        "PRIME_AGENT_INSTALLER_PLAIN": "1", "PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL": "0",
        "PRIME_AGENT_INSTALL_LINK": "1", "PRIME_AGENT_PROBE_TIMEOUT_SECONDS": "30",
    })
    env["PATH"] = env["PRIME_AGENT_BIN_DIR"] + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    return env


def execute(command: list[str], env: dict[str, str], expected_success: bool = True) -> dict:
    process = subprocess.Popen(command, env=env, cwd=env["HOME"], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        # Installer descendants must not outlive the temporary installation.
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        raise RuntimeError(json.dumps({"command": command, "error": "timed out after 180s", "stdout": stdout, "stderr": stderr}))
    evidence = {"command": command, "exit_code": process.returncode, "stdout": stdout, "stderr": stderr}
    if (process.returncode == 0) != expected_success:
        raise RuntimeError(json.dumps(evidence, indent=2))
    return evidence


def exercise(installer: Path, archive: Path, previous: Path | None, root: Path, entrypoint: str, next_archive: Path | None = None, layout: str = "custom") -> dict:
    version, platform = archive_identity(archive)
    feed = root / "feed"
    checksums = publish_archive(feed, archive)
    if previous:
        previous_version, previous_platform = archive_identity(previous)
        if previous_platform != platform or previous_version == version:
            raise ValueError("Previous archive must have the same platform and a different version")
        publish_archive(feed, previous)
    (feed / "latest.json").write_text(json.dumps({
        "version": version, "binaries": [{"platform": platform, "file": archive.name, "sha256": digest(archive)}],
    }))
    if next_archive:
        publish_archive(feed, next_archive)
        with tarfile.open(next_archive) as payload:
            script = payload.extractfile("install.sh")
            if script is None:
                raise ValueError("Next Rust archive lacks its installer")
            (feed / "install.sh").write_bytes(script.read())
    steps = []
    with release_server(feed) as base_url:
        env = isolated_environment(root / "user", base_url, layout)
        state = Path(env["PRIME_AGENT_CODING_AGENT_DIR"])
        # Opaque content witnesses that installation never edits existing state.
        witnesses = {
            "settings.json": '{"migrationWitness":"settings"}\n',
            "auth.json": '{"migrationWitness":"credentials"}\n',
            "sessions/migration/session.jsonl": '{"migrationWitness":"session"}\n',
            "skills/migration/SKILL.md": "# Migration witness\n",
        }
        for relative, contents in witnesses.items():
            path = state / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        public = Path(env["PRIME_AGENT_BIN_DIR"]) / "prime-agent"
        active = Path(env["PRIME_AGENT_INSTALL_DIR"]) / "bin/prime-agent"
        if previous:
            steps.append(execute(["sh", str(installer), previous_version], env))
            probe = execute([str(public), "--version"], env)
            assert probe["stdout"].strip() == previous_version, probe
            steps.append(probe)
            old_target = os.readlink(active)
            old_binary_hash = digest(active.resolve())
            # A corrupted candidate must not change the active TS installation.
            good_checksums = checksums.read_text()
            checksums.write_text(f"{'0' * 64}  {archive.name}\n")
            steps.append(execute(["sh", str(installer), version], env, expected_success=False))
            assert os.readlink(active) == old_target, "Failed upgrade changed active target"
            assert digest(active.resolve()) == old_binary_hash, "Failed upgrade changed active executable"
            checksums.write_text(good_checksums)
            env["PRIME_AGENT_EXPECTED_CURRENT"] = old_target
            env["PRIME_AGENT_EXPECTED_SHA256"] = digest(archive)
        update_command = [str(public), "update"] if entrypoint == "cli" else ["sh", str(installer), version]
        steps.append(execute(update_command, env))
        probe = execute([str(public), "--version"], env)
        assert probe["stdout"].strip() == version, probe
        steps.append(probe)
        steps.append(execute([str(public), "--help"], env))
        assert digest(active.resolve()) == digest(public.resolve()), "Public command does not resolve to activated executable"
        for relative, contents in witnesses.items():
            assert (state / relative).read_text() == contents, f"User state changed: {relative}"
        if previous:
            retained = active.with_name("previous")
            assert os.readlink(retained) == old_target, "Previous release not retained for recovery"
        if next_archive:
            next_version, next_platform = archive_identity(next_archive)
            assert next_platform == platform, "Second Rust archive uses another platform"
            (feed / "latest.json").write_text(json.dumps({"version": next_version, "binaries": [{"platform": platform, "file": next_archive.name, "sha256": digest(next_archive)}]}))
            (feed / "stable").write_text(next_version + "\n")
            env.pop("PRIME_AGENT_EXPECTED_CURRENT", None)
            env.pop("PRIME_AGENT_EXPECTED_SHA256", None)
            env["PRIME_AGENT_RUST_INSTALLER_URL"] = base_url + "/install.sh"
            env["PRIME_AGENT_ALLOW_HTTP"] = "1"
            steps.append(execute([str(public), "update"], env))
            probe = execute([str(public), "--version"], env)
            steps.append(probe)
            if probe["stdout"].strip() != next_version:
                raise RuntimeError(json.dumps({"error": "Second update did not advance the original public command", "expected_version": next_version, "steps": steps}))
            for relative, contents in witnesses.items():
                assert (state / relative).read_text() == contents, f"Second update changed user state: {relative}"
            # The managed coordinator can start a successor even when there
            # was no prior daemon. Stop that isolated successor before cleanup.
            steps.append(execute([str(public), "shutdown", "--force"], env))
    return {"status": "passed", "layout": layout,
 "platform": platform, "candidate_version": version,
            "previous_version": archive_identity(previous)[0] if previous else None,
            "coverage": ["real released CLI update" if entrypoint == "cli" else "unchanged shipped installer", "version/help probes", "paths with spaces", "user state bytes"]
            + (["checksum failure preserves active release", "previous release retention"] if previous else []) + (["second Rust update through same public command"] if next_archive else []),
            "not_covered": ([] if entrypoint == "cli" else ["CLI update command"]) + ["TUI /update", "daemon handoff", "session continuation", "kernel bootstrap"] + ([] if next_archive else ["second Rust update"]),
            "steps": steps}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--previous-archive", type=Path)
    parser.add_argument("--next-archive", type=Path, help="Newer Rust artifact for a second update through the migrated command")
    parser.add_argument("--layout", choices=("custom", "standard"), default="custom")
    parser.add_argument("--installer-ref", action="append", default=[], help="Verified release tag/commit containing install.sh")
    parser.add_argument("--installer-file", action="append", type=Path, default=[], help="Installer extracted unchanged from a released artifact")
    parser.add_argument("--entrypoint", choices=("installer", "cli"), default="installer")
    parser.add_argument("--report", type=Path, help="Write machine-readable evidence (including failures)")
    args = parser.parse_args()
    if not args.installer_ref and not args.installer_file:
        parser.error("Supply at least one --installer-ref or --installer-file")
    if args.entrypoint == "cli" and not args.previous_archive:
        parser.error("--entrypoint cli requires --previous-archive")
    archives = [args.archive.resolve()] + ([args.previous_archive.resolve()] if args.previous_archive else [])
    if args.next_archive:
        archives.append(args.next_archive.resolve())
    report = {"archives": [{"path": str(path), "sha256": digest(path)} for path in archives], "runs": []}
    failed = False
    with tempfile.TemporaryDirectory(prefix="prime-legacy-upgrade-") as temporary:
        directory = Path(temporary)
        installers = []
        for index, ref in enumerate(args.installer_ref):
            content = subprocess.check_output(["git", "show", f"{ref}:install.sh"], cwd=REPO)
            commit = subprocess.check_output(["git", "rev-parse", f"{ref}^{{commit}}"], cwd=REPO, text=True).strip()
            installer = directory / f"installer-{index}.sh"
            installer.write_bytes(content)
            installers.append((installer, {"ref": ref, "commit": commit}))
        installers.extend((path.resolve(), {"file": str(path.resolve())}) for path in args.installer_file)
        for index, (installer, source) in enumerate(installers):
            entry = {"installer": {**source, "sha256": digest(installer)}}
            try:
                entry.update(exercise(installer, archives[0], args.previous_archive.resolve() if args.previous_archive else None, directory / f"case-{index}", args.entrypoint, args.next_archive.resolve() if args.next_archive else None, args.layout))
            except (AssertionError, OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                entry.update(status="failed", error=str(error))
                failed = True
            report["runs"].append(entry)
    rendered = json.dumps(report, indent=2)
    if args.report:
        args.report.write_text(rendered + "\n")
    print(rendered)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
