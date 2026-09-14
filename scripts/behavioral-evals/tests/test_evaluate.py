from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluate


class TraceConversionTests(unittest.TestCase):
    def test_trace_record_converts_usage_timing_tools_errors_and_facts(self):
        trace = {
            "task": {"data": {"name": "owner/project/task-one"}},
            "calls": [
                {"usage": {"completion_tokens": 3}},
                {"usage": {"output_tokens": 5}},
                {"usage": {"completion_tokens": True}},
            ],
            "timing": {
                "start": 10,
                "boot": {"end": 11},
                "agent": {"end": 18},
                "scoring": {"end": 21},
            },
            "rewards": {
                "tests": {"score": 0.5, "weight": 2},
                "ignored": {"score": "1"},
            },
            "errors": [{"type": "AgentTimeout", "message": "timed out"}],
            "tools": [{"name": "cpython"}, {"name": "bash"}],
            "nodes": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "I will inspect and edit.",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "name": "cpython",
                                "arguments": json.dumps(
                                    {"code": "await bash('pytest -q')\nedit(path='file.py')"}
                                ),
                            }
                        ],
                    }
                },
                {
                    "message": {
                        "role": "tool",
                        "tool_call_id": "call-1",
                        "content": "done",
                    }
                },
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call-2",
                                "name": "bash",
                                "arguments": "not-json-command",
                            }
                        ],
                    }
                },
            ],
            "is_completed": True,
            "ok": True,
        }
        facts = {
            "unsupported_tool_calls": {"count": 2},
            "tests_after_final_edit": {
                "count": 0,
                "ran_after_final_edit": False,
            },
            "metadata": {"ignored": True},
        }
        episode = {"task": trace["task"], "traces": [trace], "ok": True}
        with patch.object(evaluate, "analyze_trace", return_value=facts) as analyze:
            record = evaluate.trace_record(episode, "taskset")

        analyzer_input = analyze.call_args.args[0]
        self.assertEqual(
            analyzer_input["supported_tools"],
            ["cpython", "bash", "cpython_bash", "cpython_edit"],
        )
        tools = [
            (event.get("type"), event.get("tool"), event.get("command"))
            for event in analyzer_input["events"]
            if event.get("type") in {"tool_call", "tool"}
        ]
        self.assertEqual(
            tools[0],
            ("tool_call", "cpython", "await bash('pytest -q')\nedit(path='file.py')"),
        )
        self.assertCountEqual(
            tools[1:3],
            [
                ("tool", "cpython_bash", "pytest -q"),
                ("tool", "cpython_edit", "file.py"),
            ],
        )
        self.assertEqual(tools[-1], ("tool_call", "bash", "not-json-command"))
        self.assertEqual(record["task"], "task-one")
        self.assertTrue(record["resolved"])
        self.assertEqual(record["output_tokens"], 8)
        self.assertEqual(record["e2e_seconds"], 11.0)
        self.assertEqual(record["model_calls"], 3)
        self.assertEqual(record["tool_calls"], 2)
        self.assertTrue(record["model_timeout"])
        self.assertFalse(record["infrastructure_error"])
        self.assertTrue(record["trace_complete"])
        self.assertEqual(
            record["trace_facts"],
            {
                "unsupported_tool_calls": 2,
                "tests_after_final_edit": 0,
                "no_test_after_final_edit": 1,
            },
        )

    def test_plain_cpython_result_sets_nested_bash_status(self):
        trace = {
            "tools": [{"name": "cpython"}],
            "nodes": [
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "cell-1",
                                "name": "cpython",
                                "arguments": {"code": "await bash('pytest -q')"},
                            }
                        ],
                    }
                },
                {
                    "message": {
                        "role": "tool",
                        "tool_call_id": "cell-1",
                        "content": "BashResult(exit_code=7, output='failed')",
                    }
                },
            ],
        }
        nested = [
            event for event in evaluate.analyzer_input(trace)["events"] if event.get("tool") == "cpython_bash"
        ]
        timeout = evaluate.tool_result_event(
            {"role": "tool", "tool_call_id": "cell-2", "content": "TimeoutError: timed out"}
        )
        self.assertEqual(timeout["status"], "timeout")
        self.assertEqual(
            nested,
            [
                {
                    "type": "tool",
                    "id": "cell-1:nested:1",
                    "tool": "cpython_bash",
                    "command": "pytest -q",
                    "status": "error",
                    "exit_code": 7,
                }
            ],
        )

    def test_analyzer_ignores_replayed_context_without_losing_late_results(self):
        trace = {
            "nodes": [
                {
                    "sampled": True,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "first", "name": "cpython", "arguments": {}}],
                    },
                },
                {"message": {"role": "tool", "tool_call_id": "first", "content": "one"}},
                {
                    "sampled": True,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "second", "name": "cpython", "arguments": {}}],
                    },
                },
                {
                    "sampled": False,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "first", "name": "cpython", "arguments": {}}],
                    },
                },
                {"message": {"role": "tool", "tool_call_id": "first", "content": "one"}},
                {
                    "sampled": False,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "second", "name": "cpython", "arguments": {}}],
                    },
                },
                {"message": {"role": "tool", "tool_call_id": "second", "content": "two"}},
            ]
        }

        events = evaluate.analyzer_input(trace)["events"]

        self.assertEqual(
            [event.get("id") for event in events if event["type"] == "tool_call"],
            ["first", "second"],
        )
        self.assertEqual(
            [event.get("call_id") for event in events if event["type"] == "tool_result"],
            ["first", "second"],
        )
        self.assertEqual(evaluate.tool_call_count(trace), 2)

    def test_analyzer_keeps_duplicate_sampled_call_ids_visible(self):
        trace = {
            "nodes": [
                {
                    "sampled": True,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "shared", "name": "cpython", "arguments": {}}],
                    },
                },
                {
                    "sampled": True,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{"id": "shared", "name": "cpython", "arguments": {}}],
                    },
                },
            ]
        }

        events = evaluate.analyzer_input(trace)["events"]

        self.assertEqual(
            [event.get("id") for event in events if event["type"] == "tool_call"],
            ["shared", "shared"],
        )

    def test_trace_record_rejects_analyzer_structural_loss(self):
        trace = {
            "task": {"data": {"name": "task-three"}},
            "calls": [{}],
            "nodes": [],
            "is_completed": True,
            "ok": True,
        }
        facts = {
            "tests_after_final_edit": {
                "count": 0,
                "ran_after_final_edit": None,
            },
            "meta": {
                "dropped_events": {"malformed": 1},
                "truncated_input": False,
                "truncated_strings": 0,
                "unanswered_calls": 0,
            },
        }
        with patch.object(evaluate, "analyze_trace", return_value=facts):
            record = evaluate.trace_record(
                {"task": trace["task"], "traces": [trace], "ok": True},
                "taskset",
            )
        self.assertFalse(record["trace_complete"])
        self.assertEqual(record["trace_facts"]["trace_integrity_issues"], 1)

    def test_trace_record_marks_errors_before_any_model_call_as_infrastructure(self):
        episode = {
            "task": {"data": {"name": "task-two"}},
            "errors": [{"type": "LaunchError", "message": "failed to start"}],
            "traces": [],
            "ok": False,
        }
        facts = {
            "tests_after_final_edit": {
                "count": 0,
                "ran_after_final_edit": None,
            }
        }
        with patch.object(evaluate, "analyze_trace", return_value=facts):
            record = evaluate.trace_record(episode, "taskset")
        self.assertFalse(record["model_timeout"])
        self.assertTrue(record["infrastructure_error"])
        self.assertFalse(record["trace_complete"])


