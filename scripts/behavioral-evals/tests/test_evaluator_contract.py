from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import evaluator_contract


class EvaluatorContractTests(unittest.TestCase):
    def test_fingerprint_changes_for_every_contract_file(self):
        self.assertIn(
            "scripts/behavioral-evals/short-swe.json",
            evaluator_contract.CONTRACT_FILES,
        )
        self.assertIn(
            "scripts/behavioral-evals/prime_agent_candidate.py",
            evaluator_contract.CONTRACT_FILES,
        )
        self.assertIn("scripts/benchmarks/config.json", evaluator_contract.CONTRACT_FILES)
        self.assertIn("scripts/benchmarks/uv.lock", evaluator_contract.CONTRACT_FILES)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in evaluator_contract.CONTRACT_FILES:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_bytes((evaluator_contract.ROOT / relative).read_bytes())
            expected = evaluator_contract.evaluator_contract_fingerprint(root)
            self.assertEqual(evaluator_contract.evaluator_contract_fingerprint(root), expected)
            for relative in evaluator_contract.CONTRACT_FILES:
                path = root / relative
                original = path.read_bytes()
                path.write_bytes(original + b"\n")
                with self.subTest(relative=relative):
                    self.assertNotEqual(
                        evaluator_contract.evaluator_contract_fingerprint(root),
                        expected,
                    )
                path.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
