#!/usr/bin/env python3
"""Steer/queue/abort wire parity (TS binary vs Rust build).

Drives both products side by side over the daemon wire with the same mock
provider script and byte-compares the normalized event traces of the
three flows that define the queue/abort UX:

- steer/follow-up boundary delivery: a queued steer and a queued
  follow-up both deliver as a NEW run at the agent-idle boundary (the
  TS-verified daemon semantic; the agent-level mid-run injection lives in
  the agent library and is not on the daemon wire), steering lane first,
  and the delivery projects the TS active-action phases (`preparing` at
  pickup, `committing` before the dispatch, `running` after the delivered
  run's `agent_start`, cleared at the settle, the compactRlmText label).
- multi-steer batch delivery (queue mode "all", seeded via
  `<agentDir>/settings.json` `steeringMode`): three steers parked behind
  a running wedge turn co-deliver as ONE batched turn at the boundary
  (TS `_pumpSessionInputs`'s mode-gated gathering +
  `turnExecutionPoliciesEqual`) - one delivery `agent_start`, three user
  rows, one reply - on both binaries byte-compareably.
- abort settle: an abort during a running kernel cell settles the turn
  at once - tool_execution_end(isError) + the aborted toolResult row pair
  + turn_end + agent_end broadcast (and the toolResult row persists),
  the cell dies (no finish marker), the queue suspends (the TS
  `requestAbort` suspension) and a steer resumes it.
- abort ownership: the abort of a busy session A (with a parked steer)
  neither kills nor corrupts a concurrent session B - B's own turn runs
  to completion, A's queued steer survives parked and delivers after the
  resume.

Each side runs alone (`--side rust` / `--side ts`); after both, `--diff`
byte-compares the normalized traces and the projection sequences. The
normalization keeps frame shapes and ordering (ids, timestamps, meta,
usage, and the racy aborted-tool text are scrubbed) so a semantic drift
fails the diff even when every assertion passes.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "battery"))
import batterylib as B  # noqa: E402  (the shared daemon-reap sweep)

PROMPT = "three tools prompt the queue drives"
STEER_MSG = "steer now use plan b"
FOLLOWUP_MSG = "follow up now do more"
BATCH_STEERS = [
    "steer batch one",
    "steer batch two",
    "steer batch three",
]
# Each tool cell sleeps so the parked inputs land deterministically
# mid-run: the steer arrives during tool 2's cell, so the run stops at
# the next boundary (TS `_steeringStopPending`) and never runs tool 3.
THREE_TOOLS = [
    {"toolCall": {"name": "ipython", "arguments": {"code": "import time\nprint('tool one done')\ntime.sleep(3)"}}},
    {"toolCall": {"name": "ipython", "arguments": {"code": "import time\nprint('tool two done')\ntime.sleep(3)"}}},
    {"toolCall": {"name": "ipython", "arguments": {"code": "import time\nprint('tool three done')\ntime.sleep(3)"}}},
    {"text": "all three tools done"},
]
WEDGE_CELL = (
    "import time\n"
    "open('wedge-started','w').write('1')\n"
    "time.sleep(300)\n"
    "open('wedge-finished','w').write('1')\n"
    "print('cell done')"
)
# The compared frame family (everything else - dashboards, heartbeats,
# goal recaps - is side-internal noise and is filtered before the diff).
COMPARED_TYPES = {
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "message_update",
    "tool_execution_start",
    "tool_execution_end",
    "session_action_update",
}


def normalize_event(event: dict) -> dict:
    """One normalized frame: type + the stable shape fields only."""
    kind = event.get("type")
    out = {"type": kind}
    if kind in ("message_start", "message_end"):
        message = event.get("message") or {}
        role = message.get("role")
        out["role"] = role
        if kind == "message_start" and role == "assistant":
            # The start frame's partial content is stream-chunk dependent
            # (TS carries the first block, Rust starts empty): only the
            # END frame's content shape is compared.
            return out
        if role == "user":
            out["text"] = message.get("content")
        elif role == "assistant":
            content = message.get("content") or []
            kinds = [part.get("type") for part in content if isinstance(part, dict)]
            out["content"] = kinds
            out["stop"] = message.get("stopReason")
        elif role == "toolResult":
            is_error = bool(message.get("isError"))
            out["isError"] = is_error
            if is_error:
                out["text"] = "<ABORT-RESULT>"
            else:
                texts = [
                    part.get("text", "")
                    for part in (message.get("content") or [])
                    if isinstance(part, dict)
                ]
                out["text"] = "\n".join(texts)
        elif role == "custom":
            out["customType"] = message.get("customType")
    elif kind == "tool_execution_end":
        out["isError"] = bool(event.get("isError"))
        if out["isError"]:
            out["text"] = "<ABORT-RESULT>"
        else:
            result = event.get("result") or {}
            texts = [
                part.get("text", "")
                for part in (result.get("content") or [])
                if isinstance(part, dict)
            ]
            out["text"] = "\n".join(texts)
    elif kind == "turn_end":
        message = event.get("message") or {}
        content = message.get("content") or []
        kinds = [part.get("type") for part in content if isinstance(part, dict)]
        out["content"] = kinds
        out["stop"] = message.get("stopReason")
        results = event.get("toolResults") or []
        out["toolResults"] = [
            {"isError": bool(result.get("isError")), "text": "<ABORT-RESULT>" if result.get("isError") else (result.get("content") or [{}])[0].get("text", "")}
            for result in results
        ]
    elif kind == "agent_end":
        messages = event.get("messages") or []
        # The harness-digest custom row is session-content (present when
        # the side's session has harness state), not the queue/abort
        # surface: it drops from the compared roles.
        out["roles"] = [
            (message.get("role"), (message.get("content") or [{}])[0].get("type", None) if isinstance(message.get("content"), list) else None)
            for message in messages
            if message.get("role") != "custom"
        ]
    elif kind == "session_action_update":
        out["actions"] = event.get("actions")
    elif kind == "message_update":
        out["type"] = "message_update"
    return out


class Side:
    def __init__(self, name: str, binary: str, out: Path, steering_mode: str | None = None):
        self.name = name
        self.out = out / name
        self.out.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.runid = "sqp" + stamp
        self.root = out / f"{name}-{stamp}"
        self.agent = self.root / "agent"
        self.agent.mkdir(parents=True)
        self.work = self.root / "work"
        self.work.mkdir()
        # The queue delivery modes (TS `steeringMode`/`followUpMode`, the
        # global `<agentDir>/settings.json`): `all` batches the parked
        # steering prefix into ONE co-delivered turn at the boundary.
        if steering_mode is not None:
            (self.agent / "settings.json").write_text(
                json.dumps({"steeringMode": steering_mode, "followUpMode": "one-at-a-time"})
            )
        self.mock = B.MockProvider(self.root, [0])
        self.mock.set_responses([{"text": "idle filler"}])
        self.mock.start()
        self.binary = binary
        # Findings accumulate ACROSS the run's Side instances (each flow
        # builds its own Side; a per-instance list loses the earlier
        # flows' FAILs from the summary).
        self.findings: list[dict] = []
        self.all_findings: list[dict] = []
        prior = out / "all-findings.json"
        if prior.exists():
            try:
                self.all_findings = json.loads(prior.read_text())
            except Exception:
                self.all_findings = []
        self.env = B.scrubbed_env(self.agent, self.root / "tmp")
        # The kernel python: reuse the machine's installed kernel venv when
        # present. A fresh HOME would otherwise bootstrap a fresh venv per
        # run (a full `uv sync`), which exceeds the supervisor's 30s
        # worker-boot deadline (the TS `WORKER_CONNECT_TIMEOUT_MS`) on a
        # loaded box - the kernel itself stays real, only the venv
        # bootstrap is reused.
        import os as _os
        kernel_python = Path.home() / ".prime/agent/kernel-venv/bin/python"
        if kernel_python.exists():
            self.env["PRIME_AGENT_KERNEL_PYTHON"] = str(kernel_python)
        if name == "rust":
            self.env["PI_PACKAGE_DIR"] = str(REPO)
        self.write_models_json()
        self.daemon_proc = None
        self.sock = None

    # -- daemon lifecycle ---------------------------------------------------

    def write_models_json(self) -> None:
        models = {
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": self.mock.url(),
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "baseUrl": self.mock.url(),
                            "contextWindow": 128000,
                            "maxTokens": 4096,
                        }
                    ],
                }
            }
        }
        (self.agent / "models.json").write_text(json.dumps(models))

    def start_daemon(self) -> None:
        argv = [self.binary, "supervisor", "--socket", str(self.root / "daemon.sock"), "--agent-dir", str(self.agent)]
        self.daemon_proc = subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=open(self.root / "daemon.log", "w"),
            env=self.env,
        )
        deadline = time.time() + 30
        candidates = [self.root / "daemon.sock", self.root / "tmp" / f"prime-agent-{B.os.getuid()}" / "daemon.sock"]
        while time.time() < deadline:
            for cand in candidates:
                if cand.exists():
                    self.sock = cand
                    return
            if self.daemon_proc.poll() is not None:
                raise SystemExit(f"{self.name} daemon exited early")
            time.sleep(0.1)
        raise SystemExit(f"{self.name} daemon socket never appeared")

    def stop_daemon(self) -> None:
        needles = [str(self.root / "daemon.sock"), str(self.root)]
        B.reap_daemons(socket_paths=[self.sock] if self.sock else [], needles=needles, proc=self.daemon_proc)

    # -- helpers ------------------------------------------------------------

    def record(self, summary: str, ok: bool, evidence: str = "") -> None:
        finding = {"side": self.name, "ok": ok, "summary": summary, "evidence": evidence}
        self.findings.append(finding)
        self.all_findings.append(finding)
        (self.out / "all-findings.json").write_text(json.dumps(self.all_findings, indent=1))
        print(f"[{'ok  ' if ok else 'FAIL'}] {self.name}: {summary}")

    def evidence(self, name: str, text: str) -> None:
        (self.out / name).write_text(text)

    def queue_script(self, responses: list, extra_queues: list | None = None) -> None:
        """Session-scoped mock queues, first-match-wins per request. The
        dashboard catch-all must come first: the daemon's status-line
        recap requests embed the conversation (so they carry every flow
        prompt's marker text) and their own `<agent-state>` wrapper; the
        wrapper routes them here before they can steal a flow response."""
        queues = [
            {"name": "dashboard", "match": ["<agent-state>"], "responses": [{"text": "ok"}]},
            {"name": "flow", "match": [PROMPT], "responses": responses},
        ]
        queues.extend(extra_queues or [])
        self.mock.set_responses([{"text": "idle filler"}], queues=queues)

    def wait_marker(self, path: Path, timeout: float = 240.0, wire=None) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if wire:
                wire.drain(0.3)
            if path.exists():
                return True
            time.sleep(0.2)
        return False

    def wait_event(self, wire, predicate, timeout: float = 120.0):
        """Drain until a matching session event arrives; returns it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            wire.drain(0.4)
            for e in wire.events:
                if e.get("type") == "session_event":
                    if predicate(e["event"]):
                        return e["event"]
        return None

    def session_event_types(self, wire) -> list:
        return [
            e["event"].get("type")
            for e in wire.events
            if e.get("type") == "session_event"
        ]

    def raw_trace(self, wire) -> list:
        """The raw session events; the diff-time normalizer filters and
        shapes them so a normalization tweak never needs a side re-run."""
        return [e["event"] for e in wire.events if e.get("type") == "session_event"]

    # -- flows --------------------------------------------------------------

    def flow_queue_delivery(self) -> list:
        """The steer + follow-up boundary delivery and its projections."""
        work = self.root / "work-q"
        work.mkdir()
        self.queue_script(THREE_TOOLS + [
            {"text": f"acknowledged {STEER_MSG}"},
            {"text": f"acknowledged {FOLLOWUP_MSG}"},
        ])
        wire = B.Wire(self.sock)
        try:
            created = wire.request("q-create", {"type": "create", "config": {"cwd": str(work), "model": "mock-1", "sessionDir": str(self.agent / "sessions")}})
            assert created.get("success") is True, created
            sid = created["data"]["id"]
            wire.request("q-attach", {"type": "attach", "activeSessionId": sid})
            prompt = wire.request("q-prompt", {"type": "prompt", "activeSessionId": sid, "message": PROMPT})
            assert prompt.get("success") is True, prompt
            # Park both inputs mid-run (after tool one's tool_execution_end).
            first_end = self.wait_event(wire, lambda ev: ev.get("type") == "tool_execution_end")
            self.record("the 3-tool run started", first_end is not None)
            steer = wire.request("q-steer", {"type": "steer", "activeSessionId": sid, "message": STEER_MSG})
            follow = wire.request("q-follow", {"type": "follow_up", "activeSessionId": sid, "message": FOLLOWUP_MSG})
            self.record("steer + follow_up parked behind the busy turn", steer.get("success") is True and follow.get("success") is True)
            # Both deliver as new runs at the idle boundary, steer first.
            steered = self.wait_event(wire, lambda ev: ev.get("type") == "message_start" and STEER_MSG in json.dumps(ev.get("message") or {}), timeout=180)
            self.record("the steer delivered as a new run at the idle boundary", steered is not None)
            followed = self.wait_event(wire, lambda ev: ev.get("type") == "message_start" and FOLLOWUP_MSG in json.dumps(ev.get("message") or {}), timeout=180)
            self.record("the follow-up delivered after the steer's run", followed is not None)
            # Drain past the follow-up run's settle: the cleared queue
            # projection arrives after the delivered run's agent_end.
            if followed is not None:
                self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=180)
                wire.drain(2.0)
            types = self.session_event_types(wire)
            if steered is not None and followed is not None:
                steer_idx = types.index("message_start", types.index("agent_start", 0)) if False else None
            # The projection phases: preparing/committing before the
            # delivered run's agent_start, running after it, with labels.
            trace = [
                normalize_event(ev)
                for ev in self.raw_trace(wire)
                if ev.get("type") in COMPARED_TYPES
            ]
            phase_seq = [t["actions"].get("active", {}).get("phase") if t["type"] == "session_action_update" else None for t in trace]
            phases = [p for p in phase_seq if p]
            self.record("the delivery projected preparing/committing/running with labels", phases[:3] == ["preparing", "committing", "running"], json.dumps(phases))
            labels = [t["actions"].get("active", {}).get("label") for t in trace if t["type"] == "session_action_update" and t["actions"].get("active")]
            self.record("the active labels are the compacted messages", labels and all(l in (STEER_MSG, FOLLOWUP_MSG) for l in labels if l), json.dumps(labels))
            return self.raw_trace(wire)
        finally:
            wire.close()

    def flow_batch_delivery(self) -> list:
        """The multi-steer batch under queue mode "all" (TS
        `_pumpSessionInputs`'s mode gate): the same-lane parked prefix
        co-delivers as ONE batched turn at the boundary."""
        work = self.root / "work-b"
        work.mkdir()
        # The parked-lane parking must be deterministic: tool one's cell
        # holds the turn long enough for every steer to park mid-run (the
        # established three-tools pattern), so the steering stop ends the
        # run at tool one's boundary with the whole prefix queued.
        # The mock serves its responses in request order: the wedge's
        # two tool calls consume the first two; the steering stop ends the
        # run at tool two's boundary, so the batched turn is request
        # three — the batch reply.
        self.queue_script(
            [
                {"toolCall": {"name": "ipython", "arguments": {"code": "import time\nprint('batch tool one done')\ntime.sleep(5)"}}},
                {"toolCall": {"name": "ipython", "arguments": {"code": "import time\nprint('batch tool two done')\ntime.sleep(12)"}}},
            ]
            + [{"text": "batch reply"}, {"text": "all batch tools done"}]
        )
        wire = B.Wire(self.sock)
        try:
            created = wire.request("b-create", {"type": "create", "config": {"cwd": str(work), "model": "mock-1", "sessionDir": str(self.agent / "sessions")}})
            assert created.get("success") is True, created
            sid = created["data"]["id"]
            wire.request("b-attach", {"type": "attach", "activeSessionId": sid})
            prompt = wire.request("b-prompt", {"type": "prompt", "activeSessionId": sid, "message": PROMPT})
            assert prompt.get("success") is True, prompt
            first_end = self.wait_event(wire, lambda ev: ev.get("type") == "tool_execution_end")
            self.record("the batch wedge run started", first_end is not None)
            park_t0 = time.time()
            for msg in BATCH_STEERS:
                parked = wire.request(f"b-steer-{msg}", {"type": "steer", "activeSessionId": sid, "message": msg})
                assert parked.get("success") is True, parked
                print(f"[timing] {self.name}: parked {msg!r} at +{time.time() - park_t0:.2f}s")
            # The parked rows project before the boundary: every steer is
            # visible in the queue projection before the run stops (the
            # parking is part of the assertion surface, and it makes the
            # pickup race-free: all three rows are queued when the
            # boundary hits).
            for msg in BATCH_STEERS:
                proj = self.wait_event(
                    wire,
                    lambda ev, m=msg: ev.get("type") == "session_action_update"
                    and m in json.dumps(ev.get("actions") or {}),
                    timeout=60,
                )
                print(f"[timing] {self.name}: projected {msg!r} at +{time.time() - park_t0:.2f}s")
            assert proj is not None, "the parking projection never arrived"
            self.record("three steers parked behind the busy turn", True)
            # The run stops at the wedge's boundary and the parked prefix
            # co-delivers as ONE batched turn: one delivery agent_start,
            # three user rows, one reply.
            delivered = self.wait_event(
                wire,
                lambda ev: ev.get("type") == "message_start"
                and BATCH_STEERS[0] in json.dumps(ev.get("message") or {}),
                timeout=180,
            )
            self.record("the batched turn's first steer row delivered", delivered is not None)
            replied = self.wait_event(
                wire,
                lambda ev: ev.get("type") == "message_end"
                and "batch reply" in json.dumps(ev.get("message") or {}),
                timeout=180,
            )
            self.record("the batched turn settled with one reply", replied is not None)
            if replied is not None:
                self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=180)
                wire.drain(2.0)
            types = self.session_event_types(wire)
            if delivered is not None and replied is not None:
                # The delivery window: everything after the wedge run's
                # agent_end (the batched turn is the next — and, under
                # mode "all", the only — run).
                wedge_end = types.index("agent_end")
                delivery = types[wedge_end + 1 :]
                self.record(
                    "the delivery ran as ONE agent_start",
                    delivery.count("agent_start") == 1,
                    json.dumps(delivery[:40]),
                )
                # The three steers + the batched reply ride the one run:
                # three user message_starts plus the reply's.
                self.record(
                    "the three steers co-delivered in the one batched turn",
                    delivery.count("message_start") >= 4,
                    json.dumps(delivery[:40]),
                )
            return self.raw_trace(wire)
        finally:
            wire.close()

    def flow_abort_settle(self) -> list:
        """The abort during a running kernel cell."""
        work = self.root / "work-a"
        work.mkdir()
        self.queue_script([
            {"toolCall": {"name": "ipython", "arguments": {"code": WEDGE_CELL}}},
            {"text": "the cell completed"},
            {"text": "resumed after the abort"},
        ])
        wire = B.Wire(self.sock)
        try:
            created = wire.request("a-create", {"type": "create", "config": {"cwd": str(work), "model": "mock-1", "sessionDir": str(self.agent / "sessions")}})
            assert created.get("success") is True, created
            sid = created["data"]["id"]
            wire.request("a-attach", {"type": "attach", "activeSessionId": sid})
            prompt = wire.request("a-prompt", {"type": "prompt", "activeSessionId": sid, "message": PROMPT})
            assert prompt.get("success") is True, prompt
            started = self.wait_marker(work / "wedge-started", wire=wire)
            self.record("the wedge cell started (real kernel)", started)
            abort = wire.request("a-abort", {"type": "abort", "activeSessionId": sid})
            self.record("the abort command succeeded", abort.get("success") is True)
            settled = self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=60)
            self.record("the aborted turn settled (agent_end within the budget)", settled is not None)
            # The settle frames: tool_execution_end(isError) + toolResult
            # pair + turn_end before the agent_end.
            types = self.session_event_types(wire)
            if settled is not None:
                idx = len(types) - 1 - types[::-1].index("agent_end")
                tail = types[: idx + 1]
                ok = (
                    "tool_execution_end" in tail
                    and tail.count("message_end") >= 2
                    and "turn_end" in tail
                )
                self.record("the settle frames: tool_execution_end + toolResult pair + turn_end + agent_end", ok, json.dumps(tail[-8:]))
            time.sleep(3)
            self.record("the interrupted cell died (no finish marker)", not (work / "wedge-finished").exists())
            # The toolResult row persisted.
            persisted = False
            for path in (self.agent / "sessions").glob("*.jsonl"):
                for line in path.read_text().splitlines():
                    row = json.loads(line)
                    message = row.get("message") or {}
                    if message.get("role") == "toolResult" and message.get("isError") is True:
                        persisted = True
            self.record("the aborted toolResult row persisted to the session file", persisted)
            # The queue suspension: a plain prompt is refused, a steer resumes.
            refused = wire.request("a-susp", {"type": "prompt", "activeSessionId": sid, "message": "plain prompt after abort"})
            self.record("a plain prompt is refused while the queue is suspended", refused.get("success") is False, json.dumps(refused.get("error"))[:120])
            resume = wire.request("a-resume", {"type": "steer", "activeSessionId": sid, "message": "resume the session please"})
            self.record("a steer resumed the suspended queue", resume.get("success") is True)
            resumed = self.wait_event(wire, lambda ev: ev.get("type") == "message_start" and "resume the session please" in json.dumps(ev.get("message") or {}), timeout=180)
            self.record("the resume steer delivered", resumed is not None)
            if resumed is not None:
                self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=180)
                wire.drain(2.0)
            return self.raw_trace(wire)
        finally:
            wire.close()

    def flow_abort_ownership(self) -> list:
        """The abort of session A does not kill or corrupt session B."""
        work = self.root / "work-o"
        work.mkdir()
        self.queue_script(
            [
                {"toolCall": {"name": "ipython", "arguments": {"code": "import time\ntime.sleep(120)\nprint('ownership cell')"}}},
                {"text": "A recovered"},
            ],
            extra_queues=[
                {
                    "name": "session-b",
                    "match": ["session b own task"],
                    "responses": [{"text": "B completed its own turn"}],
                }
            ],
        )
        wire = B.Wire(self.sock)
        try:
            created_a = wire.request("o-create-a", {"type": "create", "config": {"cwd": str(work), "model": "mock-1", "sessionDir": str(self.agent / "sessions")}})
            created_b = wire.request("o-create-b", {"type": "create", "config": {"cwd": str(work), "model": "mock-1", "sessionDir": str(self.agent / "sessions")}})
            assert created_a.get("success") is True and created_b.get("success") is True
            sid_a = created_a["data"]["id"]
            sid_b = created_b["data"]["id"]
            wire.request("o-attach-a", {"type": "attach", "activeSessionId": sid_a})
            # A second client attached to B: session events are per-session.
            wire_b = B.Wire(self.sock)
            try:
                wire_b.request("o-attach-b", {"type": "attach", "activeSessionId": sid_b})
                prompt_a = wire.request("o-prompt-a", {"type": "prompt", "activeSessionId": sid_a, "message": PROMPT})
                assert prompt_a.get("success") is True
                # A's kernel cell is live before the steer parks and the
                # abort lands (the abort must interrupt the running cell,
                # not a provider wait).
                a_cell = self.wait_event(wire, lambda ev: ev.get("type") == "tool_execution_start", timeout=240)
                self.record("session A's kernel cell started", a_cell is not None)
                # A parks a steer; B starts its own turn.
                parked = wire.request("o-steer-a", {"type": "steer", "activeSessionId": sid_a, "message": "steer for session a"})
                self.record("session A parked a steer behind its busy turn", parked.get("success") is True)
                prompt_b = wire_b.request("o-prompt-b", {"type": "prompt", "activeSessionId": sid_b, "message": "session b own task"})
                self.record("session B admitted its own prompt", prompt_b.get("success") is True)
                # Abort A mid-cell: B is unaffected, A's parked steer survives.
                abort_a = wire.request("o-abort-a", {"type": "abort", "activeSessionId": sid_a})
                self.record("session A aborted mid-cell", abort_a.get("success") is True)
                b_done = self.wait_event(wire_b, lambda ev: ev.get("type") == "message_end" and "B completed its own turn" in json.dumps(ev.get("message") or {}), timeout=240)
                self.record("session B's own turn ran to completion despite A's abort", b_done is not None)
                a_settled = self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=60)
                self.record("session A's aborted turn settled", a_settled is not None)
            finally:
                wire_b.close()
            # A's queued steer survived the abort: a resume delivers it.
            resume = wire.request("o-resume-a", {"type": "steer", "activeSessionId": sid_a, "message": "resume session a"})
            self.record("the resume steer admitted on A", resume.get("success") is True)
            a_steered = self.wait_event(wire, lambda ev: ev.get("type") == "message_start" and "steer for session a" in json.dumps(ev.get("message") or {}), timeout=180)
            self.record("A's parked steer survived the abort and delivered after the resume", a_steered is not None)
            # Drain past the delivery's settle (the cleared projection and
            # the run's terminal frames arrive after the agent_end).
            if a_steered is not None:
                self.wait_event(wire, lambda ev: ev.get("type") == "agent_end", timeout=180)
                wire.drain(2.0)
            return self.raw_trace(wire)
        finally:
            wire.close()


