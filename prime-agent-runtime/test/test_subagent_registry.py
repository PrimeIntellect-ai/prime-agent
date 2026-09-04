from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmSubagentRegistryTest(unittest.TestCase):
    def test_lists_parent_scoped_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": "active-child",
                        "session_id": "session-child",
                        "session_name": "subagent-check-api-a1b2c3d4",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "completed",
                        "task_id": "task-api",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(subagents[0].active_session_id, "active-child")
        self.assertEqual(subagents[0].session_id, "session-child")
        self.assertEqual(subagents[0].session_name, "subagent-check-api-a1b2c3d4")
        self.assertEqual(subagents[0].session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(subagents[0].status, "completed")
        self.assertEqual(subagents[0].task_id, "task-api")
        host_request.assert_awaited_once_with("rlm.list_subagents")


    def test_lists_failed_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-failed",
                        "active_session_id": None,
                        "session_id": None,
                        "session_name": "failed-worker",
                        "session_dir": "/tmp/parent/sub-failed",
                        "status": "error",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(subagents[0].status, "error")

    def test_forwards_orchestrator_chosen_name_and_model_to_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "api-reviewer",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "deepseek/deepseek-v4-flash",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm(
                    "check the API",
                    name="api-reviewer",
                    model="deepseek/deepseek-v4-flash",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.run",
            {
                "prompt": "check the API",
                "kwargs": {
                    "name": "api-reviewer",
                    "model": "deepseek/deepseek-v4-flash",
                },
            },
        )
        self.assertEqual(result.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(result.name, "api-reviewer")
        self.assertEqual(result.model, "deepseek/deepseek-v4-flash")

    def test_delegates_a_structured_task_atomically(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-task",
                "name": "runtime-reviewer",
                "session_dir": "/tmp/parent/sub-task",
                "model": "zero/balanced",
                "task_id": "task-runtime",
            }
        )
        task = {
            "objective": "Review runtime behavior",
            "scope": "runtime.py",
            "exclusiveClaims": [{"namespace": "repo:file", "key": "runtime.py"}],
            "delegationReason": "Independent runtime boundary",
        }

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm.delegate(
                    "Complete the assigned task contract",
                    task,
                    name="runtime-reviewer",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.delegate",
            {
                "prompt": "Complete the assigned task contract",
                "task": task,
                "kwargs": {"name": "runtime-reviewer"},
            },
        )
        self.assertEqual(result.task_id, "task-runtime")

    def test_replaces_a_task_owner_atomically(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-replacement",
                "name": "replacement",
                "session_dir": "/tmp/parent/sub-replacement",
                "model": "zero/balanced",
                "task_id": "task-runtime",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm.replace(
                    "task-runtime",
                    "Continue from the durable task state",
                    name="replacement",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.replace",
            {
                "task_id": "task-runtime",
                "prompt": "Continue from the durable task state",
                "kwargs": {"name": "replacement"},
            },
        )
        self.assertEqual(result.task_id, "task-runtime")

    def test_exposes_task_progress_and_tree_operations(self) -> None:
        host_request = AsyncMock(side_effect=[{"task": {"id": "task-a"}}, {"snapshot": {"totalTasks": 1}}, {"task": {"id": "task-a"}}])

        with patch.object(rlm_module, "host_request", host_request):
            current = asyncio.run(rlm_module.rlm.task.current())
            snapshot = asyncio.run(rlm_module.rlm.task.snapshot(limit=20))
            updated = asyncio.run(
                rlm_module.rlm.task.update(
                    "Inspected runtime",
                    evidence_refs=["artifact://runtime"],
                    completed_questions=["Concurrency remains bounded"],
                )
            )

        self.assertEqual(current["task"]["id"], "task-a")
        self.assertEqual(snapshot["snapshot"]["totalTasks"], 1)
        self.assertEqual(updated["task"]["id"], "task-a")
        self.assertEqual(
            host_request.await_args_list[2].args,
            (
                "rlm.task.update",
                {
                    "summary": "Inspected runtime",
                    "evidence_refs": ["artifact://runtime"],
                    "completed_questions": ["Concurrency remains bounded"],
                },
            ),
        )

    def test_records_task_plan_and_reusable_handoff(self) -> None:
        host_request = AsyncMock(side_effect=[{"task": {"id": "task-a"}}, {"task": {"id": "task-a"}}])
        handoff = {
            "summary": "One caller remains",
            "evidenceIds": ["evidence-1"],
            "recommendedNextScopes": ["Inspect the caller"],
        }

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(
                rlm_module.rlm.task.plan(
                    "coordinator",
                    "Two independent boundaries",
                    boundaries=["payload", "caller"],
                    expected_evidence=["pinned diff"],
                )
            )
            asyncio.run(rlm_module.rlm.task.handoff(handoff))

        self.assertEqual(
            host_request.await_args_list[0].args,
            (
                "rlm.task.plan",
                {
                    "plan": {
                        "mode": "coordinator",
                        "rationale": "Two independent boundaries",
                        "boundaries": ["payload", "caller"],
                        "expectedEvidence": ["pinned diff"],
                    }
                },
            ),
        )
        self.assertEqual(host_request.await_args_list[1].args, ("rlm.task.handoff", {"handoff": handoff}))

    def test_fetches_full_root_context_on_demand(self) -> None:
        host_request = AsyncMock(return_value={"rootContext": {"manifest": ["a.ts"]}})

        with patch.object(rlm_module, "host_request", host_request):
            context = asyncio.run(rlm_module.rlm.task.root_context())

        self.assertEqual(context, {"manifest": ["a.ts"]})
        host_request.assert_awaited_once_with("rlm.task.root_context")

    def test_defers_coordinator_until_descendants_complete(self) -> None:
        host_request = AsyncMock(return_value={"state": "waiting"})

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.task.defer_until_children_complete())

        self.assertEqual(result, {"state": "waiting"})
        host_request.assert_awaited_once_with("rlm.task.defer_until_children_complete")

    def test_finds_authenticated_models_through_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "models": [
                    {
                        "provider": "anthropic",
                        "id": "claude-opus-4-7",
                        "name": "Claude Opus 4.7",
                        "selector": "anthropic/claude-opus-4-7",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            models = asyncio.run(rlm_module.rlm.find_models("opus", limit=3))

        self.assertEqual(models[0].provider, "anthropic")
        self.assertEqual(models[0].id, "claude-opus-4-7")
        self.assertEqual(models[0].name, "Claude Opus 4.7")
        self.assertEqual(models[0].selector, "anthropic/claude-opus-4-7")
        host_request.assert_awaited_once_with(
            "rlm.find_models",
            {"query": "opus", "limit": 3},
        )

    def test_rejects_invalid_model_search_input_and_response(self) -> None:
        with self.assertRaisesRegex(TypeError, "query must be str"):
            asyncio.run(rlm_module.find_models(123))
        with self.assertRaisesRegex(TypeError, "limit must be int"):
            asyncio.run(rlm_module.find_models("opus", limit="3"))

        host_request = AsyncMock(return_value={"models": [{"provider": "anthropic"}]})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid model entry"):
                asyncio.run(rlm_module.find_models("opus"))

    def test_deletes_subagent_by_name_through_host(self) -> None:
        deleted_payload = {
            "rlm_child_id": "sub-a1b2c3d4",
            "active_session_id": "active-child",
            "session_id": "session-child",
            "session_name": "api-reviewer",
            "session_dir": "/tmp/parent/sub-a1b2c3d4",
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent("  api-reviewer  "))

        self.assertEqual(deleted.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(deleted.session_name, "api-reviewer")
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "api-reviewer"},
        )

    def test_deletes_subagent_object_by_child_id(self) -> None:
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-a1b2c3d4",
            active_session_id=None,
            session_id="session-child",
            session_name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            status="running",
        )
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": subagent.rlm_child_id,
                    "active_session_id": subagent.active_session_id,
                    "session_id": subagent.session_id,
                    "session_name": subagent.session_name,
                    "session_dir": str(subagent.session_dir),
                    "status": subagent.status,
                }
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.delete_subagent(subagent))

        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_rejects_invalid_delete_response_and_target(self) -> None:
        host_request = AsyncMock(return_value={"subagent": {"status": "completed"}})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "rlm.delete_subagent entry is missing rlm_child_id"):
                asyncio.run(rlm_module.delete_subagent("api-reviewer"))

        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.delete_subagent("   "))
        with self.assertRaisesRegex(TypeError, "target must be str or RLMSubagent"):
            asyncio.run(rlm_module.delete_subagent(123))

    def test_rejects_invalid_registry_payload(self) -> None:
        host_request = AsyncMock(return_value={"subagents": [{"status": "completed"}]})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing rlm_child_id"):
                asyncio.run(rlm_module.list_subagents())

    def test_requires_a_default_session_name(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": None,
                        "session_id": "session-child",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "running",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing session_name"):
                asyncio.run(rlm_module.list_subagents())


if __name__ == "__main__":
    unittest.main()
