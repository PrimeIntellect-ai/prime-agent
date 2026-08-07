"""Cooperative cell execution in the current IPython shell."""

from __future__ import annotations

import asyncio
import contextvars
import os
import signal
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from subprocess import CalledProcessError
from typing import Any, AsyncIterable, Awaitable, Callable, TextIO

from IPython import get_ipython
from IPython.core.interactiveshell import InteractiveShell


class _ActDone(BaseException):
    """Stops the current cell after ``done`` records its in-kernel value."""


class _ActInterrupted(Exception):
    """The active inner cell was interrupted before Act completion."""


@dataclass(frozen=True)
class _ActCellResult:
    duration_ms: float
    stdout: str
    stderr: str
    result: str | None
    error: str | None


class _ActOutput:
    def __init__(self, target: TextIO) -> None:
        self._target = target
        self._parts: list[str] = []

    def write(self, text: str) -> int:
        self._parts.append(text)
        self._target.write(text)
        return len(text)

    def flush(self) -> None:
        self._target.flush()

    @property
    def value(self) -> str:
        return "".join(self._parts)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)


class _ActState:
    def __init__(self) -> None:
        self.value: Any = None
        self.completed = False
        self.interrupted = False
        self.processes: set[asyncio.subprocess.Process] = set()
        self.cell_task: asyncio.Task[object] | None = None


_active_state: contextvars.ContextVar[_ActState | None] = contextvars.ContextVar(
    "prime_agent_act_state", default=None
)


def _terminate_process_groups(processes: set[asyncio.subprocess.Process]) -> None:
    for process in processes:
        for stop_signal in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, stop_signal)
            except ProcessLookupError:
                break


