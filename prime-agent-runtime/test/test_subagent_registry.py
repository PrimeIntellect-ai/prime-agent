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

    def test_forwards_per_spawn_service_tier_to_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "priority-worker",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "openai-codex/gpt-5.5",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.rlm("use the priority tier", service_tier="priority"))
            asyncio.run(rlm_module.rlm("use the default tier", service_tier=None))

        self.assertEqual(host_request.await_args_list[0].args[1]["kwargs"]["service_tier"], "priority")
        self.assertIsNone(host_request.await_args_list[1].args[1]["kwargs"]["service_tier"])

    def test_rejects_invalid_per_spawn_service_tier(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "service_tier must be one of auto, default, flex, scale, priority or None",
        ):
            asyncio.run(rlm_module.rlm("invalid tier", service_tier="fast"))

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
