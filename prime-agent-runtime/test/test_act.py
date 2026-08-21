from __future__ import annotations

import asyncio
import os
import signal
import unittest
from collections.abc import AsyncIterator
from types import TracebackType
from unittest.mock import patch

from IPython.core.interactiveshell import InteractiveShell

import rlm
from rlm._act import _ActInterrupted, _run_cells, done


async def cells(*sources: str) -> AsyncIterator[str]:
    for source in sources:
        yield source


class FakeActComm:
    next_message: dict[str, object] | None = None
    instances: list["FakeActComm"] = []

    def __init__(self, *, target_name: str, primary: bool) -> None:
        self.target_name = target_name
        self.primary = primary
        self.message_callback = None
        self.close_callback = None
        self.opened = None
        self.sent: list[dict[str, object]] = []
        self.closed = False
        self.instances.append(self)

    def on_msg(self, callback) -> None:
        self.message_callback = callback

    def on_close(self, callback) -> None:
        self.close_callback = callback

    def open(self, *, data) -> None:
        self.opened = data
        loop = asyncio.get_running_loop()
        if self.next_message is None:
            loop.call_soon(self.close_callback, {})
        else:
            loop.call_soon(
                self.message_callback,
                {"content": {"data": self.next_message}},
            )

    def send(self, *, data) -> None:
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class ActApiTest(unittest.IsolatedAsyncioTestCase):
    async def consume_first_event(self, requested_cells, *, cancel, **_kwargs):
        try:
            return await anext(requested_cells)
        finally:
            cancel.close()

    async def wait_for_cancel(self, _requested_cells, *, cancel, **_kwargs):
        await cancel
        raise _ActInterrupted

    async def test_validates_prompt_before_opening_a_comm(self) -> None:
        with self.assertRaisesRegex(TypeError, "prompt must be str"):
            await rlm.act(1)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "prompt must not be empty"):
            await rlm.act("  ")
        with self.assertRaisesRegex(TypeError, "model must be str or None"):
            await rlm.act("task", model=1)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "model must not be empty"):
            await rlm.rlm.act("task", model="  ")

    async def test_explicit_model_is_trimmed_and_sent_to_the_host(self) -> None:
        FakeActComm.instances.clear()
        FakeActComm.next_message = None
        with (
            patch.object(rlm, "Comm", FakeActComm),
            patch.object(rlm, "_install_control_comm_handlers"),
            patch.object(rlm, "_run_cells", self.wait_for_cancel),
        ):
            with self.assertRaises(rlm.ActCancelledError):
                await rlm.act("select the lane", model="  @deepseek  ")

        self.assertEqual(
            FakeActComm.instances[0].opened,
            {"type": "rlm.act", "prompt": "select the lane", "model": "@deepseek"},
        )

    async def test_host_comm_close_is_typed_cancellation_and_closes_locally(
        self,
    ) -> None:
        FakeActComm.instances.clear()
        FakeActComm.next_message = None
        with (
            patch.object(rlm, "Comm", FakeActComm),
            patch.object(rlm, "_install_control_comm_handlers"),
            patch.object(rlm, "_run_cells", self.wait_for_cancel),
        ):
            with self.assertRaisesRegex(rlm.ActCancelledError, "Act was cancelled"):
                await rlm.act("wait for the lane")

        comm = FakeActComm.instances[0]
        self.assertEqual(
            comm.opened, {"type": "rlm.act", "prompt": "wait for the lane"}
        )
        self.assertTrue(comm.closed)

    async def test_host_cancelled_outcome_is_typed_cancellation(self) -> None:
        FakeActComm.instances.clear()
        FakeActComm.next_message = {"status": "ok", "outcome": "cancelled"}
        with (
            patch.object(rlm, "Comm", FakeActComm),
            patch.object(rlm, "_install_control_comm_handlers"),
            patch.object(rlm, "_run_cells", self.wait_for_cancel),
        ):
            with self.assertRaisesRegex(rlm.ActCancelledError, "Act was cancelled"):
                await rlm.act("cancel from the host")

        self.assertTrue(FakeActComm.instances[0].closed)

    async def test_protocol_error_is_typed_and_closes_the_comm(self) -> None:
        FakeActComm.instances.clear()
        FakeActComm.next_message = {"status": "event", "type": "unexpected"}
        with (
            patch.object(rlm, "Comm", FakeActComm),
            patch.object(rlm, "_install_control_comm_handlers"),
            patch.object(rlm, "_run_cells", self.consume_first_event),
        ):
            with self.assertRaisesRegex(rlm.ActError, "unexpected message"):
                await rlm.act("receive malformed protocol")

        self.assertTrue(FakeActComm.instances[0].closed)

    async def test_publishes_the_host_platform_cancellation_capability(self) -> None:
        expected = "posix-managed" if os.name == "posix" else "cooperative-only"
        self.assertEqual(rlm.ACT_CANCELLATION_CAPABILITY, expected)
        self.assertEqual(rlm.rlm.ACT_CANCELLATION_CAPABILITY, expected)
        self.assertIn("ACT_CANCELLATION_CAPABILITY", rlm.act.__doc__ or "")
        if expected == "cooperative-only":
            self.assertIn("does not promise to stop synchronous Python", rlm.act.__doc__ or "")


