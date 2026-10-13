#!/usr/bin/env python3
"""Exercise a shipped TS daemon's post-install coordinator against a Rust candidate.

This launches no model inference. All homes, sockets, and daemon ownership
registries are temporary. Run in a disposable Prime sandbox.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import time


def connect(path):
    stream = socket.socket(socket.AF_UNIX)
    stream.settimeout(30)
    try:
        stream.connect(str(path))
        reader = stream.makefile("r")
        hello = json.loads(reader.readline())
        return stream, reader, hello
    except BaseException:
        stream.close()
        raise


def request(path, command):
    stream, reader, hello = connect(path)
    try:
        stream.sendall((json.dumps({"type": "command", "id": "probe", "protocol": hello["protocol"],
                                   "command": command}) + "\n").encode())
        while line := reader.readline():
            frame = json.loads(line)
            if frame.get("type") == "response" and frame.get("id") == "probe":
                if not frame.get("success"):
                    raise RuntimeError(frame)
                return frame.get("data")
        raise RuntimeError("daemon disconnected before response")
    finally:
        reader.close()
        stream.close()


def await_hello(path, child):
    deadline = time.monotonic() + 30
    while True:
        try:
            stream, reader, hello = connect(path)
            reader.close()
            stream.close()
            return hello
        except (OSError, ValueError):
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("old daemon did not become ready")
            time.sleep(0.05)


def stop_fixture_processes(home):
    """Stop only Linux processes that carry this fixture's unique HOME."""
    if not Path("/proc").is_dir():
        return
    expected = f"HOME={home}".encode()
    deadline = time.monotonic() + 10
    while True:
        matched = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                if expected in (entry / "environ").read_bytes().split(b"\0"):
                    matched.append(entry)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        if not matched:
            return
        for entry in matched:
            try:
                # Recheck after enumeration so a reused PID cannot be signalled.
                if expected in (entry / "environ").read_bytes().split(b"\0"):
                    os.kill(int(entry.name), signal.SIGKILL if time.monotonic() > deadline - 5 else signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError("fixture processes did not terminate")
        time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-archive", type=Path)
    parser.add_argument("--legacy-npm-prefix", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--candidate-archive", type=Path)
    parser.add_argument("--candidate-binary", type=Path)
    parser.add_argument("--with-session", action="store_true")
    parser.add_argument("--report", type=Path, required=True)
    options = parser.parse_args()
    if bool(options.legacy_archive) == bool(options.legacy_npm_prefix):
        parser.error("choose one legacy native archive or installed npm prefix")
    if bool(options.candidate_archive) == bool(options.candidate_binary):
        parser.error("choose one candidate archive or candidate binary")
    evidence = {}
    with tempfile.TemporaryDirectory(prefix="legacy-runtime-") as directory:
        root = Path(directory)
        old_dir, candidate_dir = root / "ts", root / "rust"
        if options.legacy_archive:
            old_dir.mkdir()
            with tarfile.open(options.legacy_archive) as archive:
                archive.extractall(old_dir, filter="data")
            old_command = [str(old_dir / "prime-agent")]
        else:
            shutil.copytree(options.legacy_npm_prefix, old_dir, symlinks=True)
            old_command = [options.node, str(old_dir / "lib/node_modules/prime-agent/dist/bundle/cli.js")]
        if options.candidate_archive:
            candidate_dir.mkdir()
            with tarfile.open(options.candidate_archive) as archive:
                archive.extractall(candidate_dir, filter="data")
            candidate = candidate_dir / "prime-agent"
        else:
            candidate = options.candidate_binary.resolve()
        home, agent, temporary = root / "home", root / "agent", root / "tmp"
        for path in (home, agent / "update-restarts", temporary):
            path.mkdir(parents=True)
        endpoint = temporary / "daemon.sock"
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(("PI_", "PRIME_AGENT_")):
                del env[key]
        env.update(HOME=str(home), TMPDIR=str(temporary), DO_NOT_TRACK="1",
                   XDG_CONFIG_HOME=str(home / ".config"), XDG_DATA_HOME=str(home / ".local/share"),
                   XDG_CACHE_HOME=str(home / ".cache"),
                   PRIME_AGENT_CODING_AGENT_DIR=str(agent), PRIME_AGENT_OFFLINE="1",
                   PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=str(root / "owners"))
        with (root / "old.log").open("w") as log:
            old = subprocess.Popen(old_command + ["--mode", "daemon", "--daemon-socket", str(endpoint)],
                                   env=env, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        threading.Thread(target=old.wait, daemon=True).start()
        successor_pid = None
        try:
            evidence["predecessor"] = await_hello(endpoint, old)
            transcript = None
            if options.with_session:
                # Seed an existing transcript: TS deliberately buffers a brand
                # new session until its first assistant message exists.
                transcript = agent / "sessions" / "migration.jsonl"
                transcript.parent.mkdir(exist_ok=True)
                stamp = "2026-10-09T00:00:00.000Z"
                rows = [
                    {"type":"session","version":3,"id":"11111111-2222-4333-8444-555555555555","timestamp":stamp,"cwd":str(root)},
                    {"type":"message","id":"seed-assistant","parentId":None,"timestamp":stamp,"message":{
                        "role":"assistant","content":[{"type":"text","text":"durable migration sentinel"}],
                        "api":"openai-completions","provider":"openai","model":"gpt-4o-mini",
                        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
                                 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
                        "stopReason":"stop","timestamp":1791504000000}},
                ]
                transcript.write_text("".join(json.dumps(row)+"\n" for row in rows))
                created = request(endpoint, {"type": "create", "sessionPath":str(transcript), "config": {
                    "cwd": str(root), "agentDir": str(agent), "provider": "openai", "model": "gpt-4o-mini",
                    "noExtensions": True, "noSkills": True, "noContextFiles": True, "telemetryDisabled": True}})
                evidence["created_session"] = created
                request(endpoint, {"type": "append_custom_message", "activeSessionId": created["activeSessionId"],
                                   "message": {"customType": "migration-test", "content": "live TS checkpoint sentinel",
                                               "display": True, "timestamp": int(time.time() * 1000)}})
                transcript = Path(created["sessionFile"])
                deadline = time.monotonic() + 10
                while True:
                    before = transcript.read_text()
                    if "live TS checkpoint sentinel" in before:
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("TS session did not persist the custom message")
                    time.sleep(0.05)
            status_path = agent / "update-restarts" / "coordinator.json"
            result = subprocess.run([str(candidate), "update", "--internal-update-restart-coordinator", "--daemon-socket",
                                     str(endpoint), "--internal-update-restart-status", str(status_path)],
                                    env=env, cwd=root, capture_output=True, text=True, timeout=180)
            evidence.update(exit_code=result.returncode, stdout=result.stdout, stderr=result.stderr,
                            status=json.loads(status_path.read_text()))
            stream, reader, hello = connect(endpoint)
            reader.close()
            stream.close()
            evidence["successor"] = hello
            successor_pid = hello["supervisorPid"]
            assert result.returncode == 0, evidence
            assert evidence["status"]["phase"] == "complete", evidence
            assert successor_pid != old.pid
            if options.with_session:
                assert evidence["status"]["counts"]["restored"] == 1, evidence
                assert evidence["status"]["counts"]["failed"] == 0, evidence
                assert transcript.read_text().startswith(before), "old transcript must remain intact"
                evidence["transcript_preserved"] = True
                evidence["restored_sessions"] = request(endpoint, {"type": "list"})
                restored = evidence["restored_sessions"]["sessions"]
                assert len(restored) == 1, restored
                assert restored[0]["sessionId"] == created["sessionId"], restored
                assert restored[0]["sessionFile"] == str(transcript), restored
                witness = "restored-session-bash-witness"
                evidence["restored_bash"] = request(endpoint, {
                    "type": "execute_bash_and_wait", "activeSessionId": restored[0]["activeSessionId"],
                    "command": f"printf '%s' '{witness}'"})
                bash = evidence["restored_bash"]
                assert bash["output"] == witness and bash["exitCode"] == 0, bash
                assert not bash["cancelled"] and not bash["truncated"], bash
                deadline = time.monotonic() + 10
                while True:
                    after = transcript.read_text()
                    rows = [json.loads(line) for line in after.splitlines()]
                    if any(row.get("message", {}).get("role") == "bashExecution"
                           and row["message"].get("output") == witness for row in rows):
                        assert after.startswith(before), "bash execution must preserve old transcript"
                        evidence["restored_bash_persisted"] = True
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("restored worker did not persist the bash result")
                    time.sleep(0.05)
            evidence["success"] = True
        finally:
            evidence["old_log"] = (root / "old.log").read_text()
            options.report.parent.mkdir(parents=True, exist_ok=True)
            options.report.write_text(json.dumps(evidence, indent=2) + "\n")
            try:
                request(endpoint, {"type": "shutdown", "force": True})
            except (OSError, ValueError, RuntimeError):
                pass
            if old.poll() is None:
                old.terminate()
            old.wait(timeout=30)
            stop_fixture_processes(home)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
