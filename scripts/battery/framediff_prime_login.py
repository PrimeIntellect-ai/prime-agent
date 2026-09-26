#!/usr/bin/env python3
"""B-3 first-run prime-login frame-diff: capture the fresh-install
onboarding + Prime Inference login flow from the TS and Rust binaries at
120x36 and diff it row-for-row, like scripts/battery/framediff_first_run.py
(the shared frame-parity harness grammar: scripts/custom_message_parity.py).

The flow needs a backend without a real Prime account, so both sides point
at ONE local mock Prime API (a read-only http.server): the challenge
generate answers a fixed challenge (the URL block + the "Code:" line), the
status poll stays pending forever (the pasted-key prompt wins the race),
whoami grants the inference write permission, and the team list carries two
teams (the onboarding team question — the TS OnboardingChoiceComponent
frame, not the /login team picker).

States, each captured with escapes after its needle settles:
  welcome            the splash (brand line, description, login action)
  url-block          the mounted login dialog (URL, Verification code,
                     the arm prompt, the paste field, the auth-actions row)
  team-question      the account question (personal account + the teams)
  picker             the connect-more providers picker
  trace-question     the trace-sharing question

The splash animates its lab field behind the brand mark, so the diff splits
like framediff_first_run.py: the seven mark-band rows compare only at the
static logo cells; every other row compares with its escape sequences after
the visual-parity normalizations (the default-fg reset, the indent-before-SGR
move). The mock challenge URL is canonicalized (the query shape may differ
in encoding across the two clients); the exit code is non-zero when any
state differs.

    python3 scripts/battery/framediff_prime_login.py [--out DIR]
"""

import argparse
import difflib
import http.server
import json
import re
import sys
import threading
import time
from pathlib import Path

import ts_identity  # the shared PATH-binary identity guard (same dir)

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B

MARK_ROW_BASE = 1
LOGO_INDENT = 5
LOGO_LINES = [
    "                 ▗▄▄█▀",
    "   ███▄       ▗▄███▀",
    "  ▗█▛▐█▙   ▗▄█▀▗█▀",
    " ▗█▛ ▟██▙▄██▛ ▟▛",
    " ▗▟▌ ▐███▛▘▗▄█▖",
    "▟███▄  ▄▄▟███▀",
    "▜█▛▀▘  ▜█▛▀▘",
]

TEAMS_BODY = json.dumps(
    {
        "data": [
            {"teamId": "team-acme", "name": "Acme Corp", "slug": "acme", "role": "Owner"},
            {"teamId": "team-beta", "name": "Beta Team", "slug": None, "role": "Member"},
        ],
        "total_count": 2,
    }
)
WHOAMI_BODY = json.dumps({"data": {"scope": {"inference": {"write": True}}}})


class MockPrimeApi(http.server.BaseHTTPRequestHandler):
    """The read-only Prime API: a pending browser challenge, a permitted
    key, and a two-team account."""

    def log_message(self, *_args):
        pass

    def _answer(self, body, status=200):
        raw = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 (http.server naming)
        if "/api/v1/user/whoami" in self.path:
            self._answer(WHOAMI_BODY)
        elif "/api/v1/user/teams" in self.path:
            self._answer(TEAMS_BODY)
        elif "/api/v1/auth_challenge/status" in self.path:
            self._answer('{"pending":true}')
        else:
            self._answer("{}", status=404)

    def do_POST(self):  # noqa: N802 (http.server naming)
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if "/api/v1/auth_challenge/generate" in self.path:
            self._answer('{"challenge":"ch-mock","status_auth_token":"tok-mock"}')
        else:
            self._answer("{}", status=404)


def start_prime_api() -> tuple[int, threading.Thread, http.server.ThreadingHTTPServer]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockPrimeApi)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server.server_address[1], thread, server


def capture_escape(session: str) -> str:
    return B.tmux("capture-pane", "-e", "-p", "-t", session).stdout


def capture_plain(session: str) -> str:
    return B.tmux_capture(session)


def normalize(frame: str) -> str:
    lines = []
    for line in frame.split("\n"):
        line = re.sub(r"^\x1b\[39m", "", line)
        line = re.sub(r"^((?:\x1b\[[0-9;]+m)+)( )", r"\2\1", line)
        # The login URL row: the mock challenge URL, canonicalized across
        # the two clients' query encodings.
        line = re.sub(
            r"https://mock\.example/dashboard/tokens/challenge\?[^ ]*",
            "<LOGIN-URL>",
            line,
        )
        lines.append(line)
    return "\n".join(lines)


def band_text(frame: str) -> list[str]:
    rows = frame.split("\n")
    out = []
    for y, logo in enumerate(LOGO_LINES):
        row = rows[MARK_ROW_BASE + y] if MARK_ROW_BASE + y < len(rows) else ""
        row = re.sub("\x1b\[[0-9;]*m", "", row)
        out.append(
            "".join(row[LOGO_INDENT + x] for x, char in enumerate(logo) if char != " ")
        )
    return out


def split_frame(frame: str) -> tuple[list[str], list[str]]:
    band_rows = {MARK_ROW_BASE + y for y in range(len(LOGO_LINES))}
    rows = frame.split("\n")
    text = [row for index, row in enumerate(rows) if index not in band_rows]
    return text, band_text(frame)


