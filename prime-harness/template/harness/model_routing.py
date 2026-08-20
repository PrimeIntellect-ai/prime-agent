#!/usr/bin/env python3
"""Score confined, content-bound child responses using a versioned evalset."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from decimal import Decimal
from pathlib import Path
from typing import Any

from numeric_reference import decimal_expm1

SUPPORTED_TASKS = (
    "sym-sqrt-square-sign",
    "num-expm1-cancellation",
    "conv-fourth-order",
    "inv-zero-momentum",
    "audit-swallowed-mismatch",
    "provenance-task-scope",
)


def _default_evalset() -> Path:
    return Path(__file__).resolve().parents[1] / "checks/evalset/model-routing-v1.json"


def _load_evalset(path: str | Path | None = None):
    evalset_path = Path(path) if path else _default_evalset()
    raw = evalset_path.read_bytes()
    data = json.loads(raw)
    tasks = tuple(item["id"] for item in data["tasks"])
    if set(tasks) != set(SUPPORTED_TASKS) or len(tasks) != len(set(tasks)):
        raise ValueError("evalset task IDs do not exactly match supported scoring oracles")

    roles = data.get("role_weights", {})
    if not isinstance(roles, dict) or not roles:
        raise ValueError("evalset role_weights must be non-empty")
    minimum_tasks = data.get("minimum_tasks_per_candidate")
    if type(minimum_tasks) is not int or not 3 <= minimum_tasks <= len(tasks):
        raise ValueError("invalid evalset minimum_tasks_per_candidate")
    for role, weights in roles.items():
        total = sum(float(value) for value in weights.values())
        if set(weights) - set(tasks) or abs(total - 1) > 1e-12:
            raise ValueError(f"invalid role weights: {role}")

    minimum_overall = float(data.get("minimum_overall_score", 0.75))
    if not 0 <= minimum_overall <= 1:
        raise ValueError("invalid minimum_overall_score")
    minimum_role = float(data.get("minimum_role_score", 0.5))
    if not 0 <= minimum_role <= 1:
        raise ValueError("invalid minimum_role_score")
    return (
        data,
        tasks,
        roles,
        minimum_tasks,
        minimum_overall,
        minimum_role,
        hashlib.sha256(raw).hexdigest(),
    )


def _answer(answers: dict[str, Any], task: str) -> tuple[Any, bool]:
    if task in answers:
        return answers[task], True
    target = task.replace("-", "_")
    for key, value in answers.items():
        normalized = str(key)
        if normalized[:1].isdigit() and "_" in normalized:
            normalized = normalized.split("_", 1)[1]
        if normalized == target:
            return value, False
    return None, False


def _expm1() -> Decimal:
    return decimal_expm1("1e-20", 120)


def _numeric(answer: Any) -> float:
    if not isinstance(answer, dict) or not isinstance(answer.get("values"), dict):
        return 0.0
    reference = _expm1()
    scores: list[float] = []
    for digits in (18, 36, 72):
        try:
            observed = Decimal(str(answer["values"][str(digits)]))
            tolerance = Decimal(10) ** Decimal(-min(digits - 2, 60))
            scores.append(float(abs((observed - reference) / reference) <= tolerance))
        except Exception:
            scores.append(0.0)
    return sum(scores) / 3


def score_answers(answers: dict[str, Any]) -> dict[str, float]:
    scores: dict[str, float] = {}
    answer, _exact = _answer(answers, SUPPORTED_TASKS[0])
    scores[SUPPORTED_TASKS[0]] = float(
        isinstance(answer, dict)
        and answer.get("verdict") == "equivalent_under_assumptions"
        and answer.get("assumptions") == ["x >= 0"]
    )

    answer, _exact = _answer(answers, SUPPORTED_TASKS[1])
    scores[SUPPORTED_TASKS[1]] = _numeric(answer)

    answer, _exact = _answer(answers, SUPPORTED_TASKS[2])
    try:
        scores[SUPPORTED_TASKS[2]] = float(abs(float(answer["observed_order"]) - 4) <= 0.03)
    except Exception:
        scores[SUPPORTED_TASKS[2]] = 0.0

    answer, _exact = _answer(answers, SUPPORTED_TASKS[3])
    try:
        scores[SUPPORTED_TASKS[3]] = float(
            answer.get("conserved") is True
            and abs(float(answer["relative_drift"]) - 2e-14) <= 1e-15
        )
    except Exception:
        scores[SUPPORTED_TASKS[3]] = 0.0

    answer, _exact = _answer(answers, SUPPORTED_TASKS[4])
    claim = str(answer.get("claim", "")).casefold() if isinstance(answer, dict) else ""
    scores[SUPPORTED_TASKS[4]] = float(
        isinstance(answer, dict)
        and str(answer.get("severity", "")).casefold() in {"critical", "major"}
        and any(term in claim for term in ("mismatch", "hash", "digest"))
        and any(term in claim for term in ("pass", "success", "accept"))
        and bool(answer.get("falsification_test"))
    )

    answer, _exact = _answer(answers, SUPPORTED_TASKS[5])
    scores[SUPPORTED_TASKS[5]] = float(
        isinstance(answer, dict)
        and answer.get("supporting_ids") == ["e1"]
        and answer.get("rejected_ids") == ["e2"]
        and "task" in str(answer.get("reason", "")).casefold()
    )
    return scores


def _is_link_like(path: Path) -> bool:
    try:
        metadata = os.lstat(path)
    except OSError:
        return False
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


def _confined_response_path(root: Path, relative_value: str) -> tuple[Path, Path]:
    relative = Path(relative_value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("response_path must be confined and relative")
    unresolved = root
    for component in relative.parts:
        unresolved = unresolved / component
        if _is_link_like(unresolved):
            raise ValueError("response_path must be a regular file without links")
    path = unresolved.resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("response_path escapes response_root") from exc
    if path.is_symlink() or not path.is_file():
        raise ValueError("response_path must be a regular file")
    return relative, path


def score_manifest(
    manifest: dict[str, Any],
    evalset_path: str | Path | None = None,
) -> dict[str, Any]:
    (
        _evalset,
        tasks,
        roles,
        minimum_tasks,
        minimum_overall,
        minimum_role,
        evalset_hash,
    ) = _load_evalset(evalset_path)
    root = Path(manifest["response_root"]).resolve()
    candidates: list[dict[str, Any]] = []

    for item in manifest.get("candidates", []):
        relative, path = _confined_response_path(root, item["response_path"])
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        claimed_digest = item.get("sha256")
        if (
            not isinstance(claimed_digest, str)
            or len(claimed_digest) != 64
            or any(character not in "0123456789abcdef" for character in claimed_digest)
        ):
            raise ValueError("response sha256 is required as lowercase hexadecimal")
        if claimed_digest != digest:
            raise ValueError("response sha256 mismatch")
        payload = json.loads(raw)
        answers = payload.get("evidence", {}).get("answers", {})
        scores = score_answers(answers)
        recognized = sum(_answer(answers, task)[0] is not None for task in tasks)
        exact_contract_rate = sum(task in answers for task in tasks) / len(tasks)
        overall_score = sum(scores[task] for task in tasks) / len(tasks)
        role_scores = {
            role: sum(scores[task] * float(weight) for task, weight in weights.items())
            for role, weights in roles.items()
        }
        candidates.append({
            "selector": item["selector"],
            "response_path": relative.as_posix(),
            "response_sha256": digest,
            "tasks_attempted": recognized,
            "task_scores": scores,
            "exact_contract_rate": exact_contract_rate,
            "overall_score": overall_score,
            "role_scores": role_scores,
        })

    candidates.sort(
        key=lambda candidate: (
            -candidate["overall_score"],
            -candidate["exact_contract_rate"],
            candidate["selector"],
        )
    )
    routes: list[dict[str, Any]] = []
    unqualified_roles: list[str] = []
    for role in roles:
        ranked = sorted(
            candidates,
            key=lambda candidate: (
                -candidate["role_scores"][role],
                -candidate["overall_score"],
                -candidate["exact_contract_rate"],
                candidate["selector"],
            ),
        )
        qualified = [
            candidate for candidate in ranked
            if candidate["role_scores"][role] >= minimum_role
        ]
        if not qualified:
            unqualified_roles.append(role)
            continue
        routes.append({
            "role": role,
            "selector": qualified[0]["selector"],
            "measured_score": qualified[0]["role_scores"][role],
            "fallbacks": [candidate["selector"] for candidate in qualified[1:3]],
        })

    candidates_qualified = bool(candidates) and all(
        candidate["tasks_attempted"] >= minimum_tasks
        and candidate["overall_score"] >= minimum_overall
        for candidate in candidates
    )
    status = "pass" if candidates_qualified and not unqualified_roles else "fail"
    if status != "pass":
        routes = []
    return {
        "schema_version": 1,
        "status": status,
        "evalset_sha256": evalset_hash,
        "evalset_tasks": list(tasks),
        "minimum_tasks_per_candidate": minimum_tasks,
        "minimum_overall_score": minimum_overall,
        "minimum_role_score": minimum_role,
        "unqualified_roles": unqualified_roles,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "routing_table": routes,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--evalset")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result = score_manifest(manifest, args.evalset)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": result["status"],
        "output": args.output,
        "candidates": result["candidate_count"],
    }, sort_keys=True))
    return 0 if result["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
