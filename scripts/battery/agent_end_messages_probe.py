"""Ground-truth probe for the agent_end messages payload (lane
agent-end-messages): what each side's daemon broadcasts on the wire for
the run-boundary frames of one turn - the `agent_end` frames' `messages`
payloads (TS `agent_end` carries the run's whole message set, one frame
per agent run), plus the per-run `agent_start`/`turn_start` frames that
retried and continued runs restart with.

Cases (each side fresh, one turn each):
  - settled:  a plain turn that settles normally - one agent run whose
              agent_end carries the harness-digest row, the accepted
              user row, and the settled assistant row.
  - retried:  a retryable provider failure (HTTP 500) then a success -
              two agent runs; the failed run's agent_end carries the
              accepted rows plus the failed assistant row, the retry
              re-opens with its own agent_start/turn_start, and its
              agent_end carries only the retry's messages.
  - continued: a context-overflow error (HTTP 400) then a success - the
              compact-and-retry recovery: the overflow run ends with its
              agent_end, the compaction runs, and the re-issued
              continuation run re-opens with its own frames and its own
              agent_end payload.

The `agent_end` frames are captured raw per side and compared cross-side
(timestamps normalized) - frame count, frame order, and every payload
byte must match.
"""
import json, os, sys, time, shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batterylib as B

RUN = Path("/tmp/agent-end-messages-probe")

# The overflow error text the TS `isContextOverflow` and the Rust
# `is_context_overflow` classifiers both match (the mock-provider
# documented scripted overflow shape).
OVERFLOW_ERROR = "prompt is too long: 213462 tokens > 200000 maximum"


def make_side(name: str, binary: str, retry_settings: bool, compact_settings: bool) -> B.Side:
    root = RUN / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "statusline filler"}])
    mock.start()
    tmpdir = Path("/tmp") / f"agent-end-probe-{name}"
    if tmpdir.exists():
        shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side = B.Side(name=name, binary=binary, root=root, agent_dir=agent,
                  work_dir=work, daemon_socket=root / "daemon.sock", mock=mock)
    side.env = B.scrubbed_env(agent, tmpdir)
    side.write_models_json()
    settings = {}
    if retry_settings:
        # Small retry delays so the retried case settles fast on both
        # sides (TS `retry.baseDelayMs` / the Rust `retry.baseDelayMs`).
        settings["retry"] = {"enabled": True, "maxRetries": 2, "baseDelayMs": 100}
    if compact_settings:
        # The overflow recovery's compaction needs a cut point: the tiny
        # keep-recent tail lets the short probe session compact instead of
        # skipping ("Session is too short to compact").
        settings["compaction"] = {"keepRecentTokens": 10}
    if settings:
        (agent / "settings.json").write_text(json.dumps(settings))
    return side


def agent_end_frames(frames: list[dict]) -> list[dict]:
    """The `agent_end` session events, raw event payloads in arrival order."""
    out = []
    for frame in frames:
        event = frame.get("event") or {}
        if event.get("type") == "agent_end":
            out.append(event)
    return out


def normalize(value):
    """Strip the volatile fields cross-side: message timestamps (and the
    diagnostics' timestamps) and the JS `stack` traces inside
    provider_stream_failure diagnostics (a bun binary path trace the Rust
    side structurally never has); everything else must byte-match."""
    if isinstance(value, dict):
        return {
            key: normalize(item)
            for key, item in value.items()
            if key not in ("timestamp", "stack")
        }
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def frame_fingerprint(frames: list[dict]) -> list[str]:
    """The run-boundary frame sequence (type + payload presence), so the
    probe diff also catches a missing/extra per-run frame, not just the
    payloads."""
    out = []
    for frame in frames:
        event = frame.get("event") or {}
        etype = event.get("type")
        # `auto_retry_*` is deliberately excluded: the retry driver's
        # `auto_retry_end` ordering (TS resets at the successful
        # message_end hook, before the retry run's turn_end; the Rust
        # retry driver closes it after the attempt boundary) is a known
        # pre-existing divergence owned by the provider-retry surface, not
        # the run-boundary frames this probe locks.
        if etype in ("agent_start", "turn_start", "turn_end", "agent_end",
                     "compaction_start", "compaction_end"):
            if etype == "turn_end":
                message = event.get("message") or {}
                out.append(f"turn_end:{message.get('stopReason')}")
            elif etype == "agent_end":
                roles = [
                    message.get("role")
                    for message in (event.get("messages") or [])
                ]
                out.append("agent_end:" + ",".join(roles))
            else:
                out.append(str(etype))
    return out


