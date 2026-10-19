#!/usr/bin/env python3
"""Real npm updater recovery when the unchanged Rust installer rejects a host.

Opt-in network integration. All installs, sockets, and sessions are temporary.
The only simulated host capability is uname -m; no installer or TS code is mocked.
"""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tarfile
import tempfile

import npm_bridge
from test_legacy_tui_upgrade import daemon_request, wait_for
from test_legacy_upgrade import archive_identity, digest, execute, isolated_environment, publish_archive, release_server


def exercise(args, root: Path) -> dict:
    source = args.previous_archive
    with tarfile.open(source) as tar:
        metadata = json.load(tar.extractfile("package/package.json"))
        original_cli = tar.extractfile("package/dist/bundle/cli.js").read()
    checksum = next(line.split()[0] for line in args.previous_checksums.read_text().splitlines()
                    if len(line.split()) == 2 and line.split()[1].lstrip("*") == source.name)
    assert digest(source) == checksum
    version, platform = archive_identity(args.archive)
    candidate = args.archive
    if args.failure_mode == "unusable-payload":
        # Valid archive and matching published checksum, but execution fails
        # on every host. Keep its executable mode so the staged --version
        # probe, rather than the presence check, must reject publication.
        candidate = root / args.archive.name
        with tarfile.open(args.archive) as source_archive, tarfile.open(candidate, "w:gz") as rejected:
            for member in source_archive.getmembers():
                if member.name == "prime-agent":
                    payload = b"#!/nonexistent-prime-agent-test-interpreter\n"
                    member.size = len(payload)
                    member.mode = 0o755
                    rejected.addfile(member, io.BytesIO(payload))
                else:
                    rejected.addfile(member, source_archive.extractfile(member) if member.isfile() else None)
    feed = root / "feed"
    publish_archive(feed, candidate)
    bridge = npm_bridge.assemble(Path(__file__).resolve().parents[2], feed / "releases" / f"v{version}",
                                 version, "stable", args.fallback_tarball)
    (feed / "latest.json").write_text(json.dumps({"version": version, "package": "prime-agent",
        "tarball": f"releases/v{version}/{bridge['tarball']}",
        "binaries": [{"platform": platform, "file": candidate.name, "sha256": digest(candidate)}]}))
    evidence = {"source_version": metadata["version"], "source_sha256": checksum,
                "candidate_sha256": digest(candidate), "failure_mode": args.failure_mode,
                "bridge_sha256": bridge["sha256"],
                "fallback_sha256": digest(args.fallback_tarball), "steps": []}
    with release_server(feed) as base:
        env = isolated_environment(root / "user", base, "standard")
        prefix = root / "npm prefix"
        shutil.copytree(args.previous_prefix, prefix, symlinks=True)
        public = prefix / "bin/prime-agent"
        cli = prefix / "lib/node_modules/prime-agent/dist/bundle/cli.js"
        assert cli.read_bytes() == original_cli
        wrappers = root / "host"
        wrappers.mkdir()
        if args.failure_mode == "unsupported-host":
            uname = wrappers / "uname"
            uname.write_text('#!/bin/sh\nif [ "$1" = -m ]; then echo unsupported-test-architecture; else exec /usr/bin/uname "$@"; fi\n')
            uname.chmod(0o755)
        native_prefix = prefix if args.failure_mode == "unusable-payload" else root / "rust"
        socket = root / "daemon.sock"
        env.update(PATH=str(wrappers) + os.pathsep + str(prefix / "bin") + os.pathsep + env["PATH"],
                   npm_config_prefix=str(prefix), npm_config_cache=str(root / "npm-cache"),
                   npm_config_ignore_scripts="true", npm_config_audit="false", npm_config_fund="false",
                   npm_config_update_notifier="false", PRIME_AGENT_RUST_PREFIX=str(native_prefix),
                   PRIME_AGENT_ALLOW_HTTP="1", PRIME_AGENT_DAEMON_SOCKET=str(socket),
                   TERM="xterm-256color", ANTHROPIC_API_KEY="fixture-not-a-real-key")
        state = Path(env["PRIME_AGENT_CODING_AGENT_DIR"])
        (state / "settings.json").write_text(json.dumps({"onboardingShown": True}))
        stamp = "2026-10-09T00:00:00.000Z"
        transcript = state / "sessions/recovery.jsonl"
        transcript.parent.mkdir(exist_ok=True)
        rows = [{"type": "session", "version": 3, "id": "11111111-2222-4333-8444-555555555555", "timestamp": stamp, "cwd": env["HOME"]},
                {"type": "message", "id": "seed", "parentId": None, "timestamp": stamp, "message": {
                    "role": "assistant", "content": [{"type": "text", "text": "durable recovery sentinel"}],
                    "api": "anthropic-messages", "provider": "anthropic", "model": "claude-sonnet-4-5",
                    "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                              "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                    "stopReason": "stop", "timestamp": 1791504000000}}]
        original = "".join(json.dumps(row) + "\n" for row in rows)
        transcript.write_text(original)
        evidence["steps"].append(execute([str(public), "--version"], env))
        update = subprocess.run([str(public), "update", "--force"], env=env, cwd=env["HOME"],
                                capture_output=True, text=True, timeout=240)
        evidence["old_update"] = {"exit_code": update.returncode, "stdout": update.stdout, "stderr": update.stderr}
        assert json.loads((cli.parents[2] / "package.json").read_text())["primeAgentRustBridge"] is True
        probe = execute([str(public), "--version"], env)
        evidence["steps"].append(probe)
        assert npm_bridge.FALLBACK_VERSION in (probe["stdout"] + probe["stderr"]).splitlines(), probe
        assert "TypeScript" in probe["stderr"], probe
        assert not (native_prefix / "share/prime-agent/prime-agent").exists(), "Unusable native payload was published"
        assert public.is_symlink() and public.resolve() == cli.resolve(), "Installer overwrote the public npm recovery launcher"
        receipts = native_prefix / "share/.prime-agent-npm-bridge"
        assert not (receipts / version).exists(), "Failed migration recorded success"
        assert (receipts / f"{version}.failed").exists(), "Failed migration was not recorded"
        expected_runtime = npm_bridge.FALLBACK_VERSION
        if args.recovery_archive:
            if args.failure_mode != "unsupported-host":
                raise ValueError("A recovery archive currently requires unsupported-host mode")
            recovery_version, recovery_platform = archive_identity(args.recovery_archive)
            assert recovery_version != version
            publish_archive(feed, args.recovery_archive)
            recovery_bridge = npm_bridge.assemble(Path(__file__).resolve().parents[2],
                feed / "releases" / f"v{recovery_version}", recovery_version, "stable", args.fallback_tarball)
            (feed / "latest.json").write_text(json.dumps({"version": recovery_version, "package": "prime-agent",
                "tarball": f"releases/v{recovery_version}/{recovery_bridge['tarball']}",
                "binaries": [{"platform": recovery_platform, "file": args.recovery_archive.name,
                              "sha256": digest(args.recovery_archive)}]}))
            (wrappers / "uname").unlink()
            expected_runtime = recovery_version
            evidence["recovery"] = {"version": recovery_version, "candidate_sha256": digest(args.recovery_archive),
                                    "bridge_sha256": recovery_bridge["sha256"]}
        retry = subprocess.run([str(public), "update", "--force"], env=env, cwd=env["HOME"],
                               capture_output=True, text=True, timeout=90)
        evidence["explicit_retry"] = {"exit_code": retry.returncode, "stdout": retry.stdout, "stderr": retry.stderr}
        if args.recovery_archive:
            assert retry.returncode == 0, evidence["explicit_retry"]
            assert (receipts / expected_runtime).is_file(), "Newer release did not record successful migration"
            assert (native_prefix / "share/prime-agent/prime-agent").is_file()
            recovered = execute([str(public), "--version"], env)
            evidence["steps"].append(recovered)
            assert recovered["stdout"].strip() == expected_runtime, recovered
        else:
            assert retry.returncode != 0 and "Rust migration failed" in retry.stderr, evidence["explicit_retry"]
            expected_error = "no rust build is published" if args.failure_mode == "unsupported-host" else "refusing an unusable launcher"
            assert expected_error in retry.stderr, evidence["explicit_retry"]
        tmux = ["tmux", "-S", str(root / "tmux.sock")]

        def tmux_run(*parts):
            return subprocess.run(tmux + list(parts), env=env, capture_output=True, text=True, timeout=10)

        def screen():
            result = tmux_run("capture-pane", "-p", "-t", "recovery")
            if result.returncode:
                raise RuntimeError(result.stderr)
            return result.stdout

        try:
            command = [str(public), "--resume", str(transcript), "--daemon-socket", str(socket),
                       "--provider", "anthropic", "--model", "claude-sonnet-4-5"]
            tmux_run("new-session", "-d", "-s", "recovery", "-x", "120", "-y", "36", "-c", env["HOME"], shlex.join(command)).check_returncode()
            wait_for("genuine TS fallback session", lambda: "durable recovery sentinel" in screen())
            hello, roster = daemon_request(socket, {"type": "list"})
            assert hello["appVersion"] == expected_runtime, hello
            wait_for("persisted session attachment", lambda: any(
                session.get("sessionFile") == str(transcript) and session.get("attachedClients", 0) > 0
                for session in daemon_request(socket, {"type": "list"})[1].get("data", {}).get("sessions", [])))
            tmux_run("send-keys", "-t", "recovery", "-l", "recovery-input-witness").check_returncode()
            wait_for("responsive fallback input", lambda: "recovery-input-witness" in screen())
            assert transcript.read_text().startswith(original)
            evidence.update(status="passed", fallback_hello=hello, fallback_roster=roster,
                            responsive_screen=screen(), transcript_preserved=True)
        finally:
            # Track the fixture's daemon, worker, and inherited bootstrap children
            # before shutdown; they must stop writing before deleting their home.
            owned = set()
            namespace = f"PRIME_AGENT_CODING_AGENT_DIR={state}".encode()
            for process in Path("/proc").iterdir():
                if process.name.isdigit():
                    try:
                        if namespace in (process / "environ").read_bytes().split(b"\0"):
                            owned.add(int(process.name))
                    except (OSError, PermissionError):
                        pass
            tmux_run("kill-server")
            try:
                daemon_request(socket, {"type": "shutdown", "force": True})
            except (OSError, RuntimeError, ValueError):
                pass

            def alive():
                running = []
                for pid in owned:
                    try:
                        stat = Path(f"/proc/{pid}/stat").read_text()
                        if stat.rsplit(")", 1)[1].split()[0] != "Z":
                            running.append(pid)
                    except FileNotFoundError:
                        pass
                return running

            try:
                wait_for("fixture daemon and worker shutdown", lambda: not alive(), timeout=20)
            except RuntimeError:
                # A failed verifier must still release only its isolated children.
                for pid in alive():
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                wait_for("forced fixture cleanup", lambda: not alive(), timeout=10)
                raise
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recovery-archive", type=Path)
    parser.add_argument("--failure-mode", choices=("unsupported-host", "unusable-payload"), default="unsupported-host")
    for name in ("previous-archive", "previous-checksums", "previous-prefix", "fallback-tarball", "archive", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pfail-", dir="/tmp") as directory:
        try:
            report = exercise(args, Path(directory))
        except Exception as error:
            report = {"status": "failed", "error": str(error)}
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return int(report["status"] != "passed")


if __name__ == "__main__":
    raise SystemExit(main())
