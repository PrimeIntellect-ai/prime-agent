"""Minimal CPython REPL runtime speaking newline-delimited JSON over stdio.

Entry point: ``python -m rlm.repl``. The protocol is documented in repl.md
next to this file. Cells execute with top-level await in one persistent
``__main__`` namespace on a single asyncio event loop.
"""

from __future__ import annotations

import ast
import asyncio
import codecs
import inspect
import json
import linecache
import os
import platform
import signal
import sys
import threading
import traceback
import types
import uuid
from typing import Any

PROTOCOL_VERSION = 1

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
_current_cell: str | None = None
_active: dict[str, Any] = {"task": None, "rid": None, "interrupted": False}
_cell_counter = 0

# Interrupt bookkeeping shared between the reader thread and the loop thread.
_interrupt_lock = threading.Lock()
_inflight: set[str] = set()
_pending_interrupts: dict[str, Any] = {"ids": set(), "any": False}


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
    _send({"event": "display", "id": _current_cell, "data": data})


class _Pump:
    """Reads one captured-output pipe and ships its bytes as stream events."""

    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        self._write_fd = write_fd
        self._stream = stream
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._watch: tuple[bytes, threading.Event] | None = None
        self._buf = b""
        threading.Thread(target=self._run, daemon=True).start()

    def drain(self, timeout: float = 2.0) -> None:
        """Block until every byte written to the fd so far has been shipped."""
        token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._watch = (token, seen)
        try:
            os.write(self._write_fd, token)
        except OSError:
            return
        seen.wait(timeout)
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
            _send({"event": self._stream, "id": _current_cell, "text": text})


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    """Retrieve a killed task's exception so no never-retrieved noise is logged."""
    if not task.cancelled():
        task.exception()


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    task = _active["task"]
    if task is None or task.done():
        return
    _active["interrupted"] = True
    # The handler runs in the main thread, which is also the loop thread, so
    # asyncio.current_task tells us whose bytecode the signal interrupted.
    running = asyncio.current_task(_loop) if _loop is not None else None
    if running is task:
        # The active request's own step is executing (sync bytecode, or a
        # blocking syscall woken by EINTR): raise straight into it.
        raise KeyboardInterrupt
    # The loop is idle in select(), or another task is mid-step; raising here
    # would land in the wrong context, so cancel the active task instead.
    # Same thread, so a direct cancel is safe.
    task.cancel()
    if running is not None and running is not _serve_task:
        # A background task's step occupies the only thread and may block in
        # synchronous code forever, which would keep the cancel from ever
        # being processed: raise into it to unwind its step. The background
        # task dies with this KeyboardInterrupt; its exception is consumed.
        running.add_done_callback(_consume_task_exception)
        raise KeyboardInterrupt


def _request_interrupt(target: str | None) -> None:
    """Deliver an interrupt now, or park it for the request it targets.

    Runs on the reader thread. Without a target id the interrupt applies to
    the running request, else to the next queued one; with a target id it
    applies to that request only. Interrupts for finished or unknown requests
    are dropped.
    """
    with _interrupt_lock:
        task = _active["task"]
        active = task is not None and not task.done()
        if active and (target is None or target == _active["rid"]):
            pass  # deliver below, outside the lock
        elif target is not None:
            if target in _inflight:
                _pending_interrupts["ids"].add(target)
            return
        elif _inflight:
            _pending_interrupts["any"] = True
            return
        else:
            return
    # SIGINT must land on the main thread: a sync-blocking syscall there gets
    # EINTR and the Python-level handler runs where the cell executes.
    signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    if _loop is not None:
        # Wake the selector so a cancel scheduled by the handler runs promptly.
        _loop.call_soon_threadsafe(lambda: None)


def _consume_pending_interrupt(rid: str) -> bool:
    """Check-and-clear any interrupt parked for this request."""
    pending = _pending_interrupts["any"] or rid in _pending_interrupts["ids"]
    _pending_interrupts["any"] = False
    _pending_interrupts["ids"].discard(rid)
    return pending


def _finish_request(rid: str) -> None:
    with _interrupt_lock:
        _inflight.discard(rid)
        _consume_pending_interrupt(rid)


_RUNTIME_FILE = __file__


