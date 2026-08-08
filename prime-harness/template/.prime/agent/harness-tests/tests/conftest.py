from __future__ import annotations

import subprocess
import sys
import types

# Import template packages without polluting the distributable tree with bytecode.
sys.dont_write_bytecode = True
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = HARNESS_ROOT / "template" / ".prime" / "agent" / "skills"

for package in ("harness-orchestrator", "sci-verify", "evidence-ledger", "external-critic", "repo-map"):
    src = SKILLS_DIR / package / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def tmp_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A minimal git repository, with cwd switched into it."""
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True, capture_output=True)
    _git(tmp_path, "config", "user.email", "harness@test.local")
    _git(tmp_path, "config", "user.name", "Harness Test")
    (tmp_path / "README.md").write_text("test repo\n", encoding="utf-8")
    _git(tmp_path, "add", "README.md")
    _git(tmp_path, "commit", "-qm", "init")
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def fake_rlm(monkeypatch: pytest.MonkeyPatch):
    """Inject a stub `rlm` kernel module capturing spawn calls."""
    calls: list[dict] = []
    module = types.ModuleType("rlm")

    async def run(prompt: str, **kwargs):
        calls.append({"prompt": prompt, "kwargs": kwargs})
        return types.SimpleNamespace(rlm_child_id="child-123", name=kwargs.get("name"))

    module.run = run
    monkeypatch.setitem(sys.modules, "rlm", module)
    return calls
