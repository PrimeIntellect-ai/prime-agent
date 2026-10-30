from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


rlm_module = importlib.import_module("rlm")


class FakeHost:
    """Records each request and answers with a fixed slice reply."""

    def __init__(self, reply: dict) -> None:
        self.reply = reply
        self.requests: list[tuple[str, dict]] = []

    async def __call__(self, request_type: str, payload: dict) -> dict:
        self.requests.append((request_type, payload))
        return self.reply


def run(host: FakeHost, call):
    emit = Mock()
    with patch.object(rlm_module, "host_request", host), patch.object(rlm_module, "emit", emit):
        result = asyncio.run(call(rlm_module.rlm.session))
    return result, [args.args[0][rlm_module._TRANSCRIPT_READ_MIME] for args in emit.call_args_list]


class SessionMessagesTest(unittest.TestCase):
    def test_messages_marshal_the_slice_and_build_messages(self) -> None:
        assistant = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "plan"},
                {"type": "text", "text": "answer"},
                {"type": "toolCall", "id": "c1", "name": "python_repl", "arguments": {"code": "1"}},
            ],
            "timestamp": 1001,
        }
        summary = {"role": "compactionSummary", "summary": "the story so far", "tokensBefore": 4000, "timestamp": 1003}
        custom = {
            "role": "custom",
            "customType": "agent_message",
            "content": "[task from parent]",
            "display": True,
            "timestamp": "2004-07-21T00:47:44.465Z",
        }
        host = FakeHost(
            {
                "messages": [
                    {"index": 7, "id": "e7", "message": assistant},
                    {"index": 8, "id": "e8", "message": summary},
                    {"index": 9, "id": "e9", "message": custom},
                ],
                "total": 10,
            }
        )

        messages, reads = run(host, lambda session: session.messages(-3, 3, role=("assistant", "c*")))

        self.assertEqual(
            host.requests,
            [("rlm.session.messages", {"start": -3, "limit": 3, "roles": ["assistant", "c*"]})],
        )
        self.assertEqual(
            [(m.index, m.id, m.role, m.text, m.timestamp) for m in messages],
            [
                (7, "e7", "assistant", "answer", 1001),
                (8, "e8", "compactionSummary", "the story so far", 1003),
                (9, "e9", "custom", "[task from parent]", 1090370864465),
            ],
        )
        self.assertEqual(messages[0].raw["content"][2]["name"], "python_repl")
        self.assertEqual(reads, [{"returned": 3, "first": 7, "total": 10, "roles": ["assistant", "c*"]}])

    def test_count_reads_only_the_total(self) -> None:
        host = FakeHost({"messages": [], "total": 4})

        count, reads = run(host, lambda session: session.count(role="user"))

        self.assertEqual(count, 4)
        self.assertEqual(host.requests, [("rlm.session.messages", {"start": 0, "limit": 0, "roles": ["user"]})])
        self.assertEqual(reads, [])

    def test_agent_reads_target_a_family_member(self) -> None:
        row = {"index": 4, "id": "e4", "message": {"role": "user", "content": "go"}}
        host = FakeHost({"messages": [row], "total": 5, "agent": "worker-a"})
        handle = rlm_module.RLMSpawnHandle(rlm_child_id="sub-1", name="worker-a", session_dir=Path("/s"), model="m")

        messages, reads = run(host, lambda session: session.messages(-1, 1, agent=handle))
        count, _ = run(host, lambda session: session.count(agent="worker-a"))

        self.assertEqual([m.text for m in messages], ["go"])
        self.assertEqual(count, 5)
        self.assertEqual(
            host.requests,
            [
                ("agent_observe.session_messages", {"start": -1, "limit": 1, "roles": ["*"], "target": "sub-1"}),
                ("agent_observe.session_messages", {"start": 0, "limit": 0, "roles": ["*"], "target": "worker-a"}),
            ],
        )
        self.assertEqual(reads, [{"returned": 1, "first": 4, "total": 5, "roles": ["*"], "agent": "worker-a"}])

    def test_negative_limit_is_rejected(self) -> None:
        host = FakeHost({"messages": [], "total": 0})

        with self.assertRaises(ValueError):
            run(host, lambda session: session.messages(0, -1))
        self.assertEqual(host.requests, [])


if __name__ == "__main__":
    unittest.main()
