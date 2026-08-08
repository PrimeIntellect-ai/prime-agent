from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "template" / ".github" / "workflows" / "prime-harness.yml"
HOLDOUT_SMOKE = ROOT / "template" / "checks" / "hidden_holdout" / "test_public_transport_smoke.py"
HOLDOUT_README = ROOT / "template" / "checks" / "hidden_holdout" / "README.md"


def test_public_workflow_uses_existing_profiles_doctor_first_and_pinned_actions():
    text = WORKFLOW.read_text(encoding="utf-8")
    document = yaml.safe_load(text)
    job = document["jobs"]["public-gates"]
    assert job["strategy"]["matrix"]["profile"] == ["default", "holdout"]
    steps = job["steps"]
    selftests = next(
        index for index, step in enumerate(steps)
        if step.get("name") == "Run installed harness component self-tests"
    )
    doctor = next(index for index, step in enumerate(steps) if step.get("name") == "Doctor preflight")
    gate = next(index for index, step in enumerate(steps) if step.get("name", "").startswith("Run existing"))
    assert selftests < doctor < gate
    selftest_command = steps[selftests]["run"]
    assert "python -m pytest -q .prime/agent/harness-tests/tests" in selftest_command
    assert "trap 'rm -f .prime/agent/harness-tests/template' EXIT" in selftest_command
    assert steps[gate]["run"] == 'python harness/verify.py --profile "${{ matrix.profile }}" --json'
    uses = [step["uses"] for step in steps if "uses" in step]
    assert uses
    assert all(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", value) for value in uses)
    assert "harness/manifest.json" not in text
    assert "secrets." not in text
    assert document["permissions"] == {"contents": "read"}


def test_public_holdout_is_explicitly_non_scientific_and_private_patterns_are_docs_only():
    smoke = HOLDOUT_SMOKE.read_text(encoding="utf-8").lower()
    documentation = HOLDOUT_README.read_text(encoding="utf-8").lower()
    assert "not scientific holdout evidence" in smoke
    assert "public transport smoke" in documentation
    assert "reusable workflow" in documentation
    assert "ephemeral" in documentation and "short-lived read-only credential" in documentation
    assert "not the public matrix result" in documentation