class TraceIngestionTests(unittest.TestCase):
    def test_read_trace_records_streams_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "traces.jsonl"
            path.write_bytes(b'{"row": 1}\n\n{"row": 2}\n')
            with patch.object(
                evaluate,
                "trace_record",
                side_effect=lambda episode, taskset: (taskset, episode["row"]),
            ):
                records = evaluate.read_trace_records(path, "alpha")
        self.assertEqual(records, [("alpha", 1), ("alpha", 2)])

    def test_read_trace_records_rejects_oversized_rows_and_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "traces.jsonl"
            path.write_bytes(b"{}  \n")
            with (
                patch.object(evaluate, "TRACE_LINE_LIMIT", 4),
                self.assertRaisesRegex(ValueError, "row exceeds"),
            ):
                evaluate.read_trace_records(path, "alpha")

            path.write_bytes(b"{}\n{}\n")
            with (
                patch.object(evaluate, "TRACE_FILE_LIMIT", 5),
                patch.object(evaluate, "trace_record", return_value={}),
                self.assertRaisesRegex(ValueError, "file exceeds"),
            ):
                evaluate.read_trace_records(path, "alpha")

    def test_read_trace_records_rejects_too_many_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "traces.jsonl"
            path.write_bytes(b"{}\n{}\n")
            with (
                patch.object(evaluate, "TRACE_RECORD_LIMIT", 1),
                patch.object(evaluate, "trace_record", return_value={}),
                self.assertRaisesRegex(ValueError, "too many rows"),
            ):
                evaluate.read_trace_records(path, "alpha")


