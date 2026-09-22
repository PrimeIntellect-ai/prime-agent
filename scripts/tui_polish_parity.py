#!/usr/bin/env python3
"""TUI styling-parity verifier (tui-polish lane): the two known color-layer
divergences from the gutter-verify audit, byte-compared against the TS
binary on PATH.

  1. Fenced-code syntax colors. The TS markdown theme's `highlightCode`
     (cli-highlight over the highlight.js 10.7.3 grammar, the same pass the
     expanded ipython cell uses) renders ```python fences multicolor; the
     Rust TUI rendered them uniform. This harness replays a session whose
     assistant text carries a python fence (keywords, built-ins, numbers,
     f-strings, a def header, literals), a bare fence (the uniform
     fallback), and an attribute fence (```python title=x: marked passes
     the whole trimmed info string, so hljs has no such language and the
     block stays uniform) through BOTH binaries and byte-compares the
     normalized frames (volatile values out, in-line ANSI in). A
     multicolor guard asserts the TS code rows actually carry >=2 distinct
     colors so a both-sides-uniform false pass cannot hold.

  2. The loader row's SGR boundary. TS's `Loader` renders
     `${spinnerColorFn(frame)} ${messageColorFn(msg)}`: chalk resets to
     default fg on the spinner->label gap; the Rust carried the label
     color over the space. This harness streams a slow reasoning mock
     into BOTH binaries, densely captures the mid-stream frames while the
     working loader is up, extracts every loader row, normalizes the
     volatile spinner/elapsed/token-count values, and byte-compares the
     row sets. The gap's `ESC[39m ` reset must sit between the spinner
     and the label on both sides.

Frames and diffs land in --out as the parity-diff evidence.
"""

import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import thinking_parity as tp  # noqa: E402  (the shared capture machinery)
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

SPINNERS = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"

#: The deployed TS product this harness diffs against. The box's PATH
#: `prime-agent` may be a Rust dogfood install (the ts-identity guard
#: refuses that); point TS_BIN at the installed TS release when it is.
TS_BIN = os.environ.get("TS_BIN", "prime-agent")

# The corpus python block: keywords, built-ins, numbers, f-strings, a def
# header (title + params), a comment, and a literal - every scope the
# token-class mapping carries.
PY_BLOCK = "def gutter_probe(count=7):\n    # probe comment\n    total = 0\n    for i in range(count):\n        print(f\"line {i}\")\n        total += i\n    if total is not None:\n        return total\n\ngutter_probe(3)"

ASSISTANT_TEXT = (
    "The parity code block:\n"
    "```python\n" + PY_BLOCK + "\n```\n"
    "\n"
    "A bare fence stays uniform:\n"
    "```\nplain code line\n```\n"
    "\n"
    "An attribute fence stays uniform:\n"
    "```python title=x\nattribute code line\n```\n"
    "\n"
    "FINAL thinking parity marker reached."
)

LIVE_PROMPT = "say the loader parity probe"


