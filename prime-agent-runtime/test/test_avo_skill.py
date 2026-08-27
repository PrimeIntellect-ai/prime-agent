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
        self.assertTrue(contract["host_enforces_completion_and_canonical_delivery"])
        self.assertIn("callers may issue only model_opinion", contract["canonical_rule"])
        self.assertIn("every factual claim", contract["factual_claim_rule"])
        self.assertIn("cannot certify themselves", contract["coding_test_rule"])
        self.assertIn("structured prospective plan", contract["experiment_rule"])
        self.assertEqual(contract["horizons"], ["direct", "iterative", "long"])

    def test_initialize_uses_the_host_routed_runtime(self) -> None:
        module = load_skill("avo_initialize_test")
        host = AsyncMock(return_value={"state": {"runId": "run-1"}})
        with patch.object(module, "host_request", host):
            result = asyncio.run(module.initialize("Fix the parser"))
        self.assertEqual(host.await_count, 1)
        self.assertEqual(host.await_args_list[0].args[0], "avo.initialize")
        self.assertEqual(
            host.await_args_list[0].args[1],
            {"objective": "Fix the parser"},
        )
        self.assertEqual(result["execution_contract"]["contract_version"], 8)

    def test_coding_baseline_runs_through_the_host_before_candidate_work(self) -> None:
        module = load_skill("avo_coding_baseline_test")
        host = AsyncMock(return_value={"execution": {"meaningful": True}})
        with patch.object(module, "host_request", host):
            result = asyncio.run(module.run_coding_baseline("python -m pytest -q"))
        self.assertTrue(result["execution"]["meaningful"])
        self.assertEqual(
            host.await_args.args,
            ("avo.verification.baseline.run", {"command": "python -m pytest -q"}),
        )

    def test_model_configure_can_only_escalate_horizon(self) -> None:
        module = load_skill("avo_configure_test")
        host = AsyncMock(return_value={"state": {"routing": {"horizon": "long"}}})
        with patch.object(module, "host_request", host):
            asyncio.run(module.configure(horizon="long"))
            with self.assertRaisesRegex(ValueError, "only escalate"):
                asyncio.run(module.configure(horizon="direct"))
        self.assertEqual(host.await_count, 1)
        self.assertEqual(host.await_args.args, ("avo.configure", {"horizon": "long"}))

    def test_candidate_evaluation_and_direct_cycle_use_host_observed_receipts(self) -> None:
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
            asyncio.run(module.run_evaluation("patch-1", "python -m pytest -q"))
            result = asyncio.run(module.complete_cycle({"candidate_id": "patch-1"}))
        self.assertEqual(host.await_args_list[0].args[0], "avo.candidate.add")
        self.assertEqual(host.await_args_list[1].args[0], "avo.evaluation.run")
        self.assertEqual(
            host.await_args_list[1].args[1],
            {"candidate_id": "patch-1", "command": "python -m pytest -q"},
        )
        self.assertEqual(host.await_args_list[2].args[0], "avo.cycle.complete")
        self.assertEqual(result["cycle"]["cycleId"], "cycle-1")

    def test_model_cannot_claim_authoritative_evaluation(self) -> None:
        module = load_skill("avo_authority_boundary_test")
        with self.assertRaisesRegex(ValueError, "only authority='model_opinion'"):
            asyncio.run(
                module.record_evaluation(
                    {
                        "candidate_id": "patch-1",
                        "evaluator_id": "test",
                        "status": "pass",
                        "authority": "environment",
                        "evidence_refs": ["claimed:test:passed"],
                        "metrics": {},
                    }
                )
            )

    def test_deterministic_and_artifact_evaluations_use_dedicated_host_contracts(self) -> None:
        module = load_skill("avo_bound_general_evaluations_test")
        self.assertIn("verify_deterministic_result", module.__all__)
        self.assertIn("verify_artifacts", module.__all__)
        host = AsyncMock(side_effect=[{"evaluation": {"status": "pass"}}, {"evaluation": {"status": "pass"}}])
        with patch.object(module, "host_request", host):
            asyncio.run(module.verify_deterministic_result("calculation-1"))
            asyncio.run(module.verify_artifacts("report-1"))
        self.assertEqual(
            host.await_args_list[0].args,
            ("avo.evaluation.deterministic", {"candidate_id": "calculation-1"}),
        )
        self.assertEqual(
            host.await_args_list[1].args,
            ("avo.evaluation.artifacts", {"candidate_id": "report-1"}),
        )

    def test_universal_experiment_helpers_bind_host_evaluations_to_trials(self) -> None:
        module = load_skill("avo_experiment_test")
        for helper in (
            "record_experiment",
            "record_trial",
            "run_trial",
            "complete_experiment",
        ):
            self.assertIn(helper, module.__all__)
        host = AsyncMock(
            side_effect=[
                {"experiment": {"experimentId": "experiment-1"}},
                {
                    "trial": {"trialId": "trial-1"},
                    "evaluation": {"issuedBy": "host"},
                },
                {"experiment": {"experimentId": "experiment-1", "status": "completed"}},
            ]
        )
        with patch.object(module, "host_request", host):
            asyncio.run(
                module.record_experiment(
                    {
                        "experiment_id": "experiment-1",
                        "title": "Parser comparison",
                        "hypothesis": "Serialization reduces failures.",
                        "design": "Run the unchanged suite.",
                        "plan": {
                            "candidate_ids": ["candidate-1"],
                            "conditions": [
                                {
                                    "condition_id": "parser-suite",
                                    "command_template": (
                                        "python -m pytest -q tests/test_parser.py "
                                        "--seed {{seed}}"
                                    ),
                                }
                            ],
                            "seeds": ["suite-v1"],
                            "primary_metric": "passed_tests",
                            "metric_direction": "maximize",
                        },
                    }
                )
            )
            trial = asyncio.run(
                module.run_trial(
                    "experiment-1",
                    "candidate-1",
                    "parser-suite",
                    "suite-v1",
                )
            )
            completed = asyncio.run(module.complete_experiment("experiment-1"))
        self.assertEqual(trial["trial"]["trialId"], "trial-1")
        self.assertEqual(trial["evaluation"]["issuedBy"], "host")
        self.assertEqual(completed["experiment"]["status"], "completed")
        self.assertEqual(host.await_args_list[0].args[0], "avo.experiment.record")
        self.assertEqual(
            host.await_args_list[1].args,
            (
                "avo.trial.run",
                {
                    "trial": {
                        "experiment_id": "experiment-1",
                        "candidate_id": "candidate-1",
                        "condition_id": "parser-suite",
                        "seed": "suite-v1",
                    },
                },
            ),
        )
        self.assertEqual(host.await_args_list[2].args[0], "avo.experiment.complete")

    def test_trial_helper_canonicalizes_integer_seeds(self) -> None:
        module = load_skill("avo_integer_seed_test")
        host = AsyncMock(return_value={"trial": {"seed": "7"}})
        with patch.object(module, "host_request", host):
            result = asyncio.run(
                module.run_trial("experiment-1", "candidate-1", "opponent-a", 7)
            )
        self.assertEqual(result["trial"]["seed"], "7")
        self.assertEqual(
            host.await_args.args[1]["trial"],
            {
                "experiment_id": "experiment-1",
                "candidate_id": "candidate-1",
                "condition_id": "opponent-a",
                "seed": "7",
            },
        )

    def test_memory_sync_is_owned_by_the_persistent_host_bridge(self) -> None:
        module = load_skill("avo_host_memory_sync_test")
        host = AsyncMock(return_value={"ok": True, "mirrored": 3})
        with patch.object(module, "host_request", host):
            result = asyncio.run(module.sync_nooa_memory())
        self.assertEqual(result, {"ok": True, "mirrored": 3})
        host.assert_awaited_once_with("avo.memory.sync")
        self.assertEqual(module.nooa_backend_status()["backend"], "host_persistent_nooa_bridge")

    def test_external_tool_binding_uses_a_host_resolved_tool_call(self) -> None:
        module = load_skill("avo_tool_receipt_test")
        host = AsyncMock(return_value={"evaluation": {"issuedBy": "host"}})
        with patch.object(module, "host_request", host):
            result = asyncio.run(
                module.bind_tool_result(
                    "answer-1",
                    "version-claim",
                    "web-search-1",
                    "The current version is 1.2.3.",
                )
            )
        self.assertEqual(result["evaluation"]["issuedBy"], "host")
        self.assertEqual(
            host.await_args.args,
            (
                "avo.evaluation.tool_result",
                {
                    "candidate_id": "answer-1",
                    "claim_id": "version-claim",
                    "tool_call_id": "web-search-1",
                    "exact_quote": "The current version is 1.2.3.",
                },
            ),
        )

    def test_external_url_fetch_and_binding_use_host_https_requests(self) -> None:
        module = load_skill("avo_url_receipt_test")
        host = AsyncMock(
            side_effect=[
                {"source": {"url": "https://example.com/source"}},
                {"evaluation": {"issuedBy": "host"}},
            ]
        )
        with patch.object(module, "host_request", host):
            source = asyncio.run(module.fetch_external_source("https://example.com/source"))
            receipt = asyncio.run(
                module.bind_url(
                    "answer-1",
                    "version-claim",
                    "https://example.com/source",
                    "The current version is 1.2.3.",
                )
            )
        self.assertEqual(source["source"]["url"], "https://example.com/source")
        self.assertEqual(receipt["evaluation"]["issuedBy"], "host")
        self.assertEqual(host.await_args_list[0].args[0], "avo.external.fetch")
        self.assertEqual(
            host.await_args_list[1].args,
            (
                "avo.evaluation.url",
                {
                    "candidate_id": "answer-1",
                    "claim_id": "version-claim",
                    "url": "https://example.com/source",
                    "exact_quote": "The current version is 1.2.3.",
                },
            ),
        )

    def test_recall_delegates_to_the_host_native_nooa_bridge(self) -> None:
        module = load_skill("avo_nooa_host_test")
        host = AsyncMock(
            return_value={
                "memories": [{"memoryId": "memory-1"}],
                "context": "[verified episode] parser fix",
                "backend": "nooa-memory",
            }
        )
        with patch.object(module, "host_request", host):
            result = asyncio.run(module.recall("parser", limit=3))
        self.assertEqual(result["memories"], [{"memoryId": "memory-1"}])
        self.assertEqual(result["backend"], "nooa-memory")
        host.assert_awaited_once_with(
            "avo.memory.recall",
            {"query": "parser", "limit": 3},
        )


if __name__ == "__main__":
    unittest.main()
