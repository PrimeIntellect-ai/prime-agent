from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmCreateSessionTest(unittest.TestCase):
    """Tests for await rlm.create_session(...) — explicit root-session spawn."""

    def test_returns_typed_handle_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-root",
                "session_id": "session-root",
                "name": "my-top-level",
                "session_file": "/tmp/root-sessions/my-top-level/session.jsonl",
                "model": "prime-inference/deepseek/deepseek-v4-flash",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(
                rlm_module.create_session(
                    "analyze shard 1",
                    name="my-top-level",
                    model="prime-inference/deepseek/deepseek-v4-flash",
                    thinking="off",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {
                "prompt": "analyze shard 1",
                "kwargs": {
                    "name": "my-top-level",
                    "model": "prime-inference/deepseek/deepseek-v4-flash",
                    "thinking": "off",
                },
            },
        )
        self.assertEqual(handle.active_session_id, "active-root")
        self.assertEqual(handle.session_id, "session-root")
        self.assertEqual(handle.name, "my-top-level")
        self.assertEqual(handle.session_file, Path("/tmp/root-sessions/my-top-level/session.jsonl"))
        self.assertEqual(handle.model, "prime-inference/deepseek/deepseek-v4-flash")
        self.assertIsInstance(handle.active_session_id, str)
        self.assertIsInstance(handle.session_id, str)
        self.assertIsInstance(handle.name, str)
        self.assertIsInstance(handle.session_file, Path)
        self.assertIsInstance(handle.model, str)

    def test_forwards_minimal_request_without_optional_kwargs(self) -> None:
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-root",
                "session_id": "session-root",
                "name": "generated-name-abc123",
                "session_file": "/tmp/sessions/generated-name-abc123/session.jsonl",
                "model": "anthropic/claude-sonnet-4-5",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(rlm_module.create_session("check status"))

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {"prompt": "check status", "kwargs": {}},
        )
        self.assertEqual(handle.name, "generated-name-abc123")

    def test_rejects_non_string_prompt(self) -> None:
        with self.assertRaisesRegex(TypeError, "prompt must be str"):
            asyncio.run(rlm_module.create_session(42))  # type: ignore[arg-type]

    def test_forwards_partial_kwargs(self) -> None:
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-id",
                "session_id": "session-id",
                "name": "partial-test",
                "session_file": "/tmp/sessions/partial-test/session.jsonl",
                "model": "anthropic/claude-sonnet-4-5",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(rlm_module.create_session("test", name="partial-test"))

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {"prompt": "test", "kwargs": {"name": "partial-test"}},
        )
        self.assertEqual(handle.name, "partial-test")

    def test_rejects_invalid_host_payload(self) -> None:
        host_request = AsyncMock(return_value={})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid payload"):
                asyncio.run(rlm_module.create_session("test"))

    def test_rejects_missing_fields_in_payload(self) -> None:
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-id",
                "session_id": "session-id",
                "name": "test",
                # missing session_file
                "model": "test/test",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid payload"):
                asyncio.run(rlm_module.create_session("test"))

    def test_can_be_called_through_rlm_callable_namespace(self) -> None:
        """Verify the rlm.create_session path (via _RLMCallable method delegation)."""
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-callable",
                "session_id": "session-callable",
                "name": "via-rlm-namespace",
                "session_file": "/tmp/sessions/via-rlm-namespace/session.jsonl",
                "model": "test/test-model",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(rlm_module.rlm.create_session("test via rlm callable"))

        self.assertEqual(handle.name, "via-rlm-namespace")
        self.assertEqual(handle.model, "test/test-model")
        host_request.assert_awaited_once()


    def test_forwards_cwd_in_kwargs(self) -> None:
        host_request = AsyncMock(
            return_value={
                "active_session_id": "active-id",
                "session_id": "session-id",
                "name": "cwd-test",
                "session_file": "/tmp/sessions/cwd-test/session.jsonl",
                "model": "test/test",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(
                rlm_module.create_session("test", name="cwd-test", cwd="/custom/workspace")
            )

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {
                "prompt": "test",
                "kwargs": {"name": "cwd-test", "cwd": "/custom/workspace"},
            },
        )
        self.assertEqual(handle.name, "cwd-test")

    def test_rejects_empty_cwd(self) -> None:
        with self.assertRaisesRegex(ValueError, "cwd must be a non-empty string"):
            asyncio.run(rlm_module.create_session("test", cwd=""))

    def test_rejects_blank_cwd(self) -> None:
        with self.assertRaisesRegex(ValueError, "cwd must be a non-empty string"):
            asyncio.run(rlm_module.create_session("test", cwd="   "))

if __name__ == "__main__":
    unittest.main()