def start_slow_mock():
    """The reasoning mock, slowed so the loader row stays up for the dense
    capture window."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": "mock-1", "object": "model"}]}).encode())

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"delta": {"reasoning_content": "LOADERPARITY-A first reasoning fragment that streams slowly."}},
                {"delta": {"reasoning_content": "LOADERPARITY-B second fragment streams slowly too."}},
                {"delta": {"reasoning_content": "LOADERPARITY-C third fragment wraps up the slow trace."}},
                {"delta": {"content": "Live body text after thinking."}},
                {"delta": {}, "finish_reason": "stop"},
            ]
            for chunk in chunks:
                wire = {"id": "chatcmpl-mock", "model": "mock-1",
                        "choices": [{"delta": chunk["delta"], "index": 0}]}
                if "finish_reason" in chunk:
                    wire["choices"][0]["finish_reason"] = chunk["finish_reason"]
                self.wfile.write(f"data: {json.dumps(wire)}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.7)
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1], server


def build_session(path, envelope, cwd):
    """The replay fixture: an assistant text block with the three fences,
    byte-shaped like a TS-written session (the shared envelope machinery)."""
    header = {
        "type": "session",
        "version": 3,
        "id": "tuipolish-session",
        "cwd": cwd,
        "timestamp": "2026-09-22T00:00:00.000Z",
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

    def assistant_with(content, ms):
        message = json.loads(json.dumps(envelope))
        message["content"] = content
        message["provider"] = "prime-inference"
        message["model"] = "z-ai/glm-5.3"
        message["timestamp"] = ms
        return message

    entries.append(entry("message", {
        "message": {"role": "user", "content": "TUI polish parity probe.", "timestamp": base_ms},
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {"message": assistant_with([
        {"type": "text", "text": ASSISTANT_TEXT},
    ], base_ms)}, base_ms))
    base_ms += 1
    with open(path, "w", encoding="utf-8") as f:
        for row in entries:
            f.write(json.dumps(row) + "\n")
    return path


def env_noise(frame):
    """The gutter-verify environment-row filter: sandbox startup notices
    (ripgrep-missing, tmux extended-keys) are environment rows, not
    transcript rows; drop them (with wrapped continuations) and collapse
    blank runs so only content rows participate."""
    out = []
    lines = frame.split("\n")
    i = 0
    while i < len(lines):
        plain = tp.strip_ansi(lines[i])
        if "ripgrep" in plain:
            i += 5
            continue
        if "extended-keys" in plain:
            i += 2
            continue
        out.append(lines[i])
        i += 1
    collapsed = []
    prev_blank = False
    for line in out:
        blank = not line.strip()
        if blank and prev_blank:
            continue
        collapsed.append(line)
        prev_blank = blank
    return "\n".join(collapsed)


def code_color_rows(frame):
    """The python-fence rows that must carry the syntax colors: rows whose
    plain text is the corpus code lines."""
    rows = []
    for line in frame.split("\n"):
        plain = tp.strip_ansi(line)
        stripped = plain.lstrip()
        if stripped.startswith(("def gutter_probe", "for i in range", "print(f\"line")):
            rows.append(line)
    return rows


def run_ts_replay(session_path, sandbox, size, out_dir):
    """tp.run_ts_replay with the explicit TS_BIN (the PATH binary may be a
    Rust dogfood install; the identity guard checks the binary used)."""
    session = f"tuipolish-ts-{size[0]}x{size[1]}"
    tp.tmux("kill-session", "-t", session, check=False)
    tp.tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    env = (
        f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    command = f"{env} {TS_BIN} --offline -r {session_path}"
    tp.tmux("send-keys", "-t", session, command, "Enter")
    frames = tp.capture_states(session, tp.MARKER_TEXT, "ts replay")
    tp.tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"ts-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def replay_compare(session_path, sandboxes, out_dir, failures):
    """REPLAY: both binaries render the same session; the normalized
    frames (in-line ANSI kept) must be byte-identical."""
    size = ("120", "90")
    ts_frames = run_ts_replay(session_path, sandboxes["ts-replay"], size, out_dir)
    rust_frames = tp.run_rust_replay(
        session_path, sandboxes["rust-replay"], size, out_dir, RUST_REPLAY_BIN
    )
    for state in ("a_collapsed", "b_details", "c_all"):
        name = f"replay-{state}-{size[0]}x{size[1]}"
        ts_norm = env_noise(tp.normalize(ts_frames[state], sandboxes["ts-replay"]["cwd"]))
        rust_norm = env_noise(tp.normalize(rust_frames[state], sandboxes["rust-replay"]["cwd"]))
        if ts_norm == rust_norm:
            print(f"PASS {name} (byte-identical)")
        else:
            report = os.path.join(out_dir, f"diff-{name}.txt")
            with open(report, "w") as f:
                f.write(tp.diff_lines(ts_norm, rust_norm))
            print(f"FAIL {name}: diff at {report}")
            failures.append(name)
        # The multicolor guard: the TS python-fence rows carry the token
        # colors (>=2 distinct fg colors per code row), so the
        # byte-identical pass cannot be a both-sides-uniform false pass.
        ts_code = code_color_rows(ts_norm)
        if not ts_code:
            print(f"FAIL {name}: no python-fence rows found in the TS frame")
            failures.append(f"{name}-code-rows")
            continue
        for row in ts_code:
            colors = set(re.findall(r"\x1b\[38;2;[0-9;]+m", row))
            if len(colors) < 2:
                print(f"FAIL {name}: TS code row is uniform: {row!r}")
                failures.append(f"{name}-multicolor")
    # The two uniform fences must stay uniform on both sides.
    bare = [line for line in ts_norm.split("\n")
            if tp.strip_ansi(line).strip() == "plain code line"]
    if not bare or "\x1b[" not in bare[0]:
        print("FAIL bare fence: not styled uniformly on the TS side")
        failures.append("bare-fence")


def loader_rows(session, report_frames, label, root):
    """Dense mid-stream capture; every working-loader row, normalized
    (spinner/elapsed/token-count out, ANSI placement in)."""
    rows = set()
    for step in range(24):
        frame = tp.capture(session)
        report_frames.append((f"{label}-{step:02d}", frame))
        for line in frame.split("\n"):
            plain = tp.strip_ansi(line)
            if re.match(f"^ [{SPINNERS}] Thinking", plain):
                rows.add(tp.normalize(line + "\n", root).strip("\n"))
        time.sleep(0.2)
    return rows


def loader_compare(base, out_dir, failures):
    """LIVE: stream the slow mock into both binaries and compare the
    normalized loader rows (the SGR boundary on the spinner->label gap)."""
    port, server = start_slow_mock()
    sandboxes = tp.prepare_sandbox(base, {
        "ts": f"http://127.0.0.1:{port}/v1",
        "rust": f"http://127.0.0.1:{port}/v1",
    })
    sides = {}
    report_frames = []
    try:
        for side, binary in (("ts", TS_BIN), ("rust", RUST_BIN)):
            sandbox = sandboxes[side]
            session = f"tuipolish-{side}"
            tp.tmux("kill-session", "-t", session, check=False)
            tp.tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "90",
                    "-c", sandbox["cwd"])
            env = (f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
                   f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
                   f"PRIME_AGENT_DISABLE_ANALYTICS=1")
            package_dir = os.path.abspath(
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
            )
            extra = f"PI_PACKAGE_DIR={package_dir}" if side == "rust" else ""
            command = (f"{env} {extra} {binary} --provider prime-inference "
                       f"--model mock-1 --offline --daemon-socket {sandbox['agent']}/daemon.sock")
            tp.tmux("send-keys", "-t", session, command, "Enter")
            time.sleep(10)
            tp.tmux("send-keys", "-t", session, LIVE_PROMPT, "Enter")
            sides[side] = loader_rows(session, report_frames, side, base)
            tp.tmux("kill-session", "-t", session, check=False)
    finally:
        listing = tp.tmux("list-sessions", "-F", "#{session_name}", check=False)
        for name in listing.split():
            if name.startswith("tuipolish-"):
                tp.tmux("kill-session", "-t", name, check=False)
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        server.shutdown()
        server.server_close()

    with open(os.path.join(out_dir, "loader-probe-frames.txt"), "w") as f:
        for label, frame in report_frames:
            f.write(f"===== {label}\n{frame}\n")
    with open(os.path.join(out_dir, "loader-rows.txt"), "w") as f:
        for side in ("ts", "rust"):
            f.write(f"===== {side} normalized loader rows\n")
            for row in sorted(sides[side]):
                f.write(repr(row) + "\n")

    for side in ("ts", "rust"):
        if not sides[side]:
            print(f"FAIL loader-{side}: no loader row captured while streaming")
            failures.append(f"loader-{side}-absent")
    if sides["ts"] == sides["rust"] and sides["ts"]:
        # The pen reset must sit on the gap: the spinner's color run is
        # closed by ESC[39m before the plain space and the label.
        row = sorted(sides["ts"])[0]
        if re.search(f"\x1b\[39m \x1b\[38;2;[0-9;]+mThinking", row):
            print("PASS loader-row (byte-identical rows, ESC[39m gap reset)")
        else:
            print(f"FAIL loader-row: gap reset missing: {row!r}")
            failures.append("loader-row-reset")
    else:
        print("FAIL loader-row: normalized row sets differ (see loader-rows.txt)")
        failures.append("loader-row-set")


def main():
    global RUST_BIN, RUST_REPLAY_BIN
    rust_dir = os.environ.get(
        "PA_RUST_DIR", os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    )
    RUST_BIN = os.path.join(rust_dir, "target", "debug", "prime-agent")
    RUST_REPLAY_BIN = os.path.join(rust_dir, "target", "debug", "pa-tui-replay")
    for path in (RUST_BIN, RUST_REPLAY_BIN):
        if not os.path.exists(path):
            raise SystemExit(f"missing {path}; build first")

    ts_identity.assert_ts_side_is_the_ts_product(ts_bin=TS_BIN)

    default_out = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "tui-polish-runs", time.strftime("%Y-%m-%d-tui-polish"),
    )
    out_dir = os.environ.get("OUT_DIR", default_out)
    os.makedirs(out_dir, exist_ok=True)

    base = tempfile.mkdtemp(prefix="tui-polish-")
    failures = []
    # Two independent mocks (the shared machinery runs one per side set).
    ts_mock = tp.start_mock(base)
    rust_mock = tp.start_mock(base)
    try:
        sandboxes = tp.prepare_sandbox(base, {
            "ts": f"http://127.0.0.1:{ts_mock[0]}/v1",
            "rust": f"http://127.0.0.1:{rust_mock[0]}/v1",
            "ts-replay": None,
            "rust-replay": None,
        })
        session_path = build_session(
            os.path.join(base, "tui-polish-session.jsonl"),
            tp.newest_assistant_envelope(),
            os.path.join(base, "cwd"),
        )
        replay_compare(session_path, sandboxes, out_dir, failures)
        ts_mock[2].shutdown()
        ts_mock[2].server_close()
        rust_mock[2].shutdown()
        rust_mock[2].server_close()
        loader_compare(base, out_dir, failures)
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])

    print(f"evidence in {out_dir}")
    if failures:
        print(f"FAILURES: {failures}")
        return 1
    print("ALL TUI-POLISH PARITY CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
