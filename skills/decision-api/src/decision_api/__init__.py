"""Prime Agent decision-api skill: an experimental System 1 / System 2 loop.

System 1 is the session's decision model: the model the user named in the
decisionApi.systemOneModel setting. `decide()` calls it once for a single
decision; `Loop` runs the control loop: it spawns a decision child
(`rlm.spawn(..., kind="decision")`) whose every message is one decision
request, so each observation becomes one model call. System 2 is the
parent — you, the calling agent: goals flow to the child as tagged
agent-to-agent messages, and every decision the child serves reads the
latest goal. You design, measure, and adjust the loop live.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

import agent_message
import rlm

DEFAULT_INSTRUCTIONS = "Choose the next action that best advances the goal given the observation."
# One decision request's wall-clock bound (the child transport waits up to
# this long for the child's reply before recording the step's error).
DECIDE_TIMEOUT = 30.0
# One spawned decision child's admission bound.
SPAWN_TIMEOUT = 30.0
# The child-deletion bound at loop teardown.
CHILD_CLEANUP_TIMEOUT = 5.0
# The poll interval while awaiting the child's reply.
_REPLY_POLL_SECONDS = 0.05
_OBSERVATION_CHARS = 6000
_MAX_ERRORS = 50


def _default_state(observation: Any, goal: str, history: list[dict[str, Any]]) -> dict[str, Any]:
    """What System 1 sees by default: the observation and recent actions."""
    state: dict[str, Any] = {"observation": observation}
    if history:
        state["recent_actions"] = history
    return state


async def _ask_system1(
    state: Any,
    actions: dict[str, str],
    *,
    instructions: str = DEFAULT_INSTRUCTIONS,
    images: list[str] | None = None,
) -> dict[str, Any]:
    """One System 1 decision for an arbitrary `state`. The host serves the
    request with the decisionApi.systemOneModel model through the normal
    provider transports; no key ever enters this kernel. `images`
    (vision models only, at most 4) are data URL strings
    (`data:image/png;base64,...`).
    Returns `action`, `confidence`, `probabilities`, `latency_ms`, and `model`."""
    question = {"type": "choice", "instructions": instructions, "criteria": actions}
    request: dict[str, Any] = {"state": state, "questions": {"action": question}}
    if images:
        bad = [
            repr(image)[:40] for image in images if not (isinstance(image, str) and image.startswith("data:image/"))
        ]
        if bad:
            raise TypeError(f"images must be data URL strings like 'data:image/png;base64,...', got {bad}")
        request["images"] = list(images)
    started = time.perf_counter()
    body = await rlm.host_request("decision_api.decide", {"request": request})
    answer = body["answers"]["action"]
    return {
        "action": answer["choice"],
        "confidence": answer["confidence"],
        "probabilities": answer["probabilities"],
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "model": body.get("model"),
    }


async def decide(
    observation: Any,
    actions: dict[str, str],
    *,
    goal: str = "",
    history: list[dict[str, Any]] | None = None,
    instructions: str = DEFAULT_INSTRUCTIONS,
    images: list[str] | None = None,
) -> dict[str, Any]:
    """A single System 1 decision with the default state."""
    state = _default_state(observation, goal, history or [])
    if goal:
        state["goal"] = goal
    return await _ask_system1(state, actions, instructions=instructions, images=images)


async def _call(fn: Callable[..., Any], *args: Any) -> Any:
    result = fn(*args)
    return await result if inspect.isawaitable(result) else result


def _spawn_prompt(objective: str, instructions: str) -> str:
    """The decision child's protocol prompt, composed from this skill's
    material: the child answers every message with one decision."""
    return (
        "You are System 1, the decision child of a real-time control loop.\n"
        f"Objective: {objective}\n"
        f"Decision instructions: {instructions}\n"
        "Every later message is one decision request; your replies carry its "
        "answer back to the parent."
    )


class Loop:
    """A live System 1 / System 2 control loop.

    System 1 is a spawned decision child (`rlm.spawn(kind="decision")`):
    each observation becomes one request to the child, one decision model
    call, and one reply back here. The child lives exactly as long as the
    loop. System 2 is the parent — you: `set_goal` routes updated goals to
    the child as tagged messages, and every decision reads the latest goal.

    Every attribute is read afresh each step, so assigning one on a running
    loop changes the next step. `goal` is yours: it starts as `objective`
    and `set_goal` updates it.

    - `observe()` returns an observation, or None to end the loop.
    - `act(action)` applies an action. Both may be sync or async.
    - `actions`: action name -> when it applies, or `(observation) -> dict`.
    - `objective`: the overall task.
    - `state`: `(observation, goal, history) -> Any`, what System 1 sees.
    - `images`: None, or `(observation) -> list` of data URL strings System 1 sees
      next to `state` (vision-capable models; see `decide`).
    - `instructions`: System 1's question instructions.
    - `system1`: None for the spawned decision child, or `(observation,
      actions, goal, history) -> action name or dict with "action"` to
      replace System 1 entirely.
    - `decide_timeout`: maximum seconds one decision round trip may take.
    - `tick`: minimum seconds per step (None runs as fast as decisions come).
    - `max_steps`: stop after this many steps (None runs until observe ends it).
    - `history_size`: recent actions shown to System 1.
    - `on_step`: `(record, observation)` after each step; returning "stop" ends the loop.
    - `on_error`: when System 1 fails, "stop", "skip", or `(error, observation)
      -> action name or None`.
    """

    def __init__(
        self,
        observe: Callable[[], Any],
        act: Callable[[str], Any],
        actions: dict[str, str] | Callable[[Any], dict[str, str]],
        *,
        objective: str,
        **settings: Any,
    ) -> None:
        self.observe = observe
        self.act = act
        self.actions = actions
        self.objective = objective
        self.state: Callable[..., Any] = _default_state
        self.images: Callable[[Any], list[str] | None] | None = None
        self.instructions = DEFAULT_INSTRUCTIONS
        self.system1: Callable[..., Any] | None = None
        self.decide_timeout: float = DECIDE_TIMEOUT
        self.tick: float | None = None
        self.max_steps: int | None = None
        self.history_size = 20
        self.on_step: Callable[..., Any] | None = None
        self.on_error: str | Callable[..., Any] = "stop"
        for name, value in settings.items():
            if not hasattr(self, name):
                raise TypeError(f"Loop has no setting {name!r}")
            setattr(self, name, value)
        self.history: list[dict[str, Any]] = []
        self.goal_updates: list[dict[str, Any]] = []
        self.errors: list[dict[str, Any]] = []
        self.error: str | None = None
        self.step = 0
        self._loop_id = uuid.uuid4().hex
        self._goal: str | None = None
        self._child_name: str | None = None
        self._child_model: str | None = None
        self._child_ready = asyncio.Event()
        self._resume = asyncio.Event()
        self._resume.set()
        self._stopping = False
        self._task: asyncio.Task[None] | None = None
        self._spawn_task: asyncio.Task[None] | None = None

    @property
    def goal(self) -> str:
        return self.objective if self._goal is None else self._goal

    def set_goal(self, goal: str) -> None:
        """Route an updated goal to the decision child (System 2 = the
        parent): fire-and-forget; every later decision reads it."""
        if not isinstance(goal, str) or not goal.strip():
            raise TypeError("goal must be a non-empty string")
        self._goal = goal
        self.goal_updates.append({"step": self.step, "goal": goal})
        if self._child_name is not None:
            message = json.dumps({"type": "decision_api.goal", "seq": self.step, "goal": goal})
            asyncio.get_running_loop().create_task(
                agent_message.send(message, receiver_role="child", receiver_name=self._child_name)
            )

    def start(self) -> "Loop":
        """Run the loop as a background task and return immediately."""
        if self._task is not None:
            raise RuntimeError("This loop was already started")
        self._spawn_task = asyncio.get_running_loop().create_task(self._spawn_child())
        self._task = asyncio.get_running_loop().create_task(self._run())
        return self

    def pause(self) -> None:
        self._resume.clear()

    def resume(self) -> None:
        self._resume.set()

    async def wait(self, timeout: float | None = None) -> dict[str, Any]:
        """Wait up to `timeout` seconds for the loop to end; return its status."""
        if self._task is None:
            raise RuntimeError("Start the loop first")
        try:
            await asyncio.wait_for(asyncio.shield(self._task), timeout)
        except TimeoutError:
            pass
        except asyncio.CancelledError:
            if not self._task.cancelled():
                raise
        return self.status()

    async def stop(self) -> dict[str, Any]:
        """End the loop after the current step, remove the child, return the status."""
        self._stopping = True
        self._resume.set()
        return await self.wait()

    async def run(self) -> dict[str, Any]:
        """Run to completion in the current cell."""
        return await self.start().wait()

    def status(self) -> dict[str, Any]:
        recent = self.history[-self.history_size :]
        latencies = [r["latency_ms"] for r in recent if r.get("latency_ms") is not None]
        return {
            "running": self._task is not None and not self._task.done(),
            "paused": not self._resume.is_set(),
            "step": self.step,
            "objective": self.objective,
            "goal": self.goal,
            "system1_model": self._child_model,
            "last": self.history[-1] if self.history else None,
            "mean_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "errors": len(self.errors),
            "error": self.error,
        }

    def _record_error(self, where: str, error: BaseException) -> None:
        self.errors.append({"step": self.step, "where": where, "error": f"{type(error).__name__}: {error}"})
        del self.errors[:-_MAX_ERRORS]

    async def _spawn_child(self) -> None:
        """Spawn the decision child with bounded retries; failures surface in
        `loop.errors` and retry in the background while the loop waits."""
        failures = 0
        while not self._stopping and self._child_name is None:
            try:
                name = f"system-1-{self._loop_id}"
                handle = await asyncio.wait_for(
                    rlm.spawn(
                        _spawn_prompt(self.objective, self.instructions),
                        name=name,
                        kind="decision",
                    ),
                    SPAWN_TIMEOUT,
                )
                self._child_name = handle.name
                self._child_model = handle.model
                self._child_ready.set()
            except Exception as error:
                self._record_error("spawn", error)
                failures += 1
                await asyncio.sleep(min(5.0, 0.25 * 2 ** min(failures - 1, 5)))

    async def _run(self) -> None:
        try:
            while not self._stopping and (self.max_steps is None or self.step < self.max_steps):
                await self._resume.wait()
                if self._stopping:
                    break
                started = time.perf_counter()
                if await self._step() == "stop":
                    break
                if self.tick is not None:
                    await asyncio.sleep(max(0.0, self.tick - (time.perf_counter() - started)))
                else:
                    # Synchronous callbacks must not starve the transport tasks.
                    await asyncio.sleep(0)
        except asyncio.CancelledError:
            self.error = "cancelled"
            raise
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
        finally:
            self._stopping = True
            await self._remove_child()

    async def _step(self) -> str | None:
        observation = await _call(self.observe)
        if observation is None:
            return "stop"
        actions = self.actions(observation) if callable(self.actions) else self.actions
        history = self.history[-self.history_size :]
        try:
            if self.system1 is not None:
                started = time.perf_counter()
                choice = await _call(self.system1, observation, actions, self.goal, history)
                decision = dict(choice) if isinstance(choice, dict) else {"action": choice}
                decision.setdefault("latency_ms", round((time.perf_counter() - started) * 1000, 1))
                if decision.get("model"):
                    self._child_model = decision["model"]
            else:
                decision = await self._decide(observation, actions, history)
        except Exception as error:
            self._record_error("system1", error)
            if self.on_error == "stop":
                raise
            fallback = None if self.on_error == "skip" else await _call(self.on_error, error, observation)
            if fallback is None:
                self.step += 1
                return None
            decision = {"action": fallback, "confidence": None, "latency_ms": None, "fallback": True}
        if decision.get("model"):
            self._child_model = decision["model"]
        await _call(self.act, decision["action"])
        record = {
            "step": self.step,
            "action": decision["action"],
            "confidence": decision.get("confidence"),
            "latency_ms": decision.get("latency_ms"),
        }
        if decision.get("fallback"):
            record["fallback"] = True
        self.history.append(record)
        self.step += 1
        if self.on_step is not None:
            return await _call(self.on_step, record, observation)
        return None

    async def _decide(
        self, observation: Any, actions: dict[str, str], history: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """One decision through the child: send the request, await the reply.
        The child injects the latest goal (message-sourced) into the state."""
        await asyncio.wait_for(self._child_ready.wait(), self.decide_timeout)
        name = self._child_name
        assert name is not None
        state = self.state(observation, self.goal, history)
        images = None if self.images is None else await _call(self.images, observation)
        if images:
            bad = [
                repr(image)[:40] for image in images if not (isinstance(image, str) and image.startswith("data:image/"))
            ]
            if bad:
                raise TypeError(f"images must be data URL strings like 'data:image/png;base64,...', got {bad}")
        request: dict[str, Any] = {
            "seq": self.step,
            "state": state,
            "questions": {
                "action": {
                    "type": "choice",
                    "instructions": self.instructions,
                    "criteria": actions,
                }
            },
        }
        if images:
            request["images"] = list(images)
        started = time.perf_counter()
        await agent_message.send(
            json.dumps(request), receiver_role="child", receiver_name=name
        )
        # Await the tagged reply: the parent's decision slot holds it.
        deadline = time.monotonic() + self.decide_timeout
        while time.monotonic() < deadline:
            reply = await rlm.host_request("decision_api.decision", {"name": name})
            if reply is not None and reply.get("seq") == self.step:
                if reply.get("error") is not None:
                    raise RuntimeError(f"the decision child failed: {reply['error']}")
                answer = reply["decision"]
                return {
                    "action": answer["choice"],
                    "confidence": answer.get("confidence"),
                    "probabilities": answer.get("probabilities"),
                    "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                    "model": reply.get("model"),
                }
            await asyncio.sleep(_REPLY_POLL_SECONDS)
        raise TimeoutError(
            f"the decision child did not answer within {self.decide_timeout} s"
        )

    async def _remove_child(self) -> None:
        """Teardown: drop the parent's reply slot and delete the child."""
        name = self._child_name
        if name is None:
            return
        self._child_name = None
        try:
            await asyncio.wait_for(
                rlm.host_request("decision_api.decision", {"name": name, "close": True}),
                CHILD_CLEANUP_TIMEOUT,
            )
        except Exception as error:
            self._record_error("cleanup", error)
        try:
            await asyncio.wait_for(rlm.delete_subagent(name), CHILD_CLEANUP_TIMEOUT)
        except Exception as error:
            self._record_error("cleanup", error)
