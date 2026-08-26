from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch


SKILL = (
    Path(__file__).parents[2]
    / "packages/coding-agent/skills/avo/src/avo/__init__.py"
)


def load_skill(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AvoSkillTest(unittest.TestCase):
    def test_execution_contract_forbids_model_owned_success(self) -> None:
        module = load_skill("avo_contract_test")
        contract = module.execution_contract()
        self.assertTrue(contract["forbid_runtime_introspection"])
        self.assertIn("model_opinion never commits", contract["canonical_rule"])
        self.assertEqual(contract["horizons"], ["direct", "iterative", "long"])

    def test_initialize_configures_the_same_host_runtime(self) -> None:
        module = load_skill("avo_initialize_test")
        host = AsyncMock(side_effect=[{"state": {}}, {"state": {"runId": "run-1"}}])
        with patch.object(module, "host_request", host):
            result = asyncio.run(
                module.initialize(
                    "Fix the parser",
                    environment="coding",
                    horizon="iterative",
                )
            )
        self.assertEqual(host.await_args_list[0].args[0], "avo.configure")
        self.assertEqual(
            host.await_args_list[0].args[1],
            {"environment": "coding", "horizon": "iterative"},
        )
        self.assertEqual(host.await_args_list[1].args[0], "avo.initialize")
        self.assertEqual(result["execution_contract"]["contract_version"], 1)

    def test_candidate_evaluation_and_direct_cycle_use_host_receipts(self) -> None:
        module = load_skill("avo_cycle_test")
        host = AsyncMock(
            side_effect=[
                {"candidate": {"candidateId": "patch-1"}},
                {"evaluation": {"evaluationId": "test-1"}},
                {"cycle": {"cycleId": "cycle-1"}, "activateSupervisor": False},
            ]
        )
        with patch.object(module, "host_request", host):
            asyncio.run(
                module.add_candidate(
                    {
                        "candidate_id": "patch-1",
                        "kind": "patch",
                        "summary": "Fix parser",
                        "payload": {"digest": "host-computes-it"},
                    }
                )
            )
            asyncio.run(
                module.record_evaluation(
                    {
                        "candidate_id": "patch-1",
                        "evaluator_id": "test",
                        "status": "pass",
                        "authority": "environment",
                        "evidence_refs": ["test:exit=0"],
                        "metrics": {"passed": 4},
                    }
                )
            )
            result = asyncio.run(module.complete_cycle({"candidate_id": "patch-1"}))
        self.assertEqual(host.await_args_list[0].args[0], "avo.candidate.add")
        self.assertEqual(host.await_args_list[1].args[0], "avo.evaluation.record")
        self.assertEqual(host.await_args_list[2].args[0], "avo.cycle.complete")
        self.assertEqual(result["cycle"]["cycleId"], "cycle-1")

    def test_nooa_failure_keeps_host_recall_as_lossless_fallback(self) -> None:
        module = load_skill("avo_nooa_fallback_test")
        host = AsyncMock(
            side_effect=[
                {"memories": [{"memoryId": "memory-1"}]},
                {"state": {"memories": [{"memoryId": "memory-1"}]}},
                {"state": {"memories": [{"memoryId": "memory-1"}]}},
            ]
        )
        with (
            patch.object(module, "host_request", host),
            patch.object(
                module,
                "_run_nooa_sidecar",
                return_value={"ok": False, "reason": "sidecar unavailable"},
            ),
        ):
            result = asyncio.run(module.recall("parser", limit=3))
        self.assertEqual(result["memories"], [{"memoryId": "memory-1"}])
        self.assertFalse(result["nooa"]["ok"])


if __name__ == "__main__":
    unittest.main()
