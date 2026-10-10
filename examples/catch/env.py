"""Catch as an environment. The session agent writes the decision-api loop.

    import sys; sys.path.insert(0, "<repo>/examples/catch")
    import env
    catch = await env.CatchEnv.make(seconds=60, seed=1)
    observation, info = await catch.reset()
    observation, reward, terminated, truncated, info = await catch.step("wait")
    result = await catch.close()

Each observation carries the text state (`picture`, `bowl`, `caught`,
`missed`, `done`) and the rendered frame as a PNG data URL (`image`).
`observation_state` and `observation_images` split it for the decision-api
loop: System 1 reads the compact text state and sees the frame as an image
block (vision-capable models only).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
# What an action does to the bowl. When to take it is the agent's decision.
ACTIONS = {
    "wait": "Leave the bowl in its current column",
    "goto_far_left": "Move the bowl to the far left column",
    "goto_left": "Move the bowl to the left column",
    "goto_middle": "Move the bowl to the middle column",
    "goto_right": "Move the bowl to the right column",
    "goto_far_right": "Move the bowl to the far right column",
}


def observation_state(
    observation: dict[str, Any], goal: str = "", history: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """The compact text half of an observation for the loop's `state`
    callback: every field but the rendered frame. `observation_images`
    sends the frame as an image block, so the data URL never rides the
    text state too."""
    state: dict[str, Any] = {
        "observation": {key: value for key, value in observation.items() if key != "image"}
    }
    if history:
        state["recent_actions"] = history
    return state


def observation_images(observation: dict[str, Any]) -> list[str] | None:
    """The observation's rendered frame as decision images for the loop's
    `images` callback: one PNG data URL, or None when there is no frame."""
    image = observation.get("image")
    if isinstance(image, str) and image.startswith("data:image/"):
        return [image]
    return None


class CatchEnv:
    """One episode of Catch. `make` launches the window; `reset` starts the clock.

    `step` applies one action and returns the next observation, the reward
    (catches minus drops since the previous step), and whether the episode
    ended because time ran out (`terminated`) or the game process stopped
    early (`truncated`).
    """

    actions = ACTIONS

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        recording: Path | None,
        summary: Path,
    ) -> None:
        self.process = process
        self.reader = reader
        self.writer = writer
        self.recording = recording
        self.summary_path = summary
        self._lock = asyncio.Lock()
        self._caught = 0
        self._missed = 0
        self._started = False
        self._terminated = False
        self._closed = False
        self._result: dict[str, Any] | None = None

    @classmethod
    async def make(
        cls,
        seconds: float = 120,
        *,
        record: bool = True,
        headless: bool = False,
        seed: int | None = None,
    ) -> CatchEnv:
        runs = HERE / "runs"
        runs.mkdir(exist_ok=True)
        run = Path(tempfile.mkdtemp(prefix="catch-", dir=runs))
        recording = run / "recording.mp4" if record else None
        summary = run / "summary.json"
        command = ["uv", "run", "--quiet", str(HERE / "game.py"), "--seconds", str(seconds), "--summary", str(summary)]
        if recording:
            command += ["--record", str(recording)]
        if headless:
            command.append("--headless")
        if seed is not None:
            command += ["--seed", str(seed)]
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE)
        writer = None
        try:
            assert process.stdout is not None
            line = await asyncio.wait_for(process.stdout.readline(), timeout=120)
            if not line.startswith(b"PORT "):
                raise RuntimeError(f"the game did not start (exit code {process.returncode})")
            reader, writer = await asyncio.open_connection("127.0.0.1", int(line.split()[1]))
            return cls(process, reader, writer, recording, summary)
        except BaseException:
            if writer is not None:
                writer.close()
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
            raise

    async def reset(self) -> tuple[dict[str, Any], dict[str, int]]:
        """Start the episode and return the first observation."""
        if self._closed:
            raise RuntimeError("environment is closed")
        if self._started:
            raise RuntimeError("this environment runs one episode; make a new one to reset")
        observation = await self._request(op="observe")
        self._started = True
        self._caught = int(observation.get("caught", 0))
        self._missed = int(observation.get("missed", 0))
        return observation, {"caught": self._caught, "missed": self._missed}

    async def step(self, action: str) -> tuple[dict[str, Any], float, bool, bool, dict[str, int]]:
        """Apply `action` and return `(observation, reward, terminated, truncated, info)`."""
        if self._closed:
            raise RuntimeError("environment is closed")
        if not self._started:
            raise RuntimeError("call reset() before step()")
        if action not in ACTIONS:
            raise ValueError(f"unknown action {action!r}; actions are {', '.join(ACTIONS)}")
        acted = await self._request(op="act", action=action)
        if acted.get("ok") is False:
            raise ValueError(acted.get("error"))
        observation = await self._request(op="observe")
        if observation.get("truncated"):
            info = {"caught": self._caught, "missed": self._missed}
            return observation, 0.0, False, True, info
        caught = int(observation.get("caught", self._caught))
        missed = int(observation.get("missed", self._missed))
        reward = float((caught - self._caught) - (missed - self._missed))
        self._caught, self._missed = caught, missed
        terminated = bool(observation.get("done"))
        self._terminated = self._terminated or terminated
        return observation, reward, terminated, False, {"caught": caught, "missed": missed}

    async def render(self, *, system1: dict[str, Any] | None = None, system2: dict[str, Any] | None = None) -> None:
        """Show status on the game's side panel. The agent decides what to send."""
        await self._request(op="overlay", system1=system1 or {}, system2=system2 or {})

    async def close(self) -> dict[str, Any]:
        """Stop the game if it is still running and return the score and recording path."""
        if self._result is not None:
            return self._result
        self._closed = True
        self.writer.close()
        if self.process.returncode is None and not self._terminated:
            self.process.terminate()
        await self.process.wait()
        await self.writer.wait_closed()
        score = json.loads(self.summary_path.read_text()) if self.summary_path.exists() else None
        self._result = {"score": score, "recording": str(self.recording) if self.recording else None}
        return self._result

    async def _request(self, **request: Any) -> dict[str, Any]:
        async with self._lock:
            self.writer.write((json.dumps(request) + "\n").encode())
            await self.writer.drain()
            line = await self.reader.readline()
        if not line:
            return {"truncated": True}
        return json.loads(line)
