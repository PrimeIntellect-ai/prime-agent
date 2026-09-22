#!/usr/bin/env python3
"""Thinking-block display parity verifier: frame-diff the Rust TUI against
the installed TS prime-agent binary rendering the SAME thinking traces in
every path that reaches the display:

  - REPLAYED: a session JSONL with TS-shaped thinking blocks (the
    `{"type":"thinking","thinking":...,"thinkingSignature":"reasoning_content"}`
    wire form TS-written sessions carry) resumed in the TS binary
    (`prime-agent -r <path>`) and replayed in the Rust TUI
    (`pa-tui-replay <path>`).
  - LIVE: a scripted OpenAI-completions mock streaming `reasoning_content`
    deltas (the prime-inference/GLM thinking wire) drives both binaries
    interactively.
  - RESUMED: the same TS-shaped fixture resumed through the Rust
    interactive binary's daemon attach (the resume Kevin dogfooded).

States per side: collapsed (overview: thinking hidden), details (Ctrl+O
once: thinking visible, dim), all (Ctrl+O twice). Frames are normalized
for volatile content and diffed; the reach asserts check the detail-level
gating on BOTH sides (absent collapsed, present dim expanded).

Wire parity is checked too: the Rust-written session file must persist the
`thinkingSignature` key on its thinking blocks — the same key TS-written
sessions carry (a snake_case serde rename once dropped the signature at the
pa-ai -> pa-agent boundary, degrading the block to plain text on the next
provider request).

tmux rules: default socket only (`env -u TMUX`), thinkparity-* session
names, no kill-server; sessions are killed individually at the end.
"""

import argparse
import difflib
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

SIZES = [("120", "90")]

MARKER_TEXT = "FINAL thinking parity marker reached."
LIVE_BODY = "Live body text after thinking."
LIVE_THINK = "LIVE-THINK-A first reasoning fragment."
THINK_A = "The user probes thinking rendering."
THINK_B = "Second trace marks THINKPROBE-B"


# ---------------------------------------------------------------------------
# Fixture: a TS-shaped session with thinking blocks in every message form.
# ---------------------------------------------------------------------------

def session_paths():
    return sorted(
        glob.glob(os.path.expanduser("~/.prime/agent/sessions/**/*.jsonl"), recursive=True),
        key=os.path.getmtime,
    )


def newest_assistant_envelope():
    """A real assistant message envelope (api/provider/usage fields) so the
    synthetic replies deserialize in BOTH loaders (same contract as
    custom_message_parity.py; the smallest captured envelope wins)."""
    best = None
    for path in reversed(session_paths()):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if '"thinking"' in line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    message = row.get("message") if row.get("type") == "message" else None
                    if (
                        isinstance(message, dict)
                        and message.get("role") == "assistant"
                        and isinstance(message.get("content"), list)
                        and any(
                            isinstance(block, dict)
                            and block.get("type") == "text"
                            and len(block.get("text", "")) < 200
                            for block in message["content"]
                        )
                        and (best is None or len(line) < best[0])
                    ):
                        best = (len(line), message)
        except OSError:
            continue
    if best is None:
        raise SystemExit("no assistant message found in captured sessions")
    return json.loads(json.dumps(best[1]))


def newest_session_header():
    for path in reversed(session_paths()):
        try:
            with open(path, encoding="utf-8") as f:
                first = f.readline()
        except OSError:
            continue
        try:
            header = json.loads(first)
        except ValueError:
            continue
        if header.get("type") == "session":
            return header
    raise SystemExit("no captured session header found under ~/.prime/agent/sessions")