def diff_lines(left: list[str], right: list[str]) -> str:
    return "\n".join(
        difflib.unified_diff(left, right, fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def wait_for(session: str, needle: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture_plain(session):
            return
        time.sleep(0.5)
    print(f"{session}: never showed {needle!r}")
    sys.exit(2)


def make_side(name: str, binary: str, root: Path, prime_port: int) -> B.Side:
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "framediff reply"}])
    mock.start()
    tmpdir = root / "tmp"
    tmpdir.mkdir(parents=True)
    side = B.Side(
        name=name,
        binary=binary,
        root=root,
        agent_dir=agent,
        work_dir=work,
        daemon_socket=root / "daemon.sock",
        mock=mock,
    )
    side.env = B.scrubbed_env(agent, tmpdir)
    # A real user terminal: both sides render their full styled surface.
    side.env["COLORTERM"] = "truecolor"
    # The mock Prime API: the browser challenge stays pending, whoami
    # permits the key, the account carries two teams (the team question).
    side.env["PRIME_AGENT_INFERENCE_API_BASE_URL"] = f"http://127.0.0.1:{prime_port}"
    side.env["PRIME_AGENT_INFERENCE_FRONTEND_URL"] = "https://mock.example"
    # No PRIME_API_KEY and no stored apiKey: the home is not model-ready
    # (batterylib's write_models_json seeds a configured prime-inference
    # key, which would SKIP the welcome/login flow this harness drives),
    # so the catalog carries the model without the credential and the
    # full first-run flow runs (welcome -> sign-in -> team question ->
    # picker -> traces).
    side.agent_dir.mkdir(parents=True, exist_ok=True)
    (side.agent_dir / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": side.base_url(),
                        "models": [
                            {
                                "id": "mock-1",
                                "name": "Mock 1",
                                "api": "openai-completions",
                                "baseUrl": side.base_url(),
                                "contextWindow": 128000,
                                "maxTokens": 4096,
                            }
                        ],
                    }
                }
            },
            indent=1,
        )
    )
    return side


def run_side(
    name: str,
    binary: str,
    base: Path,
    out: Path,
    prime_port: int,
) -> dict[str, str]:
    root = base / name
    root.mkdir(parents=True)
    side = make_side(name, binary, root, prime_port)
    session = f"plfd-{name}"
    argv = [
        "/usr/bin/env",
        "-u",
        "NO_COLOR",
        "-u",
        "FORCE_COLOR",
        "-u",
        "CLICOLOR",
        binary,
        "--daemon-socket",
        str(side.daemon_socket),
        "--offline",
    ]
    B.tmux_launch(session, argv, side.env, side.work_dir)
    frames: dict[str, str] = {}
    try:
        wait_for(session, "Log in with Prime Intellect")
        time.sleep(0.4)
        frames["welcome"] = capture_escape(session)
        # The welcome action starts the flow: the login dialog mounts with
        # the mock challenge URL, the Verification code block, and the
        # armed paste prompt under it.
        B.tmux_send(session, "Enter", enter=False)
        wait_for(
            session, "Complete the sign-in in your browser, or paste an API key below:"
        )
        time.sleep(0.4)
        frames["url-block"] = capture_escape(session)
        # The pasted key races the (pending) browser poll: whoami permits
        # it, the two teams mount the account question.
        B.tmux_send(session, "sk-mock-battery", enter=True)
        wait_for(session, "Which account should Prime Agent use?")
        time.sleep(0.4)
        frames["team-question"] = capture_escape(session)
        # The personal account answers the question; the default model
        # applies behind the pane, then the picker mounts.
        B.tmux_send(session, "Enter", enter=False)
        wait_for(session, "Connect other providers, or continue.")
        time.sleep(0.4)
        frames["picker"] = capture_escape(session)
        # Continue ends the step; the trace question ends the flow.
        B.tmux_send(session, "Enter", enter=False)
        wait_for(session, "Share agent traces")
        time.sleep(0.4)
        frames["trace-question"] = capture_escape(session)
    finally:
        B.tmux_kill(session)
        side.mock.stop()
        side.stop_daemon()
    (out / name).mkdir(parents=True, exist_ok=True)
    for state, frame in frames.items():
        (out / name / f"{name}-{state}.txt").write_text(frame)
    settings = side.agent_dir / "settings.json"
    if settings.exists():
        (out / name / "settings-after.json").write_text(settings.read_text())
    return frames


STATES = ["welcome", "url-block", "team-question", "picker", "trace-question"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rust-bin",
        default=str(Path(__file__).parent.parent.parent / "target/release/prime-agent"),
    )
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    import tempfile

    # Fail fast before any launch: a non-TS ts binary plays a Rust build as
    # the "ts" side and reports false divergences.
    ts_identity.assert_ts_side_is_the_ts_product(args.ts_bin, args.rust_bin)

    prime_port, prime_thread, prime_server = start_prime_api()
    base = Path(tempfile.mkdtemp(prefix="plframediff-"))
    out = Path(args.out) if args.out else base / "captures"
    out.mkdir(parents=True, exist_ok=True)

    try:
        ts = run_side("ts", args.ts_bin, base, out, prime_port)
        rust = run_side("rust", args.rust_bin, base, out, prime_port)
    finally:
        prime_server.shutdown()
        prime_thread.join(timeout=5)

    failures = []
    for state in STATES:
        if state not in ts or state not in rust:
            failures.append(f"{state}/missing")
            continue
        ts_text, ts_band = split_frame(normalize(ts[state]))
        rust_text, rust_band = split_frame(normalize(rust[state]))
        if ts_band != rust_band:
            print(f"FAIL {state}: mark band differs")
            (out / f"diff-band-{state}.txt").write_text(diff_lines(ts_band, rust_band))
            failures.append(f"{state}/band")
        if ts_text != rust_text:
            print(f"FAIL {state}: text rows differ")
            (out / f"diff-text-{state}.txt").write_text(diff_lines(ts_text, rust_text))
            failures.append(f"{state}/text")
        if not any(f"{state}/" in f for f in failures):
            print(f"PASS {state}: frames match (styled text rows + static mark cells)")

    print(f"captures in {out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
