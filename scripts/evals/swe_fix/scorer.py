"""Pure scorer for the swe-fix-loop eval.

The scorer consumes a fixture manifest plus a recorded outcome dict and
produces the rubric verdict. It never runs the agent; the runner records
the outcome and calls in here, so every rule below is unit-testable
without a model or network.
"""

from __future__ import annotations

import json
import re

# One double- or single-quoted Python string literal per match.
STRING_LITERAL = re.compile("\"((?:[^\"\\\\\\n]|\\\\.)*)\"|'((?:[^'\\\\\\n]|\\\\.)*)'")


def score_fixture(fixture: dict, outcome: dict) -> dict:
    """Apply the swe-fix-loop rubric to one recorded outcome.

    Rubric:
      - target test passes after the run
      - every pre-existing test still passes (no regressions)
      - diff containment: changed files stay within the golden patch's file
        list, with a tolerance of 30% of the allowed set (min 1) for
        legitimate collateral changes
      - test-run evidence: the session transcript shows the agent running
        the fixture's test command, via a bash tool call or an ipython
        bash() cell (blocks blind-patch guessing)
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
    """True when the transcript shows the agent running the test command.

    The agent's only built-in tool is the ipython kernel, so shell work
    goes through a bash(...) call inside a cell; both a raw bash tool call
    and an ipython bash() cell count. The test command must appear as a
    whole shell command, so echoes and comments naming it do not.
    """
    probe = test_command.strip()
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
            arguments = block.get("arguments") or {}
            if block.get("name") == "bash":
                command = arguments.get("command")
                if isinstance(command, str) and _runs_command(command, probe):
                    return True
            elif block.get("name") == "ipython":
                code = arguments.get("code")
                if isinstance(code, str) and "bash(" in code:
                    if any(_runs_command(literal, probe) for literal in _string_literals(code)):
                        return True
    return False


def _string_literals(code: str) -> list[str]:
    """The string literals in Python cell code, skipping comment lines."""
    code = "\n".join(line for line in code.splitlines() if not line.lstrip().startswith("#"))
    literals = []
    for match in STRING_LITERAL.finditer(code):
        literals.append(next(group for group in match.groups() if group is not None))
    return literals


def _runs_command(command: str, probe: str) -> bool:
    """True when the probe runs as a whole shell command, not a substring."""
    parts = command.replace("&&", ";").replace("||", ";").replace("|", ";").replace("&", ";")
    for part in parts.replace("\n", ";").split(";"):
        stripped = part.strip()
        if stripped == probe or stripped.startswith(f"{probe} "):
            return True
    return False


def summarize_usage(session_text: str) -> dict:
    """Sum assistant tokens and assistant turns from the session JSONL.

    In --mode json each completed assistant message is emitted once on
    message_end; turn_end repeats the same message, so only message_end
    events are counted.
    """
    tokens = 0
    turns = 0
    for line in session_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "message_end":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        total = usage.get("totalTokens", 0)
        if not isinstance(total, int) or total <= 0:
            continue
        tokens += total
        turns += 1
    return {"tokens": tokens, "turns": turns}
