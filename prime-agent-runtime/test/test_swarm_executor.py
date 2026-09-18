from __future__ import annotations

import asyncio
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest.mock import patch

import rlm as rlm_module
from rlm import swarm as swarm_module
from rlm.harness import HarnessState
from rlm.swarm import SwarmExecutor


def async_test(coroutine):
    """Run one async test method on a fresh event loop."""

    def wrapper(self):
        return asyncio.run(coroutine(self))

    wrapper.__name__ = coroutine.__name__
    return wrapper


class FakeClock:
    """Injectable monotonic clock with optional per-collect advancement."""

    def __init__(self, start: float = 1000.0, advance_per_collect: float = 0.0) -> None:
        self.now = start
        self.advance_per_collect = advance_per_collect

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class SleepRecorder:
    """Injectable sleep that records delays instead of waiting."""

    def __init__(self) -> None:
        self.sleeps: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.sleeps.append(seconds)


class FakeHost:
    """Deterministic async host_request fake that routes by request type.

    Child names carry the node id as their second dash-separated part, so
    node ids in these tests never contain "-". Collect outcomes are
    scripted per child id first (``child_outcomes``), then per node id
    (``outcomes``); a "running" outcome never settles. ``rate_limit_first``
    / ``rate_limit_forever`` make spawn admissions for a node fail with a
    429-style RuntimeError. ``gate("rlm.collect"|"rlm.delete_subagent", n)``
    suspends the n-th call of that type on an asyncio.Event so tests can
    reproduce races between the control loop and stop()/resume().
    """

    def __init__(self, clock: FakeClock | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.notices: list[dict[str, Any]] = []
        self.children: dict[str, dict[str, Any]] = {}
        self.counter = 0
        self.collects = 0
        self.clock = clock
        self.outcomes: dict[str, dict[str, Any]] = {}
        self.child_outcomes: dict[str, dict[str, Any]] = {}
        self.rate_limit_first: dict[str, int] = {}
        self.rate_limit_forever: set[str] = set()
        self.gates: dict[tuple[str, int], asyncio.Event] = {}
        self._call_indices: dict[str, int] = {}

    def gate(self, request_type: str, call_number: int) -> asyncio.Event:
        """Suspend the call_number-th collect/delete on a returned event."""
        event = asyncio.Event()
        self.gates[(request_type, call_number)] = event
        return event

    def calls_of(self, request_type: str) -> list[dict[str, Any]]:
        return [payload for kind, payload in self.calls if kind == request_type]

    def spawn_calls(self, node_id: str) -> list[dict[str, Any]]:
        return [p for p in self.calls_of("rlm.run") if p["kwargs"]["name"].split("-")[1] == node_id]

    def deleted_targets(self) -> list[str]:
        return [p["target"] for p in self.calls_of("rlm.delete_subagent")]

    def notice_kinds(self) -> list[str]:
        return [notice["kind"] for notice in self.notices]

    @staticmethod
    def _entry(
        *,
        child_id: str,
        name: str,
        status: str,
        settled: bool,
        answer: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "rlm_child_id": child_id,
            "session_name": name,
            "session_dir": f"/tmp/{child_id}",
            "status": status,
            "settled": settled,
            "tool_use_count": 1,
            "duration_ms": 5,
        }
        if answer is not None:
            entry["answer_preview"] = answer
        if error is not None:
            entry["error"] = error
        return entry

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        gate = None
        if request_type in ("rlm.collect", "rlm.delete_subagent"):
            index = self._call_indices.get(request_type, 0) + 1
            self._call_indices[request_type] = index
            gate = self.gates.pop((request_type, index), None)
        if gate is not None:
            await gate.wait()
        if request_type == "rlm.run":
            # Count this node's prior admission calls before recording the
            # current one, so rate_limit_first<n> fails exactly the first n.
            name = payload["kwargs"]["name"]
            node_id = name.split("-")[1]
            attempted = len(
                [
                    p
                    for kind, p in self.calls
                    if kind == "rlm.run" and p["kwargs"]["name"].split("-")[1] == node_id
                ]
            )
            self.calls.append((request_type, payload))
            limit = self.rate_limit_first.get(node_id, 0) + (999 if node_id in self.rate_limit_forever else 0)
            if attempted < limit:
                raise RuntimeError("spawn admission failed: 429 rate limit exceeded")
            self.counter += 1
            child_id = f"child-{self.counter}"
            self.children[child_id] = {"name": name, "node": node_id}
            return {
                "rlm_child_id": child_id,
                "name": name,
                "session_dir": f"/tmp/{child_id}",
                "model": "fake-model",
            }
        self.calls.append((request_type, payload))
        if request_type == "rlm.collect":
            self.collects += 1
            if self.clock is not None:
                self.clock.advance(self.clock.advance_per_collect)
            results = []
            for target in payload["targets"]:
                child = self.children.get(target)
                if child is None:
                    continue  # deleted children vanish from collect results
                outcome = (
                    self.child_outcomes.get(target)
                    or self.outcomes.get(child["node"])
                    or {"status": "done", "answer": f"answer-{child['node']}"}
                )
                if outcome["status"] == "running":
                    results.append(
                        self._entry(child_id=target, name=child["name"], status="running", settled=False)
                    )
                    continue
                results.append(
                    self._entry(
                        child_id=target,
                        name=child["name"],
                        status=outcome["status"],
                        settled=True,
                        answer=outcome.get("answer"),
                        error=outcome.get("error"),
                    )
                )
            return {"results": results}
        if request_type == "rlm.delete_subagent":
            target = payload["target"]
            child = self.children.pop(target, None)
            return {
                "subagent": {
                    "rlm_child_id": target,
                    "session_name": child["name"] if child else "unknown",
                    "session_dir": f"/tmp/{target}",
                    "status": "running",
                },
                "outcome": "deleted",
            }
        if request_type == "swarm.progress":
            self.notices.append(payload)
            return {}
        raise AssertionError(f"unexpected host request type {request_type!r}")


class SwarmExecutorTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.harness = HarnessState(Path(temp.name) / "harness_state.json")
        self.harness.create_subagent("Worker", "Do the work carefully.", id="worker")
        self.clock = FakeClock()
        self.host = FakeHost(clock=self.clock)
        self.sleeps = SleepRecorder()
        self.executor = SwarmExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        previous_executor = swarm_module._DEFAULT_EXECUTOR
        swarm_module._DEFAULT_EXECUTOR = self.executor
        self.addCleanup(lambda: setattr(swarm_module, "_DEFAULT_EXECUTOR", previous_executor))
        # The fake is an async callable: patch it in directly (AsyncMock does
        # not await async side effects), which preserves the patch seam.
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)

    # -- helpers -------------------------------------------------------------

    def store_swarm(self, dag: dict[str, Any], spec_id: str = "sw") -> None:
        self.harness.create_swarm("Swarm", "Swarm content", id=spec_id, dag=dag)

    def node(self, node_id: str, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {"id": node_id, "subagent": "worker"}
        base.update(overrides)
        return base

    async def start(self, spec_id: str = "sw") -> dict[str, Any]:
        return await rlm_module.rlm.swarm.run(spec_id)

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        """Yield to the control loop until the run leaves the running state."""
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.swarm.status(run_id)
            await asyncio.sleep(0)
        self.fail(f"run {run_id} never left the running state")

    async def wait_until(self, predicate, *, max_polls: int = 50_000) -> None:
        for _ in range(max_polls):
            if predicate():
                return
            await asyncio.sleep(0)
        self.fail("condition never became true")

    def node_status(self, status: dict[str, Any], node_id: str) -> dict[str, Any]:
        return next(entry for entry in status["nodes"] if entry["id"] == node_id)

    # -- dry run ---------------------------------------------------------------

    @async_test
    async def test_run_rejects_invalid_dag_and_starts_nothing(self) -> None:
        # Write-time validation blocks create_swarm, so bypass it with the
        # generic create to prove run() re-validates on its own.
        self.harness.create("swarm", "Empty", "content", id="empty", arguments={"dag": {"nodes": []}})
        self.harness.create(
            "swarm",
            "Cyclic",
            "content",
            id="cyclic",
            arguments={
                "dag": {
                    "nodes": [
                        {"id": "a", "subagent": "worker", "depends_on": ["b"]},
                        {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                    ]
                }
            },
        )
        for spec_id in ("empty", "cyclic"):
            with self.assertRaisesRegex(ValueError, "swarm"):
                await self.start(spec_id)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_run_lists_all_missing_subagent_references(self) -> None:
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "ghost-a"},
                    {"id": "b", "subagent": "ghost-b"},
                ],
            }
        )
        with self.assertRaises(ValueError) as ctx:
            await self.start()
        self.assertIn("ghost-a", str(ctx.exception))
        self.assertIn("ghost-b", str(ctx.exception))
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_run_rejects_unknown_spec(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown swarm spec"):
            await self.start("missing-spec")

    @async_test
    async def test_resolves_subagent_by_id_and_title_with_model_settings(self) -> None:
        self.harness.create_subagent(
            "The Worker",
            "Template by title.",
            id="worker-md",
            metadata={"model": "pi/test-model", "thinking": "low"},
        )
        self.store_swarm(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "x", "subagent": "The Worker"},
                    {"id": "y", "subagent": "worker-md"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        for node_id in ("x", "y"):
            spawn = self.host.spawn_calls(node_id)
            self.assertEqual(len(spawn), 1, node_id)
            self.assertEqual(spawn[0]["prompt"], "Template by title.")
            self.assertEqual(spawn[0]["kwargs"]["model"], "pi/test-model")
            self.assertEqual(spawn[0]["kwargs"]["thinking"], "low")

    @async_test
    async def test_run_starts_ready_nodes_and_reports_counts(self) -> None:
        self.store_swarm(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                    {"id": "c", "subagent": "worker", "depends_on": ["b"]},
                    {"id": "d", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        self.assertIn("run_id", result)
        self.assertEqual(result["spec_id"], "sw")
        self.assertEqual(result["nodes"], 4)
        self.assertEqual(result["max_parallel"], 2)
        self.assertEqual(result["started"], ["a", "d"])
        self.assertEqual(result["pending"], ["b", "c"])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertEqual(self.host.notice_kinds(), ["finished"])
        self.assertEqual(status["usage"]["spawns"], 4)
        self.assertEqual(status["usage"]["settled"], 4)

    # -- propagation and binding ------------------------------------------------

    @async_test
    async def test_propagation_binds_answer_into_prompt(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Summarize: {draft}"},
                        "depends_on": ["a"],
                        "inputs": [{"name": "draft", "type": "text", "from": "a.out"}],
                    },
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        prompts = [call["prompt"] for call in self.host.spawn_calls("b")]
        self.assertEqual(prompts, ["Summarize: ANSWER-A"])
        self.assertEqual(self.node_status(status, "b")["answer_preview"], "answer-b")

    @async_test
    async def test_json_input_prefers_fenced_block(self) -> None:
        self.host.outcomes["a"] = {
            "status": "done",
            "answer": 'Verdict text.\n```json\n{"result": {"x": 1}}\n```',
        }
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        prompts = [call["prompt"] for call in self.host.spawn_calls("b")]
        self.assertEqual(prompts, ['Process {"x": 1}.'])

    @async_test
    async def test_json_input_falls_back_to_whole_text(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": '{"result": 7}'}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual([call["prompt"] for call in self.host.spawn_calls("b")], ["Process 7."])

    @async_test
    async def test_bad_json_input_fails_node_without_spawning(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "not json at all"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # b failed at binding (continue policy): never spawned, marked error;
        # c still ran and finished, so the run completes but reports failed.
        self.assertEqual(self.host.spawn_calls("b"), [])
        b = self.node_status(status, "b")
        self.assertEqual(b["status"], "error")
        self.assertIn("no JSON object containing output", b["error"])
        self.assertEqual(self.node_status(status, "c")["status"], "done")
        self.assertEqual(status["state"], "failed")

    @async_test
    async def test_unplaced_inputs_are_appended(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "No placeholders here."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "draft", "type": "text", "from": "a.out"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("b")],
            ["No placeholders here.\n\n## Inputs\n- draft: ANSWER-A\n"],
        )

    @async_test
    async def test_two_parent_fan_in_binds_both_answers(self) -> None:
        # Both parents settle in one collect batch; the fan-in node must
        # bind both captured answers into a single prompt.
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.host.outcomes["b"] = {"status": "done", "answer": "ANSWER-B"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {"id": "b", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "c",
                        "subagent": {"prompt": "Combine {left} and {right}."},
                        "depends_on": ["a", "b"],
                        "inputs": [
                            {"name": "left", "type": "text", "from": "a.out"},
                            {"name": "right", "type": "text", "from": "b.out"},
                        ],
                    },
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a", "b"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("c")],
            ["Combine ANSWER-A and ANSWER-B."],
        )

    @async_test
    async def test_answer_capture_cap_slices_previews(self) -> None:
        long_answer = "x" * 300
        self.host.outcomes["a"] = {"status": "done", "answer": long_answer}
        self.store_swarm(
            {
                "nodes": [{"id": "a", "subagent": "worker"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        captured = self.node_status(status, "a")["answer_preview"]
        self.assertEqual(len(captured), 200)
        self.assertEqual(captured, long_answer[:200])

    # -- foreach ----------------------------------------------------------------

    def store_fan_swarm(self, *, policy: str) -> None:
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b", "c", "d", "e"]}'}
        self.store_swarm(
            {
                "run": {"failure_policy": policy, "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 5},
                    },
                ],
            }
        )

    @async_test
    async def test_foreach_expands_clamped_instances(self) -> None:
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": 'Here.\n```json\n{"items": [1, 2, 3, 4, 5]}\n```',
        }
        self.store_swarm(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Expand item {items}."},
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 3},
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "done")
        # 5 items clamped to foreach.max 3; all instances settle -> node done.
        self.assertEqual(len(fan["instances"]), 3)
        self.assertEqual(
            sorted(call["prompt"] for call in self.host.spawn_calls("fan")),
            ["Expand item 1.", "Expand item 2.", "Expand item 3."],
        )

    @async_test
    async def test_foreach_zero_items_marks_node_done(self) -> None:
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": []}'}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 4},
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "fan")["status"], "done")
        self.assertEqual(self.host.spawn_calls("fan"), [])

    @async_test
    async def test_foreach_mixed_instances_escalate_pauses(self) -> None:
        self.store_fan_swarm(policy="escalate")
        result = await self.start()
        # src is child-1; the five fan instances are child-2..child-6.
        # Instances 0-1 fail permanently; 2-4 succeed in the same collect
        # batch. The node must reach error and the policy must apply even
        # though the failures did not settle last.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom-2"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        self.assertEqual(self.host.notice_kinds(), ["paused"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual([i["status"] for i in fan["instances"]], ["error", "error", "done", "done", "done"])

    @async_test
    async def test_foreach_mixed_instances_fail_fast_cancels_siblings(self) -> None:
        self.store_fan_swarm(policy="fail_fast")
        result = await self.start()
        # instance 0 (child-2) fails first while its siblings are still in
        # flight: fail_fast must cancel those siblings now, not after they
        # settle.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom"}
        for child_id in ("child-3", "child-4", "child-5", "child-6"):
            self.host.child_outcomes[child_id] = {"status": "running"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual(
            [i["status"] for i in fan["instances"]],
            ["error", "cancelled", "cancelled", "cancelled", "cancelled"],
        )
        self.assertEqual(len(self.host.deleted_targets()), 4)

    @async_test
    async def test_foreach_mixed_instances_continue_finishes_with_node_error(self) -> None:
        self.store_fan_swarm(policy="continue")
        result = await self.start()
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom-2"}
        status = await self.settle(result)
        # the node fails on the first permanent instance failure, the rest
        # still settle, and the run finishes with the node error recorded
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual([i["status"] for i in fan["instances"]], ["error", "error", "done", "done", "done"])
        self.assertEqual(self.host.deleted_targets(), [])

    # -- failure policies ---------------------------------------------------------

    @async_test
    async def test_fail_fast_cancels_running_children(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.outcomes["b"] = {"status": "running"}
        self.host.outcomes["c"] = {"status": "running"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "a", "subagent": "worker", "failure_policy": "fail_fast"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(self.node_status(status, "b")["status"], "cancelled")
        self.assertEqual(self.node_status(status, "c")["status"], "cancelled")
        # delete_subagent cascaded to both running children
        self.assertEqual(len(self.host.deleted_targets()), 2)
        self.assertEqual(self.host.notice_kinds(), ["failed"])

    @async_test
    async def test_continue_policy_finishes_remaining_nodes(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # a failed; b (depends_on a, no data edge) still ran and finished; c ran.
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(self.node_status(status, "b")["status"], "done")
        self.assertEqual(self.node_status(status, "c")["status"], "done")
        self.assertEqual(self.host.deleted_targets(), [])
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])

    @async_test
    async def test_escalate_pauses_notifies_and_resume_continues(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_swarm(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertEqual(self.node_status(paused, "a")["status"], "error")
        self.assertEqual(self.node_status(paused, "b")["status"], "pending")
        self.assertEqual(self.host.spawn_calls("b"), [])
        self.assertIn("paused", self.host.notice_kinds())
        # resume() restarts the run: b is ready (a is terminal) and finishes.
        resumed = await rlm_module.rlm.swarm.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")  # a errored, b done
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        self.assertEqual(self.host.notice_kinds(), ["paused", "failed"])
        # a second resume on the finished run must refuse
        with self.assertRaisesRegex(ValueError, "not paused"):
            await rlm_module.rlm.swarm.resume(result["run_id"])

    @async_test
    async def test_resume_defers_rate_limited_admissions(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.rate_limit_first["b"] = 2
        self.store_swarm(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        resumed = await rlm_module.rlm.swarm.resume(result["run_id"])
        # resume() must not sleep in the calling turn: the rate-limited
        # admission defers to the control loop's backoff, exactly like run()
        self.assertEqual(resumed["started"], [])
        self.assertEqual(self.sleeps.sleeps, [])
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")  # a errored, b done
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        # b needed 3 admissions total: one deferred at resume, then one
        # rate-limited retry and one success inside the loop's backoff
        self.assertEqual(len(self.host.spawn_calls("b")), 3)
        self.assertEqual(self.sleeps.sleeps, [1.0])

    # -- retries --------------------------------------------------------------------

    @async_test
    async def test_retries_respawn_until_attempts_exhausted(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [{"id": "a", "subagent": "worker", "retries": 2}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # retries=2 -> 3 admissions total, then the policy applies
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
        self.assertEqual(self.node_status(status, "a")["attempts"], 3)
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(status["state"], "failed")

    # -- budgets ----------------------------------------------------------------------

    @async_test
    async def test_node_budget_marks_attempt_failed(self) -> None:
        # The fake clock advances 2s per collect, so the node's 1000ms budget
        # (admission to settlement) is exceeded when the child settles.
        self.clock.advance_per_collect = 2.0
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "budget_ms": 1000},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        a = self.node_status(status, "a")
        self.assertEqual(a["status"], "error")
        self.assertIn("budget", a["error"])
        # budget failures do not retry: exactly one admission for a
        self.assertEqual(len(self.host.spawn_calls("a")), 1)
        # b (depends_on a, no data edge) still ran and finished
        self.assertEqual(self.node_status(status, "b")["status"], "done")
        self.assertEqual(status["state"], "failed")

    @async_test
    async def test_run_budget_pauses_and_notifies_then_resume_completes(self) -> None:
        self.clock.advance_per_collect = 2.0
        self.store_swarm(
            {
                "run": {"failure_policy": "continue", "budget_ms": 1500},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertIn("budget_exceeded", self.host.notice_kinds())
        self.assertEqual(self.host.spawn_calls("b"), [])
        # resume continues despite the spent budget (reported once per run)
        await rlm_module.rlm.swarm.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        self.assertEqual(self.host.notice_kinds(), ["budget_exceeded", "finished"])

    # -- stop and rate limits -------------------------------------------------------------

    @async_test
    async def test_stop_cancels_children_and_pending_nodes(self) -> None:
        self.host.outcomes["a"] = {"status": "running"}
        self.store_swarm(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a"])
        await self.wait_until(lambda: self.host.collects >= 1)
        stopped = await rlm_module.rlm.swarm.stop(result["run_id"])
        self.assertEqual(stopped["run_id"], result["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(stopped["cancelled"], ["a", "b"])
        self.assertEqual(self.host.deleted_targets(), ["child-1"])
        status = await rlm_module.rlm.swarm.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(self.node_status(status, "a")["status"], "cancelled")
        self.assertEqual(self.node_status(status, "b")["status"], "cancelled")
        # repeated stop is idempotent: same result, no duplicate ledger event
        again = await rlm_module.rlm.swarm.stop(result["run_id"])
        self.assertEqual(again, {"run_id": result["run_id"], "state": "stopped", "cancelled": []})
        run_stopped_events = [e for e in self.executor._runs[result["run_id"]].events if e["kind"] == "run_stopped"]
        self.assertEqual(len(run_stopped_events), 1)

    @async_test
    async def test_stop_window_admits_no_new_spawns_and_never_finalizes(self) -> None:
        # max_parallel 2 with three ready nodes: c waits for a slot. The
        # loop's first collect and stop()'s first delete are gated so the
        # stop window opens mid-collect with free-able slots and a ready
        # pending node: the loop must neither admit c nor finalize the run.
        self.store_swarm(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        collect_gate = self.host.gate("rlm.collect", 1)
        delete_gate = self.host.gate("rlm.delete_subagent", 1)
        result = await self.start()
        self.assertEqual(result["started"], ["a", "b"])  # c waits for a slot
        run = self.executor._runs[result["run_id"]]
        await asyncio.sleep(0)  # the loop reaches collect#1 and suspends
        stop_task = asyncio.ensure_future(rlm_module.rlm.swarm.stop(result["run_id"]))
        for _ in range(1000):
            if run.state == "stopping":
                break
            await asyncio.sleep(0)
        self.assertEqual(run.state, "stopping")
        # release the collect: the loop settles a and b inside the stop window
        collect_gate.set()
        await run.task  # the loop must exit on "stopping" without admitting c
        delete_gate.set()
        stopped = await stop_task
        self.assertEqual(stopped["state"], "stopped")
        status = await rlm_module.rlm.swarm.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        # never finalized: no finished notice, and c was never admitted
        self.assertEqual(self.host.notice_kinds(), [])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)

    @async_test
    async def test_rate_limit_at_admission_defers_to_backoff(self) -> None:
        # First two admissions for a fail with a 429: one at run() admission
        # (deferred, no sleep), one inside the loop (backoff sleep), then success.
        self.host.rate_limit_first["a"] = 2
        self.store_swarm({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        self.assertEqual(result["started"], [])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        # three host admissions in total: one deferred at run(), then one
        # rate-limited retry inside the loop's backoff, then success
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
        self.assertEqual(self.node_status(status, "a")["attempts"], 2)
        self.assertEqual(self.sleeps.sleeps, [1.0])

    @async_test
    async def test_rate_limit_backoff_exhaustion_fails_node(self) -> None:
        self.host.rate_limit_forever.add("b")
        self.store_swarm(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # 5 admission attempts with doubling backoff capped at 60s, then error
        self.assertEqual(len(self.host.spawn_calls("b")), 5)
        self.assertEqual(self.sleeps.sleeps, [1.0, 2.0, 4.0, 8.0])
        b = self.node_status(status, "b")
        self.assertEqual(b["status"], "error")
        self.assertIn("spawn admission failed", b["error"])
        self.assertEqual(status["state"], "failed")

    # -- scale -----------------------------------------------------------------------------

    @async_test
    async def test_scale_chain_100_completes(self) -> None:
        nodes = [{"id": "n0", "subagent": {"prompt": "step"}}]
        for index in range(1, 100):
            nodes.append({"id": f"n{index}", "subagent": {"prompt": "step"}, "depends_on": [f"n{index - 1}"]})
        self.store_swarm({"run": {"max_parallel": 8}, "nodes": nodes})
        started = time.monotonic()
        result = await self.start()
        status = await self.settle(result)
        elapsed = time.monotonic() - started
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(status["nodes"]), 100)
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertLess(elapsed, 10.0)

    @async_test
    async def test_scale_fan_1000_completes(self) -> None:
        nodes = [{"id": "n0", "subagent": {"prompt": "step"}}]
        for index in range(1, 1000):
            nodes.append({"id": f"n{index}", "subagent": {"prompt": "step"}, "depends_on": ["n0"]})
        self.store_swarm({"run": {"max_parallel": 64}, "nodes": nodes})
        started = time.monotonic()
        result = await self.start()
        status = await self.settle(result)
        elapsed = time.monotonic() - started
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(status["nodes"]), 1000)
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertLess(elapsed, 10.0)

    # -- status, ledger, residents ----------------------------------------------------------

    @async_test
    async def test_status_marks_events_delivered_and_unknown_run_raises(self) -> None:
        self.store_swarm({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(lambda: run.state != "running")
        # Before any status() read: answers are arrived, the milestone is shown.
        stages = {event["kind"]: event["stage"] for event in run.events}
        self.assertEqual(stages["answer_captured"], "arrived")
        self.assertEqual(stages["milestone"], "shown")
        status = await rlm_module.rlm.swarm.status(result["run_id"])
        self.assertTrue(all(event["stage"] == "delivered" for event in status["events"]))
        self.assertTrue(all(event["stage"] == "delivered" for event in run.events))
        self.assertLessEqual(len(status["events"]), 50)
        # exactly one notice for the one milestone
        self.assertEqual(self.host.notice_kinds(), ["finished"])
        for call in ("status", "stop", "resume"):
            with self.assertRaisesRegex(ValueError, "unknown swarm run"):
                await getattr(rlm_module.rlm.swarm, call)("no-such-run")

    @async_test
    async def test_resident_node_spawns_stays_alive_and_stops(self) -> None:
        self.host.outcomes["watcher"] = {"status": "running"}
        self.store_swarm(
            {
                "nodes": [
                    {"id": "t", "subagent": "worker"},
                    {"id": "watcher", "subagent": "worker", "lifecycle": "resident"},
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["t", "watcher"])
        status = await self.settle(result)
        # The task node settled; the run reports done while the resident stays
        # alive under the supervisor (V1 wake source: its own prompt/tooling).
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "t")["status"], "done")
        resident = self.node_status(status, "watcher")
        self.assertEqual(resident["status"], "running")
        self.assertEqual(resident["lifecycle"], "resident")
        self.assertIn("finished", self.host.notice_kinds())
        # stop() tears the resident child down.
        stopped = await rlm_module.rlm.swarm.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["watcher"])
        self.assertEqual(self.host.deleted_targets(), ["child-2"])
        self.assertEqual((await rlm_module.rlm.swarm.status(result["run_id"]))["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
