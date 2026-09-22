#!/usr/bin/env python3
"""Command-dispatch parity harness: the daemon-response timeout class from
the 2026-09-22 dogfood (/system-prompt timing out at the client's 10s
bound). One driver, two sides:

- ts:   the TS daemon (node ~/prime-agent/packages/coding-agent/dist/cli-main.js
        --mode daemon --daemon-socket <sock>) on a slow-streaming mock provider
- rust: the Rust supervisor (pa-daemon supervisor --socket <sock>)

Each side gets a created + attached session, an idle command matrix, then a
turn whose provider streams one chunk and holds it open (12s) while the same
matrix runs mid-turn. The printed tables are the parity evidence: the TS bar
is that every client command answers fast while a turn streams.
"""

import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse

TURN_HOLD_MS = 12_000

MATRIX = [
    ("get_session_stats", "/session"),
    ("get_context_tree", "/context, /usage"),
    ("get_session_context", "wire: get_session_context"),
    ("get_system_prompt", "/system-prompt"),
    ("get_tool_definition", "wire: get_tool_definition"),
    ("get_resource_snapshot", "wire: get_resource_snapshot"),
]


class SlowMock(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        chunk = json.dumps({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1750000000,
            "model": "mock-1",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "streaming"}, "finish_reason": None}],
        })
        tail = json.dumps({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1750000000,
            "model": "mock-1",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        })
        # Plain connection-close SSE (no chunked framing): the first
        # chunk streams immediately so the assistant message_start
        # reaches the client; the hold keeps the turn mid-flight.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(f"data: {chunk}\n\n".encode())
        self.wfile.flush()
        time.sleep(TURN_HOLD_MS / 1000.0)
        rest = f"data: {tail}\n\ndata: [DONE]\n\n".encode()
        self.wfile.write(rest)
        self.wfile.flush()


def start_mock():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SlowMock)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_address[1]}/v1", server


class Client:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(1.0)
        self.sock.connect(path)
        self.buffer = b""
        self.hello = self.read_line()
        assert self.hello["type"] == "daemon_hello", self.hello

    def read_line(self, timeout=60.0):
        deadline = time.time() + timeout
        while b"\n" not in self.buffer:
            if time.time() > deadline:
                raise TimeoutError("no daemon line within timeout")
            try:
                data = self.sock.recv(65536)
            except socket.timeout:
                continue
            if not data:
                raise EOFError("daemon closed the connection")
            self.buffer += data
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def send(self, id_, command):
        envelope = json.dumps({
            "type": "command",
            "id": id_,
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": command,
        })
        self.sock.sendall((envelope + "\n").encode())

    def request(self, id_, command):
        started = time.monotonic()
        self.send(id_, command)
        while True:
            line = self.read_line()
            if line.get("id") == id_:
                return line, (time.monotonic() - started) * 1000.0

    def wait_for(self, predicate, timeout=60.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.read_line(deadline - time.time())
            if predicate(line):
                return line
        raise TimeoutError("event never arrived")


def is_event(line, event_type, role=None):
    if line.get("type") != "session_event":
        return False
    event = line.get("event", {})
    if event.get("type") != event_type:
        return False
    if role is None:
        return True
    return event.get("message", {}).get("role") == role


def run_matrix(client, session_id, phase):
    rows = []
    for index, (command, surface) in enumerate(MATRIX):
        payload = {"type": command, "activeSessionId": session_id}
        if command == "get_tool_definition":
            payload["name"] = "bash"
        response, elapsed = client.request(f"matrix-{phase}-{index}", payload)
        rows.append((f"{command} ({surface})", elapsed, bool(response.get("success"))))
    print(f"== response-time table ({phase}) ==")
    for name, elapsed, ok in rows:
        print(f"{name:<45} {elapsed:>10.0f} ms  {'ok' if ok else 'FAILED'}")
    return rows


def write_agent_config(agent_dir, mock_url):
    os.makedirs(agent_dir, exist_ok=True)
    os.makedirs(os.path.join(agent_dir, "sessions"), exist_ok=True)
    with open(os.path.join(agent_dir, "models.json"), "w") as f:
        json.dump({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": mock_url,
                    "apiKey": "sk-battery",
                    "models": [{
                        "id": "mock-1",
                        "name": "Mock 1",
                        "api": "openai-completions",
                        "contextWindow": 128000,
                        "maxTokens": 4096,
                    }],
                }
            }
        }, f)
    with open(os.path.join(agent_dir, "settings.json"), "w") as f:
        json.dump({"onboardingCompleted": True}, f)


def run_side(side, daemon_command, sock, home, cwd, env_extra):
    agent_dir = os.path.join(home, ".prime")
    env = dict(os.environ)
    env["HOME"] = home
    env.update(env_extra)
    proc = subprocess.Popen(
        daemon_command,
        cwd=cwd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 15
        while not os.path.exists(sock) and time.time() < deadline:
            time.sleep(0.05)
        if not os.path.exists(sock):
            raise SystemExit(f"[{side}] daemon socket never appeared")
        client = Client(sock)
        client.send("c1", {
            "type": "create",
            "config": {
                "cwd": cwd,
                "sessionDir": os.path.join(agent_dir, "sessions"),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        })
        created = client.wait_for(lambda line: line.get("id") == "c1")
        if not created.get("success"):
            raise SystemExit(f"[{side}] create failed: {created}")
        session_id = (created.get("data", {}).get("id")
                      or created.get("data", {}).get("sessionId"))
        client.send("a1", {"type": "attach", "activeSessionId": session_id})
        attached = client.wait_for(lambda line: line.get("id") == "a1")
        if not attached.get("success"):
            raise SystemExit(f"[{side}] attach failed: {attached}")

        print(f"\n===== side: {side} =====")
        run_matrix(client, session_id, "idle")

        client.send("p1", {"type": "prompt", "activeSessionId": session_id, "message": "hello"})
        client.wait_for(lambda line: is_event(line, "message_start", "assistant"))
        run_matrix(client, session_id, "mid-turn")
        client.wait_for(lambda line: is_event(line, "agent_end"), timeout=60)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--side", choices=["ts", "rust"], required=True)
    parser.add_argument("--rust-bin", default="target/debug/pa-daemon")
    args = parser.parse_args()

    mock_url, server = start_mock()
    base = tempfile.mkdtemp(prefix=f"cmd-dispatch-{args.side}-")
    home = os.path.join(base, "home")
    cwd = os.path.join(base, "cwd")
    os.makedirs(home)
    os.makedirs(cwd)
    agent_dir = os.path.join(home, ".prime")
    write_agent_config(agent_dir, mock_url)
    sock = os.path.join(base, "daemon.sock")
    try:
        if args.side == "ts":
            repo = os.path.expanduser("~/prime-agent/packages/coding-agent")
            command = ["node", os.path.join(repo, "dist", "cli-main.js"),
                       "--mode", "daemon", "--daemon-socket", sock]
            run_side("ts", command, sock, home, cwd, {})
        else:
            repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            run_side("rust", [os.path.join(repo, args.rust_bin), "supervisor",
                              "--socket", sock, "--agent-dir", agent_dir],
                     sock, home, cwd, {})
    finally:
        shutil.rmtree(base, ignore_errors=True)
        server.shutdown()


if __name__ == "__main__":
    main()
