#!/usr/bin/env python3
"""Fail-closed runtime containment monitor for the composed-contract P5 gate."""
from __future__ import annotations

import json
import math
import sys


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate(document: object) -> dict[str, object]:
    if not isinstance(document, dict):
        return {"contained": False, "violations": ["document_not_object"]}
    violations: list[str] = []
    receipt = document.get("receipt")
    if not isinstance(receipt, dict):
        return {"contained": False, "violations": ["effective_receipt_missing"]}
    allowed_paths = receipt.get("allowedPaths")
    allowed_effects = receipt.get("allowedEffects")
    if not isinstance(allowed_paths, list) or not isinstance(allowed_effects, list):
        return {"contained": False, "violations": ["effective_receipt_invalid"]}
    actual_paths = document.get("actualPaths")
    actual_effects = document.get("actualEffects")
    if not isinstance(actual_paths, list) or not all(isinstance(item, str) for item in actual_paths):
        violations.append("actual_paths_invalid")
    else:
        violations.extend("scope_escape:" + item for item in actual_paths if item not in allowed_paths)
    if not isinstance(actual_effects, list) or not all(isinstance(item, str) for item in actual_effects):
        violations.append("actual_effects_invalid")
    else:
        violations.extend("effect_denied:" + item for item in actual_effects if item not in allowed_effects)
    now = document.get("now")
    deadline = receipt.get("deadline")
    if not _finite_number(now) or not _finite_number(deadline) or float(deadline) <= float(now):
        violations.append("deadline_expired_or_invalid")
    budget_limit = document.get("budgetLimit")
    budget_used = document.get("budgetUsed")
    if not _finite_number(budget_limit) or not _finite_number(budget_used) or float(budget_limit) < 0 or float(budget_used) < 0 or float(budget_used) > float(budget_limit):
        violations.append("budget_exceeded_or_invalid")
    if document.get("kanbanCardPresent") is not True:
        violations.append("kanban_card_missing")
    return {"contained": not violations, "violations": violations}


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--input":
        print("usage: runtime-monitor.py --input JSON", file=sys.stderr)
        return 2
    try:
        document = json.loads(argv[1])
    except json.JSONDecodeError:
        print("input_not_json", file=sys.stderr)
        return 2
    print(json.dumps(evaluate(document), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
