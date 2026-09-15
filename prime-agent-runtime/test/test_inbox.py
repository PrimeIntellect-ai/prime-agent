from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmInboxTest(unittest.TestCase):
    def test_list_reads_the_host_snapshot(self) -> None:
        host_request = AsyncMock(
            return_value={
                "entries": [
                    {
                        "id": "entry-1",
                        "messageId": "msg-1",
                        "from": {"activeSessionId": "sender-active", "sessionName": "sender"},
                        "fromRelationship": "child",
                        "receivedAt": "2026-09-15T00:00:00.000Z",
                        "read": False,
                        "preview": "REPORT 481",
                        "content": "REPORT 481",
                    }
                ],
                "unread": 1,
                "total": 1,
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.inbox.list())
        self.assertEqual(result["unread"], 1)
        self.assertEqual(result["entries"][0]["messageId"], "msg-1")
        host_request.assert_awaited_once_with("rlm.inbox.list")

    def test_read_all_sends_no_ids_and_read_specific_sends_ids(self) -> None:
        host_request = AsyncMock(return_value={"entries": [], "unread": 0})
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.inbox.read())
        self.assertEqual(result["unread"], 0)
        host_request.assert_awaited_once_with("rlm.inbox.read", {})

        host_request.reset_mock()
        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.rlm.inbox.read(["entry-1"]))
        host_request.assert_awaited_once_with("rlm.inbox.read", {"ids": ["entry-1"]})


if __name__ == "__main__":
    unittest.main()