def probe(side: B.Side, key: str, responses: list[dict], timeout: float) -> None:
    side.mock.set_responses(
        [{"text": "statusline filler"}],
        queues=[{
            "name": "agent-end-probe",
            "matchModels": ["mock-1"],
            "responses": responses,
        }],
    )
    side.start_daemon()
    wire = B.Wire(side.daemon_socket)
    create = wire.request("c1", {
        "type": "create", "name": f"agent-end-probe-{key}",
        "config": {
            "cwd": str(side.work_dir),
            "sessionDir": str(side.agent_dir / "sessions"),
            "provider": "prime-inference",
            "model": "mock-1",
            "executionMode": "print",
        },
    }, timeout=120)
    session_id = create.get("data", {}).get("activeSessionId") or create.get("data", {}).get("id")
    attacher = B.Wire(side.daemon_socket)
    attacher.request("a1", {"type": "attach", "activeSessionId": session_id}, timeout=60)
    attacher.events.clear()
    if key == "continued":
        # The compact-and-retry recovery needs compaction material: a long
        # first turn fills the session so the overflow arm's compaction
        # runs instead of skipping ("Session is too short to compact").
        wire.request("filler", {
            "type": "prompt", "activeSessionId": session_id,
            "message": "context filler turn for the continued probe",
        }, timeout=60)
        wire.request("w0", {"type": "wait_for_idle", "activeSessionId": session_id}, timeout=timeout)
    wire.request("p1", {
        "type": "prompt", "activeSessionId": session_id,
        "message": f"{key} turn for the agent end probe",
    }, timeout=60)
    idle = wire.request("w1", {"type": "wait_for_idle", "activeSessionId": session_id}, timeout=timeout)
    print(f"[{side.name}/{key}] idle={idle.get('success')}")
    attacher.drain(3.0)
    (side.root / f"{key}-raw-frames.json").write_text(json.dumps(attacher.events, indent=1))
    (side.root / f"{key}-agent-end-frames.json").write_text(
        json.dumps([normalize(event) for event in agent_end_frames(attacher.events)], indent=1)
    )
    fingerprint = frame_fingerprint(attacher.events)
    (side.root / f"{key}-boundary-fingerprint.json").write_text(json.dumps(fingerprint, indent=1))
    print(f"[{side.name}/{key}] boundary: {json.dumps(fingerprint)}")
    print(f"[{side.name}/{key}] agent_ends: "
          f"{json.dumps([normalize(e) for e in agent_end_frames(attacher.events)])[:900]}")
    attacher.close()
    wire.close()
    side.stop_daemon()


def compare(key: str) -> bool:
    """Byte-compare the normalized `agent_end` frames and the boundary
    frame sequence cross-side for one case."""
    captures = {}
    for name in ("ts", "rust"):
        path = RUN / f"{name}-{key}" / f"{key}-agent-end-frames.json"
        if path.exists():
            captures[name] = json.loads(path.read_text())
    if len(captures) < 2:
        print(f"[compare/{key}] missing sides: {sorted(captures)}")
        return False
    ok = True
    if captures["ts"] == captures["rust"]:
        print(f"[compare/{key}] agent_end frames MATCH ({len(captures['ts'])} frame(s))")
        for frame in captures["ts"]:
            print(f"[compare/{key}]   payload roles: "
                  f"{[m.get('role') for m in frame.get('messages', [])]}")
    else:
        ok = False
        print(f"[compare/{key}] agent_end frames DIFFER")
        print(f"[compare/{key}] ts:   {json.dumps(captures['ts'])[:900]}")
        print(f"[compare/{key}] rust: {json.dumps(captures['rust'])[:900]}")
    fingerprints = {}
    for name in ("ts", "rust"):
        path = RUN / f"{name}-{key}" / f"{key}-boundary-fingerprint.json"
        if path.exists():
            fingerprints[name] = json.loads(path.read_text())
    if fingerprints.get("ts") == fingerprints.get("rust"):
        print(f"[compare/{key}] boundary sequence MATCH: {json.dumps(fingerprints.get('ts'))}")
    else:
        ok = False
        print(f"[compare/{key}] boundary sequence DIFFER")
        print(f"[compare/{key}] ts:   {json.dumps(fingerprints.get('ts'))}")
        print(f"[compare/{key}] rust: {json.dumps(fingerprints.get('rust'))}")
    return ok


def main():
    ts_bin = "prime-agent"
    rust_bin = os.environ.get(
        "AGENT_END_RUST_BIN",
        "/home/ubuntu/lane-worktrees/agent-end-messages/target/release/prime-agent",
    )
    cases = [
        # key, mock responses (served in order, last replays), retry settings, idle timeout
        ("settled", [{"text": "settled reply"}], False, False, 120),
        ("retried", [{"error": "mock provider overloaded", "status": 500},
                     {"text": "recovered reply"}], True, False, 180),
        ("continued", [
            {"text": "history filler " * 120},
            {"error": OVERFLOW_ERROR, "status": 400},
            {"text": "recovered after compaction reply"},
        ], False, True, 300),
    ]
    sides = [
        name
        for name in os.environ.get("AGENT_END_SIDES", "ts,rust").split(",")
        if name
    ]
    wanted = [
        name
        for name in os.environ.get("AGENT_END_CASES", "settled,retried,continued").split(",")
        if name
    ]
    cases = [case for case in cases if case[0] in wanted]
    binaries = {"ts": ts_bin, "rust": rust_bin}
    for name in sides:
        binary = binaries[name]
        for key, responses, retry_settings, compact_settings, timeout in cases:
            side = make_side(f"{name}-{key}", binary, retry_settings, compact_settings)
            try:
                probe(side, key, responses, timeout)
            finally:
                side.stop_daemon()
    if "ts" in sides and "rust" in sides:
        ok = True
        for key, _, _, _, _ in cases:
            ok = compare(key) and ok
        print("[compare] " + ("ALL agent_end frames MATCH" if ok else "DIFFERENCES FOUND"))
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
