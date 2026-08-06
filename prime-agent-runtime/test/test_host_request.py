from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import rlm


class FakeComm:
    instances: list["FakeComm"] = []

    def __init__(self, *, target_name: str, primary: bool) -> None:
        self.target_name = target_name
        self.primary = primary
        self.callback = None
        self.opened = None
        self.closed = False
        self.instances.append(self)

    def on_msg(self, callback) -> None:
        self.callback = callback

    def open(self, *, data) -> None:
        self.opened = data

    def close(self) -> None:
        self.closed = True


class HostRequestTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_request_always_closes_comm(self) -> None:
        FakeComm.instances.clear()
        with patch.object(rlm, "Comm", FakeComm), patch.object(rlm, "_install_control_comm_handlers"):
            task = asyncio.create_task(rlm.host_request("agent_message.wait", {"timeout_ms": 1000}))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(FakeComm.instances[0].opened, {
            "timeout_ms": 1000,
            "type": "agent_message.wait",
        })
        self.assertTrue(FakeComm.instances[0].closed)


if __name__ == "__main__":
    unittest.main()
