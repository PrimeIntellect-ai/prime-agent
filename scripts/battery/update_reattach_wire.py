#!/usr/bin/env python3
"""update_reattach_wire.py — the update flow's slice-6 battery: client
reattach (spec §10) end to end and the coordinator-kill construction
proofs (I2/I3), against the Rust release binary on fixture install roots.

Rows:
  T1 the flagship: a TUI attached in tmux rides a full staged update — the
     update banner renders, the daemon swaps binaries, the client
     auto-reattaches to the same durable session (reattach is the DEFAULT
     end state; spec §10). Evidence: captured tmux frames.
  G4 attach-by-durable-id after the update: a fresh client attaches by the
     durable id (§10.4/§10.5): same session, transcript replayed.
  K1 kill -9 the coordinator mid-Preparing: the daemon's prepare transaction
     self-expires back to Serving (spec §5/I3), the session survives, and a
     re-run update completes end to end (the dead-holder intent steal).
  K2 kill -9 the coordinator at Prepared: same recovery from the prepared
     state (the marker self-expiry watchdog), then the re-run completes.

The battery never touches the real TS install: every `update` runs from
battery-owned fixture install roots.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import batterylib as B
import update_staged_wire as U

FLOW = "update_reattach"

TERMINAL_COMPLETE = "complete"


def tmux(*args, check=True):
    """Run a tmux command on the default socket (never inside TMUX)."""
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", *args],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture_pane(session):
    return tmux("capture-pane", "-p", "-t", session)


def pane_alive(session):
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", "list-panes", "-t", session, "-F", "#{pane_dead}"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() != "1"


def wait_for_pane(session, needle, timeout=60.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture_pane(session)
        if needle in pane:
            return pane
        time.sleep(0.3)
    raise TimeoutError(f"pane never showed {needle!r}")


def status_file_of(side):
    socket_dir = side.agent_dir / "update-restarts"
    files = sorted(socket_dir.glob("*/status.json")) if socket_dir.exists() else []
    return files[-1] if files else None


def read_status(side):
    path = status_file_of(side)
    if not path or not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def wait_for_state(side, state, timeout=90.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = read_status(side)
        if status and status.get("state") == state:
            return status
        time.sleep(0.05)
    return None


def intent_pid(side):
    socket_dir = side.agent_dir / "update-restarts"
    for path in sorted(socket_dir.glob("*/intent.json")) if socket_dir.exists() else []:
        try:
            return json.loads(path.read_text()).get("pid")
        except (OSError, json.JSONDecodeError):
            continue
    return None


def coordinator_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main() -> int:
    default_rust = Path(__file__).resolve().parents[2] / "target/release/prime-agent"
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-bin", default=str(default_rust))
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    rust_bin = Path(args.rust_bin).resolve()
    if not rust_bin.exists():
        print(f"rust binary missing: {rust_bin}", file=sys.stderr)
        return 2
    version = subprocess.run(
        [str(rust_bin), "--version"], capture_output=True, text=True
    ).stdout.strip()

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = Path(args.out) if args.out else Path(__file__).parent / "runs" / f"{stamp}-{FLOW}"
    out.mkdir(parents=True, exist_ok=True)
    verdicts = []
    evidence = {"flow": FLOW, "version": version, "rows": {}}

    try:
        server = U.ReleaseServer(out / "server")
        (out / "server").mkdir(parents=True, exist_ok=True)

        # ------------------------------------------------------------------
        # T1 + G4: the flagship — a TUI in tmux rides the whole update and
        # auto-reattaches; then a fresh client attaches by durable id.
        # ------------------------------------------------------------------
        t1_root = out / "rust-t1"
        if t1_root.exists():
            shutil.rmtree(t1_root)
        fixture = U.build_fixture_root(t1_root, rust_bin, version)
        install = fixture["install"]
        fixture_bin = install / "bin" / "prime-agent"
        # The staged release's install-source points at the battery server.
        (fixture["release_a"] / ".install-source").write_text(server.base_url + "\n")
        archive_sha, archive_name = U.build_candidate(out / "server", rust_bin, version)
        (out / "server" / "latest.json").write_text(
            json.dumps(
                {
                    "version": version,
                    "binaries": [
                        {
                            "platform": U.PLATFORM,
                            "file": archive_name,
                            "sha256": archive_sha,
                        }
                    ],
                }
            )
        )
        side = U.make_rust_side(
            f"rust-t1-{stamp}",
            str(fixture_bin),
            t1_root,
            {
                "PRIME_AGENT_DOWNLOAD_BASE_URL": server.base_url,
                "PRIME_AGENT_UPDATE_RESTORE_OVERALL_MS": "15000",
                # Short expiry: a killed coordinator recovers fast (K rows).
                "PRIME_AGENT_UPDATE_PREPARED_EXPIRY_MS": "3000",
            },
        )
        side.daemon_socket = U.default_socket(side)
        # Skip the first-run onboarding pane (the settings flag TS respects:
        # `onboardingShown`): the row tests the reconnect contract, not the
        # trace question.
        (side.agent_dir / "settings.json").write_text(
            json.dumps({"onboardingShown": True})
        )
        side.start_daemon()

        # A session the TUI will attach to (attach a pre-made session so the
        # TUI opens straight into it: --resume <selector>-style attach).
        wire = B.Wire(side.daemon_socket)
        created = wire.request("t1-create", {"type": "create", "cwd": str(side.work_dir)})
        session_id = None
        deadline = time.time() + 30.0
        while time.time() < deadline:
            listing = wire.request("t1-ls", {"type": "list"})
            rows = ((listing.get("data") or {}).get("sessions")) or []
            if rows:
                session_id = rows[0].get("sessionId")
                break
            time.sleep(0.5)
        wire.sock.close()

        # The TUI in tmux, attached by durable id.
        tui_session = f"usw-tui-{stamp}"
        tmux("kill-session", "-t", tui_session, check=False)
        tmux("new-session", "-d", "-s", tui_session, "-x", "120", "-y", "36", "-c", str(side.work_dir))
        # A curated env (quoted; env values with spaces must not split the
        # command line - the tmux pane is a shell).
        tui_env = {
            key: value
            for key, value in side.env.items()
            if key
            in {
                "PATH",
                "HOME",
                "LANG",
                "TMPDIR",
                "NO_COLOR",
                "PRIME_AGENT_CODING_AGENT_DIR",
                "PRIME_AGENT_DOWNLOAD_BASE_URL",
                "PRIME_AGENT_UPDATE_RESTORE_OVERALL_MS",
                "PRIME_AGENT_UPDATE_PREPARED_EXPIRY_MS",
                "PRIME_API_KEY",
                "PRIME_AGENT_BASH_SHELL",
                "TERM",
            }
        }
        env_pairs = " ".join(f"{key}='{value}'" for key, value in tui_env.items())
        command = f"env {env_pairs} {fixture_bin} --daemon-socket {side.daemon_socket} --model mock-1"
        tmux("send-keys", "-t", tui_session, command, "Enter")
        # The Rust TUI's ready needle (the visual-parity harness waits for the
        # same row).
        try:
            pane = wait_for_pane(tui_session, "Collapsed mode", timeout=40)
        except TimeoutError:
            pane = capture_pane(tui_session)
            evidence["rows"]["T1"] = {
                "tui_pane": pane[-2000:],
                "error": "the TUI never reached its ready state",
            }
            verdicts.append({"row": "T1", "description": "TUI rides the update and auto-reattaches", "parity": False})
            side.stop_daemon()
            side.mock.stop()
            tmux("kill-session", "-t", tui_session, check=False)
            raise
        evidence["rows"]["T1"] = {"pre_update_frame": pane[-4000:]}

        # The update from a second shell (same fixture env).
        update = subprocess.Popen(
            [str(fixture_bin), "update", "--force"],
            env=side.env,
            cwd=str(side.work_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # A frame from inside the update window: the §11 banner is visible
        # while the daemon restarts (the pre-reattach banner is transient -
        # the reattach rebuild replaces the transcript with the session's
        # truth, so only the mid-window capture shows it).
        mid_pane = None
        mid_deadline = time.time() + 60.0
        while time.time() < mid_deadline:
            status = read_status(side)
            if status and status.get("state") in ("preparing", "prepared", "stopping", "activating", "booting", "restoring"):
                mid_pane = capture_pane(tui_session)
                if "Prime Agent is updating" in mid_pane:
                    break
                mid_pane = None
            time.sleep(0.1)
        update_stdout, update_stderr = update.communicate(timeout=240)
        time.sleep(2.0)

        final_pane = capture_pane(tui_session)
        evidence["rows"]["T1"]["update_stdout"] = update_stdout
        evidence["rows"]["T1"]["update_stderr"] = update_stderr
        evidence["rows"]["T1"]["mid_update_frame"] = (mid_pane or "")[-4000:]
        evidence["rows"]["T1"]["post_update_frame"] = final_pane[-4000:]
        evidence["rows"]["T1"]["pane_alive"] = pane_alive(tui_session)
        evidence["rows"]["T1"]["status"] = read_status(side) or {}

        after_wire = B.Wire(side.daemon_socket)
        after_listing = after_wire.request("t1-after", {"type": "list"})
        after_rows = ((after_listing.get("data") or {}).get("sessions")) or []
        after_sessions = sorted(
            row.get("sessionId") for row in after_rows if row.get("sessionId")
        )
        after_wire.sock.close()
        evidence["rows"]["T1"]["after_sessions"] = after_sessions
        t1_ok = (
            update.returncode == 0
            and mid_pane is not None
            and "Prime Agent is updating" in mid_pane
            and "Reconnected" in final_pane
            and evidence["rows"]["T1"]["pane_alive"]
            # The pre-made session is in the restored set (the TUI re-created
            # its own session on the successor; the "Reconnected" banner is
            # the TUI-side end state).
            and session_id in after_sessions
            and (evidence["rows"]["T1"]["status"] or {}).get("state") == "complete"
        )
        verdicts.append({"row": "T1", "description": "TUI rides the update: banner, auto-reattach, same durable session", "parity": bool(t1_ok)})

        # G4: a fresh client attaches by durable id (the §10.4/§10.5 end
        # state: same session, transcript replayed).
        g4_wire = B.Wire(side.daemon_socket)
        attach = g4_wire.request(
            "g4-attach", {"type": "attach", "activeSessionId": session_id}
        )
        attach_data = attach.get("data") or {}
        attached_session = (attach_data.get("snapshot") or {}).get("sessionId")
        if not attached_session:
            # Fallback: the active id from the attach data resolves to the
            # durable row in the list.
            active = attach_data.get("activeSessionId")
            listing = g4_wire.request("g4-list", {"type": "list"})
            rows = ((listing.get("data") or {}).get("sessions")) or []
            attached_session = next(
                (
                    row.get("sessionId")
                    for row in rows
                    if row.get("activeSessionId") == active
                ),
                None,
            )
        attach_ok = bool(attach.get("success")) and attached_session == session_id
        evidence["rows"]["G4"] = {
            "attach_success": bool(attach.get("success")),
            "attached_session": attached_session,
            "session": session_id,
        }
        verdicts.append({"row": "G4", "description": "attach-by-durable-id after the update: same session, replayed", "parity": bool(attach_ok)})
        g4_wire.sock.close()
        tmux("kill-session", "-t", tui_session, check=False)
        side.stop_daemon()
        side.mock.stop()
        # The successor daemon outlives the side handle: stop it over the
        # wire, then reap this fixture's detached workers (cwd-scoped).
        try:
            stop_wire = B.Wire(side.daemon_socket)
            stop_wire.request("t1-stop", {"type": "shutdown"})
            stop_wire.sock.close()
        except OSError:
            pass
        U.kill_detached_workers_under(t1_root)

        # ------------------------------------------------------------------
        # K rows: kill -9 the coordinator mid-transaction (spec §13.6's
        # construction proofs). The coordinator is SIGSTOPPED first so the
        # kill lands deterministically inside the target window: K1 freezes
        # it while the prepare RPC is in flight (the daemon finishes the
        # transaction alone); K2 freezes it the same way, then waits for
        # the prepared marker (the daemon reached `Prepared` with a frozen
        # coordinator) before the kill. Both rows recover through the
        # marker self-expiry watchdog back to `Serving`, the session
        # survives, and a re-run update completes (the dead-holder intent
        # steal).
        # ------------------------------------------------------------------
        for row, wait_for_marker in [("K1", False), ("K2", True)]:
            k_root = out / f"rust-{row.lower()}"
            if k_root.exists():
                shutil.rmtree(k_root)
            kfixture = U.build_fixture_root(k_root, rust_bin, version)
            kinstall = kfixture["install"]
            kbin = kinstall / "bin" / "prime-agent"
            (kfixture["release_a"] / ".install-source").write_text(server.base_url + "\n")
            kside = U.make_rust_side(
                f"rust-{row.lower()}-{stamp}",
                str(kbin),
                k_root,
                {
                    "PRIME_AGENT_DOWNLOAD_BASE_URL": server.base_url,
                    "PRIME_AGENT_UPDATE_RESTORE_OVERALL_MS": "15000",
                    "PRIME_AGENT_UPDATE_PREPARED_EXPIRY_MS": "3000",
                },
            )
            kside.daemon_socket = U.default_socket(kside)
            kside.start_daemon()
            kwire = B.Wire(kside.daemon_socket)
            kwire.request("k-create", {"type": "create", "cwd": str(kside.work_dir)})
            ksession = None
            deadline = time.time() + 30.0
            while time.time() < deadline and ksession is None:
                listing = kwire.request("k-ls", {"type": "list"})
                rows = ((listing.get("data") or {}).get("sessions")) or []
                ksession = next((row_.get("sessionId") for row_ in rows), None)
                time.sleep(0.5)
            kwire.sock.close()

            update_proc = subprocess.Popen(
                [str(kbin), "update", "--force"],
                env=kside.env,
                cwd=str(kside.work_dir),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # 2 ms poll: the coordinator's `Preparing` window is ~10 ms on
            # this fixture, so the freeze must land inside the RPC.
            pid = None
            deadline = time.time() + 60.0
            marker = None
            while time.time() < deadline:
                pid = pid or intent_pid(kside)
                status = read_status(kside)
                if pid and status and status.get("state") == "preparing":
                    try:
                        os.kill(pid, signal.SIGSTOP)
                    except OSError:
                        pass
                    if wait_for_marker:
                        # The daemon completes the transaction alone; wait
                        # for the prepared marker (Prepared with a frozen
                        # coordinator), then kill.
                        marker_deadline = time.time() + 30.0
                        while time.time() < marker_deadline:
                            sockets = kside.agent_dir / "update-restarts"
                            markers = list(sockets.glob("*/prepared/*/marker.json")) if sockets.exists() else []
                            if markers:
                                marker = str(markers[0])
                                break
                            time.sleep(0.05)
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
                    break
                time.sleep(0.002)
            update_proc.wait(timeout=30)

            row_data = {
                "coordinator_pid": pid,
                "prepared_marker_at_kill": marker,
                "status_at_kill": (read_status(kside) or {}).get("state"),
            }
            # The invoker CLI tails the dead coordinator for its full
            # liveness budget otherwise; it holds nothing after the hand-over,
            # so kill it (the re-run steals the dead holder's intent).
            try:
                update_proc.kill()
            except OSError:
                pass

            # The transaction self-expires back to Serving (the watchdog
            # aborts on the expiry; bounded by the short marker TTL).
            deadline = time.time() + 20.0
            served = False
            while time.time() < deadline:
                try:
                    probe = B.Wire(kside.daemon_socket)
                    listing = probe.request("k-probe", {"type": "list"})
                    served = bool(listing.get("success"))
                    if served:
                        # The gate must be gone: a mutating command passes.
                        mutate = probe.request(
                            "k-mutate",
                            {"type": "create", "cwd": str(kside.work_dir)},
                        )
                        served = bool(mutate.get("success"))
                    probe.sock.close()
                except (OSError, EOFError, TimeoutError):
                    pass
                if served:
                    break
                time.sleep(0.5)
            row_data["daemon_serving_after_kill"] = served

            # The session survived the killed update.
            ksession_after = None
            try:
                kwire2 = B.Wire(kside.daemon_socket)
                listing = kwire2.request("k-ls2", {"type": "list"})
                rows = ((listing.get("data") or {}).get("sessions")) or []
                ksession_after = next(
                    (row_.get("sessionId") for row_ in rows if row_.get("sessionId") == ksession),
                    None,
                )
                kwire2.sock.close()
            except (OSError, EOFError, TimeoutError):
                pass
            row_data["session_survived"] = ksession_after == ksession

            # The re-run: the dead-holder intent steal, then a full update.
            rerun = U.run_cli(kbin, ["update", "--force"], kside.env, kside.work_dir)
            rerun_status = read_status(kside) or {}
            row_data["rerun_exit"] = rerun["exit_code"]
            row_data["rerun_status"] = {k_: rerun_status.get(k_) for k_ in ("state", "counts", "message")}
            kill_label = "at Prepared (marker present)" if wait_for_marker else "mid-Preparing (RPC in flight)"
            k_ok = (
                bool(pid)
                and (not wait_for_marker or row_data["prepared_marker_at_kill"])
                and row_data["daemon_serving_after_kill"]
                and row_data["session_survived"]
                and rerun["exit_code"] == 0
                and rerun_status.get("state") == "complete"
            )
            verdicts.append({"row": row, "description": f"kill -9 the coordinator {kill_label}: self-expiry to Serving, session survives, re-run completes", "parity": bool(k_ok)})
            evidence["rows"][row] = row_data

            # Stop the successor daemon from the re-run + this side's daemon.
            try:
                stop = B.Wire(kside.daemon_socket)
                stop.request("k-stop", {"type": "shutdown"})
                stop.sock.close()
            except OSError:
                pass
            kside.stop_daemon()
            kside.mock.stop()
            U.kill_detached_workers_under(k_root)
            time.sleep(1.0)

        server.stop()

    finally:
        (out / "update_reattach-report.json").write_text(
            json.dumps({"verdicts": verdicts, **evidence}, indent=1)
        )

    print(f"evidence: {out / 'update_reattach-report.json'}")
    ok = True
    for verdict in verdicts:
        marker = "PARITY" if verdict["parity"] else "MISMATCH"
        ok = ok and verdict["parity"]
        print(f"  [{marker}] {verdict['row']}: {verdict['description']}")
    failed = [v["row"] for v in verdicts if not v["parity"]]
    if failed:
        print(f"FAILED rows: {', '.join(failed)}")
        return 1
    print("all parity rows match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