def build_session(path, envelope, cwd):
    """The parity session: user turn, thinking+text reply, thinking+toolcall
    turn with its result, closing text marker. The thinking blocks carry the
    TS wire form (`thinkingSignature`), so the fixture is byte-shape
    identical to a TS-written session."""
    header = {
        "type": "session",
        "version": 3,
        "id": "thinkparity-session",
        "cwd": cwd,
        "timestamp": "2026-09-21T00:00:00.000Z",
    }
    entries = [header]
    base_ms = 1_700_000_000_000

    def entry(type_, fields, ms):
        row = {"type": type_}
        row.update(fields)
        row["id"] = f"e{ms - 1_700_000_000_000:04d}"
        row["parentId"] = entries[-1]["id"]
        row["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
        return row

    def assistant_with(content, ms, stop="stop"):
        message = json.loads(json.dumps(envelope))
        message["content"] = content
        message["provider"] = "prime-inference"
        message["model"] = "z-ai/glm-5.3"
        message["timestamp"] = ms
        if stop != "stop":
            message["stopReason"] = stop
        return message

    entries.append(entry("message", {
        "message": {"role": "user", "content": "Thinking parity probe.", "timestamp": base_ms},
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {"message": assistant_with([
        {"type": "thinking", "thinking": THINK_A
         + " I should mark the THINKPROBE-A token in the reasoning trace so the parity check can find it.",
         "thinkingSignature": "reasoning_content"},
        {"type": "text", "text": "Replied with body text."},
    ], base_ms)}, base_ms))
    base_ms += 1
    entries.append(entry("message", {"message": assistant_with([
        {"type": "thinking", "thinking": THINK_B + " before the tool call.",
         "thinkingSignature": "reasoning_content"},
        {"type": "toolCall", "name": "ipython", "id": "toolu_think01",
         "arguments": {"code": "print('tool ran')"}},
    ], base_ms, stop="toolUse")}, base_ms))
    base_ms += 1
    entries.append(entry("message", {"message": {
        "role": "toolResult", "toolCallId": "toolu_think01", "toolName": "ipython",
        "content": [{"type": "text", "text": "tool ran"}],
        "details": {"status": "ok", "durationMs": 2, "stdout": "tool ran\n"},
        "isError": False, "timestamp": base_ms,
    }}, base_ms))
    base_ms += 1
    entries.append(entry("message", {"message": assistant_with(
        [{"type": "text", "text": MARKER_TEXT}], base_ms)}, base_ms))
    with open(path, "w") as f:
        for row in entries:
            f.write(json.dumps(row) + "\n")
    return path


# ---------------------------------------------------------------------------
# The live mock: OpenAI-completions SSE with reasoning_content deltas.
# ---------------------------------------------------------------------------

MOCK_CHUNKS = [
    {"delta": {"reasoning_content": LIVE_THINK + " "}},
    {"delta": {"reasoning_content": "LIVE-THINK-B second fragment."}},
    {"delta": {"content": LIVE_BODY}},
    {"delta": {}, "finish_reason": "stop"},
]


class MockState:
    def __init__(self):
        self.requests = []


def start_mock(log_path):
    """One mock per side (request logs never interleave). Returns the port."""
    state = MockState()
    chunks = MOCK_CHUNKS

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(
                {"data": [{"id": "mock-1", "object": "model"}]}).encode())

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            state.requests.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for index, chunk in enumerate(chunks):
                wire = {
                    "id": "chatcmpl-mock",
                    "model": "mock-1",
                    "choices": [{"delta": chunk["delta"], "index": 0}],
                }
                if "finish_reason" in chunk:
                    wire["choices"][0]["finish_reason"] = chunk["finish_reason"]
                self.wfile.write(f"data: {json.dumps(wire)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server.server_address[1], state, server


def write_models_json(agent_dir, base_url):
    os.makedirs(agent_dir, exist_ok=True)
    models = {"providers": {"prime-inference": {
        "api": "openai-completions", "baseUrl": base_url, "apiKey": "sk-battery",
        "models": [{"id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                     "baseUrl": base_url, "contextWindow": 128000, "maxTokens": 4096,
                     "reasoning": True}]}}}
    with open(os.path.join(agent_dir, "models.json"), "w") as f:
        json.dump(models, f, indent=1)


# ---------------------------------------------------------------------------
# tmux machinery (same rules as custom_message_parity.py).
# ---------------------------------------------------------------------------

def tmux(*args, check=True):
    result = subprocess.run(["env", "-u", "TMUX", "tmux", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session):
    return tmux("capture-pane", "-e", "-p", "-t", session)


def capture_plain(session):
    return tmux("capture-pane", "-p", "-t", session)


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture_plain(session):
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def normalize(frame, root):
    """The custom_message_parity.py normalizer: volatile rows and values out,
    transcript rows in (see that harness for the provenance of each rule)."""
    frame = frame.replace(root, "<SANDBOX>")

    def chrome_row(line):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        return (
            "prime agent" in plain
            or "cwd" in plain
            or plain.strip().startswith("model ")
            or re.search("[\u2580-\u259f]", plain) is not None
        )

    frame = re.sub(r"v\d+\.\d+\.\d+", "vX.X.X", frame)
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    frame = re.sub(r"\d+(\.\d+)?[kM]? \(\d+%\)", "<TOK> (<PCT>)", frame)
    frame = re.sub(r"[\u2193\u2191] [\d.kM]+ tokens", "<DIR> <TOK> tokens", frame)
    spinners = "".join("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f")
    frame = re.sub("[" + spinners + "]", "<SPIN>", frame)
    pulses = "".join("\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc")
    frame = re.sub("[" + pulses + "]", "<PULSE>", frame)
    frame = re.sub("\x1b\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\[49m(?= )", "\n", frame)
    kept = []
    for line in frame.split("\n"):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if "cwd" in plain and "$0.00" in plain:
            continue
        if "\u2190" in line and "manage" in line:
            continue
        if chrome_row(line):
            continue
        kept.append(line)
    while kept and not kept[0].strip():
        kept.pop(0)
    while kept and not kept[-1].strip():
        kept.pop()
    return "\n".join(kept)


def strip_ansi(frame):
    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", frame)


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(left.split("\n"), right.split("\n"),
                             fromfile="ts", tofile="rust", lineterm="", n=1)
    )


# ---------------------------------------------------------------------------
# Sides.
# ---------------------------------------------------------------------------

def prepare_sandbox(base, mock_urls):
    cwd = os.path.join(base, "cwd")
    os.makedirs(cwd, exist_ok=True)
    sides = {}
    for name, url in mock_urls.items():
        home = os.path.join(base, name, "home")
        agent = os.path.join(base, name, "agent")
        tmp = os.path.join(base, name, "tmp")
        os.makedirs(home, exist_ok=True)
        os.makedirs(tmp, exist_ok=True)
        os.makedirs(os.path.join(agent, "sessions"), exist_ok=True)
        with open(os.path.join(agent, "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True}, f)
        if url:
            write_models_json(agent, url)
        sides[name] = {"home": home, "agent": agent, "cwd": cwd, "tmp": tmp}
    return sides


def capture_states(session, marker, sizes_note):
    """collapsed -> details -> all; returns the three frames."""
    wait_for(session, marker, timeout=90)
    time.sleep(1.5)
    frames = {"a_collapsed": capture(session)}
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
    frames["b_details"] = capture(session)
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
    frames["c_all"] = capture(session)
    return frames


def run_ts_replay(session_path, sandbox, size, out_dir):
    session = f"thinkparity-ts-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    env = (
        f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    command = f"{env} prime-agent --offline -r {session_path}"
    tmux("send-keys", "-t", session, command, "Enter")
    frames = capture_states(session, MARKER_TEXT, "ts replay")
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"ts-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_rust_replay(session_path, sandbox, size, out_dir, binary):
    session = f"thinkparity-rust-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    command = f"HOME={sandbox['home']} {binary} {session_path}"
    tmux("send-keys", "-t", session, command, "Enter")
    frames = capture_states(session, MARKER_TEXT, "rust replay")
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"rust-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_rust_interactive_resume(session_path, sandbox, size, out_dir, binary, name):
    """The daemon-attach resume path (what `prime-agent -r` dogfoods)."""
    session = f"thinkparity-rust-resume-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    env = (
        f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']}"
    )
    package_dir = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    command = (
        f"{env} PI_PACKAGE_DIR={package_dir}"
        f" {binary} --daemon-socket {sandbox['agent']}/daemon.sock --offline -r {session_path}"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    frames = capture_states(session, MARKER_TEXT, "rust resume")
    tmux("send-keys", "-t", session, "C-c")
    time.sleep(0.5)
    tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"rust-resume-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_live(binary, sandbox, size, out_dir, name, prompt):
    """One live interactive turn against the reasoning mock."""
    session = f"thinkparity-{name}-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    env = (
        f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    package_dir = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    extra = f"PI_PACKAGE_DIR={package_dir}" if name == "rust" else ""
    command = (
        f"{env} {extra} {binary} --provider prime-inference --model mock-1 --offline "
        f"--daemon-socket {sandbox['agent']}/daemon.sock"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    time.sleep(8)
    tmux("send-keys", "-t", session, prompt, "Enter")
    wait_for(session, LIVE_BODY, timeout=90)
    time.sleep(1.5)
    frames = {"a_collapsed": capture(session)}
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
    frames["b_details"] = capture(session)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"live-{name}-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames, session


def rust_session_thinking_block(sandbox):
    """The thinking block the Rust daemon persisted for the live turn: must
    carry the TS wire signature key."""
    for path in sorted(
        glob.glob(os.path.join(sandbox["agent"], "sessions", "*.jsonl")),
        key=os.path.getmtime,
    ):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if '"thinking"' not in text:
            continue
        for line in text.splitlines():
            if '"thinking"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            message = row.get("message")
            if not (isinstance(message, dict) and message.get("role") == "assistant"):
                continue
            for block in message.get("content", []):
                if isinstance(block, dict) and block.get("type") == "thinking":
                    return block
    return None


# ---------------------------------------------------------------------------
# Reach assertions.
# ---------------------------------------------------------------------------

def assert_replay_reach(side, frames):
    collapsed = strip_ansi(frames["a_collapsed"])
    details = strip_ansi(frames["b_details"])
    all_frame = strip_ansi(frames["c_all"])
    assert THINK_A not in collapsed, f"{side}: thinking visible collapsed"
    assert THINK_B not in collapsed, f"{side}: thinking visible collapsed"
    assert THINK_A in details, f"{side}: thinking missing at details level"
    assert THINK_B in details, f"{side}: thinking missing at details level"
    assert THINK_A in all_frame, f"{side}: thinking missing at all level"


def assert_live_reach(side, frames):
    collapsed = strip_ansi(frames["a_collapsed"])
    details = strip_ansi(frames["b_details"])
    assert LIVE_THINK not in collapsed, f"{side}: live thinking visible collapsed"
    assert LIVE_THINK in details, f"{side}: live thinking missing at details level"


def assert_dim(frame, needle):
    """The quiet TS treatment: the thinking row renders in the dim color."""
    for line in frame.split("\n"):
        plain = strip_ansi(line)
        if needle in plain:
            assert "\x1b[38;2;113;113;122m" in line, (
                f"thinking row not dim: {line!r}"
            )
            return
    raise AssertionError(f"needle {needle!r} not in frame")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", default=",".join(f"{w}x{h}" for w, h in SIZES))
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=["ts", "rust"])
    args = parser.parse_args()
    sizes = [tuple(entry.split("x")) for entry in args.sizes.split(",")]

    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    rust_dir = os.environ.get(
        "PA_RUST_DIR",
        os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")),
    )
    rust_bin = os.path.join(rust_dir, "target", "debug", "prime-agent")
    rust_replay = os.path.join(rust_dir, "target", "debug", "pa-tui-replay")
    for path in (rust_bin, rust_replay):
        if not os.path.exists(path):
            raise SystemExit(f"missing {path}; build first (cargo build --bin prime-agent --bin pa-tui-replay)")

    base = tempfile.mkdtemp(prefix="thinking-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="thinking-captures-")

    # One mock per live side.
    ts_mock = start_mock(base)
    rust_mock = start_mock(base)
    sandboxes = prepare_sandbox(base, {
        "ts": f"http://127.0.0.1:{ts_mock[0]}/v1",
        "rust": f"http://127.0.0.1:{rust_mock[0]}/v1",
        "ts-replay": None,
        "rust-replay": None,
        "rust-resume": None,
    })
    session_path = build_session(
        os.path.join(base, "thinking-session.jsonl"),
        newest_assistant_envelope(),
        os.path.join(base, "cwd"),
    )
    print(f"session: {session_path}")

    failures = []
    ts_mock_server, rust_mock_server = ts_mock[2], rust_mock[2]
    try:
        for size in sizes:
            if args.only in (None, "ts"):
                ts_replay = run_ts_replay(session_path, sandboxes["ts-replay"], size, out_dir)
            if args.only in (None, "rust"):
                rust_replay = run_rust_replay(
                    session_path, sandboxes["rust-replay"], size, out_dir, rust_replay
                )
            if args.only is None:
                assert_replay_reach("ts", ts_replay)
                assert_replay_reach("rust", rust_replay)
                for state in ("a_collapsed", "b_details", "c_all"):
                    name = f"replay-{state}-{size[0]}x{size[1]}"
                    ts_norm = normalize(ts_replay[state], base)
                    rust_norm = normalize(rust_replay[state], base)
                    if ts_norm == rust_norm:
                        print(f"PASS {name}")
                    else:
                        print(f"FAIL {name}")
                        report = os.path.join(out_dir, f"diff-{name}.txt")
                        with open(report, "w") as f:
                            f.write(diff_lines(ts_norm, rust_norm))
                        print(f"  diff: {report}")
                        failures.append(name)

            # The daemon-attach resume path: TS-shaped fixture through the
            # Rust interactive binary (the dogfood surface).
            if args.only in (None, "rust"):
                resume_frames = run_rust_interactive_resume(
                    session_path, sandboxes["rust-resume"], size, out_dir, rust_bin, "resume"
                )
                assert_replay_reach("rust-resume", resume_frames)
                assert_dim(resume_frames["b_details"], THINK_A)
                if args.only is None:
                    ts_norm = normalize(ts_replay["b_details"], base)
                    rust_norm = normalize(resume_frames["b_details"], base)
                    name = f"resume-vs-ts-{size[0]}x{size[1]}"
                    if ts_norm == rust_norm:
                        print(f"PASS {name}")
                    else:
                        print(f"FAIL {name}")
                        report = os.path.join(out_dir, f"diff-{name}.txt")
                        with open(report, "w") as f:
                            f.write(diff_lines(ts_norm, rust_norm))
                        print(f"  diff: {report}")
                        failures.append(name)

            # The live turn: both binaries against the reasoning mock.
            if args.only in (None, "ts"):
                ts_live, ts_sess = run_live(
                    "prime-agent", sandboxes["ts"], size, out_dir, "ts-live",
                    "say the live thinking probe",
                )
                tmux("kill-session", "-t", ts_sess, check=False)
            if args.only in (None, "rust"):
                rust_live, rust_sess = run_live(
                    rust_bin, sandboxes["rust"], size, out_dir, "rust-live",
                    "say the live thinking probe",
                )
            if args.only is None:
                assert_live_reach("ts", ts_live)
                assert_live_reach("rust", rust_live)
                assert_dim(ts_live["b_details"], LIVE_THINK)
                assert_dim(rust_live["b_details"], LIVE_THINK)
                for state in ("a_collapsed", "b_details"):
                    name = f"live-{state}-{size[0]}x{size[1]}"
                    ts_norm = normalize(ts_live[state], base)
                    rust_norm = normalize(rust_live[state], base)
                    if ts_norm == rust_norm:
                        print(f"PASS {name}")
                    else:
                        print(f"FAIL {name}")
                        report = os.path.join(out_dir, f"diff-{name}.txt")
                        with open(report, "w") as f:
                            f.write(diff_lines(ts_norm, rust_norm))
                        print(f"  diff: {report}")
                        failures.append(name)
                # Wire parity: the Rust-written session carries the TS wire
                # signature key on its thinking block.
                block = rust_session_thinking_block(sandboxes["rust"])
                assert block is not None, "no thinking block persisted by the rust live turn"
                assert block.get("thinkingSignature") == "reasoning_content", (
                    f"rust-written thinking block lost the TS wire signature: {block}"
                )
                print("PASS rust-written thinkingSignature wire parity")
    finally:
        # Sweep this harness's tmux sessions (some arms return early under
        # --only, so kill by the thinkparity- prefix, not by stored handles).
        listing = tmux("list-sessions", "-F", "#{session_name}", check=False)
        for name in listing.split():
            if name.startswith("thinkparity-"):
                tmux("kill-session", "-t", name, check=False)
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        ts_mock_server.shutdown()
        ts_mock_server.server_close()
        rust_mock_server.shutdown()
        rust_mock_server.server_close()
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)

    if failures:
        print(f"{len(failures)} state(s) differ; captures in {out_dir}")
        return 1
    print(f"all states match; captures in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
