from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, Mock, patch


rlm_module = importlib.import_module("rlm")


class RlmInboxReadTest(unittest.TestCase):
    def test_namespace_forwards_targeted_filter(self) -> None:
        wire = [
            {
                "id": "inbox-1",
                "class": "agent-message",
                "arrivedAtMs": 10,
                "sender": "peer",
                "text": "hello",
                "meta": {
                    "id": "message-1",
                    "richContent": {
                        "type": "blocks",
                        "blocks": [{"type": "text", "text": "full result"}],
                    },
                },
            },
            {
                "id": "inbox-2",
                "class": "agent-message",
                "arrivedAtMs": 12,
                "sender": "peer",
                "text": "again",
                "meta": {},
            },
        ]
        host_request = AsyncMock(return_value={"messages": wire})
        emit = Mock()
        with patch.object(rlm_module, "host_request", host_request), patch.object(rlm_module, "emit", emit):
            messages = asyncio.run(
                rlm_module.rlm.inbox.read(
                    sender="peer",
                    inbox_class="agent-message",
                    since_ms=10,
                    before_ms=20,
                )
            )
        host_request.assert_awaited_once_with(
            "rlm.inbox.read",
            {
                "sender": "peer",
                "class": "agent-message",
                "sinceMs": 10,
                "beforeMs": 20,
            },
        )
        # One display event per returned message, carrying its wire dict.
        self.assertEqual(
            [call.args[0] for call in emit.call_args_list],
            [{rlm_module._INBOX_MESSAGE_MIME: entry} for entry in wire],
        )
        self.assertEqual([message.text for message in messages], ["hello", "again"])
        self.assertEqual(messages[0].sender, "peer")
        self.assertEqual(messages[0].text, "hello")
        self.assertEqual(
            messages[0].meta["richContent"],
            {"type": "blocks", "blocks": [{"type": "text", "text": "full result"}]},
        )

    def test_rejects_bool_as_timestamp(self) -> None:
        with self.assertRaisesRegex(TypeError, "since_ms must be an int"):
            asyncio.run(rlm_module.inbox.read(since_ms=True))


if __name__ == "__main__":
    unittest.main()
