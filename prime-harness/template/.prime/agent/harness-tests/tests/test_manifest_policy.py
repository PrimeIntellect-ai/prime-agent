from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "template/harness/manifest_policy.py"
SPEC = importlib.util.spec_from_file_location("manifest_policy_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


def test_profile_minimum_defaults_to_one_and_accepts_larger_integer():
    assert POLICY.profile_minimum({}, "quick") == 1
    assert POLICY.profile_minimum({"min_applicable_checks": 3}, "full") == 3


@pytest.mark.parametrize("value", [True, False, 0, -1, 1.5, "2", None])
def test_profile_minimum_rejects_unsafe_values(value):
    with pytest.raises(POLICY.ManifestPolicyError, match="min_applicable_checks"):
        POLICY.profile_minimum({"min_applicable_checks": value}, "default")


def test_validate_profiles_checks_all_profile_containers():
    assert POLICY.validate_profiles({"default": {"required": [], "conditional": []}}) == {"default": 1}
    with pytest.raises(POLICY.ManifestPolicyError, match="required"):
        POLICY.validate_profiles({"default": {"required": {}, "conditional": []}})
    with pytest.raises(POLICY.ManifestPolicyError, match="non-empty"):
        POLICY.validate_profiles({})


def test_skipped_checks_do_not_satisfy_coverage():
    fields = POLICY.coverage_fields(
        [{"status": "skipped"}, {"status": "skipped"}], 1, allow_vacuous=False
    )
    assert fields == {
        "applicable_checks": 0,
        "min_applicable_checks": 1,
        "vacuous": True,
        "vacuous_allowed": False,
        "coverage_satisfied": False,
    }


def test_failures_and_preexecution_errors_are_applicable_checks():
    fields = POLICY.coverage_fields(
        [{"status": "fail"}, {"status": "error"}, {"status": "skipped"}],
        2,
        allow_vacuous=False,
    )
    assert fields["applicable_checks"] == 2
    assert fields["coverage_satisfied"] is True
    assert fields["vacuous"] is False


def test_allow_vacuous_is_explicit_and_reported_without_changing_count():
    fields = POLICY.coverage_fields([], 1, allow_vacuous=True)
    assert fields["applicable_checks"] == 0
    assert fields["vacuous"] is True
    assert fields["vacuous_allowed"] is True
    assert fields["coverage_satisfied"] is True


def test_unknown_result_status_fails_closed():
    with pytest.raises(POLICY.ManifestPolicyError, match="unsupported status"):
        POLICY.coverage_fields([{"status": "maybe"}], 1, allow_vacuous=False)
