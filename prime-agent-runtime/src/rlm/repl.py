"""Minimal CPython REPL runtime speaking newline-delimited JSON over stdio.

Entry point: ``python -m rlm.repl``. The protocol is documented in repl.md
next to this file. Cells execute with top-level await in one persistent
``__main__`` namespace on a single asyncio event loop.
"""

from __future__ import annotations

import ast
import asyncio
import codecs
import contextvars
import ctypes
import inspect
import io
import itertools
import json
import linecache
import os
import platform
import signal
import sys
import tempfile
import threading
import time
import traceback
import types
import uuid
from collections.abc import Awaitable, Callable, Generator
from typing import Any

from . import autobg
from .bash import _kill_live_handles, active_guard_race_deadline

PROTOCOL_VERSION = 3

DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024

# Plain ASCII, never a pickle start: _restore_state sniffs it to tell v2 framed
# payloads from legacy (single dill-pickled dict) ones.
_SNAPSHOT_MAGIC = b"PRIME-AGENT-KERNEL-SNAPSHOT-V2\n"

# Stream writes must fit one protocol frame: the host buffers whole lines
# before its per-execution truncation, and raw fd writes already arrive as
# 64 KiB pump chunks.
_STREAM_FRAME_TEXT_CAP = 64 * 1024
# The host truncates results at a smaller per-execution maxChars, so this only
# bounds a pathological repr or exception text in transit.
_RESULT_TEXT_CAP = 1_048_576
_RESULT_TRUNCATION_MARKER = f"\n[... result truncated at {_RESULT_TEXT_CAP} characters ...]"
# Oversized display and host_request payloads fail the cell instead of wedging host memory.
_PAYLOAD_CAP = 16 * 1024 * 1024

# Names the session bootstrap re-creates on every start; never snapshotted.
_ALWAYS_SKIP = {"rlm", "mcp", "bash", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
# IPython-injected names that may appear in a snapshot payload; never restored.
_RESTORE_SKIP = {"In", "Out", "get_ipython"}
# The target of the last successful snapshot, remembered so an EOF shutdown
# (the host process died without a graceful dispose) can flush the final
# namespace before exit. `None` until this process has committed a snapshot:
# an EOF before that must not overwrite the on-disk payload with a namespace
# the host never considered durable.
_last_snapshot_target: dict[str, Any] | None = None

_protocol_fd: int = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_serve_task: asyncio.Task[Any] | None = None


class _CellExecution:
    def __init__(self) -> None:
        self.finished = asyncio.Event()
        self.owner: asyncio.Task[Any] | None = None


# Per-cell bounded tails of Python-level writes, armed only while the auto-bg
# guard is on: a degraded execution's result note previews the output so far.
_AUTOBG_TAIL_CAP = 4096
_AUTOBG_NOTE_PREVIEW_CAP = 2048
_bg_counter = itertools.count(1)
_autobg_tails: dict[str, "_TailBuffer"] = {}


def _pop_tail(cell_id: str, tail: "_TailBuffer | None") -> None:
    """Drop this execution's tail entry: request ids are reusable, so a bare
    keyed pop could delete a later execution's buffer - only the entry that IS
    this execution's buffer is removed."""
    if tail is not None and _autobg_tails.get(cell_id) is tail:
        _autobg_tails.pop(cell_id, None)


class _TailBuffer:
    """Bounded newest-last text tail for one running cell's Python-level writes."""

    def __init__(self, cap: int = _AUTOBG_TAIL_CAP) -> None:
        self._cap = cap
        self._text = ""
        self._lock = threading.Lock()

    def append(self, text: str) -> None:
        with self._lock:
            self._text = (self._text + text)[-self._cap :]

    def text(self, max_chars: int | None = None) -> str:
        with self._lock:
            text = self._text
        return text if max_chars is None else text[-max_chars:]


class _SyncCellRunner:
    """Runs a sync-only cell's codes in a worker thread over the shared namespace.

    The serving loop stays free (a CPU-bound cell would otherwise hold the whole
    runtime hostage and the auto-bg guard could never fire). Python-level
    writes keep their cell attribution through the copied context, and the
    kernel loop stays this thread's default loop so asyncio.get_event_loop()
    in a cell resolves it exactly like a loop-thread cell did.
    """

    def __init__(
        self, codes: list[types.CodeType], ns: dict[str, Any], cell_id: str, tail: "_TailBuffer | None"
    ) -> None:
        self._codes = codes
        self._ns = ns
        self._cell_id = cell_id
        self._tail = tail
        self._done = threading.Event()
        self._cb_lock = threading.Lock()
        self._cb: Callable[[], None] | None = None
        self._value: Any = None
        self._exc: BaseException | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        # The copied context carries the cell's id and execution state, so
        # stdout attribution and bash handles keep their creating-cell ties.
        context = contextvars.copy_context()
        self.thread = threading.Thread(
            target=context.run, args=(self._run,), name=f"rlm-cell-{self._cell_id}", daemon=True
        )
        self.thread.start()

    def _run(self) -> None:
        # The kernel loop is this thread's default loop: asyncio.get_event_loop()
        # in the cell resolves it exactly like a loop-thread cell did, and the
        # compat shims route create_task/get_running_loop/signal for this cell.
        asyncio.set_event_loop(_loop)
        _sync_cell_worker.in_cell = True
        try:
            value: Any = None
            for code_obj in self._codes:
                value = eval(code_obj, self._ns)  # noqa: S307 - executing the model's cell is the runtime's job
            self._value = value
        except BaseException as exc:  # noqa: BLE001 - surfaces inline or at poll, never silently dropped
            self._exc = exc
        finally:
            with self._cb_lock:
                self._done.set()
                callback, self._cb = self._cb, None
            _sync_cell_worker.in_cell = False
            _pop_tail(self._cell_id, self._tail)
            if callback is not None:
                callback()

    def on_done(self, callback: Callable[[], None]) -> None:
        """Register the completion callback; fires inline when already done."""
        fire = False
        with self._cb_lock:
            if self._done.is_set():
                fire = True
            else:
                self._cb = callback
        if fire:
            callback()

    def done(self) -> bool:
        return self._done.is_set()

    def outcome(self) -> Any:
        """The cell's value; raises its exception (inline or at poll)."""
        if self._exc is not None:
            raise self._exc
        return self._value

    def request_stop(self) -> None:
        """Best-effort KeyboardInterrupt into the worker: Python-level code
        stops at its next bytecode; a C-blocked call runs to its return."""
        thread = self.thread
        if thread is None or not thread.is_alive() or thread.ident is None:
            return
        try:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_long(thread.ident), ctypes.py_object(KeyboardInterrupt)
            )
        except (OSError, SystemError, ValueError):
            pass


class _KernelFuture:
    """Handle to a cell execution that outlived the auto-bg threshold.

    The execution keeps running (the worker thread for sync cells, the serving
    loop's task for async ones) and shares the kernel namespace: poll the
    handle before relying on shared state. Exceptions surface at poll(),
    never silently.
    """

    def __init__(
        self,
        name: str,
        started: float,
        runner: _SyncCellRunner | None = None,
        task: asyncio.Task[Any] | None = None,
        tail: "_TailBuffer | None" = None,
    ) -> None:
        self.name = name
        self.started = started
        self._runner = runner
        self._task = task
        self._tail = tail

    def done(self) -> bool:
        """True once the execution finished (with a value or an exception)."""
        if self._runner is not None:
            return self._runner.done()
        assert self._task is not None
        return self._task.done()

    @property
    def running(self) -> bool:
        return not self.done()

    def poll(self) -> Any:
        """The execution's value once done (None while running); raises its
        exception when it failed - failures are never silent."""
        if not self.done():
            return None
        if self._runner is not None:
            return self._runner.outcome()
        assert self._task is not None
        return self._task.result()

    def exception(self) -> BaseException | None:
        if not self.done():
            return None
        if self._runner is not None:
            return self._runner._exc
        assert self._task is not None
        if self._task.cancelled():
            return asyncio.CancelledError()
        return self._task.exception()

    def cancel(self) -> bool:
        """Stop the execution: cancels the loop task, or requests the worker's
        best-effort KeyboardInterrupt (a C-blocked call runs to its return)."""
        if self.done():
            return False
        if self._runner is not None:
            self._runner.request_stop()
            return True
        assert self._task is not None
        # Task.cancel from a foreign thread races the serving loop (and raises
        # in asyncio debug mode): marshal the cancellation onto the loop.
        self._task.get_loop().call_soon_threadsafe(self._task.cancel)
        return True

    def stdout_tail(self, max_chars: int = _AUTOBG_NOTE_PREVIEW_CAP) -> str:
        """The execution's Python-level writes so far, newest last (raw fd
        output keeps flowing as stream events)."""
        if self._tail is None:
            return ""
        return self._tail.text(max_chars)

    async def _wait(self) -> Any:
        while not self.done():
            await asyncio.sleep(0.05)
        return self.poll()

    def __await__(self) -> Generator[Any, Any, Any]:
        return self._wait().__await__()

    def __repr__(self) -> str:
        state = "running" if self.running else ("error" if self.exception() is not None else "done")
        return f"<KernelFuture {self.name} {state} ({time.monotonic() - self.started:.1f}s)>"


