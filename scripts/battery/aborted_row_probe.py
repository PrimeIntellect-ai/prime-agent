"""Ground-truth probe for the terminal turn_end frame + the aborted-turn
row (lanes turn-end-frame / aborted-row): what each side's daemon
broadcasts + persists when a turn settles normally, when it is aborted
mid-provider-wait (plain `abort`), and what the compact abort shows. The
`turn_end` frames are captured raw per side and compared cross-side
(timestamps normalized) — settled and aborted turns alike."""
import json, os, sys, time, shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batterylib as B

RUN = Path("/tmp/aborted-row-probe")

def make_side(name: str, binary: str) -> B.Side:
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
    tmpdir = Path("/tmp") / f"abrt-probe-{name}"
    if tmpdir.exists():
        shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side = B.Side(name=name, binary=binary, root=root, agent_dir=agent,
                  work_dir=work, daemon_socket=root / "daemon.sock", mock=mock)
    side.env = B.scrubbed_env(agent, tmpdir, {"PRIME_DISABLE_AUTO_COMPACTION": "1"})
    side.write_models_json()
    return side

def turn_end_frames(frames: list[dict]) -> list[dict]:
    """The `turn_end` session events, raw event payloads in arrival order."""
    out = []
    for frame in frames:
        event = frame.get("event") or {}
        if event.get("type") == "turn_end":
            out.append(event)
    return out

def normalize_turn_end(event: dict) -> dict:
    """The volatile-free form compared cross-side: wire envelope metadata
    and the message timestamp differ per side, everything else must
    byte-match (the terminal message shape, the toolResults list)."""
    event = json.loads(json.dumps(event))
    message = event.get("message")
    if isinstance(message, dict):
        message.pop("timestamp", None)
    return event