def run_side(name: str, binary: str, out: Path) -> int:
    side = Side(name, binary, out)
    traces = {}
    try:
        side.start_daemon()
        traces["queue-delivery"] = side.flow_queue_delivery()
        side.evidence("trace-queue-delivery.json", json.dumps(traces["queue-delivery"], indent=1))
        side.stop_daemon()
        side = Side(name, binary, out, steering_mode="all")
        side.start_daemon()
        traces["batch-delivery"] = side.flow_batch_delivery()
        side.evidence("trace-batch-delivery.json", json.dumps(traces["batch-delivery"], indent=1))
        side.stop_daemon()
        side = Side(name, binary, out)
        side.start_daemon()
        traces["abort-settle"] = side.flow_abort_settle()
        side.evidence("trace-abort-settle.json", json.dumps(traces["abort-settle"], indent=1))
        side.stop_daemon()
        side = Side(name, binary, out)
        side.start_daemon()
        traces["abort-ownership"] = side.flow_abort_ownership()
        side.evidence("trace-abort-ownership.json", json.dumps(traces["abort-ownership"], indent=1))
    finally:
        try:
            side.stop_daemon()
        except Exception:
            pass
    side.evidence("summary.json", json.dumps(side.all_findings, indent=1))
    total = side.all_findings
    failed = [f for f in total if not f["ok"]]
    print(f"{name}: {len(total) - len(failed)}/{len(total)} steps ok (all flows)")
    return 1 if failed else 0