# The sync-cell worker thread flag: the compat shims below route only calls
# made from inside a sync cell's worker thread.
_sync_cell_worker = threading.local()

_orig_create_task = asyncio.create_task
# The serving loop's original bound create_task, captured when the loop-level
# worker bridge installs (main() owns the loop's lifetime).
_orig_loop_create_task: Any = None
_orig_get_running_loop = asyncio.get_running_loop
_orig_signal_signal = signal.signal

# The compat bridge's bound on waiting for the serving loop: a sync cell leaves
# the loop free, so a healthy kernel answers instantly; a wedged loop fails the
# cell loudly instead of hanging the worker forever.
_COMPAT_BRIDGE_TIMEOUT = 5.0


def _worker_in_cell() -> bool:
    return getattr(_sync_cell_worker, "in_cell", False)


def _bridge_to_loop(spawn: Callable[[], None]) -> None:
    """Run `spawn` on the serving loop and wait for it (the loop is free while
    a sync cell holds its worker thread)."""
    done = threading.Event()

    def run() -> None:
        try:
            spawn()
        finally:
            done.set()

    _loop.call_soon_threadsafe(run)
    if not done.wait(_COMPAT_BRIDGE_TIMEOUT):
        raise RuntimeError(
            f"compat bridge: the kernel loop did not run within {_COMPAT_BRIDGE_TIMEOUT}s"
        )


def _create_task_from_worker(coro: Any, *, name: Any = None, context: Any = None, **kwargs: Any) -> Any:
    box: dict[str, Any] = {}

    def spawn() -> None:
        try:
            box["task"] = _orig_loop_create_task(coro, name=name, context=context, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - surfaced to the caller below
            box["exc"] = exc

    _bridge_to_loop(spawn)
    if "exc" in box:
        raise box["exc"]
    return box["task"]


def _signal_from_worker(sig: Any, handler: Any) -> Any:
    box: dict[str, Any] = {}

    def spawn() -> None:
        try:
            box["previous"] = _orig_signal_signal(sig, handler)
        except BaseException as exc:  # noqa: BLE001 - surfaced to the caller below
            box["exc"] = exc

    _bridge_to_loop(spawn)
    if "exc" in box:
        raise box["exc"]
    return box["previous"]


def _install_loop_create_task_compat() -> None:
    """Make the serving loop's create_task safe from sync-cell worker threads.

    A worker cell reaches the serving loop through the get_event_loop/
    get_running_loop shims and can call loop.create_task directly (bash
    completion notices, spawned tasks): from a foreign thread that call is
    not thread-safe (asyncio debug mode raises; without the debug check the
    queued task never wakes the loop, so an idle kernel would miss bash
    notices). The wrapper keeps the original on the loop's own thread and
    bridges every other caller, preserving the cell's context.
    """
    global _orig_loop_create_task
    assert _loop is not None
    _orig_loop_create_task = _loop.create_task

    def create_task(coro: Any, *, name: Any = None, context: Any = None, **kwargs: Any) -> Any:
        if not _worker_in_cell():
            return _orig_loop_create_task(coro, name=name, context=context, **kwargs)
        if context is None:
            context = contextvars.copy_context()
        box: dict[str, Any] = {}

        def spawn() -> None:
            try:
                box["task"] = _orig_loop_create_task(coro, name=name, context=context, **kwargs)
            except BaseException as exc:  # noqa: BLE001 - surfaced to the caller below
                box["exc"] = exc

        _bridge_to_loop(spawn)
        if "exc" in box:
            raise box["exc"]
        return box["task"]

    _loop.create_task = create_task  # type: ignore[method-assign]
    _install_loop_schedule_compat()


def _install_loop_schedule_compat() -> None:
    """Bridge the serving loop's plain scheduling entry points for workers.

    call_soon/call_later/call_at from a sync-cell worker thread are not
    thread-safe (debug mode raises; otherwise the wakeup is missing), so a
    worker's direct scheduling rides call_soon_threadsafe / the loop bridge;
    the loop's own thread keeps the originals. Timer handles round-trip so
    cell-held cancel() keeps working.
    """
    assert _loop is not None
    orig_call_soon = _loop.call_soon
    orig_call_later = _loop.call_later
    orig_call_at = _loop.call_at

    def call_soon(callback: Any, *args: Any, context: Any = None) -> Any:
        if not _worker_in_cell():
            return orig_call_soon(callback, *args, context=context)
        return _loop.call_soon_threadsafe(callback, *args, context=context)

    def call_later(delay: Any, callback: Any, *args: Any, context: Any = None) -> Any:
        if not _worker_in_cell():
            return orig_call_later(delay, callback, *args, context=context)
        box: dict[str, Any] = {}

        def spawn() -> None:
            box["handle"] = orig_call_later(delay, callback, *args, context=context)

        _bridge_to_loop(spawn)
        return box.get("handle")

    def call_at(when: Any, callback: Any, *args: Any, context: Any = None) -> Any:
        if not _worker_in_cell():
            return orig_call_at(when, callback, *args, context=context)
        box: dict[str, Any] = {}

        def spawn() -> None:
            box["handle"] = orig_call_at(when, callback, *args, context=context)

        _bridge_to_loop(spawn)
        return box.get("handle")

    _loop.call_soon = call_soon  # type: ignore[method-assign]
    _loop.call_later = call_later  # type: ignore[method-assign]
    _loop.call_at = call_at  # type: ignore[method-assign]


def _install_sync_cell_compat() -> None:
    """Keep loop-thread and main-thread APIs working from sync-cell workers.

    The auto-bg guard runs sync-only cells off the serving loop so the kernel
    stays responsive; the serving loop and the signal handlers still belong to
    the main thread. A cell expects `asyncio.create_task`,
    `asyncio.get_running_loop()`, and `signal.signal()` to behave like a
    loop-thread cell, so inside a sync cell those three marshal to the loop
    thread (create_task carries the cell's context, so spawned tasks keep
    their cell attribution and persist across cells on the serving loop).
    Every other caller gets the original function untouched.
    """

    def create_task(coro: Any, *, name: Any = None, context: Any = None, **kwargs: Any) -> Any:
        if not _worker_in_cell():
            return _orig_create_task(coro, name=name, context=context, **kwargs)
        if context is None:
            context = contextvars.copy_context()
        return _create_task_from_worker(coro, name=name, context=context, **kwargs)

    def get_running_loop() -> asyncio.AbstractEventLoop:
        if not _worker_in_cell():
            return _orig_get_running_loop()
        assert _loop is not None
        return _loop

    def signal_signal(sig: Any, handler: Any) -> Any:
        if not _worker_in_cell():
            return _orig_signal_signal(sig, handler)
        return _signal_from_worker(sig, handler)

    asyncio.create_task = create_task  # type: ignore[assignment]
    asyncio.get_running_loop = get_running_loop  # type: ignore[assignment]
    signal.signal = signal_signal  # type: ignore[assignment]


async def _await_sync_cell(runner: _SyncCellRunner) -> Any:
    """Bridge the worker thread's completion onto the serving loop."""
    # The thread starts on this task's first step, AFTER _run_guarded has
    # registered it as the active task: a fast cell's worker must never win
    # that race (result reads through _live_cell_owner would misattribute).
    runner.start()
    loop = asyncio.get_running_loop()
    finished: asyncio.Future[None] = loop.create_future()

    def _thread_done() -> None:
        loop.call_soon_threadsafe(lambda: finished.done() or finished.set_result(None))

    runner.on_done(_thread_done)
    try:
        await finished
    except asyncio.CancelledError:
        # An interrupt cannot kill a thread: request the best-effort stop,
        # report the interrupt, and let the thread's outcome land on the runner.
        runner.request_stop()
        raise
    return runner.outcome()


def _autobg_degrade_note(name: str, threshold: float, tail: _TailBuffer | None) -> str:
    lines = [
        f"python execution auto-backgrounded after {threshold:.1f}s "
        "(PRIME_AGENT_AUTOBG_MS); the execution is still running",
        "backgrounded execution shares the kernel namespace "
        "- poll the handle before relying on shared state",
        f"handle: {name}  (poll() -> the value or raises its exception; "
        "stdout_tail(); cancel(); await)",
    ]
    if tail is not None:
        preview = tail.text(_AUTOBG_NOTE_PREVIEW_CAP)
        if preview.strip():
            lines.append(f"partial stdout (last {_AUTOBG_NOTE_PREVIEW_CAP} chars):\n{preview}")
    return "\n".join(lines)


# Asyncio tasks copy cell context at creation, so detached tasks retain their
# output attribution and completion barrier. Threads start with a fresh context.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)
_current_cell_execution: contextvars.ContextVar[_CellExecution | None] = contextvars.ContextVar(
    "_current_cell_execution", default=None
)
_active: dict[str, Any] = {"task": None, "rid": None, "interrupted": False}
_cell_counter = 0
_pending_host: dict[str, "asyncio.Future[dict[str, Any]]"] = {}
# Set on the loop thread once stdin hits EOF or a shutdown request arrives; no
# host reply can arrive after that, so waiting (and future) host_request calls fail.
_host_closed = False

# Interrupt bookkeeping shared between the reader thread and the loop thread.
_interrupt_lock = threading.Lock()
_inflight: set[str] = set()
_pending_interrupts: dict[str, Any] = {"ids": set(), "any": False}
_sigint_target: str | None = None
_finishing_rid: str | None = None
_handoff_interrupted = False


def _send(event: dict[str, Any]) -> None:
    """Write one protocol frame; the locked single write keeps frames atomic."""
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view) :]
        except OSError:
            pass


