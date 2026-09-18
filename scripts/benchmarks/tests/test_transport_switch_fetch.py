from __future__ import annotations

import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from schema import PHASE_METRICS, ROOT, Observation, Side
from worker import TRANSPORT_BENCHES, stop_transport_processes, transport, transport_value

REPO = ROOT.parent.parent


class TransportValueTests(unittest.TestCase):
    def test_reads_the_result_line_and_converts_to_float(self):
        self.assertEqual(transport_value('noise\nRESULT {"value": 2}'), 2.0)
        self.assertEqual(transport_value('RESULT {"value": 1, "switch_window_ms": 339}\n'), 1.0)

    def test_rejects_missing_or_malformed_results(self):
        for output in (
            "",
            "no result line at all",
            'RESULT {"value": "1"}',
            'RESULT {"value": true}',
            'RESULT {"value": -1}',
            'RESULT {"value": float("inf")}',
            'RESULT {"switch_window_ms": 339}',
            "RESULT [1, 2, 3]",
        ):
            with self.subTest(output=output):
                with self.assertRaises((RuntimeError, ValueError)):
                    transport_value(output)


class TransportTests(unittest.TestCase):
    def test_records_the_harness_result_with_an_explicit_timeout(self):
        side = Side(sha="a" * 40)
        run_as = Mock(return_value='RESULT {"value": 1}\n')
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("worker.run_as", run_as),
                patch("worker.RESULTS", Path(directory)),
                patch("worker.stop_transport_processes") as stop,
            ):
                transport(side, 0)
            saved = list(Path(directory).glob("*.output"))
        self.assertEqual(side.metrics["switch_fetch"], [Observation(trial=0, value=1.0)])
        for _script, _metric, timeout in TRANSPORT_BENCHES:
            self.assertGreater(timeout, 0)
        # The transport phase drives every registered bench, so the switch-fetch
        # result and its sibling phase entries are recorded together.
        self.assertEqual(run_as.call_count, len(TRANSPORT_BENCHES))
        for script, _metric, timeout in TRANSPORT_BENCHES:
            run_as.assert_any_call(
                "builder",
                [
                    "node",
                    str(ROOT / script),
                    "--dist",
                    str(Path("/home/builder/source/packages/coding-agent/dist")),
                ],
                Path("/home/builder/source"),
                timeout=timeout,
                merge_output=True,
            )
        stop.assert_called_once()
        self.assertEqual(
            sorted(path.name for path in saved),
            sorted(f"{metric}-0.output" for _s, metric, _t in TRANSPORT_BENCHES),
        )

    def test_records_the_harness_failure_and_keeps_the_sweep(self):
        side = Side(sha="a" * 40)
        failure = subprocess.CalledProcessError(
            1, "node", output="switch-fetch-bench failed: switch produced an empty transcript\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("worker.run_as", Mock(side_effect=failure)),
                patch("worker.RESULTS", Path(directory)),
                patch("worker.stop_transport_processes") as stop,
            ):
                transport(side, 3)
            saved = (Path(directory) / "switch_fetch-3.output").read_text()
        sample = side.metrics["switch_fetch"][0]
        self.assertIsNone(sample.value)
        self.assertIn("non-zero exit status", sample.error)
        self.assertIn("empty transcript", sample.error)
        self.assertIn("empty transcript", saved)
        stop.assert_called_once()

    def test_records_the_timeout_failure_without_harness_output(self):
        side = Side(sha="a" * 40)
        failure = subprocess.TimeoutExpired("node", 180)
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("worker.run_as", Mock(side_effect=failure)),
                patch("worker.RESULTS", Path(directory)),
                patch("worker.stop_transport_processes") as stop,
            ):
                transport(side, 0)
            saved = list(Path(directory).glob("*.output"))
        sample = side.metrics["switch_fetch"][0]
        self.assertIsNone(sample.value)
        self.assertIn("timed out", sample.error)
        self.assertEqual(saved, [])
        stop.assert_called_once()

    def test_the_transport_phase_covers_every_benchmark_metric(self):
        recorded = {metric for _, metric, _ in TRANSPORT_BENCHES}
        self.assertEqual(recorded, set(PHASE_METRICS["transport"]))


class StopTransportProcessesTests(unittest.TestCase):
    def test_sweeps_builder_node_processes_with_sigterm_then_returns(self):
        node = SimpleNamespace(name="node", pid=4242)
        server = SimpleNamespace(name="python3", pid=4243)
        kills = []
        os = Mock()
        os.kill = lambda pid, sig: kills.append((pid, sig))
        sightings = [[node, server], []]
        with (
            patch("worker.pwd", Mock(getpwnam=Mock(return_value=SimpleNamespace(pw_uid=1500)))),
            patch("worker.memory", Mock(side_effect=lambda uid: sightings.pop(0) if sightings else [])),
            patch("worker.os", os),
        ):
            stop_transport_processes()
        # Only the daemon-shaped node process is signalled; the python3 artifact server is untouched.
        self.assertEqual(kills, [(4242, signal.SIGTERM)])

    def test_raises_when_node_processes_survive_the_sweep(self):
        node = SimpleNamespace(name="node", pid=4242)
        with (
            patch("worker.pwd", Mock(getpwnam=Mock(return_value=SimpleNamespace(pw_uid=1500)))),
            patch("worker.memory", Mock(return_value=[node])),
            patch("worker.os", Mock()),
        ):
            with self.assertRaisesRegex(RuntimeError, "node processes remain"):
                stop_transport_processes()


class SwitchFetchHarnessTests(unittest.TestCase):
    # test-policy: allow conditional-or-disabled-test -- the built coding-agent dist is required
    @unittest.skipUnless(
        (REPO / "packages/coding-agent/dist/modes/agent-connection/daemon-agent-connection.js").exists(),
        "the coding-agent build is required to run the switch-fetch harness",
    )
    def test_switch_fetch_harness_counts_one_full_history_transfer(self):
        dist = REPO / "packages/coding-agent/dist"
        completed = subprocess.run(
            ["node", str(ROOT / "switch-fetch-bench.mjs"), "--dist", str(dist)],
            capture_output=True,
            text=True,
            timeout=150,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        transfers = transport_value(completed.stdout)
        self.assertEqual(transfers, 1.0)


if __name__ == "__main__":
    unittest.main()