def probe(side: B.Side, abort_command: dict | None, key: str) -> None:
    # The settled case consumes the immediate reply; the abort cases hold
    # the turn mid-provider-wait (the 15s delay) — each side is fresh, so
    # the queue holds exactly the one reply the case needs first.
    reply = (
        {"text": "settled reply", "delayMs": 0}
        if abort_command is None
        else {"text": "held reply", "delayMs": 15000}
    )
    side.mock.set_responses(
        [{"text": "statusline filler"}],
        queues=[{
            "name": "aborted-row-probe",
            "matchModels": ["mock-1"],
            "responses": [reply],
        }],
    )
    side.start_daemon()
    wire = B.Wire(side.daemon_socket)
    create = wire.request("c1", {
        "type": "create", "name": f"aborted-row-probe-{key}",
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
    prompt = wire.request("p1", {
        "type": "prompt", "activeSessionId": session_id,
        "message": "held turn for the abort probe" if abort_command else
                   "settled turn for the frame probe",
    }, timeout=60)
    if abort_command:
        time.sleep(0.8)  # mid-provider-wait (the 15s hold)
        # The close command itself must answer on the CANCELLED turn: TS
        # `closeSessionOnce` fires `session.abort()` (the run cancel) before
        # any close work that can wait on the turn, so the reply lands far
        # inside the 15s hold (a kill that streams the held reply out first
        # is the #247 residue: the abort landed only after the turn settled
        # naturally).
        command_started = time.monotonic()
        abort = wire.request("ab1", dict(abort_command, activeSessionId=session_id), timeout=120)
        command_seconds = time.monotonic() - command_started
    else:
        abort, command_seconds = {"success": True}, 0.0
    idle = wire.request("w1", {"type": "wait_for_idle", "activeSessionId": session_id}, timeout=120)
    attacher.drain(2.0)
    rows = []
    for frame in attacher.events:
        ev = frame.get("event") or {}
        if ev.get("type") in ("message_start", "message_end", "message_update", "turn_end", "agent_end"):
            m = ev.get("message") or {}
            rows.append({
                "wire": ev.get("type"),
                "role": m.get("role"),
                "stopReason": m.get("stopReason"),
                "errorMessage": m.get("errorMessage"),
                "text": (m.get("content") if isinstance(m.get("content"), str) else
                         "".join(p.get("text", "") for p in (m.get("content") or []) if isinstance(p, dict))),
            })
    (side.root / f"{key}-wire-events.json").write_text(json.dumps(rows, indent=1))
    (side.root / f"{key}-raw-frames.json").write_text(json.dumps(attacher.events, indent=1))
    turn_ends = [normalize_turn_end(event) for event in turn_end_frames(attacher.events)]
    (side.root / f"{key}-turn-end-frames.json").write_text(json.dumps(turn_ends, indent=1))
    (side.root / f"{key}-timing.json").write_text(json.dumps({
        "command": (abort_command or {}).get("type"),
        "command_seconds": round(command_seconds, 3),
        "hold_seconds": 0 if not abort_command else 15,
    }, indent=1))
    # the durable store
    store_rows = []
    for path in side.session_files():
        for line in path.read_text().splitlines():
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("type") == "message":
                m = entry.get("fields", {}).get("message") or entry.get("message") or {}
                store_rows.append({
                    "role": m.get("role"),
                    "stopReason": m.get("stopReason"),
                    "errorMessage": m.get("errorMessage"),
                })
    (side.root / f"{key}-store-rows.json").write_text(json.dumps(store_rows, indent=1))
    print(f"[{side.name}/{key}] abort={abort.get('success')} idle={idle.get('success')} "
          f"command_seconds={command_seconds:.2f}")
    print(f"[{side.name}/{key}] wire: {json.dumps(rows)[:600]}")
    print(f"[{side.name}/{key}] turn_ends: {json.dumps(turn_ends)[:600]}")
    print(f"[{side.name}/{key}] store: {json.dumps([r for r in store_rows if r.get('role') == 'assistant'])[:600]}")
    attacher.close()
    wire.close()
    side.stop_daemon()

def compare(key: str, sides: list[str]) -> bool:
    """Byte-compare the normalized `turn_end` frames cross-side for one
    case: settled and aborted turns must carry the same terminal payload
    (the terminal/aborted assistant message and the toolResults list)."""
    captures = {}
    for name in sides:
        path = RUN / f"{name}-{key}" / f"{key}-turn-end-frames.json"
        if path.exists():
            captures[name] = json.loads(path.read_text())
    if len(captures) < 2:
        print(f"[compare/{key}] missing sides: {sorted(captures)}")
        return False
    ts, rust = captures["ts"], captures["rust"]
    if ts == rust:
        print(f"[compare/{key}] turn_end frames MATCH ({len(ts)} frame(s))")
        print(f"[compare/{key}] ts:   {json.dumps(ts)[:400]}")
        return True
    print(f"[compare/{key}] turn_end frames DIFFER")
    print(f"[compare/{key}] ts:   {json.dumps(ts)[:800]}")
    print(f"[compare/{key}] rust: {json.dumps(rust)[:800]}")
    return False

def main():
    ts_bin = "prime-agent"
    rust_bin = os.environ.get(
        "ABORTED_ROW_RUST_BIN",
        "/home/ubuntu/lane-worktrees/aborted-row/target/release/prime-agent",
    )
    cases = [
        ("settled", None),
        ("abort", {"type": "abort"}),
        ("compact", {"type": "compact"}),
        ("kill", {"type": "kill"}),
        ("abort_and_clear_queue", {"type": "abort_and_clear_queue"}),
    ]
    sides = [
        name
        for name in os.environ.get("ABORTED_ROW_SIDES", "ts,rust").split(",")
        if name
    ]
    binaries = {"ts": ts_bin, "rust": rust_bin}
    for name, binary in binaries.items():
        if name not in sides:
            continue
        for key, command in cases:
            side = make_side(f"{name}-{key}", binary)
            try:
                probe(side, command, key)
            finally:
                side.stop_daemon()
    if "ts" in sides and "rust" in sides:
        ok = True
        for key, _ in cases:
            ok = compare(key, sides) and ok
        print("[compare] " + ("ALL turn_end frames MATCH" if ok else "DIFFERENCES FOUND"))
        sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