def _check_payload(event: str, data: dict[str, Any]) -> None:
    """Fail the calling cell when a `data` payload would not fit one protocol frame.

    Strict-dumps validation: default allow_nan=True would let NaN/Infinity
    serialize as non-JSON text and tear the host's protocol framing (a
    non-serializable value raises TypeError here before any bytes are
    written, so NaN is the only corruption vector). The encoded length
    enforces the frame cap; _send re-serializes.
    """
    if len(json.dumps(data, allow_nan=False)) > _PAYLOAD_CAP:
        raise ValueError(f"{event} payload exceeds the {_PAYLOAD_CAP}-character frame cap")


def emit(data: dict[str, Any]) -> None:
    """Ship one display event carrying a dict of MIME type -> JSON payload.

    Thread-safe; the event is tagged with the cell running at call time.
    """
    if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
        raise TypeError("emit() requires a non-empty dict keyed by MIME type strings")
    _check_payload("display", data)
    _send({"event": "display", "id": _current_cell.get(), "data": data})


def is_active() -> bool:
    """True when this process serves the repl protocol (not merely imported)."""
    return _protocol_fd >= 0


def current_cell_completion_context() -> tuple[asyncio.Event, asyncio.Task[Any] | None] | None:
    """Return the calling cell's completion barrier and owning execution task."""
    execution = _current_cell_execution.get()
    if execution is None:
        return None
    return execution.finished, execution.owner


def active_cell_task() -> asyncio.Task[Any] | None:
    """The cell body task executing right now, or None between cells (global
    state, not the cell contextvar — detached tasks keep stale context copies)."""
    with _interrupt_lock:
        task = _active["task"]
    return task if isinstance(task, asyncio.Task) and not task.done() else None


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Send one typed request to the host and await its raw reply dict."""
    if _loop is None:
        raise RuntimeError("repl runtime is not serving")
    if _host_closed:
        raise RuntimeError("host connection closed; host_request cannot be answered")
    _check_payload("host_request", data)
    rid = uuid.uuid4().hex
    future: asyncio.Future[dict[str, Any]] = _loop.create_future()
    _pending_host[rid] = future
    try:
        _send({"event": "host_request", "id": rid, "data": data})
        return await future
    finally:
        _pending_host.pop(rid, None)


def _fail_pending_host_requests() -> None:
    """Loop-thread half of teardown: no host reply can arrive anymore, so every
    awaiting cell must unblock or the queued shutdown would never be served."""
    global _host_closed
    _host_closed = True
    for future in _pending_host.values():
        if not future.done():
            future.set_exception(RuntimeError("host connection closed; host_request cannot be answered"))


def _resolve_host_reply(rid: str, data: dict[str, Any]) -> None:
    """Reader-thread half of the host bridge; late/unknown replies are dropped."""
    assert _loop is not None

    def deliver() -> None:
        future = _pending_host.get(rid)
        if future is not None and not future.done():
            future.set_result(data)

    _loop.call_soon_threadsafe(deliver)


class _Pump:
    """Reads one captured-output pipe and ships its bytes as stream events."""

    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        # Private write end: a cell closing/reclaiming fd 1/2 cannot hijack drain tokens.
        self._token_fd = os.dup(write_fd)
        self._stream = stream
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._watch: tuple[bytes, threading.Event] | None = None
        self._buf = b""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def drain(self) -> None:
        """Block until every byte written to the fd so far has been shipped."""
        token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._watch = (token, seen)
        try:
            os.write(self._token_fd, token)
            # Backstop only: a dead pump (read end closed under it) can never set seen.
            while not seen.wait(0.1):
                if not self._thread.is_alive():
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._watch = None

    def _run(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self._feed(chunk)

    def _feed(self, chunk: bytes) -> None:
        data = self._buf + chunk
        self._buf = b""
        with self._lock:
            watch = self._watch
        if watch is None:
            self._emit(data)
            return
        token, seen = watch
        while True:
            i = data.find(token)
            if i == -1:
                break
            self._emit(data[:i])
            self._finish_decode()
            seen.set()
            data = data[i + len(token) :]
        # Hold back a tail that could be the start of a token split across reads.
        hold = 0
        for k in range(min(len(data), len(token) - 1), 0, -1):
            if data.endswith(token[:k]):
                hold = k
                break
        if hold:
            self._buf = data[len(data) - hold :]
            data = data[: len(data) - hold]
        self._emit(data)

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        text = self._decoder.decode(data)
        if text:
            # Raw fd bytes have no provable owner (os.write, C extensions,
            # subprocesses, threads from earlier cells): never credit a cell.
            _send({"event": self._stream, "id": None, "text": text})

    def _finish_decode(self) -> None:
        text = self._decoder.decode(b"", final=True)
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        if text:
            _send({"event": self._stream, "id": None, "text": text})


class _TaggedBuffer(io.RawIOBase):
    """Binary proxy for _TaggedWriter.buffer: bytes go to the raw fd channel.

    Byte ownership cannot be proven at this layer, so buffer writes ride the
    captured pipe and surface as id:null stream events (drained before done
    like any other raw fd write).
    """

    def __init__(self, fallback_fd: int) -> None:
        self._fallback_fd = fallback_fd

    def write(self, data: Any) -> int:
        # memoryview (unlike bytes()) rejects int, matching a real buffer's TypeError.
        view = memoryview(data).cast("B")
        total = len(view)
        # Pipe writes can be short for payloads above the pipe capacity.
        while view:
            view = view[os.write(self._fallback_fd, view) :]
        return total

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True


class _TaggedWriter(io.TextIOBase):
    """sys.stdout/sys.stderr replacement tagging writes with the writer's cell id.

    Python-level writes carry write-time provenance from the _current_cell
    contextvar (asyncio tasks inherit the spawning cell's id; user threads see
    None) and ship straight to the protocol, bypassing the fd pipe. fileno()
    and .buffer expose the captured pipe so subprocesses, C-level writers, and
    sys.stdout.buffer.write() keep working through the raw channel
    (null-attributed).
    """

    def __init__(self, stream: str, fallback_fd: int) -> None:
        self._stream = stream
        self._fallback_fd = fallback_fd
        # Keeps one write()'s frames contiguous under concurrent writers.
        self._frame_lock = threading.Lock()
        self._buffer = _TaggedBuffer(fallback_fd)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            cell_id = _current_cell.get()
            tail = _autobg_tails.get(cell_id)
            if tail is not None:
                tail.append(text)
            with self._frame_lock:
                for start in range(0, len(text), _STREAM_FRAME_TEXT_CAP):
                    _send(
                        {
                            "event": self._stream,
                            "id": cell_id,
                            "text": text[start : start + _STREAM_FRAME_TEXT_CAP],
                        }
                    )
        return len(text)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True

    @property
    def buffer(self) -> _TaggedBuffer:
        return self._buffer

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    """Retrieve a killed task's exception so no never-retrieved noise is logged."""
    if not task.cancelled():
        task.exception()


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    global _handoff_interrupted
    task = _active["task"]
    # No lock (the main thread may hold it): the rid equality revalidates the
    # target so a SIGINT delayed past its request's finish cannot hit a later cell.
    if task is None or task.done() or _active["rid"] != _sigint_target:
        if _sigint_target is not None and _sigint_target == _active["rid"]:
            # Handoff: the task is done but _run_guarded's finally has not run
            # yet, so the main thread may be inside loop internals where raising
            # would kill the serve loop. Record it; the finishing phase consumes it.
            _handoff_interrupted = True
            return
        # Post-run repr/drain is synchronous main-thread work: raise into it.
        # The equality revalidation drops a SIGINT delayed past the done send.
        if _sigint_target is not None and _sigint_target == _finishing_rid:
            raise KeyboardInterrupt
        return
    _active["interrupted"] = True
    # Handler runs in the main (loop) thread: current_task is whose step the signal interrupted.
    running = asyncio.current_task(_loop) if _loop is not None else None
    if running is task:
        # The active request's own step (sync bytecode or an EINTR-woken syscall): raise into it.
        raise KeyboardInterrupt
    # Loop idle in select() or another task mid-step: cancel the active task (same thread, safe).
    task.cancel()
    if running is not None and running is not _serve_task:
        # A background task blocked in sync code occupies the only thread and would keep the
        # cancel from ever running: raise into it to unwind its step; it dies with the KI.
        running.add_done_callback(_consume_task_exception)
        raise KeyboardInterrupt


