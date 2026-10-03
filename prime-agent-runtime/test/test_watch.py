from __future__ import annotations

import asyncio
import os
import sys
import time
import unittest
from typing import Any
from unittest.mock import AsyncMock, patch

SRC = os.path.join(os.path.dirname(__file__), "..", "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import rlm  # noqa: E402


class FakeJobHandle:
    """Fake bash handle: output grows per poll, then the job stops."""

    def __init__(self, pid: int, chunks: list[str]) -> None:
        self.pid = pid
        self.command = "fake long-running job"
        self._chunks = chunks
        self._index = 0
        self.running = True

    def output(self) -> str:
        consumed = "".join(self._chunks[: self._index])
        return consumed

    def peek_output(self) -> str:
        return self.output()

    def peek_output_bytes(self) -> int:
        return len(self.output().encode("utf-8"))

    def _grow(self) -> None:
        if self._index < len(self._chunks):
            self._index += 1
        if self._index >= len(self._chunks):
            self.running = False


class RlmWatchJobTest(unittest.TestCase):
    def tearDown(self) -> None:
        rlm._JOB_WATCHES.clear()

    def test_job_watch_emits_byte_ranges_and_stops_when_the_job_ends(self) -> None:
        seen: list[tuple[int, int]] = []
        handle = FakeJobHandle(4242, ["a" * 100, "b" * 200, "c" * 300])

        async def fake_host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            if request_type == "bash.progress":
                seen.append((payload["fromBytes"], payload["toBytes"]))
            return {"status": "ok"}

        async def scenario() -> None:
            with patch.object(rlm, "host_request", AsyncMock(side_effect=fake_host_request)):
                rlm._JOB_WATCHES.clear()
                result = await rlm.rlm.watch.job(handle, interval_seconds=0.01)
                self.assertEqual(result, {"pid": 4242, "watching": True})
                self.assertEqual(rlm.rlm.watch.job_list(), [{"pid": 4242, "interval": 0.01}])

                await asyncio.sleep(0.005)  # let the poller capture its 0-byte baseline
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    handle._grow()
                    await asyncio.sleep(0.005)
                    if not handle.running:
                        break
                # Let the poller observe the final chunk and exit its loop.
                for _ in range(20):
                    await asyncio.sleep(0.01)
                    if seen and seen[-1][1] == 600:
                        break

                # A LIVE watch cancels; the ended watch already cleaned its
                # entry, so cancelling it again answers False.
                live = FakeJobHandle(4243, ["z" * 10])
                live.running = True
                rlm._JOB_WATCHES.clear()
                self.assertEqual(await rlm.rlm.watch.job(live, interval_seconds=0.05), {"pid": 4243, "watching": True})
                self.assertEqual(rlm.rlm.watch.job_cancel(4243), True)
                self.assertEqual(rlm.rlm.watch.job_cancel(4243), False)
                self.assertEqual(rlm.rlm.watch.job_cancel(4242), False)

        asyncio.run(scenario())
        self.assertTrue(len(seen) >= 1)
        self.assertEqual(seen[0][0], 0)
        self.assertEqual(seen[-1][1], 600)
        # The watch ended with the job: the table no longer lists it.
        self.assertEqual(rlm.rlm.watch.job_list(), [])

    def test_job_watch_counts_utf8_bytes_not_characters(self) -> None:
        handle = FakeJobHandle(4301, ["é" * 100])

        async def fake_host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            if request_type == "bash.progress":
                seen.append((payload["fromBytes"], payload["toBytes"]))
            return {"status": "ok"}

        seen: list[tuple[int, int]] = []

        async def scenario() -> None:
            with patch.object(rlm, "host_request", AsyncMock(side_effect=fake_host_request)):
                rlm._JOB_WATCHES.clear()
                await rlm.rlm.watch.job(handle, interval_seconds=0.01)
                await asyncio.sleep(0.02)
                handle._grow()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not seen:
                    await asyncio.sleep(0.01)
                for _ in range(10):
                    await asyncio.sleep(0.01)

        asyncio.run(scenario())
        self.assertTrue(len(seen) >= 1)
        # "é" is two UTF-8 bytes, so 100 characters report 200 bytes.
        self.assertEqual(seen[-1][1], 200)

    def test_job_watch_rejects_non_handles_and_invalid_intervals(self) -> None:
        async def scenario() -> None:
            rlm._JOB_WATCHES.clear()
            with self.assertRaises(TypeError):
                await rlm.rlm.watch.job(object())
            with self.assertRaises(ValueError):
                await rlm.rlm.watch.job(FakeJobHandle(1, ["x"]), interval_seconds=0)
            # A non-finite interval would sleep-raise inside the task and
            # kill the watch silently; it is rejected at registration.
            with self.assertRaises(ValueError):
                await rlm.rlm.watch.job(FakeJobHandle(2, ["x"]), interval_seconds=float("nan"))
            with self.assertRaises(ValueError):
                await rlm.rlm.watch.job(FakeJobHandle(3, ["x"]), interval_seconds=float("inf"))
            self.assertEqual(rlm.rlm.watch.job_list(), [])

        asyncio.run(scenario())


class RlmWatchAgentTest(unittest.TestCase):
    def test_agent_watch_forwards_to_host_handlers(self) -> None:
        host_request = AsyncMock(return_value={"id": "watch-agent-sub-1", "childName": "worker", "messages": 3})
        with patch.object(rlm, "host_request", host_request):
            result = asyncio.run(rlm.rlm.watch.agent("worker"))
        self.assertEqual(result["childName"], "worker")
        host_request.assert_awaited_once_with("rlm.watch.agent", {"target": "worker"})

        host_request.reset_mock()
        host_request.return_value = {"watches": []}
        with patch.object(rlm, "host_request", host_request):
            asyncio.run(rlm.rlm.watch.agent_list())
        host_request.assert_awaited_once_with("rlm.watch.agent_list")

        host_request.reset_mock()
        host_request.return_value = {"cancelled": True}
        with patch.object(rlm, "host_request", host_request):
            asyncio.run(rlm.rlm.watch.agent_cancel("watch-agent-sub-1"))
        host_request.assert_awaited_once_with("rlm.watch.agent_cancel", {"id": "watch-agent-sub-1"})

    def test_watch_reports_the_final_output_after_running_flips(self) -> None:
        """The watcher drains the stdout pump's last bytes before exiting."""

        class LatePumpHandle:
            """A reaped job whose final bytes land only after the loop first
            observes `running == False` — the growth exists solely inside the
            drain window, so the test fails without the drain."""

            pid = 9999
            command = "late pump job"

            def __init__(self) -> None:
                self._running_observed = False

            @property
            def running(self) -> bool:
                # The loop reads `running` after each peek; the process is
                # already reaped, but the pump still holds the last chunk.
                self._running_observed = True
                return False

            def peek_output_bytes(self) -> int:
                # 0 until `running` was observed; 500 once the pump lands
                # the final bytes inside the drain window.
                return 500 if self._running_observed else 0

            def output(self) -> str:
                return ""

            def peek_output(self) -> str:
                return ""

        handle = LatePumpHandle()
        seen: list[tuple[int, int]] = []

        async def fake_host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            if request_type == "bash.progress":
                seen.append((payload["fromBytes"], payload["toBytes"]))
            return {"status": "ok"}

        async def scenario() -> None:
            with patch.object(rlm, "host_request", AsyncMock(side_effect=fake_host_request)):
                rlm._JOB_WATCHES.clear()
                await rlm.rlm.watch.job(handle, interval_seconds=0.01)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not seen:
                    await asyncio.sleep(0.01)
                # Let the drain finish.
                await asyncio.sleep(0.2)

        asyncio.run(scenario())
        self.assertTrue(len(seen) >= 1, "the final output range never reported")
        self.assertEqual(seen[-1], (0, 500))
        self.assertEqual(rlm.rlm.watch.job_list(), [])

    def test_cancelled_watch_finally_does_not_pop_a_replacement(self) -> None:
        """A re-registration on the same pid survives the cancelled task's cleanup."""

        async def scenario() -> None:
            rlm._JOB_WATCHES.clear()
            first = FakeJobHandle(4244, ["a" * 10])
            first.running = True
            await rlm.rlm.watch.job(first, interval_seconds=0.05)
            # Cancel the live watch (the task is cancelled but its finally
            # may run late), then immediately re-register on the same pid.
            rlm.rlm.watch.job_cancel(4244)
            second = FakeJobHandle(4244, ["b" * 10])
            second.running = True
            result = await rlm.rlm.watch.job(second, interval_seconds=0.05)
            self.assertEqual(result, {"pid": 4244, "watching": True})
            # Let the cancelled task's finally run: the replacement stays.
            await asyncio.sleep(0.02)
            self.assertEqual(rlm.rlm.watch.job_list(), [{"pid": 4244, "interval": 0.05}])

        asyncio.run(scenario())
        rlm._JOB_WATCHES.clear()

    def test_agent_watch_rejects_empty_targets_before_the_host_request(self) -> None:
        host_request = AsyncMock(return_value={})
        with patch.object(rlm, "host_request", host_request):
            with self.assertRaises(ValueError):
                asyncio.run(rlm.rlm.watch.agent("   "))
        host_request.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
