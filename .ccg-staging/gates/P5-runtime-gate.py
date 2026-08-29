#!/usr/bin/env python3
"""Deterministic P5 gate for executor pre-work and runtime containment."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
STAGING = Path(__file__).resolve().parents[1]
RUNTIME = STAGING / "runtime"
EVIDENCE = PROJECT / "docs" / "evidence" / "composed-contract-gate" / "P5-runtime.json"
SOURCE_PATHS = (
    ".ccg-staging/runtime/executor-prework.py",
    ".ccg-staging/runtime/runtime-monitor.py",
    ".ccg-staging/runtime/executor-watchdog.py",
    ".ccg-staging/gates/P5-runtime-gate.py",
)


class GateFailure(Exception):
    """Raised when a deterministic containment assertion fails."""


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _call(script_name: str, document: dict[str, object]) -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(RUNTIME / script_name), "--input", json.dumps(document, sort_keys=True, separators=(",", ":"))],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise GateFailure(script_name + " returned " + str(completed.returncode) + ":" + completed.stderr.strip())
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise GateFailure(script_name + " returned invalid JSON") from error
    if not isinstance(result, dict):
        raise GateFailure(script_name + " result is not an object")
    return result


def _require(condition: bool, label: str) -> None:
    if not condition:
        raise GateFailure(label)


def _contains_prefix(result: dict[str, object], prefix: str) -> bool:
    violations = result.get("violations")
    return isinstance(violations, list) and any(isinstance(item, str) and item.startswith(prefix) for item in violations)


def _synthetic_tests() -> None:
    prework = {
        "contractSha256": "a" * 64,
        "scopeRoot": "/isolated/p5",
        "allowedPaths": ["runtime/allowed.py"],
        "allowedEffects": ["project_read", "project_write"],
        "providerCredentialed": True,
        "deadline": 1100,
        "now": 1000,
    }
    receipt_result = _call("executor-prework.py", prework)
    _require(receipt_result.get("ok") is True, "prework_valid_rejected")
    receipt = receipt_result.get("effectiveReceipt")
    _require(isinstance(receipt, dict), "effective_receipt_missing")
    bad_prework = dict(prework)
    bad_prework["contractSha256"] = "bad"
    _require(_call("executor-prework.py", bad_prework).get("ok") is False, "mutated_contract_accepted")
    observation = {
        "receipt": receipt,
        "actualPaths": ["runtime/allowed.py"],
        "actualEffects": ["project_read"],
        "now": 1000,
        "budgetLimit": 10,
        "budgetUsed": 3,
        "kanbanCardPresent": True,
    }
    _require(_call("runtime-monitor.py", observation).get("contained") is True, "contained_runtime_rejected")
    out_of_scope = dict(observation)
    out_of_scope["actualPaths"] = ["runtime/forbidden.py"]
    _require(_contains_prefix(_call("runtime-monitor.py", out_of_scope), "scope_escape:"), "scope_escape_not_detected")
    denied_effect = dict(observation)
    denied_effect["actualEffects"] = ["deployment_mutation"]
    _require(_contains_prefix(_call("runtime-monitor.py", denied_effect), "effect_denied:"), "denied_effect_not_detected")
    expired = dict(observation)
    expired["now"] = 1100
    _require(_contains_prefix(_call("runtime-monitor.py", expired), "deadline_expired_or_invalid"), "expired_deadline_not_detected")
    over_budget = dict(observation)
    over_budget["budgetUsed"] = 11
    _require(_contains_prefix(_call("runtime-monitor.py", over_budget), "budget_exceeded_or_invalid"), "budget_burn_not_detected")
    no_card = dict(observation)
    no_card["kanbanCardPresent"] = False
    _require(_contains_prefix(_call("runtime-monitor.py", no_card), "kanban_card_missing"), "kanban_gap_not_detected")
    watchdog = _call("executor-watchdog.py", {
        "now": 1000,
        "records": [
            {"taskId": "overdue", "deadline": 999, "lastProgressAt": 995, "stallLimitSeconds": 10},
            {"taskId": "stalled", "deadline": 1100, "lastProgressAt": 980, "stallLimitSeconds": 10},
            {"taskId": "fresh", "deadline": 1100, "lastProgressAt": 995, "stallLimitSeconds": 10},
        ],
    })
    _require(_contains_prefix(watchdog, "B4_OVERDUE:overdue"), "overdue_not_detected")
    _require(_contains_prefix(watchdog, "B2_STALLED:stalled"), "stall_not_detected")


def _validate_evidence() -> None:
    try:
        evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GateFailure("p5_evidence_missing_or_invalid") from error
    if not isinstance(evidence, dict):
        raise GateFailure("p5_evidence_not_object")
    _require(evidence.get("stageId") == "P5", "evidence_stage_invalid")
    _require(evidence.get("terminal") == "runtime_containment_compiled", "evidence_terminal_invalid")
    actual_hashes = {path: hashlib.sha256((PROJECT / path).read_bytes()).hexdigest() for path in SOURCE_PATHS}
    _require(evidence.get("sourceSha256") == actual_hashes, "evidence_source_hash_mismatch")
    payload = dict(evidence)
    aggregate = payload.pop("payloadAggregate", None)
    _require(aggregate == hashlib.sha256(_canonical(payload)).hexdigest(), "evidence_payload_aggregate_mismatch")


def main(argv: list[str]) -> int:
    if argv not in (["--verify-draft-inputs"], ["--self-test"]):
        print("usage: P5-runtime-gate.py --verify-draft-inputs|--self-test", file=sys.stderr)
        return 2
    try:
        _synthetic_tests()
        _validate_evidence()
    except GateFailure as error:
        print("P5_RUNTIME_RED:" + str(error), file=sys.stderr)
        return 1
    print("COMPOSED_P5_G4_G5_RUNTIME_GREEN" if argv == ["--verify-draft-inputs"] else "P5_RUNTIME_SELF_TEST_GREEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