class RunAllTests(unittest.TestCase):
    def test_run_all_retries_a_pre_model_taskset_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configs = root / "configs"
            output = root / "output"
            configs.mkdir()
            (configs / "alpha.toml").write_text("alpha-config\n")
            (configs / "beta.toml").write_text("beta-config\n")
            launches = []

            class Process:
                def __init__(self, return_code):
                    self.return_code = return_code

                def wait(self):
                    return self.return_code

            def popen(command, **kwargs):
                config = Path(command[2])
                run_dir = Path(command[command.index("--output-dir") + 1])
                launches.append((config, run_dir, kwargs))
                is_initial_alpha = config.stem == "alpha" and run_dir == output / "alpha"
                if not is_initial_alpha:
                    (run_dir / "traces.jsonl").write_text("{}\n")
                return Process(1 if is_initial_alpha else 0)

            def convert(_episode, taskset):
                return {
                    "taskset": taskset,
                    "task": f"{taskset}-task",
                    "infrastructure_error": False,
                }

            with (
                patch.object(evaluate.subprocess, "Popen", side_effect=popen),
                patch.object(evaluate, "trace_record", side_effect=convert),
            ):
                stats = {"taskset_retries": 0}
                records = evaluate.run_all(Path("eval"), configs, output, Path("plugin"), stats=stats)

            self.assertEqual(stats["taskset_retries"], 1)
            self.assertEqual(
                [(record["taskset"], record["task"]) for record in records],
                [("beta", "beta-task"), ("alpha", "alpha-task")],
            )
            retry_config = output / "pre-model-retry-configs/alpha.toml"
            self.assertEqual(retry_config.read_text(), "alpha-config\n")
            self.assertFalse((output / "pre-model-retry-configs/beta.toml").exists())
            self.assertEqual(len(launches), 3)
            self.assertEqual(launches[-1][0], retry_config)
            self.assertEqual(launches[-1][1], output / "pre-model-retry/alpha")

    def test_run_all_rejects_nonzero_exit_with_complete_or_partial_traces(self):
        for row_count in (1, 2):
            with (
                self.subTest(row_count=row_count),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                configs = root / "configs"
                output = root / "output"
                configs.mkdir()
                (configs / "alpha.toml").write_text("config\n")

                class Process:
                    def wait(self):
                        return 2

                def popen(command, row_count=row_count, **_kwargs):
                    run_dir = Path(command[command.index("--output-dir") + 1])
                    (run_dir / "traces.jsonl").write_text("{}\n" * row_count)
                    return Process()

                with (
                    patch.object(evaluate.subprocess, "Popen", side_effect=popen),
                    patch.object(evaluate, "trace_record", return_value={}),
                    self.assertRaisesRegex(RuntimeError, "exited with status 2"),
                ):
                    evaluate.run_all(Path("eval"), configs, output, Path("plugin"))


class ValidationTests(unittest.TestCase):
    def test_validate_complete_rejects_incomplete_records(self):
        records = [
            {"taskset": "alpha", "task": "done", "trace_complete": True},
            {"taskset": "alpha", "task": "unfinished", "trace_complete": False},
        ]
        with self.assertRaisesRegex(RuntimeError, "alpha/unfinished"):
            evaluate.validate_complete(records)


class RetryTests(unittest.TestCase):
    def test_retry_narrows_configs_and_replaces_only_infrastructure_failures(self):
        records = [
            {"taskset": "alpha", "task": "a", "infrastructure_error": True},
            {"taskset": "alpha", "task": "b", "infrastructure_error": False},
            {"taskset": "beta", "task": "c", "infrastructure_error": False},
        ]
        replacement = {
            "taskset": "alpha",
            "task": "a",
            "infrastructure_error": False,
            "retried": True,
        }
        manifest = {
            "model": "provider/model",
            "num_rollouts": 1,
            "max_concurrent": 2,
            "tasksets": [
                {"id": "alpha", "tasks": ["a", "b"]},
                {"id": "beta", "tasks": ["c"]},
            ],
        }
        executable = Path("/tmp/eval")
        artifacts = Path("/tmp/artifacts")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with (
                patch("prepare.config_text", return_value="retry-config\n") as config_text,
                patch.object(evaluate, "run_all", return_value=[replacement]) as run_all,
            ):
                result = evaluate.retry_infrastructure_failures(
                    executable,
                    records,
                    manifest,
                    artifacts,
                    "a" * 40,
                    output,
                )

            self.assertEqual((output / "retry-configs/alpha.toml").read_text(), "retry-config\n")
            self.assertFalse((output / "retry-configs/beta.toml").exists())
            narrowed = config_text.call_args.args[0]
            self.assertEqual(narrowed, {"id": "alpha", "tasks": ["a"]})
            run_all.assert_called_once_with(
                executable,
                output / "retry-configs",
                output / "retry",
                evaluate.ROOT,
                stats=None,
            )
        self.assertEqual(result[0], {**replacement, "retries": 1})
        self.assertIs(result[1], records[1])
        self.assertIs(result[2], records[2])

    def test_retry_is_a_noop_without_infrastructure_failures(self):
        records = [{"taskset": "alpha", "task": "a", "infrastructure_error": False}]
        with patch.object(evaluate, "run_all") as run_all:
            result = evaluate.retry_infrastructure_failures(
                Path("eval"),
                records,
                {"tasksets": []},
                Path("artifacts"),
                "a" * 40,
                Path("output"),
            )
        self.assertIs(result, records)
        run_all.assert_not_called()


if __name__ == "__main__":
    unittest.main()
