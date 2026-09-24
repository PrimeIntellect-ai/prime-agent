#!/usr/bin/env python3
"""prime-agent latency trace probe — the cross-machine comparison protocol.

Drives the LIVE daemon on this machine over its JSONL supervisor socket
and records a per-request timing breakdown for the operator's lag
surfaces (the agents-view request set, the /context request, attach),
plus the live-store shape and the concurrency decomposition (a
lightweight request fired alongside a heavy one: its inflation is the
head-of-line/queueing measure).

Run identically on both machines (the box and the Mac), then compare the
JSON traces: same product, comparable store, wildly different feel — the
difference IS the diagnosis (fleet contention, hardware, or the
request-path defects under fix).

Usage: python3 pa-latency-trace.py [--socket /path] [--out trace.json]
  The trace JSON is written to --out and printed.
"""
import argparse
import json
import os
import socket
import subprocess
import threading
import time

PROTOCOL = {"name": "prime-agent.daemon", "version": 7}


class DaemonProbe:
    def __init__(self, sock, timeout=90.0):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(timeout)
        self.s.connect(sock)
        self.buf = b""
        self.deadline = None

    def read_line(self):
        # One deadline spans the whole command: a wedged request (a steady
        # stream of non-response event frames) still fails the trace
        # instead of waiting a socket-timeout per recv forever.
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise TimeoutError("trace deadline exceeded for the pending response")
        while b"\n" not in self.buf:
            remaining = None
            if self.deadline is not None:
                remaining = self.deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("trace deadline exceeded for the pending response")
            self.s.settimeout(remaining)
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)

    def command(self, cmd, rid, timeout=90.0):
        env = {"type": "command", "id": rid, "protocol": PROTOCOL, "command": cmd}
        self.deadline = time.monotonic() + timeout
        t0 = time.time()
        self.s.sendall((json.dumps(env) + "\n").encode())
        try:
            while True:
                msg = self.read_line()
                if msg.get("id") == rid and msg.get("type") == "response":
                    return {"wall_ms": (time.time() - t0) * 1000.0, "response": msg}
        finally:
            self.deadline = None

    def close(self):
        self.s.close()


def kitty_probe_timing(budget_s=2.5):
    """The terminal enhanced-key query latency, measured on THIS process's
    tty (run the trace from inside the interactive terminal being
    compared): the TUI's surface start blocks input-blind on this answer
    for up to 2s when the terminal does not answer (an SSH pipe often
    does not; a local terminal answers in milliseconds) — the
    per-switch, terminal-dependent stall that stacks with the request
    chain."""
    import select
    import sys
    if not sys.stdout.isatty():
        return {"available": False, "reason": "no tty on this process"}
    fd = sys.stdout.fileno()
    old = None
    try:
        import termios
        old = termios.tcgetattr(fd)
        import tty
        tty.setraw(fd)
    except Exception:
        old = None
    t0 = time.time()
    answered = False
    try:
        os.write(fd, b"\x1b[?u")  # the kitty keyboard-protocol query
        deadline = t0 + budget_s
        while time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], deadline - time.time())
            if ready:
                os.read(fd, 65536)
                answered = True
                break
    finally:
        if old is not None:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            except Exception:
                pass
    return {
        "available": True,
        "answered": answered,
        "answer_ms": round((time.time() - t0) * 1000.0, 1),
        "note": "answered in answer_ms; unanswered means the TUI's kitty probe waits out its 2s budget per surface start (input-blind) — the terminal-dependent per-switch stall",
    }


def command_timing(probe, cmd, rid, label):
    r = probe.command(cmd, rid)
    return {
        "label": label,
        "command": cmd.get("type"),
        "wall_ms": round(r["wall_ms"], 2),
        "success": r["response"].get("success"),
        "payload_bytes": len(json.dumps(r["response"].get("data") or {})),
    }


def store_shape(agent_dir):
    sessions = os.path.join(agent_dir, "sessions")
    artifacts = os.path.join(agent_dir, "session-artifacts")
    files = 0
    total = 0
    largest = 0
    if os.path.isdir(sessions):
        for f in os.listdir(sessions):
            if f.endswith(".jsonl"):
                p = os.path.join(sessions, f)
                size = os.path.getsize(p)
                files += 1
                total += size
                largest = max(largest, size)
    subagent_dirs = 0
    if os.path.isdir(artifacts):
        for dirpath, dirnames, _ in os.walk(artifacts):
            subagent_dirs += sum(1 for d in dirnames if d.startswith("sub-"))
    return {
        "top_level_sessions": files,
        "top_level_bytes": total,
        "largest_session_bytes": largest,
        "subagent_dirs": subagent_dirs,
    }


