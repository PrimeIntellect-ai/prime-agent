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
from collections.abc import Awaitable, Callable
from typing import Any

from .bash import _kill_live_handles

PROTOCOL_VERSION = 3

DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024

# Names the session bootstrap re-creates on every start; never snapshotted.
_ALWAYS_SKIP = {"rlm", "mcp", "bash", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
# IPython-injected names that may appear in a snapshot payload; never restored.
_RESTORE_SKIP = {"In", "Out", "get_ipython"}

_protocol_fd: int = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_serve_task: asyncio.Task[Any] | None = None
# Attribution rides task context: asyncio tasks copy it at creation, so a
# detached task spawned by a cell keeps writing under that cell's id after
# the cell finishes. Threads start with a fresh context and emit id null.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)
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


def emit(data: dict[str, Any]) -> None:
    """Ship one display event carrying a dict of MIME type -> JSON payload.

    Thread-safe; the event is tagged with the cell running at call time.
    """
    if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
        raise TypeError("emit() requires a non-empty dict keyed by MIME type strings")
    # Strict-dumps validation: default allow_nan=True would let NaN/Infinity
    # serialize as non-JSON text and tear the host's protocol framing (a
    # non-serializable value already raises in _send before any bytes are
    # written, so NaN is the only corruption vector). Payloads are small, so
    # the throwaway serialization here is cheap; _send re-serializes.
    json.dumps(data, allow_nan=False)
    _send({"event": "display", "id": _current_cell.get(), "data": data})


def is_active() -> bool:
    """True when this process serves the repl protocol (not merely imported)."""
    return _protocol_fd >= 0


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Send one typed request to the host and await its raw reply dict."""
    if _loop is None:
        raise RuntimeError("repl runtime is not serving")
    if _host_closed:
        raise RuntimeError("host connection closed; host_request cannot be answered")
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
        self._buffer = _TaggedBuffer(fallback_fd)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            _send({"event": self._stream, "id": _current_cell.get(), "text": text})
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
        "evalue": _safe_str(exc),
        "traceback": lines,
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


async def _run_guarded(task: asyncio.Task[Any], rid: str) -> tuple[str, Any, dict[str, Any] | None]:
    """Await a request task; returns (status, value, error event or None)."""
    with _interrupt_lock:
        _active["interrupted"] = False
        _active["rid"] = rid
        _active["task"] = task
        if _consume_pending_interrupt(rid):
            # Interrupt parked before activation: cancel before the first step.
            _active["interrupted"] = True
            task.cancel()
    try:
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
    # The cell task (created below) copies this context, so writes made from
    # the cell and from asyncio tasks it spawns carry this cell's id.
    token = _current_cell.set(cell_id)
    try:
        codes, has_trailing = _compile_cell(req["code"], filename)
        assert _loop is not None
        task = _loop.create_task(_run_codes(codes, ns))
        status, value, error = await _run_guarded(task, cell_id)
        result_text: str | None = None
        try:
            if _consume_handoff_interrupt() and status == "ok":
                # SIGINT landed between the task's completion and the finishing
                # phase: it targeted this request, so cancel its remaining work.
                status, error = "error", _error_event(cell_id, KeyboardInterrupt())
            if status == "ok" and has_trailing and value is not None:
                try:
                    ns["_"] = value
                    result_text = repr(value)
                except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is a cell error
                    status, error = "error", _error_event(cell_id, exc)
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
        _current_cell.reset(token)


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


class _SnapshotBuffer:
    def __init__(self, limit: int) -> None:
        import io

        self._buf = io.BytesIO()
        self._limit = limit

    def write(self, chunk: bytes) -> int:
        if self._buf.tell() + len(chunk) > self._limit:
            raise _SnapshotSizeLimitExceeded()
        return self._buf.write(chunk)

    def getvalue(self) -> bytes:
        return self._buf.getvalue()


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

    payload: dict[str, bytes] = {}
    skipped: list[dict[str, str]] = []
    oversized: list[str] = []
    total = 0
    missing = object()
    for name in list(ns.keys()):
        if name.startswith("_") or name in _ALWAYS_SKIP:
            continue
        value = ns.get(name, missing)
        if value is missing:
            # A background thread deleted the name after the key listing.
            skipped.append({"name": name, "reason": "deleted during snapshot"})
            continue
        remaining = max_bytes - total
        limit = max_variable_bytes if prune_oversized else min(max_variable_bytes, remaining)
        buffer = _SnapshotBuffer(limit)
        try:
            dill.dump(value, buffer)
            blob = buffer.getvalue()
        except _SnapshotSizeLimitExceeded:
            if not prune_oversized and remaining < max_variable_bytes:
                skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            else:
                skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                oversized.append(name)
            continue
        except Exception as err:  # noqa: BLE001 - one unpicklable name must not abort the snapshot
            skipped.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
            continue
        if total + len(blob) > max_bytes:
            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            continue
        payload[name] = blob
        total += len(blob)

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
            def serialize(candidate: dict[str, bytes]) -> bytes | None:
                buffer = _SnapshotBuffer(max_bytes)
                try:
                    dill.dump(candidate, buffer)
                except _SnapshotSizeLimitExceeded:
                    return None
                return buffer.getvalue()

            serialized_payload = serialize(payload)
            if serialized_payload is None:
                items = list(payload.items())
                serialized_payload = serialize({})
                if serialized_payload is None:
                    return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
                # Keep the largest insertion-order prefix whose complete pickle fits.
                # Prefix pickle size is monotonic because each prefix only adds a string key and bytes value.
                low, high = 0, len(items) - 1
                while low < high:
                    mid = (low + high + 1) // 2
                    candidate = serialize(dict(items[:mid]))
                    if candidate is None:
                        high = mid - 1
                    else:
                        low = mid
                        serialized_payload = candidate
                for name, _ in items[low:]:
                    skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                payload = dict(items[:low])

            fh, tmp = stage_temp(path, "wb")
            with fh:
                fh.write(serialized_payload)
            bytes_written = len(serialized_payload)
            saved = sorted(payload.keys())
            pruned = sorted(name for name in oversized if name in ns) if prune_oversized else []
            manifest = {
                "version": 1,
                "savedNames": saved,
                "skipped": skipped,
                "pruned": pruned,
                "bytes": bytes_written,
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
        result = {"saved": saved, "skipped": skipped, "pruned": pruned, "bytes": bytes_written}
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


def _restore_state(
    ns: dict[str, Any], path: str, committed: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    try:
        import dill
    except Exception as err:  # noqa: BLE001
        return {"error": f"dill unavailable: {err}"}
    try:
        with open(path, "rb") as fh:
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
    result = {"restored": sorted(staged), "failed": failed}
    # Park SIGINT across the whole apply so it is all-or-nothing; the parked interrupt is consumed by the commit (as in snapshot).
    previous = signal.signal(signal.SIGINT, lambda signum, frame: None)
    try:
        for name, value in staged.items():
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
        return _restore_state(ns, req["path"], committed)

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
    _send({"event": "done", "id": rid, "status": "ok", **result})


def _list_names(ns: dict[str, Any]) -> list[str]:
    """User-defined top-level names, filtered like the snapshot."""
    # Non-string keys (globals()[1] = 1) are not user-listable names.
    return sorted(
        name for name in ns if isinstance(name, str) and not name.startswith("_") and name not in _ALWAYS_SKIP
    )


async def _handle_list_names(req: dict[str, Any], ns: dict[str, Any]) -> None:
    _send({"event": "done", "id": req["id"], "status": "ok", "names": _list_names(ns)})


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


_REQUIRED_FIELDS = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path", "manifest_path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
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
    # Host closed stdin: shut the runtime down.
    _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown"})


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

    # Alias the executing module so an in-cell `from rlm.repl import emit`
    # binds the live module, not a second copy.
    sys.modules.setdefault("rlm.repl", sys.modules[__name__])
    # A real __main__ module makes dill pickle user functions/classes by value.
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = user_module

    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
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
