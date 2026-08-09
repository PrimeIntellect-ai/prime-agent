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
import signal
import subprocess
import sys
import tempfile
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Any

from numeric_reference import decimal_expm1

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
    except ReplayError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError, MemoryError) as exc:
        raise ReplayError(f"invalid JSON in {path}: {type(exc).__name__}") from exc


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _source_digest(path: Path) -> str:
    """Hash source semantics while ignoring Git's LF/CRLF materialization."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


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


MAX_CORPUS_TASKS = 256
MAX_TEXT_CHARS = 10_000
MAX_EXPRESSION_CHARS = 4_096
MAX_ASSUMPTIONS = 64
MAX_VARIABLES = 64
MAX_SAMPLES = 1_000
MAX_NUMERIC_LADDER = 64
MAX_CONVERGENCE_POINTS = 1_000
MAX_INVARIANT_POINTS = 10_000
MAX_FINITE_MAGNITUDE = 1e100
SYMBOLIC_VERDICTS = frozenset({
    "universally_equivalent", "equivalent_under_assumptions", "not_equivalent",
})
EXPECTED_RESPONSE_CONTRACTS = {
    "convergence": {"observed_order": "finite number"},
    "invariant": {"conserved": "boolean", "relative_drift": "finite number"},
    "numeric": {"values": {"<precision_digits>": "finite decimal string for every requested ladder rung"}},
    "symbolic": {
        "assumptions": ["exact condition strings in the prompt/task; [] if none"],
        "counterexample": {"variable": "finite number; required only for not_equivalent"},
        "verdict": "universally_equivalent | equivalent_under_assumptions | not_equivalent",
    },
}
ROOT_FIELDS = frozenset({
    "schema_version", "corpus_version", "default_seed", "promotion_policy",
    "reference_executor_sha256", "response_contracts", "tasks",
})
COMMON_TASK_FIELDS = frozenset({"id", "category", "prompt"})
CATEGORY_TASK_FIELDS = {
    "symbolic": frozenset({
        "expected_verdict", "lhs", "random_samples", "required_assumptions", "rhs",
        "sample_domain", "trap_samples", "valid_samples",
    }),
    "numeric": frozenset({"max_tolerance_digits", "precisions_digits", "reference"}),
    "convergence": frozenset({"errors", "expected_order", "order_tolerance", "resolutions"}),
    "invariant": frozenset({"report_tolerance", "rtol", "scale_floor", "series"}),
}


def _closed_object(value: Any, label: str, fields: frozenset[str]) -> dict[str, Any]:
    obj = _require_dict(value, label)
    unknown = sorted(set(obj) - fields)
    missing = sorted(fields - set(obj))
    if unknown:
        raise ReplayError(f"{label} has unknown fields: {unknown}")
    if missing:
        raise ReplayError(f"{label} is missing required fields: {missing}")
    return obj


def _bounded_text(value: Any, label: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value) or len(value) > maximum or "\x00" in value:
        qualifier = "possibly empty" if allow_empty else "non-empty"
        raise ReplayError(f"{label} must be a {qualifier} string of at most {maximum} characters without NUL")
    return value



def _validate_expression(value: Any, label: str) -> str:
    expression = _bounded_text(value, label, MAX_EXPRESSION_CHARS)
    try:
        tree = ast.parse(expression, mode="eval")
    except (SyntaxError, RecursionError, ValueError, MemoryError) as exc:
        raise ReplayError(f"{label} expression could not be parsed safely") from exc
    pending: list[tuple[ast.AST, int]] = [(tree, 1)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if count > 512 or depth > 64:
            raise ReplayError(f"{label} expression exceeds the 512-node or 64-level bound")
        children: list[ast.AST]
        if isinstance(node, ast.Expression):
            children = [node.body]
        elif isinstance(node, ast.Constant) and type(node.value) in {int, float}:
            _json_number(node.value, f"{label} constant")
            children = []
        elif isinstance(node, ast.Name):
            _variable_name(node.id, f"{label} variable")
            children = []
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            children = [node.operand]
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            children = [node.left, node.right]
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in ALLOWED_FUNCS
            and len(node.args) == 1
            and not node.keywords
        ):
            children = [node.args[0]]
        else:
            raise ReplayError(f"{label} expression contains unsupported node {type(node).__name__}")
        pending.extend((child, depth + 1) for child in children)
    return expression


def _bounded_identifier(value: Any, label: str, maximum: int) -> str:
    text = _bounded_text(value, label, maximum)
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"
    if any(ch not in allowed for ch in text):
        raise ReplayError(f"{label} contains unsupported characters")
    return text


def _variable_name(value: Any, label: str) -> str:
    text = _bounded_text(value, label, 64)
    if not (text[0].isalpha() or text[0] == "_") or any(not (ch.isalnum() or ch == "_") for ch in text):
        raise ReplayError(f"{label} must be an identifier-like variable name")
    if not text.isascii():
        raise ReplayError(f"{label} must use ASCII variable characters")
    return text


def _json_number(value: Any, label: str, *, positive: bool = False) -> float:
    if type(value) not in {int, float}:
        raise ReplayError(f"{label} must be a JSON number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as exc:
        raise ReplayError(f"{label} must be a representable finite JSON number") from exc
    if not math.isfinite(result) or abs(result) > MAX_FINITE_MAGNITUDE:
        raise ReplayError(f"{label} must be finite with magnitude at most {MAX_FINITE_MAGNITUDE:g}")
    if positive and result <= 0:
        raise ReplayError(f"{label} must be positive")
    return result


def _bounded_number(
    value: Any, label: str, *, lower: float, upper: float,
    lower_inclusive: bool = True, upper_inclusive: bool = True,
) -> float:
    result = _json_number(value, label)
    lower_ok = result >= lower if lower_inclusive else result > lower
    upper_ok = result <= upper if upper_inclusive else result < upper
    if not lower_ok or not upper_ok:
        left = "[" if lower_inclusive else "("
        right = "]" if upper_inclusive else ")"
        raise ReplayError(f"{label} must be in {left}{lower}, {upper}{right}")
    return result


def _bounded_int(value: Any, label: str, lower: int, upper: int) -> int:
    if type(value) is not int or not lower <= value <= upper:
        raise ReplayError(f"{label} must be an integer from {lower} through {upper}")
    return value


def _decimal_string(value: Any, label: str, *, nonzero: bool = False) -> Decimal:
    text = _bounded_text(value, label, 256)
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise ReplayError(f"{label} must be a finite decimal string") from exc
    if not number.is_finite() or abs(number) > Decimal("1e100") or (nonzero and number == 0):
        suffix = " nonzero" if nonzero else ""
        raise ReplayError(f"{label} must be a finite{suffix} decimal string with magnitude at most 1e100")
    return number


def _max_tolerance_digits(value: Any, label: str) -> int:
    return _bounded_int(value, label, 6, 500)


def _order_tolerance(value: Any, label: str) -> float:
    return _bounded_number(value, label, lower=0.0, upper=0.5, lower_inclusive=False)


def _relative_tolerance(value: Any, label: str) -> float:
    return _bounded_number(value, label, lower=0.0, upper=1.0, lower_inclusive=False, upper_inclusive=False)


def _scale_floor(value: Any, label: str) -> float:
    return _bounded_number(value, label, lower=0.0, upper=1.0, lower_inclusive=False)


def _report_tolerance(value: Any, rtol: float, label: str) -> float:
    return _bounded_number(value, label, lower=0.0, upper=rtol, lower_inclusive=False)


def _string_list(value: Any, label: str, maximum_items: int, maximum_chars: int) -> list[str]:
    items = _require_list(value, label)
    if len(items) > maximum_items:
        raise ReplayError(f"{label} may contain at most {maximum_items} items")
    result = [_bounded_text(item, f"{label}[{index}]", maximum_chars) for index, item in enumerate(items)]
    if len(set(result)) != len(result):
        raise ReplayError(f"{label} must not contain duplicates")
    return result


def _sample_point(value: Any, label: str) -> dict[str, float]:
    point = _require_dict(value, label)
    if not 1 <= len(point) <= MAX_VARIABLES:
        raise ReplayError(f"{label} must contain from 1 through {MAX_VARIABLES} variables")
    result: dict[str, float] = {}
    for key, coordinate in point.items():
        name = _variable_name(key, f"{label} variable")
        result[name] = _json_number(coordinate, f"{label}.{name}")
    return result


def _sample_list(value: Any, label: str, *, require_nonempty: bool) -> list[dict[str, float]]:
    samples = _require_list(value, label)
    minimum = 1 if require_nonempty else 0
    if not minimum <= len(samples) <= MAX_SAMPLES:
        raise ReplayError(f"{label} must contain from {minimum} through {MAX_SAMPLES} sample points")
    return [_sample_point(point, f"{label}[{index}]") for index, point in enumerate(samples)]


def _validate_symbolic_task(task: dict[str, Any], label: str) -> None:
    _validate_expression(task["lhs"], f"{label}.lhs")
    _validate_expression(task["rhs"], f"{label}.rhs")
    expected = task["expected_verdict"]
    if expected not in SYMBOLIC_VERDICTS:
        raise ReplayError(f"{label}.expected_verdict must be one of {sorted(SYMBOLIC_VERDICTS)}")
    random_samples = _bounded_int(task["random_samples"], f"{label}.random_samples", 0, MAX_SAMPLES)
    assumptions = _string_list(
        task["required_assumptions"], f"{label}.required_assumptions", MAX_ASSUMPTIONS, 256,
    )
    if expected == "universally_equivalent" and assumptions:
        raise ReplayError(f"{label}.required_assumptions must be empty for universally_equivalent")
    if expected == "equivalent_under_assumptions" and not assumptions:
        raise ReplayError(f"{label}.required_assumptions must be non-empty for equivalent_under_assumptions")

    domain = _require_dict(task["sample_domain"], f"{label}.sample_domain")
    if len(domain) > MAX_VARIABLES:
        raise ReplayError(f"{label}.sample_domain may contain at most {MAX_VARIABLES} variables")
    domain_names: set[str] = set()
    for raw_name, raw_bounds in domain.items():
        name = _variable_name(raw_name, f"{label}.sample_domain variable")
        bounds = _require_list(raw_bounds, f"{label}.sample_domain.{name}")
        if len(bounds) != 2:
            raise ReplayError(f"{label}.sample_domain.{name} requires exactly two bounds")
        low = _json_number(bounds[0], f"{label}.sample_domain.{name}[0]")
        high = _json_number(bounds[1], f"{label}.sample_domain.{name}[1]")
        if not low < high:
            raise ReplayError(f"{label}.sample_domain.{name} lower bound must be below its upper bound")
        domain_names.add(name)
    if random_samples and not domain_names:
        raise ReplayError(f"{label}.sample_domain must be non-empty when random_samples is positive")

    valid = _sample_list(task["valid_samples"], f"{label}.valid_samples", require_nonempty=True)
    traps = _sample_list(task["trap_samples"], f"{label}.trap_samples", require_nonempty=False)
    if expected in {"not_equivalent", "equivalent_under_assumptions"} and not traps:
        raise ReplayError(f"{label}.trap_samples must be non-empty for {expected}")
    sample_names = set(valid[0])
    for index, point in enumerate([*valid, *traps]):
        if set(point) != sample_names:
            raise ReplayError(f"{label} sample point {index} does not use the common variable set")
    if not domain_names.issubset(sample_names):
        raise ReplayError(f"{label}.sample_domain contains variables absent from sample points")
    if random_samples and domain_names != sample_names:
        raise ReplayError(f"{label}.sample_domain must cover every sample variable when random_samples is positive")


def _validate_numeric_reference(value: Any, label: str) -> None:
    reference = _require_dict(value, label)
    algorithm = reference.get("algorithm")
    if algorithm in {"sqrt", "expm1", "log1p"}:
        reference = _closed_object(reference, label, frozenset({"algorithm", "value"}))
        number = _decimal_string(reference["value"], f"{label}.value")
        if algorithm == "sqrt" and number < 0:
            raise ReplayError(f"{label}.value must be non-negative for sqrt")
        if algorithm == "log1p" and number <= -1:
            raise ReplayError(f"{label}.value must be greater than -1 for log1p")
        return
    if algorithm == "product_divide":
        reference = _closed_object(reference, label, frozenset({"algorithm", "factors", "divisor"}))
        factors = _require_list(reference["factors"], f"{label}.factors")
        if not 1 <= len(factors) <= 32:
            raise ReplayError(f"{label}.factors must contain from 1 through 32 decimal strings")
        for index, factor in enumerate(factors):
            _decimal_string(factor, f"{label}.factors[{index}]")
        _decimal_string(reference["divisor"], f"{label}.divisor", nonzero=True)
        return
    raise ReplayError(f"{label}.algorithm is unsupported: {algorithm!r}")


def _validate_numeric_task(task: dict[str, Any], label: str) -> None:
    precisions = _require_list(task["precisions_digits"], f"{label}.precisions_digits")
    if not 3 <= len(precisions) <= MAX_NUMERIC_LADDER:
        raise ReplayError(f"{label}.precisions_digits must contain from 3 through {MAX_NUMERIC_LADDER} rungs")
    checked = [_bounded_int(value, f"{label}.precisions_digits[{index}]", 10, 500) for index, value in enumerate(precisions)]
    if any(before >= after for before, after in zip(checked, checked[1:])):
        raise ReplayError(f"{label}.precisions_digits must be strictly increasing")
    _max_tolerance_digits(task["max_tolerance_digits"], f"{label}.max_tolerance_digits")
    _validate_numeric_reference(task["reference"], f"{label}.reference")


def _number_series(value: Any, label: str, minimum: int, maximum: int, *, positive: bool) -> list[float]:
    items = _require_list(value, label)
    if not minimum <= len(items) <= maximum:
        raise ReplayError(f"{label} must contain from {minimum} through {maximum} numbers")
    return [_json_number(item, f"{label}[{index}]", positive=positive) for index, item in enumerate(items)]


def _validate_convergence_task(task: dict[str, Any], label: str) -> None:
    resolutions = _number_series(
        task["resolutions"], f"{label}.resolutions", 3, MAX_CONVERGENCE_POINTS, positive=True,
    )
    errors = _number_series(task["errors"], f"{label}.errors", 3, MAX_CONVERGENCE_POINTS, positive=True)
    if len(resolutions) != len(errors):
        raise ReplayError(f"{label}.resolutions and {label}.errors must have equal length")
    if any(before >= after for before, after in zip(resolutions, resolutions[1:])):
        raise ReplayError(f"{label}.resolutions must be strictly increasing")
    if any(before <= after for before, after in zip(errors, errors[1:])):
        raise ReplayError(f"{label}.errors must be strictly decreasing")
    expected = _bounded_number(task["expected_order"], f"{label}.expected_order", lower=0.0, upper=100.0, lower_inclusive=False)
    tolerance = _order_tolerance(task["order_tolerance"], f"{label}.order_tolerance")
    observed = sum(_observed_orders(resolutions, errors)) / (len(errors) - 1)
    if not math.isfinite(observed) or abs(observed - expected) > tolerance:
        raise ReplayError(f"{label}.expected_order is inconsistent with the supplied series and tolerance")


def _validate_invariant_task(task: dict[str, Any], label: str) -> None:
    _number_series(task["series"], f"{label}.series", 3, MAX_INVARIANT_POINTS, positive=False)
    rtol = _relative_tolerance(task["rtol"], f"{label}.rtol")
    _report_tolerance(task["report_tolerance"], rtol, f"{label}.report_tolerance")
    _scale_floor(task["scale_floor"], f"{label}.scale_floor")


def load_corpus(path: Path) -> tuple[dict[str, Any], str]:
    corpus = _closed_object(_read_json(path), "corpus", ROOT_FIELDS)
    if type(corpus["schema_version"]) is not int or corpus["schema_version"] != SCHEMA_VERSION:
        raise ReplayError(f"unsupported corpus schema: {corpus['schema_version']!r}")
    _bounded_text(corpus["corpus_version"], "corpus.corpus_version", 64)
    _bounded_int(corpus["default_seed"], "corpus.default_seed", 0, 2**63 - 1)
    reference_digest = corpus["reference_executor_sha256"]
    if type(reference_digest) is not str or len(reference_digest) != 64 or any(ch not in "0123456789abcdef" for ch in reference_digest):
        raise ReplayError("corpus.reference_executor_sha256 must be lowercase SHA-256")

    policy = _closed_object(
        corpus["promotion_policy"], "corpus.promotion_policy",
        frozenset({"minimum_category_rate", "minimum_score_rate", "repetitions"}),
    )
    _bounded_number(
        policy["minimum_category_rate"], "corpus.promotion_policy.minimum_category_rate",
        lower=0.0, upper=1.0, lower_inclusive=False,
    )
    _bounded_number(
        policy["minimum_score_rate"], "corpus.promotion_policy.minimum_score_rate",
        lower=0.0, upper=1.0, lower_inclusive=False,
    )
    _bounded_int(policy["repetitions"], "corpus.promotion_policy.repetitions", 2, 5)

    contracts = _require_dict(corpus["response_contracts"], "corpus.response_contracts")
    if contracts != EXPECTED_RESPONSE_CONTRACTS:
        raise ReplayError("corpus.response_contracts must exactly match the closed response-contract schema")

    tasks = _require_list(corpus["tasks"], "corpus.tasks")
    if not 12 <= len(tasks) <= MAX_CORPUS_TASKS:
        raise ReplayError(f"corpus.tasks must contain from 12 through {MAX_CORPUS_TASKS} tasks")
    seen: set[str] = set()
    categories: set[str] = set()
    for index, raw in enumerate(tasks):
        task = _require_dict(raw, f"corpus.tasks[{index}]")
        task_id = _bounded_identifier(task.get("id"), f"corpus.tasks[{index}].id", 128)
        if task_id in seen:
            raise ReplayError(f"duplicate task id: {task_id}")
        seen.add(task_id)
        category = task.get("category")
        if category not in CATEGORY_TASK_FIELDS:
            raise ReplayError(f"unknown category for {task_id}: {category!r}")
        label = f"corpus.tasks[{index}] ({task_id})"
        _closed_object(task, label, COMMON_TASK_FIELDS | CATEGORY_TASK_FIELDS[category])
        _bounded_text(task["prompt"], f"{label}.prompt", MAX_TEXT_CHARS)
        categories.add(category)
        if category == "symbolic":
            _validate_symbolic_task(task, label)
        elif category == "numeric":
            _validate_numeric_task(task, label)
        elif category == "convergence":
            _validate_convergence_task(task, label)
        else:
            _validate_invariant_task(task, label)
    required = set(CATEGORY_TASK_FIELDS)
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
    if expected not in SYMBOLIC_VERDICTS:
        raise ReplayError(f"task {task['id']} expected_verdict must be one of {sorted(SYMBOLIC_VERDICTS)}")
    assumptions = answer.get("assumptions")
    required = _string_list(task.get("required_assumptions", []), "required_assumptions", MAX_ASSUMPTIONS, 256)
    task_traps = _require_list(task.get("trap_samples", []), "trap_samples")
    if expected in {"not_equivalent", "equivalent_under_assumptions"} and not task_traps:
        raise ReplayError(f"task {task['id']} trap_samples must be non-empty for {expected}")
    contract_ok = verdict == expected and assumptions == required
    valid = _symbolic_samples(task, seed)
    valid_ok = bool(valid) and all(_equivalent_at(task, p) for p in valid)
    traps = task_traps
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
            return decimal_expm1(spec["value"], digits + 14)
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
    max_tolerance_digits = _max_tolerance_digits(
        task.get("max_tolerance_digits", 60), f"task {task['id']} max_tolerance_digits",
    )
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
        tolerance_digits = min(raw_digits - 4, max_tolerance_digits)
        tolerance = Decimal(10) ** Decimal(-tolerance_digits)
        error = abs(candidate - reference)
        threshold = tolerance * abs(reference) if reference != 0 else tolerance
        if error <= threshold:
            passed_count += 1
    return bool(precisions) and passed_count == len(precisions), {
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
    tolerance = _order_tolerance(task.get("order_tolerance", 0.05), "order_tolerance")
    reported = _finite_float(answer.get("observed_order"), "response.observed_order")
    oracle_ok = abs(observed - expected) <= tolerance
    passed = oracle_ok and abs(reported - observed) <= tolerance
    return passed, {"observed_order": round(observed, 12), "oracle_ok": oracle_ok}


def verify_invariant(task: dict[str, Any], response: Any, _seed: int) -> tuple[bool, dict[str, Any]]:
    answer = _require_dict(response, f"response {task['id']}")
    series = [_finite_float(x, "series") for x in _require_list(task.get("series"), "series")]
    if len(series) < 3:
        raise ReplayError(f"invariant series too short for {task['id']}")
    scale_floor = _scale_floor(task.get("scale_floor", 1e-30), "scale_floor")
    scale = max(abs(series[0]), scale_floor)
    drift = max(abs(value - series[0]) for value in series) / scale
    rtol = _relative_tolerance(task.get("rtol"), "rtol")
    conserved = drift <= rtol
    reported_conserved = answer.get("conserved")
    reported_drift = _finite_float(answer.get("relative_drift"), "response.relative_drift")
    report_tolerance = _report_tolerance(
        task.get("report_tolerance", max(rtol * 0.05, 1e-15)), rtol, "report_tolerance",
    )
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


def _executor_command(
    executor: Path,
    version_info: tuple[int, ...] | None = None,
) -> list[str]:
    version = tuple(version_info or sys.version_info)
    command = [sys.executable]
    # -P was added in Python 3.11. Retain the supported 3.10 runtime rather
    # than making every executor fail with "Unknown option" there.
    if version[:2] >= (3, 11):
        command.extend(("-P", "-S", str(executor)))
    else:
        launcher = (
            "import sys;del sys.path[0];import runpy;"
            "runpy.run_path(sys.argv[1],run_name='__main__')"
        )
        command.extend(("-S", "-c", launcher, str(executor)))
    return command


def _terminate_executor_tree(process: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
                creationflags=creationflags,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass


def _run_executor(executor: Path, payload: dict[str, Any], timeout_seconds: float) -> tuple[Any | None, str | None]:
    # Scrub all PYTHON* variables ourselves (what -E would do), then pin the
    # hash seed.  -P retains that seed on 3.11+ while keeping the script
    # directory out of sys.path; unlike -I it does not imply -E.
    environment = {
        key: value for key, value in os.environ.items()
        if not key.upper().startswith("PYTHON")
    }
    environment["PYTHONHASHSEED"] = "0"
    popen_options: dict[str, Any] = {}
    if os.name == "nt":
        popen_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_options["start_new_session"] = True
    try:
        process = subprocess.Popen(
            _executor_command(executor),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            **popen_options,
        )
    except OSError:
        return None, "executor_launch_error"
    try:
        stdout, _stderr = process.communicate(
            input=_canonical(payload), timeout=timeout_seconds
        )
    except subprocess.TimeoutExpired:
        _terminate_executor_tree(process)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            _terminate_executor_tree(process)
        return None, "executor_timeout"
    if process.returncode != 0:
        return None, "executor_nonzero_exit"
    if len(stdout) > 200_000:
        return None, "executor_output_too_large"
    try:
        response = json.loads(
            stdout.decode("utf-8"),
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
        executor_digest = _source_digest(executor)
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
