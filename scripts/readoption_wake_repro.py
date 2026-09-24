#!/usr/bin/env python3
"""Deterministic re-adoption wake repro (lane readoption-wake-path).

An ISOLATED daemon (agent dir + socket + kernel venv) hosts one session.
The session starts a detached background bash() watcher (a real kernel
cell), its turn settles (idle), the SUPERVISOR is killed -9 and relaunched
(adopting the still-live worker), and when the watcher process exits the
bash-completion notice must WAKE the session.

Usage: repro_readoption_wake.py <path-to-pa-daemon> <work-dir>
Prints WAKE_OK on the green path; on the red path prints the frozen
evidence (no bash-done row, kernel stderr's rejection) and exits 1.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DAEMON = sys.argv[1]
ROOT = Path(sys.argv[2])
AGENT_DIR = ROOT / "agent"
SOCK = ROOT / "daemon.sock"
SESSIONS = AGENT_DIR / "sessions"
KILL_MS = str(120 * 1000)  # workers outlive the supervisor-lost window

MOCK_PORT = [None]
MOCK_REQUESTS = []
MOCK_LOCK = threading.Lock()


def sse(chunks):
    payload = "".join(f"data: {c}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return (
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
        f"Connection: close\r\nContent-Length: {len(payload)}\r\n\r\n{payload}"
    ).encode()


def chunk(delta, finish=None):
    return json.dumps(
        {
            "id": "chatcmpl-wake",
            "object": "chat.completion.chunk",
            "created": 1750000000,
            "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
    )


WATCHER_CODE = 'bash("sleep 12; echo RW_WAKE_DONE")\nprint("watcher armed")'
TOOL_CALL = json.dumps({"code": WATCHER_CODE})


class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length)
        with MOCK_LOCK:
            MOCK_REQUESTS.append(body.decode("utf-8", "replace"))
            index = len(MOCK_REQUESTS) - 1
        if index == 0:
            data = sse(
                [
                    chunk(
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-wake-1",
                                    "type": "function",
                                    "function": {"name": "ipython", "arguments": TOOL_CALL},
                                }
                            ],
                        },
                        None,
                    ),
                    chunk({}, "tool_calls"),
                ]
            )
        elif index == 1:
            data = sse(
                [
                    chunk({"role": "assistant", "content": "watcher started"}, None),
                    chunk({}, "stop"),
                ]
            )
        else:
            data = sse(
                [
                    chunk({"role": "assistant", "content": "woken by the bash-done notice"}, None),
                    chunk({}, "stop"),
                ]
            )
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def start_mock():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


class Wire:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(path))
        self.buf = b""
        hello = self.readline()
        assert hello.get("type") == "daemon_hello", hello

    def readline(self):
        while b"\n" not in self.buf:
            data = self.sock.recv(65536)
            if not data:
                raise RuntimeError("daemon closed")
            self.buf += data
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)

    def request(self, command, rid, timeout=180.0):
        envelope = {
            "type": "command",
            "id": rid,
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": command,
        }
        self.sock.sendall((json.dumps(envelope) + "\n").encode())
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.sock.settimeout(1.0)
            try:
                line = self.readline()
            except (TimeoutError, socket.timeout):
                continue
            if line.get("id") == rid:
                return line
        raise TimeoutError(f"no response for {rid}")


def spawn_daemon():
    env = dict(os.environ)
    env.pop("PRIME_API_KEY", None)
    env["PRIME_AGENT_CODING_AGENT_DIR"] = str(AGENT_DIR)
    env["PRIME_AGENT_KERNEL_PYTHON"] = os.environ.get(
        "RWP_KERNEL_PYTHON", str(ROOT.parent / "rwp-kernel-venv/bin/python")
    )
    env["PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS"] = KILL_MS
    proc = subprocess.Popen(
        [DAEMON, "supervisor", "--socket", str(SOCK), "--agent-dir", str(AGENT_DIR)],
        stdout=(ROOT / "supervisor.out").open("ab"),
        stderr=(ROOT / "supervisor.err").open("ab"),
        env=env,
        start_new_session=True,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if SOCK.exists():
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"supervisor died at boot: rc={proc.returncode}")
        time.sleep(0.05)
    raise RuntimeError("supervisor socket never appeared")


def wait_for(predicate, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.25)
    raise TimeoutError(f"condition never became true: {what}")


def main():
    # The work-dir must be disposable AND fresh: refuse an existing path
    # (a caller pointing this at a real directory must never lose it).
    if ROOT.exists():
        raise RuntimeError(f"work-dir already exists: {ROOT} (use a fresh disposable path)")
    ROOT.mkdir(parents=True)
    for d in (AGENT_DIR, SESSIONS):
        d.mkdir(parents=True)
    port = start_mock()
    (AGENT_DIR / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": f"http://127.0.0.1:{port}/v1",
                        "apiKey": "sk-wake",
                        "models": [
                            {
                                "id": "mock-1",
                                "name": "Mock 1",
                                "api": "openai-completions",
                                "contextWindow": 128000,
                                "maxTokens": 4096,
                            }
                        ],
                    }
                }
            }
        )
    )
    supervisor = spawn_daemon()
    client = Wire(SOCK)
    created = client.request(
        {
            "type": "create",
            "name": "wake-lane",
            "config": {
                "cwd": str(ROOT),
                "sessionDir": str(SESSIONS),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        },
        "c1",
    )
    assert created["success"], created
    active_id = created["data"].get("id") or created["data"]["activeSessionId"]
    session_id = created["data"]["sessionId"]
    session_file = SESSIONS / f"{session_id}.jsonl"
    print(f"session: {session_id} active: {active_id}")

    started = client.request(
        {"type": "prompt_and_wait", "activeSessionId": active_id, "message": "start the watcher and stop"},
        "p1",
        timeout=240,
    )
    assert started["success"], started
    first = client.request({"type": "get_messages", "activeSessionId": active_id}, "gm0")
    assert first["success"], first
    assert "watcher started" in json.dumps(first["data"]), first
    print("turn 1 settled; the detached watcher runs (sleep 12)")

    # The false-green guard: the watcher must still be RUNNING at the
    # kill — a completion that already landed means the wake was not
    # exercised across re-adoption (fail loudly instead of matching a
    # pre-restart reply later).
    prekill = client.request(
        {"type": "get_messages", "activeSessionId": active_id}, "gm0b"
    )
    assert prekill.get("success"), prekill
    assert "bash-done" not in json.dumps(prekill["data"]), (
        "the watcher completed BEFORE the restart - the repro did not "
        "exercise the re-adoption wake"
    )

    # The supervisor dies hard; the worker survives, orphaned.
    os.kill(supervisor.pid, signal.SIGKILL)
    supervisor.wait()
    client.sock.close()
    SOCK.unlink(missing_ok=True)
    print(f"supervisor killed -9 at t+0; relaunching")
    supervisor = spawn_daemon()
    client = Wire(SOCK)

    def listed():
        response = client.request({"type": "list"}, "l")
        return response["data"]["sessions"] if response.get("success") else []

    wait_for(
        lambda: any(s.get("sessionId") == session_id or s.get("id") == active_id for s in listed()),
        30,
        "adoption",
    )
    print("worker re-adopted by the second supervisor generation")

    # The watcher exits ~12s after its cell; the notice must wake the session.
    def woken():
        response = client.request(
            {"type": "get_messages", "activeSessionId": active_id}, "gm"
        )
        if not response.get("success"):
            return False
        return "woken by the bash-done notice" in json.dumps(response["data"])

    try:
        wait_for(woken, 90, "the bash-done wake")
    except TimeoutError:
        file_rows = session_file.read_text() if session_file.exists() else ""
        kernel_stderr = ""
        stderr_path = AGENT_DIR / "session-artifacts" / session_id / "kernel-stderr.log"
        if stderr_path.exists():
            kernel_stderr = stderr_path.read_text()
        print("WAKE_MISSING: the session stayed asleep across re-adoption")
        print(f"  async_bash_completion row persisted: {'async_bash_completion' in file_rows}")
        rejection = [l for l in kernel_stderr.splitlines() if "not accepted" in l or "bash.completed" in l]
        print(f"  kernel stderr rejection lines: {rejection[:3]}")
        print(f"  provider requests seen: {len(MOCK_REQUESTS)}")
        for i, body in enumerate(MOCK_REQUESTS):
            print(f"  --- request {i} (last 400 chars):")
            print("  " + body[-400:].replace("\n", " ")[:400])
        # The red path cleans up like the green one: a leaked supervisor
        # (and its adopted workers) would poison later runs.
        try:
            client.request({"type": "kill", "activeSessionId": active_id}, "k1")
        except Exception:
            pass
        os.kill(supervisor.pid, signal.SIGTERM)
        try:
            supervisor.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.kill(supervisor.pid, signal.SIGKILL)
        sys.exit(1)

    file_rows = session_file.read_text()
    assert "async_bash_completion" in file_rows, "no durable notice row"
    assert "[bash-done pid:" in file_rows, "no bash-done content row"
    print("WAKE_OK: the bash-done notice woke the re-adopted session")
    client.request({"type": "kill", "activeSessionId": active_id}, "k1")
    os.kill(supervisor.pid, signal.SIGTERM)
    try:
        supervisor.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.kill(supervisor.pid, signal.SIGKILL)


if __name__ == "__main__":
    main()
