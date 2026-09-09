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
            subagents = asyncio.run(rlm_module.list_subagents())

        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(subagents[0].session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(subagents[0].status, "completed")
        self.assertEqual(subagents[0].session_name, "subagent-check-api-a1b2c3d4")
        self.assertIsNone(subagents[0].execution)
        self.assertFalse(subagents[0].is_hosted)

    def test_propagates_delete_response(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": "sub-api-reviewer",
                    "active_session_id": "active-reviewer",
                    "session_id": "session-reviewer",
                    "session_name": "subagent-api-reviewer",
                    "session_dir": "/tmp/parent/sub-api-reviewer",
                    "status": "completed",
                }
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result: rlm_module.RLMSubagent = asyncio.run(rlm_module.delete_subagent("api-reviewer"))

        self.assertEqual(result.rlm_child_id, "sub-api-reviewer")
        self.assertEqual(result.session_dir, Path("/tmp/parent/sub-api-reviewer"))
        self.assertEqual(result.status, "completed")


class RlmSpawnHandleHostedTest(unittest.TestCase):
    """Test hosted arm of RLMSpawnHandle parser."""

    def test_accepts_hosted_spawn_payload(self) -> None:
        payload = {
            "rlm_child_id": "sub-xyz789",
            "name": "hosted-worker",
            "model": "other/model",
            "execution": {"type": "prime-sandbox"},
        }
        handle = rlm_module._spawn_handle_from_payload(payload)
        self.assertEqual(handle.rlm_child_id, "sub-xyz789")
        self.assertEqual(handle.name, "hosted-worker")
        self.assertIsNone(handle.session_dir)
        self.assertEqual(handle.model, "other/model")
        self.assertIsNotNone(handle.execution)
        self.assertTrue(handle.is_hosted)

    def test_hosted_execution_is_immutable(self) -> None:
        payload = {
            "rlm_child_id": "sub-xyz789",
            "name": "hosted-worker",
            "model": "other/model",
            "execution": {"type": "prime-sandbox"},
        }
        handle = rlm_module._spawn_handle_from_payload(payload)
        with self.assertRaises(TypeError):
            handle.execution["type"] = "other"  # type: ignore[index]

    def test_local_repr_unchanged(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc123",
            "name": "worker",
            "session_dir": "/tmp/sessions/abc",
            "model": "provider/model",
        }
        handle = rlm_module._spawn_handle_from_payload(payload)
        self.assertIn("rlm_child_id=", repr(handle))
        self.assertIn("session_dir=", repr(handle))
        self.assertNotIn("execution", repr(handle))

    def test_local_equality_and_hash_unchanged(self) -> None:
        p1 = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "session_dir": "/tmp/s",
            "model": "p/m",
        }
        p2 = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "session_dir": "/tmp/s",
            "model": "p/m",
        }
        h1 = rlm_module._spawn_handle_from_payload(p1)
        h2 = rlm_module._spawn_handle_from_payload(p2)
        self.assertEqual(h1, h2)
        self.assertEqual(hash(h1), hash(h2))

    def test_rejects_mixed_payload_keys(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "session_dir": "/tmp/s",
            "model": "p/m",
            "execution": {"type": "prime-sandbox"},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_extra_keys_local(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "session_dir": "/tmp/s",
            "model": "p/m",
            "extra": "bad",
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_extra_keys_hosted(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "model": "p/m",
            "execution": {"type": "prime-sandbox"},
            "extra": "bad",
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_missing_keys_local(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "session_dir": "/tmp/s",
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_missing_keys_hosted(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "execution": {"type": "prime-sandbox"},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_dict_subclass_payload(self) -> None:
        class MyDict(dict):
            pass
        payload = MyDict({
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "model": "p/m",
            "execution": {"type": "prime-sandbox"},
        })
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_bad_execution_type(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "model": "p/m",
            "execution": {"type": "other"},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_rejects_bad_execution_keys(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "worker",
            "model": "p/m",
            "execution": {"type": "prime-sandbox", "extra": True},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._spawn_handle_from_payload(payload)

    def test_hosted_list_parse(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-hosted-1",
                        "active_session_id": "active-1",
                        "session_id": "session-1",
                        "session_name": "hosted-worker",
                        "status": "running",
                        "execution": {"type": "prime-sandbox"},
                    }
                ]
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.list_subagents())
        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-hosted-1")
        self.assertIsNone(subagents[0].session_dir)
        self.assertIsNotNone(subagents[0].execution)
        self.assertTrue(subagents[0].is_hosted)

    def test_rejects_hosted_subagent_without_home_assigned_session_ids(self) -> None:
        payload = {
            "rlm_child_id": "sub-hosted-1",
            "active_session_id": None,
            "session_id": None,
            "session_name": "hosted-worker",
            "status": "running",
            "execution": {"type": "prime-sandbox"},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._subagent_from_payload(payload)

    def test_hosted_subagent_immutable_execution(self) -> None:
        payload = {
            "rlm_child_id": "sub-hosted-1",
            "active_session_id": "active-hosted-1",
            "session_id": "session-hosted-1",
            "session_name": "hosted-worker",
            "status": "running",
            "execution": {"type": "prime-sandbox"},
        }
        sub = rlm_module._subagent_from_payload(payload)
        with self.assertRaises(TypeError):
            sub.execution["type"] = "other"  # type: ignore[index]

    def test_local_subagent_repr_unchanged(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
        }
        sub = rlm_module._subagent_from_payload(payload)
        self.assertIn("rlm_child_id=", repr(sub))
        self.assertIn("session_dir=", repr(sub))
        self.assertNotIn("execution", repr(sub))

    def test_local_subagent_equality_unchanged(self) -> None:
        p1 = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
        }
        p2 = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
        }
        s1 = rlm_module._subagent_from_payload(p1)
        s2 = rlm_module._subagent_from_payload(p2)
        self.assertEqual(s1, s2)
        self.assertEqual(hash(s1), hash(s2))

    def test_rejects_hostile_mixed_subagent_payload(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
            "execution": {"type": "prime-sandbox"},
        }
        with self.assertRaises(RuntimeError):
            rlm_module._subagent_from_payload(payload)

    def test_rejects_extra_subagent_keys(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
            "extra": "bad",
        }
        with self.assertRaises(RuntimeError):
            rlm_module._subagent_from_payload(payload)

    def test_local_is_hosted_false(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "name": "local-worker",
            "session_dir": "/tmp/s",
            "model": "p/m",
        }
        handle = rlm_module._spawn_handle_from_payload(payload)
        self.assertFalse(handle.is_hosted)

    def test_hosted_is_hosted_true(self) -> None:
        payload = {
            "rlm_child_id": "sub-xyz",
            "name": "hosted-worker",
            "model": "p/m",
            "execution": {"type": "prime-sandbox"},
        }
        handle = rlm_module._spawn_handle_from_payload(payload)
        self.assertTrue(handle.is_hosted)

    def test_local_subagent_is_hosted_false(self) -> None:
        payload = {
            "rlm_child_id": "sub-abc",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker",
            "session_dir": "/tmp/s",
            "status": "running",
        }
        sub = rlm_module._subagent_from_payload(payload)
        self.assertFalse(sub.is_hosted)

    def test_hosted_subagent_is_hosted_true(self) -> None:
        payload = {
            "rlm_child_id": "sub-xyz",
            "active_session_id": "active-hosted-1",
            "session_id": "session-hosted-1",
            "session_name": "hosted-worker",
            "status": "running",
            "execution": {"type": "prime-sandbox"},
        }
        sub = rlm_module._subagent_from_payload(payload)
        self.assertTrue(sub.is_hosted)


if __name__ == "__main__":
    unittest.main()