class ActCellRunnerTest(unittest.IsolatedAsyncioTestCase):
    def new_shell(self) -> InteractiveShell:
        shell = InteractiveShell()
        shell.user_ns["done"] = done
        return shell

    async def test_returns_exact_object_and_stops_terminal_cell(self) -> None:
        shell = self.new_shell()
        previous_exceptions = shell.custom_exceptions
        previous_tb = shell.CustomTB
        lifecycle: list[str] = []
        shell.events.register("pre_run_cell", lambda _info: lifecycle.append("pre"))
        shell.events.register("post_run_cell", lambda _result: lifecycle.append("post"))

        returned = await _run_cells(
            cells(
                "original = object()",
                "done(original)\nafter_done = True",
            ),
            shell,
        )

        self.assertIs(returned, shell.user_ns["original"])
        self.assertNotIn("after_done", shell.user_ns)
        self.assertEqual(lifecycle, ["pre", "post", "pre", "post"])
        self.assertEqual(shell.custom_exceptions, previous_exceptions)
        self.assertIs(shell.CustomTB, previous_tb)

    async def test_nested_done_returns_exact_identity_and_restores_the_calling_cell(self) -> None:
        shell = self.new_shell()
        nested_source = object()
        shell.user_ns["nested_source"] = nested_source

        async def nested_act() -> object:
            return await _run_cells(cells("done(nested_source)"), shell)

        shell.user_ns["nested_act"] = nested_act
        outer_source = object()
        shell.user_ns["outer_source"] = outer_source
        returned = await _run_cells(
            cells(
                "nested_result = await nested_act()\nnested_identity = nested_result is nested_source\ncontinued_after_nested = True",
                "done(outer_source)",
            ),
            shell,
        )

        self.assertIs(shell.user_ns["nested_result"], nested_source)
        self.assertIs(shell.user_ns["nested_identity"], True)
        self.assertIs(shell.user_ns["continued_after_nested"], True)
        self.assertIs(returned, outer_source)

    async def test_reports_live_streams_and_result_before_the_next_cell(self) -> None:
        shell = self.new_shell()
        results: list[object] = []
        terminal = asyncio.Event()

        async def record(result: object) -> None:
            results.append(result)

        async def acknowledge_done() -> None:
            terminal.set()

        returned = await _run_cells(
            cells("print('hello')\n6 * 7", "done('finished')"),
            shell,
            on_cell_result=record,
            on_done=acknowledge_done,
        )

        self.assertEqual(returned, "finished")
        self.assertTrue(terminal.is_set())
        self.assertEqual(len(results), 1)
        self.assertIn("hello\n", getattr(results[0], "stdout"))
        self.assertEqual(getattr(results[0], "result"), "42")
        self.assertGreaterEqual(getattr(results[0], "duration_ms"), 0)
        self.assertIsNone(getattr(results[0], "error"))

    async def test_none_is_a_valid_exact_result(self) -> None:
        shell = self.new_shell()

        returned = await _run_cells(cells("done(None)"), shell)

        self.assertIsNone(returned)

    async def test_cancellation_stops_waiting_for_the_next_cell(self) -> None:
        shell = self.new_shell()
        waiting = asyncio.Event()
        cancelled = asyncio.Event()
        never = asyncio.Event()

        async def waiting_cells() -> AsyncIterator[str]:
            yield "first_cell_completed = True"
            waiting.set()
            await never.wait()
            yield "done('too-late')"

        async def wait_for_cancel() -> object:
            await cancelled.wait()
            return None

        task = asyncio.create_task(
            _run_cells(waiting_cells(), shell, cancel=wait_for_cancel())
        )
        await waiting.wait()
        cancelled.set()

        with self.assertRaises(_ActInterrupted):
            await task
        self.assertIs(shell.user_ns["first_cell_completed"], True)

    async def test_exhaustion_requires_done_and_restores_shell(self) -> None:
        shell = self.new_shell()
        previous_exceptions = shell.custom_exceptions
        previous_tb = shell.CustomTB

        with self.assertRaisesRegex(RuntimeError, "ended without calling rlm.done"):
            await _run_cells(cells("ordinary_value = 1"), shell)

        self.assertEqual(shell.custom_exceptions, previous_exceptions)
        self.assertIs(shell.CustomTB, previous_tb)
        with self.assertRaisesRegex(RuntimeError, "only valid in the active Act cell"):
            done(None)

    async def test_preserves_existing_custom_exception_handler(self) -> None:
        shell = self.new_shell()
        handled: list[type[BaseException]] = []

        class CustomError(Exception):
            pass

        def handle_custom(
            _shell: InteractiveShell,
            exception_type: type[BaseException],
            _value: BaseException,
            _traceback: TracebackType | None,
            **_kwargs: object,
        ) -> list[str]:
            handled.append(exception_type)
            return []

        shell.user_ns["CustomError"] = CustomError
        shell.set_custom_exc((CustomError,), handle_custom)
        previous_tb = shell.CustomTB

        returned = await _run_cells(
            cells("raise CustomError('expected')", "done('recovered')"),
            shell,
        )

        self.assertEqual(returned, "recovered")
        self.assertEqual(handled, [CustomError])
        self.assertIs(shell.CustomTB, previous_tb)

    async def test_rejects_done_from_a_detached_inner_task(self) -> None:
        shell = self.new_shell()

        returned = await _run_cells(
            cells(
                """import asyncio
gate = asyncio.Event()
async def late_done():
    await gate.wait()
    done('detached')
late_task = asyncio.create_task(late_done())""",
                """gate.set()
try:
    await late_task
except RuntimeError:
    detached_done_rejected = True
done('active-cell')""",
            ),
            shell,
        )

        self.assertEqual(returned, "active-cell")
        self.assertIs(shell.user_ns["detached_done_rejected"], True)

    async def test_rejects_duplicate_done_after_a_caught_terminal_signal(self) -> None:
        shell = self.new_shell()

        with self.assertRaisesRegex(RuntimeError, "ended without calling rlm.done"):
            await _run_cells(
                cells(
                    """try:
    done('first')
except BaseException:
    try:
        done('second')
    except RuntimeError:
        duplicate_done_rejected = True"""
                ),
                shell,
            )

        self.assertIs(shell.user_ns["duplicate_done_rejected"], True)

    async def test_task_cancellation_interrupts_act_and_restores_shell(self) -> None:
        shell = self.new_shell()
        previous_exceptions = shell.custom_exceptions
        previous_tb = shell.CustomTB
        started = asyncio.Event()

        async def blocking_cells() -> AsyncIterator[str]:
            started.set()
            yield "import asyncio\nawait asyncio.sleep(60)"

        task = asyncio.create_task(_run_cells(blocking_cells(), shell))
        await started.wait()
        await asyncio.sleep(0)
        task.cancel()

        with self.assertRaises(_ActInterrupted):
            await task
        self.assertEqual(shell.custom_exceptions, previous_exceptions)
        self.assertIs(shell.CustomTB, previous_tb)

    @unittest.skipUnless(os.name == "posix", "Act shell interruption is POSIX-only")
    async def test_sigint_interrupts_only_the_active_cell_and_restores_hooks(
        self,
    ) -> None:
        shell = self.new_shell()
        previous_sigint = signal.getsignal(signal.SIGINT)
        previous_create_subprocess_exec = asyncio.create_subprocess_exec

        with self.assertRaises(_ActInterrupted):
            await _run_cells(
                cells("import os, signal\nos.kill(os.getpid(), signal.SIGINT)"),
                shell,
            )

        self.assertIs(signal.getsignal(signal.SIGINT), previous_sigint)
        self.assertIs(asyncio.create_subprocess_exec, previous_create_subprocess_exec)
        returned = await _run_cells(cells("done('root-reused')"), shell)
        self.assertEqual(returned, "root-reused")


if __name__ == "__main__":
    unittest.main()