def run_diff(out: Path) -> int:
    failed = 0
    for flow in ("queue-delivery", "batch-delivery", "abort-settle", "abort-ownership"):
        ts_path = out / "ts" / f"trace-{flow}.json"
        rust_path = out / "rust" / f"trace-{flow}.json"
        if not ts_path.exists() or not rust_path.exists():
            print(f"diff {flow}: missing side traces (run both --side invocations first)")
            failed += 1
            continue
        def norm(raw):
            out = []
            for ev in raw:
                if ev.get("type") not in COMPARED_TYPES:
                    continue
                frame = normalize_event(ev)
                # Streaming pacing (message_update deltas) and the
                # session-start harness digest are content noise, not the
                # queue/abort surface: they drop from the compared trace.
                if frame["type"] == "message_update":
                    continue
                if frame.get("role") == "custom" or frame.get("customType"):
                    continue
                out.append(frame)
            # Collapse consecutive identical frames (repeat updates).
            collapsed = []
            for frame in out:
                if collapsed and collapsed[-1] == frame:
                    continue
                collapsed.append(frame)
            return collapsed

        ts = norm(json.loads(ts_path.read_text()))
        rust = norm(json.loads(rust_path.read_text()))
        # The interleaving of queue projections and run frames is a TS
        # event-queue race (a mid-run admission projects after the run's
        # queued frames on one TS run, mid-run on another), so the byte
        # compare splits the trace into the queue-projection sequence and
        # the run-frame sequence and compares each in order; the phase
        # assertions in the side runs pin the pickup-before-agent_start
        # ordering that is deterministic.
        def split(frames):
            projections = [f for f in frames if f["type"] == "session_action_update"]
            runs = [f for f in frames if f["type"] != "session_action_update"]
            return projections, runs

        ts_proj, ts_runs = split(ts)
        rust_proj, rust_runs = split(rust)
        if ts_proj == rust_proj and ts_runs == rust_runs:
            print(f"diff {flow}: MATCHES ({len(ts_runs)} run frames, {len(ts_proj)} projections)")
        else:
            failed += 1
            if ts_proj != rust_proj:
                print(f"diff {flow}: PROJECTIONS DIFFER (ts {len(ts_proj)}, rust {len(rust_proj)})")
            if ts_runs != rust_runs:
                print(f"diff {flow}: RUN FRAMES DIFFER (ts {len(ts_runs)}, rust {len(rust_runs)})")
            import difflib
            for label, a, b in (
                ("projections", ts_proj, rust_proj),
                ("run-frames", ts_runs, rust_runs),
            ):
                if a == b:
                    continue
                a_lines = json.dumps(a, indent=1).splitlines()
                b_lines = json.dumps(b, indent=1).splitlines()
                diff_lines = list(difflib.unified_diff(a_lines, b_lines, f"ts-{label}", f"rust-{label}", lineterm=""))
                for line in diff_lines[:50]:
                    print(line)
                (out / f"diff-{flow}-{label}.txt").write_text("\n".join(diff_lines))
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", choices=["rust", "ts"], default=None)
    parser.add_argument("--diff", action="store_true", help="byte-compare both sides' normalized traces")
    parser.add_argument("--binary", default=None)
    parser.add_argument("--out", default=str(REPO / "scripts" / "steer-queue-runs"))
    args = parser.parse_args()
    out = Path(args.out)
    if args.diff:
        return run_diff(out)
    if not args.side:
        parser.error("choose --side rust|ts or --diff")
    binary = args.binary or (
        str(REPO / "target" / "debug" / "pa-daemon") if args.side == "rust" else "prime-agent"
    )
    return run_side(args.side, binary, out)


if __name__ == "__main__":
    raise SystemExit(main())
