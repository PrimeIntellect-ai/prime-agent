"""Requires a Docker daemon and the locally built runner image."""
import shutil
import unittest
from evaluator.verifier import Verifier
from sandbox.runner import SandboxRunner
from synthesizer.generator import BINARY


@unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
class DockerIntegrationTests(unittest.TestCase):
    def test_real_ten_gate_execution(self):
        report = Verifier(SandboxRunner()).verify(BINARY, {})
        self.assertTrue(report["passed"], report)
        self.assertEqual(len(report["gates"]), 10)

    def test_infinite_loop_is_terminated(self):
        runner = SandboxRunner(timeout=5)
        runner.boot()
        with self.assertRaises(RuntimeError):
            runner.execute("def binary_search(values, target):\n    while True:\n        pass\n", [([], 0)])

    def test_mutation_rejected(self):
        runner = SandboxRunner()
        runner.boot()
        with self.assertRaises(RuntimeError):
            runner.execute("def binary_search(values, target):\n    values[0] = 99\n    return 0\n", [([1], 1)])


if __name__ == "__main__":
    unittest.main()
