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


def test_marker_status_rejects_traversal_and_backslashes(tmp_path):
    outside = tmp_path.parent / "outside-marker"
    outside.write_text("x", encoding="utf-8")
    with pytest.raises(POLICY.ManifestPolicyError, match="escapes"):
        POLICY.marker_status(tmp_path, "../outside-marker")
    with pytest.raises(POLICY.ManifestPolicyError, match="forward-slash"):
        POLICY.marker_status(tmp_path, "dir\\marker")


def test_marker_status_distinguishes_regular_missing_and_link_paths(tmp_path):
    regular = tmp_path / "checks/unit"
    regular.mkdir(parents=True)
    assert POLICY.marker_status(tmp_path, "checks/unit") == (True, "present")
    assert POLICY.marker_status(tmp_path, "checks/missing")[0] is False
    link = tmp_path / "linked"
    try:
        link.symlink_to(regular, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlink creation unavailable")
    present, reason = POLICY.marker_status(tmp_path, "linked")
    assert present is False
    assert "link/reparse" in reason


def test_load_manifest_object_accepts_bounded_bom_json(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_bytes(b"\xef\xbb\xbf" + b'{"profiles": {}}')
    assert POLICY.load_manifest_object(path) == {"profiles": {}}


def test_load_manifest_object_rejects_oversize_and_nonobject(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_bytes(b" " * (POLICY.MAX_MANIFEST_BYTES + 1) + b"{}")
    with pytest.raises(POLICY.ManifestPolicyError, match="size limit"):
        POLICY.load_manifest_object(path)
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(POLICY.ManifestPolicyError, match="JSON object"):
        POLICY.load_manifest_object(path)


def test_load_manifest_object_rejects_pathname_replacement_during_read(tmp_path, monkeypatch):
    path = tmp_path / "manifest.json"
    path.write_text('{"profiles": {"original": {}}}', encoding="utf-8")
    replacement = tmp_path / "replacement.json"
    replacement.write_text('{"profiles": {"replacement": {}}}', encoding="utf-8")
    real_read = POLICY.os.read
    real_lstat = Path.lstat
    swapped = False

    def swapping_read(descriptor, amount):
        nonlocal swapped
        data = real_read(descriptor, amount)
        swapped = True
        return data

    def replacement_lstat(candidate):
        if swapped and candidate == path:
            return real_lstat(replacement)
        return real_lstat(candidate)

    monkeypatch.setattr(POLICY.os, "read", swapping_read)
    monkeypatch.setattr(Path, "lstat", replacement_lstat)
    with pytest.raises(POLICY.ManifestPolicyError, match="changed"):
        POLICY.load_manifest_object(path)
    assert swapped is True


@pytest.mark.parametrize("marker", ["d:/windows", "d:", "C:relative", "z:/"])
def test_marker_status_rejects_windows_drive_markers_portably(tmp_path, marker):
    with pytest.raises(POLICY.ManifestPolicyError, match="escapes"):
        POLICY.marker_status(tmp_path, marker)
