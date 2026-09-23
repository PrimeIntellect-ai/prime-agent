from __future__ import annotations

import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from schema import PHASE_METRICS, ROOT, Observation, Side
from worker import TRANSPORT_BENCHES, stop_transport_processes, transport, transport_value


class TransportTests(unittest.TestCase):
    def test_records_each_bench_result_and_failure_with_explicit_timeouts(self):
        side = Side(sha="a" * 40)
        failure = subprocess.CalledProcessError(1, "node", output="bench failed: exploded\n")
        # Every trial drives the full two-bench transport phase: both benches
        # succeed, then both fail, then both time out.
        result = 'RESULT {"value": 1.5}\n'
        timeouts = [subprocess.TimeoutExpired("node", timeout) for _, _, timeout in TRANSPORT_BENCHES]
        run_as = Mock(side_effect=[result, result, failure, failure, *timeouts])
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch("worker.run_as", run_as),
                patch("worker.RESULTS", Path(directory)),
                patch("worker.stop_transport_processes"),
            ):
                for trial in range(3):
                    transport(side, trial)
            saved = sorted(path.name for path in Path(directory).glob("*.output"))
        expected_calls = [
            call(
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
            for script, _metric, timeout in TRANSPORT_BENCHES
        ]
        self.assertEqual(run_as.call_args_list, expected_calls * 3)
        for _script, metric, _timeout in TRANSPORT_BENCHES:
            self.assertEqual(side.metrics[metric][0], Observation(trial=0, value=1.5))
            self.assertIn("exploded", side.metrics[metric][1].error)
            self.assertIn("timed out", side.metrics[metric][2].error)
        self.assertEqual(
            saved,
            sorted(f"{metric}-{trial}.output" for trial in (0, 1) for _s, metric, _t in TRANSPORT_BENCHES),
        )
        self.assertEqual({name for _, name, _ in TRANSPORT_BENCHES}, set(PHASE_METRICS["transport"]))
        self.assertTrue(all(limit > 0 for _, _, limit in TRANSPORT_BENCHES))

    def test_transport_value_reads_the_result_line_and_rejects_malformed_output(self):
        self.assertEqual(transport_value('noise\nRESULT {"value": 12}'), 12.0)
        for output in ("", 'RESULT {"value": "12"}', 'RESULT {"value": true}', "RESULT [1, 2, 3]"):
            with self.subTest(output=output):
                self.assertRaises((RuntimeError, ValueError), transport_value, output)


class StopTransportProcessesTests(unittest.TestCase):
    def test_sweeps_only_builder_node_processes_and_raises_when_strays_survive(self):
        node = SimpleNamespace(name="node", pid=4242)
        kills = []

        def run_sweep(memory):
            os = Mock()
            os.kill = lambda pid, sig: kills.append((pid, sig))
            with (
                patch("worker.pwd", Mock(getpwnam=Mock(return_value=SimpleNamespace(pw_uid=1500)))),
                patch("worker.memory", memory),
                patch("worker.os", os),
            ):
                stop_transport_processes()

        sightings = [[node, SimpleNamespace(name="python3", pid=4243)], []]
        run_sweep(Mock(side_effect=lambda uid: sightings.pop(0)))
        self.assertEqual(kills, [(4242, signal.SIGTERM)])  # the python3 artifact server stays up
        with self.assertRaisesRegex(RuntimeError, "node processes remain"):
            run_sweep(Mock(return_value=[node]))


if __name__ == "__main__":
    unittest.main()
