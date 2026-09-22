#!/usr/bin/env python3
"""Heartbeats-view verifier (lane: heartbeats-menu; extended by the
hb-viewer dogfood lane for unlabeled rows and the tray count).

tmux user-level test driving `/heartbeats` with a user heartbeat (wire
`heartbeat_set`, no label) and two agent heartbeats (kernel
`rlm_heartbeat.create` tool-call turns: one labeled, one unlabeled — the
dogfood repro) registered on the same daemon session, then attaching the
interactive TUI and checking the management surface:

  1. The tray counts every scoped heartbeat (labeled or not) before the
     view is ever opened.
  2. `/heartbeats` opens the view: title, count label, one row per
     heartbeat with its status, source labels, schedule; unlabeled rows
     identify themselves by their instruction preview (TS
     `primary: label || prompt || default name`).
  3. Down navigates the inline list (the selection marker moves).
  4. Enter opens the actions pane (Pause/Resume, Stop with the TS
     descriptions).
  5. Enter applies Pause: the view returns to the list and the paused
     status shows; the wire catalog confirms the applied status.
  6. Escape closes the view; the tray heartbeat label stays.
  7. The unlabeled agent heartbeat's action pane titles it with the
     default name and rides the instruction as the subtitle.

Runs one side at a time (`--side rust` or `--side ts`) so the same steps
produce evidence frames on both products for the parity diff; the
informational tokens (labels, statuses, action names) must match, with the
deliberate style divergence documented: the Rust view is inline-picker
style (the lane directive), TS renders its full-pane overlay.

Usage:
  python3 scripts/heartbeats_parity.py --side rust --binary <path> \
      --repo <checkout> [--out <dir>]
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "battery"))
import batterylib as B  # noqa: E402

HEARTBEAT_PROMPT = "user heartbeat ping instruction"
AGENT_HB_INSTRUCTION = "agent heartbeat check instruction"
AGENT_HB_LABEL = "agent hb"
AGENT_UNLABELED_INSTRUCTION = "agent unlabeled heartbeat watch instruction"
USER_SCHEDULE = "every 30m"
AGENT_INTERVAL = "every 30m"
SEED_REPLY = "heartbeats verifier seed reply"


class Verifier:
    def __init__(self, side_name: str, binary: str, out: Path):
        self.name = side_name
        self.out = out
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.runid = "hbv" + stamp
        root = out / self.name
        root.mkdir(parents=True, exist_ok=True)
        agent = root / "agent"
        work = root / "work"
        work.mkdir(parents=True, exist_ok=True)
        if agent.exists():
            shutil.rmtree(agent)
        agent.mkdir(parents=True)
        mock = B.MockProvider(root, [])
        self._script_mock(mock)
        mock.start()
        tmpdir = Path("/tmp") / f"{self.runid}-{self.name}"
        if tmpdir.exists():
            shutil.rmtree(tmpdir)
        tmpdir.mkdir(parents=True)
        self.side = B.Side(
            name=side_name,
            binary=binary,
            root=root,
            agent_dir=agent,
            work_dir=work,
            daemon_socket=root / "daemon.sock",
            mock=mock,
        )
        self.side.env = B.scrubbed_env(agent, tmpdir)
        # The Rust binary resolves the kernel runtime through PI_PACKAGE_DIR
        # (battery make_side precedent): point it at this checkout.
        if side_name == "rust":
            self.side.env["PI_PACKAGE_DIR"] = str(REPO)
        self.side.env["PRIME_API_KEY"] = "sk-battery"
        self.side.write_models_json()
        # Suppress first-run overlays (battery suppress_first_run_notices).
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        settings["onboardingShown"] = True
        settings["telemetry"] = {**(settings.get("telemetry") or {}), "noticeShown": True}
        settings_path.write_text(json.dumps(settings))
        self.findings: list[dict] = []

    # -- helpers ------------------------------------------------------------

    def record(self, summary: str, ok: bool, evidence: str = "") -> None:
        self.findings.append(
            {"side": self.name, "ok": ok, "summary": summary, "evidence": evidence}
        )
        print(f"[{'ok  ' if ok else 'FAIL'}] {self.name}: {summary}")

    def evidence(self, name: str, text: str) -> Path:
        path = self.out / self.name
        path.mkdir(parents=True, exist_ok=True)
        target = path / name
        target.write_text(text)
        return target

    def evidence_json(self, name: str, obj) -> Path:
        return self.evidence(name, json.dumps(obj, indent=2))

    def ensure_daemon(self) -> None:
        try:
            probe = B.Wire(self.side.daemon_socket)
            probe.close()
            return
        except (OSError, EOFError):
            pass
        self.side.start_daemon()

    def settle_frame(self, session: str, quiet_s: float = 2.0, timeout: float = 40.0) -> str:
        deadline = time.time() + timeout
        last = B.tmux_capture(session)
        last_change = time.time()
        while time.time() < deadline:
            time.sleep(0.5)
            frame = B.tmux_capture(session)
            if frame != last:
                last = frame
                last_change = time.time()
            elif time.time() - last_change >= quiet_s:
                return frame
        return last

    def ready(self, session: str, marker: str, timeout: float = 90.0) -> str:
        """Wait past first-run notices into the stable ready marker."""
        deadline = time.time() + timeout
        frame = ""
        stable_since: float | None = None
        while time.time() < deadline:
            frame = B.tmux_capture(session)
            if "Share agent traces" in frame:
                B.tmux_send(session, "Down")
                time.sleep(0.5)
                B.tmux_send(session, "Enter")
                time.sleep(1.5)
                stable_since = None
                continue
            if marker in frame:
                if stable_since is None:
                    stable_since = time.time()
                elif time.time() - stable_since >= 2.0:
                    return frame
            else:
                stable_since = None
            time.sleep(0.5)
        return frame

    def send(self, session: str, keys: str, enter: bool = True) -> None:
        frame = B.tmux_capture(session)
        if "Share agent traces" in frame:
            B.tmux_send(session, "Down")
            time.sleep(0.5)
            B.tmux_send(session, "Enter")
            time.sleep(1.5)
        B.tmux_send(session, keys, enter=enter)

    def wait_catalog(self, session_id: str, expect: int, timeout: float = 60.0) -> list | None:
        """Poll the wire catalog until `expect` scoped heartbeats list."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            wire = B.Wire(self.side.daemon_socket)
            try:
                data = wire.request(
                    "hb-list",
                    {
                        "type": "heartbeats_list",
                        "activeSessionId": session_id,
                    },
                    timeout=30,
                )
            finally:
                wire.close()
            heartbeats = (data.get("data") or {}).get("heartbeats") or []
            if len(heartbeats) >= expect:
                return heartbeats
            time.sleep(1.0)
        return None

    def _script_mock(self, mock) -> None:
        """Script the whole run once (before the mock starts): per-turn
        queues matched on the turn's prompt, a catch-all queue for the
        session-summary model (the wrap-up calls), and an idle default.
        Order matters: the later turn's marker is checked first, because
        a later conversation's history contains the earlier prompts.
        """
        mock.set_responses(
            [{"text": "battery idle filler"}],
            queues=[
                {
                    "name": "session-summary",
                    "matchModels": ["qwen/qwen3-30b-a3b-instruct-2507"],
                    "responses": [{"text": "summary filler"}],
                },
                {
                    "name": "turn-unlabeled-agent-heartbeat",
                    "match": ["create the unlabeled agent heartbeat"],
                    "responses": [
                        {
                            "toolCall": {
                                "name": "ipython",
                                "arguments": {
                                    "code": (
                                        "import rlm_heartbeat\n"
                                        "await rlm_heartbeat.create(\n"
                                        f"    {AGENT_UNLABELED_INSTRUCTION!r},\n"
                                        f"    interval={AGENT_INTERVAL!r},\n"
                                        ")\n"
                                        "print('created')\n"
                                    )
                                },
                            }
                        },
                        {"text": "unlabeled agent heartbeat created"},
                    ],
                },
                {
                    "name": "turn-agent-heartbeat",
                    "match": ["create the agent heartbeat"],
                    "responses": [
                        {
                            "toolCall": {
                                "name": "ipython",
                                "arguments": {
                                    "code": (
                                        "import rlm_heartbeat\n"
                                        "await rlm_heartbeat.create(\n"
                                        f"    {AGENT_HB_INSTRUCTION!r},\n"
                                        f"    interval={AGENT_INTERVAL!r},\n"
                                        f"    label={AGENT_HB_LABEL!r},\n"
                                        ")\n"
                                        "print('created')\n"
                                    )
                                },
                            }
                        },
                        {"text": "agent heartbeat created"},
                    ],
                },
                {
                    "name": "turn-seed",
                    "match": ["verifier seed turn"],
                    "responses": [{"text": SEED_REPLY}],
                },
            ],
        )

    # -- the flow -----------------------------------------------------------

    def run(self) -> bool:
        self.ensure_daemon()
        wire = B.Wire(self.side.daemon_socket)
        create = wire.request(
            "hb-create",
            {
                "type": "create",
                "name": "heartbeats-verifier",
                "config": {
                    "cwd": str(self.side.work_dir),
                    "sessionDir": str(self.side.agent_dir / "sessions"),
                    "provider": "prime-inference",
                    "model": "mock-1",
                    "executionMode": "print",
                },
            },
            timeout=120,
        )
        if create.get("success") is not True:
            self.record("daemon create failed: " + json.dumps(create)[:200], ok=False)
            wire.close()
            return False
        session_id = (
            (create.get("data") or {}).get("activeSessionId")
            or (create.get("data") or {}).get("id")
            or ""
        )

        seeded = wire.request(
            "hb-seed",
            {
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "verifier seed turn",
            },
            timeout=240,
        )
        self.record("seed turn ran", seeded.get("success") is True)

        # User heartbeat through the wire (the /heartbeat set arm).
        set_reply = wire.request(
            "hb-set",
            {
                "type": "heartbeat_set",
                "activeSessionId": session_id,
                "schedule": USER_SCHEDULE,
                "prompt": HEARTBEAT_PROMPT,
            },
            timeout=60,
        )
        self.evidence_json("00-heartbeat-set.json", set_reply)
        self.record(
            "user heartbeat set through the wire",
            set_reply.get("success") is True,
        )

        # Agent heartbeat through the kernel: one ipython tool-call turn
        # creates an rlm_heartbeat (the rlm-heartbeat skill host request).
        # The create tool call rides the turn queue scripted above.
        agent_reply = wire.request(
            "hb-agent",
            {
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "create the agent heartbeat",
            },
            timeout=240,
        )
        self.evidence_json("01-agent-heartbeat-turn.json", agent_reply)
        self.record("agent heartbeat turn ran", agent_reply.get("success") is True)

        # The create-without-label path (the dogfood repro): a second agent
        # heartbeat with no label. Its row must identify itself by its
        # instruction preview (TS `primary: label || prompt || default name`).
        # The create tool call rides the turn queue scripted above.
        unlabeled_reply = wire.request(
            "hb-agent-unlabeled",
            {
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "create the unlabeled agent heartbeat",
            },
            timeout=240,
        )
        self.evidence_json("01b-unlabeled-heartbeat-turn.json", unlabeled_reply)
        self.record("unlabeled agent heartbeat turn ran", unlabeled_reply.get("success") is True)

        # The wire catalog must now carry all three scoped heartbeats.
        catalog = self.wait_catalog(session_id, 3)
        self.evidence_json("02-wire-catalog.json", catalog)
        sources = sorted(
            (entry.get("job") or {}).get("source") or "" for entry in catalog or []
        )
        self.record(
            "wire catalog lists the user and both agent heartbeats",
            sources == ["heartbeat", "rlm_heartbeat", "rlm_heartbeat"],
            evidence="02-wire-catalog.json",
        )
        unlabeled_rows = [
            entry
            for entry in catalog or []
            if (entry.get("job") or {}).get("label") in (None, "")
                and (entry.get("job") or {}).get("source") == "rlm_heartbeat"
        ]
        self.record(
            "the wire row keeps the unlabeled agent heartbeat unlabeled",
            len(unlabeled_rows) == 1,
            evidence="02-wire-catalog.json",
        )
        wire.close()

        # Attach the interactive TUI to the live session.
        tmux = f"{self.runid}-{self.name}"
        argv = [
            self.side.binary,
            "--daemon-socket",
            str(self.side.daemon_socket),
            "--resume",
            session_id,
        ]
        B.tmux_launch(tmux, argv, self.side.env, self.side.work_dir)
        frame = self.ready(tmux, ">")
        self.evidence("03-attached.txt", frame)

        # The tray counts every scoped heartbeat before the view is ever
        # opened (the dogfood repro: unlabeled heartbeats fired on schedule
        # while the tray showed none of them).
        tray = frame
        deadline = time.time() + 20
        while time.time() < deadline and "3 heartbeats" not in tray:
            time.sleep(0.5)
            tray = B.tmux_capture(tmux)
        self.evidence("03b-tray.txt", tray)
        self.record(
            "the tray counts the labeled and unlabeled heartbeats before the view opens",
            "3 heartbeats" in tray,
            evidence="03b-tray.txt",
        )

        # /heartbeats opens the management view.
        self.send(tmux, "/heartbeats")
        time.sleep(2.5)
        opened = B.tmux_capture(tmux)
        # Wait for the catalog-driven rows (the fetch is bounded-async).
        deadline = time.time() + 20
        while time.time() < deadline and HEARTBEAT_PROMPT.split()[0] not in opened:
            time.sleep(0.5)
            opened = B.tmux_capture(tmux)
        self.evidence("04-opened.txt", opened)
        checks = {
            "title": "Heartbeats" in opened,
            "count label": "3 heartbeats" in opened,
            "user source": "Created by you" in opened,
            "agent source": "Created by agent" in opened,
            "schedule": USER_SCHEDULE in opened,
            "status": "active" in opened,
            "labeled agent row": AGENT_HB_LABEL in opened,
            "unlabeled agent row preview": AGENT_UNLABELED_INSTRUCTION in opened,
            "unlabeled user row preview": HEARTBEAT_PROMPT in opened,
        }
        failed = [name for name, ok in checks.items() if not ok]
        self.record(
            "/heartbeats renders the list with both heartbeats"
            + (f" (missing: {', '.join(failed)})" if failed else ""),
            not failed,
            evidence="04-opened.txt",
        )

        # Down navigates the inline list: the selection moves to the second
        # row (the marker/highlight is a color change, so the proof is the
        # actions pane the next Enter opens: it must target the agent
        # heartbeat, the second row, not the first).
        self.send(tmux, "Down", enter=False)
        time.sleep(0.8)
        moved = B.tmux_capture(tmux)
        self.evidence("05-navigated.txt", moved)

        # Enter opens the actions pane.
        self.send(tmux, "Enter", enter=False)
        time.sleep(1.0)
        actions = B.tmux_capture(tmux)
        self.evidence("06-actions.txt", actions)
        action_checks = {
            "navigation reached the second row": (
                AGENT_HB_LABEL in actions or AGENT_HB_INSTRUCTION in actions
            ),
            "pause or resume row": ("Pause heartbeat" in actions) or ("Resume heartbeat" in actions),
            "stop row": "Stop heartbeat" in actions,
        }
        failed = [name for name, ok in action_checks.items() if not ok]
        self.record(
            "down navigates to the agent heartbeat and enter opens the TS action pane"
            + (f" (missing: {', '.join(failed)})" if failed else ""),
            not failed,
            evidence="06-actions.txt",
        )

        # Enter applies the pause: the view returns to the list with the
        # paused status and the count label carries it.
        self.send(tmux, "Enter", enter=False)
        time.sleep(2.5)
        applied = B.tmux_capture(tmux)
        self.evidence("07-applied.txt", applied)
        self.record(
            "applying the action returns to the list with the paused status",
            "paused" in applied and "1 paused" in applied,
            evidence="07-applied.txt",
        )

        # The wire catalog confirms the applied status (a real mutation, not
        # a local-only flip).
        paused_catalog = self.wait_catalog_status(session_id, expected_paused=1)
        self.evidence_json("08-applied-catalog.json", paused_catalog)
        self.record(
            "the pause reached the daemon catalog",
            paused_catalog is not None,
            evidence="08-applied-catalog.json",
        )

        # Escape closes the view; the tray heartbeat label stays.
        self.send(tmux, "Escape", enter=False)
        time.sleep(1.0)
        closed = B.tmux_capture(tmux)
        self.evidence("09-closed.txt", closed)
        self.record(
            "escape closes the view (the transcript returns)",
            closed != applied,
            evidence="09-closed.txt",
        )
        tray_ok = "3 heartbeats" in closed and "1 paused" in closed
        self.record(
            "the tray heartbeat label renders after close",
            tray_ok,
            evidence="09-closed.txt",
        )

        # Reopen and inspect the unlabeled agent heartbeat's action pane: the
        # title falls back to the default name (TS
        # `label?.trim() || defaultHeartbeatName`), the instruction rides as
        # the subtitle.
        self.send(tmux, "/heartbeats")
        time.sleep(2.5)
        reopened = B.tmux_capture(tmux)
        deadline = time.time() + 20
        while time.time() < deadline and AGENT_UNLABELED_INSTRUCTION not in reopened:
            time.sleep(0.5)
            reopened = B.tmux_capture(tmux)
        self.send(tmux, "Down", enter=False)
        time.sleep(0.8)
        self.send(tmux, "Down", enter=False)
        time.sleep(0.8)
        self.send(tmux, "Enter", enter=False)
        time.sleep(1.0)
        unlabeled_actions = B.tmux_capture(tmux)
        self.evidence("10-unlabeled-actions.txt", unlabeled_actions)
        unlabeled_checks = {
            "default-name title": "Agent-created heartbeat" in unlabeled_actions,
            "instruction subtitle": AGENT_UNLABELED_INSTRUCTION in unlabeled_actions,
            "pause or resume row": (
                "Pause heartbeat" in unlabeled_actions
            )
            or ("Resume heartbeat" in unlabeled_actions),
        }
        failed = [name for name, ok in unlabeled_checks.items() if not ok]
        self.record(
            "the unlabeled heartbeat's action pane names it by the default name with the instruction subtitle"
            + (f" (missing: {', '.join(failed)})" if failed else ""),
            not failed,
            evidence="10-unlabeled-actions.txt",
        )

        B.tmux_kill(tmux)
        ok = all(f["ok"] for f in self.findings)
        return ok

    def wait_catalog_status(self, session_id: str, expected_paused: int, timeout: float = 30.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            wire = B.Wire(self.side.daemon_socket)
            try:
                data = wire.request(
                    "hb-status",
                    {"type": "heartbeats_list", "activeSessionId": session_id},
                    timeout=30,
                )
            finally:
                wire.close()
            heartbeats = (data.get("data") or {}).get("heartbeats") or []
            paused = [
                entry
                for entry in heartbeats
                if (entry.get("job") or {}).get("status") == "paused"
            ]
            if len(paused) == expected_paused:
                return heartbeats
            time.sleep(1.0)
        return None

    def stop(self) -> None:
        try:
            wire = B.Wire(self.side.daemon_socket)
            wire.send_command("sd", {"type": "shutdown"})
            wire.close()
            time.sleep(2)
        except Exception:
            pass
        B.reap_daemons(socket_paths=[self.side.daemon_socket], needles=[str(self.side.daemon_socket)])
        self.side.mock.stop()
        if self.side.daemon_proc and self.side.daemon_proc.poll() is None:
            self.side.daemon_proc.terminate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", choices=["rust", "ts"], required=True)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--repo", default=str(REPO))
    parser.add_argument("--out", default=str(REPO / "scripts" / "heartbeats-runs"))
    args = parser.parse_args()

    globals()["REPO"] = Path(args.repo).resolve()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = Path(args.out) / stamp
    out.mkdir(parents=True, exist_ok=True)
    verifier = Verifier(args.side, args.binary, out)
    ok = False
    try:
        ok = verifier.run()
    finally:
        verifier.stop()
        (out / "findings.json").write_text(json.dumps(verifier.findings, indent=2))
    print(f"\n{'PASS' if ok else 'FAIL'} — evidence: {out / args.side}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
