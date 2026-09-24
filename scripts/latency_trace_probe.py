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

    def read_line(self):
        while b"\n" not in self.buf:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)

    def command(self, cmd, rid, timeout=None):
        env = {"type": "command", "id": rid, "protocol": PROTOCOL, "command": cmd}
        t0 = time.time()
        self.s.sendall((json.dumps(env) + "\n").encode())
        while True:
            msg = self.read_line()
            if msg.get("id") == rid and msg.get("type") == "response":
                return {"wall_ms": (time.time() - t0) * 1000.0, "response": msg}

    def close(self):
        self.s.close()


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

        # 3. The concurrency decomposition: a lightweight request fired at
        #    the same instant as the heavy one, on SEPARATE connections —
        #    the lightweight one's inflation over its solo baseline is the
        #    queueing/head-of-line measure of this daemon under its live
        #    load.
        solo = command_timing(p, {"type": "get_session_stats", "activeSessionId": active}, "solo-baseline", "solo baseline")
        trace["steps"].append(solo)
        heavy = {"type": "get_context_tree", "activeSessionId": active}
        p2 = DaemonProbe(args.socket)
        p2.read_line()
        result_box = {}

        def fire_heavy():
            result_box["heavy"] = command_timing(p2, heavy, "concurrent-heavy", "concurrent heavy (/context)")

        th = threading.Thread(target=fire_heavy)
        th.start()
        time.sleep(0.002)
        light = command_timing(p, {"type": "get_session_stats", "activeSessionId": active}, "concurrent-light", "concurrent light (stats)")
        th.join()
        trace["concurrency"] = {
            "heavy_label": "get_context_tree",
            "heavy_wall_ms": round(result_box["heavy"]["wall_ms"], 2) if result_box.get("heavy") else None,
            "light_wall_ms": round(light["wall_ms"], 2),
            "light_solo_wall_ms": round(solo["wall_ms"], 2),
            "light_inflation_ms": round(light["wall_ms"] - solo["wall_ms"], 2),
        }
        p2.close()

        # 4. The attach round trip (the Esc-handoff surface): a fresh
        #    client attaches and detaches.
        p3 = DaemonProbe(args.socket)
        p3.read_line()
        attach = command_timing(p3, {"type": "attach", "activeSessionId": active, "clientId": "latency-trace"}, "attach-fresh", "fresh-client attach (the Esc-handoff surface)")
        trace["steps"].append(attach)
        detach = command_timing(p3, {"type": "detach", "activeSessionId": active, "clientId": "latency-trace"}, "detach", "detach")
        trace["steps"].append(detach)
        p3.close()

    p.close()
    with open(args.out, "w") as f:
        json.dump(trace, f, indent=2)
    print(json.dumps(trace, indent=2))


if __name__ == "__main__":
    main()
