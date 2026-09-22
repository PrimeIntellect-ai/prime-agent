#!/usr/bin/env python3
"""Attach-render parity verifier: the first frame after a daemon attach of an
IDLE session (the live-dogfood blank-pane bug class).

Drives both products (the deployed TS `prime-agent` binary and a Rust build of
this repo) through the same flow against a mock-provider daemon:

1. Create a session over the daemon wire, settle one scripted turn, close the
   wire client — the session ends idle with a durable transcript.
2. Launch the interactive TUI in tmux attaching to that session id. No keys are
   ever sent and the window is never resized: the first frames must come from
   the attach's own render scheduling (TS `renderInitialMessages` ends in
   `requestRender`; the Rust equivalent is `rebuild_view`'s dirty flag). The
   verifier measures time-to-first-frame and time-to-transcript and gates both.
3. With the pane idle and attached, rename the session from a second wire
   client: the pane must repaint the renamed label with no input (TS
   `handleEvent`'s `session_info_changed` arm).
4. The settled attach frame is normalized and diffed TS vs Rust (visual parity
   evidence).

Exit code is non-zero when any gate fails on either side or the frames differ.
"""

import argparse
import difflib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib as B  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

FIRST_FRAME_MAX_S = 10.0
TRANSCRIPT_MAX_S = 20.0
RENAME_MAX_S = 10.0
SETTLE_TEXT = "settle the attach fixture"
SETTLE_REPLY = "idle session fixture reply"
RENAMED = "renamed-while-attached"
VOLATILE = [
    # Version/model rows differ by build; the transcript is the parity claim.
    re.compile(r"prime agent v\S+"),
    re.compile(r"model \S+"),
    re.compile(r"\d+ tokens?\b.*"),
    # The two sides run in separate evidence dirs; the cwd line neutralizes.
    re.compile(r"attach-frame-parity-\S+"),
]


def normalize(frame: str) -> str:
    lines = []
    for line in frame.splitlines():
        for pattern in VOLATILE:
            line = pattern.sub("", line)
        lines.append(line.rstrip())
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def nonblank_rows(frame: str) -> int:
    return sum(1 for line in frame.splitlines() if line.strip())