def _request_interrupt(target: str | None) -> None:
    """Deliver an interrupt now, or park it for the request it targets.

    Runs on the reader thread. Without a target id the interrupt applies to
    the running request, else to the next queued one; with a target id it
    applies to that request only. A request finishing its post-run repr/drain
    is still interrupted (never parked: parking would hit the NEXT request).
    Interrupts for finished or unknown requests are dropped.
    """
    global _sigint_target
    with _interrupt_lock:
        task = _active["task"]
        rid = _active["rid"]
        if rid is not None and (target is None or target == rid):
            # Active, or in the done-task handoff before _run_guarded's finally:
            # either way the rid still owns the interrupt (parking here would
            # leak it onto the next request); the handler decides delivery.
            _sigint_target = rid
        elif _finishing_rid is not None and (target is None or target == _finishing_rid):
            _sigint_target = _finishing_rid
        elif target is not None:
            if target in _inflight:
                _pending_interrupts["ids"].add(target)
            return
        elif _inflight:
            _pending_interrupts["any"] = True
            return
        else:
            return
    # SIGINT must land on the main thread, where cells execute. Windows has no
    # signal.pthread_kill: fall back to cancelling the active task on the loop
    # (sync-blocked cells and the finishing repr/drain cannot be broken there;
    # best-effort parity).
    if hasattr(signal, "pthread_kill"):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
        if _loop is not None:
            # Wake the selector so a cancel scheduled by the handler runs promptly.
            _loop.call_soon_threadsafe(lambda: None)
        return
    if _loop is not None:

        def cancel_active() -> None:
            current = _active["task"]
            if current is task and current is not None and not current.done():
                _active["interrupted"] = True
                current.cancel()

        _loop.call_soon_threadsafe(cancel_active)


def _consume_pending_interrupt(rid: str) -> bool:
    """Check-and-clear any interrupt parked for this request."""
    pending = _pending_interrupts["any"] or rid in _pending_interrupts["ids"]
    _pending_interrupts["any"] = False
    _pending_interrupts["ids"].discard(rid)
    return pending


def _consume_handoff_interrupt() -> bool:
    """Check-and-clear an interrupt that landed in the done-task handoff."""
    global _handoff_interrupted
    with _interrupt_lock:
        pending = _handoff_interrupted
        _handoff_interrupted = False
        return pending


def _finish_locked(rid: str) -> None:
    """Drop a finished request; a parked untargeted interrupt survives while others are inflight."""
    global _finishing_rid, _handoff_interrupted, _sigint_target
    if _finishing_rid == rid:
        # An unconsumed handoff interrupt dies with its request (state requests
        # have no cancellable post-run work); it must never hit the next request.
        _finishing_rid = None
        _handoff_interrupted = False
    if _sigint_target == rid:
        # The target dies with its request: a later request reusing this id must
        # not match a stale target when a delayed/external SIGINT arrives.
        _sigint_target = None
    _inflight.discard(rid)
    _pending_interrupts["ids"].discard(rid)
    if not _inflight:
        _pending_interrupts["any"] = False


def _finish_request(rid: str) -> None:
    with _interrupt_lock:
        _finish_locked(rid)


_RUNTIME_FILE = __file__


def _cell_stack(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    """Frames from the first cell frame on, minus runtime-internal frames.

    Returns None when no cell frame exists (e.g. a compile-time SyntaxError).
    """
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<cell-")), None)
    if start is None:
        return None
    return traceback.StackSummary.from_list([f for f in stack[start:] if f.filename != _RUNTIME_FILE])


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001 - a broken __str__ must not kill the runtime
        return "<exception str() failed>"


def _cap_text(text: str) -> str:
    if len(text) > _RESULT_TEXT_CAP:
        return text[:_RESULT_TEXT_CAP] + _RESULT_TRUNCATION_MARKER
    return text


def _cap_traceback_lines(lines: list[str]) -> list[str]:
    """Bound the aggregate, not just each entry: an exception chain can carry
    thousands of entries, and per-entry caps alone would still let one error
    event exceed the host's protocol line limit. Keep the newest entries — the
    outermost exception carries the actionable failure — and lead with a
    truncation marker."""
    total = sum(len(line) for line in lines)
    if total <= _RESULT_TEXT_CAP:
        return lines
    kept: list[str] = []
    remaining = _RESULT_TEXT_CAP
    for line in reversed(lines):
        if len(line) > remaining:
            if not kept:
                # Never drop the newest entry: it names the raised exception.
                kept.append(line)
            break
        kept.append(line)
        remaining -= len(line)
    kept.reverse()
    kept.insert(
        0,
        f"[... traceback truncated: kept the newest {len(kept)} of {len(lines)} entries "
        f"to fit {_RESULT_TEXT_CAP} characters ...]\n",
    )
    return kept


def _error_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    # No cell frame (e.g. SyntaxError): exception-only keeps filename, source, and caret.
    te = traceback.TracebackException.from_exception(exc)
    stack = _cell_stack(te.stack)
    if stack is None:
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        te.stack = stack
        lines = list(te.format())
    return {
        "event": "error",
        "id": cell_id,
        "ename": type(exc).__name__,
        "evalue": _cap_text(_safe_str(exc)),
        "traceback": _cap_traceback_lines([_cap_text(line) for line in lines]),
    }


def _interrupt_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    """Report a cancelled await-suspended cell as a KeyboardInterrupt."""
    stack = _cell_stack(traceback.extract_tb(exc.__traceback__))
    lines = []
    if stack:
        lines = ["Traceback (most recent call last):\n"]
        lines.extend(stack.format())
    lines.append("KeyboardInterrupt\n")
    return {"event": "error", "id": cell_id, "ename": "KeyboardInterrupt", "evalue": "", "traceback": lines}


def _compile_cell(code: str, filename: str) -> tuple[list[types.CodeType], bool]:
    """Compile a cell; a trailing expression compiles separately in eval mode."""
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)
    tree = ast.parse(code, filename)
    trailing: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    codes: list[types.CodeType] = []
    if tree.body:
        codes.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
    if trailing is not None:
        codes.append(compile(trailing, filename, "eval", flags=flags, dont_inherit=True))
    return codes, trailing is not None


async def _run_codes(codes: list[types.CodeType], ns: dict[str, Any]) -> Any:
    value: Any = None
    for code_obj in codes:
        value = eval(code_obj, ns)  # noqa: S307 - executing the model's cell is the runtime's job
        if code_obj.co_flags & inspect.CO_COROUTINE:
            value = await value
    return value


