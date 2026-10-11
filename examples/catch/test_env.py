"""Catch startup owns its subprocess, including failed and cancelled startup.
The observation helpers split the rendered frame from the text state."""

import asyncio
import base64
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import env


class Process:
    def __init__(self, line=b"PORT 12345\n"):
        self.stdout = type("Stdout", (), {"readline": AsyncMock(return_value=line)})()
        self.returncode = None
        self.reaped = False

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9

    async def wait(self):
        self.reaped = True
        return self.returncode


class CatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.here = patch.object(env, "HERE", Path(self.directory.name))
        self.here.start()
        self.addCleanup(self.here.stop)

    async def test_concurrent_runs_have_independent_artifacts(self):
        processes = [Process(), Process()]
        writer = type("Writer", (), {"close": lambda _self: None, "wait_closed": AsyncMock()})()
        with (
            patch.object(asyncio, "create_subprocess_exec", AsyncMock(side_effect=processes)),
            patch.object(asyncio, "open_connection", AsyncMock(return_value=(None, writer))),
        ):
            first, second = await asyncio.gather(env.CatchEnv.make(), env.CatchEnv.make())
            self.assertNotEqual(first.summary_path, second.summary_path)
            self.assertNotEqual(first.recording, second.recording)
            self.assertNotEqual(first.summary_path.parent, second.summary_path.parent)
            await asyncio.gather(first.close(), second.close())
        self.assertTrue(all(process.reaped for process in processes))

    async def test_failed_startup_terminates_and_reaps_process(self):
        for line, failure in ((b"bad startup\n", RuntimeError), (b"PORT invalid\n", ValueError)):
            process = Process(line)
            with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                with self.assertRaises(failure):
                    await env.CatchEnv.make(record=False)
            self.assertEqual(process.returncode, -15)
            self.assertTrue(process.reaped)

    async def test_connection_failure_terminates_and_reaps_process(self):
        process = Process()
        with (
            patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=process)),
            patch.object(asyncio, "open_connection", AsyncMock(side_effect=ConnectionRefusedError)),
        ):
            with self.assertRaises(ConnectionRefusedError):
                await env.CatchEnv.make(record=False)
        self.assertEqual(process.returncode, -15)
        self.assertTrue(process.reaped)

    async def test_cancelled_startup_terminates_and_reaps_process(self):
        process = Process()
        process.stdout.readline.side_effect = asyncio.CancelledError
        with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.CancelledError):
                await env.CatchEnv.make(record=False)
        self.assertEqual(process.returncode, -15)
        self.assertTrue(process.reaped)


class ObservationHelperTests(unittest.TestCase):
    def observation(self, image="data:image/png;base64,aGVsbG8="):
        return {
            "picture": [".....", "..U.."],
            "bowl": "middle",
            "caught": 3,
            "missed": 4,
            "done": False,
            "image": image,
        }

    def test_state_keeps_the_text_and_drops_the_frame(self):
        state = env.observation_state(self.observation())
        self.assertEqual(
            state["observation"],
            {"picture": [".....", "..U.."], "bowl": "middle", "caught": 3, "missed": 4, "done": False},
        )

    def test_state_keeps_the_text_when_there_is_no_frame(self):
        observation = self.observation(image=None)
        state = env.observation_state(observation)
        self.assertNotIn("image", state["observation"])
        self.assertEqual(state["observation"]["caught"], 3)

    def test_state_carries_recent_actions(self):
        history = [{"step": 0, "action": "wait", "confidence": 0.5, "latency_ms": 1.0}]
        state = env.observation_state(self.observation(), history=history)
        self.assertEqual(state["recent_actions"], history)

    def test_images_pass_the_frame_through_as_a_data_url(self):
        self.assertEqual(env.observation_images(self.observation()), ["data:image/png;base64,aGVsbG8="])
        self.assertIsNone(env.observation_images(self.observation(image=None)))
        self.assertIsNone(env.observation_images(self.observation(image="not-a-data-url")))


class LiveObservationFrameTests(unittest.IsolatedAsyncioTestCase):
    """The game serves a real rendered frame: a decodable PNG of the play
    area. Skipped when `uv` cannot run the game (its declared pygame
    dependency resolves through uv)."""

    @classmethod
    def setUpClass(cls):
        if shutil.which("uv") is None:
            raise unittest.SkipTest("uv is not on PATH; the game cannot start")

    async def asyncSetUp(self):
        self.environment = await env.CatchEnv.make(seconds=5, seed=1, record=False, headless=True)

    def assert_play_area_png(self, url):
        prefix, _, data = url.partition(",")
        self.assertEqual(prefix, "data:image/png;base64")
        png = base64.b64decode(data, validate=True)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual((width, height), (360, 360))

    async def test_the_observation_carries_a_play_area_png(self):
        observation, _ = await self.environment.reset()
        self.assertIn("picture", observation)
        self.assertIn("bowl", observation)
        self.assert_play_area_png(observation["image"])

    async def test_the_frame_tracks_the_game(self):
        observation, _ = await self.environment.reset()
        first = observation["image"]
        # The seeded first circle spawns at 0.6 s and is mid-fall here, so
        # the frame must move with the game, not stay the opening render.
        await asyncio.sleep(0.8)
        observation, _, terminated, truncated, _ = await self.environment.step("wait")
        self.assertFalse(terminated or truncated)
        second = observation["image"]
        self.assert_play_area_png(second)
        self.assertNotEqual(first, second)

    async def asyncTearDown(self):
        await self.environment.close()
        shutil.rmtree(self.environment.summary_path.parent, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
