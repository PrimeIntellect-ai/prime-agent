from __future__ import annotations

import re
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
REFERENCE = HARNESS_ROOT / "docs" / "prime-agent-v0.7.0-api-reference.md"


def test_phase1_disposes_every_open_question() -> None:
    text = REFERENCE.read_text(encoding="utf-8")
    section = text.split("# Phase 1 live runtime disposition", 1)[1]
    rows = re.findall(r"^\| (\d+) \| \*\*(RESOLVED|STILL-OPEN)\*\* \|", section, re.MULTILINE)
    assert [int(number) for number, _ in rows] == list(range(1, 46))
    assert all(status in {"RESOLVED", "STILL-OPEN"} for _, status in rows)


def test_settings_merge_discrepancy_is_resolved_with_evidence() -> None:
    text = REFERENCE.read_text(encoding="utf-8")
    assert "settings merge is one-level, not" in text
    assert "settings-deep-merge-probe.log" in text
    assert "Phase 1 selfcheck should test the real semantics" not in text


def test_readme_documents_live_selfcheck() -> None:
    readme = (HARNESS_ROOT / "README.md").read_text(encoding="utf-8")
    assert "await harness_orchestrator.selfcheck()" in readme
    assert "tests/test_live_kernel_e2e.py" in readme
