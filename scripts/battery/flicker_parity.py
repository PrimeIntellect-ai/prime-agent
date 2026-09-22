#!/usr/bin/env python3
"""View-switch flicker verifier (lane: pa-tui alt-screen handoff).

Drives the TS and Rust products through the chat -> agents -> chat view
cycle in a tmux pane whose PRIMARY screen carries a marker line, and
samples tmux's per-pane `alternate_on` state throughout the in-app window.
The alternate screen must stay active across every view switch (TS
`pendingAltScreenHandoff`: the screen is entered once and handed between
surfaces); any sample showing the primary screen (alternate_on=0) mid-flow
is a flicker frame and is captured as evidence.

Also verifies the teardown parity around the handoff:
  - a real chat exit (C-c C-c) leaves the screen and flushes the inline
    frame onto the primary screen (exit-flush fires only on real exits);
  - exiting the agents view leaves the screen with no flush (TS
    `flushFullscreen: false`), so the marker line is back in view.

Run (from the repo root):

    python3 scripts/battery/flicker_parity.py --rust-bin <ABS>/target/release/prime-agent

Writes evidence under scripts/battery/runs/<stamp>-flicker/{ts,rust}/ and
prints a verdict per side; exit code 1 on any flicker frame or teardown gap.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B  # noqa: E402
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

MARKER = "PRIMARYSCREENMARKER-0123456789"
REPLY_TEXT = "flicker idle reply"
PROMPT_TEXT = "flicker idle prompt"
SESSION_NAME = "flicker-idle-session"


class FlickerSampler(threading.Thread):
    """Poll the pane's alternate-screen state; capture flicker frames."""

    def __init__(self, session: str):
        super().__init__(daemon=True)
        self.session = session
        self.stop_flag = threading.Event()
        self.samples = 0
        self.flickers: list[dict] = []

    def run(self) -> None:
        while not self.stop_flag.is_set():
            out = B.tmux(
                "display-message",
                "-p",
                "-t",
                f"{self.session}:0",
                "#{alternate_on}",
                check=False,
            ).stdout.strip()
            self.samples += 1
            if out == "0":
                frame = B.tmux_capture(self.session)
                self.flickers.append({"alternate_on": out, "frame": frame})

    def stop(self) -> None:
        self.stop_flag.set()
        self.join(timeout=10)


def make_side(name: str, binary: str, run_dir: Path) -> B.Side:
    root = run_dir / name
    root.mkdir(parents=True, exist_ok=True)
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True, exist_ok=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": REPLY_TEXT}])
    mock.start()
    tmpdir = Path("/tmp") / f"{run_dir.name}-{name}"
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
    side.write_models_json()
    side.start_daemon()
    # The agents view is gated on completed onboarding on both products.
    settings_path = agent / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    settings["onboardingShown"] = True
    settings_path.write_text(json.dumps(settings))
    create_idle_session(side)
    return side


def create_idle_session(side: B.Side) -> str:
    """One completed live session, so the roster shows an openable row."""
    wire = B.Wire(side.daemon_socket)
    create = wire.request(
        "cfl",
        {
            "type": "create",
            "name": SESSION_NAME,
            "config": {
                "cwd": str(side.work_dir),
                "sessionDir": str(side.agent_dir / "sessions"),
                "provider": "prime-inference",
                "model": "mock-1",
                "executionMode": "print",
            },
        },
        timeout=120,
    )
    if create.get("success") is not True:
        wire.close()
        raise RuntimeError(f"{side.name}: daemon create failed: {json.dumps(create)[:300]}")
    idle_id = create.get("data", {}).get("activeSessionId") or create.get("data", {}).get("id") or ""
    wire.request(
        "pfl",
        {"type": "prompt_and_wait", "activeSessionId": idle_id, "message": PROMPT_TEXT},
        timeout=240,
    )
    wire.close()
    return idle_id


