from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

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
        "harness/verify.py",
        "harness/scorecard.py",
        "harness/replay.py",
        "harness/manifest.json",
        "harness/roster.yaml",
        "harness/doctor.py",
        "checks/evalset/corpus.json",
        "checks/evalset/executors/reference_adapter.py",
        "checks/evalset/snapshots/baseline-v1.json",
        "harness/replay_adapters/README.md",
        "checks/properties/test_example_properties.py",
        "checks/hidden_holdout/README.md",
    ):
        assert (tmp_repo / expected).is_file(), f"missing {expected}"
    assert "harness/scorecard.py" in proc.stdout
    assert "harness/replay.py" in proc.stdout
    gitignore = (tmp_repo / ".gitignore").read_text(encoding="utf-8")
    assert "artifacts/harness/" in gitignore
    assert "__pycache__/" in gitignore
    assert "*.py[cod]" in gitignore


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
