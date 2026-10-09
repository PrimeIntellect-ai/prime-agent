#!/usr/bin/env python3
"""Exercise a released TS /update in an isolated tmux session and local feed.

Uses no real provider credentials and sends no inference turns. The test checks
activation, daemon version replacement, session identity, and a responsive
restarted TUI. All sockets and state stay within a temporary directory.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time

from test_legacy_upgrade import (
    archive_identity, digest, execute, isolated_environment, publish_archive, release_server,
)
import npm_bridge


def daemon_request(path: Path, command: dict | None = None) -> tuple[dict, dict | None]:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(3)
        client.connect(str(path))
        stream = client.makefile("r")
        hello = json.loads(stream.readline())
        if command is None:
            return hello, None
        client.sendall((json.dumps({"type": "command", "id": "migration-probe", "protocol": hello["protocol"], "command": command}) + "\n").encode())
        while line := stream.readline():
            response = json.loads(line)
            if response.get("id") == "migration-probe":
                return hello, response
        raise RuntimeError("Daemon closed before replying")


def session_files(value) -> set[str]:
    if isinstance(value, dict):
        files = {value["sessionFile"]} if isinstance(value.get("sessionFile"), str) else set()
        for child in value.values():
            files.update(session_files(child))
        return files
    if isinstance(value, list):
        return set().union(*(session_files(child) for child in value))
    return set()


def wait_for(description: str, probe, timeout: float = 90):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = probe()
            if value:
                return value
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            last_error = str(error)
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}: {last_error}")


def exercise(root: Path, previous: Path, installer: Path | None, candidate: Path,
             npm_prefix: Path | None = None, previous_checksums: Path | None = None,
             fallback_tarball: Path | None = None) -> dict:
    version, candidate_platform = archive_identity(candidate)
    if npm_prefix:
        if previous_checksums is None or fallback_tarball is None:
            raise ValueError("Published npm checksums and fallback tarball are required")
        expected = next((line.split()[0] for line in previous_checksums.read_text().splitlines()
                         if len(line.split()) == 2 and line.split()[1].lstrip("*") == previous.name), None)
        if expected != digest(previous):
            raise ValueError("Historical npm artifact checksum mismatch")
        with tarfile.open(previous) as package:
            metadata = json.load(package.extractfile("package/package.json"))
            if metadata["name"] != "prime-agent" or metadata["bin"]["prime-agent"] != "dist/bundle/cli.js":
                raise ValueError("Unexpected historical npm package entrypoint")
            previous_version = metadata["version"]
            old_entrypoint = package.extractfile("package/dist/bundle/cli.js").read()
        platform = candidate_platform
    else:
        previous_version, platform = archive_identity(previous)
        assert platform == candidate_platform
    feed = root / "feed"
    if not npm_prefix:
        publish_archive(feed, previous)
    publish_archive(feed, candidate)
    manifest = {"version": version, "binaries": [{"platform": platform, "file": candidate.name, "sha256": digest(candidate)}]}
    if npm_prefix:
        bridge = npm_bridge.assemble(Path(__file__).resolve().parents[2], feed / "releases" / f"v{version}", version, "stable", fallback_tarball)
        manifest.update(package="prime-agent", tarball=f"releases/v{version}/{bridge['tarball']}")
    (feed / "latest.json").write_text(json.dumps(manifest))
    daemon_socket = root / "daemon.sock"
    tmux = ["tmux", "-S", str(root / "tmux.sock")]
    evidence = {
        "previous_version": previous_version, "candidate_version": version,
        "previous_archive": {"path": str(previous), "sha256": digest(previous)},
        "candidate_archive": {"path": str(candidate), "sha256": digest(candidate)},
        "installation_method": "npm" if npm_prefix else "native",
        "steps": [],
    }
    if installer:
        evidence["installer"] = {"path": str(installer), "sha256": digest(installer)}
    if npm_prefix:
        evidence["npm_bridge_sha256"] = bridge["sha256"]
    with release_server(feed) as base:
        env = isolated_environment(root / "user", base, "standard")
        env.update(TERM="xterm-256color", ANTHROPIC_API_KEY="fixture-not-a-real-key")
        state = Path(env["PRIME_AGENT_CODING_AGENT_DIR"])
        (state / "settings.json").write_text(json.dumps({"onboardingShown": True}))
        if npm_prefix:
            isolated_prefix = root / "npm prefix"
            shutil.copytree(npm_prefix, isolated_prefix, symlinks=True)
            entrypoint = isolated_prefix / "lib/node_modules/prime-agent/dist/bundle/cli.js"
            assert entrypoint.read_bytes() == old_entrypoint, "Npm fixture entrypoint differs from published bytes"
            env.update(npm_config_prefix=str(isolated_prefix), npm_config_cache=str(root / "npm-cache"),
                       npm_config_ignore_scripts="true", npm_config_audit="false", npm_config_fund="false",
                       npm_config_update_notifier="false", PRIME_AGENT_ALLOW_HTTP="1",
                       PRIME_AGENT_RUST_PREFIX=str(root / "rust prefix"),
                       PRIME_AGENT_DAEMON_SOCKET=str(daemon_socket))
            env["PATH"] = str(isolated_prefix / "bin") + os.pathsep + env["PATH"]
            public = isolated_prefix / "bin/prime-agent"
        else:
            public = Path(env["PRIME_AGENT_BIN_DIR"]) / "prime-agent"
            evidence["steps"].append(execute(["sh", str(installer), previous_version], env))
        # TS buffers unsaved drafts until an assistant message exists. Start
        # from a valid saved transcript so the migration exercises restoration.
        transcript = state / "sessions" / "migration.jsonl"
        transcript.parent.mkdir(exist_ok=True)
        stamp = "2026-10-09T00:00:00.000Z"
        rows = [
            {"type": "session", "version": 3, "id": "11111111-2222-4333-8444-555555555555", "timestamp": stamp, "cwd": env["HOME"]},
            {"type": "message", "id": "seed-assistant", "parentId": None, "timestamp": stamp, "message": {
                "role": "assistant", "content": [{"type": "text", "text": "durable migration sentinel"}],
                "api": "anthropic-messages", "provider": "anthropic", "model": "claude-sonnet-4-5",
                "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                "stopReason": "stop", "timestamp": 1791504000000}},
        ]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        original_transcript = transcript.read_text()
        command = [str(public), "--resume", str(transcript), "--daemon-socket", str(daemon_socket), "--provider", "anthropic", "--model", "claude-sonnet-4-5"]

        def tmux_run(*args):
            return subprocess.run(tmux + list(args), env=env, capture_output=True, text=True, timeout=10)

        def screen():
            captured = tmux_run("capture-pane", "-p", "-t", "migration")
            if captured.returncode:
                raise RuntimeError(captured.stderr)
            return captured.stdout

        try:
            started = tmux_run("new-session", "-d", "-s", "migration", "-x", "120", "-y", "36", "-c", env["HOME"], shlex.join(command))
            if started.returncode:
                raise RuntimeError(started.stderr)
            tmux_run("pipe-pane", "-o", "-t", "migration", "cat > " + shlex.quote(str(root / "terminal.log"))).check_returncode()
            wait_for("TS TUI ready", lambda: "durable migration sentinel" in screen() and "claude-sonnet" in screen())
            before_hello, before_roster = daemon_request(daemon_socket, {"type": "list"})
            evidence.update(before_hello=before_hello, before_roster=before_roster, before_screen=screen())
            # The shipped slash-name completion consumes Enter while appending
            # a space. End the name explicitly so this Enter submits the command.
            tmux_run("send-keys", "-t", "migration", "-l", "/update ").check_returncode()
            wait_for("update text rendered", lambda: "/update" in screen())
            tmux_run("send-keys", "-t", "migration", "Enter").check_returncode()
            wait_for("Rust daemon after /update", lambda: daemon_request(daemon_socket)[0].get("appVersion") == version, timeout=180)
            wait_for("restarted Rust TUI", lambda: (
                f"prime agent v{version}" in screen() or f"Prime Agent updated to v{version}" in screen()
            ) and "durable migration sentinel" in screen())
            wait_for("original session reattached", lambda: any(
                session.get("sessionFile") == str(transcript) and session.get("attachedClients", 0) > 0
                for session in daemon_request(daemon_socket, {"type": "list"})[1].get("data", {}).get("sessions", [])
            ))
            after_hello, after_roster = daemon_request(daemon_socket, {"type": "list"})
            evidence.update(after_hello=after_hello, after_roster=after_roster, after_screen=screen())
            evidence["steps"].append(execute([str(public), "--version"], env))
            assert before_hello["appVersion"] == previous_version
            assert after_hello.get("updateResume", {}).get("complete") is True, "Daemon did not finish update restoration"
            terminal_output = (root / "terminal.log").read_text(errors="replace")
            assert "could not coordinate the daemon restart" not in terminal_output.lower(), "Update coordinator could not launch"
            assert "could not restart the daemon" not in terminal_output, "Update coordinator reported restart failure"
            assert "daemon still runs the previous version" not in terminal_output, "Update coordinator reported a stale daemon"
            assert before_hello["supervisorPid"] != after_hello["supervisorPid"]
            previous_sessions = session_files(before_roster)
            assert previous_sessions, f"TS daemon had no session files: {before_roster}"
            assert previous_sessions <= session_files(after_roster), "Migrated daemon lost the original session"
            assert transcript.read_text().startswith(original_transcript), "Saved transcript was rewritten"
            evidence["transcript_preserved"] = True
            assert evidence["steps"][-1]["stdout"].strip() == version
            # Prove the new UI still accepts local input without provider calls.
            tmux_run("send-keys", "-t", "migration", "-l", "migration-input-witness").check_returncode()
            wait_for("responsive Rust input", lambda: "migration-input-witness" in screen())
            evidence["responsive_screen"] = screen()
            evidence["status"] = "passed"
        except Exception as error:
            evidence.update(status="failed", error=str(error))
            try:
                evidence["failure_screen"] = screen()
            except RuntimeError as capture_error:
                evidence["capture_error"] = str(capture_error)
            try:
                evidence["failure_hello"], evidence["failure_roster"] = daemon_request(daemon_socket, {"type": "list"})
            except (OSError, ValueError, RuntimeError) as daemon_error:
                evidence["daemon_error"] = str(daemon_error)
        finally:
            tmux_run("kill-server")
            terminal_log = root / "terminal.log"
            if terminal_log.exists():
                evidence["terminal_stream"] = terminal_log.read_text(errors="replace")
            try:
                hello, _ = daemon_request(daemon_socket, {"type": "shutdown", "force": True})
                pid = hello.get("supervisorPid")
                if pid:
                    def stopped():
                        try:
                            os.kill(pid, 0)
                            return False
                        except ProcessLookupError:
                            return True
                    wait_for("isolated daemon cleanup", stopped, timeout=20)
            except (OSError, ValueError, RuntimeError):
                pass
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous-archive", required=True, type=Path)
    method = parser.add_mutually_exclusive_group(required=True)
    method.add_argument("--installer-file", type=Path)
    method.add_argument("--previous-npm-prefix", type=Path)
    parser.add_argument("--previous-checksums", type=Path)
    parser.add_argument("--fallback-tarball", type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ptui-", dir="/tmp") as temporary:
        report = exercise(Path(temporary), args.previous_archive.resolve(),
                          args.installer_file.resolve() if args.installer_file else None,
                          args.archive.resolve(),
                          args.previous_npm_prefix.resolve() if args.previous_npm_prefix else None,
                          args.previous_checksums.resolve() if args.previous_checksums else None,
                          args.fallback_tarball.resolve() if args.fallback_tarball else None)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return int(report["status"] != "passed")


if __name__ == "__main__":
    raise SystemExit(main())
