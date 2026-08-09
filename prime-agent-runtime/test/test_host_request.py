from __future__ import annotations

import asyncio
import importlib
import os
import unittest
from unittest.mock import patch


rlm_module = importlib.import_module("rlm")


class FakeComm:
    instances: list["FakeComm"] = []

    def __init__(self, *, target_name: str, primary: bool) -> None:
        self.target_name = target_name
        self.primary = primary
        self.callback = None
        self.last_callback = None
        self.open_data: dict[str, object] | None = None
        self.closed = False
        self.__class__.instances.append(self)

    def on_msg(self, callback) -> None:
        self.callback = callback
        if callback is not None:
            self.last_callback = callback

    def open(self, *, data: dict[str, object]) -> None:
        self.open_data = data

    def close(self) -> None:
        self.closed = True

    def deliver(self, data: dict[str, object]) -> None:
        if self.callback is not None:
            self.callback({"content": {"data": data}})


class HostRequestTest(unittest.TestCase):
    def setUp(self) -> None:
        FakeComm.instances.clear()

    def test_round_trips_a_normal_reply_and_closes_the_comm(self) -> None:
        async def run() -> dict[str, object]:
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                request = asyncio.create_task(
                    rlm_module.host_request("goal.get", timeout_ms=100)
                )
                await asyncio.sleep(0)
                FakeComm.instances[0].deliver(
                    {"status": "ok", "goal": {"status": "active"}}
                )
                return await request

        self.assertEqual(asyncio.run(run()), {"goal": {"status": "active"}})
        comm = FakeComm.instances[0]
        self.assertEqual(
            comm.open_data,
            {
                "_prime_agent_timeout_ms": 100,
                "_prime_agent_execution_owned": True,
                "type": "goal.get",
            },
        )
        self.assertTrue(comm.closed)
        self.assertIsNone(comm.callback)

    def test_times_out_a_lost_host_request_and_closes_the_comm(self) -> None:
        async def run() -> None:
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                with self.assertRaisesRegex(
                    TimeoutError,
                    'host request "goal.complete" timed out after 10ms',
                ):
                    await rlm_module.host_request("goal.complete", timeout_ms=10)

        asyncio.run(run())
        self.assertEqual(len(FakeComm.instances), 1)
        self.assertTrue(FakeComm.instances[0].closed)
        self.assertIsNone(FakeComm.instances[0].callback)

    def test_maps_a_host_deadline_reply_to_timeout_error(self) -> None:
        async def run() -> None:
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                request = asyncio.create_task(
                    rlm_module.host_request("rlm.run", timeout_ms=100)
                )
                await asyncio.sleep(0)
                FakeComm.instances[0].deliver(
                    {
                        "status": "error",
                        "error_type": "timeout",
                        "error": 'host request "rlm.run" timed out after 100ms',
                    }
                )
                with self.assertRaisesRegex(TimeoutError, "rlm.run"):
                    await request

        asyncio.run(run())
        self.assertTrue(FakeComm.instances[0].closed)

    def test_ignores_a_reply_that_arrives_after_timeout(self) -> None:
        loop_errors: list[dict[str, object]] = []

        async def run() -> None:
            loop = asyncio.get_running_loop()
            loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                with self.assertRaises(TimeoutError):
                    await rlm_module.host_request("goal.complete", timeout_ms=5)
                comm = FakeComm.instances[0]
                self.assertIsNone(comm.callback)
                assert comm.last_callback is not None
                comm.last_callback(
                    {"content": {"data": {"status": "ok", "goal": {"status": "complete"}}}}
                )
                await asyncio.sleep(0)

        asyncio.run(run())
        self.assertEqual(loop_errors, [])

    def test_cancellation_closes_the_comm_and_cancels_the_future(self) -> None:
        async def run() -> None:
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                request = asyncio.create_task(
                    rlm_module.host_request("agent_message.send", timeout_ms=100)
                )
                await asyncio.sleep(0)
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await request

        asyncio.run(run())
        comm = FakeComm.instances[0]
        self.assertTrue(comm.closed)
        self.assertIsNone(comm.callback)

    def test_marks_a_detached_task_as_not_execution_owned(self) -> None:
        async def run() -> None:
            owner_task = asyncio.current_task()
            with (
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
                patch.object(rlm_module, "_host_request_task_tracking_installed", True),
                patch.object(rlm_module, "_host_request_execution_task", owner_task),
            ):
                request = asyncio.create_task(
                    rlm_module.host_request("goal.get", timeout_ms=100)
                )
                await asyncio.sleep(0)
                self.assertFalse(
                    FakeComm.instances[0].open_data["_prime_agent_execution_owned"]
                )
                FakeComm.instances[0].deliver({"status": "ok"})
                await request

        asyncio.run(run())

    def test_validates_per_call_and_environment_timeout_bounds(self) -> None:
        invalid_call_values = (0, -1, 3_600_001, True, 1.5)
        for value in invalid_call_values:
            with self.subTest(timeout_ms=value):
                with self.assertRaises((TypeError, ValueError)):
                    asyncio.run(rlm_module.host_request("goal.get", timeout_ms=value))
        self.assertEqual(FakeComm.instances, [])

        for value in ("0", "3600001", "not-an-int"):
            with self.subTest(environment=value):
                with patch.dict(
                    os.environ,
                    {"PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS": value},
                ):
                    with self.assertRaises((TypeError, ValueError)):
                        asyncio.run(rlm_module.host_request("goal.get"))
        self.assertEqual(FakeComm.instances, [])

    def test_accepts_the_inclusive_timeout_boundaries(self) -> None:
        self.assertEqual(rlm_module._resolve_host_request_timeout_ms(1), 1)
        self.assertEqual(
            rlm_module._resolve_host_request_timeout_ms(3_600_000),
            3_600_000,
        )

    def test_reads_the_timeout_from_the_environment(self) -> None:
        async def run() -> None:
            with (
                patch.dict(
                    os.environ,
                    {"PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS": "25"},
                ),
                patch.object(rlm_module, "Comm", FakeComm),
                patch.object(rlm_module, "_install_control_comm_handlers"),
            ):
                request = asyncio.create_task(rlm_module.host_request("goal.get"))
                await asyncio.sleep(0)
                FakeComm.instances[0].deliver({"status": "ok"})
                await request

        asyncio.run(run())
        self.assertEqual(
            FakeComm.instances[0].open_data,
            {
                "_prime_agent_timeout_ms": 25,
                "_prime_agent_execution_owned": True,
                "type": "goal.get",
            },
        )


if __name__ == "__main__":
    unittest.main()
