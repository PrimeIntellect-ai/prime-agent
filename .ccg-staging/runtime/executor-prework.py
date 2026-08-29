#!/usr/bin/env python3
"""Fail-closed executor pre-work validation for the composed-contract P5 gate."""
from __future__ import annotations

import json
import math
import sys


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _safe_relative_path(value: object) -> bool:
    return isinstance(value, str) and bool(value) and not value.startswith("/") and ".." not in value.split("/")


def validate(document: object) -> dict[str, object]:
    if not isinstance(document, dict):
        return {"ok": False, "violations": ["document_not_object"]}
    violations: list[str] = []
    contract = document.get("contractSha256")
    if not isinstance(contract, str) or len(contract) != 64 or any(char not in "0123456789abcdef" for char in contract):
        violations.append("contract_hash_invalid")
    scope_root = document.get("scopeRoot")
    if not isinstance(scope_root, str) or not scope_root:
        violations.append("scope_root_missing")
    allowed_paths = document.get("allowedPaths")
    if not isinstance(allowed_paths, list) or not allowed_paths or not all(_safe_relative_path(item) for item in allowed_paths):
        violations.append("allowed_paths_invalid")
    allowed_effects = document.get("allowedEffects")
    if not isinstance(allowed_effects, list) or not allowed_effects or not all(isinstance(item, str) and item for item in allowed_effects):
        violations.append("allowed_effects_invalid")
    if document.get("providerCredentialed") is not True:
        violations.append("provider_not_credentialed")
    deadline = document.get("deadline")
    now = document.get("now")
    if not _finite_number(deadline) or not _finite_number(now) or float(deadline) <= float(now):
        violations.append("deadline_invalid")
    result: dict[str, object] = {"ok": not violations, "violations": violations}
    if not violations:
        result["effectiveReceipt"] = {
            "contractSha256": contract,
            "scopeRoot": scope_root,
            "allowedPaths": allowed_paths,
            "allowedEffects": allowed_effects,
            "deadline": deadline,
        }
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--input":
        print("usage: executor-prework.py --input JSON", file=sys.stderr)
        return 2
    try:
        document = json.loads(argv[1])
    except json.JSONDecodeError:
        print("input_not_json", file=sys.stderr)
        return 2
    print(json.dumps(validate(document), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
