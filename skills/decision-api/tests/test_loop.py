"""The decision-api loop against a stand-in host.

Covers the decision child transport (spawn + request + tagged reply), goal
routing, step control, and the direct `decide` path. `rlm` and
`agent_message` are installed before the skill imports.
"""

import asyncio
import json
import sys
import types
import unittest

host_calls = []
sent = []


async def host_request(kind, payload):
    host_calls.append((kind, payload))
    if kind == "decision_api.decide":
        return {
            "answers": {
                "action": {
                    "choice": "left",
                    "confidence": 0.9,
                    "probabilities": {"left": 0.9},
                }
            },
            "model": "fixture/model",
        }
    return None


class _Handle:
    def __init__(self, name: str) -> None:
        self.name = name
        self.model = "fixture/system-1"


async def spawn(prompt, *, name, kind=None, model=None, thinking=None):
    if kind != "decision":
        raise TypeError("the loop spawns a decision child")
    assert "You are System 1" in prompt
    return _Handle(name)


async def send(text, *, receiver_role, receiver_name):
    sent.append({"text": text, "role": receiver_role, "name": receiver_name})


async def delete_subagent(name):
    sent.append({"deleted": name})


def _install_stubs():
    rlm = types.ModuleType("rlm")
    rlm.host_request = host_request
    rlm.spawn = spawn
    rlm.delete_subagent = delete_subagent
    agent_message = types.ModuleType("agent_message")
    agent_message.send = send
    sys.modules["rlm"] = rlm
    sys.modules["agent_message"] = agent_message


_install_stubs()

from decision_api import DEFAULT_INSTRUCTIONS, Loop, decide  # noqa: E402


class DecideTests(unittest.TestCase):
    def setUp(self):
        host_calls.clear()

    def test_images_must_be_data_url_strings(self):
        async def check():
            for images in (
                [{"content_type": "image/png", "base64": "AA=="}],
                [b"png"],
                ["frame.png"],
            ):
                with self.assertRaises(TypeError) as raised:
                    await decide({"x": 1}, {"left": "go left"}, images=images)
                self.assertIn("data:image/png;base64", str(raised.exception))
            self.assertEqual(host_calls, [])

            result = await decide(
                {"x": 1},
                {"left": "go left"},
                images=["data:image/png;base64,AA=="],
            )
            self.assertEqual(result["action"], "left")
            self.assertEqual(result["confidence"], 0.9)
            self.assertEqual(result["model"], "fixture/model")
            self.assertIsInstance(result["latency_ms"], float)

            kind, payload = host_calls[0]
            request = payload["request"]
            self.assertEqual(kind, "decision_api.decide")
            self.assertEqual(request["state"], {"observation": {"x": 1}})
            self.assertEqual(request["images"], ["data:image/png;base64,AA=="])
            self.assertNotIn("model", request)
            self.assertEqual(
                request["questions"]["action"],
                {
                    "type": "choice",
                    "instructions": DEFAULT_INSTRUCTIONS,
                    "criteria": {"left": "go left"},
                },
            )

        asyncio.run(check())


