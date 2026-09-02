from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")

PAYLOAD = {
    "active_session_id": "active-root",
    "session_id": "session-root",
    "name": "researcher",
    "session_file": "/tmp/sessions/researcher/session.jsonl",
    "model": "prime-inference/deepseek/deepseek-v4-flash",
}


class RlmCreateSessionTest(unittest.TestCase):
    def test_returns_typed_handle_and_forwards_options(self) -> None:
        host_request = AsyncMock(return_value=PAYLOAD)

        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(
                rlm_module.rlm.create_session(
                    "analyze shard 1",
                    name="researcher",
                    model="prime-inference/deepseek/deepseek-v4-flash",
                    thinking="off",
                    cwd="/tmp/project",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {
                "prompt": "analyze shard 1",
                "kwargs": {
                    "name": "researcher",
                    "model": "prime-inference/deepseek/deepseek-v4-flash",
                    "thinking": "off",
                    "cwd": "/tmp/project",
                },
            },
        )
        self.assertEqual(
            handle,
            rlm_module.RLMCreateSessionHandle(
                active_session_id="active-root",
                session_id="session-root",
                name="researcher",
                session_file=Path("/tmp/sessions/researcher/session.jsonl"),
                model="prime-inference/deepseek/deepseek-v4-flash",
            ),
        )

    def test_omits_unset_options(self) -> None:
        host_request = AsyncMock(return_value=PAYLOAD)

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.create_session("check status"))

        host_request.assert_awaited_once_with(
            "rlm.create_session",
            {"prompt": "check status", "kwargs": {}},
        )

    def test_rejects_non_string_prompt(self) -> None:
        with self.assertRaisesRegex(TypeError, "prompt must be str"):
            asyncio.run(rlm_module.create_session(42))  # type: ignore[arg-type]

    def test_rejects_invalid_host_payload(self) -> None:
        host_request = AsyncMock(return_value={**PAYLOAD, "session_file": ""})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid payload"):
                asyncio.run(rlm_module.create_session("test"))


if __name__ == "__main__":
    unittest.main()
