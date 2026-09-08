import ast
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from core.ast_validator import parse, validate
from core.ledger import capability, confidence, metrics
from core.rollback import VersionController
from evaluator.oracle import expected
from evaluator.verifier import Verifier
from memory.skill_store import MemoryEngine
from sandbox.runner import SandboxRunner
from synthesizer.generator import BINARY, LINEAR, select_strategy
from synthesizer.mutator import mutate_ast
from synthesizer.recombinator import recombine_ast
from main import rollback, run


class FakeRunner:
    def __init__(self, fail_at=None, boot_error=False):
        self.calls = 0
        self.fail_at = fail_at
        self.boot_error = boot_error

    def boot(self):
        if self.boot_error:
            raise RuntimeError("no isolation")

    def execute(self, source, cases):
        self.calls += 1
        if self.calls == self.fail_at:
            raise RuntimeError("simulated failure")
        return {"outputs": expected(cases), "cpu_seconds": 0.001, "peak_bytes": 500}


class LabTests(unittest.TestCase):
    def test_static_rejects_escapes(self):
        for code in ["import os", "def f():\n return eval('1')", "def f():\n return ().__class__",
                     "def f():\n return __builtins__", "def f():\n return open('x')",
                     "@print\ndef f():\n return 1", "def f(x=print('x')):\n return 1",
                     "def f():\n import math", "def f():\n len = 2\n return len"]:
            with self.subTest(code=code), self.assertRaises((ValueError, SyntaxError)):
                validate(parse(code))
        validate(parse(BINARY))

    def test_source_limit(self):
        with self.assertRaises(ValueError):
            parse(" " * 32769)

    def test_all_ten_gates_run(self):
        runner = FakeRunner()
        report = Verifier(runner).verify(BINARY, {"binary_search": {"source": LINEAR}})
        self.assertTrue(report["passed"])
        self.assertEqual([g["number"] for g in report["gates"]], list(range(1, 11)))
        self.assertEqual(runner.calls, 10)

    def test_every_execution_gate_stops_promotion(self):
        for call, gate in [(1, 4), (2, 5), (3, 6), (4, 7), (5, 8), (6, 9), (7, 10)]:
            with self.subTest(gate=gate):
                runner = FakeRunner(fail_at=call)
                report = Verifier(runner).verify(BINARY, {})
                self.assertFalse(report["passed"])
                self.assertEqual(report["gates"][-1]["number"], gate)
                self.assertEqual(runner.calls, call)

    def test_first_three_gates(self):
        for code, runner, gate in [("def", FakeRunner(), 1), ("import os", FakeRunner(), 2),
                                   (BINARY, FakeRunner(boot_error=True), 3)]:
            report = Verifier(runner).verify(code, {})
            self.assertFalse(report["passed"])
            self.assertEqual(report["gates"][-1]["number"], gate)

    def test_host_oracle_rejects_false_output(self):
        runner = FakeRunner()
        runner.execute = lambda source, cases: {"outputs": [-1] * len(cases)}
        report = Verifier(runner).verify(BINARY, {})
        self.assertEqual(report["gates"][-1]["number"], 4)
        self.assertFalse(report["passed"])

    def test_performance_gate(self):
        runner = FakeRunner()
        original = runner.execute
        def slow(source, cases):
            result = original(source, cases)
            result["cpu_seconds"] = 10
            return result
        runner.execute = slow
        report = Verifier(runner).verify(BINARY, {})
        self.assertEqual(report["gates"][-1]["number"], 8)
        self.assertFalse(report["passed"])

    def test_no_docker_no_execution(self):
        with patch("sandbox.runner.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "host execution is forbidden"):
                SandboxRunner().execute(BINARY, [])

    def test_protocol_rejects_short_boolean_nonfinite_outputs(self):
        for response in [{"outputs": []}, {"outputs": [True]},
                         {"outputs": [0], "cpu_seconds": float("nan"), "peak_bytes": 0}]:
            with patch.object(SandboxRunner, "_run", return_value=response):
                with self.assertRaises(RuntimeError):
                    SandboxRunner().execute(BINARY, [([1], 1)])

    def test_isolation_probe_checks_actual_limits(self):
        response = {"uid": 65534, "readonly": True, "seccomp": 2, "no_new_privs": 1,
                    "caps": 0, "memory_max": "536870912", "swap_max": "0",
                    "pids_max": "64", "cpu_max": "100000 100000"}
        with patch.object(SandboxRunner, "_run", return_value=response):
            SandboxRunner().boot()
        for key, value in [("uid", 0), ("readonly", False), ("seccomp", 0),
                           ("memory_max", "max"), ("cpu_max", "200000 100000"),
                           ("swap_max", "max"), ("pids_max", "max"), ("caps", 1)]:
            with self.subTest(key=key), patch.object(SandboxRunner, "_run", return_value=dict(response, **{key: value})):
                with self.assertRaises(RuntimeError):
                    SandboxRunner().boot()

    def test_search_reproducibility(self):
        self.assertEqual(mutate_ast(BINARY, 7), mutate_ast(BINARY, 7))
        validate(ast.parse(recombine_ast(LINEAR, BINARY, 3)))
        self.assertEqual(select_strategy({}), "direct")
        self.assertEqual(select_strategy({"direct": (1, 1)}), "mutation")

    def test_ledger(self):
        self.assertEqual(capability({}, {"x": 1}), 0)
        self.assertEqual(capability({"x": {}}, {"x": 1}), 1)
        self.assertEqual(metrics(1, 1, 2)["delta"], 0)
        self.assertAlmostEqual(confidence(1, 0), 2 / 3)
        with self.assertRaises(ValueError):
            capability({}, {"x": 2})

    def test_checkpoints_rollback_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = MemoryEngine(directory)
            vcs = VersionController(directory)
            first = vcs.snapshot({"binary_search": {"source": LINEAR}})
            memory.activate(first)
            second = vcs.snapshot({"binary_search": {"source": BINARY}}, first)
            memory.activate(second)
            memory.record(BINARY, True, "direct", 1, {"test": True})
            rollback(directory, first)
            self.assertEqual(memory.current(), first)
            self.assertEqual(len(memory.evidence()), 1)
            self.assertEqual(vcs.read(second)["binary_search"]["source"], BINARY)
            self.assertEqual(memory.db.execute("SELECT count(*) FROM events").fetchone()[0], 2)
            with self.assertRaises(ValueError):
                rollback(directory, "f" * 40)
            memory.db.close()

    def test_failed_isolation_records_event_without_activation(self):
        with tempfile.TemporaryDirectory() as directory, patch("sandbox.runner.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Isolation unavailable"):
                run(directory, 1, "demo", "unused")
            memory = MemoryEngine(directory)
            self.assertIsNone(memory.current())
            episode = json.loads(memory.db.execute("SELECT payload FROM events").fetchone()[0])
            self.assertFalse(episode["promoted"])
            self.assertEqual(episode["failed_gate"], "isolation_boot")
            memory.db.close()

    def test_activation_failure_is_transactional(self):
        with tempfile.TemporaryDirectory() as directory, patch("main.SandboxRunner", return_value=FakeRunner()), patch.object(VersionController, "snapshot", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                run(directory, 1, "demo", "unused")
            memory = MemoryEngine(directory)
            self.assertIsNone(memory.current())
            self.assertEqual(memory.history(), {})
            self.assertEqual(memory.evidence(), [])
            memory.db.close()

    def test_repeated_success_is_not_new_capability(self):
        with tempfile.TemporaryDirectory() as directory, patch("main.SandboxRunner", return_value=FakeRunner()):
            run(directory, 2, "demo", "unused")
            memory = MemoryEngine(directory)
            episodes = [json.loads(row[0]) for row in memory.db.execute("SELECT payload FROM events")]
            self.assertEqual(episodes[0]["metrics"]["delta"], 1)
            self.assertEqual(episodes[1]["metrics"]["delta"], 0)
            memory.db.close()


if __name__ == "__main__":
    unittest.main()
