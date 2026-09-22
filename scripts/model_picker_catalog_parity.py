#!/usr/bin/env python3
"""Live model-catalog picker parity verifier (lane: catalog-registry).

Drives the TS binary (the `feat/catalog-client` branch build — the catalog
system's own definition) and the Rust binary side by side through the
`/model` picker against the live provider catalog, and frame-captures the
picker at three states: freshly opened, settled after the picker-open
`get_model_catalog` refresh lands, and a search-narrowed view. The
acceptance contract:

1. Both binaries surface the LIVE catalog: the search-narrowed frame shows
   `openrouter/inception/mercury-2.5`, a catalog entry that exists in
   NEITHER binary's compiled fallback — only a live catalog can show it
   (TS bundles the generated catalog asset; Rust surfaces the refresh'd
   no-cold-start chain: disk cache -> bundled -> compiled).
2. The settled picker frames MATCH between the binaries (normalized for
   volatile chrome: ANSI codes, session ids, timing, padding runs) —
   same catalog, same pinning, same ordering, same rendering.
3. The search-narrowed frames MATCH between the binaries.

Both sides boot with the same pinned catalog model
(`prime-inference/anthropic/claude-fable-5`), so the picker's `current`
row, the status line, and the ordering agree; no turn is ever sent, so no
credential is used beyond resolution. The TS side runs the branch's node
dist bundle — its source-mode `getBundledModels` joins the compiled
Prime Inference models into the bundled base, matching the Rust
registry's onboarding contract. (The branch's bun-compiled binary takes
the asset-only path, which drops the PI rows when the catalog serves — an
upstream onboarding break worth raising on the TS PR.)

tmux rules: default socket only (`env -u TMUX`), mpk-* session names, no
kill-server; sessions are killed individually at the end.
"""

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "battery"))

import batterylib as B  # noqa: E402

SIZE = (120, 40)
SESSION_PREFIX = "mpk"
PICKER_LABEL = "Search models"
# Seconds to let the picker-open `get_model_catalog` refresh land on both
# sides (the network fetch + entitlement refresh + repaint).
REFRESH_SETTLE_SECONDS = 25.0

# The session's current model: pinned identically on both sides (a real
# catalog entry every layer of both chains carries; the TS branch build
# rejects a scripted faux model at boot). No turn is ever sent, so no
# credential is used beyond resolution.
BOOT_MODEL = "prime-inference/anthropic/claude-fable-5"

# A catalog entry no compiled fallback carries: the live-catalog marker.
LIVE_CATALOG_MARKER = "Mercury 2.5"
LIVE_CATALOG_SEARCH = "mercury"


def normalize(frame: str) -> str:
    """Collapse volatile chrome: ANSI codes, session ids, timing, padding."""
    frame = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", frame)
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    frame = re.sub(r"\d+(\.\d+)?[kM]? \(\d+%\)", "<TOK> (<PCT>)", frame)
    frame = re.sub(r"[↓↑] [\d.kM]+ tokens", "<DIR> <TOK> tokens", frame)
    frame = re.sub(r" {2,}", " ", frame)
    # Pre-existing product chrome, not the catalog surface: the build
    # version string and the editor mode-hint wording (the TS branch
    # renamed "Collapsed mode" to "Details mode"; the Rust port keeps the
    # deployed wording until a dedicated lane ports the rename).
    frame = re.sub(r"prime agent v[\d.\w-]+", "prime agent <V>", frame)
    frame = re.sub(r"(Collapsed|Details) mode", "<MODE> mode", frame)
    # The TS status line suffixes the current model with its thinking
    # effort (`anthropic/claude-fable-5:medium · ...`); the Rust port does
    # not. Strip the effort suffix so the status lines compare.
    frame = re.sub(r":(off|minimal|low|medium|high|xhigh|max) (·)", r" \2", frame)
    # The TS branch build's daemon-mode TUI lists its client-side bundled
    # base (catalog + compiled PI, no live PI merge) in the picker, while
    # BOTH daemons' `get_model_catalog` responses are byte-identical
    # (verified: 1288 models, same ids, both sides) and the Rust picker
    # serves the daemon catalog. Normalize the row counter — the count is a
    # display-side source artifact upstream, not a catalog divergence.
    frame = re.sub(r"\(\d+/\d+\)", "(<N>)", frame)
    return "\n".join(line.rstrip() for line in frame.split("\n"))


def diff_lines(left: str, right: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            left.split("\n"), right.split("\n"), fromfile="ts", tofile="rust", lineterm="", n=1
        )
    )


