from __future__ import annotations

import importlib.util
import json
import hashlib
import re
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parents[1]
INSTALL = HARNESS_ROOT / "install.py"


def run_install(target: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(INSTALL), str(target), *args],
                          capture_output=True, text=True, timeout=120)


def test_fresh_install_copies_everything(tmp_repo):
    proc = run_install(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    for expected in (
        ".prime/agent/APPEND_SYSTEM.md",
        ".prime/agent/settings.json",
        ".prime/agent/prompts/harness-task.md",
        ".prime/agent/skills/harness-orchestrator/SKILL.md",
        ".prime/agent/skills/sci-verify/src/sci_verify/__init__.py",
        ".prime/agent/skills/evidence-ledger/pyproject.toml",
        ".prime/agent/skills/external-critic/src/external_critic/_common.py",
        ".prime/agent/skills/repo-map/SKILL.md",
        ".prime/agent/skills/repo-map/pyproject.toml",
        ".prime/agent/skills/repo-map/src/repo_map/__init__.py",
        ".prime/agent/skills/repo-map/src/repo_map/__main__.py",
        "harness/verify.py",
        "harness/scorecard.py",
        "harness/replay.py",
        "harness/backup.py",
        "harness/model_routing.py",
        ".github/workflows/prime-harness.yml",
        ".prime/agent/harness-tests/BUNDLE.md",
        ".prime/agent/harness-tests/docs/alert-codes.md",
        ".prime/agent/harness-tests/tests/test_orchestrator.py",
        ".prime/agent/harness-tests/tests/fixtures/scorecard/session.jsonl",
        "harness/manifest.json",
        "harness/roster.yaml",
        "harness/doctor.py",
        "harness/manifest_policy.py",
        "harness/upstream_check.py",
        "harness/patches/prime-agent/windows-kernel-venv-python.patch",
        "harness/patches/prime-agent/windows-kernel-windows-hide.patch",
        "checks/evalset/corpus.json",
        "checks/evalset/model-routing-v1.json",
        "checks/evalset/executors/reference_adapter.py",
        "checks/evalset/snapshots/baseline-v1.json",
        "harness/replay_adapters/README.md",
        "checks/properties/test_example_properties.py",
        "checks/hidden_holdout/README.md",
        "checks/hidden_holdout/test_public_transport_smoke.py",
    ):
        assert (tmp_repo / expected).is_file(), f"missing {expected}"
    assert "harness/scorecard.py" in proc.stdout
    assert "harness/replay.py" in proc.stdout
    assert "harness/backup.py create" in proc.stdout
    assert ".github/workflows/prime-harness.yml" in proc.stdout
    gitignore = (tmp_repo / ".gitignore").read_text(encoding="utf-8")
    assert "artifacts/harness/" in gitignore
    assert "__pycache__/" in gitignore
    assert "*.py[cod]" in gitignore
    assert ".prime/agent/harness-tests/template" in gitignore
    baseline = json.loads((
        tmp_repo / "artifacts/harness/upstream-watch/baseline.json"
    ).read_text(encoding="utf-8"))
    assert baseline["schema_version"] == 1
    assert set(baseline["patch_state"]) == {"venv_python_path", "windows_hide"}


def test_reinstall_is_idempotent(tmp_repo):
    run_install(tmp_repo)
    before = (tmp_repo / ".gitignore").read_text(encoding="utf-8")
    baseline_path = tmp_repo / "artifacts/harness/upstream-watch/baseline.json"
    baseline_before = baseline_path.read_bytes()
    proc = run_install(tmp_repo)
    assert proc.returncode == 0
    assert "new files:        0" in proc.stdout
    # .gitignore not duplicated
    assert (tmp_repo / ".gitignore").read_text(encoding="utf-8") == before
    assert baseline_path.read_bytes() == baseline_before


def test_local_edits_preserved_without_force(tmp_repo):
    run_install(tmp_repo)
    manifest = tmp_repo / "harness" / "manifest.json"
    manifest.write_text('{"profiles": {"custom": {"required": []}}}', encoding="utf-8")
    proc = run_install(tmp_repo)
    assert "kept local edits" in proc.stdout
    assert "custom" in manifest.read_text(encoding="utf-8")

    proc = run_install(tmp_repo, "--force")
    assert "overwritten" in proc.stdout
    assert "custom" not in manifest.read_text(encoding="utf-8")


def test_dry_run_writes_nothing(tmp_repo):
    proc = run_install(tmp_repo, "--dry-run")
    assert proc.returncode == 0
    assert not (tmp_repo / "harness").exists()


def test_doctor_passes_on_fresh_install(tmp_repo):
    run_install(tmp_repo)
    proc = subprocess.run([sys.executable, str(tmp_repo / "harness" / "doctor.py")],
                          cwd=str(tmp_repo), capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"doctor failed:\n{proc.stdout}\n{proc.stderr}"


def test_bounded_text_rejects_same_inode_mutation_during_read(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("installer_mutation_test", INSTALL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    victim = tmp_path / "pyproject.toml"
    original = b"[tool.pytest.ini_options]\n" + b"a" * 70000
    replacement = b"[tool.other.ini_options] \n" + b"b" * (len(original) - 26)
    assert len(replacement) == len(original)
    victim.write_bytes(original)
    real_read = os.read
    mutated = False

    def mutating_read(descriptor, amount):
        nonlocal mutated
        data = real_read(descriptor, amount)
        if not mutated:
            mutated = True
            with victim.open("r+b") as handle:
                handle.write(replacement)
                handle.flush()
                os.fsync(handle.fileno())
        return data

    monkeypatch.setattr(module.os, "read", mutating_read)
    assert module._bounded_text(victim) is None
    assert mutated is True


def test_bounded_text_rejects_file_replaced_between_check_and_open(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("installer_race_test", INSTALL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    victim = tmp_path / "package.json"
    victim.write_text('{"scripts": {}}', encoding="utf-8")
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(b"x" * 2048)
    real_open = os.open
    swapped = False

    def racing_open(path, flags, *args, **kwargs):
        nonlocal swapped
        if not swapped and Path(path) == victim:
            swapped = True
            os.replace(replacement, victim)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(module.os, "open", racing_open)
    assert module._bounded_text(victim, limit=1024) is None
    assert swapped is True


def test_installer_rejects_linked_harness_destination_before_any_external_write(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    outside = tmp_repo.parent / f"{tmp_repo.name}-external-harness"
    outside.mkdir()
    try:
        (tmp_repo / "harness").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlink creation unavailable")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "link/reparse destination forbidden" in (proc.stdout + proc.stderr)
    assert list(outside.iterdir()) == []
    assert not (tmp_repo / ".prime/agent/APPEND_SYSTEM.md").exists()


def test_tailor_generates_nonvacuous_manifest_from_repo_layout(tmp_repo):
    (tmp_repo / "pyproject.toml").write_text("[project]\nname='sample'\nversion='0'\n", encoding="utf-8")
    (tmp_repo / "src/sample").mkdir(parents=True)
    (tmp_repo / "src/sample/__init__.py").write_text("", encoding="utf-8")
    (tmp_repo / "tests").mkdir()
    (tmp_repo / "tests/test_sample.py").write_text("def test_ok(): assert True\n", encoding="utf-8")

    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    assert manifest["_generated_by"] == "prime-harness install.py --tailor"
    for profile_name in ("quick", "default", "changed-files"):
        profile = manifest["profiles"][profile_name]
        assert profile["min_applicable_checks"] >= 1
        assert profile["required"]
        assert all(
            not entry.get("skip_if_missing")
            or (tmp_repo / entry["skip_if_missing"]).exists()
            for entry in profile["required"]
        )
    assert {entry["name"] for entry in manifest["profiles"]["default"]["required"]} >= {"compile", "unit"}


def test_tailor_uses_simulation_and_pyproject_pytest_markers(tmp_repo):
    (tmp_repo / "simulation").mkdir()
    (tmp_repo / "simulation/model.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_repo / "pyproject.toml").write_text(
        "[project]\nname='sim'\nversion='0'\n[tool.pytest.ini_options]\ntestpaths=['custom']\n",
        encoding="utf-8",
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    entries = {entry["name"]: entry for entry in manifest["profiles"]["default"]["required"]}
    assert entries["compile"]["skip_if_missing"] == "simulation"
    assert entries["unit"]["skip_if_missing"] == "pyproject.toml"
    assert "pyproject.toml:pytest" in manifest["_detected"]


def test_tailor_rejects_link_descendant_in_source_layout_free_package(tmp_repo):
    package = tmp_repo / "pkg"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    outside = tmp_repo.parent / f"{tmp_repo.name}-outside-module.py"
    outside.write_text("secret = 1\n", encoding="utf-8")
    try:
        (package / "external.py").symlink_to(outside)
    except OSError:
        pytest.skip("file symlink creation unavailable")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "link/reparse entry forbidden" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_rejects_link_descendant_after_regular_python_source(tmp_repo):
    source = tmp_repo / "src"
    source.mkdir()
    (source / "a.py").write_text("value = 1\n", encoding="utf-8")
    outside = tmp_repo.parent / f"{tmp_repo.name}-outside-source"
    outside.mkdir()
    (outside / "external.py").write_text("secret = 1\n", encoding="utf-8")
    try:
        (source / "zlink").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlink creation unavailable")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "link/reparse entry forbidden" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_rejects_empty_source_directory_as_vacuous(tmp_repo):
    (tmp_repo / "src").mkdir()
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_rejects_shell_metacharacters_in_detected_package_names(tmp_repo):
    dangerous = tmp_repo / "pkg & echo PWNED"
    dangerous.mkdir()
    (dangerous / "__init__.py").write_text("", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_root_bound_stops_iteration_at_limit_plus_one(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("installer_bound_test", INSTALL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real_iterdir = Path.iterdir
    requested = 0

    def guarded_iterdir(path):
        nonlocal requested
        if path == tmp_path:
            for index in range(513):
                requested += 1
                yield path / f"entry-{index:03d}"
            raise AssertionError("tailoring exhausted entries beyond its advertised bound")
        yield from real_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)
    with pytest.raises(module.TailorError, match="512-entry tailoring scan limit"):
        module.tailor_manifest(tmp_path)
    assert requested == 513


def test_tailor_fails_closed_when_top_level_scan_bound_is_exceeded(tmp_repo):
    for index in range(520):
        (tmp_repo / f"marker-{index:03d}").write_text("x", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "512-entry tailoring scan limit" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / ".prime/agent/APPEND_SYSTEM.md").exists()


def test_tailor_dry_run_does_not_write_manifest_or_template(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor", "--dry-run")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "[dry-run] tailored manifest" in proc.stdout
    assert not (tmp_repo / "harness/manifest.json").exists()
    assert not (tmp_repo / ".prime/agent/APPEND_SYSTEM.md").exists()


def test_tailor_rejects_linked_lean_marker(tmp_repo):
    outside = tmp_repo.parent / f"{tmp_repo.name}-lakefile.lean"
    outside.write_text("package external\n", encoding="utf-8")
    try:
        (tmp_repo / "lakefile.lean").symlink_to(outside)
    except OSError:
        pytest.skip("file symlink creation unavailable")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "link/reparse layout marker forbidden" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_rejects_link_descendant_in_test_directory(tmp_repo):
    tests = tmp_repo / "tests"
    tests.mkdir()
    outside = tmp_repo.parent / f"{tmp_repo.name}-outside-test.py"
    outside.write_text("def test_external(): assert True\n", encoding="utf-8")
    try:
        (tests / "test_external.py").symlink_to(outside)
    except OSError:
        pytest.skip("file symlink creation unavailable")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "link/reparse entry forbidden" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_rejects_runner_name_used_only_as_echo_argument(tmp_repo):
    (tmp_repo / "package.json").write_text(
        json.dumps({"scripts": {"test": "echo jest"}}), encoding="utf-8"
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)


def test_tailor_rejects_trivially_vacuous_node_test_script(tmp_repo):
    (tmp_repo / "package.json").write_text(
        json.dumps({"scripts": {"test": "true"}}), encoding="utf-8"
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / "harness/manifest.json").exists()


def test_tailor_detects_tox_lean_and_nonplaceholder_node_tests(tmp_repo):
    (tmp_repo / "tox.ini").write_text("[tox]\nenvlist=py\n", encoding="utf-8")
    (tmp_repo / "lakefile.lean").write_text("package sample\n", encoding="utf-8")
    (tmp_repo / "package.json").write_text(
        json.dumps({"scripts": {"test": "node --test"}}), encoding="utf-8"
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    names = {entry["name"] for entry in manifest["profiles"]["default"]["required"]}
    assert names == {"tox", "lean-build", "node-test"}
    quick = manifest["profiles"]["quick"]["required"]
    assert sum(int(entry["timeout_seconds"]) for entry in quick) < 600





def test_tailor_emits_one_unit_check_per_detected_test_directory(tmp_repo):
    for directory in ("tests", "test"):
        path = tmp_repo / directory
        path.mkdir()
        (path / f"test_{directory}.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    units = [entry for entry in manifest["profiles"]["default"]["required"] if entry["name"].startswith("unit")]
    assert {entry["skip_if_missing"] for entry in units} == {"tests", "test"}
    assert len(units) == 2
    for entry in units:
        assert entry["command"].split()[-1] == entry["skip_if_missing"]

    shutil.rmtree(tmp_repo / "tests")
    gate = subprocess.run(
        [sys.executable, "-S", str(tmp_repo / "harness/verify.py"), "--profile", "default", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=300,
    )
    assert gate.returncode == 0, gate.stdout + gate.stderr
    verdict = json.loads(next(line[12:] for line in gate.stdout.splitlines() if line.startswith("GATE_RESULT ")))
    assert any(name.startswith("unit:test") for name in verdict["passed"])
    assert len(verdict["skipped"]) == 1


def test_tailored_manifest_passes_doctor_static_applicability(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    (tmp_repo / "tests").mkdir()
    (tmp_repo / "tests/test_pkg.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    installed = run_install(tmp_repo, "--tailor")
    assert installed.returncode == 0, installed.stdout + installed.stderr
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    report = json.loads(doctor.stdout)
    applicability = next(item for item in report["checks"] if item["name"] == "manifest-applicability")
    assert applicability["level"] == "PASS"


def test_tailor_ignores_installer_owned_example_checks_on_reinstall(tmp_repo):
    first = run_install(tmp_repo)
    assert first.returncode == 0, first.stdout + first.stderr
    original = (tmp_repo / "harness/manifest.json").read_bytes()
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)
    assert (tmp_repo / "harness/manifest.json").read_bytes() == original
    assert not (tmp_repo / "harness/manifest.tailored.json").exists()


def test_tailor_recognizes_user_extension_of_installed_example_checks(tmp_repo):
    first = run_install(tmp_repo)
    assert first.returncode == 0
    custom = tmp_repo / "checks/properties/test_project_property.py"
    custom.write_text("def test_project_property(): assert True\n", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    sidecar = json.loads((tmp_repo / "harness/manifest.tailored.json").read_text(encoding="utf-8"))
    unit = next(entry for entry in sidecar["profiles"]["default"]["required"] if entry["name"] == "unit")
    assert "checks/properties" in unit["command"]


def test_tailor_refuses_vacuous_repo_before_installing(tmp_repo):
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "no executable project checks detected" in (proc.stdout + proc.stderr)
    assert not (tmp_repo / ".prime/agent/APPEND_SYSTEM.md").exists()


def test_repeated_identical_tailor_is_idempotent_without_sidecar(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    (tmp_repo / "tests").mkdir()
    (tmp_repo / "tests/test_pkg.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    first = run_install(tmp_repo, "--tailor")
    assert first.returncode == 0, first.stdout + first.stderr
    manifest = tmp_repo / "harness/manifest.json"
    before = manifest.read_bytes()
    before_mtime = manifest.stat().st_mtime_ns

    second = run_install(tmp_repo, "--tailor")
    assert second.returncode == 0, second.stdout + second.stderr
    assert manifest.read_bytes() == before
    assert manifest.stat().st_mtime_ns == before_mtime
    assert not (tmp_repo / "harness/manifest.tailored.json").exists()
    assert "tailored manifest: unchanged" in second.stdout


def test_tailor_preserves_existing_manifest_and_writes_review_sidecar(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    (tmp_repo / "tests").mkdir()
    (tmp_repo / "tests/test_pkg.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    (tmp_repo / "harness").mkdir()
    custom = {"profiles": {"custom": {"required": [], "conditional": []}}}
    (tmp_repo / "harness/manifest.json").write_text(json.dumps(custom), encoding="utf-8")

    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8")) == custom
    sidecar = tmp_repo / "harness/manifest.tailored.json"
    assert sidecar.is_file()
    assert json.loads(sidecar.read_text(encoding="utf-8"))["profiles"]["default"]["required"]


def test_strict_doctor_validates_invoked_repository_not_cwd(tmp_repo):
    (tmp_repo / "src/pkg").mkdir(parents=True)
    (tmp_repo / "src/pkg/__init__.py").write_text("", encoding="utf-8")
    (tmp_repo / "tests").mkdir()
    (tmp_repo / "tests/test_ok.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    installed_a = run_install(tmp_repo, "--tailor")
    assert installed_a.returncode == 0

    repo_b = tmp_repo.parent / f"{tmp_repo.name}-repo-b"
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo_b)], check=True)
    subprocess.run(["git", "-C", str(repo_b), "config", "user.email", "harness@test.local"], check=True)
    subprocess.run(["git", "-C", str(repo_b), "config", "user.name", "Harness Test"], check=True)
    (repo_b / "README.md").write_text("repo b\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo_b), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(repo_b), "commit", "-qm", "init"], check=True)
    installed_b = run_install(repo_b)
    assert installed_b.returncode == 0

    doctor = subprocess.run(
        [sys.executable, str(repo_b / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    assert doctor.returncode == 2
    report = json.loads(doctor.stdout)
    applicability = next(item for item in report["checks"] if item["name"] == "manifest-applicability")
    assert applicability["level"] == "FAIL"
    assert "quick:compile" in applicability["detail"]


def test_doctor_missing_git_diagnostic_names_invoked_repository(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    (tmp_repo / ".git").rename(tmp_repo / ".git-removed")
    unrelated = tmp_repo.parent
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--json"],
        cwd=unrelated, capture_output=True, text=True, timeout=120,
    )
    report = json.loads(doctor.stdout)
    git_check = next(item for item in report["checks"] if item["name"] == "git")
    assert git_check["level"] == "FAIL"
    assert str(tmp_repo) in git_check["detail"]
    assert "at repository root" in git_check["detail"]


def test_doctor_rejects_oversized_manifest_before_parsing(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    (tmp_repo / "harness/manifest.json").write_text(" " * 1_048_577 + "{}", encoding="utf-8")
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    assert doctor.returncode == 2
    report = json.loads(doctor.stdout)
    manifest_check = next(item for item in report["checks"] if item["name"] == "manifest")
    assert manifest_check["level"] == "FAIL"
    assert "size limit" in manifest_check["detail"]


def test_doctor_reports_nonobject_manifest_as_structured_failure(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    (tmp_repo / "harness/manifest.json").write_text("[]", encoding="utf-8")
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    assert doctor.returncode == 2
    report = json.loads(doctor.stdout)
    manifest_check = next(item for item in report["checks"] if item["name"] == "manifest")
    assert manifest_check["level"] == "FAIL"
    assert "JSON object" in manifest_check["detail"]


def test_doctor_strict_rejects_traversal_marker_even_when_outside_exists(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    outside = tmp_repo.parent / "outside-marker"
    outside.write_text("x", encoding="utf-8")
    manifest = {"profiles": {"default": {"required": [
        {"name": "escape", "command": "echo unsafe", "skip_if_missing": "../outside-marker"}
    ], "conditional": []}}}
    (tmp_repo / "harness/manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    report = json.loads(doctor.stdout)
    applicability = next(item for item in report["checks"] if item["name"] == "manifest-applicability")
    assert applicability["level"] == "FAIL"
    assert "escapes or ambiguously names" in applicability["detail"]


def test_doctor_strict_reports_static_manifest_skips(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py"), "--strict", "--json"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=120,
    )
    report = json.loads(doctor.stdout)
    applicability = next(item for item in report["checks"] if item["name"] == "manifest-applicability")
    assert applicability["level"] == "FAIL"
    assert "quick:compile" in applicability["detail"]
    assert "quick:unit-fast" in applicability["detail"]


def test_doctor_fails_on_recorded_prime_agent_drift(tmp_repo):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0
    baseline_path = tmp_repo / "artifacts/harness/upstream-watch/baseline.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline["prime_agent"]["binary_sha256"] = "0" * 64
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")

    doctor = subprocess.run(
        [sys.executable, str(tmp_repo / "harness/doctor.py")],
        cwd=tmp_repo,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert doctor.returncode == 2
    assert "[FAIL] upstream-watch" in doctor.stdout
    assert "binary hash drift" in doctor.stdout


def test_installer_ignores_python_cache_artifacts():
    spec = importlib.util.spec_from_file_location("prime_harness_installer", INSTALL)
    assert spec and spec.loader
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    assert installer.is_ignored_template_artifact(Path("pkg/__pycache__/module.cpython-313.pyc"))
    assert installer.is_ignored_template_artifact(Path("pkg/module.pyc"))
    assert installer.is_ignored_template_artifact(Path("pkg/module.pyo"))
    assert not installer.is_ignored_template_artifact(Path("pkg/module.py"))


def test_installed_orchestrator_docs_scope_upstream_only_live_e2e_path():
    skill_doc = (
        HARNESS_ROOT / "template/.prime/agent/skills/harness-orchestrator/SKILL.md"
    ).read_text(encoding="utf-8")
    bundle_doc = (
        HARNESS_ROOT / "template/.prime/agent/harness-tests/BUNDLE.md"
    ).read_text(encoding="utf-8")
    assert "In the upstream prime-harness repo" in skill_doc
    assert "it is not part of the installed bundle" in skill_doc
    assert ".prime/agent/harness-tests/BUNDLE.md" in skill_doc
    assert "tests/test_live_kernel_e2e.py" in bundle_doc
    assert "upstream-only" in bundle_doc


def test_readme_install_tree_documents_every_large_installed_component():
    readme = (HARNESS_ROOT / "README.md").read_text(encoding="utf-8")
    required = {
        ".github/workflows/prime-harness.yml",
        ".prime/agent/harness-tests/",
        "harness/backup.py",
        "harness/model_routing.py",
        "harness/replay_adapters/",
        "checks/evalset/model-routing-v1.json",
        ".prime/agent/harness-tests/BUNDLE.md",
    }
    assert not (HARNESS_ROOT / "template/.prime/agent/harness-tests/.pytest_cache").exists()
    assert required <= {entry for entry in required if entry in readme}


def test_bundle_uses_context_safe_contract_docs_not_upstream_readme():
    bundle_root = HARNESS_ROOT / "template/.prime/agent/harness-tests"
    upstream_doc = HARNESS_ROOT / "docs/alert-codes.md"
    bundled_doc = bundle_root / "docs/alert-codes.md"
    assert upstream_doc.is_file()
    assert bundled_doc.read_bytes() == upstream_doc.read_bytes()
    assert not (bundle_root / "README.md").exists()
    text = bundled_doc.read_text(encoding="utf-8")
    assert "Scorecard alert codes" in text
    assert "Panel finding closure" in text
    assert "Measured 2026-08-08" not in text
    assert "python install.py" not in text


def test_installed_conftest_manages_template_link_without_shell_symlink(tmp_path, monkeypatch):
    conftest_path = HARNESS_ROOT / "tests/conftest.py"
    spec = importlib.util.spec_from_file_location("installed_conftest_contract", conftest_path)
    assert spec and spec.loader
    installed_conftest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installed_conftest)

    shallow_source = tmp_path / "prime-harness"
    (shallow_source / "template").mkdir(parents=True)
    monkeypatch.setattr(installed_conftest, "HARNESS_ROOT", shallow_source)
    monkeypatch.setattr(
        installed_conftest,
        "_installed_repo_root",
        lambda: (_ for _ in ()).throw(AssertionError("source layout must not index parents")),
    )
    installed_conftest.pytest_configure(None)

    consumer = tmp_path / "consumer"
    bundle = consumer / ".prime/agent/harness-tests"
    bundle.mkdir(parents=True)
    (consumer / "sentinel.txt").write_text("consumer-root", encoding="utf-8")
    monkeypatch.setattr(installed_conftest, "HARNESS_ROOT", bundle)
    monkeypatch.setattr(installed_conftest, "_installed_repo_root", lambda: consumer)

    installed_conftest.pytest_configure(None)
    link = bundle / "template"
    assert link.is_dir()
    assert (link / "sentinel.txt").read_text(encoding="utf-8") == "consumer-root"
    installed_conftest.pytest_unconfigure(None)
    assert not os.path.lexists(link)

    link.mkdir()
    (link / "sentinel.txt").write_text("shadow-copy", encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not resolve to the consumer root"):
        installed_conftest.pytest_configure(None)
    assert (link / "sentinel.txt").read_text(encoding="utf-8") == "shadow-copy"


def test_customizable_consumer_contracts_are_not_frozen_in_installed_selftests():
    bundle_root = HARNESS_ROOT / "template/.prime/agent/harness-tests"
    assert not (bundle_root / "tests/test_source_reviewability.py").exists()
    assert not (bundle_root / "tests/test_template_checks.py").exists()
    assert not (bundle_root / "tests/test_workflow.py").exists()
    assert (bundle_root / "tests/test_workflow_policy.py").is_file()
    bundle_doc = (bundle_root / "BUNDLE.md").read_text(encoding="utf-8").lower()
    assert "custom" in bundle_doc
    assert "test_source_reviewability.py" in bundle_doc
    assert "test_template_checks.py" in bundle_doc and "test_workflow.py" in bundle_doc


def test_installed_component_selftests_match_upstream_sources():
    source_root = HARNESS_ROOT / "tests"
    bundle_root = HARNESS_ROOT / "template" / ".prime" / "agent" / "harness-tests" / "tests"
    excluded = {
        "test_api_reference.py",
        "test_installer.py",
        "test_live_kernel_e2e.py",
        "test_source_reviewability.py",
        "test_standalone.py",
        "test_template_checks.py",
        "test_workflow.py",
    }
    source_files = {
        path.relative_to(source_root).as_posix(): path
        for path in source_root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
        and path.relative_to(source_root).as_posix() not in excluded
    }
    bundle_files = {
        path.relative_to(bundle_root).as_posix(): path
        for path in bundle_root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }
    assert set(bundle_files) == set(source_files)
    for relative, source in source_files.items():
        assert bundle_files[relative].read_bytes() == source.read_bytes(), relative
    assert (bundle_root.parent / "docs/alert-codes.md").read_bytes() == (
        HARNESS_ROOT / "docs/alert-codes.md"
    ).read_bytes()
    assert not (bundle_root.parent / "README.md").exists()



def test_tailor_preserves_actual_case_for_every_fixed_layout_marker(tmp_repo):
    (tmp_repo / "Src/Pkg").mkdir(parents=True)
    (tmp_repo / "Src/Pkg/module.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_repo / "Tests").mkdir()
    (tmp_repo / "Tests/test_ok.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    (tmp_repo / "PyProject.toml").write_text("[tool.pytest.ini_options]\n", encoding="utf-8")
    (tmp_repo / "Tox.ini").write_text("[tox]\n", encoding="utf-8")
    (tmp_repo / "Lakefile.lean").write_text("package Test\n", encoding="utf-8")
    (tmp_repo / "Package.json").write_text(
        json.dumps({"scripts": {"test": "node --test"}}), encoding="utf-8",
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    checks = manifest["profiles"]["default"]["required"]
    by_name = {entry["name"]: entry for entry in checks}
    assert by_name["compile"]["skip_if_missing"] == "Src"
    assert "compileall -q Src" in by_name["compile"]["command"]
    assert by_name["unit"]["skip_if_missing"] == "Tests"
    assert "pytest -q Tests" in by_name["unit"]["command"]
    assert by_name["lean-build"]["skip_if_missing"] == "Lakefile.lean"
    assert by_name["node-test"]["skip_if_missing"] == "Package.json"


def test_tailor_preserves_actual_case_for_nested_check_paths(tmp_repo):
    (tmp_repo / "Checks/Properties").mkdir(parents=True)
    (tmp_repo / "Checks/Properties/test_project.py").write_text(
        "def test_project(): assert True\n", encoding="utf-8",
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    unit = next(entry for entry in manifest["profiles"]["default"]["required"] if entry["name"] == "unit")
    assert unit["skip_if_missing"] == "Checks/Properties"
    assert "pytest -q Checks/Properties" in unit["command"]



@pytest.mark.parametrize(
    "marker,content,check_name",
    [
        ("PyProject.toml", "[tool.pytest.ini_options]\n", "unit"),
        ("Tox.ini", "[tox]\n", "tox"),
    ],
)
def test_tailor_preserves_actual_case_for_single_file_python_markers(tmp_repo, marker, content, check_name):
    (tmp_repo / marker).write_text(content, encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    check = next(entry for entry in manifest["profiles"]["default"]["required"] if entry["name"] == check_name)
    assert check["skip_if_missing"] == marker


def test_tailor_preserves_actual_case_for_holdout_marker(tmp_repo):
    (tmp_repo / "Tests").mkdir()
    (tmp_repo / "Tests/test_ok.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    (tmp_repo / "Checks/Hidden_Holdout").mkdir(parents=True)
    (tmp_repo / "Checks/Hidden_Holdout/test_hidden.py").write_text(
        "def test_hidden(): assert True\n", encoding="utf-8",
    )
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    manifest = json.loads((tmp_repo / "harness/manifest.json").read_text(encoding="utf-8"))
    holdout = manifest["profiles"]["holdout"]["required"][0]
    assert holdout["skip_if_missing"] == "Checks/Hidden_Holdout"
    assert holdout["command"].endswith("Checks/Hidden_Holdout")


def test_tailor_rejects_casefold_ambiguous_layout_markers(tmp_repo):
    lower = tmp_repo / "src"
    upper = tmp_repo / "Src"
    lower.mkdir()
    try:
        upper.mkdir()
    except FileExistsError:
        pytest.skip("filesystem is case-insensitive")
    (lower / "a.py").write_text("a = 1\n", encoding="utf-8")
    (upper / "b.py").write_text("b = 1\n", encoding="utf-8")
    proc = run_install(tmp_repo, "--tailor")
    assert proc.returncode != 0
    assert "ambiguous under case folding" in (proc.stdout + proc.stderr)



def _load_installer_module(name: str):
    spec = importlib.util.spec_from_file_location(name, INSTALL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("failure", [subprocess.TimeoutExpired(["upstream_check"], 120), OSError("spawn denied")])
def test_post_install_baseline_launch_failures_degrade_to_warning(tmp_repo, monkeypatch, capsys, failure):
    installer = _load_installer_module(f"prime_harness_installer_{{type(failure).__name__}}")

    def fail_run(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(installer.subprocess, "run", fail_run)
    monkeypatch.setattr(sys, "argv", [str(INSTALL), str(tmp_repo)])
    assert installer.main() == 0
    output = capsys.readouterr()
    assert "warning: could not record upstream baseline" in output.out
    assert (tmp_repo / "harness/upstream_check.py").is_file()



def test_tailor_preserves_user_edited_review_sidecar_without_force(tmp_repo):
    package = tmp_repo / "src"
    package.mkdir()
    (package / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    assert run_install(tmp_repo).returncode == 0
    created = run_install(tmp_repo, "--tailor")
    assert created.returncode == 0, created.stdout + created.stderr
    sidecar = tmp_repo / "harness/manifest.tailored.json"
    draft = json.loads(sidecar.read_text(encoding="utf-8"))
    draft["operator_note"] = "reviewed locally"
    sidecar.write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    before = sidecar.read_bytes()
    rerun = run_install(tmp_repo, "--tailor")
    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    assert sidecar.read_bytes() == before
    assert "sidecar differs from new draft; use --force" in rerun.stdout
    forced = run_install(tmp_repo, "--tailor", "--force")
    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert "operator_note" not in json.loads(sidecar.read_text(encoding="utf-8"))


@pytest.mark.parametrize("script", [
    "true || jest",
    "exit 0 || jest",
    "jest || true",
    "vitest run || echo ignored",
])
def test_node_or_chains_are_never_credible_test_scripts(script):
    installer = _load_installer_module("prime_harness_installer_node_or")
    assert installer._credible_node_test_script(script) is False


def test_atomic_writers_replace_final_symlinks_instead_of_following_them(tmp_path):
    installer = _load_installer_module("prime_harness_installer_atomic_write")
    source = tmp_path / "source.txt"
    source.write_text("template\n", encoding="utf-8")
    outside_copy = tmp_path / "outside-copy.txt"
    outside_copy.write_text("outside-copy\n", encoding="utf-8")
    copy_destination = tmp_path / "copy-destination.txt"
    outside_text = tmp_path / "outside-text.txt"
    outside_text.write_text("outside-text\n", encoding="utf-8")
    text_destination = tmp_path / "text-destination.txt"
    try:
        copy_destination.symlink_to(outside_copy)
        text_destination.symlink_to(outside_text)
    except OSError:
        pytest.skip("file symlink creation unavailable")
    installer.atomic_copy(source, copy_destination)
    installer.atomic_text(text_destination, "merged\n")
    assert not copy_destination.is_symlink()
    assert not text_destination.is_symlink()
    assert copy_destination.read_text(encoding="utf-8") == "template\n"
    assert text_destination.read_text(encoding="utf-8") == "merged\n"
    assert outside_copy.read_text(encoding="utf-8") == "outside-copy\n"
    assert outside_text.read_text(encoding="utf-8") == "outside-text\n"


def test_installed_example_ownership_survives_template_upgrade_and_deletion(tmp_repo, tmp_path):
    source = tmp_repo / "src"
    source.mkdir()
    (source / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    first = run_install(tmp_repo)
    assert first.returncode == 0, first.stdout + first.stderr
    ownership_path = tmp_repo / "artifacts/harness/installed-examples.json"
    ownership = json.loads(ownership_path.read_text(encoding="utf-8"))
    relative = "checks/properties/test_example_properties.py"
    assert ownership["schema_version"] == 1
    assert relative in ownership["files"]
    ownership_before = (ownership_path.read_bytes(), ownership_path.stat().st_mtime_ns)
    second = run_install(tmp_repo)
    assert second.returncode == 0, second.stdout + second.stderr
    assert (ownership_path.read_bytes(), ownership_path.stat().st_mtime_ns) == ownership_before

    installer = _load_installer_module("prime_harness_installer_owned_examples")
    upgraded_template = tmp_path / "upgraded-template"
    shutil.copytree(installer.TEMPLATE, upgraded_template)
    (upgraded_template / relative).write_text("def test_new_placeholder():\n    assert True\n", encoding="utf-8")
    installer.TEMPLATE = upgraded_template
    before_delete = installer.tailor_manifest(tmp_repo)
    assert "python-tests:checks/properties" not in before_delete["_detected"]

    (tmp_repo / relative).unlink()
    after_delete = installer.tailor_manifest(tmp_repo)
    assert "python-tests:checks/properties" not in after_delete["_detected"]



def test_main_atomic_writes_resist_final_component_swap_after_validation(tmp_repo, tmp_path, monkeypatch):
    installer = _load_installer_module("prime_harness_installer_atomic_main")
    outside_copy = tmp_path / "outside-template.txt"
    outside_copy.write_text("outside-template\n", encoding="utf-8")
    outside_ignore = tmp_path / "outside-ignore.txt"
    outside_ignore.write_text("outside-ignore\n", encoding="utf-8")
    original_bytes = installer.atomic_bytes
    original_text = installer.atomic_text
    raced = {"copy": None, "ignore": False}

    def race_bytes(destination, value, mode=0o644):
        if raced["copy"] is None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                destination.symlink_to(outside_copy)
            except OSError:
                pytest.skip("file symlink creation unavailable")
            raced["copy"] = destination
        original_bytes(destination, value, mode)

    def race_text(destination, value):
        if destination.name == ".gitignore":
            destination.symlink_to(outside_ignore)
            raced["ignore"] = True
        original_text(destination, value)

    monkeypatch.setattr(installer, "atomic_bytes", race_bytes)
    monkeypatch.setattr(installer, "atomic_text", race_text)
    monkeypatch.setattr(sys, "argv", [str(INSTALL), str(tmp_repo)])
    assert installer.main() == 0
    assert raced["copy"] is not None and not raced["copy"].is_symlink()
    assert raced["ignore"] is True and not (tmp_repo / ".gitignore").is_symlink()
    assert outside_copy.read_text(encoding="utf-8") == "outside-template\n"
    assert outside_ignore.read_text(encoding="utf-8") == "outside-ignore\n"



INSTALL_STATE = Path(".prime/agent/harness-install-state.json")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def test_install_stamps_version_and_records_pristine_template_hashes(tmp_repo):
    proc = run_install(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    version = (HARNESS_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert re.fullmatch(r"\d+\.\d+\.\d+", version)
    config = json.loads((tmp_repo / "harness/config.json").read_text(encoding="utf-8"))
    assert config["prime_harness_version"] == version
    state = json.loads((tmp_repo / INSTALL_STATE).read_text(encoding="utf-8"))
    assert state["schema_version"] == 1
    assert state["installed_version"] == version
    assert state["template_sha256"]["harness/config.json"] == _sha256_bytes(
        (tmp_repo / "harness/config.json").read_bytes()
    )
    assert not any("__pycache__" in path.parts or path.suffix == ".pyc" for path in tmp_repo.rglob("*"))


def _prepare_old_version_install(tmp_repo: Path) -> tuple[str, bytes]:
    installed = run_install(tmp_repo)
    assert installed.returncode == 0, installed.stdout + installed.stderr
    old_version = "0.0.0"
    managed = tmp_repo / "harness/backup.py"
    old_bytes = b"# old pristine managed file\n"
    managed.write_bytes(old_bytes)
    config_path = tmp_repo / "harness/config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["prime_harness_version"] = old_version
    config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    state_path = tmp_repo / INSTALL_STATE
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["installed_version"] = old_version
    state["template_sha256"]["harness/backup.py"] = _sha256_bytes(old_bytes)
    state["template_sha256"]["harness/config.json"] = _sha256_bytes(config_path.read_bytes())
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return old_version, old_bytes


def test_upgrade_updates_unmodified_files_and_preserves_modified_files_as_new_sidecars(tmp_repo):
    _old_version, old_bytes = _prepare_old_version_install(tmp_repo)
    managed = tmp_repo / "harness/backup.py"
    modified = tmp_repo / "harness/scorecard.py"
    user_bytes = modified.read_bytes() + b"\n# user customization\n"
    modified.write_bytes(user_bytes)
    state_path = tmp_repo / INSTALL_STATE
    state = json.loads(state_path.read_text(encoding="utf-8"))
    # scorecard.py's existing state hash remains its old-pristine comparison arm.
    assert state["template_sha256"]["harness/scorecard.py"] != _sha256_bytes(user_bytes)

    proc = run_install(tmp_repo, "--upgrade")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert managed.read_bytes() == (HARNESS_ROOT / "template/harness/backup.py").read_bytes()
    assert managed.read_bytes() != old_bytes
    assert modified.read_bytes() == user_bytes
    sidecar = tmp_repo / "harness/scorecard.py.new"
    assert sidecar.read_bytes() == (HARNESS_ROOT / "template/harness/scorecard.py").read_bytes()
    version = (HARNESS_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert json.loads((tmp_repo / "harness/config.json").read_text(encoding="utf-8"))["prime_harness_version"] == version
    assert json.loads(state_path.read_text(encoding="utf-8"))["installed_version"] == version
    assert "upgrade conflicts: 1" in proc.stdout


def test_upgrade_fails_closed_on_missing_or_malformed_install_state(tmp_repo):
    before = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    missing = run_install(tmp_repo, "--upgrade")
    assert missing.returncode == 2
    assert "install state" in missing.stderr.lower()
    after = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    assert after == before

    state_path = tmp_repo / INSTALL_STATE
    state_path.parent.mkdir(parents=True)
    state_path.write_text('{"schema_version": 1, "installed_version": "bad"}', encoding="utf-8")
    before = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    malformed = run_install(tmp_repo, "--upgrade")
    assert malformed.returncode == 2
    after = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    assert after == before


def test_upgrade_preserves_existing_edited_new_sidecar_and_dry_run_is_read_only(tmp_repo):
    _prepare_old_version_install(tmp_repo)
    modified = tmp_repo / "harness/backup.py"
    modified.write_bytes(modified.read_bytes() + b"# edit\n")
    sidecar = tmp_repo / "harness/backup.py.new"
    sidecar.write_bytes(b"operator-reviewed sidecar\n")
    before = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    conflict = run_install(tmp_repo, "--upgrade")
    assert conflict.returncode == 2
    assert "sidecar" in conflict.stderr.lower()
    after = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    assert after == before

    sidecar.unlink()
    dry = run_install(tmp_repo, "--upgrade", "--dry-run")
    assert dry.returncode == 0, dry.stdout + dry.stderr
    after_dry = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    expected = dict(before)
    expected.pop("harness/backup.py.new")
    assert after_dry == expected



@pytest.mark.parametrize("bad_path,bad_digest", [
    ("../escape.py", "a" * 64),
    ("C:/escape.py", "a" * 64),
    ("harness\\escape.py", "a" * 64),
    ("harness/file.py", "not-a-digest"),
])
def test_upgrade_rejects_unsafe_state_paths_and_digests_without_writes(tmp_repo, bad_path, bad_digest):
    installed = run_install(tmp_repo)
    assert installed.returncode == 0, installed.stdout + installed.stderr
    state_path = tmp_repo / INSTALL_STATE
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["installed_version"] = "0.0.0"
    state["template_sha256"][bad_path] = bad_digest
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    before = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    proc = run_install(tmp_repo, "--upgrade")
    assert proc.returncode == 2
    after = {path.relative_to(tmp_repo).as_posix(): path.read_bytes() for path in tmp_repo.rglob("*") if path.is_file()}
    assert after == before



def test_upgrade_blocks_custom_config_without_advancing_canonical_version(tmp_repo):
    old_version, _ = _prepare_old_version_install(tmp_repo)
    config_path = tmp_repo / "harness/config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["verification_coverage"] = {"min_evidence_per_100_lines": 2.0}
    config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    before_config = config_path.read_bytes()
    state_path = tmp_repo / INSTALL_STATE
    before_state = json.loads(state_path.read_text(encoding="utf-8"))
    proc = run_install(tmp_repo, "--upgrade")
    assert proc.returncode == 1
    assert config_path.read_bytes() == before_config
    after_state = json.loads(state_path.read_text(encoding="utf-8"))
    assert after_state["installed_version"] == before_state["installed_version"]
    assert after_state["template_sha256"] == before_state["template_sha256"]
    assert after_state["pending_sidecar_sha256"]["harness/config.json"]
    assert json.loads(before_config)["prime_harness_version"] == old_version
    new_config = json.loads((tmp_repo / "harness/config.json.new").read_text(encoding="utf-8"))
    assert new_config["prime_harness_version"] == (HARNESS_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert "merge its .new sidecar" in proc.stderr


def test_upgrade_rolls_back_prior_writes_when_a_later_write_fails(tmp_repo, monkeypatch):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module("prime_harness_installer_upgrade_rollback")
    inventory = installer._template_inventory(installer.read_harness_version())
    before = {
        path.relative_to(tmp_repo).as_posix(): path.read_bytes()
        for path in tmp_repo.rglob("*") if path.is_file()
    }
    original = installer.atomic_bytes
    calls = {"forward": 0}

    def fail_second(path, value, mode=0o644, *args, **kwargs):
        if not str(path).endswith("harness-install-state.json") and calls["forward"] < 2:
            calls["forward"] += 1
            if calls["forward"] == 2:
                raise OSError("injected later write failure")
        return original(path, value, mode, *args, **kwargs)

    monkeypatch.setattr(installer, "atomic_bytes", fail_second)
    code, _ = installer._run_upgrade(
        tmp_repo, version=installer.read_harness_version(), inventory=inventory, dry_run=False
    )
    assert code == 2
    after = {
        path.relative_to(tmp_repo).as_posix(): path.read_bytes()
        for path in tmp_repo.rglob("*") if path.is_file()
    }
    assert after == before


def test_upgrade_rechecks_content_at_atomic_write_and_preserves_concurrent_edit(tmp_repo, monkeypatch):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module("prime_harness_installer_upgrade_race")
    inventory = installer._template_inventory(installer.read_harness_version())
    managed = tmp_repo / "harness/backup.py"
    original = installer.atomic_bytes
    injected = b"# concurrent edit\n"
    raced = {"done": False}

    def race(path, value, mode=0o644, *args, **kwargs):
        if path == managed and not raced["done"]:
            raced["done"] = True
            path.write_bytes(path.read_bytes() + injected)
        return original(path, value, mode, *args, **kwargs)

    monkeypatch.setattr(installer, "atomic_bytes", race)
    code, _ = installer._run_upgrade(
        tmp_repo, version=installer.read_harness_version(), inventory=inventory, dry_run=False
    )
    assert code == 2
    assert managed.read_bytes().endswith(injected)


def test_upgrade_treats_deletion_as_customization_and_refreshes_unedited_stale_sidecar(tmp_repo):
    _prepare_old_version_install(tmp_repo)
    deleted = tmp_repo / "harness/backup.py"
    deleted.unlink()
    first = run_install(tmp_repo, "--upgrade")
    assert first.returncode == 0, first.stdout + first.stderr
    assert not deleted.exists()
    assert (tmp_repo / "harness/backup.py.new").read_bytes() == (
        HARNESS_ROOT / "template/harness/backup.py"
    ).read_bytes()

    modified = tmp_repo / "harness/scorecard.py"
    modified.write_bytes(modified.read_bytes() + b"# local edit\n")
    second = run_install(tmp_repo, "--upgrade")
    assert second.returncode == 0, second.stdout + second.stderr
    sidecar = tmp_repo / "harness/scorecard.py.new"
    old_sidecar = sidecar.read_bytes()

    installer = _load_installer_module("prime_harness_installer_stale_sidecar")
    inventory = installer._template_inventory("0.2.0")
    source, payload, mode = inventory["harness/scorecard.py"]
    inventory["harness/scorecard.py"] = (source, payload + b"# next template\n", mode)
    code, _ = installer._run_upgrade(tmp_repo, version="0.2.0", inventory=inventory, dry_run=False)
    assert code == 0
    assert sidecar.read_bytes() != old_sidecar
    assert sidecar.read_bytes().endswith(b"# next template\n")


def test_legacy_bootstrap_state_excludes_preserved_local_files(tmp_repo):
    local = tmp_repo / "harness/backup.py"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"# legacy customization\n")
    proc = run_install(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    state = json.loads((tmp_repo / INSTALL_STATE).read_text(encoding="utf-8"))
    assert "harness/backup.py" not in state["template_sha256"]
    assert local.read_bytes() == b"# legacy customization\n"
    assert "baseline excludes" in proc.stdout



def test_upgrade_rejects_parent_directory_replacement_after_preflight(tmp_repo, monkeypatch):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module("prime_harness_installer_parent_race")
    inventory = installer._template_inventory(installer.read_harness_version())
    harness = tmp_repo / "harness"
    parked = tmp_repo / "harness-parked"
    original = installer.atomic_bytes
    raced = {"done": False}

    def race(path, value, mode=0o644, *args, **kwargs):
        if path == harness / "backup.py" and not raced["done"]:
            raced["done"] = True
            harness.rename(parked)
            harness.mkdir()
        return original(path, value, mode, *args, **kwargs)

    monkeypatch.setattr(installer, "atomic_bytes", race)
    try:
        code, _ = installer._run_upgrade(
            tmp_repo, version=installer.read_harness_version(), inventory=inventory, dry_run=False
        )
        assert code == 2
        assert not (harness / "backup.py").exists()
    finally:
        if harness.exists():
            shutil.rmtree(harness)
        if parked.exists():
            parked.rename(harness)



def test_upgrade_refreshes_gitignore_and_installed_example_provenance(tmp_repo):
    _prepare_old_version_install(tmp_repo)
    gitignore = tmp_repo / ".gitignore"
    text = gitignore.read_text(encoding="utf-8")
    text = text.replace(".prime/agent/harness-tests/template\n", "")
    gitignore.write_text(text, encoding="utf-8")
    examples = tmp_repo / "artifacts/harness/installed-examples.json"
    examples.unlink()
    proc = run_install(tmp_repo, "--upgrade")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert ".prime/agent/harness-tests/template" in gitignore.read_text(encoding="utf-8").splitlines()
    payload = json.loads(examples.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["files"]



def test_atomic_capture_does_not_clobber_edit_created_after_comparison(tmp_repo, monkeypatch):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module("prime_harness_installer_atomic_capture_race")
    inventory = installer._template_inventory(installer.read_harness_version())
    managed = tmp_repo / "harness/backup.py"
    concurrent = b"# edit after comparison and capture\n"
    original_link = installer.os.link
    injected = {"done": False}
    def race_link(source, destination, *args, **kwargs):
        if Path(destination) == managed and not injected["done"]:
            injected["done"] = True
            managed.write_bytes(concurrent)
        return original_link(source, destination, *args, **kwargs)
    monkeypatch.setattr(installer.os, "link", race_link)
    code, _ = installer._run_upgrade(
        tmp_repo, version=installer.read_harness_version(), inventory=inventory, dry_run=False
    )
    assert code == 2
    assert managed.read_bytes() == concurrent
    held = list(managed.parent.glob(".backup.py.*.hold"))
    assert len(held) == 1
    assert held[0].read_bytes() == b"# old pristine managed file\n"


@pytest.mark.parametrize("modified", [False, True])
def test_upgrade_removes_only_pristine_obsolete_template_files(tmp_repo, modified):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module(f"prime_harness_installer_obsolete_{modified}")
    inventory = installer._template_inventory("0.2.0")
    inventory.pop("harness/backup.py")
    managed = tmp_repo / "harness/backup.py"
    if modified:
        managed.write_bytes(managed.read_bytes() + b"# local obsolete customization\n")
    code, counts = installer._run_upgrade(tmp_repo, version="0.2.0", inventory=inventory, dry_run=False)
    assert code == 0
    if modified:
        assert managed.exists()
        assert counts["obsolete_kept"] == 1
    else:
        assert not managed.exists()
        assert counts["obsolete_removed"] == 1


def test_upgrade_rolls_back_metadata_if_install_state_commit_fails(tmp_repo, monkeypatch):
    _prepare_old_version_install(tmp_repo)
    installer = _load_installer_module("prime_harness_installer_metadata_transaction")
    inventory = installer._template_inventory(installer.read_harness_version())
    gitignore = tmp_repo / ".gitignore"
    gitignore.write_text(gitignore.read_text(encoding="utf-8").replace(
        ".prime/agent/harness-tests/template\n", ""
    ), encoding="utf-8")
    examples = tmp_repo / "artifacts/harness/installed-examples.json"
    examples.unlink()
    before = {
        path.relative_to(tmp_repo).as_posix(): path.read_bytes()
        for path in tmp_repo.rglob("*") if path.is_file()
    }
    original = installer.atomic_bytes
    def fail_state(path, value, mode=0o644, *args, **kwargs):
        if Path(path) == tmp_repo / INSTALL_STATE:
            raise OSError("injected state commit failure")
        return original(path, value, mode, *args, **kwargs)
    monkeypatch.setattr(installer, "atomic_bytes", fail_state)
    code, _ = installer._run_upgrade(
        tmp_repo, version=installer.read_harness_version(), inventory=inventory, dry_run=False
    )
    assert code == 2
    after = {
        path.relative_to(tmp_repo).as_posix(): path.read_bytes()
        for path in tmp_repo.rglob("*") if path.is_file()
    }
    assert after == before


def test_deleted_config_blocks_version_advance_and_emits_owned_sidecar(tmp_repo):
    old_version, _ = _prepare_old_version_install(tmp_repo)
    config = tmp_repo / "harness/config.json"
    config.unlink()
    proc = run_install(tmp_repo, "--upgrade")
    assert proc.returncode == 1
    assert not config.exists()
    assert (tmp_repo / "harness/config.json.new").exists()
    state = json.loads((tmp_repo / INSTALL_STATE).read_text(encoding="utf-8"))
    assert state["installed_version"] == old_version
    assert state["pending_sidecar_sha256"]["harness/config.json"]


def test_config_blocked_upgrade_refreshes_cryptographically_owned_sidecar_across_versions(tmp_repo):
    _prepare_old_version_install(tmp_repo)
    config = tmp_repo / "harness/config.json"
    value = json.loads(config.read_text(encoding="utf-8"))
    value["verification_coverage"] = {"min_evidence_per_100_lines": 2.0}
    config.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    first = run_install(tmp_repo, "--upgrade")
    assert first.returncode == 1
    sidecar = tmp_repo / "harness/config.json.new"
    first_digest = _sha256_bytes(sidecar.read_bytes())

    installer = _load_installer_module("prime_harness_installer_pending_sidecar")
    inventory = installer._template_inventory("0.2.0")
    code, _ = installer._run_upgrade(tmp_repo, version="0.2.0", inventory=inventory, dry_run=False)
    assert code == 1
    assert _sha256_bytes(sidecar.read_bytes()) != first_digest
    assert json.loads(sidecar.read_text(encoding="utf-8"))["prime_harness_version"] == "0.2.0"
    state = json.loads((tmp_repo / INSTALL_STATE).read_text(encoding="utf-8"))
    assert state["installed_version"] == "0.0.0"
    assert state["pending_sidecar_sha256"]["harness/config.json"] == _sha256_bytes(sidecar.read_bytes())
