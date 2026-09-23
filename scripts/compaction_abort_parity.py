#!/usr/bin/env python3
"""Compaction-abort wire parity verifier (TS vs Rust): abort_compaction
on an in-flight AUTOMATIC threshold compaction.

Both sides run the identical daemon flow over the shared battery mock
provider (the f14-auto battery shape: one mock-reported 126k-usage turn
crosses the 500-token reserve headroom, the summarizer request is held
open by a scripted delayMs, and `abort_compaction` cancels it mid-flight):

  1. the `compaction_start` (threshold) broadcast,
  2. the durable `compaction_outcome` row broadcast as its
     `message_start`/`message_end` pair with the `cancelled` outcome and
     the `Compaction cancelled` disclosure,
  3. the `aborted` `compaction_end` (no errorMessage, no errorSeverity,
     no result),
  4. the durable session-file row and the absence of a committed
     compaction entry (TS `_runAutoCompaction`'s aborted arm ->
     `_endCompactionUnsuccessfully`).

Volatile fields (timestamps, ids, sequences, socket paths) are normalized
away; the two sides' captures are printed side by side and the exit code
is non-zero on any shape or content diff. Evidence is written under
scripts/battery/runs/<stamp>-compaction-abort/<side>/.
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "battery"))
import batterylib as B  # noqa: E402
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

REPO = Path(__file__).resolve().parents[1]

# The volatile fields stripped from wire events and durable rows before
# the diff (per-run identity, ordering metadata, timing).
VOLATILE = ("timestamp", "id", "parentId", "sessionId", "activeSessionId",
            "sequence", "meta", "generation", "createdAt", "updatedAt")

SUMMARIZER_MARKER = "context summarization assistant"

SEED_REPLY = "abort parity seed reply"
CROSSING_REPLY = "abort parity crossing reply"
# The held summarizer: delayMs keeps the request open long enough for the
# abort to land mid-flight on both sides (the dropped request kills the
# mock connection; the mock thread exits on its failed write).
HELD_SUMMARY = {"text": "the aborted parity summary", "delayMs": 25000}

CROSSING_USAGE = {
    "prompt_tokens": 126000,
    "completion_tokens": 10,
    "total_tokens": 126010,
    "prompt_tokens_details": {"cached_tokens": 80},
}


def normalize(value):
    """Recursively drop volatile keys and scrub volatile strings."""
    if isinstance(value, dict):
        return {
            k: normalize(v)
            for k, v in value.items()
            if k not in VOLATILE
        }
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, str):
        # Session ids and ports leak into strings only through fields that
        # are already dropped; nothing else in the capture is volatile.
        return value
    return value


def relevant_event(event: dict) -> dict | None:
    """The compaction-related session events, normalized."""
    if event.get("type") == "compaction_start":
        return normalize(event)
    if event.get("type") == "compaction_end":
        return normalize(event)
    if event.get("type") in ("message_start", "message_end"):
        message = event.get("message", {})
        if message.get("customType") == "compaction_outcome":
            return {"type": event["type"], "message": normalize(message)}
    return None


def durable_rows(side: B.Side) -> dict:
    """The compaction rows in the side's durable session file."""
    for path in side.session_files():
        text = path.read_text(errors="replace")
        if "compaction_outcome" not in text and '"compaction"' not in text:
            continue
        rows = []
        compaction_entries = 0
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "custom_message" and entry.get("customType") == "compaction_outcome":
                rows.append(normalize(entry))
            if entry.get("type") == "compaction":
                compaction_entries += 1
        if rows or compaction_entries:
            return {"outcome_rows": rows, "compaction_entries": compaction_entries}
    return {"outcome_rows": [], "compaction_entries": 0}


def read_response_for(wire: B.Wire, command_id: str, timeout: float = 120.0) -> dict:
    """Read lines until the response for `command_id` (command already sent)."""
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError(f"no response for command {command_id}")
        line = wire.read_line(timeout=remaining)
        if line.get("id") == command_id:
            return line
        wire.events.append(line)