def _cell_stack(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    """Frames from the first cell frame on, minus runtime-internal frames.

    Returns None when no cell frame exists (e.g. a compile-time SyntaxError).
    """
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<cell-")), None)
    if start is None:
        return None
    return traceback.StackSummary.from_list([f for f in stack[start:] if f.filename != _RUNTIME_FILE])


def _error_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    # The traceback shows only cell and library frames: frames before the
    # first cell frame are the runtime's exec machinery and frames from this
    # file (e.g. the SIGINT handler's raise) are runtime-internal; both are
    # stripped. When no cell frame exists, format the exception only, which
    # for syntax errors keeps filename, source, and caret.
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
        "evalue": str(exc),
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
            # An interrupt arrived before this request became active: cancel
            # the task before its first step and report KeyboardInterrupt.
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
            _active["task"] = None
            _active["rid"] = None
            _inflight.discard(rid)
            _consume_pending_interrupt(rid)


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _current_cell, _cell_counter
    cell_id = req["id"]
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    _current_cell = cell_id
    try:
        try:
            codes, has_trailing = _compile_cell(req["code"], filename)
        except (SyntaxError, ValueError) as exc:
            _finish_request(cell_id)
            _send(_error_event(cell_id, exc))
            _send({"event": "done", "id": cell_id, "status": "error"})
            return
        assert _loop is not None
        task = _loop.create_task(_run_codes(codes, ns))
        status, value, error = await _run_guarded(task, cell_id)
        result_text: str | None = None
        if status == "ok" and has_trailing and value is not None:
            try:
                ns["_"] = value
                result_text = repr(value)
            except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is a cell error
                status, error = "error", _error_event(cell_id, exc)
        _drain_output()
        if result_text is not None:
            _send({"event": "result", "id": cell_id, "text": result_text})
        if error is not None:
            _send(error)
        _send({"event": "done", "id": cell_id, "status": status})
    finally:
        _current_cell = None


def _drain_output() -> None:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except OSError:
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
    for name in list(ns.keys()):
        if name.startswith("_") or name in _ALWAYS_SKIP:
            continue
        value = ns[name]
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
            skipped.append({"name": name, "reason": f"{type(err).__name__}: {str(err)[:200]}"})
            continue
        if total + len(blob) > max_bytes:
            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            continue
        payload[name] = blob
        total += len(blob)

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as fh:
            dill.dump(payload, fh)
        os.replace(tmp, path)
    except Exception as err:  # noqa: BLE001 - report any write failure to the host
        try:
            os.remove(tmp)
        except OSError:
            pass
        return {"error": f"write failed: {err}"}

    bytes_written = os.path.getsize(path)
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
    try:
        with open(manifest_path, "w") as fh:
            json.dump(manifest, fh)
    except OSError:
        pass
    for name in pruned:
        ns.pop(name, None)
    return {"saved": saved, "skipped": skipped, "pruned": pruned, "bytes": bytes_written}


def _restore_state(ns: dict[str, Any], path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": []}
    try:
        import dill
    except Exception as err:  # noqa: BLE001
        return {"error": f"dill unavailable: {err}"}
    try:
        with open(path, "rb") as fh:
            payload = dill.load(fh)
    except Exception as err:  # noqa: BLE001 - a corrupt snapshot yields an empty restore
        return {"error": f"load failed: {err}"}
    if not isinstance(payload, dict):
        return {"error": "corrupt snapshot: not a dict"}

    restored: list[str] = []
    failed: list[dict[str, str]] = []
    for name, blob in payload.items():
        if name in _RESTORE_SKIP:
            continue
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except Exception as err:  # noqa: BLE001 - revive every other name regardless
            failed.append({"name": name, "reason": f"{type(err).__name__}: {str(err)[:200]}"})
    return {"restored": sorted(restored), "failed": failed}


async def _handle_state(req: dict[str, Any], ns: dict[str, Any]) -> None:
    """Run snapshot/restore as an interruptible task and reply in the done event."""
    rid = req["id"]

    async def run() -> dict[str, Any]:
        if req["type"] == "snapshot":
            return _snapshot_state(
                ns,
                req["path"],
                req["manifest_path"],
                int(req.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES)),
                int(req.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES)),
                bool(req.get("prune_oversized", False)),
            )
        return _restore_state(ns, req["path"])

    assert _loop is not None
    task = _loop.create_task(run())
    status, result, error = await _run_guarded(task, rid)
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


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        rtype = req.get("type")
        if rtype == "shutdown":
            rid = req.get("id")
            # Kill live bash children before replying so shutdown is prompt even
            # when executor threads are still parked on their handles.
            from .bash import _kill_live_handles

            _kill_live_handles()
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok"})
            return
        if rtype == "execute":
            await _handle_execute(req, ns)
        elif rtype in ("snapshot", "restore"):
            await _handle_state(req, ns)


_REQUIRED_FIELDS = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path", "manifest_path"),
    "restore": ("id", "path"),
    "shutdown": (),
}


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                req = json.loads(raw)
                if not isinstance(req, dict):
                    raise ValueError("request is not a JSON object")
            except ValueError as err:
                _protocol_error(str(err))
                continue
            rtype = req.get("type")
            if rtype == "interrupt":
                target = req.get("id")
                _request_interrupt(target if isinstance(target, str) else None)
                continue
            if rtype not in _REQUIRED_FIELDS:
                _protocol_error(f"unknown request type: {rtype!r}")
                continue
            missing = [f for f in _REQUIRED_FIELDS[rtype] if not isinstance(req.get(f), str)]
            if missing:
                _protocol_error(f"{rtype} request needs string fields: {', '.join(missing)}")
                continue
            if rtype in ("execute", "snapshot", "restore"):
                with _interrupt_lock:
                    _inflight.add(req["id"])
            _loop.call_soon_threadsafe(queue.put_nowait, req)
    # Host closed stdin: shut the runtime down.
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown"})


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
    sys.stdout = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", errors="replace")
    sys.stderr = os.fdopen(os.dup(2), "w", buffering=1, encoding="utf-8", errors="replace")
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
