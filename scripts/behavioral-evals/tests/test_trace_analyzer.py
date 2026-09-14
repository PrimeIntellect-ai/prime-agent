import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trace_analyzer import (
    Limits,
    TraceError,
    analyze_trace,
    has_violations,
    normalize_trace,
)

SCRIPT = Path(__file__).resolve().parents[1] / "trace_analyzer.py"


def tool(command, status="ok", exit_code=0, tool_name="bash", **extra):
    event = {"type": "tool", "tool": tool_name, "command": command, "status": status}
    if exit_code is not None:
        event["exit_code"] = exit_code
    event.update(extra)
    return event


def message(text, role="assistant"):
    return {"type": "message", "role": role, "text": text}


def facts(events, supported=None, limits=None):
    raw = {"events": events}
    if supported is not None:
        raw["supported_tools"] = supported
    return analyze_trace(raw, limits)


class TestNormalize(unittest.TestCase):
    def test_pairs_call_and_result_by_id(self):
        raw = {
            "events": [
                {
                    "type": "tool_call",
                    "id": "c1",
                    "tool": "bash",
                    "command": "npm test",
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "c1",
                    "status": "error",
                    "exit_code": 1,
                },
            ]
        }
        trace = normalize_trace(raw)
        self.assertEqual(len(trace.tools), 1)
        event = trace.tools[0]
        self.assertEqual(
            (event.seq, event.tool, event.command, event.status, event.exit_code),
            (1, "bash", "npm test", "error", 1),
        )
        self.assertEqual(trace.meta["events"], 1)
        self.assertEqual(trace.meta["unanswered_calls"], 0)
        self.assertEqual(trace.meta["dropped_events"]["orphan_results"], 0)

    def test_exit_code_derives_status(self):
        trace = normalize_trace(
            {
                "events": [
                    {"type": "tool", "tool": "bash", "command": "true", "exit_code": 0},
                    {
                        "type": "tool",
                        "tool": "bash",
                        "command": "false",
                        "exit_code": 2,
                    },
                    {"type": "tool", "tool": "bash", "command": "no status"},
                ]
            }
        )
        self.assertEqual([event.status for event in trace.tools], ["ok", "error", "unknown"])

    def test_status_aliases_and_flags(self):
        trace = normalize_trace(
            {
                "events": [
                    {
                        "type": "tool",
                        "tool": "bash",
                        "command": "a",
                        "status": "success",
                    },
                    {
                        "type": "tool",
                        "tool": "bash",
                        "command": "b",
                        "status": "failed",
                    },
                    {
                        "type": "tool",
                        "tool": "bash",
                        "command": "c",
                        "status": "timed_out",
                    },
                    {"type": "tool", "tool": "bash", "command": "d", "timed_out": True},
                    {"type": "tool", "tool": "bash", "command": "e", "error": True},
                    {
                        "type": "tool",
                        "tool": "bash",
                        "command": "f",
                        "status": "bizarre",
                    },
                ]
            }
        )
        self.assertEqual(
            [event.status for event in trace.tools],
            ["ok", "error", "timeout", "timeout", "error", "unknown"],
        )

    def test_orphan_result_and_unanswered_call(self):
        trace = normalize_trace(
            {
                "events": [
                    {"type": "tool_result", "call_id": "missing", "exit_code": 0},
                    {
                        "type": "tool_call",
                        "id": "c2",
                        "tool": "bash",
                        "command": "sleep 1",
                    },
                ]
            }
        )
        self.assertEqual(len(trace.tools), 1)
        self.assertEqual(trace.tools[0].status, "unknown")
        self.assertEqual(trace.meta["dropped_events"]["orphan_results"], 1)
        self.assertEqual(trace.meta["unanswered_calls"], 1)

    def test_duplicate_call_id_dropped(self):
        trace = normalize_trace(
            {
                "events": [
                    {"type": "tool_call", "id": "c1", "tool": "bash", "command": "a"},
                    {"type": "tool_call", "id": "c1", "tool": "bash", "command": "b"},
                ]
            }
        )
        self.assertEqual(len(trace.tools), 1)
        self.assertEqual(trace.tools[0].command, "a")
        self.assertEqual(trace.meta["dropped_events"]["duplicate_call_ids"], 1)

    def test_string_truncation_is_bounded_and_counted(self):
        trace = normalize_trace(
            {
                "events": [
                    {"type": "tool", "tool": "bash", "command": "abcdefghij"},
                    {"type": "message", "text": "x" * 12},
                ]
            },
            limits=Limits(max_string=6),
        )
        self.assertEqual(trace.tools[0].command, "abcdef")
        self.assertEqual(trace.messages[0].text, "xxxxxx")
        self.assertEqual(trace.meta["truncated_strings"], 2)

    def test_event_cap_truncates_input(self):
        events = [{"type": "tool", "tool": "bash", "command": str(i)} for i in range(4)]
        trace = normalize_trace({"events": events}, limits=Limits(max_events=2))
        self.assertEqual(len(trace.tools), 2)
        self.assertTrue(trace.meta["truncated_input"])
        self.assertEqual(trace.meta["dropped_events"]["beyond_limit"], 2)

    def test_nested_arguments_command_extraction(self):
        trace = normalize_trace(
            {
                "events": [
                    {
                        "type": "tool",
                        "tool": "bash",
                        "arguments": {"command": "npm test"},
                    },
                ]
            }
        )
        self.assertEqual(trace.tools[0].command, "npm test")

    def test_unknown_and_malformed_events_dropped(self):
        trace = normalize_trace(
            {
                "events": [
                    {"type": "weird_event"},
                    {"tool": "bash"},
                    "not even a dict",
                    {"type": "tool", "tool": "bash", "command": "ok", "exit_code": 0},
                ]
            }
        )
        # {"tool": "bash"} has no type key but is still a usable merged tool event.
        self.assertEqual(len(trace.tools), 2)
        self.assertEqual(trace.tools[0].status, "unknown")
        self.assertEqual(trace.meta["dropped_events"]["malformed"], 2)

    def test_message_content_blocks(self):
        trace = normalize_trace(
            {
                "events": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "text", "text": "All tests pass."},
                            "done",
                        ],
                    },
                ]
            }
        )
        self.assertEqual(len(trace.messages), 1)
        self.assertEqual(trace.messages[0].role, "assistant")
        self.assertEqual(trace.messages[0].text, "All tests pass.\ndone")

    def test_rejects_non_list_events(self):
        with self.assertRaises(TraceError):
            normalize_trace({"events": {"type": "tool"}})
        with self.assertRaises(TraceError):
            normalize_trace("not a trace")