async def _run_guarded(
    task: asyncio.Task[Any], rid: str, autobg_threshold: float = 0.0
) -> tuple[str, Any, dict[str, Any] | None]:
    """Await a request task; returns (status, value, error event or None).

    With a positive auto-bg threshold the race degrades: a task still running
    past the threshold is left running and reported as "degraded" — the
    execution slot frees and the caller hands back a pollable future handle.
    """
    with _interrupt_lock:
        _active["interrupted"] = False
        _active["rid"] = rid
        _active["task"] = task
        if _consume_pending_interrupt(rid):
            # Interrupt parked before activation: cancel before the first step.
            _active["interrupted"] = True
            task.cancel()
    try:
        if autobg_threshold > 0.0:
            deadline = time.monotonic() + autobg_threshold
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    # The threshold passed: defer only while the cell is
                    # suspended inside an actively-guarded bash await - that
                    # await degrades on its own (the cell resumes with the
                    # bash handle), so the cell is not degraded too.
                    bash_deadline = active_guard_race_deadline(task)
                    if bash_deadline is None:
                        return "degraded", None, None
                    remaining = max(bash_deadline - time.monotonic(), 0.0) + 0.05
                    deadline = time.monotonic() + remaining
                done, _pending = await asyncio.wait({task}, timeout=remaining)
                if done:
                    break
        value = await task
        return "ok", value, None
    except asyncio.CancelledError as exc:
        if _active["interrupted"]:
            return "error", None, _interrupt_event(rid, exc)
        return "error", None, _error_event(rid, exc)
    except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event
        return "error", None, _error_event(rid, exc)
    finally:
        with _interrupt_lock:
            global _finishing_rid
            # The rid stays inflight and interrupt-targetable through the
            # post-run repr/drain; the handler closes the window via _finish_request.
            # Set before clearing _active: the lock-free handler must always see
            # the rid in one of the two slots, never a torn in-between state.
            _finishing_rid = rid
            _active["task"] = None
            _active["rid"] = None


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter
    cell_id = req["id"]
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    execution = _CellExecution()
    cell_token = _current_cell.set(cell_id)
    execution_token = _current_cell_execution.set(execution)
    threshold = autobg.threshold_seconds()
    tail: _TailBuffer | None = None
    runner: _SyncCellRunner | None = None
    # True once a degraded async task owns its own tail cleanup.
    tail_detached = False
    try:
        codes, has_trailing = _compile_cell(req["code"], filename)
        assert _loop is not None
        if threshold > 0.0:
            tail = _TailBuffer()
            _autobg_tails[cell_id] = tail
            if any(code_obj.co_flags & inspect.CO_COROUTINE for code_obj in codes):
                task = _loop.create_task(_run_codes(codes, ns))
            else:
                # Sync-only cell: a worker thread keeps the loop free so the
                # guard can fire even while the cell holds the GIL.
                runner = _SyncCellRunner(codes, ns, cell_id, tail)
                task = _loop.create_task(_await_sync_cell(runner))
        else:
            task = _loop.create_task(_run_codes(codes, ns))
        execution.owner = task
        status, value, error = await _run_guarded(task, cell_id, threshold)
        result_text: str | None = None
        try:
            if _consume_handoff_interrupt() and status in ("ok", "degraded"):
                if status == "degraded":
                    # The interrupt targets the request's remaining work - the
                    # still-running execution: stop it best-effort and keep its
                    # late outcome on the runner/task instead of loop logs.
                    if runner is not None:
                        runner.request_stop()
                    else:
                        task.cancel()
                    task.add_done_callback(_consume_task_exception)
                    _pop_tail(cell_id, tail)
                # SIGINT landed between the task's completion and the finishing
                # phase: it targeted this request, so cancel its remaining work.
                status, error = "error", _error_event(cell_id, KeyboardInterrupt())
            if status == "degraded":
                # The cell outlived the auto-bg threshold: bind a pollable
                # future handle, keep the execution running, free the slot.
                name = f"_bg_{next(_bg_counter)}"
                while name in ns:
                    name = f"_bg_{next(_bg_counter)}"
                future = _KernelFuture(
                    name=name,
                    started=time.monotonic(),
                    runner=runner,
                    task=None if runner is not None else task,
                    tail=tail,
                )
                ns[name] = future
                # The abandoned task keeps running to completion; its late
                # exception belongs to poll() (the future surfaces it), so it
                # must never become loop noise at garbage collection.
                task.add_done_callback(_consume_task_exception)
                if runner is None:
                    # The async task keeps writing after this request ends; it
                    # owns the tail's cleanup now (identity-guarded: the
                    # request id may be reused by a later execution).
                    tail_detached = True
                    task.add_done_callback(
                        lambda _done_task, _cell_id=cell_id, _tail=tail: _pop_tail(_cell_id, _tail)
                    )
                result_text = _cap_text(_autobg_degrade_note(name, threshold, tail))
                status = "ok"
            elif status == "ok" and has_trailing and value is not None:
                try:
                    ns["_"] = value
                    result_text = repr(value)
                except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is a cell error
                    status, error = "error", _error_event(cell_id, exc)
            if result_text is not None:
                result_text = _cap_text(result_text)
            _drain_output()
        finally:
            # Close the interrupt window before the protocol sends so a
            # handler-raised KeyboardInterrupt can never tear a frame mid-_send.
            _finish_request(cell_id)
        if result_text is not None:
            _send({"event": "result", "id": cell_id, "text": result_text})
        if error is not None:
            _send(error)
        _send({"event": "done", "id": cell_id, "status": status})
    finally:
        # A started sync cell's runner pops its own tail at thread completion;
        # a degraded async task's done-callback owns its tail. A runner whose
        # task was cancelled before its first step never starts, so its entry
        # would otherwise leak; every other armed cell ends here.
        if tail is not None and not tail_detached and (runner is None or runner.thread is None):
            _pop_tail(cell_id, tail)
        execution.owner = None
        execution.finished.set()
        _current_cell_execution.reset(execution_token)
        _current_cell.reset(cell_token)


def _drain_output() -> None:
    # Per-stream, and ValueError too: a cell may close sys.stdout/sys.stderr, and
    # flushing a closed file raises ValueError, or rebind them to a flush-less
    # object (AttributeError); neither may kill the serve loop nor skip flushing
    # the other stream.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError, AttributeError):
            pass
    _pump_out.drain()
    _pump_err.drain()


class _SnapshotSizeLimitExceeded(Exception):
    pass


class _CappedWriter:
    def __init__(self, sink: Any, limit: int) -> None:
        self._sink = sink
        self._limit = limit
        self.written = 0

    def write(self, chunk: Any) -> int:
        size = len(chunk)
        if self.written + size > self._limit:
            raise _SnapshotSizeLimitExceeded()
        self._sink.write(chunk)
        self.written += size
        return size


def _read_snapshot_records(fh: Any, max_bytes: int, max_variable_bytes: int) -> dict[str, bytes]:
    """Framing damage is a corrupt snapshot: a restore error, never a partial namespace.
    Length fields are bounds-checked before their reads, so a corrupt header cannot force a huge
    allocation; the writer's own per-record and aggregate caps bound every blob read, so a
    sparse multi-gigabyte file cannot OOM the process either."""
    fh.seek(0, os.SEEK_END)
    size = fh.tell()
    fh.seek(len(_SNAPSHOT_MAGIC))
    records: dict[str, bytes] = {}
    total = 0
    while fh.tell() < size:
        header = fh.read(4)
        if len(header) < 4:
            raise ValueError("truncated snapshot record")
        name_len = int.from_bytes(header, "little")
        if fh.tell() + name_len + 8 > size:
            raise ValueError("truncated snapshot record")
        # The name is bounded by the same aggregate cap as the blobs: a
        # corrupt or sparse snapshot declaring a multi-gigabyte name must
        # fail the cap BEFORE the read allocates it (the same OOM class
        # the blob caps close).
        if name_len > max_bytes:
            raise ValueError("snapshot record name exceeds the aggregate byte cap")
        name = fh.read(name_len)
        raw_len = fh.read(8)
        blob_len = int.from_bytes(raw_len, "little")
        if len(raw_len) < 8 or fh.tell() + blob_len > size:
            raise ValueError("truncated snapshot record")
        if blob_len > max_variable_bytes:
            raise ValueError("snapshot record exceeds the per-variable byte cap")
        total += blob_len
        if total > max_bytes:
            raise ValueError("snapshot payload exceeds the aggregate byte cap")
        blob = fh.read(blob_len)
        if len(blob) < blob_len:
            raise ValueError("truncated snapshot record")
        records[name.decode("utf-8")] = blob
    return records


