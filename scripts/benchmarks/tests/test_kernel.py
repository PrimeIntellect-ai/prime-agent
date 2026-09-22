from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from kernel import OUTPUT_BYTES, Kernel

FIXTURE = r"""
import json, os, sys, time

def emit(event):
    data = (json.dumps(event) + "\n").encode()
    for index in range(0, len(data), 17):
        os.write(1, data[index:index + 17])

time.sleep(float(sys.argv[1]))
emit({"event": "ready", "protocol": int(sys.argv[3]), "python": "fixture"})
for line in sys.stdin:
    request = json.loads(line)
    rid, kind = request.get("id"), request["type"]
    if kind == "shutdown":
        break
    if kind == "interrupt":
        time.sleep(0.03)
        emit({"event": "error", "id": rid, "ename": "KeyboardInterrupt"})
        emit({"event": "done", "id": rid, "status": "error"})
        continue
    code = request.get("code", "")
    if "interrupt-ready" in code:
        emit({"event": "stdout", "id": rid, "text": "interrupt-ready"})
        continue
    if code == "exit":
        break
    if code == "invalid":
        os.write(1, b'not json\n')
        continue
    time.sleep(float(sys.argv[2]))
    if code.startswith("output:"):
        emit({"event": "stdout", "id": rid, "text": "x" * int(code.split(":")[1])})
    emit({"event": "done", "id": rid, "status": "error" if code == "fail" else "ok"})
"""


class KernelTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.script = self.root / "fixture.py"
        self.script.write_text(FIXTURE)
        self.count = 0

    def launch(self, startup=0, execution=0, protocol=3):
        self.count += 1
        kernel = Kernel(
            [sys.executable, str(self.script), str(startup), str(execution), str(protocol)],
            self.root,
            os.environ.copy(),
            self.root / f"kernel-{self.count}",
        )
        self.addCleanup(kernel.close)
        return kernel

    def test_real_protocol_distinguishes_startup_from_execution_regressions(self):
        timings = []
        for startup, execution in ((0, 0), (0.3, 0.02)):
            kernel = self.launch(startup, execution)
            ready, version = kernel.ready()
            self.assertEqual(version, "fixture")
            timings.append((ready, kernel.batch("pass", 5)))
        self.assertGreater(timings[1][0] - timings[0][0], 0.2)
        self.assertGreater(timings[1][1] - timings[0][1], 0.015)

    def test_complete_output_is_required_even_across_split_frames(self):
        kernel = self.launch()
        kernel.ready()
        self.assertGreater(kernel.batch(f"output:{OUTPUT_BYTES}", 2, output_bytes=OUTPUT_BYTES), 0)
        with self.assertRaisesRegex(RuntimeError, "truncated or missing"):
            kernel.batch("output:31", 1, output_bytes=OUTPUT_BYTES)

    def test_failed_execution_and_invalid_protocol_are_not_timings(self):
        for code, error in (("fail", RuntimeError), ("invalid", ValueError), ("exit", RuntimeError)):
            with self.subTest(code=code):
                kernel = self.launch()
                kernel.ready()
                with self.assertRaises(error):
                    kernel.batch(code, 1)

    def test_interrupt_waits_for_running_cell_and_acknowledgement(self):
        kernel = self.launch()
        kernel.ready()
        self.assertGreaterEqual(kernel.interrupt(), 0.025)
        self.assertGreater(kernel.batch("pass", 1), 0)

    def test_ready_version_and_protocol_deadline_are_enforced(self):
        wrong = self.launch(protocol=2)
        with self.assertRaisesRegex(ValueError, "protocol 3"):
            wrong.ready()
        kernel = self.launch()
        kernel.ready()
        with self.assertRaises(TimeoutError):
            kernel.event(time.perf_counter() + 0.02)


if __name__ == "__main__":
    unittest.main()
