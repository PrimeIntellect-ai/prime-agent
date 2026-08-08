#!/usr/bin/env python3
"""Deterministically score Prime Harness evaluation response snapshots.

The runner is intentionally standard-library-only.  It never calls a model:
a snapshot is a provenance-bearing response bundle captured before or after a
Continual Harness refinement.  Objective verifiers in this file score those
responses against the versioned corpus.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MAX_INPUT_BYTES = 4_000_000
ALLOWED_FUNCS = {
    "abs": abs,
    "cos": math.cos,
    "exp": math.exp,
    "log": math.log,
    "sin": math.sin,
    "sqrt": math.sqrt,
}


class ReplayError(ValueError):
    """A deterministic input/contract failure."""


def _reject_json_constant(value: str) -> Any:
    raise ReplayError(f"non-finite JSON constant is forbidden: {value}")


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ReplayError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(path: Path) -> Any:
    try:
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ReplayError(f"input exceeds {MAX_INPUT_BYTES} bytes: {path}")
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_pairs_no_duplicates,
            parse_constant=_reject_json_constant,
        )
    except (OSError, UnicodeError) as exc:
        raise ReplayError(f"cannot read {path}: {type(exc).__name__}") from exc
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ReplayError(f"invalid JSON in {path}: {type(exc).__name__}") from exc


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReplayError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ReplayError(f"{label} must be an array")
    return value


FORBIDDEN_RESPONSE_BUNDLE_KEYS = {"responses", "prepared_responses", "gold_answers", "answer_bundle"}


def _find_response_bundle_key(value: Any, path: str = "snapshot") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key in FORBIDDEN_RESPONSE_BUNDLE_KEYS:
                return child_path
            found = _find_response_bundle_key(child, child_path)
            if found is not None:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = _find_response_bundle_key(child, f"{path}[{index}]")
            if found is not None:
                return found
    return None


def _finite_float(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ReplayError(f"{label} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ReplayError(f"{label} must be a finite number") from exc
    if not math.isfinite(result):
        raise ReplayError(f"{label} must be a finite number")
    return result


def load_corpus(path: Path) -> tuple[dict[str, Any], str]:
    corpus = _require_dict(_read_json(path), "corpus")
    if corpus.get("schema_version") != SCHEMA_VERSION:
        raise ReplayError(f"unsupported corpus schema: {corpus.get('schema_version')!r}")
    if not isinstance(corpus.get("corpus_version"), str) or not corpus["corpus_version"]:
        raise ReplayError("corpus_version must be a non-empty string")
    seed = corpus.get("default_seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        raise ReplayError("default_seed must be a non-negative integer")
    reference_digest = corpus.get("reference_executor_sha256")
    if not isinstance(reference_digest, str) or len(reference_digest) != 64 or any(ch not in "0123456789abcdef" for ch in reference_digest):
        raise ReplayError("reference_executor_sha256 must be lowercase SHA-256")
    tasks = _require_list(corpus.get("tasks"), "corpus.tasks")
    if len(tasks) < 12:
        raise ReplayError("corpus must contain at least 12 tasks")
    seen: set[str] = set()
    categories: set[str] = set()
    for index, raw in enumerate(tasks):
        task = _require_dict(raw, f"tasks[{index}]")
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            raise ReplayError(f"tasks[{index}].id must be non-empty")
        if task_id in seen:
            raise ReplayError(f"duplicate task id: {task_id}")
        seen.add(task_id)
        category = task.get("category")
        if category not in {"symbolic", "numeric", "convergence", "invariant"}:
            raise ReplayError(f"unknown category for {task_id}: {category!r}")
        categories.add(category)
        if not isinstance(task.get("prompt"), str) or not task["prompt"]:
            raise ReplayError(f"task {task_id} has no prompt")
    required = {"symbolic", "numeric", "convergence", "invariant"}
    if categories != required:
        raise ReplayError(f"corpus categories must be exactly {sorted(required)}")
    return corpus, _digest(corpus)


def load_snapshot(path: Path, corpus_digest: str, corpus_seed: int) -> dict[str, Any]:
    snapshot = _require_dict(_read_json(path), "snapshot")
    if snapshot.get("schema_version") != SCHEMA_VERSION:
        raise ReplayError(f"unsupported snapshot schema: {snapshot.get('schema_version')!r}")
    for key in ("snapshot_id", "role", "executor_sha256"):
        if not isinstance(snapshot.get(key), str) or not snapshot[key]:
            raise ReplayError(f"snapshot.{key} must be a non-empty string")
    if snapshot["role"] not in {"baseline", "candidate"}:
        raise ReplayError("snapshot.role must be baseline or candidate")
    digest = snapshot["executor_sha256"]
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        raise ReplayError("snapshot.executor_sha256 must be lowercase SHA-256")
    if snapshot.get("corpus_sha256") != corpus_digest:
        raise ReplayError("snapshot corpus_sha256 does not match the loaded corpus")
    if snapshot.get("seed") != corpus_seed:
        raise ReplayError("snapshot seed does not match corpus default_seed")
    harness_state = _require_dict(snapshot.get("harness_state"), "snapshot.harness_state")
    for scope in ("local", "global"):
        state = _require_dict(harness_state.get(scope), f"snapshot.harness_state.{scope}")
        _require_dict(state.get("entries"), f"snapshot.harness_state.{scope}.entries")
        _require_list(state.get("refinements"), f"snapshot.harness_state.{scope}.refinements")
    forbidden_path = _find_response_bundle_key(snapshot)
    if forbidden_path is not None:
        raise ReplayError(f"snapshots must not contain caller-supplied response bundles ({forbidden_path}); use the executor protocol")
    return snapshot


def _eval_expr_node(node: ast.AST, env: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _eval_expr_node(node.body, env)
    if isinstance(node, ast.Constant) and type(node.value) in {int, float}:
        return float(node.value)
    if isinstance(node, ast.Name) and node.id in env:
        return env[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _eval_expr_node(node.operand, env)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp):
        left = _eval_expr_node(node.left, env)
        right = _eval_expr_node(node.right, env)
        if isinstance(node.op, ast.Add): return left + right
        if isinstance(node.op, ast.Sub): return left - right
        if isinstance(node.op, ast.Mult): return left * right
        if isinstance(node.op, ast.Div): return left / right
        if isinstance(node.op, ast.Pow): return left ** right
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        function = ALLOWED_FUNCS.get(node.func.id)
        if function is not None and len(node.args) == 1 and not node.keywords:
            return float(function(_eval_expr_node(node.args[0], env)))
    raise ReplayError(f"unsupported expression node: {type(node).__name__}")


def _eval_expr(expression: str, env: dict[str, float]) -> tuple[bool, float | None]:
    try:
        tree = ast.parse(expression, mode="eval")
        value = _eval_expr_node(tree, env)
        if not math.isfinite(value):
            return False, None
        return True, value
    except (ReplayError, SyntaxError, ArithmeticError, ValueError, OverflowError):
        return False, None


def _equivalent_at(task: dict[str, Any], values: dict[str, Any]) -> bool:
    env = {str(k): _finite_float(v, f"counterexample.{k}") for k, v in values.items()}
    left_ok, left = _eval_expr(str(task["lhs"]), env)
    right_ok, right = _eval_expr(str(task["rhs"]), env)
    if left_ok != right_ok or not left_ok:
        return False
    assert left is not None and right is not None
    return math.isclose(left, right, rel_tol=1e-10, abs_tol=1e-12)


def _symbolic_samples(task: dict[str, Any], seed: int) -> list[dict[str, float]]:
    samples = [dict(x) for x in _require_list(task.get("valid_samples", []), "valid_samples")]
    domains = _require_dict(task.get("sample_domain", {}), "sample_domain")
    count = task.get("random_samples", 0)
    if not isinstance(count, int) or count < 0 or count > 1000:
        raise ReplayError("random_samples must be an integer from 0 through 1000")
    derived = int.from_bytes(hashlib.sha256(f"{seed}:{task['id']}".encode()).digest()[:8], "big")
    rng = random.Random(derived)
    for _ in range(count):
        point: dict[str, float] = {}
        for variable in sorted(domains):
            bounds = _require_list(domains[variable], f"sample_domain.{variable}")
            if len(bounds) != 2:
                raise ReplayError(f"sample_domain.{variable} requires two bounds")
            low, high = (_finite_float(x, f"sample_domain.{variable}") for x in bounds)
            if not low < high:
                raise ReplayError(f"invalid bounds for {variable}")
            point[variable] = rng.uniform(low, high)
        samples.append(point)
    return samples


def verify_symbolic(task: dict[str, Any], response: Any, seed: int) -> tuple[bool, dict[str, Any]]:
    answer = _require_dict(response, f"response {task['id']}")
    verdict = answer.get("verdict")
    expected = task.get("expected_verdict")
    assumptions = answer.get("assumptions")
    required = task.get("required_assumptions", [])
    contract_ok = verdict == expected and assumptions == required
    valid = _symbolic_samples(task, seed)
    valid_ok = bool(valid) and all(_equivalent_at(task, p) for p in valid)
    traps = _require_list(task.get("trap_samples", []), "trap_samples")
    trap_detected = any(not _equivalent_at(task, p) for p in traps)
    oracle_ok = valid_ok
    if expected in {"not_equivalent", "equivalent_under_assumptions"}:
        oracle_ok = oracle_ok and trap_detected
    if expected == "universally_equivalent" and traps:
        oracle_ok = oracle_ok and not trap_detected
    counterexample_ok = True
    if expected == "not_equivalent":
        counterexample = answer.get("counterexample")
        counterexample_ok = isinstance(counterexample, dict) and not _equivalent_at(task, counterexample)
    passed = contract_ok and oracle_ok and counterexample_ok
    return passed, {
        "contract_ok": contract_ok,
        "counterexample_ok": counterexample_ok,
        "oracle_ok": oracle_ok,
        "samples_checked": len(valid) + len(traps),
    }


def _numeric_reference(spec: dict[str, Any], digits: int) -> Decimal:
    algorithm = spec.get("algorithm")
    with localcontext() as context:
        context.prec = digits + 14
        if algorithm == "sqrt":
            return Decimal(str(spec["value"])).sqrt(context)
        if algorithm == "expm1":
            return Decimal(str(spec["value"])).exp(context) - Decimal(1)
        if algorithm == "log1p":
            return (Decimal(1) + Decimal(str(spec["value"]))).ln(context)
        if algorithm == "product_divide":
            value = Decimal(1)
            for factor in _require_list(spec.get("factors"), "reference.factors"):
                value *= Decimal(str(factor))
            return value / Decimal(str(spec["divisor"]))
    raise ReplayError(f"unsupported numeric algorithm: {algorithm!r}")


def verify_numeric(task: dict[str, Any], response: Any, _seed: int) -> tuple[bool, dict[str, Any]]:
    answer = _require_dict(response, f"response {task['id']}")
    values = _require_dict(answer.get("values"), "response.values")
    precisions = _require_list(task.get("precisions_digits"), "precisions_digits")
    expected_keys = {str(p) for p in precisions}
    if set(values) != expected_keys:
        return False, {"ladder_passed": 0, "ladder_total": len(precisions), "shape_ok": False}
    passed_count = 0
    for raw_digits in precisions:
        if not isinstance(raw_digits, int) or raw_digits < 10 or raw_digits > 500:
            raise ReplayError("precision digits must be integers from 10 through 500")
        try:
            candidate = Decimal(str(values[str(raw_digits)]))
            reference = _numeric_reference(_require_dict(task.get("reference"), "reference"), raw_digits)
        except (InvalidOperation, ValueError) as exc:
            raise ReplayError(f"invalid decimal response for {task['id']}") from exc
        if not candidate.is_finite():
            continue
        tolerance_digits = min(raw_digits - 4, int(task.get("max_tolerance_digits", 60)))
        tolerance = Decimal(10) ** Decimal(-tolerance_digits)
        error = abs(candidate - reference)
        threshold = tolerance * abs(reference) if reference != 0 else tolerance
        if error <= threshold:
            passed_count += 1
    return passed_count == len(precisions), {
        "ladder_passed": passed_count,
        "ladder_total": len(precisions),
        "shape_ok": True,
    }


def _observed_orders(resolutions: list[float], errors: list[float]) -> list[float]:
    return [
        math.log(errors[i] / errors[i + 1]) / math.log(resolutions[i + 1] / resolutions[i])
        for i in range(len(errors) - 1)
    ]


def verify_convergence(task: dict[str, Any], response: Any, _seed: int) -> tuple[bool, dict[str, Any]]:
    answer = _require_dict(response, f"response {task['id']}")
    resolutions = [_finite_float(x, "resolution") for x in _require_list(task.get("resolutions"), "resolutions")]
    errors = [_finite_float(x, "error") for x in _require_list(task.get("errors"), "errors")]
    if len(resolutions) != len(errors) or len(errors) < 3 or any(x <= 0 for x in resolutions + errors):
        raise ReplayError(f"invalid convergence series for {task['id']}")
    if any(resolutions[i] >= resolutions[i + 1] for i in range(len(resolutions) - 1)):
        raise ReplayError(f"resolutions must increase for {task['id']}")
    observed = sum(_observed_orders(resolutions, errors)) / (len(errors) - 1)
    expected = _finite_float(task.get("expected_order"), "expected_order")
    tolerance = _finite_float(task.get("order_tolerance", 0.05), "order_tolerance")
    reported = _finite_float(answer.get("observed_order"), "response.observed_order")
    oracle_ok = abs(observed - expected) <= tolerance
    passed = oracle_ok and abs(reported - observed) <= tolerance
    return passed, {"observed_order": round(observed, 12), "oracle_ok": oracle_ok}


def verify_invariant(task: dict[str, Any], response: Any, _seed: int) -> tuple[bool, dict[str, Any]]:
    answer = _require_dict(response, f"response {task['id']}")
    series = [_finite_float(x, "series") for x in _require_list(task.get("series"), "series")]
    if len(series) < 3:
        raise ReplayError(f"invariant series too short for {task['id']}")
    scale = max(abs(series[0]), float(task.get("scale_floor", 1e-30)))
    drift = max(abs(value - series[0]) for value in series) / scale
    rtol = _finite_float(task.get("rtol"), "rtol")
    conserved = drift <= rtol
    reported_conserved = answer.get("conserved")
    reported_drift = _finite_float(answer.get("relative_drift"), "response.relative_drift")
    report_tolerance = _finite_float(task.get("report_tolerance", max(rtol * 0.05, 1e-15)), "report_tolerance")
    passed = type(reported_conserved) is bool and reported_conserved == conserved and abs(reported_drift - drift) <= report_tolerance
    return passed, {"conserved": conserved, "relative_drift": round(drift, 15)}


VERIFIERS = {
    "symbolic": verify_symbolic,
    "numeric": verify_numeric,
    "convergence": verify_convergence,
    "invariant": verify_invariant,
}


def _challenge(task: dict[str, Any], corpus: dict[str, Any]) -> dict[str, Any]:
    category = task["category"]
    result: dict[str, Any] = {
        "category": category,
        "id": task["id"],
        "prompt": task["prompt"],
        "response_contract": corpus["response_contracts"][category],
    }
    if category == "symbolic":
        result.update({"lhs": task["lhs"], "rhs": task["rhs"]})
    elif category == "numeric":
        result["precisions_digits"] = task["precisions_digits"]
    elif category == "convergence":
        result.update({"errors": task["errors"], "resolutions": task["resolutions"]})
    elif category == "invariant":
        result.update({"rtol": task["rtol"], "scale_floor": task.get("scale_floor", 1e-30), "series": task["series"]})
    return result


def _run_executor(executor: Path, payload: dict[str, Any], timeout_seconds: float) -> tuple[Any | None, str | None]:
    environment = dict(os.environ)
    environment["PYTHONHASHSEED"] = "0"
    try:
        process = subprocess.run(
            [sys.executable, "-I", "-S", str(executor)],
            input=_canonical(payload),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            env=environment,
        )
    except subprocess.TimeoutExpired:
        return None, "executor_timeout"
    except OSError:
        return None, "executor_launch_error"
    if process.returncode != 0:
        return None, "executor_nonzero_exit"
    if len(process.stdout) > 200_000:
        return None, "executor_output_too_large"
    try:
        response = json.loads(
            process.stdout.decode("utf-8"),
            object_pairs_hook=_pairs_no_duplicates,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ReplayError):
        return None, "executor_invalid_json"
    if not isinstance(response, dict):
        return None, "executor_response_not_object"
    return response, None


def score_snapshot(
    corpus: dict[str, Any],
    corpus_digest: str,
    snapshot: dict[str, Any],
    executor: Path,
    executor_digest: str,
    repetitions: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    if snapshot["executor_sha256"] != executor_digest:
        raise ReplayError("snapshot executor_sha256 does not match the trusted executor")
    task_results: list[dict[str, Any]] = []
    category_counts: dict[str, dict[str, int]] = {}
    behavior_digests: dict[str, str | None] = {}
    execution_errors: list[str] = []
    verification_errors: list[str] = []
    unstable: list[str] = []
    state_digest = _digest(snapshot["harness_state"])
    for task in sorted(corpus["tasks"], key=lambda item: item["id"]):
        outputs: list[Any] = []
        errors: list[str] = []
        for repetition in range(repetitions):
            payload = {
                "challenge": _challenge(task, corpus),
                "harness_state": snapshot["harness_state"],
                "harness_state_sha256": state_digest,
                "protocol_version": 1,
                "repetition": repetition,
                "seed": snapshot["seed"],
            }
            response, error = _run_executor(executor, payload, timeout_seconds)
            if error:
                errors.append(error)
            else:
                outputs.append(response)
        stable = len(outputs) == repetitions and all(_canonical(item) == _canonical(outputs[0]) for item in outputs[1:])
        if not stable:
            unstable.append(task["id"])
        if errors:
            execution_errors.append(task["id"])
        passed = False
        details: dict[str, Any] = {"executor_errors": sorted(set(errors)), "stable": stable}
        if outputs and stable and not errors:
            verifier = VERIFIERS[task["category"]]
            try:
                passed, verifier_details = verifier(task, outputs[0], snapshot["seed"])
                details.update(verifier_details)
            except ReplayError:
                verification_errors.append(task["id"])
                details["verifier_error"] = "invalid_response_or_oracle"
                passed = False
            behavior_digests[task["id"]] = _digest(outputs[0])
        else:
            behavior_digests[task["id"]] = None
        task_results.append({"category": task["category"], "details": details, "id": task["id"], "passed": passed})
        counts = category_counts.setdefault(task["category"], {"passed": 0, "total": 0})
        counts["total"] += 1
        counts["passed"] += int(passed)
    passed_total = sum(int(item["passed"]) for item in task_results)
    total = len(task_results)
    result = {
        "behavior_sha256": _digest(behavior_digests),
        "categories": {key: category_counts[key] for key in sorted(category_counts)},
        "corpus_sha256": corpus_digest,
        "execution_errors": sorted(execution_errors),
        "executor_sha256": executor_digest,
        "harness_state_sha256": state_digest,
        "repetitions": repetitions,
        "role": snapshot["role"],
        "score": {"passed": passed_total, "rate": round(passed_total / total, 12), "total": total},
        "snapshot_id": snapshot["snapshot_id"],
        "snapshot_sha256": _digest(snapshot),
        "stable": not unstable and not execution_errors,
        "task_results": task_results,
        "unstable_tasks": sorted(unstable),
        "verification_errors": sorted(verification_errors),
    }
    if snapshot["role"] == "candidate":
        refinement_id = snapshot.get("refinement_id")
        result["refinement_id"] = refinement_id
        result["refinement_event_sha256"] = _refinement_events(snapshot["harness_state"]).get(refinement_id)
        result["parent_snapshot_sha256"] = snapshot.get("parent_snapshot_sha256")
        result["parent_harness_state_sha256"] = snapshot.get("parent_harness_state_sha256")
    return result


def _policy_failures(score: dict[str, Any], corpus: dict[str, Any], require_perfect: bool) -> list[str]:
    policy = _require_dict(corpus.get("promotion_policy"), "corpus.promotion_policy")
    reasons: list[str] = []
    minimum_rate = _finite_float(policy.get("minimum_score_rate"), "minimum_score_rate")
    category_rate = _finite_float(policy.get("minimum_category_rate"), "minimum_category_rate")
    if not 0.0 <= minimum_rate <= 1.0 or not 0.0 <= category_rate <= 1.0:
        raise ReplayError("promotion score thresholds must be between 0 and 1")
    if not score["stable"]:
        reasons.append("behavior execution was unstable or errored")
    if score["verification_errors"]:
        reasons.append("one or more behavior responses failed verifier input contracts")
    if score["score"]["rate"] < minimum_rate:
        reasons.append("score is below the corpus promotion threshold")
    for category, counts in score["categories"].items():
        if counts["passed"] / counts["total"] < category_rate:
            reasons.append(f"category {category} is below its promotion threshold")
    if require_perfect and score["score"]["passed"] != score["score"]["total"]:
        reasons.append("perfect score was required")
    return reasons


def _refinement_events(harness_state: dict[str, Any]) -> dict[str, str]:
    local = _require_dict(harness_state.get("local"), "harness_state.local")
    events = _require_list(local.get("refinements", []), "harness_state.local.refinements")
    result: dict[str, str] = {}
    for event in events:
        event_id = event if isinstance(event, str) else event.get("id") if isinstance(event, dict) else None
        if not isinstance(event_id, str) or not event_id:
            raise ReplayError("each local refinement history event must have a non-empty id")
        if event_id in result:
            raise ReplayError(f"duplicate local refinement history id: {event_id}")
        result[event_id] = _digest(event)
    return result


def compare_snapshots(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    baseline_score: dict[str, Any],
    candidate_score: dict[str, Any],
    corpus: dict[str, Any],
    require_perfect: bool,
) -> dict[str, Any]:
    errors: list[str] = []
    if baseline["role"] != "baseline": errors.append("baseline bundle role is not baseline")
    if candidate["role"] != "candidate": errors.append("candidate bundle role is not candidate")
    if baseline["executor_sha256"] != candidate["executor_sha256"]: errors.append("executor digests differ")
    if candidate["snapshot_id"] == baseline["snapshot_id"]: errors.append("snapshot ids are identical")
    baseline_state_digest = _digest(baseline["harness_state"])
    if _digest(candidate["harness_state"]) == baseline_state_digest: errors.append("harness states are identical")
    refinement_id = candidate.get("refinement_id")
    if not isinstance(refinement_id, str) or not refinement_id:
        errors.append("candidate refinement_id is missing")
    elif len(refinement_id) > 128 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for ch in refinement_id):
        errors.append("candidate refinement_id has invalid characters or length")
    elif refinement_id not in _refinement_events(candidate["harness_state"]):
        errors.append("candidate refinement_id is absent from local refinement history")
    baseline_local = baseline["harness_state"]["local"]
    candidate_local = candidate["harness_state"]["local"]
    baseline_history = baseline_local["refinements"]
    candidate_history = candidate_local["refinements"]
    if len(candidate_history) != len(baseline_history) + 1:
        errors.append("candidate local refinement history must append exactly one event")
    elif any(_canonical(before) != _canonical(after) for before, after in zip(baseline_history, candidate_history[:-1])):
        errors.append("candidate local refinement history does not preserve baseline events")
    else:
        new_event = candidate_history[-1]
        if not isinstance(new_event, dict) or new_event.get("id") != refinement_id:
            errors.append("candidate appended event does not match refinement_id")
        elif not isinstance(new_event.get("changes"), list) or not new_event["changes"] or not all(isinstance(item, str) and item for item in new_event["changes"]):
            errors.append("candidate appended refinement event has no concrete changes")
        elif not isinstance(new_event.get("created_at"), str) or not new_event["created_at"]:
            errors.append("candidate appended refinement event has no created_at provenance")
    baseline_local_content = {key: value for key, value in baseline_local.items() if key != "refinements"}
    candidate_local_content = {key: value for key, value in candidate_local.items() if key != "refinements"}
    if _canonical(candidate_local_content) == _canonical(baseline_local_content):
        errors.append("candidate has no local harness change beyond its history event")
    if _canonical(candidate["harness_state"]["global"]) != _canonical(baseline["harness_state"]["global"]):
        errors.append("local refinement candidate changed global harness state")
    if candidate.get("parent_snapshot_sha256") != _digest(baseline):
        errors.append("candidate parent_snapshot_sha256 does not bind the baseline bundle")
    if candidate.get("parent_harness_state_sha256") != baseline_state_digest:
        errors.append("candidate parent_harness_state_sha256 does not bind baseline state")
    errors.extend(f"baseline: {reason}" for reason in _policy_failures(baseline_score, corpus, require_perfect))
    errors.extend(f"candidate: {reason}" for reason in _policy_failures(candidate_score, corpus, require_perfect))
    baseline_by_id = {item["id"]: item for item in baseline_score["task_results"]}
    candidate_by_id = {item["id"]: item for item in candidate_score["task_results"]}
    regressions = sorted(task_id for task_id in baseline_by_id if baseline_by_id[task_id]["passed"] and not candidate_by_id[task_id]["passed"])
    improvements = sorted(task_id for task_id in baseline_by_id if not baseline_by_id[task_id]["passed"] and candidate_by_id[task_id]["passed"])
    delta = candidate_score["score"]["passed"] - baseline_score["score"]["passed"]
    eligible = not errors and not regressions and delta >= 0
    return {
        "eligible_for_promotion": eligible,
        "errors": errors,
        "improvements": improvements,
        "passed_delta": delta,
        "regressions": regressions,
        "verdict": "pass" if eligible else "fail",
    }


def build_report(
    corpus_path: Path,
    snapshot_path: Path | None,
    baseline_path: Path | None,
    candidate_path: Path | None,
    executor: Path,
    *,
    require_perfect: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    corpus, corpus_digest = load_corpus(corpus_path)
    seed = corpus["default_seed"]
    policy = _require_dict(corpus.get("promotion_policy"), "corpus.promotion_policy")
    repetitions = policy.get("repetitions")
    if not isinstance(repetitions, int) or isinstance(repetitions, bool) or not 2 <= repetitions <= 5:
        raise ReplayError("promotion_policy.repetitions must be an integer from 2 through 5")
    try:
        executor_digest = hashlib.sha256(executor.read_bytes()).hexdigest()
    except OSError as exc:
        raise ReplayError(f"cannot read executor: {exc}") from exc
    common = {
        "corpus": {"sha256": corpus_digest, "task_count": len(corpus["tasks"]), "version": corpus["corpus_version"]},
        "executor_sha256": executor_digest,
        "schema_version": SCHEMA_VERSION,
        "seed": seed,
    }
    if snapshot_path is not None:
        snapshot = load_snapshot(snapshot_path, corpus_digest, seed)
        scored = score_snapshot(corpus, corpus_digest, snapshot, executor, executor_digest, repetitions, timeout_seconds)
        reasons = _policy_failures(scored, corpus, require_perfect)
        decision = {"passed": not reasons, "reasons": reasons, "verdict": "pass" if not reasons else "fail"}
        return {**common, "decision": decision, "mode": "single", "snapshot": scored, "status": decision["verdict"]}
    if baseline_path is None or candidate_path is None:
        raise ReplayError("comparison mode requires both --baseline and --candidate")
    if executor_digest == corpus["reference_executor_sha256"]:
        raise ReplayError("the checked-in reference executor cannot be used for comparison")
    if executor.parent.name == "executors" and executor.parent.parent.name == "evalset":
        raise ReplayError("executors from the corpus reference directory cannot be used for comparison")
    baseline = load_snapshot(baseline_path, corpus_digest, seed)
    candidate = load_snapshot(candidate_path, corpus_digest, seed)
    baseline_score = score_snapshot(corpus, corpus_digest, baseline, executor, executor_digest, repetitions, timeout_seconds)
    candidate_score = score_snapshot(corpus, corpus_digest, candidate, executor, executor_digest, repetitions, timeout_seconds)
    comparison = compare_snapshots(baseline, candidate, baseline_score, candidate_score, corpus, require_perfect)
    return {
        **common,
        "baseline": baseline_score,
        "candidate": candidate_score,
        "comparison": comparison,
        "mode": "comparison",
        "status": comparison["verdict"],
    }


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _confine_paths(
    repo_root: Path,
    corpus: Path,
    snapshot: Path | None,
    baseline: Path | None,
    candidate: Path | None,
    executor: Path,
    output: Path | None,
) -> None:
    root = repo_root.resolve()
    if os.path.normcase(str(root)) != os.path.normcase(str(Path.cwd().resolve())):
        raise ReplayError("repo-root must be the current working repository")
    expected_script = (root / "harness" / "replay.py").resolve()
    if os.path.normcase(str(Path(__file__).resolve())) != os.path.normcase(str(expected_script)):
        raise ReplayError("executing replay.py is not anchored inside repo-root")
    try:
        git_probe = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReplayError("cannot validate repo-root with git") from exc
    if git_probe.returncode != 0:
        raise ReplayError("repo-root must be an actual Git repository or worktree")
    git_root = Path(git_probe.stdout.strip()).resolve()
    if os.path.normcase(str(git_root)) != os.path.normcase(str(root)):
        raise ReplayError("repo-root does not match git rev-parse --show-toplevel")
    expected_corpus = (root / "checks" / "evalset" / "corpus.json").resolve()
    if corpus.resolve() != expected_corpus:
        raise ReplayError("corpus must be the repository checks/evalset/corpus.json")
    snapshot_roots = [(root / "checks" / "evalset" / "snapshots").resolve(), (root / "artifacts" / "harness" / "replay").resolve()]
    for label, path in (("snapshot", snapshot), ("baseline", baseline), ("candidate", candidate)):
        if path is not None and not any(_inside(path.resolve(), allowed) for allowed in snapshot_roots):
            raise ReplayError(f"{label} path is outside confined replay roots")
    executor_resolved = executor.resolve()
    reference_root = (root / "checks" / "evalset" / "executors").resolve()
    behavior_root = (root / "harness" / "replay_adapters").resolve()
    if baseline is not None:
        if not _inside(executor_resolved, behavior_root):
            raise ReplayError("comparison executor must be under harness/replay_adapters")
    elif not (_inside(executor_resolved, reference_root) or _inside(executor_resolved, behavior_root)):
        raise ReplayError("executor is outside confined adapter roots")
    if output is not None:
        output_root = (root / "artifacts" / "harness" / "replay").resolve()
        if not _inside(output.resolve(), output_root):
            raise ReplayError("output path must be under artifacts/harness/replay")


def _write_report(report: dict[str, Any], output: Path | None) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if output is None:
        sys.stdout.write(payload)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{output.name}.",
            suffix=".tmp",
            dir=output.parent,
            delete=False,
        ) as handle:
            handle.write(payload)
            temporary = Path(handle.name)
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--corpus", type=Path, default=Path("checks/evalset/corpus.json"))
    parser.add_argument("--executor", required=True, type=Path, help="trusted behavior adapter; responses are never accepted in snapshots")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--snapshot", type=Path)
    mode.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path, help="required with --baseline")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-perfect", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    args = parser.parse_args(argv)
    if (args.baseline is None) != (args.candidate is None):
        parser.error("--baseline and --candidate must be used together")
    if not 0.1 <= args.timeout_seconds <= 300:
        parser.error("--timeout-seconds must be from 0.1 through 300")
    output_is_confined = False
    try:
        _confine_paths(args.repo_root, args.corpus, args.snapshot, args.baseline, args.candidate, args.executor, args.output)
        output_is_confined = True
        report = build_report(
            args.corpus, args.snapshot, args.baseline, args.candidate, args.executor,
            require_perfect=args.require_perfect, timeout_seconds=args.timeout_seconds,
        )
        _write_report(report, args.output)
    except ReplayError as exc:
        if output_is_confined and args.output is not None:
            args.output.unlink(missing_ok=True)
        print(f"replay input error: {exc}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, InvalidOperation, ArithmeticError) as exc:
        if output_is_confined and args.output is not None:
            args.output.unlink(missing_ok=True)
        print(f"replay input error: malformed replay data ({type(exc).__name__})", file=sys.stderr)
        return 2
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
