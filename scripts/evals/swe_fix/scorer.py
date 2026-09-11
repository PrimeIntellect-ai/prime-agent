"""Pure scorer for the swe-fix-loop eval.

The scorer consumes a fixture manifest plus a recorded outcome dict and
produces the rubric verdict. It never runs the agent; the runner records
the outcome and calls in here, so every rule below is unit-testable
without a model or network.
"""

from __future__ import annotations

import json


def score_fixture(fixture: dict, outcome: dict) -> dict:
    """Apply the swe-fix-loop rubric to one recorded outcome.

    Rubric:
      - target test passes after the run
      - every pre-existing test still passes (no regressions)
      - diff containment: changed files stay within the golden patch's file
        list, with a tolerance of 30% of the allowed set (min 1) for
        legitimate collateral changes
      - test-run evidence: the session transcript contains at least one bash
        tool call running the fixture's test command (blocks blind-patch
        guessing)
    ``resolved`` requires every rubric element.
    """
    allowed = list(fixture.get("allowed_files", []))
    changed = list(outcome.get("changed_files", []))
    extras = [path for path in changed if path not in allowed]
    tolerance = max(1, int(len(allowed) * 0.3))
    diff_contained = len(extras) <= tolerance
    evidence = bool(outcome.get("test_run_evidence", False))
    target_passes = bool(outcome.get("target_test_passes", False))
    pre_pass = bool(outcome.get("pre_existing_tests_pass", False))
    usage = outcome.get("usage") or {}
    resolved = target_passes and pre_pass and diff_contained and evidence
    return {
        "fixture": fixture.get("name"),
        "resolved": resolved,
        "target_test_passes": target_passes,
        "pre_existing_tests_pass": pre_pass,
        "diff_contained": diff_contained,
        "extra_changed_files": extras,
        "test_run_evidence": evidence,
        "tokens_used": int(usage.get("tokens", 0)),
        "turns": int(usage.get("turns", 0)),
    }


def test_run_evidence(session_text: str, test_command: str) -> bool:
    """True when the session transcript shows a bash call running the tests.

    Matches a bash toolCall whose command contains the test command (the
    command may be prefixed or wrapped, so a substring test is used).
    """
    probe = _evidence_probe(test_command)
    for line in session_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "toolCall":
                continue
            if block.get("name") != "bash":
                continue
            command = (block.get("arguments") or {}).get("command", "")
            if isinstance(command, str) and probe in command:
                return True
    return False


def _evidence_probe(test_command: str) -> str:
    """The distinctive tail of the test command (e.g. 'npm test').

    Strip leading runner prefixes so wrapped invocations still match.
    """
    return test_command.strip()


def summarize_usage(session_text: str) -> dict:
    """Sum assistant tokens and assistant turns from the session JSONL."""
    tokens = 0
    turns = 0
    for line in session_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        total = usage.get("totalTokens", 0)
        if not isinstance(total, int) or total <= 0:
            continue
        tokens += total
        turns += 1
    return {"tokens": tokens, "turns": turns}
