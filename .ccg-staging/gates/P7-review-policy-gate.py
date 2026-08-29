#!/usr/bin/env python3
"""Fail-closed P7 review-policy proof for the inert composed-contract candidate."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
INPUT_DIR = PROJECT / "docs/plans/composed-gate-review-inputs-g8-r4"
CONTRACTS = INPUT_DIR / "action-contracts"
PARENT = INPUT_DIR / "PARENT-ENVELOPE.candidate.json"
EVIDENCE = PROJECT / "docs/evidence/composed-contract-gate/P7-review-policy.json"
ADMISSION_RECEIPT = PROJECT / "docs/evidence/composed-contract-gate/P7-reviewer-admission.json"
P6_GATE = PROJECT / ".ccg-staging/gates/P6-terminal-gate.py"
P1_GATE = PROJECT / ".ccg-staging/gates/P1-schema-policy-gate.py"
SELF_PATH = ".ccg-staging/gates/P7-review-policy-gate.py"
REVIEWER_EFFECTS = ["source_read", "project_read", "git_read", "message_receipt"]
REVIEWER_DENIALS = ["project_write", "temp_write", "test_execution", "git_mutation", "runtime_effect", "runtime_read", "service_mutation", "service_read", "thread_read"]
P1_POST_RESTART_FIELDS = [
    "pid", "pidStartTime", "invokedArgv", "invokedArgvRawSha256",
    "resolvedExecutablePath", "resolvedExecutableRawSha256",
    "loadedSourcePath", "loadedSourceRawSha256", "acceptedManifestRawSha256",
    "acceptedDashboardArtifactRawSha256", "listenerHost", "listenerPort",
    "listenerSocketIdentity", "refreshProofRawSha256", "bindingNonce", "payloadAggregate",
]
DAEMON_BINDINGS = {
    "worker": {"actor": "p7-g7-review-policy-goal-executor", "sessionName": "p7-g7-review-policy-goal-executor", "activeSessionId": "621679c63601", "sessionId": "01a04b28-89b7-723a-ae5d-19dc25ba216b"},
    "reviewer": {"actor": "p7-g7-independent-reviewer", "sessionName": "p7-g7-independent-reviewer", "activeSessionId": "fdfd0f257419", "sessionId": "01a04b2f-0729-75f8-887f-2d9879be6d48"},
}
MODEL = "openai-codex/gpt-5.6-terra"
WORKSPACE_NAME = "composed-contract-gate-plan"


class GateFailure(Exception):
    pass


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise GateFailure("missing_or_unreadable:" + path.name) from error


def _require(condition: bool, label: str) -> None:
    if not condition:
        raise GateFailure(label)


def _load_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GateFailure("invalid_or_missing:" + path.name) from error
    _require(isinstance(value, dict), "not_object:" + path.name)
    return value


def _contract(name: str, expected_action_id: str, expected_role: str, expected_claim_ceiling: str) -> tuple[dict[str, object], dict[str, object]]:
    compiled = _load_json(CONTRACTS / name)
    action = compiled.get("actionContract")
    _require(isinstance(action, dict), "action_contract_missing:" + name)
    _require(compiled.get("scopeFrozen") is True and compiled.get("current") is True, "contract_not_frozen:" + name)
    _require(compiled.get("actionContractSha256") == hashlib.sha256(_canonical(action)).hexdigest(), "contract_hash_mismatch:" + name)
    _require(action.get("actionId") == expected_action_id and action.get("role") == expected_role, "contract_identity_mismatch:" + name)
    _require(action.get("stageId") == "P7" and action.get("claimCeiling") == expected_claim_ceiling, "contract_stage_or_claim_mismatch:" + name)
    return compiled, action


def _run_predecessor(path: Path, marker: str, argv: list[str]) -> None:
    completed = subprocess.run([sys.executable, str(path), *argv], check=False, capture_output=True, text=True)
    _require(completed.returncode == 0 and completed.stdout.strip() == marker, "predecessor_not_green:" + path.name)


def _reviewer_policy(parent: dict[str, object], worker: dict[str, object], reviewer: dict[str, object]) -> dict[str, object]:
    worker_scope = worker.get("scope"); reviewer_scope = reviewer.get("scope")
    _require(isinstance(worker_scope, dict) and isinstance(reviewer_scope, dict), "p7_scope_missing")
    _require(worker.get("actionId") != reviewer.get("actionId"), "reviewer_not_independent")
    _require(reviewer_scope.get("allowedEffects") == REVIEWER_EFFECTS, "reviewer_effects_not_read_only")
    denied = reviewer_scope.get("deniedEffects")
    _require(isinstance(denied, list) and all(effect in denied for effect in REVIEWER_DENIALS), "reviewer_denials_incomplete")
    _require("project_write" in worker_scope.get("allowedEffects", []), "worker_implementation_authority_missing")
    projections = parent.get("actionParentProjections")
    _require(isinstance(projections, dict), "parent_projections_missing")
    for action, expected in ((worker, "worker"), (reviewer, "reviewer")):
        action_id = action.get("actionId")
        projection = projections.get(action_id) if isinstance(action_id, str) else None
        _require(isinstance(projection, dict) and projection.get("role") == expected and projection.get("scope") == action.get("scope"), "parent_projection_mismatch:" + expected)
    return {"workerActionId": worker["actionId"], "reviewerActionId": reviewer["actionId"], "reviewerAllowedEffects": REVIEWER_EFFECTS}


def _p1_post_restart_policy(parent: dict[str, object]) -> dict[str, object]:
    transition = parent.get("P10ReloadTransition")
    _require(isinstance(transition, dict), "p1_4_reload_transition_missing")
    receipt = transition.get("postFinalReceipt")
    _require(isinstance(receipt, dict) and receipt.get("phase") == "P10-post-final-active", "p1_4_post_receipt_phase_missing")
    fields = receipt.get("requiredFields")
    _require(isinstance(fields, list) and all(field in fields for field in P1_POST_RESTART_FIELDS), "p1_4_hash_bound_identity_fields_missing")
    _require("listener is 127.0.0.1:60243" in receipt.get("requirements", []), "p1_4_listener_requirement_missing")
    _require("refresh and steady-state proof are from that same PID/socket/source" in receipt.get("requirements", []), "p1_4_same_process_requirement_missing")
    return {"receiptPhase": receipt["phase"], "requiredFields": P1_POST_RESTART_FIELDS}


def _validate_admission_receipt(parent: dict[str, object], worker: dict[str, object], reviewer: dict[str, object], receipt: dict[str, object] | None = None) -> dict[str, object]:
    if receipt is None:
        receipt = _load_json(ADMISSION_RECEIPT)
    _require(receipt.get("stageId") == "P7" and receipt.get("kind") == "reviewer_admission_identity_receipt", "admission_receipt_kind_invalid")
    _require(receipt.get("claimLevel") == "derived_candidate_only", "admission_receipt_claim_invalid")
    _require(receipt.get("parentEnvelopeSha256") == parent.get("payloadAggregate"), "admission_parent_binding_mismatch")
    bindings = receipt.get("actualBindings")
    _require(isinstance(bindings, dict), "admission_actual_bindings_missing")
    expected = {"worker": worker, "reviewer": reviewer}
    normalized: dict[str, dict[str, object]] = {}
    for identity, action in expected.items():
        binding = bindings.get(identity)
        _require(isinstance(binding, dict), "admission_binding_missing:" + identity)
        scope = action.get("scope")
        _require(isinstance(scope, dict), "admission_contract_scope_missing:" + identity)
        _require(binding.get("actionId") == action.get("actionId"), "admission_action_mismatch:" + identity)
        _require(all(binding.get(key) == value for key, value in DAEMON_BINDINGS[identity].items()), "admission_daemon_binding_mismatch:" + identity)
        _require(binding.get("workspaceName") == WORKSPACE_NAME, "admission_workspace_name_mismatch:" + identity)
        _require(binding.get("daemonCwd") == "/Users/ZGH/projects/PA-AGI", "admission_daemon_cwd_mismatch:" + identity)
        _require(binding.get("contractScopeRoot") == scope.get("scopeRoot"), "admission_contract_scope_root_mismatch:" + identity)
        _require(binding.get("provenance") == {"daemonCwd": "controller_daemon_observation", "contractScopeRoot": "action_contract"}, "admission_workspace_provenance_invalid:" + identity)
        _require(binding.get("model") == MODEL, "admission_model_mismatch:" + identity)
        _require(binding.get("role") == action.get("role"), "admission_role_mismatch:" + identity)
        _require(binding.get("scopeSha256") == hashlib.sha256(_canonical(scope)).hexdigest(), "admission_scope_hash_mismatch:" + identity)
        _require(binding.get("actionContractSha256") == hashlib.sha256(_canonical(action)).hexdigest(), "admission_contract_hash_mismatch:" + identity)
        expected_writes = list(scope.get("allowedPaths", [])) if identity == "worker" else []
        _require(binding.get("writeSurface") == expected_writes, "admission_write_surface_mismatch:" + identity)
        normalized[identity] = binding
    _require(normalized["worker"]["actor"] != normalized["reviewer"]["actor"], "admission_actor_not_independent")
    _require(normalized["worker"]["activeSessionId"] != normalized["reviewer"]["activeSessionId"], "admission_active_session_not_independent")
    _require(normalized["worker"]["sessionId"] != normalized["reviewer"]["sessionId"], "admission_session_not_independent")
    _require(receipt.get("sharedFactsPermission") == {"shared": {"model": MODEL, "workspace": WORKSPACE_NAME}, "permittedOnlyBecause": {"reviewerReadOnly": True, "reviewerWriteSurface": [], "distinct": ["actor", "activeSessionId", "sessionId"]}}, "admission_shared_fact_policy_invalid")
    payload = dict(receipt); aggregate = payload.pop("payloadAggregate", None)
    _require(aggregate == hashlib.sha256(_canonical(payload)).hexdigest(), "admission_payload_aggregate_mismatch")
    return normalized


def _validate_evidence(evidence: dict[str, object], parent: dict[str, object], worker: dict[str, object], reviewer: dict[str, object]) -> dict[str, object]:
    _require(evidence.get("stageId") == "P7" and evidence.get("terminal") == "review_policy_compiled", "p7_terminal_invalid")
    _require(evidence.get("claimLevel") == "derived_candidate_only" and evidence.get("accepted") is False, "p7_claim_or_acceptance_invalid")
    source_hashes = evidence.get("sourceSha256")
    _require(source_hashes == {SELF_PATH: _sha256(PROJECT / SELF_PATH)}, "p7_source_hash_mismatch")
    contract_hashes = evidence.get("contractSha256")
    _require(contract_hashes == {"worker": hashlib.sha256(_canonical(worker)).hexdigest(), "reviewer": hashlib.sha256(_canonical(reviewer)).hexdigest()}, "p7_contract_hash_mismatch")
    policy = evidence.get("policy")
    _require(isinstance(policy, dict), "p7_policy_missing")
    _require(policy.get("reviewerAdmission") == {"identityBindings": ["actor", "session", "workspace", "model", "role", "independence"], "readOnly": True, "reviewerNever": ["implement", "accept"]}, "reviewer_admission_policy_invalid")
    _require(policy.get("findings") == {"appendOnly": True, "unresolvedP0P1BlocksAcceptance": True}, "findings_policy_invalid")
    _require(policy.get("rvb") == {"invocation": "conditional_only", "triggers": ["disputed_finding"], "notInvokedFor": ["no_disputed_finding"]}, "rvb_policy_invalid")
    _require(policy.get("controllerAcceptance") == {"actor": "Controller", "action": "gate_decision_only", "requires": ["reviewer_PASS", "unresolved_P0_P1_zero"], "reviewerMayAccept": False}, "controller_policy_invalid")
    _require(evidence.get("predecessor") == {"stageId": "P6", "marker": "COMPOSED_P6_G6_TERMINAL_GREEN"}, "p6_precondition_missing")
    _require(evidence.get("p1Repair") == {"findingId": "P1-4", "status": "preserved", "subject": "hash_bound_post_reload_restart_dashboard_listener_process_identity_receipt"}, "p1_4_repair_binding_invalid")
    _require(evidence.get("reviewerAdmissionReceiptSha256") == _sha256(ADMISSION_RECEIPT), "admission_receipt_hash_mismatch")
    admission = _validate_admission_receipt(parent, worker, reviewer)
    payload = dict(evidence); aggregate = payload.pop("payloadAggregate", None)
    _require(aggregate == hashlib.sha256(_canonical(payload)).hexdigest(), "p7_payload_aggregate_mismatch")
    return {"reviewer": _reviewer_policy(parent, worker, reviewer), "admission": admission, "p1Repair": _p1_post_restart_policy(parent)}


def _verify() -> dict[str, object]:
    _run_predecessor(P6_GATE, "COMPOSED_P6_G6_TERMINAL_GREEN", ["--verify-draft-inputs"])
    _run_predecessor(P1_GATE, "COMPOSED_P1_P10_INTERPRETER_RESTART_GREEN", ["--p10-interpreter-restart-argv"])
    parent = _load_json(PARENT)
    _, worker = _contract("P7-implementation.compiled.json", "ccg-p7-worker", "worker", "derived_candidate_only")
    _, reviewer = _contract("P7-review.compiled.json", "ccg-p7-reviewer", "reviewer", "evidence_only")
    return _validate_evidence(_load_json(EVIDENCE), parent, worker, reviewer)


def _self_test() -> None:
    parent = _load_json(PARENT)
    _, worker = _contract("P7-implementation.compiled.json", "ccg-p7-worker", "worker", "derived_candidate_only")
    _, reviewer = _contract("P7-review.compiled.json", "ccg-p7-reviewer", "reviewer", "evidence_only")
    valid = _load_json(EVIDENCE)
    for label, mutate in (
        ("reviewer_write_accepted", lambda value: value["policy"]["reviewerAdmission"].update(readOnly=False)),
        ("unconditional_rvb_accepted", lambda value: value["policy"].update(rvb={"invocation": "always", "triggers": ["disputed_finding"], "notInvokedFor": []})),
        ("reviewer_acceptance_accepted", lambda value: value["policy"]["controllerAcceptance"].update(reviewerMayAccept=True)),
        ("p1_4_binding_accepted", lambda value: value["p1Repair"].update(status="ignored")),
    ):
        candidate = json.loads(json.dumps(valid)); candidate.pop("payloadAggregate")
        mutate(candidate); candidate["payloadAggregate"] = hashlib.sha256(_canonical(candidate)).hexdigest()
        try:
            _validate_evidence(candidate, parent, worker, reviewer)
        except GateFailure:
            continue
        raise GateFailure(label)
    observed_receipt = _load_json(ADMISSION_RECEIPT)
    for label, mutate in (
        ("shared_session_accepted", lambda value: value["actualBindings"]["reviewer"].update(sessionId=value["actualBindings"]["worker"]["sessionId"])),
        ("reviewer_write_surface_accepted", lambda value: value["actualBindings"]["reviewer"].update(writeSurface=["docs/evidence/composed-contract-gate/P7-review-policy.json"])),
        ("contract_root_as_daemon_cwd_accepted", lambda value: value["actualBindings"]["reviewer"].update(daemonCwd=value["actualBindings"]["reviewer"]["contractScopeRoot"])),
    ):
        candidate = json.loads(json.dumps(observed_receipt)); candidate.pop("payloadAggregate")
        mutate(candidate); candidate["payloadAggregate"] = hashlib.sha256(_canonical(candidate)).hexdigest()
        try:
            _validate_admission_receipt(parent, worker, reviewer, candidate)
        except GateFailure:
            continue
        raise GateFailure(label)
    bad_parent = json.loads(json.dumps(parent))
    bad_parent["P10ReloadTransition"]["postFinalReceipt"]["requiredFields"].remove("listenerSocketIdentity")
    try:
        _p1_post_restart_policy(bad_parent)
    except GateFailure:
        pass
    else:
        raise GateFailure("p1_4_listener_identity_accepted")


def main(argv: list[str]) -> int:
    if argv not in (["--verify-draft-inputs"], ["--self-test"]):
        print("usage: P7-review-policy-gate.py --verify-draft-inputs|--self-test", file=sys.stderr)
        return 2
    try:
        _verify()
        if argv == ["--self-test"]:
            _self_test()
            print("P7_REVIEW_POLICY_SELF_TEST_GREEN")
        else:
            print("COMPOSED_P7_G7_REVIEW_GREEN")
    except GateFailure as error:
        print("P7_REVIEW_POLICY_RED:" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
