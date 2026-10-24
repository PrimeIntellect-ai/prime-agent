"""The rlm.watch.* kernel surface pins: forwarding, validation, shapes.

Patches ``rlm.host_request`` (the same seam the factory executor tests
use) and asserts the request types and payloads the namespace forwards.
"""

import asyncio
import unittest
from unittest.mock import patch

import rlm as rlm_module


class _FakeHost:
    """A deterministic host fake recording every request."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.replies: dict[str, dict] = {
            "rlm.watch.agent": {
                "id": "watch-agent-sub-1",
                "child_id": "sub-1",
                "child_name": "worker",
                "messages": 3,
                "status": "active",
                "total_events": 0,
                "created_at_ms": 1_000,
            },
            "rlm.watch.agent_list": {
                "watches": [
                    {
                        "id": "watch-agent-sub-1",
                        "child_id": "sub-1",
                        "child_name": "worker",
                        "messages": 7,
                        "status": "active",
                        "total_events": 2,
                        "created_at_ms": 1_000,
                    }
                ]
            },
            "rlm.watch.agent_cancel": {"cancelled": True},
            "rlm.watch.read": {
                "events": [
                    {
                        "id": "watch-a",
                        "seq": 1,
                        "subscription_id": "watch-agent-sub-1",
                        "kind": "watch.agent",
                        "content": {
                            "target": "sub-1",
                            "start": 3,
                            "end": 5,
                            "status": {"from": "idle", "to": "running"},
                        },
                        "at_ms": 1_234,
                    }
                ],
                "next_seq": 1,
                "dropped": 0,
            },
        }

    async def __call__(self, request_type: str, payload: dict | None = None) -> dict:
        payload = payload or {}
        self.calls.append((request_type, {**payload, "type": request_type}))
        return self.replies[request_type]


class WatchAgentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = _FakeHost()
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_watch_agent_forwards_to_host(self) -> None:
        reply = asyncio.run(rlm_module.watch_agent("worker"))
        self.assertEqual(reply["child_id"], "sub-1")
        kind, payload = self.host.calls[-1]
        self.assertEqual(kind, "rlm.watch.agent")
        self.assertEqual(
            payload, {"target": "worker", "wake": True, "type": "rlm.watch.agent"}
        )
        # The namespace surface forwards to the same module function.
        reply = asyncio.run(rlm_module.rlm.watch.agent("worker"))
        self.assertEqual(reply["child_id"], "sub-1")

    def test_watch_agent_wake_flag_forwards_and_validates(self) -> None:
        # wake=False (the factory's own waits) rides the subscribe payload,
        # so the registry can keep those subscriptions out of the quiet
        # wake rows. (Mutating the kernel back to a bare target forward
        # fails this pin: the wake key disappears.)
        asyncio.run(rlm_module.watch_agent("worker", wake=False))
        self.assertEqual(
            self.host.calls[-1][1],
            {"target": "worker", "wake": False, "type": "rlm.watch.agent"},
        )
        asyncio.run(rlm_module.rlm.watch.agent("worker", wake=False))
        self.assertEqual(self.host.calls[-1][1]["wake"], False)
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_agent("worker", wake="yes"))
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_agent("worker", wake=None))
        self.assertEqual(len(self.host.calls), 2, "no host call may leave the invalid surface")

    def test_watch_agent_requires_nonempty_target(self) -> None:
        for bad in ("", "   ", None, 7):
            with self.assertRaises(ValueError):
                asyncio.run(rlm_module.watch_agent(bad))
        self.assertEqual(self.host.calls, [], "no host call may leave the invalid surface")

    def test_watch_agent_list_and_cancel_shapes(self) -> None:
        listed = asyncio.run(rlm_module.rlm.watch.agent_list())
        self.assertEqual(listed["watches"][0]["total_events"], 2)
        self.assertEqual(self.host.calls[-1][0], "rlm.watch.agent_list")
        cancelled = asyncio.run(rlm_module.watch_agent_cancel("watch-agent-sub-1"))
        self.assertEqual(cancelled, {"cancelled": True})
        self.assertEqual(
            self.host.calls[-1][1],
            {"id": "watch-agent-sub-1", "type": "rlm.watch.agent_cancel"},
        )
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_agent_cancel(""))

    def test_watch_read_pages(self) -> None:
        page = asyncio.run(rlm_module.watch_read(since_seq=0, limit=10))
        self.assertEqual(page["next_seq"], 1)
        self.assertEqual(page["dropped"], 0)
        event = page["events"][0]
        self.assertEqual(event["kind"], "watch.agent")
        self.assertEqual(event["content"], {"target": "sub-1", "start": 3, "end": 5, "status": {"from": "idle", "to": "running"}})
        kind, payload = self.host.calls[-1]
        self.assertEqual(kind, "rlm.watch.read")
        self.assertEqual(payload, {"since_seq": 0, "limit": 10, "type": "rlm.watch.read"})
        # The cursor follows the page's next_seq; invalid cursors stay local.
        asyncio.run(rlm_module.watch_read(since_seq=page["next_seq"]))
        self.assertEqual(self.host.calls[-1][1]["since_seq"], 1)
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_read(since_seq=-1))
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_read(limit=0))
        # The host caps one page at 500 events; the kernel rejects a
        # larger ask locally instead of surfacing the host refusal.
        with self.assertRaises(ValueError):
            asyncio.run(rlm_module.watch_read(limit=501))
        self.assertEqual(len(self.host.calls), 2, "the capped limit never reached the host")


if __name__ == "__main__":
    unittest.main()
