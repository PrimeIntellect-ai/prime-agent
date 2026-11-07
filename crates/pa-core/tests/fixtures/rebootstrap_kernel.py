#!/usr/bin/env python3
import json
import os
import sys
import time

# Protocol v3 fake: "BOOT" is the runtime bootstrap, failing while the counter
# file at FAIL_BOOTS_FILE is positive; "check-boot" errors unless this process
# ran a successful bootstrap; "corrupt" emits an invalid protocol frame. With
# SPAWNS_FILE set, every spawn after the first holds its ready frame back a moment.
fail_boots_file = os.environ["FAIL_BOOTS_FILE"]
booted = False
spawns_file = os.environ.get("SPAWNS_FILE")
if spawns_file:
    with open(spawns_file, "a") as f:
        f.write("x")
    if os.path.getsize(spawns_file) > 1:
        time.sleep(1)


def done(req_id, ok, evalue=""):
    if not ok:
        print(json.dumps({"event": "error", "id": req_id, "ename": "RuntimeError", "evalue": evalue}))
    print(json.dumps({"event": "done", "id": req_id, "status": "ok" if ok else "error"}), flush=True)


print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    code = req.get("code")
    if code == "corrupt":
        print(json.dumps({"event": "bogus"}), flush=True)
    elif code == "BOOT":
        with open(fail_boots_file) as f:
            remaining = int(f.read() or 0)
        if remaining > 0:
            with open(fail_boots_file, "w") as f:
                f.write(str(remaining - 1))
            done(req.get("id"), False, "bootstrap failed")
        else:
            booted = True
            done(req.get("id"), True)
    elif code == "check-boot":
        done(req.get("id"), booted, "kernel was not bootstrapped")
    else:
        done(req.get("id"), True)
        if req.get("type") == "shutdown":
            break
