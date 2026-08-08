from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "template/harness/model_routing.py"
if str(SOURCE.parent) not in sys.path:
    sys.path.insert(0, str(SOURCE.parent))
SPEC = importlib.util.spec_from_file_location("routing_tested", SOURCE)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)


def answers():
    return {
        "sym-sqrt-square-sign": {
            "verdict": "equivalent_under_assumptions",
            "assumptions": ["x >= 0"],
        },
        "num-expm1-cancellation": {
            "values": {
                "18": "1e-20",
                "36": "1.000000000000000000005e-20",
                "72": "1.00000000000000000000500000000000000000001666666666666666666666666666667e-20",
            },
        },
        "conv-fourth-order": {"observed_order": 4},
        "inv-zero-momentum": {"conserved": True, "relative_drift": 2e-14},
        "audit-swallowed-mismatch": {
            "severity": "critical",
            "claim": "mismatch returns pass",
            "falsification_test": "mismatch",
        },
        "provenance-task-scope": {
            "supporting_ids": ["e1"],
            "rejected_ids": ["e2"],
            "reason": "task id",
        },
    }


def write_response(path: Path, response_answers=None) -> None:
    payload = {"evidence": {"answers": response_answers or answers()}}
    path.write_text(json.dumps(payload), encoding="utf-8")


def bound_candidate(path: Path, selector: str = "m") -> dict[str, str]:
    return {
        "selector": selector,
        "response_path": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def test_perfect_scores_and_routes(tmp_path):
    write_response(tmp_path / "r.json")
    result = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "r.json")],
    })
    assert result["status"] == "pass"
    assert result["candidates"][0]["overall_score"] == 1
    assert all(route["selector"] == "m" for route in result["routing_table"])


def test_wrong_numeric_and_prefixed_contract_are_measured(tmp_path):
    candidate_answers = answers()
    candidate_answers["num-expm1-cancellation"]["values"]["36"] = "1e-20"
    candidate_answers = {
        f"{index}_{key.replace('-', '_')}": value
        for index, (key, value) in enumerate(candidate_answers.items(), 1)
    }
    write_response(tmp_path / "r.json", candidate_answers)
    result = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "r.json")],
    })
    candidate = result["candidates"][0]
    assert candidate["task_scores"]["num-expm1-cancellation"] < 1
    assert candidate["exact_contract_rate"] == 0


def test_empty_and_arbitrary_answers_fail_cleanly(tmp_path):
    write_response(tmp_path / "r.json", {"junk": {}, "x": {}, "y": {}})
    result = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "r.json")],
    })
    assert result["status"] == "fail"
    assert result["candidates"][0]["tasks_attempted"] == 0
    assert mod.score_manifest({"response_root": str(tmp_path), "candidates": []})["status"] == "fail"


def test_role_floor_filters_unqualified_fallbacks_and_fails_missing_role(tmp_path):
    write_response(tmp_path / "good.json")
    weak_answers = answers()
    weak_answers["audit-swallowed-mismatch"] = {}
    write_response(tmp_path / "weak.json", weak_answers)
    both = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [
            bound_candidate(tmp_path / "good.json", "good"),
            bound_candidate(tmp_path / "weak.json", "weak"),
        ],
    })
    route = next(
        item for item in both["routing_table"]
        if item["role"] == "adversarial-reviewer"
    )
    assert both["minimum_role_score"] == 0.5
    assert route["selector"] == "good"
    assert "weak" not in route["fallbacks"]

    weak_only = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "weak.json", "weak")],
    })
    assert weak_only["status"] == "fail"
    assert weak_only["routing_table"] == []
    assert weak_only["unqualified_roles"] == ["adversarial-reviewer"]


def test_minimum_role_score_is_validated(tmp_path):
    source = ROOT / "template/checks/evalset/model-routing-v1.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    for value in (-0.01, 1.01, "not-a-score"):
        data["minimum_role_score"] = value
        path = tmp_path / f"eval-{repr(value)}.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises((TypeError, ValueError)) as caught:
            mod._load_evalset(path)
        assert "minimum_role_score" in str(caught.value) or value == "not-a-score"


def test_role_weights_must_be_nonempty(tmp_path):
    source = ROOT / "template/checks/evalset/model-routing-v1.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    data["role_weights"] = {}
    path = tmp_path / "empty-roles.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="role_weights must be non-empty"):
        mod._load_evalset(path)


def test_response_paths_are_confined_and_hashed(tmp_path):
    write_response(tmp_path / "r.json")
    with pytest.raises(ValueError, match="confined"):
        mod.score_manifest({
            "response_root": str(tmp_path),
            "candidates": [{"selector": "m", "response_path": "../r.json", "sha256": "0" * 64}],
        })
    result = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "r.json")],
    })
    assert result["candidates"][0]["response_sha256"]


def test_response_symlink_is_rejected_before_resolution(tmp_path):
    target = tmp_path / "target.json"
    write_response(target)
    link = tmp_path / "response.json"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("file symlink creation is unavailable")
    with pytest.raises(ValueError, match="regular file"):
        mod._confined_response_path(tmp_path.resolve(), "response.json")


def test_response_digest_is_mandatory_and_content_binding(tmp_path):
    write_response(tmp_path / "r.json")
    for missing_digest in ({}, {"sha256": ""}):
        item = {"selector": "m", "response_path": "r.json", **missing_digest}
        with pytest.raises(ValueError, match="sha256 is required"):
            mod.score_manifest({
                "response_root": str(tmp_path),
                "candidates": [item],
            })


def test_three_recognized_but_wrong_answers_do_not_promote(tmp_path):
    bad = {
        "sym-sqrt-square-sign": {},
        "num-expm1-cancellation": {},
        "conv-fourth-order": {},
    }
    write_response(tmp_path / "r.json", bad)
    result = mod.score_manifest({
        "response_root": str(tmp_path),
        "candidates": [bound_candidate(tmp_path / "r.json")],
    })
    assert result["candidates"][0]["tasks_attempted"] == 3
    assert result["status"] == "fail"
    assert result["routing_table"] == []
