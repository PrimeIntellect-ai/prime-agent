#!/usr/bin/env python3
import json
import sys
import time

print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("code") == "corrupt-huge-line":
        sys.stdout.write("x" * (33 * 1024 * 1024))
        sys.stdout.flush()
        time.sleep(30)
        break
    if req.get("code") in ("big-frame", "unicode-blank-frame"):
        padding = " " * (31 * 1024 * 1024) if req.get("code") == "big-frame" else " \t\r\v\f\u0085\u00a0\u2000\u2028\u2029\u3000 "
        sys.stdout.write(padding + "\n")
        sys.stdout.write(json.dumps({"event": "stdout", "id": req.get("id"), "text": "big"}) + "\n")
    sys.stdout.write(json.dumps({"event": "done", "id": req.get("id"), "status": "ok"}) + "\n")
    sys.stdout.flush()
