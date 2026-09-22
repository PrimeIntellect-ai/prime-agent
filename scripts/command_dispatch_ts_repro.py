#!/usr/bin/env python3
"""tmux-driven TS interactive repro for the daemon-response timeout class:
while a turn streams against a slow mock provider (one chunk, then a 12s
hold), `/system-prompt` must render immediately — the TS bar for the Rust
fix. Prints the command-to-render time and the captured frame-set.
"""

import argparse
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time

TURN_HOLD_MS = 12_000


class SlowMock(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        chunk = json.dumps({
            "id": "chatcmpl-test", "object": "chat.completion.chunk",
            "created": 1750000000, "model": "mock-1",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "streaming"}, "finish_reason": None}],
        })
        tail = json.dumps({
            "id": "chatcmpl-test", "object": "chat.completion.chunk",
            "created": 1750000000, "model": "mock-1",
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


def tmux(*args, check=True):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, check=check)


def capture(session):
    result = tmux("capture-pane", "-p", "-t", session, check=False)
    return result.stdout


def wait_stable(session, quiet_ms=700, timeout=60):
    deadline = time.time() + timeout
    last = capture(session)
    last_change = time.time()
    while time.time() < deadline:
        time.sleep(0.15)
        current = capture(session)
        if current != last:
            last = current
            last_change = time.time()
        elif (time.time() - last_change) * 1000 >= quiet_ms:
            return last
    raise SystemExit("pane never settled")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--side", choices=["ts", "rust"], default="ts")
    parser.add_argument("--rust-bin", default="target/debug/prime-agent")
    args = parser.parse_args()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SlowMock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    mock_url = f"http://127.0.0.1:{server.server_address[1]}/v1"

    base = tempfile.mkdtemp(prefix=f"cmd-dispatch-tmux-{args.side}-")
    home = os.path.join(base, "home")
    cwd = os.path.join(base, "cwd")
    tmp = os.path.join(base, "tmp")
    agent_dir = os.path.join(base, "agent")
    for path in (home, cwd, tmp, os.path.join(agent_dir, "sessions")):
        os.makedirs(path, exist_ok=True)
    with open(os.path.join(agent_dir, "models.json"), "w") as f:
        json.dump({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions", "baseUrl": mock_url,
                    "apiKey": "sk-battery",
                    "models": [{"id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                                "contextWindow": 128000, "maxTokens": 4096}],
                }
            }
        }, f)
    with open(os.path.join(agent_dir, "settings.json"), "w") as f:
        # Both keys (the release binary may predate the `onboardingShown`
        # rename): the splash and its trace-consent question must stay
        # away so the repro drives a settled interactive session.
        json.dump({"onboardingCompleted": True, "onboardingShown": True,
                   "agentTraces": {"enabled": False}}, f)

    session = f"cmd-dispatch-{args.side}"
    tmux("kill-session", "-t", session, check=False)
    if args.side == "ts":
        # The installed TS product binary on PATH (the standing pattern for
        # the parity harnesses; it is the packaged node SEA build).
        ts_bin = shutil.which("prime-agent")
        if not ts_bin:
            raise SystemExit("prime-agent (TS product) not on PATH")
        command = [ts_bin, "--provider", "prime-inference", "--model", "mock-1"]
    else:
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        command = [os.path.join(repo, args.rust_bin),
                   "--provider", "prime-inference", "--model", "mock-1"]
    command += ["--daemon-socket", os.path.join(base, "daemon.sock")]
    # Isolate from any embedding daemon env (this harness may itself run
    # inside a worker, and the tmux server replays its own environment):
    # a leaked socket/env would connect the sandbox TUI to the live daemon
    # instead of a fresh sandboxed one.
    unset = [
        key for key in os.environ
        if key.startswith("PRIME_AGENT_INTERNAL_")
    ] + ["PI_PACKAGE_DIR", "PRIME_API_KEY", "PI_CODING_AGENT"]
    prefix = ("env " + " ".join(f"-u {key}" for key in unset)
              + f" HOME={home} TMPDIR={tmp}"
              + f" PRIME_AGENT_CODING_AGENT_DIR={agent_dir}"
              + " PRIME_AGENT_DISABLE_ANALYTICS=1 ")
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd,
         prefix + " ".join(command) + " 2>" + os.path.join(base, "err.log")],
        check=True)
    try:
        wait_stable(session, timeout=90)
        # The boot sequence keeps painting transient notices after the
        # logo settles; a second settle window keeps the first keystrokes
        # from being swallowed by a notice that eats Enter.
        time.sleep(2)
        wait_stable(session, timeout=30)
        # Fallback: an onboarding dialog still up gets dismissed with
        # "Not now" (Down, Enter), then the pane must settle again.
        if "Share agent traces" in capture(session):
            tmux("send-keys", "-t", session, "Down", "Enter")
            wait_stable(session, timeout=30)
        tmux("send-keys", "-t", session, "-l", "hello")
        time.sleep(0.5)
        tmux("send-keys", "-t", session, "Enter")
        # Wait for the streamed first chunk (the assistant row holds
        # "streaming" while the mock keeps the turn open).
        deadline = time.time() + 60
        while time.time() < deadline:
            pane = capture(session)
            if "streaming" in pane:
                break
            time.sleep(0.1)
        else:
            raise SystemExit("the turn never streamed:\n" + capture(session))
        started = time.monotonic()
        tmux("send-keys", "-t", session, "-l", "/system-prompt")
        time.sleep(0.3)
        tmux("send-keys", "-t", session, "Enter")
        # The header row renders as soon as the command answers; a long
        # prompt scrolls the header off the pane, so any assembled-prompt
        # body line (the skills inventory section) counts as rendered.
        deadline = time.time() + 30
        elapsed = None
        pane_at_render = None
        while time.time() < deadline:
            pane = capture(session)
            # The whole prompt block paints in one frame and the view
            # shows its tail, so the closing tag of the skills inventory
            # is the always-visible marker (the header scrolled off).
            if ("System Prompt (" in pane or "<available_skills>" in pane
                    or "</available_skills>" in pane):
                elapsed = (time.monotonic() - started) * 1000.0
                pane_at_render = pane
                break
            time.sleep(0.05)
        if elapsed is None:
            raise SystemExit("/system-prompt never rendered:\n" + capture(session))
        print(f"[{args.side}] /system-prompt mid-turn render time: {elapsed:.0f} ms")
        # The streaming turn is still open at render time (the mock holds
        # for {TURN_HOLD_MS} ms; the render must land well inside it).
        print(f"[{args.side}] turn-hold window: {TURN_HOLD_MS} ms (render inside it: {elapsed < TURN_HOLD_MS})")
        print("---- pane at render ----")
        for line in pane_at_render.splitlines():
            if line.strip():
                print(line)
    finally:
        tmux("kill-session", "-t", session, check=False)
        shutil.rmtree(base, ignore_errors=True)
        server.shutdown()


if __name__ == "__main__":
    main()