def _track_act_subprocesses(
    state: _ActState,
    create: Callable[..., Awaitable[asyncio.subprocess.Process]],
) -> Callable[..., Awaitable[asyncio.subprocess.Process]]:
    async def tracked(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
        active = _active_state.get() is state
        if (
            active
            and "start_new_session" not in kwargs
            and "process_group" not in kwargs
        ):
            kwargs["start_new_session"] = True
        supervised = active and (
            kwargs.get("start_new_session") is True or kwargs.get("process_group") == 0
        )
        process = await create(*args, **kwargs)
        if supervised:
            state.processes.add(process)
        return process

    return tracked


def done(value: Any) -> None:
    """Record an exact in-kernel value and stop the current cell."""
    state = _active_state.get()
    if state is None or asyncio.current_task() is not state.cell_task:
        raise RuntimeError("rlm.done() is only valid in the active Act cell")
    if state.completed:
        raise RuntimeError("rlm.done() was already called")
    state.value = value
    state.completed = True
    raise _ActDone


async def _run_cells(
    cells: AsyncIterable[str],
    shell: InteractiveShell | None = None,
    cancel: Awaitable[object] | None = None,
    on_cell_result: Callable[[_ActCellResult], Awaitable[None]] | None = None,
    on_done: Callable[[], Awaitable[None]] | None = None,
) -> Any:
    """Run serialized inner cells and return the exact value passed to ``done``."""
    if shell is None:
        shell = get_ipython()
    if shell is None:
        raise RuntimeError("shared Act cells require an active IPython shell")

    state = _ActState()
    token = _active_state.set(state)
    previous_custom_exceptions = shell.custom_exceptions
    previous_custom_tb = shell.CustomTB

    def handle_act_control(
        _shell: InteractiveShell,
        exception_type: type[BaseException],
        value: BaseException,
        traceback: Any,
        tb_offset: int | None = None,
    ) -> Any:
        if isinstance(value, (_ActDone, asyncio.CancelledError, KeyboardInterrupt)) or (
            state.interrupted and isinstance(value, CalledProcessError)
        ):
            return []
        return previous_custom_tb(
            exception_type,
            value,
            traceback,
            tb_offset=tb_offset,
        )

    cancel_task: asyncio.Future[object] | None = None
    try:
        shell.set_custom_exc(
            previous_custom_exceptions
            + (_ActDone, asyncio.CancelledError, KeyboardInterrupt, CalledProcessError),
            handle_act_control,
        )
        cancel_task = asyncio.ensure_future(cancel) if cancel is not None else None
        cell_iterator = cells.__aiter__()
        while True:
            request_task = asyncio.ensure_future(anext(cell_iterator))
            cancel_arrived = False
            try:
                if cancel_task is not None:
                    completed, _ = await asyncio.wait(
                        (request_task, cancel_task),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if cancel_task in completed:
                        cancel_task.result()
                        cancel_arrived = True
                        request_task.cancel()
                try:
                    cell = await request_task
                except StopAsyncIteration:
                    if cancel_arrived:
                        raise _ActInterrupted
                    break
                if cancel_arrived:
                    raise _ActInterrupted
            finally:
                if not request_task.done():
                    request_task.cancel()
                    await asyncio.gather(request_task, return_exceptions=True)

            transformed = shell.transform_cell(cell)
            started_at = time.monotonic()
            stdout = _ActOutput(sys.stdout)
            stderr = _ActOutput(sys.stderr)
            result = None
            cell_task: asyncio.Task[Any] | None = None
            cell_cancelled = False
            previous_sigint: Any = None
            previous_create_subprocess_exec: Any = None
            state.processes.clear()

            def interrupt_act_cell(_signum: int, _frame: Any) -> None:
                state.interrupted = True
                raise KeyboardInterrupt

            state.interrupted = False
            if os.name == "posix":
                previous_sigint = signal.getsignal(signal.SIGINT)
                signal.signal(signal.SIGINT, interrupt_act_cell)
                previous_create_subprocess_exec = asyncio.create_subprocess_exec
                asyncio.create_subprocess_exec = _track_act_subprocesses(
                    state, previous_create_subprocess_exec
                )
            try:
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    cell_task = asyncio.create_task(
                        shell.run_cell_async(
                            cell,
                            store_history=False,
                            transformed_cell=transformed,
                        )
                    )
                    state.cell_task = cell_task
                    if cancel_task is not None:
                        completed, _ = await asyncio.wait(
                            (cell_task, cancel_task),
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if cancel_task in completed:
                            cancel_task.result()
                            cell_cancelled = True
                            cell_task.cancel()
                    result = await cell_task
            finally:
                if os.name == "posix":
                    signal.signal(signal.SIGINT, previous_sigint)
                    asyncio.create_subprocess_exec = previous_create_subprocess_exec
                if cell_task is not None and not cell_task.done():
                    cell_cancelled = True
                    cell_task.cancel()
                    await asyncio.gather(cell_task, return_exceptions=True)
                if os.name == "posix" and (state.interrupted or cell_cancelled):
                    _terminate_process_groups(state.processes)
                if state.cell_task is cell_task:
                    state.cell_task = None
                shell.events.trigger("post_execute")
                shell.events.trigger("post_run_cell", result)
            if result is None:
                raise RuntimeError(
                    "inner IPython cell did not return an execution result"
                )
            if isinstance(result.error_in_exec, _ActDone):
                if on_done is not None:
                    await on_done()
                return state.value
            if state.interrupted or isinstance(
                result.error_in_exec, (asyncio.CancelledError, KeyboardInterrupt)
            ):
                raise _ActInterrupted from result.error_in_exec
            if on_cell_result is not None:
                try:
                    result_text = (
                        repr(result.result) if result.result is not None else None
                    )
                except Exception as error:
                    result_text = f"<{type(error).__name__} while formatting result>"
                error = result.error_before_exec or result.error_in_exec
                error_text = (
                    f"{type(error).__name__}: {error}" if error is not None else None
                )
                await on_cell_result(
                    _ActCellResult(
                        duration_ms=(time.monotonic() - started_at) * 1000,
                        stdout=stdout.value[:65536],
                        stderr=stderr.value[:65536],
                        result=result_text[:65536] if result_text is not None else None,
                        error=error_text[:65536] if error_text is not None else None,
                    )
                )
        raise RuntimeError("Act ended without calling rlm.done()")
    except asyncio.CancelledError as exc:
        raise _ActInterrupted from exc
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()
            await asyncio.gather(cancel_task, return_exceptions=True)
        shell.custom_exceptions = previous_custom_exceptions
        shell.CustomTB = previous_custom_tb
        _active_state.reset(token)
