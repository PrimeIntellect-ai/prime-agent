#!/usr/bin/env python3
"""`/mcp` visual-parity verifier: frame-diff the Rust inline connections
view against the installed TS prime-agent binary in tmux.

Both sides are driven like a user: tmux launches the binary, `/mcp` is
typed at the editor, and the rendered pane is captured with escape
sequences after the view settles. The frames are normalized (ANSI
stripped, trailing whitespace trimmed) and diffed. The TS binary's view
(TS `handleMcpCommand` -> the configuration menu's MCP Connections tab)
lists the auth-registry connections; the Rust view lists the daemon
roster (the built-in catalog plus user-declared servers) with the
connection status and tool listing. Divergences are classified:

- structural (panel, search field, row markers, key hint) must match;
- roster content may differ where the products differ (the TS tab shows
  the auth-registry providers — including the Serper api-key entry —
  while the Rust roster is the MCP catalog plus settings servers);
- the Rust detail block (status wording, tool count/tool lines) is the
  lane's sanctioned extension over the TS status row.

The report goes to stdout plus --out; exit code is non-zero when a
structural line differs.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

SESSION_TS = "mcp-parity-ts"
SESSION_RS = "mcp-parity-rs"
WIDTH, HEIGHT = 110, 32
SETTLE_SECONDS = 6.0

TS_BINARY = "prime-agent"


def tmux(*args, check=True):
    result = subprocess.run(
        ["tmux", *args], capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def ansi_stripped(text: str) -> str:
    text = re.sub(r"\x1b\][^\x07]*(\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][0-9A-B]", "", text)
    return text


def capture(session: str) -> str:
    raw = tmux("capture-pane", "-t", session, "-p", "-e")
    lines = [ansi_stripped(line).rstrip() for line in raw.splitlines()]
    # Drop trailing blank rows (tmux pads the pane).
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def run_ts(out_dir: str) -> str:
    tmux("kill-session", "-t", SESSION_TS, check=False)
    tmux("new-session", "-d", "-s", SESSION_TS, "-x", str(WIDTH), "-y", str(HEIGHT))
    time.sleep(0.5)
    tmux("send-keys", "-t", SESSION_TS, TS_BINARY, "Enter")
    time.sleep(6)
    tmux("send-keys", "-t", SESSION_TS, "/mcp", "Enter")
    time.sleep(SETTLE_SECONDS)
    frame = capture(SESSION_TS)
    tmux("kill-session", "-t", SESSION_TS, check=False)
    with open(os.path.join(out_dir, "ts_frame.txt"), "w") as handle:
        handle.write(frame + "\n")
    return frame


def run_rust(binary: str, out_dir: str) -> str:
    agent_dir = os.path.join(out_dir, "agent")
    os.makedirs(agent_dir, exist_ok=True)
    # A hermetic agent dir: only the built-in catalog (linear, notion) in
    # the roster, mirroring the TS tab's built-in rows.
    tmux("kill-session", "-t", SESSION_RS, check=False)
    tmux("new-session", "-d", "-s", SESSION_RS, "-x", str(WIDTH), "-y", str(HEIGHT))
    time.sleep(0.5)
    script = (
        f"PRIME_AGENT_CODING_AGENT_DIR={agent_dir} PI_OFFLINE=1 "
        f"PRIME_AGENT_KERNEL_VENV={os.path.join(out_dir, 'kernel-venv')} "
        f"{binary}"
    )
    tmux("send-keys", "-t", SESSION_RS, script, "Enter")
    time.sleep(8)
    tmux("send-keys", "-t", SESSION_RS, "/mcp", "Enter")
    time.sleep(SETTLE_SECONDS + 4)
    frame = capture(SESSION_RS)
    tmux("kill-session", "-t", SESSION_RS, check=False)
    with open(os.path.join(out_dir, "rust_frame.txt"), "w") as handle:
        handle.write(frame + "\n")
    return frame


def frame_rows(frame: str, panel_marker: str):
    """The view's rows: from the first marker row to the hint row."""
    rows = frame.splitlines()
    start = next((i for i, row in enumerate(rows) if panel_marker in row), None)
    if start is None:
        return []
    end = len(rows)
    for i in range(start, len(rows)):
        if "close" in rows[i] and ("select" in rows[i] or "navigate" in rows[i]):
            end = i + 1
            break
    return rows[start:end]


def structural(row: str) -> str:
    """One row reduced to its structural cells: the border rules, the
    search field, and the hint; connection rows collapse to their marker
    (the roster content is product-specific and diffed separately)."""
    if set(row.strip()) in ({"─"}, {"-", "─"}):
        return "BORDER"
    if "Search MCP connections" in row:
        return "SEARCH-FIELD"
    if "select" in row and "close" in row:
        return "HINT"
    if row.startswith("›") or (row.startswith("  ") and "·" in row):
        return "ROW"
    if row.startswith(" ("):
        return "SCROLL"
    return "OTHER"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-binary", help="path to the Rust prime-agent binary")
    parser.add_argument("--out-dir", required=True, help="directory for the captured frames and report")
    parser.add_argument("--side", choices=["both", "ts", "rust"], default="both",
                        help="capture one side only (frames land in --out-dir; run again on the other box for the diff)")
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    if args.side in ("both", "ts"):
        run_ts(args.out_dir)
    if args.side in ("both", "rust"):
        if not args.rust_binary:
            parser.error("--rust-binary is required for the rust side")
        run_rust(args.rust_binary, args.out_dir)
    if args.side in ("ts", "rust"):
        print(f"captured the {args.side} side to {args.out_dir}")
        return 0

    with open(os.path.join(args.out_dir, "ts_frame.txt")) as handle:
        ts_frame = handle.read()
    with open(os.path.join(args.out_dir, "rust_frame.txt")) as handle:
        rust_frame = handle.read()

    ts_rows = frame_rows(ts_frame, "Search MCP connections")
    rust_rows = frame_rows(rust_frame, "Search MCP connections")

    report = []
    report.append(f"TS rows in view: {len(ts_rows)}; Rust rows in view: {len(rust_rows)}")
    ts_structure = [structural(row) for row in ts_rows]
    rust_structure = [structural(row) for row in rust_rows]
    if ts_structure == rust_structure:
        report.append("STRUCTURE: identical (border, search field, rows, hint)")
    else:
        report.append("STRUCTURE: DIFFERS")
        report.append(f"  ts:   {ts_structure}")
        report.append(f"  rust: {rust_structure}")
    report.append("TS view rows:")
    report.extend(f"  | {row}" for row in ts_rows)
    report.append("Rust view rows:")
    report.extend(f"  | {row}" for row in rust_rows)

    text = "\n".join(report)
    print(text)
    with open(os.path.join(args.out_dir, "report.txt"), "w") as handle:
        handle.write(text + "\n")
    return 0 if ts_structure == rust_structure else 1


if __name__ == "__main__":
    sys.exit(main())
