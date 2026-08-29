#!/usr/bin/env python3
"""Deterministic P6 terminal proof for the inert composed-contract candidate."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/evidence/composed-contract-gate/P6-terminal.json"
P5_GATE = PROJECT / ".ccg-staging/gates/P5-runtime-gate.py"
P1_GATE = PROJECT / ".ccg-staging/gates/P1-schema-policy-gate.py"
P6_SOURCE_PATHS = (".ccg-staging/gates/P6-terminal-gate.py",)
PREIMAGE_PATHS = (
    ".ccg-staging/gates/P5-runtime-gate.py",
    ".ccg-staging/runtime/executor-prework.py",
    ".ccg-staging/runtime/runtime-monitor.py",
    ".ccg-staging/runtime/executor-watchdog.py",
    "docs/evidence/composed-contract-gate/P5-runtime.json",
    ".ccg-staging/schemas/parent-envelope.schema.json",
    ".ccg-staging/schemas/task-contract.schema.json",
    ".ccg-staging/schemas/addendum.schema.json",
    ".ccg-staging/schemas/task-event.schema.json",
    ".ccg-staging/gates/P1-schema-policy-gate.py",
    ".ccg-staging/policy/project-policy-profile.json",
    "docs/evidence/composed-contract-gate/P1-schema-policy.json",
)
P6_CHANGE_SURFACE = [
    ".ccg-staging/gates/P6-terminal-gate.py",
    "docs/evidence/composed-contract-gate/P6-terminal.json",
]
TERMINAL_SEQUENCE = [
    "preimages_frozen",
    "executor_self_review_pass",
    "change_surface_proof_pass",
    "role_post_pass",
    "ownership_released",
    "terminal_emitted",
]


class GateFailure(Exception):
    pass


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _require(condition: bool, label: str) -> None:
    if not condition:
        raise GateFailure(label)


def _sha256(path: str) -> str:
    return hashlib.sha256((PROJECT / path).read_bytes()).hexdigest()


def _current_preimages() -> dict[str, str]:
    return {path: _sha256(path) for path in PREIMAGE_PATHS}


def _validate_bundle(evidence: object, preimages: dict[str, str], source_hashes: dict[str, str]) -> None:
    _require(isinstance(evidence, dict), "evidence_not_object")
    _require(evidence.get("stageId") == "P6" and evidence.get("terminal") == "terminal_chain_compiled", "terminal_invalid")
    _require(evidence.get("claimLevel") == "derived_candidate_only", "claim_level_invalid")
    _require(evidence.get("p5GateMarker") == "COMPOSED_P5_G4_G5_RUNTIME_GREEN", "stale_p5_gate")
    _require(evidence.get("p1GateMarker") == "COMPOSED_P1_G0_SCHEMA_GREEN", "p1_repair_gate_missing")
    _require(evidence.get("preimageSha256") == preimages, "preimage_hash_mismatch")
    _require(evidence.get("preimageAggregate") == hashlib.sha256(_canonical(preimages)).hexdigest(), "preimage_aggregate_mismatch")
    _require(evidence.get("sourceSha256") == source_hashes, "source_hash_mismatch")
    _require(evidence.get("selfReview") == {"actor": "ccg-p6-worker", "status": "PASS"}, "self_review_missing_or_invalid")
    _require(evidence.get("changeSurface") == {"actualPaths": P6_CHANGE_SURFACE, "allowedPaths": P6_CHANGE_SURFACE, "status": "PASS"}, "change_surface_invalid")
    _require(evidence.get("rolePost") == {"ownership": "RELEASED", "role": "worker", "status": "PASS"}, "role_post_or_ownership_invalid")
    _require(evidence.get("terminalSequence") == TERMINAL_SEQUENCE, "terminal_before_post_or_sequence_invalid")
    _require(evidence.get("accepted") is False, "acceptance_claim_not_allowed")
    payload = dict(evidence); aggregate = payload.pop("payloadAggregate", None)
    _require(aggregate == hashlib.sha256(_canonical(payload)).hexdigest(), "payload_aggregate_mismatch")


def _run_predecessor(gate: Path, marker: str) -> None:
    completed = subprocess.run([sys.executable, str(gate), "--verify-draft-inputs"], check=False, capture_output=True, text=True)
    _require(completed.returncode == 0 and completed.stdout.strip() == marker, "predecessor_not_green:" + gate.name)


def _synthetic_tests() -> None:
    preimages = {path: "a" * 64 for path in PREIMAGE_PATHS}
    sources = {path: "b" * 64 for path in P6_SOURCE_PATHS}
    valid = {
        "stageId": "P6", "terminal": "terminal_chain_compiled", "claimLevel": "derived_candidate_only",
        "p5GateMarker": "COMPOSED_P5_G4_G5_RUNTIME_GREEN", "p1GateMarker": "COMPOSED_P1_G0_SCHEMA_GREEN",
        "preimageSha256": preimages, "preimageAggregate": hashlib.sha256(_canonical(preimages)).hexdigest(), "sourceSha256": sources,
        "selfReview": {"actor": "ccg-p6-worker", "status": "PASS"},
        "changeSurface": {"actualPaths": P6_CHANGE_SURFACE, "allowedPaths": P6_CHANGE_SURFACE, "status": "PASS"},
        "rolePost": {"ownership": "RELEASED", "role": "worker", "status": "PASS"},
        "terminalSequence": TERMINAL_SEQUENCE, "accepted": False,
    }
    valid["payloadAggregate"] = hashlib.sha256(_canonical(valid)).hexdigest()
    _validate_bundle(valid, preimages, sources)
    mutations = (
        ("missing_preimage", lambda value: value.pop("preimageSha256")),
        ("stale_gate", lambda value: value.update(p5GateMarker="COMPOSED_P5_G4_G5_RUNTIME_RED")),
        ("self_review_missing", lambda value: value["selfReview"].update(status="PENDING")),
        ("out_of_scope_change", lambda value: value["changeSurface"].update(actualPaths=P6_CHANGE_SURFACE + ["packages/forbidden.ts"])),
        ("terminal_before_post", lambda value: value.update(terminalSequence=["terminal_emitted"] + TERMINAL_SEQUENCE[:-1])),
        ("ownership_held", lambda value: value["rolePost"].update(ownership="HELD")),
    )
    for name, mutate in mutations:
        candidate = json.loads(json.dumps(valid)); candidate.pop("payloadAggregate")
        mutate(candidate); candidate["payloadAggregate"] = hashlib.sha256(_canonical(candidate)).hexdigest()
        try:
            _validate_bundle(candidate, preimages, sources)
        except GateFailure:
            continue
        raise GateFailure(name + "_accepted")


def _validate_evidence() -> None:
    try:
        evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GateFailure("p6_evidence_missing_or_invalid") from error
    _validate_bundle(evidence, _current_preimages(), {path: _sha256(path) for path in P6_SOURCE_PATHS})


def main(argv: list[str]) -> int:
    if argv not in (["--verify-draft-inputs"], ["--self-test"]):
        print("usage: P6-terminal-gate.py --verify-draft-inputs|--self-test", file=sys.stderr)
        return 2
    try:
        _run_predecessor(P5_GATE, "COMPOSED_P5_G4_G5_RUNTIME_GREEN")
        _run_predecessor(P1_GATE, "COMPOSED_P1_G0_SCHEMA_GREEN")
        _synthetic_tests()
        _validate_evidence()
    except GateFailure as error:
        print("P6_TERMINAL_RED:" + str(error), file=sys.stderr)
        return 1
    print("COMPOSED_P6_G6_TERMINAL_GREEN" if argv == ["--verify-draft-inputs"] else "P6_TERMINAL_SELF_TEST_GREEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
