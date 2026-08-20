from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "template/.github/workflows/prime-harness.yml"


def _assert_workflow_policy(text: str) -> None:
    document = yaml.safe_load(text)
    assert document["permissions"] == {"contents": "read"}
    assert "secrets." not in text
    job = document["jobs"]["public-gates"]
    steps = job["steps"]
    action_steps = [step for step in steps if "uses" in step]
    assert action_steps
    assert all(
        re.fullmatch(
            r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}",
            step["uses"],
        )
        for step in action_steps
    )
    checkout = next(
        index for index, step in enumerate(steps)
        if str(step.get("uses", "")).startswith("actions/checkout@")
    )
    assert steps[checkout].get("with", {}).get("fetch-depth") == 0
    diff_base = next(
        index for index, step in enumerate(steps) if step.get("id") == "diff-base"
    )
    selftests = next(
        index for index, step in enumerate(steps)
        if ".prime/agent/harness-tests/tests" in str(step.get("run", ""))
    )
    doctor = next(
        index for index, step in enumerate(steps)
        if "harness/doctor.py" in str(step.get("run", ""))
    )
    gate = next(
        index for index, step in enumerate(steps)
        if "harness/verify.py" in str(step.get("run", ""))
    )
    assert checkout < diff_base < selftests < doctor < gate


def test_installed_public_workflow_retains_security_and_gate_order_policy():
    _assert_workflow_policy(WORKFLOW.read_text(encoding="utf-8"))


def test_workflow_policy_rejects_mutable_actions_and_write_permissions():
    text = WORKFLOW.read_text(encoding="utf-8")
    text = re.sub(
        r"(actions/checkout)@[0-9a-f]{40}", r"\1@v4", text, count=1
    )
    text = text.replace("  contents: read", "  contents: write", 1)
    with pytest.raises(AssertionError):
        _assert_workflow_policy(text)