def env_shape():
    try:
        load1 = os.getloadavg()[0]
    except Exception:
        load1 = None
    nproc = os.cpu_count()
    return {"load_1min": load1, "cores": nproc}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default=os.environ.get("PA_TRACE_SOCKET", "/tmp/prime-agent-1000/daemon.sock"))
    ap.add_argument("--out", default="pa-latency-trace.json")
    ap.add_argument("--agent-dir", default=os.path.expanduser("~/.prime/agent"))
    args = ap.parse_args()

    trace = {
        "protocol_version": 1,
        "machine": {"hostname": socket.gethostname()},
        "steps": [],
        "store": store_shape(args.agent_dir),
        "env": env_shape(),
        "concurrency": [],
    }

    # 1. The connection + handshake.
    p = DaemonProbe(args.socket)
    hello = p.read_line()
    trace["steps"].append({
        "label": "daemon_hello handshake",
        "command": "connect",
        "wall_ms": 0.0,
        "success": hello.get("type") == "daemon_hello",
        "payload_bytes": len(json.dumps(hello)),
    })

    # 2. A live session for the request set: prefer the busiest live
    #    session (the operator's own), else any live row.
    listing = p.command({"type": "list", "all": True}, "trace-list")
    rows = (listing["response"].get("data") or {}).get("sessions") or []
    active = None
    for row in rows:
        if row.get("isActive") or row.get("activeSessionId"):
            active = row.get("activeSessionId") or row.get("id")
            break
    if active is None and rows:
        active = rows[0].get("id")
    trace["live_session"] = active
    trace["live_session_rows"] = len(rows)

    if active:
        rid = 0

        def run(cmd, label):
            nonlocal rid
            rid += 1
            t = command_timing(p, cmd, f"trace-{rid}", label)
            trace["steps"].append(t)
            return t

        # The agents-view request set + the operator's named lag surfaces.
        run({"type": "roster_subscribe", "activeSessionId": active}, "agents view: roster subscribe")
        run({"type": "get_rlm_children", "activeSessionId": active}, "agents view: rlm children")
        run({"type": "get_session_stats", "activeSessionId": active}, "tray: session stats")
        run({"type": "get_state", "activeSessionId": active}, "state read")
        run({"type": "get_context_tree", "activeSessionId": active}, "/context: context tree")
        run({"type": "get_messages", "activeSessionId": active}, "messages read")

        # 3. The concurrency decomposition: a lightweight request fired
        #    only AFTER the heavy request is on the wire (an event
        #    synchronized on the send), on SEPARATE connections — the
        #    lightweight one's inflation over its solo baseline is the
        #    queueing/head-of-line measure of this daemon under its live
        #    load.
        solo = command_timing(p, {"type": "get_session_stats", "activeSessionId": active}, "solo-baseline", "solo baseline")
        trace["steps"].append(solo)
        heavy = {"type": "get_context_tree", "activeSessionId": active}
        p2 = DaemonProbe(args.socket)
        p2.read_line()
        result_box = {}
        sent = threading.Event()

        def fire_heavy():
            env = {"type": "command", "id": "concurrent-heavy", "protocol": PROTOCOL, "command": heavy}
            p2.deadline = time.monotonic() + 90.0
            t0 = time.time()
            p2.s.sendall((json.dumps(env) + "\n").encode())
            sent.set()
            while True:
                msg = p2.read_line()
                if msg.get("id") == "concurrent-heavy" and msg.get("type") == "response":
                    result_box["heavy"] = {"wall_ms": (time.time() - t0) * 1000.0}
                    return

        th = threading.Thread(target=fire_heavy)
        th.start()
        sent.wait(timeout=5.0)
        light = command_timing(p, {"type": "get_session_stats", "activeSessionId": active}, "concurrent-light", "concurrent light (stats)")
        th.join()
        trace["concurrency"] = {
            "heavy_label": "get_context_tree",
            "heavy_wall_ms": round(result_box["heavy"]["wall_ms"], 2) if result_box.get("heavy") else None,
            "light_wall_ms": round(light["wall_ms"], 2),
            "light_solo_wall_ms": round(solo["wall_ms"], 2),
            "light_inflation_ms": round(light["wall_ms"] - solo["wall_ms"], 2),
            "sync": "the light request fires after the heavy request is on the wire",
        }
        p2.close()

        # 4. The attach round trip (the Esc-handoff surface): a fresh
        #    client attaches and detaches.
        p3 = DaemonProbe(args.socket)
        p3.read_line()
        attach = command_timing(p3, {"type": "attach", "activeSessionId": active, "clientId": "latency-trace"}, "attach-fresh", "fresh-client attach (the Esc-handoff surface)")
        trace["steps"].append(attach)

        # 5. The client-side view-switch CHAIN: the requests the TUI's
        #    switch awaits SEQUENTIALLY on one connection, summed — the
        #    felt round trip's request component (each step inflates
        #    under fleet contention; the sum is the bound the operator
        #    feels stacked with the terminal probe below).
        chain_steps = [
            ({"type": "attach", "activeSessionId": active, "clientId": "latency-trace-chain"}, "chain: attach"),
            ({"type": "roster_subscribe", "activeSessionId": active}, "chain: roster subscribe"),
            ({"type": "get_session_stats", "activeSessionId": active}, "chain: session stats"),
            ({"type": "get_state", "activeSessionId": active}, "chain: state read"),
            ({"type": "get_rlm_children", "activeSessionId": active}, "chain: rlm children"),
            ({"type": "detach", "activeSessionId": active, "clientId": "latency-trace-chain"}, "chain: detach"),
        ]
        chain = []
        chain_t0 = time.time()
        for cmd, label in chain_steps:
            chain.append(command_timing(p3, cmd, "chain-step", label))
        chain_total = (time.time() - chain_t0) * 1000.0
        trace["switch_chain"] = {
            "note": "the sequential request chain a view switch awaits on one connection (the client-side request component of the felt round trip)",
            "steps": chain,
            "total_wall_ms": round(chain_total, 2),
        }
        p3.close()

    # 6. The terminal enhanced-key probe timing (run the trace from inside
    #    the interactive terminal being compared): the surface start
    #    blocks input-blind on this answer for up to 2s when the terminal
    #    does not answer — the terminal-dependent per-switch stall that
    #    stacks with the request chain.
    trace["kitty_probe"] = kitty_probe_timing()

    p.close()
    with open(args.out, "w") as f:
        json.dump(trace, f, indent=2)
    print(json.dumps(trace, indent=2))


if __name__ == "__main__":
    main()
