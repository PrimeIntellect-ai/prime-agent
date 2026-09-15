from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


def _watch_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "watch_id": "watch_a1b2c3d4",
        "path": "/tmp/shared/out",
        "recursive": False,
        "status": "active",
        "created_at": "2026-09-14T12:00:00.000Z",
    }
    payload.update(overrides)
    return payload


class RlmPathWatchTest(unittest.TestCase):
    def test_registers_a_path_watch_with_host_payload(self) -> None:
        host_request = AsyncMock(return_value={"watch": _watch_payload()})

        with patch.object(rlm_module, "host_request", host_request):
            watch = asyncio.run(rlm_module.rlm.watch.path("/tmp/shared/out"))

        self.assertEqual(watch.watch_id, "watch_a1b2c3d4")
        self.assertEqual(watch.path, "/tmp/shared/out")
        self.assertFalse(watch.recursive)
        self.assertEqual(watch.status, "active")
        self.assertIsNone(watch.error)
        host_request.assert_awaited_once_with(
            "rlm.watch_path", {"path": "/tmp/shared/out", "recursive": False}
        )

    def test_rejects_invalid_arguments(self) -> None:
        with self.assertRaises(TypeError):
            asyncio.run(rlm_module.rlm.watch.path(123))
        with self.assertRaises(TypeError):
            asyncio.run(rlm_module.watch_path("/tmp", recursive="yes"))

    def test_lists_gets_and_cancels_watches(self) -> None:
        list_host = AsyncMock(
            return_value={"watches": [_watch_payload(), _watch_payload(status="completed")]}
        )
        with patch.object(rlm_module, "host_request", list_host):
            watches = asyncio.run(rlm_module.rlm.watch.list())
        self.assertEqual([w.status for w in watches], ["active", "completed"])
        list_host.assert_awaited_once_with("rlm.watch_list")

        get_host = AsyncMock(return_value={"watch": _watch_payload(status="failed", error="removed")})
        with patch.object(rlm_module, "host_request", get_host):
            watch = asyncio.run(rlm_module.rlm.watch.get("watch_a1b2c3d4"))
        self.assertEqual(watch.status, "failed")
        self.assertEqual(watch.error, "removed")
        get_host.assert_awaited_once_with("rlm.watch_get", {"watch_id": "watch_a1b2c3d4"})

        cancel_host = AsyncMock(return_value={"watch": _watch_payload(status="completed")})
        with patch.object(rlm_module, "host_request", cancel_host):
            watch = asyncio.run(rlm_module.rlm.watch.cancel("watch_a1b2c3d4"))
        self.assertEqual(watch.status, "completed")
        cancel_host.assert_awaited_once_with("rlm.watch_cancel", {"watch_id": "watch_a1b2c3d4"})

    def test_rejects_malformed_host_payloads(self) -> None:
        host_request = AsyncMock(return_value={"watch": {"watch_id": "watch_x", "path": 3}})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaises(RuntimeError):
                asyncio.run(rlm_module.watch_path("/tmp/shared/out"))


if __name__ == "__main__":
    unittest.main()
