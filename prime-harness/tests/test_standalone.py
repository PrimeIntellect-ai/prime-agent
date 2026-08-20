from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_standalone_self_ci_is_pinned_cross_platform_cross_shell_and_full_suite():
    workflow = ROOT / ".github/workflows/ci.yml"
    text = workflow.read_text(encoding="utf-8")
    document = yaml.safe_load(text)
    assert document["permissions"] == {"contents": "read"}
    job = document["jobs"]["full-suite"]
    assert set(job["strategy"]["matrix"]["os"]) == {"ubuntu-latest", "windows-latest"}
    assert set(job["strategy"]["matrix"]["shell"]) == {"bash", "pwsh"}
    assert job["defaults"]["run"]["shell"] == "${{ matrix.shell }}"
    steps = job["steps"]
    action_steps = [step for step in steps if "uses" in step]
    assert all(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", step["uses"]) for step in action_steps)
    assert job["timeout-minutes"] == 45
    assert any("--require-hashes -r requirements-ci.txt" in str(step.get("run", "")) for step in steps)
    assert any("bash -n template/harness/burst.sh" == step.get("run") for step in steps)
    assert any("scriptblock" in str(step.get("run", "")).lower() and "burst.ps1" in str(step.get("run", "")) for step in steps)
    assert any(step.get("run") == "python -m pytest -q tests" for step in steps)
    lock = (ROOT / "requirements-ci.txt").read_text(encoding="utf-8")
    assert "pip==25.1.1" in lock and "--hash=sha256:" in lock
    assert "--universal" in lock and "colorama==0.4.6 ; sys_platform == 'win32'" in lock
    assert "secrets." not in text


def test_standalone_version_and_ignore_contracts():
    assert re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n", (ROOT / "VERSION").read_text(encoding="utf-8"))
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert {"__pycache__/", "*.py[cod]", ".pytest_cache/", ".hypothesis/", ".venv/", "artifacts/"}.issubset(ignored)