def _snapshot_state(
    ns: dict[str, Any],
    path: str,
    manifest_path: str,
    max_bytes: int,
    max_variable_bytes: int,
    prune_oversized: bool,
    committed: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    import datetime

    try:
        import dill
    except Exception as err:  # noqa: BLE001 - dill is provisioned by the host, not a hard dep
        return {"error": f"dill unavailable: {err}"}
    dill.settings["recurse"] = True

    saved: list[str] = []
    skipped: list[dict[str, str]] = []
    oversized: list[str] = []
    missing = object()

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temps: list[str] = []

    def stage_temp(target: str, mode: str):
        # Unique same-directory temps: a fixed '.tmp' name could alias the other
        # final path (clobbering it) or collide with a concurrent snapshot.
        fd, name = tempfile.mkstemp(
            dir=os.path.dirname(target) or ".", prefix=os.path.basename(target) + ".", suffix=".tmp"
        )
        temps.append(name)
        try:
            return os.fdopen(fd, mode), name
        except BaseException:
            os.close(fd)  # fdopen never took ownership: the raw fd would leak
            raise

    def discard_temps() -> None:
        for stale in temps:
            try:
                os.remove(stale)
            except OSError:
                pass

    # Stage both temps before replacing anything: any failure up to the first
    # replace leaves the previous payload+manifest pair fully intact.
    stage = "write"
    parked: list[int] = []
    handler_installed = False
    previous = None
    try:
        try:
            if max_bytes < len(_SNAPSHOT_MAGIC):
                # Even the header alone busts the cap: keep the committed-payload <= cap invariant.
                return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
            fh, tmp = stage_temp(path, "wb")
            with fh:
                # Single pass: each variable is dill-serialized exactly once, streamed
                # into the staged temp. The record header is charged against the aggregate
                # cap up front, so a completed record can never overflow it (no prefix re-dump).
                total = fh.write(_SNAPSHOT_MAGIC)
                for name in list(ns.keys()):
                    if name.startswith("_") or name in _ALWAYS_SKIP:
                        continue
                    value = ns.get(name, missing)
                    if value is missing:
                        # A background thread deleted the name after the key listing.
                        skipped.append({"name": name, "reason": "deleted during snapshot"})
                        continue
                    try:
                        encoded = name.encode("utf-8")
                    except UnicodeEncodeError as err:
                        # A lone-surrogate name (e.g. "\ud800") cannot ride the
                        # v2 record header; skip it like any other unserializable
                        # name instead of failing the whole snapshot.
                        skipped.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
                        continue
                    # Record header: 4-byte name length + 8-byte blob length, plus the name itself.
                    budget = max_bytes - total - 12 - len(encoded)
                    # Prune mode measures at the full per-variable cap: only that cap decides
                    # pruned-ness, and the write always re-measures — in-place mutation
                    # defeats any name-based size tracking from an earlier dump.
                    limit = max_variable_bytes if prune_oversized else min(max_variable_bytes, budget)
                    buffer = io.BytesIO()
                    try:
                        dill.dump(value, _CappedWriter(buffer, limit))
                        blob = buffer.getvalue()
                    except _SnapshotSizeLimitExceeded:
                        if not prune_oversized and budget < max_variable_bytes:
                            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                        else:
                            skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                            oversized.append(name)
                        continue
                    except Exception as err:  # noqa: BLE001 - one unpicklable name must not abort the snapshot
                        skipped.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
                        continue
                    if total + 12 + len(encoded) + len(blob) > max_bytes:
                        # Only reachable in prune mode, where the measurement cap ignores the budget.
                        skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                        continue
                    fh.write(len(encoded).to_bytes(4, "little"))
                    fh.write(encoded)
                    fh.write(len(blob).to_bytes(8, "little"))
                    fh.write(blob)
                    total += 12 + len(encoded) + len(blob)
                    saved.append(name)
                saved.sort()
                pruned = sorted(name for name in oversized if name in ns) if prune_oversized else []
                manifest = {
                    "version": 1,
                    "savedNames": saved,
                    "skipped": skipped,
                    "pruned": pruned,
                    "bytes": total,
                    "pythonVersion": sys.version.split()[0],
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
                stage = "manifest write"
                fh, manifest_tmp = stage_temp(manifest_path, "w")
                with fh:
                    json.dump(manifest, fh)
        except BaseException as err:  # noqa: BLE001 - Exception -> error dict, rest propagates
            if not isinstance(err, Exception):
                raise  # e.g. KeyboardInterrupt: clean up (outer finally), then propagate
            return {"error": f"{stage} failed: {err}"}

        # A SIGINT-raised KeyboardInterrupt anywhere from the first commit through the
        # last cleanup removal would desync payload/manifest/namespace or misreport a
        # committed snapshot: park SIGINT until the end; it is consumed, see below.
        previous = signal.signal(signal.SIGINT, lambda signum, frame: parked.append(signum))
        handler_installed = True
        try:
            os.replace(tmp, path)
        except OSError as err:
            return {"error": f"write failed: {err}"}
        try:
            os.replace(manifest_tmp, manifest_path)
        except OSError as err:
            # Fail before the prune deletions so a bad manifest path never destroys state.
            return {"error": f"manifest write failed: {err}"}
        for name in pruned:
            ns.pop(name, None)
        result = {"saved": saved, "skipped": skipped, "pruned": pruned, "bytes": total}
        # Publish while still parked: a later KeyboardInterrupt into this task finds the committed result (see _handle_state).
        if committed is not None:
            committed.append(result)
    finally:
        # The one guaranteed cleanup point (unique owned names: after a successful
        # commit the renamed temps no longer exist, so this is a no-op). It runs with
        # SIGINT still parked; the nested finally makes the restore the guaranteed
        # last action even when cleanup itself fails.
        try:
            discard_temps()
        finally:
            if handler_installed:
                signal.signal(signal.SIGINT, previous)
                # The parked SIGINT is consumed, not re-raised: with the manifest committed and
                # the namespace pruned, the destructive snapshot has succeeded, and re-raising
                # would misreport it as failed and risk the host discarding the only copy of
                # the pruned variables. The interrupt targeted this now-complete request.
    return result


def _revive_with_live_globals(
    value: Any,
    ns: dict[str, Any],
    backfill: list[tuple[str, Any]] | None = None,
    memo: dict[int, Any] | None = None,
) -> Any:
    """Rebind restored __main__ callables onto the live namespace, collecting
    names their saved globals carry but ns lacks as backfill for the caller
    to apply at commit (live ns values always win)."""
    import functools

    if memo is None:
        memo = {}
    if id(value) in memo:
        return memo[id(value)]

    def revive(dep: Any) -> Any:
        return _revive_with_live_globals(dep, ns, backfill, memo)

    if isinstance(value, functools.partial):
        # No placeholder memo entry: a partial is immutable, so it could never be patched;
        # every cycle passes through a function, which is memoized before recursing.
        rebuilt = revive(value.func)
        changed = rebuilt is not value.func
        args = []
        keywords = {}
        for arg in value.args:
            revived = revive(arg)
            changed = changed or revived is not arg
            args.append(revived)
        for key, arg in value.keywords.items():
            revived = revive(arg)
            changed = changed or revived is not arg
            keywords[key] = revived
        if not changed:
            # An unchanged partial still carries its original attributes:
            # __main__ callables there would keep frozen snapshot globals, so
            # revive them in place. Memoize first — an attribute can cycle
            # back to this partial.
            memo[id(value)] = value
            value.__dict__.update({key: revive(attr) for key, attr in value.__dict__.items()})
            return value
        rebuilt_partial = functools.partial(rebuilt, *args, **keywords)
        # Memoize before the attribute walk: attributes can hold the partial
        # itself (a self-cycle or mutual partials), and unlike the function
        # branch below there is no outer memo entry yet. Once set, the
        # not-changed fast path also returns the rebuilt one.
        memo[id(value)] = rebuilt_partial
        rebuilt_partial.__dict__.update({key: revive(attr) for key, attr in value.__dict__.items()})
        return rebuilt_partial
    atoms = (int, float, str, bytes, bool, type(None))
    # dill loads __main__.__dict__ by reference, so a saved globals() IS the live ns: never walk it.
    if value is ns:
        return value
    if isinstance(value, (list, dict, set)):
        # Memoized before recursing and revived in place: cycles and identity come for free.
        # Skipping atoms keeps the walk over million-element containers near dill.loads cost.
        memo[id(value)] = value
        if isinstance(value, set):
            # Iterate a snapshot: discard+add during iteration would skip members.
            for item in list(value):
                revived = item if type(item) in atoms else revive(item)
                if revived is not item:
                    value.discard(item)
                    value.add(revived)
        elif isinstance(value, list):
            for key, item in enumerate(value):
                revived = item if type(item) in atoms else revive(item)
                if revived is not item:
                    value[key] = revived
        else:
            # Keys can be __main__ callables too: revive them, or lookups
            # through the dict keep observing frozen globals. The snapshot
            # tolerates the delete+reinsert a rebuilt key needs.
            for key, item in list(value.items()):
                revived = item if type(item) in atoms else revive(item)
                revived_key = key if type(key) in atoms else revive(key)
                if revived_key is not key:
                    del value[key]
                    value[revived_key] = revived
                elif revived is not item:
                    value[key] = revived
        return value
    if type(value) is tuple:
        items = tuple(item if type(item) in atoms else revive(item) for item in value)
        if all(new is old for new, old in zip(items, value)):
            items = value
        return memo.setdefault(id(value), items)
    if type(value) is frozenset:
        # Immutable: rebuild when any member revived (identity equality makes
        # the comparison exact — a rebuilt function never equals the original).
        items = frozenset(item if type(item) in atoms else revive(item) for item in value)
        if items == value:
            items = value
        return memo.setdefault(id(value), items)
    if not isinstance(value, types.FunctionType) or value.__module__ != "__main__":
        return value
    # Defaults and cell contents are revived only after the rebound function is memoized, so a
    # function reachable from its own defaults or closure resolves to it. Cells are revived in
    # place: holders this walk never sees (attribute-held siblings) must keep sharing them.
    rebound = types.FunctionType(value.__code__, ns, value.__name__, None, value.__closure__)
    memo[id(value)] = rebound
    if backfill is not None:
        for name, dep in value.__globals__.items():
            # Snapshots never save _-prefixed or skip-listed names; backfill must not smuggle them past that policy.
            if name in ns or name.startswith("_") or name in _ALWAYS_SKIP or name in _RESTORE_SKIP:
                continue
            backfill.append((name, revive(dep)))
    if value.__defaults__:
        rebound.__defaults__ = tuple(revive(dep) for dep in value.__defaults__)
    if value.__kwdefaults__:
        rebound.__kwdefaults__ = {key: revive(dep) for key, dep in value.__kwdefaults__.items()}
    for cell in value.__closure__ or ():
        if id(cell) in memo:
            continue
        memo[id(cell)] = cell
        try:
            contents = cell.cell_contents
        except ValueError:
            continue
        cell.cell_contents = revive(contents)
    rebound.__doc__ = value.__doc__
    rebound.__dict__.update({key: revive(attr) for key, attr in value.__dict__.items()})
    rebound.__annotations__ = value.__annotations__
    rebound.__qualname__ = value.__qualname__
    rebound.__module__ = value.__module__
    # PEP 695 generics carry their type params here on 3.12+; plain 3.11
    # functions lack the attribute entirely, hence the getattr guard.
    params = getattr(value, "__type_params__", None)
    if params is not None:
        rebound.__type_params__ = params
    return rebound


def _restore_state(
    ns: dict[str, Any],
    path: str,
    committed: list[dict[str, Any]] | None = None,
    max_bytes: int | None = None,
    max_variable_bytes: int | None = None,
) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    try:
        import dill
    except Exception as err:  # noqa: BLE001
        return {"error": f"dill unavailable: {err}"}
    try:
        with open(path, "rb") as fh:
            if fh.read(len(_SNAPSHOT_MAGIC)) == _SNAPSHOT_MAGIC:
                payload = _read_snapshot_records(
                    fh,
                    max_bytes if max_bytes is not None else DEFAULT_SNAPSHOT_MAX_BYTES,
                    (
                        max_variable_bytes
                        if max_variable_bytes is not None
                        else DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES
                    ),
                )
            else:
                # Legacy: one dill-pickled dict; old snapshot files must keep restoring.
                fh.seek(0)
                payload = dill.load(fh)
    except Exception as err:  # noqa: BLE001 - a corrupt snapshot yields an empty restore
        return {"error": f"load failed: {_safe_str(err)}"}
    if not isinstance(payload, dict):
        return {"error": "corrupt snapshot: not a dict"}

    staged: dict[str, Any] = {}
    failed: list[dict[str, str]] = []
    for name, blob in payload.items():
        if name in _RESTORE_SKIP:
            continue
        try:
            staged[name] = dill.loads(blob)
        except Exception as err:  # noqa: BLE001 - revive every other name regardless
            failed.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
    # Revive every staged name before parking: a failure must never abort the
    # apply halfway and leave the namespace half old, half new.
    prepared: dict[str, Any] = {}
    backfill: list[tuple[str, Any]] = []
    revive_failed: list[dict[str, str]] = []
    for name, value in staged.items():
        # The backfill entries a name's revival produced merge only if THAT
        # name revives: a failed revival adds nothing (its saved globals
        # would partially restore state the failure report says failed).
        name_backfill: list[tuple[str, Any]] = []
        try:
            prepared[name] = _revive_with_live_globals(value, ns, name_backfill)
        except Exception as err:  # noqa: BLE001 - one broken revival must not abort the restore
            revive_failed.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
            continue
        backfill.extend(name_backfill)
    result = {"restored": sorted(prepared), "failed": failed + revive_failed}
    # Park SIGINT across the whole apply so it is all-or-nothing; the parked interrupt is consumed by the commit (as in snapshot).
    previous = signal.signal(signal.SIGINT, lambda signum, frame: None)
    try:
        for name, value in prepared.items():
            ns[name] = value
        for name, value in backfill:
            # prepared names already sit in ns here: a restored value always beats backfill.
            if name not in ns:
                ns[name] = value
        # Publish while still parked: a later KeyboardInterrupt into this task finds the committed result (see _handle_state).
        if committed is not None:
            committed.append(result)
    finally:
        signal.signal(signal.SIGINT, previous)
    return result


async def _handle_state(req: dict[str, Any], ns: dict[str, Any]) -> None:
    """Run snapshot/restore as an interruptible task and reply in the done event."""
    rid = req["id"]
    committed: list[dict[str, Any]] = []

    async def run() -> dict[str, Any]:
        if req["type"] == "snapshot":
            prune = req.get("prune_oversized", False)
            if not isinstance(prune, bool):
                return {"error": "prune_oversized must be a boolean"}
            for field in ("max_bytes", "max_variable_bytes"):
                # Any present value must be a non-negative int; a JSON null is not a valid way to ask
                # for the default, and a negative cap would prune every user variable from ns.
                if field in req and (
                    isinstance(req[field], bool) or not isinstance(req[field], int) or req[field] < 0
                ):
                    return {"error": f"{field} must be a non-negative integer"}
            # realpath resolves symlinks, so aliased paths cannot silently clobber the payload.
            if os.path.realpath(req["path"]) == os.path.realpath(req["manifest_path"]):
                return {"error": "path and manifest_path must differ"}
            return _snapshot_state(
                ns,
                req["path"],
                req["manifest_path"],
                req.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
                req.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
                prune,
                committed,
            )
        return _restore_state(
            ns,
            req["path"],
            committed,
            req.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
            req.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
        )

    assert _loop is not None
    task = _loop.create_task(run())
    outcome: tuple[str, Any, dict[str, Any] | None] | None = None
    try:
        outcome = await _run_guarded(task, rid)
        _finish_request(rid)  # no post-run repr/drain: close the interrupt window now
    except KeyboardInterrupt:
        # A finishing-targeted SIGINT can raise anywhere between _run_guarded's
        # finally publishing _finishing_rid and _finish_request clearing it; the
        # handler only raises once _finishing_rid is set, so the task is already
        # complete (destructively so for a pruning snapshot). Consume the
        # interrupt and report the task's real outcome; escaping to the backstop
        # would misreport a committed snapshot as failed.
        _finish_request(rid)
        if outcome is None:
            # The KeyboardInterrupt pre-empted _run_guarded's return: recover
            # the completed task's outcome with _run_guarded's failure mapping.
            try:
                outcome = ("ok", task.result(), None)
            except asyncio.CancelledError as exc:
                event = _interrupt_event(rid, exc) if _active["interrupted"] else _error_event(rid, exc)
                outcome = ("error", None, event)
            except BaseException as exc:  # noqa: BLE001 - every request failure becomes an error event
                outcome = ("error", None, _error_event(rid, exc))
    status, result, error = outcome
    if (
        committed
        and _active["interrupted"]
        and error is not None
        and error.get("ename") == "KeyboardInterrupt"
    ):
        # Recover only a protocol interrupt that landed after the commit; a user KeyboardInterrupt keeps interrupted reporting.
        status, result, error = "ok", committed[0], None
    if status != "ok":
        reason = "interrupted" if error and error.get("ename") == "KeyboardInterrupt" else (
            f"{error.get('ename')}: {error.get('evalue')}" if error else "failed"
        )
        _send({"event": "done", "id": rid, "status": "error", "reason": reason})
        return
    if "error" in result:
        _send({"event": "done", "id": rid, "status": "error", "reason": result["error"]})
        return
    if req["type"] == "snapshot":
        global _last_snapshot_target
        _last_snapshot_target = {
            "path": req["path"],
            "manifest_path": req["manifest_path"],
            "max_bytes": req.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
            "max_variable_bytes": req.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
        }
    _send({"event": "done", "id": rid, "status": "ok", **result})


def _flush_final_snapshot(ns: dict[str, Any]) -> None:
    """EOF-only best-effort final snapshot before exit.

    The host died without a graceful dispose (crash, SIGKILL, worker exit
    path that skipped `shutdown`), so its debounced snapshots stop at the
    last one. Flush the current namespace to the last-known target so a
    resume revives state up to the EOF instead of up to the debounce.
    Atomic staging (temp + rename) means an interrupted flush leaves the
    previous payload intact, never a torn one.
    """
    target = _last_snapshot_target
    if target is None:
        return
    try:
        _snapshot_state(
            ns,
            target["path"],
            target["manifest_path"],
            target["max_bytes"],
            target["max_variable_bytes"],
            False,
            None,
        )
    except BaseException:  # noqa: BLE001 - never block or crash the shutdown path
        pass


def _list_names(ns: dict[str, Any]) -> list[str]:
    """User-defined top-level names, filtered like the snapshot."""
    # Non-string keys (globals()[1] = 1) are not user-listable names.
    return sorted(
        name for name in ns if isinstance(name, str) and not name.startswith("_") and name not in _ALWAYS_SKIP
    )


async def _handle_list_names(req: dict[str, Any], ns: dict[str, Any]) -> None:
    _send({"event": "done", "id": req["id"], "status": "ok", "names": _list_names(ns)})


async def _handle_mcp_status(req: dict[str, Any], ns: dict[str, Any]) -> None:
    from . import mcp as mcp_mod

    servers = req.get("servers")
    if not isinstance(servers, list) or not all(isinstance(name, str) for name in servers):
        raise ValueError("mcp_status requires a list of server names")
    timeout_ms = req.get("timeout_ms", 10_000)
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        raise ValueError("mcp_status timeout_ms must be a positive number")
    connections = await mcp_mod.status(servers, float(timeout_ms))
    _send({"event": "done", "id": req["id"], "status": "ok", "connections": connections})


async def _handle_request(
    handler: Callable[[dict[str, Any], dict[str, Any]], Awaitable[None]],
    req: dict[str, Any],
    ns: dict[str, Any],
) -> None:
    # Backstop: one broken request (e.g. RecursionError in compile) fails alone, never the serve loop.
    try:
        await handler(req, ns)
    except BaseException as exc:  # noqa: BLE001 - any per-request failure becomes error+done
        rid = req["id"]
        with _interrupt_lock:
            # Only a still-inflight request (never reached _run_guarded, e.g. compile
            # failure) owns a parked interrupt; after _run_guarded finished it, a parked
            # "any" belongs to the next request and must survive.
            if rid in _inflight:
                _consume_pending_interrupt(rid)
            _finish_locked(rid)
        _send(_error_event(rid, exc))
        _send({"event": "done", "id": rid, "status": "error"})


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        # A cell (or a snapshot-restored prior handler) may have rebound SIGINT; the
        # protocol handler must own it before each request. Mid-cell rebinds remain
        # that cell's own problem for that cell only.
        signal.signal(signal.SIGINT, _sigint_handler)
        rtype = req.get("type")
        if rtype == "shutdown":
            rid = req.get("id")
            if req.get("eof"):
                # Host stdin closed without a shutdown request: the host
                # process is gone, so this is the last chance to persist.
                _flush_final_snapshot(ns)
            # MCP children must close before the loop dies; close() is internally bounded under the host's 5s deadline.
            mcp_mod = sys.modules.get("rlm.mcp")
            if mcp_mod is not None:
                try:
                    await mcp_mod.close()
                except BaseException as exc:
                    print(f"MCP shutdown failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            # Kill live bash children now; atexit would wait on parked executor threads.
            _kill_live_handles()
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok"})
            return
        if rtype == "execute":
            await _handle_request(_handle_execute, req, ns)
        elif rtype in ("snapshot", "restore"):
            await _handle_request(_handle_state, req, ns)
        elif rtype == "list_names":
            await _handle_request(_handle_list_names, req, ns)
        elif rtype == "mcp_status":
            await _handle_request(_handle_mcp_status, req, ns)


def _handle_bash_activity(req: dict[str, Any]) -> None:
    """Out-of-band: a running cell must not block inspection or cancellation."""
    from .bash import activity_request

    rid = req["id"]
    try:
        response = activity_request(req["action"], req.get("activityId"), req.get("lines", 50))
        frame = {"event": "done", "id": rid, "status": "ok", **response}
        _cap_bash_activity_frame(frame)
        _send(frame)
    except (KeyError, ValueError) as exc:
        _send({"event": "done", "id": rid, "status": "error", "reason": str(exc)})


def _cap_bash_activity_frame(frame: dict[str, Any]) -> None:
    """Keep the serialized response under the 16 KiB wire cap.

    json escaping can expand one character to six bytes (uXXXX-style), so
    the byte slices in `activity_request` cannot bound the frame alone. Trim
    from the oldest end: a tail keeps its newest lines, a list keeps its
    newest rows.
    """
    tail = frame.get("tail")
    if isinstance(tail, str):
        while len(json.dumps(frame)) > 16_384:
            excess = len(json.dumps(frame)) - 16_384
            keep = max(0, len(tail) - excess // 6 - 1)
            if keep >= len(tail):
                # The frame cannot fit no matter how the payload shrinks
                # (oversized request metadata): emit the smallest frame
                # instead of looping forever on the reader thread.
                frame["tail"] = ""
                break
            tail = tail[-keep:] if keep else ""
            frame["tail"] = tail
        return
    rows = frame.get("activities")
    while len(json.dumps(frame)) > 16_384 and isinstance(rows, list) and len(rows) > 1:
        victim = next(
            (index for index, row in enumerate(rows) if row.get("status") != "running"),
            0,
        )
        rows.pop(victim)



_REQUIRED_FIELDS = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path", "manifest_path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
    # mcp_status's server list is a JSON array, so only its id is a
    # string-required field; the handler validates the list itself.
    "mcp_status": ("id",),
    "bash_activity": ("id", "action"),
    "shutdown": (),
}


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


def _handle_request_line(raw: bytes, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("request is not a JSON object")
    rtype = req.get("type")
    if rtype == "interrupt":
        if "id" in req and not isinstance(req["id"], str):
            _protocol_error("interrupt request id must be a string")
            return
        _request_interrupt(req.get("id"))
        return
    if rtype == "host_reply":
        # Bypass the FIFO queue: the awaiting cell IS the in-flight
        # execute, so a queued reply would deadlock behind it.
        rid = req.get("id")
        data = req.get("data")
        if isinstance(rid, str) and isinstance(data, dict):
            _resolve_host_reply(rid, data)
        else:
            _protocol_error("host_reply request needs string id and dict data")
        return
    if not isinstance(rtype, str) or rtype not in _REQUIRED_FIELDS:
        _protocol_error(f"unknown request type: {rtype!r}")
        return
    missing = [f for f in _REQUIRED_FIELDS[rtype] if not isinstance(req.get(f), str)]
    if missing:
        _protocol_error(f"{rtype} request needs string fields: {', '.join(missing)}")
        return
    if rtype == "bash_activity":
        if req["action"] not in ("list", "tail", "kill"):
            _protocol_error("unknown bash activity action")
            return
        if req["action"] != "list" and not isinstance(req.get("activityId"), str):
            _protocol_error("bash activity tail/kill requires string activityId")
            return
        if len(req["id"]) > 256 or len(req.get("activityId") or "") > 256:
            # Frame metadata rides every response: an unbounded id would
            # leave no room for the capped payload.
            _protocol_error("bash activity ids must stay under 256 characters")
            return
        # Like host_reply, this bypasses the cell FIFO. Handles remain owned
        # by the runtime, not by an arbitrary PID supplied by the client.
        _handle_bash_activity(req)
        return
    if rtype in ("execute", "snapshot", "restore"):
        with _interrupt_lock:
            # A reused in-flight id would corrupt interrupt/finish bookkeeping.
            duplicate = req["id"] in _inflight
            if not duplicate:
                _inflight.add(req["id"])
        # The protocol write can block on backpressure: never send under the lock.
        if duplicate:
            _protocol_error(f"duplicate in-flight request id: {req['id']!r}")
            return
    if rtype == "shutdown":
        # No host reply follows a shutdown; a cell awaiting host_request
        # must fail now or it would block _serve from ever consuming this.
        _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, req)


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                # The whole per-line handling sits inside the backstop: hostile
                # input (RecursionError from pathological nesting, unhashable
                # field types, ...) must never kill the reader thread.
                _handle_request_line(raw, queue)
            except BaseException as err:  # noqa: BLE001
                _protocol_error(f"{type(err).__name__}: {_safe_str(err)}")
    # Host closed stdin: shut the runtime down. The marker distinguishes
    # this from the host's explicit shutdown request (which runs after the
    # host flushed its own final snapshot, so no runtime-side flush runs).
    _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown", "eof": True})


def _resolve_owner_pid() -> int:
    raw = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID", "")
    try:
        owner = int(raw)
    except ValueError:
        owner = 0
    return owner if owner > 0 else os.getppid()


def _owner_alive_posix(owner: int, initial_ppid: int) -> bool:
    # Reparenting is the race-free parent-death signal when the owner is the
    # parent; the kill-0 probe covers an env-designated non-parent owner.
    if initial_ppid == owner and os.getppid() != initial_ppid:
        return False
    try:
        os.kill(owner, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass  # EPERM etc.: alive but unprobeable
    return True


def _wait_owner_windows(owner: int) -> None:
    # Blocks until the owner exits. os.kill(pid, 0) on Windows TERMINATES the
    # target, so a SYNCHRONIZE handle wait is the only sound probe.
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    handle = k32.OpenProcess(SYNCHRONIZE, False, owner)
    if not handle:
        return  # already gone (or unprobeable): exit rather than run ownerless
    try:
        k32.WaitForSingleObject(handle, INFINITE)
    finally:
        k32.CloseHandle(handle)


def _owner_watchdog(owner: int, initial_ppid: int) -> None:
    if os.name == "nt":
        _wait_owner_windows(owner)
    else:
        while _owner_alive_posix(owner, initial_ppid):
            time.sleep(1.0)
    # Event-loop-independent by design: a synchronous cell monopolizes the
    # loop, so the queued EOF shutdown can never run; hard-exit from here.
    try:
        _kill_live_handles()
    except BaseException:  # noqa: BLE001
        pass
    os._exit(1)


def _start_owner_watchdog() -> None:
    threading.Thread(
        target=_owner_watchdog, args=(_resolve_owner_pid(), os.getppid()), daemon=True
    ).start()


_pump_out: _Pump
_pump_err: _Pump


def _setup_fds() -> int:
    """Reserve stdout for the protocol; route fds 1/2 through captured pipes."""
    global _protocol_fd, _pump_out, _pump_err
    _protocol_fd = os.dup(1)
    os.set_inheritable(_protocol_fd, False)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.close(out_w)
    os.close(err_w)
    sys.stdout = _TaggedWriter("stdout", fallback_fd=os.dup(1))
    sys.stderr = _TaggedWriter("stderr", fallback_fd=os.dup(2))
    stdin_fd = os.dup(0)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, "r")  # user input() sees EOF, never protocol frames
    _pump_out = _Pump(out_r, 1, "stdout")
    _pump_err = _Pump(err_r, 2, "stderr")
    return stdin_fd


def main() -> None:
    global _loop, _serve_task
    stdin_fd = _setup_fds()
    _start_owner_watchdog()
    _install_sync_cell_compat()

    # Alias the executing module so an in-cell `from rlm.repl import emit`
    # binds the live module, not a second copy.
    sys.modules.setdefault("rlm.repl", sys.modules[__name__])
    # A real __main__ module makes dill pickle user functions/classes by value.
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = user_module

    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _install_loop_create_task_compat()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    signal.signal(signal.SIGINT, _sigint_handler)
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()

    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": platform.python_version()})

    _serve_task = _loop.create_task(_serve(queue, user_module.__dict__))
    # A KeyboardInterrupt escaping a cell or background task stops
    # run_until_complete; the interrupt is already recorded, so resume serving.
    while not _serve_task.done():
        try:
            _loop.run_until_complete(_serve_task)
        except KeyboardInterrupt:
            continue
    _loop.close()


if __name__ == "__main__":
    main()
