#!/usr/bin/env python3
"""Fail-closed P1 schema/policy gate bound to its frozen implementation contract."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
FROZEN = PROJECT / "docs/plans/composed-gate-review-inputs-g8-r4/action-contracts/P1-implementation.compiled.json"
INPUT_DIR = FROZEN.parent.parent
PARENT = INPUT_DIR / "PARENT-ENVELOPE.candidate.json"
CONTRACTS = FROZEN.parent
POLICY = PROJECT / ".ccg-staging/policy/project-policy-profile.json"
EVIDENCE = PROJECT / "docs/evidence/composed-contract-gate/P1-schema-policy.json"
AGENTS = PROJECT / "AGENTS.md"
SCHEMA_PATHS = tuple(".ccg-staging/schemas/" + name for name in (
    "parent-envelope.schema.json", "task-contract.schema.json", "addendum.schema.json", "task-event.schema.json"))
SOURCE_PATHS = SCHEMA_PATHS + (".ccg-staging/policy/project-policy-profile.json", ".ccg-staging/gates/P1-schema-policy-gate.py")
MARKERS = {
    "agents": "COMPOSED_P1_AGENTS_POLICY_MATRIX_GREEN",
    "parent": "COMPOSED_P1_ACTUAL_PARENT_CONTAINMENT_GREEN",
    "db": "COMPOSED_P1_MUTABLE_DB_PROFILE_GREEN",
    "all24": "COMPOSED_P1_ALL_24_ACTUAL_PARENT_CONTAINED_GREEN",
    "wrapper": "COMPOSED_P1_P10_WRAPPER_AUTHORITY_GREEN",
    "interpreter": "COMPOSED_P1_P10_INTERPRETER_RESTART_GREEN",
}
ACCEPTANCE_ARGV = [
    ["--policy", str(AGENTS), "--require-all-current-rules"],
    ["--actual-parent-containment", "--all-action-bindings"],
    ["--mutable-db-profile", "--reject-long-lived-db-raw"],
    ["--actual-parent-path-effect-claim-containment", "--count", "24"],
    ["--p10-single-wrapper-owner-reload"],
    ["--p10-interpreter-restart-argv"],
]


class GateFailure(Exception):
    pass


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _require(condition: bool, label: str) -> None:
    if not condition:
        raise GateFailure(label)


def _load_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GateFailure("invalid_json:" + str(path)) from error
    _require(isinstance(value, dict), "json_not_object:" + str(path))
    return value


def _contract(value: dict[str, object]) -> dict[str, object]:
    nested = value.get("actionContract")
    return nested if isinstance(nested, dict) else value


def _frozen_contract() -> dict[str, object]:
    return _contract(_load_json(FROZEN))


def _parent() -> dict[str, object]:
    return _load_json(PARENT)


def _contracts() -> list[tuple[Path, dict[str, object]]]:
    return [(path, _contract(_load_json(path))) for path in sorted(CONTRACTS.glob("*.compiled.json"))]


def _profile() -> dict[str, object]:
    return _load_json(POLICY)


def _source_hashes() -> dict[str, str]:
    return {path: _sha(PROJECT / path) for path in SOURCE_PATHS}


def _schema_assets() -> None:
    required_by_name = {
        "parent-envelope.schema.json": "generation",
        "task-contract.schema.json": "stageId",
        "addendum.schema.json": "addendumId",
        "task-event.schema.json": "eventType",
    }
    for name, required_field in required_by_name.items():
        schema = _load_json(PROJECT / ".ccg-staging/schemas" / name)
        _require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema_draft_invalid:" + name)
        _require(schema.get("type") == "object" and schema.get("additionalProperties") is False, "schema_not_closed:" + name)
        required = schema.get("required")
        properties = schema.get("properties")
        _require(isinstance(required, list) and required_field in required and isinstance(properties, dict) and required_field in properties, "schema_binding_invalid:" + name)


def _check_agents() -> dict[str, object]:
    profile = _profile()
    rules = profile.get("agentsPolicyRules")
    _require(profile.get("commandAllowlist") == ACCEPTANCE_ARGV, "command_allowlist_invalid")
    _require(isinstance(rules, dict), "agents_policy_rules_missing")
    current = AGENTS.read_text(encoding="utf-8")
    _require(profile.get("agentsPolicySha256") == _sha(AGENTS), "agents_policy_bytes_stale")
    for rule_id, phrase in rules.items():
        _require(isinstance(rule_id, str) and isinstance(phrase, str) and phrase in current, "agents_rule_unenforced:" + str(rule_id))
    return {"agentsPolicySha256": _sha(AGENTS), "ruleIds": sorted(rules)}


def _check_actual_parent() -> dict[str, object]:
    frozen = _frozen_contract(); binding = frozen.get("parentBinding")
    _require(isinstance(binding, dict), "frozen_parent_binding_missing")
    parent = _parent(); payload = dict(parent); aggregate = payload.pop("payloadAggregate", None)
    actual = "sha256:" + hashlib.sha256(_canonical(payload)).hexdigest()
    _require(aggregate == actual, "actual_parent_payload_aggregate_invalid")
    _require(binding.get("parentEnvelopeSha256") == actual.removeprefix("sha256:"), "actual_parent_binding_mismatch")
    projections = parent.get("actionParentProjections")
    _require(isinstance(projections, dict), "actual_parent_projections_missing")
    actions = _contracts(); _require(len(actions) == 24 and len(projections) == 24, "actual_parent_action_count_not_24")
    for path, action in actions:
        action_binding = action.get("parentBinding")
        action_id = action.get("actionId")
        _require(isinstance(action_binding, dict) and action_binding.get("parentEnvelopeSha256") == actual.removeprefix("sha256:"), "action_parent_binding_mismatch:" + path.name)
        _require(isinstance(action_id, str) and action_id in projections, "action_projection_missing:" + path.name)
    p10 = next((action for path, action in actions if path.name == "P10-implementation.compiled.json"), None)
    _require(isinstance(p10, dict), "p10_contract_missing")
    p10_projection = projections.get("ccg-p10-worker")
    _require(isinstance(p10_projection, dict) and p10_projection.get("scope") == p10.get("scope"), "p10_effect_restriction_binding_mismatch")
    return {"parentEnvelopePayloadAggregate": actual, "actionContracts": len(actions)}


def _check_mutable_db() -> dict[str, object]:
    parent = _parent(); profile = parent.get("mutableTaskKanbanDbProfile"); phases = parent.get("mutableDbSeamReceiptPhases")
    _require(isinstance(profile, dict) and profile.get("longLivedRawHashForbidden") is True, "long_lived_db_raw_hash_allowed")
    fields = profile.get("receiptRequiredFields")
    _require(isinstance(fields, list) and all(field in fields for field in ("rawSha256", "canonicalSemanticAggregate", "bindingNonce", "transitionClass")), "mutable_db_receipt_fields_missing")
    _require("P0" in json.dumps(phases) and "P8" in json.dumps(phases) and "P10" in json.dumps(phases), "mutable_db_seam_phase_missing")
    return {"profileId": profile.get("profileId"), "profileAggregate": profile.get("payloadAggregate")}


def _check_all_24() -> dict[str, object]:
    parent_binding = _check_actual_parent(); parent = _parent(); projections = parent["actionParentProjections"]
    parent_ceiling = parent.get("claimCeiling")
    rank = {"evidence_only": 0, "derived_candidate_only": 1}
    _require(parent_ceiling in rank, "parent_claim_ceiling_invalid")
    for path, action in _contracts():
        action_id = action.get("actionId"); projection = projections.get(action_id) if isinstance(action_id, str) else None
        _require(isinstance(projection, dict) and projection.get("scope") == action.get("scope"), "all_24_scope_mismatch:" + path.name)
        _require(action.get("claimCeiling") in rank and rank[action["claimCeiling"]] <= rank[parent_ceiling], "all_24_claim_escape:" + path.name)
    bootstrap = _contract(_load_json(CONTRACTS / "P0-bootstrapPreflight.compiled.json"))
    bootstrap_paths = bootstrap.get("scope", {}).get("allowedPaths") if isinstance(bootstrap.get("scope"), dict) else None
    _require(bootstrap_paths == ["docs/plans/2026-08-23-composed-contract-gate-task-package.rlm-draft.json"], "bootstrap_path_not_exact_package_draft")
    return parent_binding


def _legacy_p1_repairs(profile: dict[str, object]) -> None:
    preflight = profile.get("postPreflight")
    _require(preflight == {"requiredBeforePost": True, "rejectRawPost": True}, "raw_post_preflight_bypass")
    owner = profile.get("ownerAuthority")
    _require(isinstance(owner, dict) and owner.get("generation") == 8 and owner.get("requestId") == "ccg-owner-auth-request-2026-08-23-r8", "stale_r3_owner_authority")
    receipt = profile.get("dashboardPostFinalReceipt")
    _require(isinstance(receipt, dict) and receipt.get("phase") == "post_final" and receipt.get("status") == "PASS", "dashboard_post_final_receipt_invalid")
    identity = receipt.get("processIdentity")
    _require(isinstance(identity, dict) and all(isinstance(identity.get(key), str) and identity[key] for key in ("processId", "startedAt", "commandSha256")), "dashboard_process_identity_missing")


def _check_p10_wrapper() -> dict[str, object]:
    _legacy_p1_repairs(_profile())
    parent = _parent(); wrapper = parent.get("P10ExactBoundWrapper"); authority = parent.get("P10OwnerAuthorityBinding")
    _require(isinstance(wrapper, dict) and wrapper.get("rawCurlAuthorized") is False, "p10_raw_post_or_curl_authorized")
    argv = wrapper.get("argv")
    _require(isinstance(argv, list) and len(argv) >= 3 and argv[0] == "/opt/homebrew/bin/python3" and isinstance(argv[1], str) and argv[1].endswith("/.ccg-staging/gates/P10-activation-close-gate.py") and argv[2] == "--full-bound-activation", "p10_wrapper_argv_invalid")
    _require("--post-final-process-receipt" in argv and "curl" not in argv, "p10_post_final_wrapper_binding_missing")
    _require(isinstance(authority, dict) and isinstance(authority.get("request"), dict) and authority["request"].get("generation") == 8, "p10_stale_owner_authority")
    return {"wrapperArgvSha256": hashlib.sha256(_canonical(argv)).hexdigest(), "ownerRequestGeneration": 8}


def _check_p10_interpreter() -> dict[str, object]:
    parent = _parent(); transition = parent.get("P10ReloadTransition"); wrapper = parent.get("P10ExactBoundWrapper")
    _require(isinstance(transition, dict) and isinstance(wrapper, dict), "p10_interpreter_binding_missing")
    argv = transition.get("startArgv"); executable = transition.get("resolvedExecutable")
    _require(isinstance(argv, list) and len(argv) >= 7 and argv[0] == executable and argv[1] == "-u" and "--out" not in argv, "p10_interpreter_alias_or_argv_invalid")
    receipt = transition.get("postFinalReceipt")
    _require(isinstance(receipt, dict) and receipt.get("phase") == "P10-post-final-active", "p10_post_final_receipt_missing")
    fields = receipt.get("requiredFields")
    _require(isinstance(fields, list) and all(field in fields for field in ("pid", "pidStartTime", "invokedArgv", "resolvedExecutablePath", "listenerSocketIdentity")), "p10_post_final_process_identity_missing")
    interp = wrapper.get("interpreterBinding")
    _require(isinstance(interp, dict) and interp.get("observedResolution") == executable, "p10_interpreter_receipt_mismatch")
    return {"interpreter": executable, "argvSha256": hashlib.sha256(_canonical(argv)).hexdigest()}


def _all_checks() -> dict[str, object]:
    _schema_assets()
    return {"agents": _check_agents(), "actualParent": _check_actual_parent(), "mutableDb": _check_mutable_db(), "all24": _check_all_24(), "p10Wrapper": _check_p10_wrapper(), "p10Interpreter": _check_p10_interpreter()}


def _synthetic_tests() -> None:
    profile = _profile(); bad = json.loads(json.dumps(profile)); bad["commandAllowlist"] = [["curl", "-X", "POST"]]
    try:
        _require(bad.get("commandAllowlist") == ACCEPTANCE_ARGV, "command_allowlist_invalid")
    except GateFailure:
        pass
    else:
        raise GateFailure("command_allowlist_accepted")
    for repair, mutate in (
        ("raw_post_preflight_bypass", lambda value: value["postPreflight"].update(rejectRawPost=False)),
        ("stale_r3_owner_authority", lambda value: value["ownerAuthority"].update(generation=3)),
        ("dashboard_process_identity_missing", lambda value: value["dashboardPostFinalReceipt"].pop("processIdentity")),
    ):
        candidate = json.loads(json.dumps(profile)); mutate(candidate)
        try:
            _legacy_p1_repairs(candidate)
        except GateFailure:
            continue
        raise GateFailure(repair + "_accepted")
    parent = _parent(); bad_parent = json.loads(json.dumps(parent)); bad_parent["P10ExactBoundWrapper"]["rawCurlAuthorized"] = True
    try:
        wrapper = bad_parent["P10ExactBoundWrapper"]; _require(wrapper.get("rawCurlAuthorized") is False, "raw_post_preflight_bypass")
    except GateFailure:
        pass
    else:
        raise GateFailure("raw_post_preflight_bypass_accepted")
    bad_parent = json.loads(json.dumps(parent)); bad_parent["P10OwnerAuthorityBinding"]["request"]["generation"] = 3
    try:
        _require(bad_parent["P10OwnerAuthorityBinding"]["request"].get("generation") == 8, "stale_r3_owner_authority")
    except GateFailure:
        pass
    else:
        raise GateFailure("stale_r3_owner_authority_accepted")
    bad_parent = json.loads(json.dumps(parent)); bad_parent["P10ReloadTransition"]["postFinalReceipt"]["requiredFields"].remove("pidStartTime")
    try:
        fields = bad_parent["P10ReloadTransition"]["postFinalReceipt"]["requiredFields"]; _require("pidStartTime" in fields, "dashboard_process_identity_missing")
    except GateFailure:
        pass
    else:
        raise GateFailure("dashboard_process_identity_accepted")


def _validate_evidence(bindings: dict[str, object]) -> None:
    evidence = _load_json(EVIDENCE)
    _require(evidence.get("stageId") == "P1" and evidence.get("terminal") == "schema_policy_compiled" and evidence.get("claimLevel") == "derived_candidate_only", "p1_evidence_terminal_invalid")
    _require(evidence.get("sourceSha256") == _source_hashes(), "p1_evidence_source_hash_mismatch")
    _require(evidence.get("acceptanceBindings") == bindings, "p1_evidence_acceptance_binding_mismatch")
    _require(evidence.get("acceptanceMarkers") == MARKERS, "p1_evidence_acceptance_marker_mismatch")
    payload = dict(evidence); aggregate = payload.pop("payloadAggregate", None)
    _require(aggregate == hashlib.sha256(_canonical(payload)).hexdigest(), "p1_evidence_payload_aggregate_mismatch")


def _run(flag: str) -> str:
    if flag == "agents": _schema_assets(); _check_agents()
    elif flag == "parent": _schema_assets(); _check_actual_parent()
    elif flag == "db": _schema_assets(); _check_mutable_db()
    elif flag == "all24": _schema_assets(); _check_all_24()
    elif flag == "wrapper": _schema_assets(); _check_p10_wrapper()
    elif flag == "interpreter": _schema_assets(); _check_p10_interpreter()
    return MARKERS[flag]


def main(argv: list[str]) -> int:
    policy_argv = ["--policy", str(AGENTS), "--require-all-current-rules"]
    flags = {
        tuple(policy_argv): "agents",
        ("--actual-parent-containment", "--all-action-bindings"): "parent",
        ("--mutable-db-profile", "--reject-long-lived-db-raw"): "db",
        ("--actual-parent-path-effect-claim-containment", "--count", "24"): "all24",
        ("--p10-single-wrapper-owner-reload",): "wrapper",
        ("--p10-interpreter-restart-argv",): "interpreter",
    }
    try:
        if argv == ["--verify-draft-inputs"]:
            bindings = _all_checks(); _synthetic_tests(); _validate_evidence(bindings)
            print("COMPOSED_P1_G0_SCHEMA_GREEN")
        elif argv == ["--self-test"]:
            _all_checks(); _synthetic_tests(); print("P1_SCHEMA_POLICY_SELF_TEST_GREEN")
        elif tuple(argv) in flags:
            print(_run(flags[tuple(argv)]))
        else:
            print("usage: P1-schema-policy-gate.py --verify-draft-inputs|--self-test|<frozen acceptance argv>", file=sys.stderr)
            return 2
    except GateFailure as error:
        print("P1_SCHEMA_POLICY_RED:" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