def run_side(name: str, binary: str, root: Path) -> dict:
    print(f"[{name}] starting daemon + mock provider")
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": SETTLE_REPLY}])
    mock.start()
    tmpdir = Path("/tmp") / f"attach-frame-{name}"
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
    if name == "rust":
        side.env["PI_PACKAGE_DIR"] = str(Path(__file__).resolve().parents[1])
    side.write_models_json()
    # Mark the onboarding/trace-notice state as already shown so the pane
    # settles straight into the conversation (run_battery's
    # `suppress_first_run_notices`): the gates below are about the attach
    # render, not the first-run overlay.
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    settings["onboardingShown"] = True
    settings["telemetry"] = {**(settings.get("telemetry") or {}), "noticeShown": True}
    settings_path.write_text(json.dumps(settings))
    side.start_daemon()

    gates = []
    try:
        # 1. Idle session with a settled turn, owned by nobody.
        wire = B.Wire(side.daemon_socket)
        create = wire.request(
            "c1",
            {"type": "create", "config": {
                "model": "mock-1", "provider": "prime-inference", "name": "attach-frame"}},
            timeout=60,
        )
        session_id = (create.get("data") or {}).get("activeSessionId")
        assert create.get("success") and session_id, f"create failed: {json.dumps(create)[:300]}"
        wire.request(
            "p1",
            {"type": "prompt_and_wait", "activeSessionId": session_id, "message": SETTLE_TEXT},
            timeout=240,
        )
        wire.close()

        # 2. Attach the interactive TUI: no keys, no resize.
        tmux = f"attach-frame-{name}"
        argv = [
            side.binary, "--daemon-socket", str(side.daemon_socket),
            "--provider", "prime-inference", "--model", "mock-1",
            "--resume", session_id,
        ]
        launch = time.time()
        B.tmux_launch(tmux, argv, side.env, side.work_dir)
        first_frame_s = None
        transcript_s = None
        deadline = launch + TRANSCRIPT_MAX_S
        while time.time() < deadline:
            frame = B.tmux_capture(tmux)
            if first_frame_s is None and nonblank_rows(frame) >= 5:
                first_frame_s = round(time.time() - launch, 2)
            if SETTLE_TEXT in frame and SETTLE_REPLY in frame:
                transcript_s = round(time.time() - launch, 2)
                break
            time.sleep(0.05)
        settled = B.tmux_capture(tmux)
        (root / "frames").mkdir(exist_ok=True)
        (root / "frames" / "01-attach-settled.txt").write_text(settled)
        if first_frame_s is None:
            gates.append(f"{name}: the attach never painted a frame (no keys, no resize)")
        elif first_frame_s > FIRST_FRAME_MAX_S:
            gates.append(f"{name}: first frame took {first_frame_s}s (> {FIRST_FRAME_MAX_S}s)")
        if transcript_s is None:
            gates.append(f"{name}: the settled transcript never rendered within {TRANSCRIPT_MAX_S}s without /reload")
        else:
            print(f"[{name}] first frame {first_frame_s}s, transcript {transcript_s}s (no input)")
        if gates:
            return {"gates": gates, "frame": settled}

        # 3. Idle-session event repaint: rename from a second wire client.
        renamer = B.Wire(side.daemon_socket)
        rename = renamer.request(
            "r1",
            {"type": "rename", "activeSessionId": session_id, "name": RENAMED},
            timeout=60,
        )
        renamer.close()
        if rename.get("success") is not True:
            gates.append(f"{name}: the wire rename failed: {json.dumps(rename)[:300]}")
            return {"gates": gates, "frame": settled}
        rename_at = time.time()
        renamed_frame = ""
        while time.time() < rename_at + RENAME_MAX_S:
            renamed_frame = B.tmux_capture(tmux)
            if RENAMED in renamed_frame:
                break
            time.sleep(0.05)
        (root / "frames" / "02-renamed.txt").write_text(renamed_frame)
        if RENAMED not in renamed_frame:
            gates.append(
                f"{name}: the session_info_changed rename never repainted the idle pane within {RENAME_MAX_S}s"
            )
        else:
            print(f"[{name}] rename repainted in {round(time.time() - rename_at, 2)}s")
        return {"gates": gates, "frame": settled}
    finally:
        B.tmux_kill(f"attach-frame-{name}")
        side.stop_daemon()
        mock.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-bin", default=os.path.join(
        Path(__file__).resolve().parents[1], "target", "release", "prime-agent"))
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--keep", action="store_true", help="keep the evidence dir")
    args = parser.parse_args()

    args.rust_bin = str(Path(args.rust_bin).resolve())
    args.ts_bin = str(Path(args.ts_bin)) if "/" in args.ts_bin else args.ts_bin
    ts_identity.assert_ts_side_is_the_ts_product(args.ts_bin, args.rust_bin)

    failures = 0
    evidence = Path(tempfile.mkdtemp(prefix="attach-frame-parity-"))
    print(f"evidence: {evidence}")
    try:
        results = {}
        for name, binary in (("ts", args.ts_bin), ("rust", args.rust_bin)):
            results[name] = run_side(name, binary, evidence / name)
            for gate in results[name]["gates"]:
                print(f"GATE FAIL: {gate}")
                failures += 1
        # 4. Settled-frame parity diff (normalized: version/model rows differ).
        ts_frame = normalize(results["ts"]["frame"])
        rust_frame = normalize(results["rust"]["frame"])
        (evidence / "diff.txt").write_text(
            "\n".join(difflib.unified_diff(
                ts_frame.splitlines(), rust_frame.splitlines(),
                fromfile="ts", tofile="rust", lineterm="")))
        if ts_frame != rust_frame:
            print("FRAME DIFF (normalized): see " + str(evidence / "diff.txt"))
            for line in difflib.unified_diff(
                    ts_frame.splitlines(), rust_frame.splitlines(),
                    fromfile="ts", tofile="rust", lineterm=""):
                print(line)
            failures += 1
        else:
            print("settled attach frames identical after normalization")
        if failures:
            print(f"{failures} gate(s) failed")
            return 1
        print("attach-render parity: PASS")
        return 0
    finally:
        if not args.keep:
            shutil.rmtree(evidence, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
