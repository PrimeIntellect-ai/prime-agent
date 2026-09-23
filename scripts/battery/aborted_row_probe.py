"""Ground-truth probe for the terminal turn_end frame + the aborted-turn
row (lanes turn-end-frame / aborted-row): what each side's daemon
broadcasts + persists when a turn settles normally, when it is aborted
mid-provider-wait (plain `abort`), when one parked steering message is
delivered by the interrupt (`abort_and_send_queued`, schema 29), and what
the compact abort shows. The `turn_end` frames are captured raw per side
and compared cross-side (timestamps normalized) — settled and aborted
turns alike."""
import glob
import json, os, sys, time, shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batterylib as B
import ts_identity  # noqa: E402  (the shared binary-identity guard)

RUN = Path("/tmp/aborted-row-probe")


def default_ts_binary() -> str:
    """The ts side's launch command (the rules queue_edit_parity.py
    established): the box PATH `prime-agent` may itself be the Rust
    dogfood install, and the deployed 0.9.5 release predates schema 29
    (abortAndSendQueued, TS PR #2426, never reached it), so the probe
    compares against the TS-main bundle from the parity checkout.
    PA_TS_BINARY overrides (an absolute path or a full command string)."""
    override = os.environ.get("PA_TS_BINARY")
    if override:
        return override
    ts_main_cli = os.path.join(
        "/home/ubuntu/prime-agent", "packages", "coding-agent", "dist", "bundle", "cli.js"
    )
    if os.path.exists(ts_main_cli):
        return f"node {ts_main_cli}"
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = sorted(glob.glob(os.path.join(releases, "0.9.5-linux-x64-*", "prime-agent")))
    if not candidates:
        raise SystemExit("neither the TS-main checkout nor a deployed TS release found; set PA_TS_BINARY")
    return candidates[-1]


def ts_executable(command: str) -> str:
    """batterylib spawns `[binary, ...]` directly, so a node-bundle
    command needs a wrapper executable."""
    if " " not in command:
        return command
    RUN.mkdir(parents=True, exist_ok=True)
    wrapper = RUN / "ts-cli"
    wrapper.write_text(f"#!/bin/sh\nexec {command} \"$@\"\n")
    wrapper.chmod(0o755)
    return str(wrapper)

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
    # the queue holds exactly the one reply the case needs first. The
    # abort-and-send case parks one steering message before the interrupt
    # (the held reply cancels with the turn, the second reply answers the
    # delivered steering turn).
    reply = (
        {"text": "settled reply", "delayMs": 0}
        if abort_command is None
        else {"text": "held reply", "delayMs": 15000}
    )
    replies = [reply]
    if key == "abort_and_send_queued":
        replies.append({"text": "queued steering reply", "delayMs": 0})
    side.mock.set_responses(
        [{"text": "statusline filler"}],
        queues=[{
            "name": "aborted-row-probe",
            "matchModels": ["mock-1"],
            "responses": replies,
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
        if key == "abort_and_send_queued":
            # One steering message parked at the turn boundary, so the
            # interrupt aborts the held run AND delivers it (schema 29):
            # TS batches the armed steering into one new turn, the Rust
            # port runs it as its own boundary turn — the `turn_end`
            # payloads compared below must match either way.
            steer = wire.request("sq1", {
                "type": "steer", "activeSessionId": session_id,
                "message": "queued steering text",
            }, timeout=60)
            print(f"[{side.name}/{key}] steer queued: {steer.get('success')}")
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
    ts_command = default_ts_binary()
    # Fail fast before any launch: the probe's parity tables are only a
    # parity claim when the ts side is the TS product. The TS-main bundle
    # prints its version line to stderr: redirect it into the guard's
    # stdout probe (the queue_edit_parity rule).
    ts_identity.assert_ts_side_is_the_ts_product(f"{ts_command} 2>&1")
    ts_bin = ts_executable(ts_command)
    rust_bin = os.environ.get("ABORTED_ROW_RUST_BIN") or ts_identity.default_rust_binary()
    cases = [
        ("settled", None),
        ("abort", {"type": "abort"}),
        ("abort_and_send_queued", {"type": "abort_and_send_queued"}),
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
