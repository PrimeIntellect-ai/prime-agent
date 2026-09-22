#!/usr/bin/env python3
"""Wire parity battery for the update-prepare transaction (spec
`docs/update-flow-state-machine.md` §5/§7/§8): the TS binary and the Rust
binary side by side on the `prepare_update_restart`/`commit_update_restart`
daemon-command surface (slices 2-3).

What is compared (same command ids, same sockets, real daemons both sides):

  P1 baseline reads: `list_saved_sessions` on an empty agent dir — the
     response envelope must be byte-identical (canonical form).
  P2 the admission gate: a mutating `create` while a prepare is active —
     both products must answer with the TS message
     "Daemon is preparing an update restart" and the same failure shape.
  P3 reads stay served during the prepare window: `list_saved_sessions`
     again, identical to P1 on both sides.
  P4 user-visible invariant "a wedged update never wedges the daemon": the
     TS supervisor stays fenced after a stray `prepare_update_restart`
     (mutations refused indefinitely — the bug the spec kills); the Rust
     supervisor's deadline watchdog aborts it and serves mutations again.

Documented divergences (spec redesign, not regressions — each row is
asserted, reported, and explained):
  D1 `prepare_update_restart` without an `updateId`: TS accepts and runs the
     whole blocking restart flow; Rust requires the idempotency key.
  D2 `prepare_update_restart` with an `updateId`: TS ignores it and runs the
     blocking flow (success + manifest, sessions stop); Rust returns the
     prepare transaction's state (`prepared` + the marker `expiresAt`) and
     keeps serving.
  D3 a second `prepare_update_restart` with a different id while active:
     TS has no such window to stage (its gate refuses inside the blocking
     RPC); Rust answers with the TS string "Daemon is already preparing an
     update restart" plus the typed `update_prepare_refused` info.
  D4 `shutdown` during the window: TS exempts shutdown at `prepared`; Rust
     refuses it as a mutation (the coordinator owns the restart).

Phase 2 (slice 3, live session): the graceful-stop divergence with a real
resident session, same binaries, fresh daemons:

  E1 prepare vs the session's life: TS's blocking prepare returns the
     manifest AND stops the session (its worker is killed inside the RPC);
     Rust's prepare returns `prepared` with the session still serving
     (`get_state` answers) - invariant I3, graceful stops only at commit.
  E2 Rust `commit_update_restart`: success `{state: "stopping", stopped: N}`,
     the worker exits within budget, and the supervisor process exits for
     the update (the socket goes away).

Usage:
    python3 scripts/battery/update_prepare_wire.py \
        --rust-bin /abs/path/prime-agent [--ts-bin prime-agent] [--out DIR]

Exit code is non-zero when any parity row (P*/E*) mismatches.
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

FLOW = "update_prepare"
GATE_MESSAGE = "Daemon is preparing an update restart"
ALREADY_MESSAGE = "Daemon is already preparing an update restart"


def make_side(name: str, binary: str, root: Path, env_extra: dict) -> B.Side:
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "prepare-battery"}])
    mock.start()
    tmpdir = Path("/tmp") / f"upw-{name}"
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
    side.env = B.scrubbed_env(agent, tmpdir, env_extra)
    side.env["PRIME_API_KEY"] = "sk-battery"
    side.write_models_json()
    return side


def canon(line: dict) -> str:
    """Order-insensitive wire form: sorted keys, compact (JSON-equality)."""
    return json.dumps(line, sort_keys=True, separators=(",", ":"))


def run_empty_flow(side: B.Side) -> tuple[list[dict], dict[str, dict]]:
    """Drive one side; returns (raw response lines in order, by-command map)."""
    side.start_daemon()
    wire = B.Wire(side.daemon_socket)
    raw = []
    by_id = {}

    def step(command_id: str, command: dict, timeout: float = 60.0) -> dict:
        response = wire.request(command_id, command, timeout=timeout)
        raw.append(response)
        by_id[command_id] = response
        return response

    # P1 baseline read.
    step("s1", {"type": "list"})
    if side.name == "ts":
        # D1: TS accepts a bare prepare and runs the whole flow.
        step("s2", {"type": "prepare_update_restart"})
        # P2 gate: mutations refused while TS sits in its prepared phase.
        step("s3", {"type": "create", "cwd": str(side.work_dir)})
        # P3 reads stay served.
        step("s4", {"type": "list"})
        # P4 TS wedge: still refused long after any reasonable budget.
        time.sleep(5.0)
        step("s5", {"type": "create", "cwd": str(side.work_dir)})
        # D4: TS exempts shutdown at `prepared` — the daemon exits.
        step("s6", {"type": "shutdown"})
    else:
        # D1: Rust requires the idempotency key.
        step("s2", {"type": "prepare_update_restart"})
        # D2: prepare with an id reports the transaction state.
        step("s2b", {"type": "prepare_update_restart", "updateId": "upd-1"})
        # P2 gate: mutations refused while Fenced.
        step("s3", {"type": "create", "cwd": str(side.work_dir)})
        # P3 reads stay served.
        step("s4", {"type": "list"})
        # D3: a different id is a typed refusal.
        step("s2c", {"type": "prepare_update_restart", "updateId": "upd-2"})
        # D4: shutdown during the window is refused as a mutation (the
        # coordinator owns the restart), unlike TS's prepared exemption.
        step("s6b", {"type": "shutdown"})
        # P4 recovery: the deadline watchdog (3 s env override) aborts the
        # prepare and the supervisor serves mutations again.
        time.sleep(5.0)
        step("s5", {"type": "create", "cwd": str(side.work_dir)})
        # After recovery, shutdown is a plain mutation and succeeds.
        step("s6", {"type": "shutdown"})
    return raw, by_id


def session_id_of(create_response: dict) -> str | None:
    data = create_response.get("data") or {}
    for candidate in (data, data.get("session") or {}):
        if isinstance(candidate, dict) and candidate.get("activeSessionId"):
            return candidate["activeSessionId"]
    return None


def run_session_flow(side: B.Side) -> tuple[list[dict], dict[str, dict], str | None]:
    """Slice 3: one live session, then prepare (both) and commit (Rust)."""
    side.start_daemon()
    wire = B.Wire(side.daemon_socket)
    raw = []
    by_id = {}

    def step(command_id: str, command: dict, timeout: float = 60.0) -> dict:
        response = wire.request(command_id, command, timeout=timeout)
        raw.append(response)
        by_id[command_id] = response
        return response

    create = step("c1", {"type": "create", "cwd": str(side.work_dir)})
    session_id = session_id_of(create)
    if not session_id:
        raise RuntimeError(f"{side.name} create returned no activeSessionId: {create}")
    # The worker registers asynchronously; poll the roster until resident.
    deadline = time.time() + 30.0
    while time.time() < deadline:
        listing = step("ls1", {"type": "list"})
        sessions = ((listing.get("data") or {}).get("sessions")) or []
        if sessions:
            break
        time.sleep(0.5)
    if side.name == "ts":
        # TS prepare: the blocking flow returns the manifest AND stops the
        # session inside the RPC (spec §2's failure mode this redesign
        # kills - sessions die at prepare, not at commit).
        step("pre", {"type": "prepare_update_restart"})
        # E1: the session worker is gone.
        step("st1", {"type": "get_state", "activeSessionId": session_id})
        return raw, by_id, session_id
    # Rust prepare: a transaction to Prepared; the session keeps serving.
    step("pre", {"type": "prepare_update_restart", "updateId": "upd-live"})
    # E1: the session is still alive behind the gate.
    step("st1", {"type": "get_state", "activeSessionId": session_id})
    # E2: commit stops the worker and exits the supervisor.
    step("cm1", {"type": "commit_update_restart", "updateId": "upd-live"})
    return raw, by_id, session_id


def daemon_socket_alive(socket_path: Path) -> bool:
    import socket as socket_module

    try:
        with socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM) as probe:
            probe.settimeout(2.0)
            probe.connect(str(socket_path))
            return True
    except OSError:
        return False


def main() -> int:
    default_rust = Path(__file__).resolve().parents[2] / "target/release/prime-agent"
    parser = argparse.ArgumentParser()
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--rust-bin", default=str(default_rust))
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    rust_bin = Path(args.rust_bin).resolve()
    if not rust_bin.exists():
        print(f"rust binary missing: {rust_bin}", file=sys.stderr)
        return 2
    # Fail fast before any launch: a non-TS ts binary plays a Rust build as
    # the "ts" side and reports false parity rows.
    ts_identity.assert_ts_side_is_the_ts_product(args.ts_bin, str(rust_bin))

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = Path(args.out) if args.out else Path(__file__).parent / "runs" / f"{stamp}-{FLOW}"
    out.mkdir(parents=True, exist_ok=True)

    # The Rust windows must be observable: a 3 s prepare budget and a 3 s
    # marker self-expiry keep the gate active long enough to stage
    # P2/P3/D3/D4, then the recovery row needs the watchdog to fire before
    # the 5 s wait ends.
    rust_env = {
        "PRIME_AGENT_UPDATE_PREPARE_MS": "3000",
        "PRIME_AGENT_UPDATE_PREPARED_EXPIRY_MS": "3000",
    }
    sides = {
        "ts": make_side("ts", args.ts_bin, out / "ts", {}),
        "rust": make_side("rust", str(rust_bin), out / "rust", rust_env),
    }
    results = {}
    for name, side in sides.items():
        raw, by_id = run_empty_flow(side)
        results[name] = by_id
        side.evidence(
            FLOW,
            "wire.jsonl",
            "\n".join(json.dumps(line) for line in raw) + "\n",
        )
        side.stop_daemon()
        side.mock.stop()

    ts, rs = results["ts"], results["rust"]
    verdicts = []

    def parity(row: str, description: str, ts_line: dict, rs_line: dict) -> None:
        ok = canon(ts_line) == canon(rs_line)
        verdicts.append({"row": row, "description": description, "parity": ok})
        if not ok:
            side_diff = f"ts={canon(ts_line)}\nrust={canon(rs_line)}"
            print(f"[MISMATCH] {row}: {description}\n{side_diff}")

    def divergence(row: str, description: str, observed: str) -> None:
        verdicts.append({"row": row, "description": description, "divergence": observed})

    # P1: baseline read byte parity (canonical).
    parity("P1", "list_saved_sessions baseline is byte-identical", ts["s1"], rs["s1"])
    # P2: the gate refusal.
    ts_gate_error = ts["s3"].get("error")
    rs_gate_error = rs["s3"].get("error")
    gate_ok = (
        ts["s3"].get("success") is False
        and rs["s3"].get("success") is False
        and ts_gate_error == GATE_MESSAGE
        and rs_gate_error == GATE_MESSAGE
    )
    verdicts.append({"row": "P2", "description": "gate refusal message parity", "parity": gate_ok})
    if not gate_ok:
        print(f"[MISMATCH] P2: ts={ts_gate_error!r} rust={rs_gate_error!r}")
    # P3: reads stay served during the window, identical to baseline.
    parity("P3", "reads stay served during the prepare window", ts["s4"], rs["s4"])
    def masked(line: dict) -> str:
        body = {k: v for k, v in line.items() if k != "id"}
        return canon(body)

    served = (
        ts["s4"].get("success") is True
        and rs["s4"].get("success") is True
        and masked(ts["s4"]) == masked(ts["s1"])
        and masked(rs["s4"]) == masked(rs["s1"])
    )
    verdicts.append({"row": "P3b", "description": "served rows equal the baseline rows", "parity": served})
    # P4: TS wedges, Rust recovers.
    ts_wedged = ts["s5"].get("error") == GATE_MESSAGE
    rs_recovered = rs["s5"].get("error") != GATE_MESSAGE
    verdicts.append(
        {
            "row": "P4",
            "description": "stray prepare: TS stays wedged (bug), Rust self-recovers",
            "parity": ts_wedged and rs_recovered,
            "ts_wedged": ts_wedged,
            "rust_recovered": rs_recovered,
        }
    )
    if not (ts_wedged and rs_recovered):
        print(f"[MISMATCH] P4: ts_wedged={ts_wedged} rust_recovered={rs_recovered}")

    # Divergence rows (asserted, explained).
    divergence(
        "D1",
        "prepare without updateId: TS runs the flow, Rust requires the key",
        f"ts success={ts['s2'].get('success')} data-keys={sorted((ts['s2'].get('data') or {}).keys())}; "
        f"rust success={rs['s2'].get('success')} error={rs['s2'].get('error')!r}",
    )
    divergence(
        "D2",
        "prepare with updateId: TS blocking full restart, Rust transaction state",
        f"ts data={json.dumps(ts['s2'].get('data'), sort_keys=True)}; "
        f"rust data={json.dumps(rs['s2b'].get('data'), sort_keys=True)}",
    )
    already_ok = (
        rs["s2c"].get("success") is False
        and rs["s2c"].get("error") == ALREADY_MESSAGE
        and (rs["s2c"].get("errorInfo") or {}).get("code") == "update_prepare_refused"
    )
    verdicts.append(
        {
            "row": "D3",
            "description": "different-id prepare: TS string + typed refusal info",
            "parity": already_ok,
        }
    )
    if not already_ok:
        print(f"[MISMATCH] D3: rust={canon(rs['s2c'])}")
    # D4 live: shutdown during the window — TS exempts it at `prepared`
    # (its s6 succeeded while the gate was up), Rust refuses it as a
    # mutation and serves it normally once the transaction aborted.
    d4_ok = (
        ts["s6"].get("success") is True
        and rs["s6b"].get("success") is False
        and rs["s6b"].get("error") == GATE_MESSAGE
        and rs["s6"].get("success") is True
    )
    verdicts.append(
        {
            "row": "D4",
            "description": "shutdown during the window: TS exempts at prepared, Rust refuses until recovery",
            "parity": d4_ok,
        }
    )
    if not d4_ok:
        print(
            f"[MISMATCH] D4: ts s6={canon(ts['s6'])} rust s6b={canon(rs['s6b'])} rust s6={canon(rs['s6'])}"
        )

    # Phase 2 (slice 3): the live-session prepare/commit divergence with
    # fresh daemons on fresh agent dirs.
    live = {}
    for name, side in sides.items():
        live_side = make_side(f"{name}-live", side.binary, out / f"{name}-live", rust_env if name == "rust" else {})
        raw_live, by_id_live, session_id = run_session_flow(live_side)
        supervisor_exited = False
        if name == "rust":
            # E2: commit stops the worker and the supervisor exits for the
            # update - poll the socket, not a shell ps.
            exit_deadline = time.time() + 10.0
            while time.time() < exit_deadline:
                if not daemon_socket_alive(live_side.daemon_socket):
                    supervisor_exited = True
                    break
                time.sleep(0.25)
        live_side.evidence(
            FLOW,
            "wire-live.jsonl",
            "\n".join(json.dumps(line) for line in raw_live) + "\n",
        )
        live_side.stop_daemon()
        live_side.mock.stop()
        live[name] = by_id_live
        live[name]["__session_id__"] = session_id
        if name == "rust":
            live[name]["__supervisor_exited__"] = supervisor_exited

    tls, rls = live["ts"], live["rust"]
    # E1: prepare vs the session's life. TS stops the session inside the
    # blocking prepare (get_state fails); Rust leaves it serving.
    e1_ok = (
        tls["pre"].get("success") is True
        and rls["pre"].get("success") is True
        and (rls["pre"].get("data") or {}).get("state") == "prepared"
        and tls["st1"].get("success") is False
        and rls["st1"].get("success") is True
    )
    verdicts.append(
        {
            "row": "E1",
            "description": "prepare: TS kills the session in the RPC, Rust keeps it serving (I3)",
            "parity": e1_ok,
            "ts_get_state": tls["st1"].get("error"),
            "rust_get_state": rls["st1"].get("success"),
        }
    )
    if not e1_ok:
        print(f"[MISMATCH] E1: ts st1={canon(tls['st1'])} rust st1={canon(rls['st1'])}")
    # E2: Rust commit stops the worker in budget and exits the supervisor.
    commit_data = rls["cm1"].get("data") or {}
    e2_ok = (
        rls["cm1"].get("success") is True
        and commit_data.get("state") == "stopping"
        and int(commit_data.get("stopped") or 0) >= 1
        and live["rust"].get("__supervisor_exited__") is True
    )
    verdicts.append(
        {
            "row": "E2",
            "description": "commit: worker stopped in budget, supervisor exits for the update",
            "parity": e2_ok,
        }
    )
    if not e2_ok:
        print(f"[MISMATCH] E2: commit={canon(rls['cm1'])} exited={live['rust'].get('__supervisor_exited__')}")
    divergence(
        "E3",
        "commit_update_restart exists only on Rust (spec §5): TS has no separate commit surface",
        f"ts prepare data-keys={sorted((tls['pre'].get('data') or {}).keys())}; "
        f"rust commit data={json.dumps(commit_data, sort_keys=True)}",
    )

    report = {
        "flow": FLOW,
        "ts_bin": args.ts_bin,
        "rust_bin": str(rust_bin),
        "verdicts": verdicts,
        "raw": {name: {cmd: line for cmd, line in results[name].items()} for name in results},
        "raw_live": {
            name: {cmd: line for cmd, line in live[name].items()} for name in live
        },
    }
    (out / f"{FLOW}-report.json").write_text(json.dumps(report, indent=1))
    print(f"evidence: {out / f'{FLOW}-report.json'}")
    for verdict in verdicts:
        status = "PARITY" if verdict.get("parity") else verdict.get("divergence", "MISMATCH")
        print(f"  [{status}] {verdict['row']}: {verdict['description']}")
    failed = [v["row"] for v in verdicts if "parity" in v and not v["parity"]]
    if failed:
        print(f"FAILED rows: {', '.join(failed)}")
        return 1
    print("all parity rows match; divergences documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