class TestFacts(unittest.TestCase):
    def test_unsupported_tool_calls(self):
        result = facts(
            [
                {"type": "tool", "tool": "mcp_fetch", "command": None, "exit_code": 0},
                {"type": "tool", "tool": "mcp_fetch", "command": None, "exit_code": 1},
                tool("ls"),
            ]
        )
        unsupported = result["unsupported_tool_calls"]
        self.assertEqual(unsupported["count"], 2)
        self.assertEqual(unsupported["tools"], ["mcp_fetch"])
        self.assertEqual([item["seq"] for item in unsupported["items"]], [1, 2])

        result = facts(
            [{"type": "tool", "tool": "mcp_fetch", "command": None, "exit_code": 0}],
            supported=["bash", "mcp_fetch"],
        )
        self.assertEqual(result["unsupported_tool_calls"]["count"], 0)
        self.assertEqual(result["meta"]["supported_tools_source"], "trace")

    def test_tests_after_final_edit_true(self):
        result = facts(
            [
                {"type": "tool", "tool": "edit", "status": "ok"},
                tool("npm test"),
                message("All tests pass."),
            ]
        )
        check = result["tests_after_final_edit"]
        self.assertEqual(check["edit_count"], 1)
        self.assertEqual(check["ran_after_final_edit"], True)
        self.assertEqual(check["last_test_command"], "npm test")

    def test_tests_after_final_edit_false_when_edit_is_last(self):
        result = facts(
            [
                tool("npm test"),
                {"type": "tool", "tool": "edit", "status": "ok"},
            ]
        )
        check = result["tests_after_final_edit"]
        self.assertEqual(check["ran_after_final_edit"], False)

    def test_tests_after_final_edit_null_without_edits(self):
        result = facts([tool("pytest"), message("All tests pass.")])
        check = result["tests_after_final_edit"]
        self.assertIsNone(check["final_edit_seq"])
        self.assertIsNone(check["ran_after_final_edit"])

    def test_bash_sed_in_place_counts_as_edit(self):
        result = facts(
            [
                tool("sed -i s/a/b/ app.py"),
                tool("pytest"),
            ]
        )
        check = result["tests_after_final_edit"]
        self.assertEqual(check["edit_count"], 1)
        self.assertEqual(check["ran_after_final_edit"], True)

        result = facts([tool("pytest"), tool("sed -i s/a/b/ app.py")])
        self.assertEqual(result["tests_after_final_edit"]["ran_after_final_edit"], False)

    def test_repeated_identical_commands(self):
        result = facts(
            [
                tool("npm  test"),
                tool("ls"),
                tool("npm test"),
                tool("npm test"),
            ]
        )
        repeated = result["repeated_identical_commands"]
        self.assertEqual(repeated["groups"], 1)
        item = repeated["items"][0]
        self.assertEqual(item["command"], "npm test")
        self.assertEqual(item["runs"], 3)
        self.assertEqual(item["first_seq"], 1)
        self.assertEqual(item["last_seq"], 4)

    def test_repeated_commands_ordered_by_runs_then_first_seq(self):
        result = facts(
            [
                tool("a"),
                tool("b"),
                tool("b"),
                tool("c"),
                tool("c"),
            ]
        )
        items = result["repeated_identical_commands"]["items"]
        self.assertEqual([item["command"] for item in items], ["b", "c"])

    def test_environment_mutations_kinds(self):
        result = facts(
            [
                tool("pip install requests"),
                tool("export FOO=1"),
                tool("rm -rf build"),
                tool("git commit -m done"),
                tool("sudo systemctl restart nginx"),
            ]
        )
        mutations = result["environment_mutations"]
        self.assertEqual(mutations["count"], 5)
        self.assertEqual(
            mutations["kinds"],
            [
                "environment_variable",
                "file_system",
                "git",
                "package_install",
                "process",
            ],
        )

    def test_environment_mutations_multi_segment_and_read_only(self):
        result = facts([tool("pip install a && git commit -m ok")])
        self.assertEqual(result["environment_mutations"]["count"], 2)
        self.assertEqual(
            [item["kind"] for item in result["environment_mutations"]["items"]],
            ["package_install", "git"],
        )

        result = facts([tool("ls -la"), tool("cat main.py"), tool("git status")])
        self.assertEqual(result["environment_mutations"]["count"], 0)

    def test_timeouts(self):
        result = facts(
            [
                tool("sleep 30", status="timeout"),
                tool("pytest"),
            ]
        )
        timeouts = result["timeouts"]
        self.assertEqual(timeouts["count"], 1)
        self.assertEqual(timeouts["items"][0]["command"], "sleep 30")

    def test_ignored_failures_unresolved_and_resolved(self):
        result = facts(
            [
                tool("npm test", status="error", exit_code=1),
                tool("npm test"),
                tool("flake8 src", status="error", exit_code=1),
                message("moving on"),
            ]
        )
        failures = result["ignored_failures"]
        self.assertEqual(failures["count"], 1)
        self.assertEqual(failures["items"][0]["key"], "flake8 src")
        self.assertEqual(failures["items"][0]["exit_code"], 1)

    def test_ignored_failures_keyed_by_command(self):
        result = facts(
            [
                tool("npm test", status="error", exit_code=1),
                tool("pytest"),
            ]
        )
        self.assertEqual(result["ignored_failures"]["count"], 1)

    def test_claim_mismatch_after_failure(self):
        result = facts(
            [
                tool("npm test", status="error", exit_code=1),
                message("All tests pass, everything is green."),
            ]
        )
        mismatches = result["claim_mismatches"]
        self.assertEqual(mismatches["count"], 1)
        item = mismatches["items"][0]
        self.assertEqual(item["kind"], "after_failure")
        self.assertEqual(item["failing_seq"], 1)
        self.assertEqual(item["failing_command"], "npm test")

    def test_claim_consistent_after_successful_rerun(self):
        result = facts(
            [
                tool("npm test", status="error", exit_code=1),
                tool("npm test"),
                message("The tests pass."),
            ]
        )
        self.assertEqual(result["claim_mismatches"]["count"], 0)

    def test_claim_mismatch_without_any_tests(self):
        result = facts([message("All tests pass.")])
        item = result["claim_mismatches"]["items"][0]
        self.assertEqual(item["kind"], "no_tests")
        self.assertIsNone(item["failing_seq"])

    def test_claim_from_user_role_ignored(self):
        result = facts([message("All tests pass.", role="user")])
        self.assertEqual(result["claim_mismatches"]["count"], 0)

    def test_claim_evaluated_against_prefix_only(self):
        result = facts(
            [
                tool("pytest"),
                message("All tests pass."),
                tool("npm test", status="error", exit_code=1),
            ]
        )
        self.assertEqual(result["claim_mismatches"]["count"], 0)