class LoopTests(unittest.TestCase):
    def setUp(self):
        host_calls.clear()
        sent.clear()

    def test_steps_skip_a_system1_error_and_stop_when_observe_ends(self):
        seen = []

        def observe():
            observe.n += 1
            if observe.n > 3:
                return None
            return {"n": observe.n}

        observe.n = 0

        def system1(_observation, _actions, _goal, _history):
            if observe.n == 2:
                raise RuntimeError("blip")
            return "left"

        async def run():
            loop = Loop(
                observe,
                seen.append,
                {"left": "go left"},
                objective="stay under it",
                system1=system1,
                on_error="skip",
            )
            status = await loop.run()
            self.assertEqual(seen, ["left", "left"])
            self.assertEqual(loop.step, 3)
            self.assertEqual(len(loop.errors), 1)
            self.assertIn("blip", loop.errors[0]["error"])
            self.assertEqual(
                {
                    key: status[key]
                    for key in (
                        "running",
                        "paused",
                        "step",
                        "objective",
                        "goal",
                        "errors",
                        "error",
                    )
                },
                {
                    "running": False,
                    "paused": False,
                    "step": 3,
                    "objective": "stay under it",
                    "goal": "stay under it",
                    "errors": 1,
                    "error": None,
                },
            )

        asyncio.run(run())

    def test_the_loop_spawns_one_child_and_awaits_its_replies(self):
        taken = []
        replies = {}
        spawns = []

        async def stub_spawn(prompt, *, name, kind=None, model=None, thinking=None):
            spawns.append(name)
            return _Handle(name)

        async def stub_send(text, *, receiver_role, receiver_name):
            message = json.loads(text)
            sent.append({"message": message, "role": receiver_role, "name": receiver_name})
            # The child's answer routes back through the decision slot.
            replies[receiver_name] = {
                "type": "decision_api.decision",
                "seq": message["seq"],
                "model": "fixture/model",
                "decision": {"choice": "left", "confidence": 0.9},
            }

        async def stub_host_request(kind, payload):
            host_calls.append((kind, payload))
            if kind == "decision_api.decision":
                if payload.get("close"):
                    replies.pop(payload["name"], None)
                    return None
                return replies.get(payload["name"])

        def observe():
            observe.n += 1
            if observe.n > 2:
                return None
            return {"frame": observe.n}

        observe.n = 0

        import decision_api

        decision_api.rlm.spawn = stub_spawn
        decision_api.rlm.host_request = stub_host_request
        decision_api.agent_message.send = stub_send

        async def run():
            loop = decision_api.Loop(
                observe,
                taken.append,
                {"left": "go left", "right": "go right"},
                objective="fixture objective",
                decide_timeout=5.0,
            )
            status = await loop.run()
            self.assertEqual(taken, ["left", "left"])
            self.assertEqual(len(spawns), 1, "one child for the loop's lifetime")
            self.assertEqual(loop._child_model, "fixture/model")
            self.assertEqual(spawns[0].split("-")[2], loop._loop_id)
            self.assertEqual(loop.status()["system1_model"], "fixture/model")
            self.assertEqual(loop.errors, [], loop.errors)
            self.assertFalse(status["running"])
            # The requests carry the step seq and the decision instructions.
            requests = [
                entry["message"] for entry in sent if entry.get("role") == "child"
            ]
            self.assertEqual([request["seq"] for request in requests], [0, 1])
            for request in requests:
                self.assertEqual(request["questions"]["action"]["type"], "choice")
                self.assertEqual(
                    request["questions"]["action"]["criteria"],
                    {"left": "go left", "right": "go right"},
                )
                self.assertNotIn("goal", request["state"], "the goal rides tagged messages, not the state")

        asyncio.run(run())

    def test_goal_updates_route_to_the_child(self):
        taken = []
        goals = []
        replies = {}
        decided = []

        async def stub_spawn(prompt, *, name, kind=None, model=None, thinking=None):
            return _Handle(name)

        async def stub_send(text, *, receiver_role, receiver_name):
            message = json.loads(text)
            sent.append(message)
            if message.get("type") == "decision_api.goal":
                goals.append(message)
            else:
                # The child injects the latest goal into the state it serves.
                decided.append(message["seq"])
                replies[receiver_name] = {
                    "type": "decision_api.decision",
                    "seq": message["seq"],
                    "model": "fixture/model",
                    "decision": {"choice": "left", "confidence": 0.9},
                }

        async def stub_host_request(kind, payload):
            if kind == "decision_api.decision":
                if payload.get("close"):
                    return None
                return replies.get(payload["name"])

        def observe():
            observe.n += 1
            if observe.n > 2:
                return None
            return {}

        observe.n = 0

        import decision_api

        decision_api.rlm.spawn = stub_spawn
        decision_api.rlm.host_request = stub_host_request
        decision_api.agent_message.send = stub_send

        async def run():
            loop = decision_api.Loop(
                observe,
                taken.append,
                {"left": "go left"},
                objective="fixture objective",
                on_step=lambda record, observation: (
                    loop.set_goal("follow the target") if record["step"] == 0 else None
                ),
                decide_timeout=5.0,
            )
            await loop.run()
            self.assertEqual(taken, ["left", "left"])
            self.assertEqual(loop.goal, "follow the target")
            self.assertEqual(loop.goal_updates[-1]["goal"], "follow the target")
            # The goal message is tagged and routed to the child.
            self.assertEqual(
                [entry["type"] for entry in goals],
                ["decision_api.goal"],
                goals,
            )
            self.assertEqual(goals[0]["goal"], "follow the target")
            # set_goal of an empty goal is a contract error.
            with self.assertRaises(TypeError):
                loop.set_goal("")

        asyncio.run(run())

    def test_a_child_error_reply_fails_the_step_and_the_removal_closes_the_slot(self):
        taken = []
        replies = {}
        closed = []

        async def stub_spawn(prompt, *, name, kind=None, model=None, thinking=None):
            return _Handle(name)

        async def stub_send(text, *, receiver_role, receiver_name):
            message = json.loads(text)
            replies[receiver_name] = {
                "type": "decision_api.decision",
                "seq": message["seq"],
                "error": "the decision model refused",
            }

        async def stub_host_request(kind, payload):
            if kind == "decision_api.decision":
                if payload.get("close"):
                    closed.append(payload["name"])
                    return None
                return replies.get(payload["name"])

        def observe():
            observe.n += 1
            if observe.n > 1:
                return None
            return {}

        observe.n = 0

        import decision_api

        decision_api.rlm.spawn = stub_spawn
        decision_api.rlm.host_request = stub_host_request
        decision_api.agent_message.send = stub_send

        async def run():
            loop = decision_api.Loop(
                observe,
                taken.append,
                {"left": "go left"},
                objective="fixture objective",
                decide_timeout=5.0,
                on_error="skip",
            )
            await loop.run()
            self.assertEqual(taken, [])
            self.assertEqual(len(loop.errors), 1)
            self.assertIn("the decision model refused", loop.errors[0]["error"])
            self.assertEqual(closed, ["system-1-" + loop._loop_id])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