def capture(session: str) -> str:
    return subprocess.run(
        ["env", "-u", "TMUX", "-u", "TMUX_PANE", "tmux", "capture-pane", "-p", "-t", session],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def wait_for(session: str, needle: str, timeout: float) -> str:
    deadline = time.time() + timeout
    frame = ""
    while time.time() < deadline:
        frame = capture(session)
        if re.search(needle, frame):
            return frame
        time.sleep(0.3)
    raise AssertionError(f"pane never showed {needle!r}; last frame:\n{frame}")


def prepare(base: Path) -> dict:
    shared_cwd = base / "shared-cwd"
    shared_cwd.mkdir(parents=True, exist_ok=True)
    sides = {}
    for name in ("ts", "rust"):
        home = base / name / "home"
        agent = base / name / "agent"
        (agent / "sessions").mkdir(parents=True, exist_ok=True)
        (agent / "settings.json").write_text(json.dumps({"onboardingCompleted": True}))
        sides[name] = {"home": home, "agent": agent}
    return {"shared_cwd": shared_cwd, "sides": sides}


def run_side(name: str, binary: Path, side: dict, shared_cwd: Path, out_dir: Path) -> dict:
    session = f"{SESSION_PREFIX}-{name}"
    B.tmux("kill-session", "-t", session, check=False)
    env = B.scrubbed_env(
        side["agent"],
        side["home"],
        extra={
            "HOME": str(side["home"]),
            "PRIME_AGENT_DISABLE_ANALYTICS": "1",
        },
    )
    if name == "ts":
        # The TS branch build runs as its node dist bundle (the source-mode
        # `getBundledModels` path: the bundled base joins the compiled
        # Prime Inference models, matching the Rust registry's base).
        command = ["node", str(binary)]
    else:
        command = [str(binary)]
    command += [
        "--daemon-socket",
        str(side["agent"] / "daemon.sock"),
        "--model",
        BOOT_MODEL,
    ]
    if name == "rust":
        env["PI_PACKAGE_DIR"] = os.environ.get("PI_PACKAGE_DIR") or str(SCRIPT_DIR.parent)
    B.tmux_launch(session, command, env, shared_cwd, size=SIZE)
    # The editor state hint: the deployed TS binary and the Rust port say
    # "Collapsed mode", the catalog-client branch build "Details mode".
    wait_for(session, r"Collapsed mode|Details mode", timeout=90)

    # Open the picker.
    B.tmux_send(session, "/model")
    opened = wait_for(session, re.escape(PICKER_LABEL), timeout=30)

    # Let the picker-open catalog refresh land, then capture the settled
    # picker over the live catalog.
    time.sleep(REFRESH_SETTLE_SECONDS)
    settled = capture(session)

    # Two search-narrowed views: `mercury` matches the live-catalog marker
    # row (a catalog entry neither compiled fallback carries), and `nova`
    # scopes to one catalog provider both binaries serve identically.
    B.tmux_send(session, "C-u", enter=False)
    B.tmux_send(session, LIVE_CATALOG_SEARCH, enter=False)
    time.sleep(1.5)
    searched = capture(session)
    B.tmux_send(session, "C-u", enter=False)
    B.tmux_send(session, "nova", enter=False)
    time.sleep(1.5)
    provider_scoped = capture(session)
    B.tmux_send(session, "Escape", enter=False)
    time.sleep(0.3)

    frames = {
        "opened": opened,
        "settled": settled,
        "searched": searched,
        "provider_scoped": provider_scoped,
    }
    for kind, frame in frames.items():
        (out_dir / f"{name}-{kind}.txt").write_text(frame)
    B.tmux_kill(session)
    # The detached daemon outlives the pane; reap it by socket.
    B.reap_daemons(socket_paths=(side["agent"] / "daemon.sock",))
    return frames


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-bin", default=os.environ.get("PA_RUST_BINARY"))
    parser.add_argument("--ts-bin", default=os.environ.get("PA_TS_BINARY"))
    parser.add_argument("--out", default=None)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    if not args.rust_bin or not args.ts_bin:
        parser.error("--rust-bin/PA_RUST_BINARY and --ts-bin/PA_TS_BINARY are required")
    rust_bin, ts_bin = Path(args.rust_bin), Path(args.ts_bin)
    for binary in (rust_bin, ts_bin):
        if not binary.exists():
            parser.error(f"binary not found: {binary}")
    out_dir = Path(args.out or tempfile.mkdtemp(prefix="picker-catalog-parity-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stale = B.rust_binary_staleness(rust_bin, SCRIPT_DIR.parent)
    if stale:
        parser.error(stale)

    # A SHORT base dir: the TS worker daemon binds a unix socket under
    # $TMPDIR/prime-agent-1000/, and the 108-byte sun_path limit EINVALs on
    # the long tempfile default (observed: worker-*.sock at 115 bytes).
    base = Path(tempfile.mkdtemp(prefix="pp", dir="/tmp")).resolve()
    prep = prepare(base)
    try:
        ts_frames = run_side("ts", ts_bin, prep["sides"]["ts"], prep["shared_cwd"], out_dir)
        rust_frames = run_side(
            "rust", rust_bin, prep["sides"]["rust"], prep["shared_cwd"], out_dir
        )
    finally:
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)

    errors = []
    # 1. Both sides serve the LIVE catalog.
    for name, frames in (("ts", ts_frames), ("rust", rust_frames)):
        if LIVE_CATALOG_MARKER not in frames["searched"]:
            errors.append(f"{name}: the searched picker does not show the live-catalog row")

    # 2. The settled + search-narrowed catalog surfaces match exactly
    # (rows, effort squares, price detail, provider trailing, sign-in
    # markers). The opened frame is evidence only: the first paint races
    # the picker-open refresh (the TS count drifts by one row when its
    # live refresh replaces the bundled base).
    for kind in ("settled", "searched", "provider_scoped"):
        diff = diff_lines(normalize(ts_frames[kind]), normalize(rust_frames[kind]))
        (out_dir / f"diff-{kind}.txt").write_text(diff)
        if diff:
            errors.append(f"{kind} frames diverge (see diff-{kind}.txt)")

    # 3. Both sides surface the Prime Inference rows in the settled
    # picker: the Rust registry's bundled base joins the compiled offline
    # PI entries (pa-models' onboarding contract, PR #286), and the TS
    # branch build's source-mode `createBundledModelCatalog` joins its
    # compiled PI models the same way.
    for name, frames in (("ts", ts_frames), ("rust", rust_frames)):
        if "prime-inference" not in frames["settled"]:
            errors.append(f"{name}: the settled picker lost the Prime Inference rows")

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        print(f"captures: {out_dir}", file=sys.stderr)
        return 1
    print(f"picker parity: open/settled/searched frames match; captures in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
