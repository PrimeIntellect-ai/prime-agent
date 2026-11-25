"""Behavioural tests for the edit skill's read-before-edit guard.

Without the kernel's read tracker the guard is a no-op, so these tests load the
real runtime tracker by path, install it, and expose it as ``rlm._read_tracker``
exactly as the kernel does (``rlm.repl`` installs it at boot).
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SKILL = REPO_ROOT / "skills/edit/src/edit/__init__.py"
TRACKER = REPO_ROOT / "prime-agent-runtime/src/rlm/_read_tracker.py"


def _load(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tracker = _load("_read_tracker_test", TRACKER)
tracker.install()
# Shadow any installed rlm: the skill reaches the tracker as rlm._read_tracker.
sys.modules["rlm"] = types.ModuleType("rlm")
sys.modules["rlm"]._read_tracker = tracker  # type: ignore[attr-defined]
edit = _load("edit_test", SKILL)


@pytest.fixture()
def target(tmp_path: Path) -> Path:
    path = tmp_path / "file.txt"
    path.write_text("alpha beta\n", encoding="utf-8")
    return path


def test_unread_file_is_refused(target: Path) -> None:
    with pytest.raises(ValueError, match="was not read in this session"):
        asyncio.run(edit.run(str(target), "alpha", "gamma"))
    assert target.read_text(encoding="utf-8") == "alpha beta\n"


def test_read_then_edit_passes(target: Path) -> None:
    target.read_text(encoding="utf-8")
    assert "Edited" in asyncio.run(edit.run(str(target), "alpha", "gamma"))
    assert target.read_text(encoding="utf-8") == "gamma beta\n"


def test_external_change_is_refused_until_reread(target: Path) -> None:
    target.read_text(encoding="utf-8")
    target.write_text("alpha beta gamma\n", encoding="utf-8")
    with pytest.raises(ValueError, match="changed on disk"):
        asyncio.run(edit.run(str(target), "alpha", "delta"))
    assert target.read_text(encoding="utf-8") == "alpha beta gamma\n"
    target.read_text(encoding="utf-8")
    assert "Edited" in asyncio.run(edit.run(str(target), "alpha", "delta"))
    assert target.read_text(encoding="utf-8") == "delta beta gamma\n"


def test_back_to_back_edits_need_one_read(target: Path) -> None:
    target.read_text(encoding="utf-8")
    asyncio.run(edit.run(str(target), "alpha", "gamma"))
    asyncio.run(edit.run(str(target), "beta", "delta"))
    assert target.read_text(encoding="utf-8") == "gamma delta\n"
