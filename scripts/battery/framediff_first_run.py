#!/usr/bin/env python3
"""B-2 first-run frame-diff: capture the fresh-install onboarding frame
(splash + trace-sharing notice) from the TS and Rust binaries at 120x36 and
diff it row-for-row, like scripts/visual_parity.py.

The splash animates a lab field behind the brand mark (cells drift every
120ms), so the two frame captures can never be byte-equal in that band. The
diff therefore splits the frame:
  - text rows (welcome line, question panel, choice rows, note) compare with
    their escape sequences (colour, bold/italic, the selection wash) after
    the visual-parity normalizations;
  - the mark band (the seven animated rows) compares only at the static
    brand-mark cells (the logo quiet zone); the drifting field around them
    cannot be synchronized across captures.

Both sides launch flagless (no --provider/--model): the onboarding gate
must resolve the startup model from settings + auth, exactly like the TS
`isOnboardingModelReady` chain, so the fresh agent dir (PRIME_API_KEY +
models.json provider key, no saved default) reaches the trace question
without explicit flags. Exit code is non-zero when the frames differ.

    python3 scripts/battery/framediff_first_run.py [--out DIR]
"""

import argparse
import difflib
import re
import json
import shutil
import sys
import time
from pathlib import Path

import ts_identity  # the shared PATH-binary identity guard (same dir)

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B

FLOW = "framediff"
# The splash layout: frame row 0 blank, rows 1-7 the mark band. The brand
# mark (LOGO_INDENT=5) paints its glyphs at priority 8 over the animated
# field, so exactly the logo glyph cells are static and comparable; the
# drifting field (ambient dots, contours, traces) rides everywhere else,
# including the mark's blank cells, and cannot be synchronized.
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


def band_text(frame: str) -> list[str]:
    """The static mark cells: one string per band row, logo glyphs only."""
    import re as _re

    rows = frame.split("\n")
    out = []
    for y, logo in enumerate(LOGO_LINES):
        row = rows[MARK_ROW_BASE + y] if MARK_ROW_BASE + y < len(rows) else ""
        row = _re.sub("\x1b\[[0-9;]*m", "", row)
        out.append("".join(row[LOGO_INDENT + x] for x, char in enumerate(logo) if char != " "))
    return out


def capture_escape(session: str) -> str:
    return B.tmux("capture-pane", "-e", "-p", "-t", session).stdout


def capture_plain(session: str) -> str:
    return B.tmux_capture(session)


def normalize(frame: str, root: str) -> str:
    frame = frame.replace(root, "<SANDBOX>")
    # tmux moves the trailing foreground-reset between identical screens;
    # both spellings describe default-coloured cells.
    frame = frame.replace("\x1b[39m\n", "\n")
    lines = []
    for line in frame.split("\n"):
        # crossterm emits an explicit default-fg reset where TS writes
        # nothing (the theme's empty text colour); visually identical.
        line = re.sub(r"^\x1b\[39m", "", line)
        # TS styles the row text and leaves its leading indent unstyled;
        # the Rust span starts at the indent. The same cells either way:
        # move the indent before the row's SGR.
        line = re.sub(r"^((?:\x1b\[[0-9;]+m)+)( )", r"\2\1", line)
        lines.append(line)
    return "\n".join(lines)


def split_frame(frame: str) -> tuple[list[str], list[str]]:
    """(styled text rows, static mark cells) as separate line lists."""
    band_rows = {MARK_ROW_BASE + y for y in range(len(LOGO_LINES))}
    rows = frame.split("\n")
    text = [
        row for index, row in enumerate(rows) if index not in band_rows
    ]
    return text, band_text(frame)


def diff_lines(left: list[str], right: list[str]) -> str:
    return "\n".join(
        difflib.unified_diff(left, right, fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def make_side(name: str, binary: str, root: Path) -> B.Side:
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "framediff reply"}])
    mock.start()
    tmpdir = Path("/tmp") / f"f1fd-{name}"
    if tmpdir.exists():
        shutil.rmtree(tmpdir)
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
    side.env["PRIME_API_KEY"] = "sk-battery"
    # A real user terminal: the ambient sandbox NO_COLOR would strip TS
    # chalk modifiers (bold/italic) while the Rust side forces color output,
    # so the pane command unsets it and opts both sides into truecolor.
    side.env["COLORTERM"] = "truecolor"
    side.write_models_json()
    return side


def run_side(name: str, binary: str, base: Path, out: Path) -> dict[str, str]:
    root = base / name
    root.mkdir(parents=True)
    side = make_side(name, binary, root)
    session = f"f1fd-{name}"
    # Flagless: the startup model comes from settings + auth resolution
    # (TS findInitialModel over the auth-configured catalog), not from
    # explicit provider/model flags.
    argv = [
        "/usr/bin/env",
        # A real user terminal: the ambient sandbox pins NO_COLOR/FORCE_COLOR
        # to suppress chalk styling in the TS binary; strip them so both
        # sides render their full styled surface.
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
        deadline = time.time() + 30
        while time.time() < deadline:
            plain = capture_plain(session)
            if "Share agent traces" in plain:
                break
            time.sleep(0.5)
        else:
            print(f"{name}: never reached the trace question")
            sys.exit(2)
        # Let a fresh animation frame settle, then capture with escapes.
        time.sleep(0.3)
        frames["notice-share-selected"] = capture_escape(session)
        # Down moves the selection to `Not now`: the highlight row follows.
        B.tmux_send(session, "Down", enter=False)
        time.sleep(0.4)
        frames["notice-notnow-selected"] = capture_escape(session)
        # Answering settles the pane into the main session screen.
        B.tmux_send(session, "Enter", enter=False)
        deadline = time.time() + 20
        while time.time() < deadline:
            plain = capture_plain(session)
            if "Share agent traces" not in plain:
                break
            time.sleep(0.5)
        time.sleep(0.5)
        frames["after-answer"] = capture_escape(session)
    finally:
        B.tmux_kill(session)
        side.mock.stop()
        if side.daemon_proc and side.daemon_proc.poll() is None:
            side.daemon_proc.terminate()
    (out / name).mkdir(parents=True, exist_ok=True)
    for state, frame in frames.items():
        (out / name / f"{name}-{state}.txt").write_text(frame)
    settings = side.agent_dir / "settings.json"
    if settings.exists():
        (out / name / "settings-after.json").write_text(settings.read_text())
    return frames


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

    base = Path(tempfile.mkdtemp(prefix="f1framediff-"))
    out = Path(args.out) if args.out else base / "captures"
    out.mkdir(parents=True, exist_ok=True)

    ts = run_side("ts", args.ts_bin, base, out)
    rust = run_side("rust", args.rust_bin, base, out)

    failures = []
    for state in ("notice-share-selected", "notice-notnow-selected"):
        ts_text, ts_band = split_frame(normalize(ts[state], str(base)))
        rust_text, rust_band = split_frame(normalize(rust[state], str(base)))
        if ts_band != rust_band:
            print(f"FAIL {state}: mark band differs")
            (out / f"diff-band-{state}.txt").write_text(diff_lines(ts_band, rust_band))
            failures.append(f"{state}/band")
        if ts_text != rust_text:
            print(f"FAIL {state}: text rows differ")
            (out / f"diff-text-{state}.txt").write_text(diff_lines(ts_text, rust_text))
            failures.append(f"{state}/text")
        if not any(f"{state}/" in f for f in failures):
            print(f"PASS {state}: splash frames match (styled text rows + static mark cells)")

    both = (ts["after-answer"], rust["after-answer"])
    print(f"after-answer frames captured for both sides: {len(both) == 2}")
    print(f"captures in {out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