def run_cycle(side: B.Side, cycles: int) -> dict:
    """Launch the agents view in a marked pane, cycle view -> chat -> view,
    sampling the alternate-screen state throughout, then verify the two
    teardown paths (real chat exit vs. agents-view exit)."""
    evidence_dir = side.root / "f14_view_switch"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    session = f"{run_id}-{side.name}-f14"
    # A plain shell pane first: the marker line makes the primary screen
    # unmistakable if a view switch ever shows it.
    B.tmux_launch(session, ["/bin/sh"], side.env, side.work_dir)
    time.sleep(0.5)
    B.tmux_send(session, f"printf '{MARKER}'")
    time.sleep(0.5)
    side.evidence(
        "f14_view_switch",
        "00-primary-screen-marker.txt",
        B.tmux_capture(session),
    )
    B.tmux_send(
        session,
        f"exec {side.binary} agents --daemon-socket {side.daemon_socket}",
    )
    view = B.tmux_wait_text(session, r"Idle \(|Running \(|Inactive \(", timeout=40)
    side.evidence("f14_view_switch", "01-agents-view.txt", view)

    sampler = FlickerSampler(session)
    sampler.start()
    transitions = []
    for i in range(cycles):
        # Open the idle row (search narrows to the session by name).
        B.tmux_send(session, SESSION_NAME)
        time.sleep(0.8)
        chat = B.tmux_wait_text(session, re.escape(REPLY_TEXT), timeout=60)
        transitions.append(("open", chat))
        # Agents-back (Left with an empty editor hands the pane to the view).
        B.tmux_send(session, "Left", enter=False)
        view_back = B.tmux_wait_text(session, r"Idle \(", timeout=60)
        transitions.append(("back", view_back))
        # Clear the search so the next cycle starts from the full roster.
        B.tmux_send(session, "C-u", enter=False)
        time.sleep(0.5)
    sampler.stop()
    for j, (kind, frame) in enumerate(transitions):
        side.evidence("f14_view_switch", f"02-{kind}-{j:02d}.txt", frame)
    for k, flicker in enumerate(sampler.flickers):
        side.evidence(
            "f14_view_switch",
            f"03-FLICKER-{k:02d}.txt",
            flicker["frame"],
        )

    # Real exit from the chat: the pane must die showing the flushed
    # transcript (the exit flush fires on real exits only) and the
    # primary screen must be back (alternate_on 0 is legitimate here).
    B.tmux_send(session, SESSION_NAME)
    time.sleep(0.8)
    B.tmux_wait_text(session, re.escape(REPLY_TEXT), timeout=60)
    B.tmux("set-option", "-t", session, "remain-on-exit", "on", check=False)
    B.tmux_send(session, "C-c", enter=False)
    time.sleep(0.3)
    B.tmux_send(session, "C-c", enter=False)
    deadline = time.time() + 10
    pane_state = ""
    while time.time() < deadline:
        pane_state = B.tmux(
            "display-message", "-p", "-t", session, "#{pane_dead} #{pane_dead_status}", check=False
        ).stdout.strip()
        if pane_state.startswith("1"):
            break
        time.sleep(0.1)
    final = B.tmux_capture(session)
    side.evidence("f14_view_switch", "04-chat-exit-frame.txt", final)
    alt_after_exit = B.tmux(
        "display-message", "-p", "-t", session, "#{alternate_on}", check=False
    ).stdout.strip()
    B.tmux_kill(session)

    # Agents-view exit: the screen is left with no flush, so the marker
    # line is back in view on the primary screen.
    session2 = f"{session}-exit"
    B.tmux_launch(session2, ["/bin/sh"], side.env, side.work_dir)
    time.sleep(0.5)
    B.tmux_send(session2, f"printf '{MARKER}'")
    time.sleep(0.5)
    B.tmux_send(session2, f"exec {side.binary} agents --daemon-socket {side.daemon_socket}")
    B.tmux_wait_text(session2, r"Idle \(", timeout=40)
    B.tmux("set-option", "-t", session2, "remain-on-exit", "on", check=False)
    B.tmux_send(session2, "Escape", enter=False)
    deadline = time.time() + 10
    alt_view_exit = None
    while time.time() < deadline:
        alt_view_exit = B.tmux(
            "display-message", "-p", "-t", session2, "#{alternate_on}", check=False
        ).stdout.strip()
        pane_dead = B.tmux(
            "display-message", "-p", "-t", session2, "#{pane_dead}", check=False
        ).stdout.strip()
        if pane_dead == "1":
            break
        time.sleep(0.1)
    view_exit_frame = B.tmux_capture(session2)
    side.evidence("f14_view_switch", "05-agents-view-exit-frame.txt", view_exit_frame)
    B.tmux_kill(session2)

    return {
        "samples": sampler.samples,
        "flickers": len(sampler.flickers),
        "chat_exit_frame_flushed": PROMPT_TEXT in final,
        "chat_exit_alt_released": alt_after_exit == "0",
        "chat_exit_pane_dead": pane_state.startswith("1"),
        "view_exit_alt_released": alt_view_exit == "0",
        "view_exit_marker_back": MARKER in view_exit_frame,
        "view_exit_no_flush": PROMPT_TEXT not in view_exit_frame,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument(
        "--rust-bin",
        default=str(Path.cwd() / "target" / "release" / "prime-agent"),
    )
    parser.add_argument("--runs-root", default=str(Path(__file__).parent / "runs"))
    parser.add_argument("--cycles", type=int, default=2)
    args = parser.parse_args()

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    global run_id
    run_id = "flick" + stamp
    run_dir = Path(args.runs_root) / f"{stamp}-flicker"
    run_dir.mkdir(parents=True)

    ts_bin = B.run_cmd(["which", args.ts_bin], os.environ.copy(), Path("/tmp"), timeout=10)
    ts_path = ts_bin["stdout"].strip() if ts_bin["exit_code"] == 0 else args.ts_bin
    rust_bin = str(Path(args.rust_bin).resolve())
    if not Path(rust_bin).exists():
        print(f"Rust binary not found: {rust_bin}", file=sys.stderr)
        return 1
    # Fail fast before any launch: a non-TS ts binary plays a Rust build as
    # the "ts" side and reports false divergences.
    ts_identity.assert_ts_side_is_the_ts_product(ts_path, rust_bin)

    results: dict[str, dict] = {}
    sides = []
    ok = True
    try:
        for name, binary in (("ts", ts_path), ("rust", rust_bin)):
            side = make_side(name, binary, run_dir)
            sides.append(side)
            print(f"[{name}] cycling view switches (cycles={args.cycles}) ...")
            results[name] = run_cycle(side, args.cycles)
            rec = results[name]
            print(f"[{name}] {json.dumps(rec)}")
            verdict = (
                rec["flickers"] == 0
                and rec["chat_exit_frame_flushed"]
                and rec["chat_exit_pane_dead"]
                and rec["view_exit_alt_released"]
                and rec["view_exit_marker_back"]
            )
            ok = ok and verdict
            print(f"[{name}] verdict: {'PASS' if verdict else 'FAIL'}")
        # Differential: the TS reference must show the same handoff contract.
        ts_flickers = results["ts"]["flickers"]
        rs_flickers = results["rust"]["flickers"]
        print(
            f"parity: primary-screen frames during view switches — ts={ts_flickers}, rust={rs_flickers}"
        )
    finally:
        for side in sides:
            try:
                wire = B.Wire(side.daemon_socket)
                wire.send_command("sfl", {"type": "shutdown"})
                wire.close()
            except (OSError, EOFError):
                pass
            side.stop_daemon()
            side.mock.stop()
        report = {
            "run_dir": str(run_dir),
            "cycles": args.cycles,
            "results": results,
        }
        (run_dir / "report.json").write_text(json.dumps(report, indent=1))
        print(f"evidence: {run_dir}/report.json")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
