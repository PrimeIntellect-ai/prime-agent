#!/usr/bin/env python3
"""Finite, non-blocking deadline and stall detector for composed-contract P5."""
from __future__ import annotations

import json
import math
import sys


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def detect(document: object) -> dict[str, object]:
    if not isinstance(document, dict) or not _finite_number(document.get("now")):
        return {"ok": False, "violations": ["clock_invalid"]}
    now = float(document["now"])
    records = document.get("records")
    if not isinstance(records, list):
        return {"ok": False, "violations": ["records_invalid"]}
    violations: list[str] = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("taskId"), str) or not record["taskId"]:
            violations.append("record_invalid")
            continue
        task_id = record["taskId"]
        deadline = record.get("deadline")
        last_progress = record.get("lastProgressAt")
        stall_limit = record.get("stallLimitSeconds")
        if not _finite_number(deadline) or not _finite_number(last_progress) or not _finite_number(stall_limit) or float(stall_limit) < 0:
            violations.append("record_timing_invalid:" + task_id)
            continue
        if now > float(deadline):
            violations.append("B4_OVERDUE:" + task_id)
        if now - float(last_progress) > float(stall_limit):
            violations.append("B2_STALLED:" + task_id)
    return {"ok": not violations, "violations": violations}


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--input":
        print("usage: executor-watchdog.py --input JSON", file=sys.stderr)
        return 2
    try:
        document = json.loads(argv[1])
    except json.JSONDecodeError:
        print("input_not_json", file=sys.stderr)
        return 2
    print(json.dumps(detect(document), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