class TestDeterminism(unittest.TestCase):
    EVENTS: ClassVar[list[dict]] = [
        {"type": "tool_call", "id": "c1", "tool": "bash", "command": "npm test"},
        {"type": "tool_result", "call_id": "c1", "status": "error", "exit_code": 1},
        {"type": "tool", "tool": "mcp_fetch", "command": None, "exit_code": 0},
        tool("pip install left-pad"),
        message("All tests pass."),
    ]

    def test_identical_input_identical_output(self):
        first = json.dumps(analyze_trace({"events": self.EVENTS}), sort_keys=True)
        second = json.dumps(analyze_trace({"events": self.EVENTS}), sort_keys=True)
        self.assertEqual(first, second)

    def test_fact_counts_on_sample(self):
        result = analyze_trace({"events": self.EVENTS})
        self.assertEqual(result["unsupported_tool_calls"]["count"], 1)
        self.assertEqual(result["ignored_failures"]["count"], 1)
        self.assertEqual(result["claim_mismatches"]["count"], 1)
        self.assertEqual(result["environment_mutations"]["count"], 1)
        self.assertTrue(has_violations(result))


class TestCLI(unittest.TestCase):
    def run_cli(self, argv):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *argv],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_check_exit_one_on_violation_trace(self):
        trace = {
            "events": [
                {
                    "type": "tool",
                    "tool": "bash",
                    "command": "npm test",
                    "status": "error",
                    "exit_code": 1,
                },
                {"type": "message", "text": "All tests pass."},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.json"
            path.write_text(json.dumps(trace), encoding="utf-8")
            run = self.run_cli(["--check", str(path)])
        self.assertEqual(run.returncode, 1, run.stderr)
        payload = json.loads(run.stdout)
        self.assertEqual(payload["claim_mismatches"]["count"], 1)

    def test_check_exit_zero_on_clean_trace(self):
        trace = {
            "events": [
                {"type": "tool", "tool": "edit", "status": "ok"},
                {
                    "type": "tool",
                    "tool": "bash",
                    "command": "pytest",
                    "status": "ok",
                    "exit_code": 0,
                },
                {"type": "message", "text": "All tests pass."},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.json"
            path.write_text(json.dumps(trace), encoding="utf-8")
            run = self.run_cli(["--check", str(path)])
        self.assertEqual(run.returncode, 0, run.stderr)
        payload = json.loads(run.stdout)
        self.assertFalse(has_violations(payload))

    def test_invalid_input_exit_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.json"
            path.write_text("not json", encoding="utf-8")
            run = self.run_cli([str(path)])
        self.assertEqual(run.returncode, 2)
        self.assertTrue(run.stderr.startswith("error:"))

    def test_cli_output_deterministic(self):
        trace = {
            "events": [
                {
                    "type": "tool",
                    "tool": "bash",
                    "command": "make check",
                    "status": "ok",
                },
                {"type": "message", "text": "All tests pass."},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.json"
            path.write_text(json.dumps(trace), encoding="utf-8")
            first = self.run_cli([str(path)])
            second = self.run_cli([str(path)])
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stdout, second.stdout)


if __name__ == "__main__":
    unittest.main()
