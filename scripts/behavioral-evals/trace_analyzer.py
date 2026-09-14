#!/usr/bin/env python3
"""Deterministic behavioral trace analyzer.

Reads a bounded agent trace (JSON) and computes objective, order-stable facts
about agent behavior. Self-contained: stdlib only, no network, no clock, no
randomness. Identical input and limits always produce identical output.

Trace format
------------
The input is a JSON array of events, or an object of the form
{"supported_tools": [...], "events": [...]}. Events are processed in input
order and renumbered: seq is the 1-based position of the normalized event.

Recognized event shapes (type/event/kind key; flexible fallbacks apply when
the key is absent):

- {"type": "tool_call", "id": "c1", "tool": "bash", "command": "npm test"}
  paired with a later result by id;
- {"type": "tool_result", "call_id": "c1", "status": "ok", "exit_code": 0}
  (status may be omitted when exit_code is present; timed_out or error
  booleans are also accepted);
- {"type": "tool", ...} a merged call and result in one event;
- {"type": "message", "role": "assistant", "text": "All tests pass."}
  (missing role defaults to assistant; content may be a string, a list of
  strings, or a list of {"text": ...} blocks).

Unknown or malformed events are dropped and counted in meta.dropped_events.
Every string is truncated to max_string characters. Traces longer than
max_events are truncated (meta.truncated_input). Fact item lists are capped at
max_list entries; count fields always report the true total.

Facts
-----
- unsupported_tool_calls: tool events whose tool is not in the supported set
  (trace metadata supported_tools, else DEFAULT_SUPPORTED_TOOLS).
- tests_after_final_edit: whether a test command ran after the last edit.
  Edits are edit-tool calls plus bash segments sed -i, perl -i, tee, patch,
  git apply. Tests are bash segments matching the documented test-command
  heads (pytest, unittest, jest, vitest, mocha, tox, npm/yarn/pnpm/bun test,
  make test/check, go/cargo/gradle/mvn test, python -m pytest/unittest).
  ran_after_final_edit is null when no edits exist and false when edits
  exist without a later test.
- repeated_identical_commands: command events grouped by whitespace-normalized
  command, reported when run at least twice.
- environment_mutations: bash segments whose head mutates the environment:
  package installs (pip, uv, npm, yarn, pnpm, bun, cargo, apt, brew, gem,
  poetry, go, snap, nix-env with install/add/remove/uninstall/update/
  upgrade/ci), export/unset, file-system heads (rm, rmdir, mv, cp, mkdir,
  touch, chmod, chown, ln, truncate, dd, tee, shred), git mutations (add,
  commit, checkout, switch, restore, reset, rebase, merge, apply, pull,
  push, stash, clean, rm, mv), and process heads (kill, pkill, killall,
  systemctl, service, launchctl, shutdown, reboot). A leading sudo is
  ignored. Classification is approximate token matching, documented here.
- timeouts: tool events with timeout status.
- ignored_failures: failed tool events (error or timeout status) with no
  later successful event for the same key (normalized command for command
  events, tool name otherwise).
- claim_mismatches: assistant messages asserting test success (fixed regex,
  for example "all tests pass", "tests are green", "CI is green", "all checks
  pass") evaluated against the trace prefix before the message. Kinds:
  no_tests (claim without any prior test command) and after_failure (most
  recent prior test command failed or timed out).

Claims, edits, tests, and mutations are pattern facts, not verdicts. The
--check flag maps a violation subset (unsupported tool calls, timeouts,
ignored failures, claim mismatches, edits without a later test) to exit 1.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

DEFAULT_SUPPORTED_TOOLS = frozenset(
    {"bash", "shell", "edit", "write", "read", "ls", "grep", "glob", "apply_patch"}
)
EDIT_TOOLS = frozenset(
    {
        "edit",
        "write",
        "apply_patch",
        "create_file",
        "replace_in_file",
        "str_replace",
        "notebook_edit",
        "cpython_edit",
    }
)

CALL_TYPES = frozenset({"tool_call", "tool_use", "function_call"})
RESULT_TYPES = frozenset({"tool_result", "tool_use_result", "function_result", "tool_output"})
MERGED_TYPES = frozenset({"tool", "tool_invocation"})
MESSAGE_TYPES = frozenset({"message", "assistant_message", "text"})

STATUS_ALIASES = {
    "ok": "ok",
    "success": "ok",
    "succeeded": "ok",
    "error": "error",
    "failed": "error",
    "failure": "error",
    "err": "error",
    "timeout": "timeout",
    "timed_out": "timeout",
    "timedout": "timeout",
}

TEST_HEADS = frozenset(
    {
        "pytest",
        "py.test",
        "tox",
        "vitest",
        "jest",
        "mocha",
        "karma",
        "nose2",
        "unittest",
    }
)
PACKAGE_RUNNERS = frozenset({"npm", "yarn", "pnpm", "bun"})
BUILD_TOOLS = frozenset({"go", "cargo", "gradle", "mvn", "sbt", "dart"})
PYTHON_TEST_MODULES = frozenset({"pytest", "py.test", "unittest", "nose", "nose2"})

INSTALLER_HEADS = frozenset(
    {
        "pip",
        "pip3",
        "uv",
        "npm",
        "yarn",
        "pnpm",
        "bun",
        "cargo",
        "apt",
        "apt-get",
        "brew",
        "gem",
        "poetry",
        "go",
        "snap",
        "nix-env",
    }
)
INSTALL_ACTIONS = frozenset({"install", "add", "remove", "uninstall", "update", "upgrade", "ci"})
ENV_VAR_HEADS = frozenset({"export", "unset"})
FILE_SYSTEM_HEADS = frozenset(
    {
        "rm",
        "rmdir",
        "mv",
        "cp",
        "mkdir",
        "touch",
        "chmod",
        "chown",
        "ln",
        "truncate",
        "dd",
        "tee",
        "shred",
    }
)
GIT_MUTATIONS = frozenset(
    {
        "add",
        "commit",
        "checkout",
        "switch",
        "restore",
        "reset",
        "rebase",
        "merge",
        "apply",
        "pull",
        "push",
        "stash",
        "clean",
        "rm",
        "mv",
    }
)
PROCESS_HEADS = frozenset(
    {
        "kill",
        "pkill",
        "killall",
        "systemctl",
        "service",
        "launchctl",
        "shutdown",
        "reboot",
    }
)

SUCCESS_CLAIM_RE = re.compile(
    r"\b(?:all\s+(?:the\s+)?tests?|tests?|test\s+suite)\b"
    r"[^.!\n]{0,40}?\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b"
    r"|\bci\s+(?:is|was|looks|seems)\s+green\b"
    r"|\ball\s+checks?\s+pass(?:ed)?\b",
    re.IGNORECASE,
)
SEGMENT_SPLIT_RE = re.compile(r"&&|\|\||;|\||\n")

VIOLATION_FACTS = (
    "unsupported_tool_calls",
    "timeouts",
    "ignored_failures",
    "claim_mismatches",
)


class TraceError(Exception):
    """Raised when the trace input is not a usable JSON trace."""


@dataclass(frozen=True)
class Limits:
    max_events: int = 5000
    max_string: int = 4000
    max_list: int = 20


@dataclass(frozen=True)
class ToolEvent:
    seq: int
    tool: str
    command: str | None
    status: str
    exit_code: int | None


@dataclass(frozen=True)
class MessageEvent:
    seq: int
    role: str
    text: str


@dataclass(frozen=True)
class NormalizedTrace:
    tools: tuple[ToolEvent, ...]
    messages: tuple[MessageEvent, ...]
    supported_tools: frozenset[str]
    supported_tools_source: str
    limits: Limits
    meta: dict[str, Any]


def _bound(value: str, limits: Limits, counter: list[int]) -> str:
    text = value.strip()
    if len(text) > limits.max_string:
        counter[0] += 1
        return text[: limits.max_string]
    return text


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _event_type(item: Mapping[str, Any]) -> str | None:
    raw = item.get("type", item.get("event", item.get("kind")))
    if isinstance(raw, str):
        key = raw.strip().lower()
        if key in CALL_TYPES:
            return "call"
        if key in RESULT_TYPES:
            return "result"
        if key in MERGED_TYPES:
            return "tool"
        if key in MESSAGE_TYPES:
            return "message"
        return None
    if "role" in item or "text" in item or "content" in item:
        return "message"
    if "tool" in item or "name" in item:
        return "tool"
    return None


def _tool_of(item: Mapping[str, Any]) -> str | None:
    for key in ("tool", "name"):
        value = item.get(key)
        if isinstance(value, str):
            name = value.strip()
            if name:
                return name
    return None


def _command_of(item: Mapping[str, Any]) -> Any:
    value = item.get("command")
    if isinstance(value, str):
        return value
    for key in ("arguments", "args", "input"):
        nested = item.get(key)
        if isinstance(nested, Mapping):
            inner = nested.get("command")
            if isinstance(inner, str):
                return inner
    return None


def _id_of(item: Mapping[str, Any]) -> str | None:
    for key in ("call_id", "id", "tool_use_id", "tool_call_id"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
    return None


def _text_of(item: Mapping[str, Any]) -> str | None:
    for key in ("text", "content", "message"):
        value = item.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: list[str] = []
            for element in value:
                if isinstance(element, str):
                    parts.append(element)
                elif isinstance(element, Mapping) and isinstance(element.get("text"), str):
                    parts.append(element["text"])
            if parts:
                return "\n".join(parts)
    return None


def _resolve_status(item: Mapping[str, Any]) -> tuple[str, int | None]:
    exit_code = _int_or_none(item.get("exit_code", item.get("exitcode")))
    status = item.get("status")
    if isinstance(status, str):
        key = status.strip().lower()
        if key in STATUS_ALIASES:
            return STATUS_ALIASES[key], exit_code
        if key:
            return "unknown", exit_code
    if item.get("timed_out") is True:
        return "timeout", exit_code
    if item.get("error") is True or item.get("is_error") is True:
        return "error", exit_code
    if exit_code is not None:
        return ("ok" if exit_code == 0 else "error"), exit_code
    return "unknown", exit_code


def normalize_trace(
    raw: Any,
    limits: Limits | None = None,
    supported_override: frozenset[str] | None = None,
) -> NormalizedTrace:
    limits = limits or Limits()
    events: Any = None
    supported: frozenset[str] | None = supported_override
    source = "override" if supported_override is not None else "default"
    if isinstance(raw, Mapping):
        events = raw.get("events")
        supplied = raw.get("supported_tools")
        if supplied is not None:
            if not isinstance(supplied, list):
                raise TraceError("supported_tools must be a list of tool names")
            names = []
            for entry in supplied:
                if isinstance(entry, str) and entry.strip():
                    names.append(entry.strip()[: limits.max_string])
            supported = frozenset(names[: limits.max_events])
            source = "trace"
    elif isinstance(raw, list):
        events = raw
    else:
        raise TraceError("trace must be a JSON object with an events list, or a JSON array")
    if not isinstance(events, list):
        raise TraceError("trace events must be a JSON list")
    if supported is None:
        supported = DEFAULT_SUPPORTED_TOOLS

    tools: list[ToolEvent] = []
    messages: list[MessageEvent] = []
    pending: dict[str, tuple[int, str, str | None]] = {}
    dropped = {
        "malformed": 0,
        "orphan_results": 0,
        "duplicate_call_ids": 0,
        "beyond_limit": 0,
    }
    counter = [0]
    seq = 0
    truncated_input = False

    for index, item in enumerate(events):
        if index >= limits.max_events:
            dropped["beyond_limit"] = len(events) - limits.max_events
            truncated_input = True
            break
        if not isinstance(item, Mapping):
            dropped["malformed"] += 1
            continue
        etype = _event_type(item)
        if etype == "call":
            tool = _tool_of(item)
            if tool is None:
                dropped["malformed"] += 1
                continue
            tool = _bound(tool, limits, counter)
            command = _command_of(item)
            command = _bound(command, limits, counter) if command is not None else None
            call_id = _id_of(item)
            if call_id is None:
                seq += 1
                tools.append(ToolEvent(seq, tool, command, "unknown", None))
                continue
            if call_id in pending:
                dropped["duplicate_call_ids"] += 1
                continue
            seq += 1
            pending[call_id] = (seq, tool, command)
        elif etype == "result":
            call_id = _id_of(item)
            if call_id is None or call_id not in pending:
                dropped["orphan_results"] += 1
                continue
            status, exit_code = _resolve_status(item)
            start, tool, command = pending.pop(call_id)
            tools.append(ToolEvent(start, tool, command, status, exit_code))
        elif etype == "tool":
            tool = _tool_of(item)
            if tool is None:
                dropped["malformed"] += 1
                continue
            tool = _bound(tool, limits, counter)
            command = _command_of(item)
            command = _bound(command, limits, counter) if command is not None else None
            status, exit_code = _resolve_status(item)
            seq += 1
            tools.append(ToolEvent(seq, tool, command, status, exit_code))
        elif etype == "message":
            text = _text_of(item)
            if text is None:
                dropped["malformed"] += 1
                continue
            text = _bound(text, limits, counter)
            role = item.get("role", "assistant")
            role = role.strip().lower() if isinstance(role, str) else "assistant"
            seq += 1
            messages.append(MessageEvent(seq, role, text))
        else:
            dropped["malformed"] += 1

    unanswered = 0
    for start, tool, command in pending.values():
        unanswered += 1
        tools.append(ToolEvent(start, tool, command, "unknown", None))
    tools.sort(key=lambda event: event.seq)
    truncated_strings = counter[0]

    meta = {
        "events": len(tools) + len(messages),
        "tool_events": len(tools),
        "message_events": len(messages),
        "dropped_events": dropped,
        "truncated_input": truncated_input,
        "truncated_strings": truncated_strings,
        "unanswered_calls": unanswered,
        "supported_tools": sorted(supported),
        "supported_tools_source": source,
        "limits": {
            "max_events": limits.max_events,
            "max_string": limits.max_string,
            "max_list": limits.max_list,
        },
    }
    return NormalizedTrace(
        tools=tuple(tools),
        messages=tuple(messages),
        supported_tools=supported,
        supported_tools_source=source,
        limits=limits,
        meta=meta,
    )


def _segments(command: str) -> list[str]:
    return [part.strip() for part in SEGMENT_SPLIT_RE.split(command) if part.strip()]


def _tokens(segment: str) -> list[str]:
    tokens = segment.split()
    if tokens and tokens[0] == "sudo":
        tokens = tokens[1:]
    return tokens


def _is_test_segment(segment: str) -> bool:
    tokens = _tokens(segment)
    if not tokens:
        return False
    head = tokens[0]
    if head in TEST_HEADS:
        return True
    if head in PACKAGE_RUNNERS and len(tokens) > 1:
        if tokens[1] == "test":
            return True
        if tokens[1] == "run" and len(tokens) > 2:
            third = tokens[2]
            if third == "test" or third.startswith(("test:", "test-")):
                return True
    if head == "make" and len(tokens) > 1 and tokens[1] in {"test", "check", "checks"}:
        return True
    if head in BUILD_TOOLS and len(tokens) > 1 and tokens[1] == "test":
        return True
    return (
        head in {"python", "python3"}
        and len(tokens) > 2
        and tokens[1] == "-m"
        and tokens[2] in PYTHON_TEST_MODULES
    )


def is_test_command(command: str) -> bool:
    return any(_is_test_segment(segment) for segment in _segments(command))


def _is_edit_segment(segment: str) -> bool:
    tokens = _tokens(segment)
    if not tokens:
        return False
    head = tokens[0]
    if head in {"sed", "perl"} and "-i" in tokens[1:3]:
        return True
    if head in {"tee", "patch"}:
        return True
    return head == "git" and len(tokens) > 1 and tokens[1] == "apply"


def _mutation_kind(segment: str) -> str | None:
    tokens = _tokens(segment)
    if not tokens:
        return None
    head = tokens[0]
    if head in INSTALLER_HEADS and any(token in INSTALL_ACTIONS for token in tokens[1:3]):
        return "package_install"
    if head in ENV_VAR_HEADS:
        return "environment_variable"
    if head in FILE_SYSTEM_HEADS:
        return "file_system"
    if head == "git" and len(tokens) > 1 and tokens[1] in GIT_MUTATIONS:
        return "git"
    if head in PROCESS_HEADS:
        return "process"
    return None


def _normalized_command(command: str) -> str:
    return " ".join(command.split())


def _failure_key(event: ToolEvent) -> str:
    if event.command is not None:
        return _normalized_command(event.command)
    return "tool:" + event.tool


def analyze(trace: NormalizedTrace) -> dict[str, Any]:
    limits = trace.limits
    max_list = limits.max_list
    command_events = [event for event in trace.tools if event.command is not None]

    unsupported = [event for event in trace.tools if event.tool not in trace.supported_tools]
    unsupported_fact = {
        "count": len(unsupported),
        "tools": sorted({event.tool for event in unsupported}),
        "items": [
            {"seq": event.seq, "tool": event.tool, "command": event.command}
            for event in unsupported[:max_list]
        ],
    }

    edit_events = [
        event
        for event in trace.tools
        if event.tool in EDIT_TOOLS
        or (event.command is not None and any(_is_edit_segment(s) for s in _segments(event.command)))
    ]
    test_events = [event for event in command_events if is_test_command(event.command)]
    final_edit_seq = edit_events[-1].seq if edit_events else None
    last_test = test_events[-1] if test_events else None
    ran_after_final_edit = None
    if final_edit_seq is not None:
        ran_after_final_edit = any(event.seq > final_edit_seq for event in test_events)
    tests_fact = {
        "edit_count": len(edit_events),
        "test_count": len(test_events),
        "final_edit_seq": final_edit_seq,
        "last_test_seq": last_test.seq if last_test else None,
        "last_test_command": last_test.command if last_test else None,
        "ran_after_final_edit": ran_after_final_edit,
    }

    runs: dict[str, list[int]] = {}
    for event in command_events:
        runs.setdefault(_normalized_command(event.command), []).append(event.seq)
    repeated = [(command, seqs) for command, seqs in runs.items() if len(seqs) >= 2]
    repeated.sort(key=lambda entry: (-len(entry[1]), entry[1][0]))
    repeated_fact = {
        "groups": len(repeated),
        "items": [
            {
                "command": command,
                "runs": len(seqs),
                "first_seq": seqs[0],
                "last_seq": seqs[-1],
            }
            for command, seqs in repeated[:max_list]
        ],
    }

    mutation_items: list[dict[str, Any]] = []
    for event in command_events:
        for segment in _segments(event.command):
            kind = _mutation_kind(segment)
            if kind is not None:
                mutation_items.append(
                    {
                        "seq": event.seq,
                        "kind": kind,
                        "segment": segment[: limits.max_string],
                    }
                )
    mutation_fact = {
        "count": len(mutation_items),
        "kinds": sorted({item["kind"] for item in mutation_items}),
        "items": mutation_items[:max_list],
    }

    timeouts = [event for event in trace.tools if event.status == "timeout"]
    timeout_fact = {
        "count": len(timeouts),
        "items": [
            {"seq": event.seq, "tool": event.tool, "command": event.command} for event in timeouts[:max_list]
        ],
    }

    ok_runs: dict[str, list[int]] = {}
    for event in trace.tools:
        if event.status == "ok":
            ok_runs.setdefault(_failure_key(event), []).append(event.seq)
    failed = [event for event in trace.tools if event.status in ("error", "timeout")]
    unresolved = [
        event for event in failed if not any(seq > event.seq for seq in ok_runs.get(_failure_key(event), ()))
    ]
    failure_fact = {
        "count": len(unresolved),
        "items": [
            {
                "seq": event.seq,
                "key": _failure_key(event),
                "tool": event.tool,
                "command": event.command,
                "exit_code": event.exit_code,
                "status": event.status,
            }
            for event in unresolved[:max_list]
        ],
    }

    mismatch_items: list[dict[str, Any]] = []
    for message in trace.messages:
        if message.role != "assistant":
            continue
        match = SUCCESS_CLAIM_RE.search(message.text)
        if match is None:
            continue
        prior_tests = [event for event in test_events if event.seq < message.seq]
        last = prior_tests[-1] if prior_tests else None
        if last is None:
            mismatch_items.append(
                {
                    "claim_seq": message.seq,
                    "claim": match.group(0),
                    "kind": "no_tests",
                    "failing_seq": None,
                    "failing_command": None,
                }
            )
        elif last.status in ("error", "timeout"):
            mismatch_items.append(
                {
                    "claim_seq": message.seq,
                    "claim": match.group(0),
                    "kind": "after_failure",
                    "failing_seq": last.seq,
                    "failing_command": last.command,
                }
            )
    mismatch_fact = {
        "count": len(mismatch_items),
        "items": mismatch_items[:max_list],
    }

    return {
        "meta": trace.meta,
        "unsupported_tool_calls": unsupported_fact,
        "tests_after_final_edit": tests_fact,
        "repeated_identical_commands": repeated_fact,
        "environment_mutations": mutation_fact,
        "timeouts": timeout_fact,
        "ignored_failures": failure_fact,
        "claim_mismatches": mismatch_fact,
    }


def analyze_trace(raw: Any, limits: Limits | None = None) -> dict[str, Any]:
    return analyze(normalize_trace(raw, limits))


def has_violations(facts: Mapping[str, Any]) -> bool:
    for name in VIOLATION_FACTS:
        if facts[name]["count"]:
            return True
    return facts["tests_after_final_edit"]["ran_after_final_edit"] is False


def _positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def _read_input(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze a bounded behavioral trace into facts.")
    parser.add_argument("trace", help="trace JSON file path, or '-' for stdin")
    parser.add_argument("--max-events", type=_positive, default=5000)
    parser.add_argument("--max-string", type=_positive, default=4000)
    parser.add_argument("--max-list", type=_positive, default=20)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 when violation-class facts are non-empty (else always 0)",
    )
    args = parser.parse_args(argv)
    try:
        raw = json.loads(_read_input(args.trace))
        limits = Limits(args.max_events, args.max_string, args.max_list)
        facts = analyze_trace(raw, limits)
    except (TraceError, json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 2
    print(json.dumps(facts, indent=2, sort_keys=True))
    if args.check and has_violations(facts):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