def run_side(name: str, binary: str, root: Path) -> dict:
    """Run the abort flow on one side; returns the normalized capture."""
    root.mkdir(parents=True, exist_ok=True)
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    if agent.exists():
        import shutil
        shutil.rmtree(agent)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    # The mock process reads the script file at startup (the battery's
    # make_side order): write one response before starting.
    mock.set_responses([{"text": SEED_REPLY}])
    mock.start()
    tmpdir = Path("/tmp") / f"compaction-abort-{name}-{os.getpid()}"
    if tmpdir.exists():
        import shutil
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
    if name == "rust":
        side.env["PI_PACKAGE_DIR"] = str(REPO)
    side.env["PRIME_API_KEY"] = "sk-battery"
    side.write_models_json()
    # The f14-auto battery settings shape: the mock-reported 126k usage
    # crosses on both products (TS at window - reserve = 123904, Rust at
    # the combined input+output ceiling 128000 - 4096 - 4096 = 119808),
    # and a tiny keep-recent budget keeps the seeded turns summarizable.
    (agent / "settings.json").write_text(json.dumps(
        {"compaction": {"enabled": True, "reserveTokens": 4096, "keepRecentTokens": 10}}
    ))
    capture: dict = {}
    try:
        side.start_daemon()
        wire = B.Wire(side.daemon_socket)
        created = wire.request(
            "c1",
            {
                "type": "create",
                "name": f"compaction-abort-{name}",
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
        if created.get("success") is not True:
            raise RuntimeError(f"create failed: {json.dumps(created)[:400]}")
        session_id = (created.get("data", {}).get("activeSessionId")
                      or created.get("data", {}).get("id") or "")

        # Attach the wire so the session's broadcast events flow to this
        # connection (the daemon only broadcasts to attached clients).
        attached = wire.request(
            "a1",
            {"type": "attach", "activeSessionId": session_id},
            timeout=120,
        )
        if attached.get("success") is not True:
            raise RuntimeError(f"attach failed: {json.dumps(attached)[:400]}")

        # Seed turn (small usage): the threshold stays silent.
        mock.set_responses([
            {"text": SEED_REPLY},
            {"text": CROSSING_REPLY, "usage": CROSSING_USAGE},
            dict(HELD_SUMMARY),
        ])
        seeded = wire.request(
            "p1",
            {"type": "prompt_and_wait", "activeSessionId": session_id,
             "message": "abort parity seed turn"},
            timeout=240,
        )
        if seeded.get("success") is not True:
            raise RuntimeError(f"seed prompt failed: {json.dumps(seeded)[:400]}")

        # The crossing turn fires the threshold compaction; its summarizer
        # request is held open by the scripted delay.
        seed_requests = len(mock.requests())
        wire.send_command(
            "p2",
            {"type": "prompt_and_wait", "activeSessionId": session_id,
             "message": "abort parity crossing turn"},
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            new_requests = mock.requests()[seed_requests:]
            if any(
                SUMMARIZER_MARKER in json.dumps(body)
                for body in new_requests
            ):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError(f"{name}: the compaction summarizer request never arrived")

        # Abort the in-flight compaction over the daemon wire (a second
        # connection, exactly like the TUI interrupt key's fire-and-forget
        # abort_compaction).
        abort_wire = B.Wire(side.daemon_socket)
        aborted = abort_wire.request(
            "ab1",
            {"type": "abort_compaction", "activeSessionId": session_id},
            timeout=120,
        )
        capture["abort_response"] = {
            "success": aborted.get("success"),
            "command": aborted.get("command"),
            "has_data": "data" in aborted,
        }

        # The turn completes after the cancelled compaction.
        crossed = read_response_for(wire, "p2", timeout=120)
        capture["prompt_response"] = {"success": crossed.get("success")}
        wire.drain(3.0)
        abort_wire.drain(1.0)

        # wire.events holds full frames; extract the event payloads.
        events = []
        for frame in wire.events + abort_wire.events:
            if frame.get("type") == "session_event":
                kept = relevant_event(frame.get("event", {}))
                if kept is not None:
                    events.append(kept)
        capture["events"] = events
        capture["durable"] = durable_rows(side)
    finally:
        side.stop_daemon()
        mock.stop()
        import shutil
        if tmpdir.exists():
            shutil.rmtree(tmpdir, ignore_errors=True)
    # Evidence for the run.
    evidence = root / "capture.json"
    evidence.write_text(json.dumps(capture, indent=1))
    return capture


def main() -> int:
    ts_binary = os.environ.get("PA_PARITY_TS", "prime-agent")
    rust_binary = os.environ.get(
        "PA_PARITY_RUST", str(REPO / "target" / "release" / "prime-agent")
    )
    # The run root must keep the daemon-socket path under the 107-char
    # AF_UNIX limit (the battery's own stamp run dirs fit with one side
    # directory of margin): a short `-abort` suffix, no more.
    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    ts_identity.assert_ts_side_is_the_ts_product(ts_binary, rust_binary)
    # Fail fast on a stale rust build: a binary older than the checkout's
    # newest product commit reproduces "summarizer request never arrived"
    # class false failures (the 20260920 main run: the checkout's binary
    # predated the auto-compaction merge).
    stale = B.rust_binary_staleness(Path(rust_binary), REPO)
    if stale:
        print(f"[parity] STALE RUST BINARY: {stale}")
        return 2
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run_root = REPO / "scripts" / "battery" / "runs" / f"{stamp}-abort"
    print(f"[parity] run root: {run_root}")
    ts = run_side("ts", ts_binary, run_root / "ts")
    print(f"[parity] ts capture: {json.dumps(ts)[:200]}...")
    rust = run_side("rust", rust_binary, run_root / "rust")
    print(f"[parity] rust capture: {json.dumps(rust)[:200]}...")

    ok = True
    if ts != rust:
        ok = False
        print("[parity] DIFF: the two sides' captures differ")
        for key in sorted(set(ts) | set(rust)):
            if ts.get(key) != rust.get(key):
                print(f"--- {key} ts ----\n{json.dumps(ts.get(key), indent=1)}")
                print(f"--- {key} rust ----\n{json.dumps(rust.get(key), indent=1)}")
    else:
        print("[parity] OK: TS and Rust captures are identical after normalization")
    print(f"[parity] exit {'0' if ok else '1'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
