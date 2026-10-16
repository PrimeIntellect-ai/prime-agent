#!/usr/bin/env python3
"""Capture real TS/Rust daemon HTTP requests for a synthetic GLM→DeepSeek switch.

Only disposable homes, session workers and loopback inference are used. This is
request capture, not a response-only differential or a live-model quality test.
Full request bytes and semantic differences remain in the receipt directory;
The owned fixture root is the only normalized value; JSON formatting/key order is retained.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256

TS_COMMIT = "7d442aafa985f9342134fac16c2ef41f03fb45c1"
SOURCE = "glm-5.3"
TARGET = "internal/deepseek-v4.1-flash"
PLAN = "SYNTHETIC_REPLAY_PLAN"
ANSWER = "SYNTHETIC_REPLAY_ANSWER"
LIMIT = 90


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class Capture(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        self.server.requests.append({"path": self.path, "headers": dict(self.headers), "raw": raw, "body": body})
        first = len(self.server.requests) == 1
        def chunk(value, finish=None):
            return {"id": "synthetic-response", "object": "chat.completion.chunk", "created": 1,
                    "model": body["model"], "choices": [{"index": 0, "delta": value, "finish_reason": finish}]}
        events = [chunk({"role": "assistant"})]
        if first:
            events.append(chunk({"reasoning_content": PLAN}))
        events.extend([chunk({"content": ANSWER if first else "Fixture complete."}), chunk({}, "stop")])
        wire = "".join("data: " + json.dumps(x) + "\n\n" for x in events) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


class Client:
    def __init__(self, path, process):
        self.socket = socket.socket(socket.AF_UNIX)
        deadline = time.monotonic() + LIMIT
        while True:
            if process.poll() is not None:
                raise RuntimeError("owned daemon exited before its socket became ready")
            try:
                self.socket.connect(str(path))
                break
            except (FileNotFoundError, ConnectionRefusedError):
                if time.monotonic() >= deadline:
                    raise TimeoutError("owned daemon socket readiness")
                threading.Event().wait(0.025)
        self.socket.settimeout(LIMIT)
        self.reader = self.socket.makefile("rb")
        self.hello = self.read()
        assert self.hello["type"] == "daemon_hello", self.hello
        self.sequence = 0
        self.transcript = [self.hello]

    def read(self):
        line = self.reader.readline()
        if not line:
            raise EOFError("daemon closed before command completion")
        return json.loads(line)

    def command(self, command):
        self.sequence += 1
        identity = "wire-" + str(self.sequence)
        protocol = self.hello.get("protocol", {"name": "prime-agent.daemon", "version": 7})
        envelope = {"type": "command", "id": identity, "protocol": protocol, "command": command}
        self.transcript.append(envelope)
        self.socket.sendall(canonical(envelope) + b"\n")
        while True:
            value = self.read()
            self.transcript.append(value)
            if value.get("id") == identity:
                assert value.get("success"), value
                return value.get("data")

    def close(self):
        self.reader.close()
        self.socket.close()


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def run(binary, label, root, artifacts):
    for name in ("home", "agent", "sessions", "work", "tmp", "config", "cache", "data"):
        (root / name).mkdir(parents=True)
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TZ", "PI_PACKAGE_DIR",
           "PRIME_AGENT_KERNEL_PYTHON", "PA_E2E_KERNEL_PYTHON") if k in os.environ}
    env.update(HOME=str(root / "home"), TMPDIR=str(root / "tmp"),
               PI_CODING_AGENT_DIR=str(root / "agent"), PRIME_AGENT_CODING_AGENT_DIR=str(root / "agent"),
               PI_SESSION_DIR=str(root / "sessions"), PRIME_AGENT_SESSION_DIR=str(root / "sessions"),
               XDG_CONFIG_HOME=str(root / "config"), XDG_CACHE_HOME=str(root / "cache"),
               XDG_DATA_HOME=str(root / "data"), PI_OFFLINE="1", DO_NOT_TRACK="1",
               PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS="250")
    server = Capture()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider = {"api": "openai-completions", "apiKey": "fixture-only",
                "baseUrl": f"http://127.0.0.1:{server.server_address[1]}/v1",
                "models": [{"id": identity, "name": identity, "reasoning": True,
                            "contextWindow": 128000, "maxTokens": 4096} for identity in (SOURCE, TARGET)]}
    (root / "agent/models.json").write_text(json.dumps({"providers": {"prime-inference": provider}}))
    (root / "agent/settings.json").write_text(json.dumps({"prewarmPythonKernel": False,
        "compaction": {"enabled": False}, "retry": {"enabled": False},
        "defaultProvider": "prime-inference", "defaultModel": SOURCE}))
    path = root / "daemon.sock"
    client = None
    with open(artifacts / f"{label}-daemon.log", "wb") as log:
        process = subprocess.Popen([str(binary), "--mode", "daemon", "--daemon-socket", str(path)],
            cwd=root / "work", env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            client = Client(path, process)
            created = client.command({"type": "create", "config": {"cwd": str(root / "work"),
                "sessionDir": str(root / "sessions"), "provider": "prime-inference", "model": SOURCE}})
            session = created.get("id") or created["sessionId"]
            attached = client.command({"type": "attach", "activeSessionId": session})
            session = attached.get("activeSessionId", session)
            client.command({"type": "prompt_and_wait", "activeSessionId": session,
                            "message": "Establish synthetic reasoning history."})
            client.command({"type": "set_model", "activeSessionId": session,
                            "provider": "prime-inference", "modelId": TARGET})
            client.command({"type": "prompt_and_wait", "activeSessionId": session,
                            "message": "Continue after the synthetic model switch."})
            assert len(server.requests) == 2, f"expected exactly two inference requests, got {len(server.requests)}"
            for number, request in enumerate(server.requests, 1):
                (artifacts / f"{label}-request-{number}.headers.json").write_bytes(canonical({"path": request["path"], "headers": request["headers"]}))
                (artifacts / f"{label}-request-{number}.raw.json").write_bytes(request["raw"])
                normalized = request["raw"].replace(str(root).encode(), b"<FIXTURE_ROOT>")
                (artifacts / f"{label}-request-{number}.normalized.json").write_bytes(normalized)
            (artifacts / f"{label}-daemon-transcript.json").write_bytes(canonical(client.transcript))
            replay = [m for m in server.requests[1]["body"]["messages"] if m.get("role") == "assistant"]
            assert len(replay) == 1, replay
            assert server.requests[0]["body"]["model"] == SOURCE
            assert server.requests[1]["body"]["model"] == TARGET
            expected = ({"role": "assistant", "content": PLAN + ANSWER} if label == "ts" else
                        {"role": "assistant", "content": ANSWER, "reasoning_content": PLAN})
            assert replay[0] == expected, {"actual": replay[0], "expected": expected}
            return {"request_count": 2, "replayed_assistant": replay[0],
                    "binary_sha256": sha256(binary), "hello": client.hello}
        finally:
            if client is not None:
                client.close()
            stop(process)
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def differences(left, right, path="$"):
    if type(left) is not type(right):
        return [{"path": path, "ts": left, "rust": right}]
    if isinstance(left, dict):
        result = []
        for key in sorted(left.keys() | right.keys()):
            if key not in left or key not in right:
                result.append({"path": f"{path}.{key}", "ts": left.get(key), "rust": right.get(key)})
            else:
                result.extend(differences(left[key], right[key], f"{path}.{key}"))
        return result
    if isinstance(left, list):
        if len(left) != len(right):
            return [{"path": path, "ts": left, "rust": right}]
        return [item for i, (a, b) in enumerate(zip(left, right)) for item in differences(a, b, f"{path}[{i}]")]
    return [] if left == right else [{"path": path, "ts": left, "rust": right}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    artifacts = args.receipt.parent / "reasoning-wire-captures"
    artifacts.mkdir(exist_ok=True)
    receipt = {"ts_revision": TS_COMMIT, "ts_archive_sha256": sha256(os.environ["PA_TS_ARCHIVE"]),
               "rust_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
               "normalizations": ["owned fixture root only; JSON formatting/key order retained"], "runs": {}}
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path:
        event = json.loads(Path(event_path).read_text())
        receipt["rust_pr_head"] = event.get("pull_request", {}).get("head", {}).get("sha")
    assert receipt["ts_archive_sha256"] == TS_ARCHIVE_SHA256, "unpinned TS archive"
    try:
        with tempfile.TemporaryDirectory(prefix="reasoning-wire-") as temp:
            for label in ("ts", "rust"):
                binary = Path(os.environ[f"PA_{label.upper()}_BINARY"]).resolve()
                receipt["runs"][label] = run(binary, label, Path(temp) / label, artifacts)
        for number in (1, 2):
            captures = {label: artifacts / f"{label}-request-{number}.normalized.json" for label in ("ts", "rust")}
            a, b = (captures[label].read_bytes() for label in ("ts", "rust"))
            receipt[f"request_{number}"] = {"byte_equal": a == b,
                "normalized_sha256": {label: sha256(path) for label, path in captures.items()},
                "raw_sha256": {label: sha256(artifacts / f"{label}-request-{number}.raw.json") for label in ("ts", "rust")},
                "all_nonvolatile_differences": differences(json.loads(a), json.loads(b))}
        receipt["result"] = "captured_expected_reasoning_policy_difference"
        receipt["parity_equal"] = False
        receipt["maintainer_adjudication_required"] = True
    except Exception as error:
        receipt["result"] = "failed"
        receipt["error"] = str(error)
        raise
    finally:
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"result": receipt["result"], "rust_revision": receipt["rust_revision"],
                      "parity_equal": receipt["parity_equal"]}))


if __name__ == "__main__":
    main()
