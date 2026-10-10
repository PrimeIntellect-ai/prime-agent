#!/usr/bin/env python3
"""PR #3407: real TS/Rust daemon restart parity against one local SSE provider.

Run on Linux with PA_TS_BINARY and PA_RUST_BINARY pointing at executable
Prime Agent 0.9.8 and the built prime-agent CLI. No external credentials are used.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

LIMIT = 90
TS_ARCHIVE_SHA256 = "83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2"


def until(label, predicate, seconds=LIMIT):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise TimeoutError(label)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), self.Handler)
        self.lock = threading.Lock()
        self.calls = {"busy": 0, "park": 0, "idle": 0}
        self.chunks = {"busy": 0, "park": 0, "idle": 0}
        self.release = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            request = body.decode("utf-8", errors="replace")
            lane = next((key for key in ("busy", "park", "idle")
                         if "PARITY_" + key.upper() in request), None)
            if lane is None:
                self.send_error(400, "unknown fixture prompt")
                return
            with self.server.lock:
                self.server.calls[lane] += 1
                number = self.server.calls[lane]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()

            def emit(delta, finish=None):
                chunk = {"id": "chatcmpl-parity", "object": "chat.completion.chunk",
                         "created": 1750000000, "model": "parity-1", "choices": [
                             {"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()

            try:
                if lane != "idle" and number == 1:
                    emit({"role": "assistant", "content": lane + "-started"})
                    with self.server.lock:
                        self.server.chunks[lane] += 1
                    self.server.release.wait(LIMIT)
                    return
                emit({"role": "assistant", "content": lane + "-completed"})
                emit({}, "stop")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass


class Client:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(10)
        self.sock.connect(str(path))
        self.stream = self.sock.makefile("rwb", buffering=0)
        self.hello = self.read()
        if self.hello.get("type") != "daemon_hello":
            raise RuntimeError(f"bad daemon hello: {self.hello}")
        self.protocol = self.hello.get("protocol")
        if not isinstance(self.protocol, dict) or not isinstance(self.protocol.get("version"), int):
            raise RuntimeError(f"daemon hello lacks protocol: {self.hello}")
        self.counter = 0

    def read(self):
        line = self.stream.readline()
        if not line:
            raise EOFError("daemon socket closed")
        return json.loads(line)

    def response(self, command):
        self.counter += 1
        request_id = f"fixture-{self.counter}"
        envelope = {"type": "command", "id": request_id,
                    "protocol": self.protocol, "command": command}
        self.stream.write((json.dumps(envelope) + "\n").encode())
        while True:
            row = self.read()
            if row.get("id") == request_id:
                return row

    def command(self, command):
        row = self.response(command)
        if row.get("success") is not True:
            raise RuntimeError(f"{command['type']} failed: {row}")
        return row.get("data", {})

    def close(self):
        try:
            self.stream.close()
        finally:
            self.sock.close()


def connect_ready(path, process):
    def connect():
        if process.poll() is not None:
            raise RuntimeError(f"daemon exited early: {process.returncode}")
        try:
            return Client(path)
        except (OSError, EOFError, TimeoutError):
            return None
    return until("daemon hello", connect, 25)


def clean_env(root, agent, kind):
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ")
           if key in os.environ}
    # CI supplies PI_PACKAGE_DIR only if its official TS launcher requires it.
    if kind == "ts" and "PI_PACKAGE_DIR" in os.environ:
        env["PI_PACKAGE_DIR"] = os.environ["PI_PACKAGE_DIR"]
    for key in ("PRIME_AGENT_KERNEL_PYTHON", "PA_E2E_KERNEL_PYTHON"):
        if key in os.environ:
            env[key] = os.environ[key]
    env.update(HOME=str(root / "home"), TMPDIR=str(root / "tmp"),
               XDG_CONFIG_HOME=str(root / "xdg"),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent),
               PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_MODEL_PROVIDER="parity-local",
               PRIME_AGENT_MODEL="parity-1", PI_OFFLINE="1",
               DO_NOT_TRACK="1", NO_COLOR="1",
               PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS="10000")
    return env


def run_one(kind, binary, root):
    root.mkdir()
    for name in ("home", "tmp", "xdg", "agent/sessions"):
        (root / name).mkdir(parents=True)
    agent = root / "agent"
    sock_path = root / "daemon.sock"
    provider = Provider()
    server = threading.Thread(target=provider.serve_forever, daemon=True)
    server.start()
    model = {"providers": {"parity-local": {
        "api": "openai-completions",
        "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
        "apiKey": "fixture-only", "models": [{"id": "parity-1",
            "name": "Parity 1", "api": "openai-completions",
            "contextWindow": 128000, "maxTokens": 4096}]}}}
    (agent / "models.json").write_text(json.dumps(model))
    (agent / "settings.json").write_text('{"onboardingCompleted":true}')
    env = clean_env(root, agent, kind)
    command = [str(binary), "--mode", "daemon", "--daemon-socket", str(sock_path)]
    processes = []
    logs = []
    client = None
    result = {"binary": str(binary), "sha256": digest(binary), "kind": kind}

    def launch():
        log = open(root / f"daemon-{len(processes) + 1}.log", "wb")
        logs.append(log)
        process = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        return process, connect_ready(sock_path, process)

    try:
        version = subprocess.run([str(binary), "--version"], cwd=root, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, timeout=15, check=True)
        result["cli_version"] = version.stdout.strip()[:500]
        if kind == "ts" and "0.9.8" not in result["cli_version"]:
            raise RuntimeError(f"unexpected TS version: {result['cli_version']}")
        daemon, client = launch()
        result["hello"] = {key: client.hello.get(key) for key in
                           ("appVersion", "protocol", "schemaId")}
        sessions = {}
        for lane in ("busy", "park", "idle"):
            data = client.command({"type": "create", "config": {
                "cwd": str(root), "agentDir": str(agent),
                "sessionDir": str(agent / "sessions"),
                "provider": "parity-local", "model": "parity-1",
                "telemetryDisabled": True, "noExtensions": True,
                "noSkills": True, "noContextFiles": True}})
            sessions[lane] = {"id": data.get("id") or data.get("sessionId"),
                              "file": data.get("sessionFile")}
            if not all(sessions[lane].values()):
                raise RuntimeError(f"create {lane} lacks session identity: {data}")

        def prompt(lane, wait=False):
            return client.command({"type": "prompt_and_wait" if wait else "prompt",
                                   "activeSessionId": sessions[lane]["id"],
                                   "message": "PARITY_" + lane.upper()})

        prompt("idle", wait=True)
        idle_before = Path(sessions["idle"]["file"]).read_bytes()
        prompt("park")
        until("park stream chunk", lambda: provider.chunks["park"] >= 1)
        client.command({"type": "follow_up", "activeSessionId": sessions["park"]["id"],
                        "message": "PARKED_QUEUE_DO_NOT_RUN"})
        client.command({"type": "abort", "activeSessionId": sessions["park"]["id"]})
        until("park turn settled", lambda: client.command({"type": "get_state",
              "activeSessionId": sessions["park"]["id"]}).get("isStreaming") is False)
        queue = client.command({"type": "get_queue",
                                "activeSessionId": sessions["park"]["id"]})
        park_before = Path(sessions["park"]["file"]).read_bytes()
        result["park_queue_before"] = queue.get("followUp")
        result["park_queue_before_data"] = queue
        prompt("busy")
        until("busy stream chunk", lambda: provider.chunks["busy"] >= 1)
        client.command({"type": "shutdown"})
        # The TS supervisor waits for connected clients to leave before exit.
        client.close()
        client = None
        until("daemon shutdown exit", lambda: daemon.poll() is not None, 45)
        daemon2, client = launch()
        result["restart_hello"] = {key: client.hello.get(key) for key in
                                   ("appVersion", "protocol", "schemaId")}
        # Absence of a TS continuation is a product observation, not a fixture timeout.
        try:
            until("busy continuation request", lambda: provider.calls["busy"] >= 2, 8)
        except TimeoutError:
            pass
        if provider.calls["busy"] >= 2:
            try:
                until("busy continuation persisted", lambda: "busy-completed" in
                      Path(sessions["busy"]["file"]).read_text(), 20)
            except TimeoutError:
                pass
        listed = client.command({"type": "list"}).get("sessions", [])
        result["restart_listed_sessions"] = listed
        listed_park = any((row.get("id") or row.get("activeSessionId")) ==
                          sessions["park"]["id"] for row in listed)
        # Do not attach/create to recover a missing worker: that would manufacture
        # the state under test. Only read a worker observed in the restarted list.
        park_queue_response = None
        park_state_response = None
        if listed_park:
            park_queue_response = client.response({"type": "get_queue",
                "activeSessionId": sessions["park"]["id"]})
            park_state_response = client.response({"type": "get_state",
                "activeSessionId": sessions["park"]["id"]})
        result["park_queue_after_restart_read"] = {
            "attempted": listed_park,
            "not_attempted_reason": None if listed_park else "worker absent from restarted list",
            "response": park_queue_response,
        }
        result["park_state_after_restart_response"] = park_state_response
        park_queue_after = (park_queue_response or {}).get("data", {})
        busy_text = Path(sessions["busy"]["file"]).read_text()
        controls = {"idle": idle_before, "park": park_before}
        result["control_transcripts"] = {}
        for lane, before in controls.items():
            after = Path(sessions[lane]["file"]).read_bytes()
            prefix_preserved = after.startswith(before)
            appended = after[len(before):] if prefix_preserved else None
            appended_rows = None
            append_parse_error = None
            if appended is not None:
                try:
                    appended_rows = [json.loads(line) for line in appended.splitlines()]
                except (ValueError, UnicodeDecodeError) as error:
                    append_parse_error = str(error)
            result["control_transcripts"][lane] = {
                "before_utf8": before.decode("utf-8"),
                "after_restart_utf8": after.decode("utf-8"),
                "before_sha256": hashlib.sha256(before).hexdigest(),
                "after_restart_sha256": hashlib.sha256(after).hexdigest(),
                "preexisting_bytes_preserved": prefix_preserved,
                "appended_utf8": None if appended is None else appended.decode("utf-8"),
                "appended_rows": appended_rows,
                "append_parse_error": append_parse_error,
            }
        park_control = result["control_transcripts"]["park"]
        park_appended = park_control["appended_rows"]
        park_lifecycle = park_appended[0] if park_appended and len(park_appended) == 1 else None
        previous_park_rows = [json.loads(line) for line in park_before.splitlines()]
        previous_park_row = previous_park_rows[-1]
        expected_status = "active" if kind == "rust" else "archived"
        park_only_lifecycle = bool(
            park_control["preexisting_bytes_preserved"] and
            isinstance(park_lifecycle, dict) and
            set(park_lifecycle) == {"type", "id", "parentId", "timestamp", "state"} and
            park_lifecycle.get("type") == "session_state" and
            park_lifecycle.get("state") == {"status": expected_status} and
            isinstance(previous_park_row.get("id"), str) and previous_park_row["id"] and
            park_lifecycle.get("parentId") == previous_park_row["id"] and
            all(park_lifecycle.get("id") != row.get("id") for row in previous_park_rows) and
            isinstance(park_lifecycle.get("id"), str) and park_lifecycle["id"] and
            isinstance(park_lifecycle.get("timestamp"), str) and park_lifecycle["timestamp"])
        result["observed"] = {
            "provider_requests": dict(provider.calls),
            "busy_continuation_requested": provider.calls["busy"] >= 2,
            "busy_continued": "busy-completed" in busy_text,
            "park_not_executed": provider.calls["park"] == 1,
            "idle_not_executed": provider.calls["idle"] == 1,
            "park_queue_before_shutdown_matches": queue.get("followUp") ==
                                                  ["PARKED_QUEUE_DO_NOT_RUN"],
            "listed_park": listed_park,
            "park_queue_after_restart_preserved":
                (park_queue_response or {}).get("success") is True and
                park_queue_after == queue,
            "park_idle_after_restart":
                (park_state_response or {}).get("success") is True and
                (park_state_response or {}).get("data", {}).get("isStreaming") is False,
            "park_transcript_only_expected_lifecycle_append": park_only_lifecycle,
            "park_appended_lifecycle_status":
                park_lifecycle.get("state", {}).get("status")
                if isinstance(park_lifecycle, dict) and
                isinstance(park_lifecycle.get("state"), dict) else None,
            "park_transcript_unchanged": result["control_transcripts"]["park"]["before_sha256"] ==
                                         result["control_transcripts"]["park"]["after_restart_sha256"],
            "idle_transcript_unchanged": result["control_transcripts"]["idle"]["before_sha256"] ==
                                         result["control_transcripts"]["idle"]["after_restart_sha256"],
            "listed_session_count": len(listed),
            "listed_busy": any((row.get("id") or row.get("activeSessionId")) ==
                               sessions["busy"]["id"] for row in listed),
            "busy_transcript_sha256": digest(sessions["busy"]["file"]),
        }
        client.command({"type": "shutdown"})
        client.close()
        client = None
        until("restarted daemon exit", lambda: daemon2.poll() is not None, 45)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if client:
            client.close()
        provider.release.set()
        provider.shutdown()
        provider.server_close()
        for process in processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
        for log in logs:
            log.close()
        result["daemon_log_tails"] = [
            (root / f"daemon-{index}.log").read_bytes()[-2000:].decode("utf-8", "replace")
            for index in range(1, len(logs) + 1)]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    receipt_path = args.receipt.resolve()
    repo = Path(__file__).resolve().parent.parent
    if receipt_path == repo or repo in receipt_path.parents:
        parser.error("receipt must be outside the repository")
    receipt = {"fixture": "pr-3407-graceful-shutdown",
               "ts_reference": {"version": "0.9.8", "expected_archive_sha256":
                   TS_ARCHIVE_SHA256},
               "results": {}}
    try:
        if sys.platform != "linux":
            raise RuntimeError("this real-binary fixture requires Linux")
        archive = Path(os.environ["PA_TS_ARCHIVE"]).resolve()
        archive_sha = digest(archive)
        receipt["ts_reference"]["archive"] = str(archive)
        receipt["ts_reference"]["verified_archive_sha256"] = archive_sha
        if archive_sha != TS_ARCHIVE_SHA256:
            raise RuntimeError("official TS archive SHA-256 mismatch")
        binaries = {kind: Path(os.environ[f"PA_{kind.upper()}_BINARY"]).resolve()
                    for kind in ("ts", "rust")}
        for kind, binary in binaries.items():
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise RuntimeError(f"{kind} binary is missing or not executable: {binary}")
        with tempfile.TemporaryDirectory(prefix="pa-pr3407-") as temp:
            for kind, binary in binaries.items():
                try:
                    receipt["results"][kind] = run_one(kind, binary, Path(temp) / kind)
                except Exception as error:
                    receipt["results"][kind] = {"binary": str(binary),
                                                 "error": f"{type(error).__name__}: {error}"}
    except Exception as error:
        receipt["preflight_error"] = f"{type(error).__name__}: {error}"
    results = receipt["results"]
    checks = ("busy_continued", "park_not_executed", "idle_not_executed",
              "park_queue_before_shutdown_matches", "listed_park",
              "park_queue_after_restart_preserved", "park_idle_after_restart",
              "park_transcript_only_expected_lifecycle_append",
              "idle_transcript_unchanged", "listed_busy")
    comparisons = checks + ("park_appended_lifecycle_status",)
    observed = [results.get(kind, {}).get("observed") for kind in ("ts", "rust")]
    receipt["parity"] = bool("preflight_error" not in receipt and
        all("error" not in results.get(kind, {}) for kind in ("ts", "rust")) and
        all(observed) and
        all(all(item.get(key) for key in checks) for item in observed) and
        all(observed[0].get(key) == observed[1].get(key) for key in comparisons))
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
