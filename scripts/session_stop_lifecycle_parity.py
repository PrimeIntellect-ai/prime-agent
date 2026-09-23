#!/usr/bin/env python3
"""Stop-lifecycle verifier (lane: deletion-lifecycle; the zombie fix).

Wire-level user test proving the stop/delete lifecycle on both products
(TS parity diff): stopping a session must cancel its goals' continuation
paths AND its scheduled jobs (heartbeats), and no wake pass may revive
the stopped session. The TS contract under test (daemon-mode
`closeSessionOnce("killed")` -> `cancelScheduledJobsForSession`, the
supervisor's `finalizeArchivedWorkerStop`, `isPersistedCronJobRunnable`,
`collectPassiveScheduledJobs`):

  1. a session with an active goal + an active heartbeat is KILLED through
     the wire `kill` (the stop path);
  2. the kill cancels the heartbeat durably (`scheduled-jobs.json` flips
     the job to `cancelled`, `nextRunAt` clears) and archives the session
     file (state `archived`);
  3. after a daemon restart, the session never revives (no boot re-arm
     wake, no schedule delivery) — the daemon's `list` never shows it
     again, the goal record freezes (no continuation rows), and the
     store's cancel + archived state held.

Runs one side at a time (`--side rust` or `--side ts`); both sides must
pass every step. Timing information (nextRunAt/lastRunAt) is recorded for
the diff but never asserted equal to the second.

Usage:
  python3 scripts/session_stop_lifecycle_parity.py --side rust --binary <path> \
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

OBJECTIVE = "keep the lane alive until merged"
HEARTBEAT_PROMPT = "liveness ping"
HEARTBEAT_SCHEDULE = "every 10s"
NO_REVIVAL_WINDOW_S = 12.0


class Verifier:
    def __init__(self, side_name: str, binary: str, out: Path, repo: Path):
        self.name = side_name
        self.out = out
        self.repo = repo
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.runid = "stop" + stamp
        root = out / self.name
        root.mkdir(parents=True, exist_ok=True)
        agent = root / "agent"
        work = root / "work"
        work.mkdir(parents=True, exist_ok=True)
        if agent.exists():
            shutil.rmtree(agent)
        agent.mkdir(parents=True)
        mock = B.MockProvider(root, [])
        mock.set_responses([{"text": "the lane works on"} for _ in range(8)])
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
        if side_name == "rust":
            self.side.env["PI_PACKAGE_DIR"] = str(self.repo)
        self.side.env["PRIME_API_KEY"] = "sk-battery"
        self.side.write_models_json()
        settings_path = agent / "settings.json"
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        settings["onboardingShown"] = True
        settings["telemetry"] = {**(settings.get("telemetry") or {}), "noticeShown": True}
        settings_path.write_text(json.dumps(settings))
        self.findings: list[dict] = []

    def record(self, summary: str, ok: bool, evidence: str = "") -> None:
        self.findings.append(
            {"side": self.name, "ok": ok, "summary": summary, "evidence": evidence}
        )
        print(f"[{'ok  ' if ok else 'FAIL'}] {self.name}: {summary}")

    def evidence_json(self, name: str, obj) -> Path:
        path = self.out / self.name
        path.mkdir(parents=True, exist_ok=True)
        target = path / name
        target.write_text(json.dumps(obj, indent=2))
        return target

    def request(self, command_id: str, command: dict, timeout: float = 120) -> dict:
        wire = B.Wire(self.side.daemon_socket)
        try:
            return wire.request(command_id, command, timeout=timeout)
        finally:
            wire.close()

    def create_session(self) -> dict:
        return self.request(
            "stop-create",
            {
                "type": "create",
                "name": "stop-lifecycle",
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

    def session_file(self, session_id: str) -> Path:
        return self.side.agent_dir / "sessions" / f"{session_id}.jsonl"

    def scheduled_jobs(self, session_id: str) -> dict:
        path = (
            self.side.agent_dir
            / "session-artifacts"
            / session_id
            / "scheduled-jobs.json"
        )
        if not path.exists():
            return {}
        return json.loads(path.read_text())

    def latest_state(self, session_id: str) -> str:
        state = ""
        for line in self.session_file(session_id).read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "session_state":
                status = entry.get("state", {}).get("status")
                if status:
                    state = status
        return state

    def goal_rows(self, session_id: str) -> list[dict]:
        rows = []
        for line in self.session_file(session_id).read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "custom" and entry.get("customType") == "thread_goal_state":
                rows.append(entry)
        return rows

    def file_row_count(self, session_id: str) -> int:
        return len(
            [line for line in self.session_file(session_id).read_text().splitlines() if line.strip()]
        )

    def listed_ids(self) -> list[str]:
        response = self.request("stop-list", {"type": "list"}, timeout=30)
        sessions = (response.get("data") or {}).get("sessions") or []
        return [
            (row.get("sessionId") or row.get("id") or "") for row in sessions
        ]

    def run(self) -> bool:
        self.side.start_daemon()
        created = self.create_session()
        if created.get("success") is not True:
            self.record("daemon create failed: " + json.dumps(created)[:200], ok=False)
            return False
        session_id = (
            (created.get("data") or {}).get("sessionId")
            or (created.get("data") or {}).get("activeSessionId")
            or (created.get("data") or {}).get("id")
            or ""
        )
        self.record("daemon created the session", bool(session_id))

        # The zombie-orchestrator shape: an active goal + a heartbeat.
        started = self.request(
            "stop-goal",
            {
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": f"/goal {OBJECTIVE}",
            },
            timeout=240,
        )
        self.record("the goal start turn ran", started.get("success") is True)
        heartbeat = self.request(
            "stop-hb",
            {
                "type": "heartbeat_set",
                "activeSessionId": session_id,
                "schedule": HEARTBEAT_SCHEDULE,
                "prompt": HEARTBEAT_PROMPT,
            },
            timeout=60,
        )
        self.record("heartbeat_set registered the heartbeat", heartbeat.get("success") is True)
        jobs = (self.scheduled_jobs(session_id).get("jobs") or [])
        self.record(
            "the heartbeat job is active in the durable store",
            any(job.get("status") == "active" for job in jobs),
        )

        # THE STOP: the wire kill.
        killed = self.request(
            "stop-kill", {"type": "kill", "activeSessionId": session_id}, timeout=120
        )
        self.record("the wire kill succeeded", killed.get("success") is True)
        self.evidence_json("01-kill-response.json", killed)

        # The kill cancelled the heartbeat durably and archived the file.
        deadline = time.time() + 10
        job_status = None
        while time.time() < deadline:
            jobs = (self.scheduled_jobs(session_id).get("jobs") or [])
            if jobs and jobs[0].get("status") == "cancelled":
                job_status = jobs[0].get("status")
                break
            time.sleep(0.2)
        jobs = (self.scheduled_jobs(session_id).get("jobs") or [])
        job_status = jobs[0].get("status") if jobs else None
        self.evidence_json("02-post-kill-jobs.json", self.scheduled_jobs(session_id))
        self.record(
            "the killed session's heartbeat cancelled in the durable store",
            job_status == "cancelled",
        )
        state = self.latest_state(session_id)
        self.record("the killed session's file archived", state == "archived")
        # The frozen-record baselines: captured after the kill settles (the
        # kill appends its own `session_state: archived` row and an
        # in-flight continuation may land rows before the archive
        # settles), so the post-restart comparisons measure only what a
        # revival would have written.
        goal_rows_at_kill = self.goal_rows(session_id)
        file_rows_at_kill = self.file_row_count(session_id)

        # The restart: the wake passes (boot re-arm, adoption) get their
        # shot at reviving the stopped session.
        self.side.stop_daemon()
        time.sleep(1)
        self.side.start_daemon()

        # THE ACCEPTANCE: no revival across the window (an active
        # `every 10s` heartbeat would have woken the session within it).
        revived = False
        deadline = time.time() + NO_REVIVAL_WINDOW_S
        while time.time() < deadline:
            if session_id in self.listed_ids():
                revived = True
                break
            time.sleep(0.5)
        self.record("the killed session never revived after the restart", not revived)

        # No continuation: the goal record and the file froze at the kill.
        self.record(
            "the stopped session's goal record froze",
            len(self.goal_rows(session_id)) == len(goal_rows_at_kill),
        )
        self.record(
            "the stopped session's file froze",
            self.file_row_count(session_id) == file_rows_at_kill,
        )
        self.record(
            "the durable cancel held across the restart",
            ((self.scheduled_jobs(session_id).get("jobs") or [{}])[0].get("status") == "cancelled"),
        )
        self.record(
            "the archived state held across the restart",
            self.latest_state(session_id) == "archived",
        )
        self.evidence_json("03-final-jobs.json", self.scheduled_jobs(session_id))
        self.side.stop_daemon()
        return all(finding["ok"] for finding in self.findings)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", required=True, choices=["rust", "ts"])
    parser.add_argument("--binary", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", default="scripts/stop-lifecycle-runs")
    args = parser.parse_args()
    out = Path(args.out)
    verifier = Verifier(args.side, args.binary, out, Path(args.repo))
    ok = verifier.run()
    out_dir = out / args.side
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "findings.json").write_text(json.dumps(verifier.findings, indent=2))
    print(f"[{'PASS' if ok else 'FAIL'}] {args.side}: stop lifecycle")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
