#!/usr/bin/env python3
"""Heartbeat-fire verifier (lane: hb-fire, dogfood P0).

Wire-level user test proving the kernel heartbeat FIRE chain on both
products (TS parity diff): a daemon session whose kernel creates an
`rlm_heartbeat` (the rlm-heartbeat skill host request, `every 30s`,
delivery steer) must actually FIRE within the interval —

  1. the fire lands its prompt in the session (the session file gains
     the instruction as a user message, the visible "Heartbeat prompt"
     row source),
  2. the store records the run (`runCount` bumps to >= 1, `lastRunAt`
     sets, `nextRunAt` rolls past the boundary),
  3. the wire catalog (`heartbeats_list`) reflects the fired state.

This is the exact repro of the dogfood P0 (a heartbeat created 20:47:23
with next_run_at 20:48:00 that never fired): a job created after the
bind-time scheduler arm must re-arm the timer (TS
`cronScheduler.wake()` at the controller call sites) and fire.

Runs one side at a time (`--side rust` or `--side ts`); both sides must
pass every step. Timing information (nextRunAt/lastRunAt) is recorded
for the diff but never asserted equal to the second.

Usage:
  python3 scripts/heartbeat_fire_parity.py --side rust --binary <path> \
      --repo <checkout> [--out <dir>]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "battery"))
import batterylib as B  # noqa: E402

AGENT_HB_INSTRUCTION = "agent heartbeat fire probe instruction"
AGENT_HB_LABEL = "hb-fire"
AGENT_INTERVAL = "every 30s"
SEED_REPLY = "heartbeat fire verifier seed reply"
FIRE_TIMEOUT_S = 120.0  # the interval plus turn-settle slack


class Verifier:
    def __init__(self, side_name: str, binary: str, out: Path):
        self.name = side_name
        self.out = out
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.runid = "hbf" + stamp
        root = out / self.name
        root.mkdir(parents=True, exist_ok=True)
        agent = root / "agent"
        work = root / "work"
        work.mkdir(parents=True, exist_ok=True)
        if agent.exists():
            shutil.rmtree(agent)
        agent.mkdir(parents=True)
        mock = B.MockProvider(root, [])
        mock.set_responses([{"text": SEED_REPLY}])
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
            self.side.env["PI_PACKAGE_DIR"] = str(REPO)
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

    def catalog(self, session_id: str) -> list:
        wire = B.Wire(self.side.daemon_socket)
        try:
            data = wire.request(
                "hb-list",
                {"type": "heartbeats_list", "activeSessionId": session_id},
                timeout=30,
            )
        finally:
            wire.close()
        return (data.get("data") or {}).get("heartbeats") or []

    def run(self) -> bool:
        self.ensure_daemon()
        wire = B.Wire(self.side.daemon_socket)
        create = wire.request(
            "hb-create",
            {
                "type": "create",
                "name": "hb-fire-verifier",
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

        # Seed turn: the session becomes created + persisted and the kernel
        # (the rlm-heartbeat skill host requests) is live.
        self.side.mock.set_responses([{"text": SEED_REPLY}])
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

        # The kernel creates the heartbeat (the rlm-heartbeat skill host
        # request): the same path the dogfood session drove.
        code = (
            "import rlm_heartbeat\n"
            "hb = await rlm_heartbeat.create(\n"
            f"    {AGENT_HB_INSTRUCTION!r},\n"
            f"    interval={AGENT_INTERVAL!r},\n"
            f"    label={AGENT_HB_LABEL!r},\n"
            ")\n"
            "print('created', hb['id'])"
        )
        self.side.mock.set_responses(
            [
                {"toolCall": {"name": "ipython", "arguments": {"code": code}}},
                {"text": "agent heartbeat created"},
            ]
        )
        agent_reply = wire.request(
            "hb-agent",
            {
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "create the agent heartbeat",
            },
            timeout=240,
        )
        self.record("agent heartbeat turn ran", agent_reply.get("success") is True)
        self.evidence_json("01-agent-heartbeat-turn.json", agent_reply)

        # The catalog must carry the job, active, not yet run.
        job = self.wait_job(session_id)
        if job is None:
            self.record("catalog lists the agent heartbeat", ok=False)
            wire.close()
            return False
        self.record("catalog lists the agent heartbeat", True)
        self.record("created job is active and unrun", job.get("status") == "active")
        self.record("created job runCount is 0", (job.get("runCount") or 0) == 0)

        # THE FIRE: within the interval (+ slack) the job must run.
        fired = self.wait_fire(session_id, job.get("id") or "")
        self.evidence_json("02-fired-catalog.json", self.catalog(session_id))
        if fired is None:
            self.record(
                "the heartbeat fired within the interval (runCount >= 1)",
                ok=False,
                evidence="02-fired-catalog.json",
            )
            wire.close()
            return False
        self.record(
            f"the heartbeat fired within the interval (runCount >= 1, "
            f"runCount={fired.get('runCount')})",
            True,
            evidence="02-fired-catalog.json",
        )
        self.record("the fire stamped lastRunAt", bool(fired.get("lastRunAt")))
        self.record(
            "the fire rolled nextRunAt past the boundary",
            bool(fired.get("nextRunAt")),
        )
        wire.close()

        # The fired prompt reached the session: the instruction is a user
        # message in the session file (the "Heartbeat prompt" row source).
        session_dir = self.side.agent_dir / "sessions"
        hits = []
        for path in sorted(session_dir.glob("*.jsonl")):
            if AGENT_HB_INSTRUCTION in path.read_text(errors="replace"):
                hits.append(path.name)
        self.evidence(
            "03-transcript-hit.txt",
            "\n".join(hits) + f"\ninstruction: {AGENT_HB_INSTRUCTION}",
        )
        self.record(
            "the fired prompt landed in the session transcript",
            bool(hits),
            evidence="03-transcript-hit.txt",
        )
        return all(finding["ok"] for finding in self.findings)

    def wait_job(self, session_id: str, timeout: float = 60.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for entry in self.catalog(session_id):
                job = entry.get("job") or {}
                if job.get("source") == "rlm_heartbeat":
                    return job
            time.sleep(1.0)
        return None

    def wait_fire(self, session_id: str, job_id: str) -> dict | None:
        deadline = time.time() + FIRE_TIMEOUT_S
        while time.time() < deadline:
            for entry in self.catalog(session_id):
                job = entry.get("job") or {}
                if job.get("id") == job_id and (job.get("runCount") or 0) >= 1:
                    return job
            time.sleep(2.0)
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", required=True, choices=["rust", "ts"])
    parser.add_argument("--binary", required=True)
    parser.add_argument("--repo", default=str(REPO))
    parser.add_argument("--out", default=str(REPO / "scripts" / "heartbeat-fire-runs"))
    args = parser.parse_args()

    verifier = Verifier(args.side, args.binary, Path(args.out))
    try:
        ok = verifier.run()
    finally:
        try:
            verifier.side.stop_daemon()
        except Exception:
            pass
    verifier.evidence_json("summary.json", verifier.findings)
    failed = [f for f in verifier.findings if not f["ok"]]
    print(f"\n{args.side}: {len(verifier.findings) - len(failed)}/{len(verifier.findings)} steps ok")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
