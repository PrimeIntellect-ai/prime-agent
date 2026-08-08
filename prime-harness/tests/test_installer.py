from __future__ import annotations

import importlib.util
import os
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


def test_reinstall_is_idempotent(tmp_repo):
    run_install(tmp_repo)
    before = (tmp_repo / ".gitignore").read_text(encoding="utf-8")
    proc = run_install(tmp_repo)
    assert proc.returncode == 0
    assert "new files:        0" in proc.stdout
    # .gitignore not duplicated
    assert (tmp_repo / ".gitignore").read_text(encoding="utf-8") == before


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
