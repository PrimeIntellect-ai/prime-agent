from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/agent-message/src/agent_message/__init__.py"


class AgentMessageSkillTest(unittest.TestCase):
    def test_roled_parent_and_broadcast_forms(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_test", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        host = AsyncMock(return_value={"deliveryStatus": "queued"})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_sent_message"):
            asyncio.run(module.send("done", receiver_role="parent"))
            asyncio.run(module.send("all", "follow up"))
        self.assertEqual(host.await_args_list[0].args[1]["receiver_role"], "parent")
        self.assertEqual(host.await_args_list[1].args[1]["target"], "all")

    def test_roled_selector_validation(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_validation", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError, "required"):
            asyncio.run(module.send("hello", receiver_role="child"))
        with self.assertRaisesRegex(ValueError, "omitted"):
            asyncio.run(module.send("hello", receiver_role="parent", receiver_name="x"))
        with self.assertRaisesRegex(TypeError, "unexpected keyword argument 'mode'"):
            asyncio.run(module.send("hello", receiver_role="parent", mode="follow_up"))

    def test_inbox_wait_and_correlation_request_construction(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_mailbox", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        host = AsyncMock(return_value={"messages": []})
        with patch.object(module, "host_request", host), patch.object(module, "_emit_sent_message"):
            asyncio.run(
                module.send(
                    "answer",
                    receiver_role="parent",
                    message_id="agentmsg-stable",
                    reply_to="agentmsg-question",
                )
            )
            asyncio.run(module.inbox(limit=7, consume=True, sender="parent", reply_to="agentmsg-question"))
            asyncio.run(module.wait(timeout=1.25, sender="parent", reply_to="agentmsg-question"))
        self.assertEqual(host.await_args_list[0].args[1]["id"], "agentmsg-stable")
        self.assertEqual(host.await_args_list[0].args[1]["reply_to"], "agentmsg-question")
        self.assertEqual(host.await_args_list[1].args, (
            "agent_message.inbox",
            {"limit": 7, "consume": True, "sender": "parent", "reply_to": "agentmsg-question"},
        ))
        self.assertEqual(host.await_args_list[2].args[1]["timeout_ms"], 1250)

    def test_mailbox_bounds(self) -> None:
        spec = importlib.util.spec_from_file_location("agent_message_bounds", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError, "between 1 and 100"):
            asyncio.run(module.inbox(limit=0))
        with self.assertRaisesRegex(ValueError, "at most 300"):
            asyncio.run(module.wait(timeout=301))
        with self.assertRaisesRegex(ValueError, "non-empty"):
            asyncio.run(module.inbox(sender=" "))


if __name__ == "__main__":
    unittest.main()
