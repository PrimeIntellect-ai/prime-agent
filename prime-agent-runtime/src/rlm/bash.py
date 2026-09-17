"""Async-by-default shell execution: bash() spawns immediately and returns a live handle."""

from __future__ import annotations

import asyncio
import atexit
import functools
import json
import os
import re
import secrets
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Generator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, NamedTuple, cast

from . import _winjob

_IS_POSIX = os.name == "posix"

if _IS_POSIX:
    import fcntl
    import termios

_HEAD_CAP = 512 * 1024
_TAIL_CAP = 3 * 512 * 1024
_READ_CHUNK = 65536
# Fixed child-side fd for the status channel; POSIX shells (notably dash) only
# guarantee single-digit fds in redirection syntax.
_STATUS_FD = 9
_OUTPUT_FD = 8
_COMPLETION_PREFIX = b"\x1eprime-agent-complete:"
_COMPLETION_SUFFIX = b"\x1f"
# Cancelled one-shot awaits: TERM grace before the group KILL, then the bounded
# wait for a confirmed group exit before CancelledError propagates.
_CANCEL_TERM_GRACE = 0.5
_CANCEL_KILL_WAIT = 2.0
_COMPLETION_NOTICE_COMMAND_CAP = 1000
_ASYNCIO_WRAPPER_CALLBACKS = {
    ("asyncio.tasks", "gather.<locals>._done_callback"),
    ("asyncio.tasks", "shield.<locals>._inner_done_callback"),
    ("asyncio.tasks", "_wait.<locals>._on_completion"),
    ("asyncio.tasks", "as_completed.<locals>._on_completion"),
    ("asyncio.tasks", "_release_waiter"),
}

_live_handles: set["BashHandle"] = set()
_live_lock = threading.Lock()
_hook_installed = False
_hook_lock = threading.Lock()


def _current_cell_completion_context() -> tuple[asyncio.Event, asyncio.Task[Any] | None] | None:
    """Get the creating REPL cell's lifecycle without coupling standalone use to repl."""
    try:
        from . import repl

        if repl.is_active():
            return repl.current_cell_completion_context()
    except (ImportError, RuntimeError):
        pass
    return None


def _consume_notice_task(task: asyncio.Task[None]) -> None:
    """Retrieve detached notifier failures so they never become loop warnings."""
    if not task.cancelled():
        task.exception()


def _completion_reaches(
    start: asyncio.Future[Any], targets: tuple[asyncio.Future[Any], ...]
) -> bool:
    """Follow asyncio's wrapper and TaskGroup ownership callbacks."""
    pending = [start]
    seen_futures: set[int] = set()
    seen_values: set[int] = set()

    def collect(value: Any, depth: int = 0) -> None:
        if isinstance(value, asyncio.Future):
            pending.append(value)
            return
        identity = id(value)
        if depth >= 4 or identity in seen_values:
            return
        seen_values.add(identity)

        nested: list[Any] = []
        if isinstance(value, asyncio.Queue):
            pending.extend(value._getters)
        elif isinstance(value, functools.partial):
            nested.extend((value.func, value.args, value.keywords))
        elif isinstance(value, dict):
            nested.extend(value.keys())
            nested.extend(value.values())
        elif isinstance(value, (tuple, list, set, frozenset)):
            nested.extend(value)
        else:
            closure = getattr(value, "__closure__", None) or ()
            for cell in closure:
                try:
                    nested.append(cell.cell_contents)
                except ValueError:
                    pass
            bound_self = getattr(value, "__self__", None)
            if bound_self is not None:
                nested.append(bound_self)
        for item in nested:
            collect(item, depth + 1)

    while pending:
        future = pending.pop()
        if any(future is target for target in targets):
            return True
        if id(future) in seen_futures:
            continue
        seen_futures.add(id(future))
        for entry in getattr(future, "_callbacks", None) or ():
            callback = entry[0] if isinstance(entry, tuple) else entry
            base = callback.func if isinstance(callback, functools.partial) else callback
            identity = (getattr(base, "__module__", None), getattr(base, "__qualname__", None))
            if identity in _ASYNCIO_WRAPPER_CALLBACKS:
                collect(callback)
            elif identity == ("asyncio.tasks", "_AsCompletedIterator._handle_completion"):
                collect(base.__self__._done)
            elif identity == (None, "Task.task_wakeup"):
                task = getattr(callback, "__self__", None)
                if isinstance(task, asyncio.Task):
                    pending.append(task)
            elif identity == ("asyncio.taskgroups", "TaskGroup._on_task_done"):
                parent = getattr(getattr(callback, "__self__", None), "_parent_task", None)
                if isinstance(parent, asyncio.Future):
                    pending.append(parent)
    return False


def _creating_cell_waits_for(
    owner: asyncio.Task[Any] | None, awaiter: asyncio.Task[Any] | None
) -> bool:
    """Return whether the cell owner directly or transitively waits for awaiter."""
    if owner is None or awaiter is None:
        return False
    if owner is awaiter:
        return True
    waiter = getattr(owner, "_fut_waiter", None)
    targets: tuple[asyncio.Future[Any], ...] = (owner,)
    if isinstance(waiter, asyncio.Future):
        targets += (waiter,)
    return _completion_reaches(awaiter, targets)


def _live_cell_owner() -> asyncio.Task[Any] | None:
    """Body task of the cell executing right now, ignoring detached context copies."""
    try:
        from . import repl

        if repl.is_active():
            return repl.active_cell_task()
    except (ImportError, RuntimeError):
        pass
    return None


@dataclass(frozen=True)
class BashResult:
    exit_code: int
    output: str
    duration: float


class _BoundedBuffer:
    """First _HEAD_CAP bytes plus a rolling _TAIL_CAP-byte tail; the middle is dropped."""

    def __init__(self) -> None:
        self._head = bytearray()
        self._tail: deque[bytes] = deque()
        self._tail_size = 0
        self._dropped = 0
        self._lock = threading.Lock()

    def write(self, chunk: bytes) -> None:
        with self._lock:
            if len(self._head) < _HEAD_CAP:
                take = _HEAD_CAP - len(self._head)
                self._head.extend(chunk[:take])
                chunk = chunk[take:]
            if not chunk:
                return
            self._tail.append(chunk)
            self._tail_size += len(chunk)
            # Trim the oldest chunk instead of dropping it whole so exactly _TAIL_CAP bytes stay.
            while self._tail_size > _TAIL_CAP:
                excess = self._tail_size - _TAIL_CAP
                oldest = self._tail[0]
                if len(oldest) <= excess:
                    self._tail.popleft()
                    self._tail_size -= len(oldest)
                    self._dropped += len(oldest)
                else:
                    self._tail[0] = oldest[excess:]
                    self._tail_size -= excess
                    self._dropped += excess

    def size(self) -> int:
        with self._lock:
            return len(self._head) + self._tail_size

    def text(self) -> str:
        with self._lock:
            head = bytes(self._head)
            tail = b"".join(self._tail)
            dropped = self._dropped
        if not dropped:
            return (head + tail).decode("utf-8", errors="replace")
        marker = f"\n... [{dropped} bytes dropped] ...\n"
        return head.decode("utf-8", errors="replace") + marker + tail.decode("utf-8", errors="replace")


class BashHandle:
    """Live handle to a shell command; await it for the BashResult.

    A handle awaited before any other API use (the `await bash(cmd)` one-shot
    form, including `h = bash(cmd)` awaited immediately) owns the command:
    cancelling that await kills the process group. Touching .pid/.running/
    .output()/.tail()/.poll()/.kill() first marks the handle as a background
    handle; later awaits only wait and cancelling them leaves it running.
    """

    def __init__(self, command: str) -> None:
        self.command = command
        completion_context = _current_cell_completion_context()
        self._creating_cell_finished = completion_context[0] if completion_context else None
        self._creating_cell_task = completion_context[1] if completion_context else None
        self._awaited_by_creating_cell = False
        self._buffer = _BoundedBuffer()
        self._done = threading.Event()
        self._eof = threading.Event()
        self._completion_terminal = threading.Event()
        self._completion_output: str | None = None
        self._completion_lock = threading.Lock()
        self._completion_pending = b""
        self._status: int | None = None
        self._status_known = threading.Event()
        self._reaped = False
        self._result: BashResult | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._reap_callback: Callable[[], None] | None = None
        self._result_consumed = False
        self._consumed_notice: Callable[[], None] | None = None
        self._callback_lock = threading.Lock()
        # Serializes kill/reap so a pid fallback can never outlive the process handle.
        self._kill_lock = threading.Lock()
        self._started = time.monotonic()
        # POSIX: own process group so kill() signals the whole pipeline; Windows
        # contains the tree in a kill-on-close job object.
        self._status_read = -1
        self._wake_read = -1
        self._wake_write = -1
        # True only while the pump moves a chunk from the pipe into the buffer.
        self._pump_transfer = False
        self._job: int | None = None
        self._completion_marker: bytes | None = None
        status_write = -1
        if _IS_POSIX:
            # Full-duplex status channel: the child end rides in as stdin (fd 0)
            # and the script remaps it to _STATUS_FD before swapping in /dev/null
            # (dash rejects multi-digit fds in redirections at parse time). The
            # parent end doubles as the gate: the child blocks on it until the
            # pid is journaled, so a kernel kill in that window cannot leak an
            # unjournaled command (parent death closes the socket -> child exits).
            parent_sock, child_sock = socket.socketpair()
            self._status_read = parent_sock.detach()
            status_write = child_sock.detach()
            try:
                self._wake_read, self._wake_write = os.pipe()
            except BaseException:
                os.close(self._status_read)
                os.close(status_write)
                raise
            completion_token = secrets.token_hex(32)
            # Halves stop passive echoes; a deliberate forgery freezes only this call while later bytes stay live.
            token_midpoint = len(completion_token) // 2
            self._completion_marker = (
                _COMPLETION_PREFIX + completion_token.encode("ascii") + _COMPLETION_SUFFIX
            )
            script = _status_script(
                _with_prefix(command),
                completion_token[:token_midpoint],
                completion_token[token_midpoint:],
            )
        else:
            # Windows lacks a foreground-status channel, so its exit drain stays best-effort.
            script = _with_prefix(command)
            self._job = _winjob.create_job()
            if self._job is None:
                # Nothing spawned yet, so nothing can leak: refuse to start.
                raise RuntimeError("bash(): Windows job containment could not be established")
        try:
            self._proc: subprocess.Popen[bytes] | _winjob.JobProcess
            if _IS_POSIX:
                self._proc = subprocess.Popen(
                    [_shell(), "-c", script],
                    cwd=os.getcwd(),
                    env=_child_env(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    stdin=status_write,
                )
            else:
                self._proc = _winjob.spawn_in_job(
                    self._job, [_shell(), "-c", script], cwd=os.getcwd(), env=_child_env()
                )
        except BaseException:
            for fd in (self._status_read, self._wake_read, self._wake_write):
                if fd >= 0:
                    os.close(fd)
            if self._job is not None:
                job, self._job = self._job, None
                _winjob.close(job)
            raise
        finally:
            if status_write >= 0:
                os.close(status_write)
        self._pid: int = self._proc.pid
        self._released = False
        with _live_lock:
            _live_handles.add(self)
        enrolled = _record_journal(self._pid, active=True)
        if not enrolled:
            # Fail closed: a configured journal that cannot enroll the pid must
            # not let the command run (the host reaper would never see it).
            self._abort_spawn()
            raise RuntimeError(
                "bash(): orphan-journal enrollment failed (journal configured but the "
                "pid could not be recorded); the spawned process was killed"
            )
        if _IS_POSIX:
            # Journal first, then open the gate: the child does not run the user
            # command until this byte arrives. A failed write means the child
            # already died; the status/EOF paths report that normally.
            try:
                os.write(self._status_read, b"\n")
            except OSError:
                pass
        else:
            # The child is already job-contained and journaled; resume is the
            # last step. A failed resume would strand a permanently suspended
            # child: fail closed via the assigned job.
            if not cast("_winjob.JobProcess", self._proc).resume():
                self._abort_spawn()
                raise RuntimeError("bash(): Windows job containment could not be established")
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._report, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()
        self._schedule_background_completion_notice()

    @property
    def pid(self) -> int:
        self._released = True
        return self._pid

    @property
    def running(self) -> bool:
        # Group liveness, matching kill()'s guard and the journal; poll()/await
        # keep foreground result semantics after `cmd &` returns early.
        self._released = True
        return not self._reaped

    def output(self) -> str:
        self._released = True
        self._note_result_consumed()
        return self._buffer.text()

    def tail(self, n: int = 50) -> str:
        self._released = True
        self._note_result_consumed()
        return "\n".join(self._buffer.text().splitlines()[-n:])

    def poll(self) -> BashResult | None:
        self._released = True
        self._note_result_consumed()
        return self._result if self._done.is_set() else None

    def kill(self, sig: int = signal.SIGTERM, grace: float = 5.0) -> None:
        # Guard on group death, not _done: kill() must still reach a lingering
        # background group after the foreground result was already delivered.
        self._released = True
        if self._reaped:
            return
        if not _IS_POSIX:
            with self._kill_lock:
                if self._reaped:  # re-check: _watch may have reaped while we waited
                    return
                if self._job is not None and _winjob.terminate(self._job):
                    return
                # TerminateJobObject failed or reap raced: taskkill fallback.
                if not _taskkill_tree(self._pid):
                    try:
                        self._proc.kill()
                    except OSError:
                        pass
            return
        _signal_group(self._pid, sig)
        if sig == signal.SIGTERM:
            timer = threading.Timer(grace, self._force_kill)
            timer.daemon = True
            timer.start()

    def _force_kill(self) -> None:
        if not self._reaped:
            _signal_group(self._pid, signal.SIGKILL)

    def _pump(self) -> None:
        stdout = self._proc.stdout
        assert stdout is not None
        if not _IS_POSIX:
            try:
                while chunk := stdout.read1(_READ_CHUNK):
                    self._buffer.write(chunk)
            except (OSError, ValueError):
                pass
            stdout.close()
            self._eof.set()
            return
        fd = stdout.fileno()
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(fd, selectors.EVENT_READ)
                while True:
                    sel.select()
                    self._pump_transfer = True
                    try:
                        chunk = os.read(fd, _READ_CHUNK)
                        if not chunk:
                            break
                        self._consume_output(chunk)
                    finally:
                        self._pump_transfer = False
        except (OSError, ValueError):
            pass
        self._abandon_completion()
        try:
            stdout.close()
        except OSError:
            pass
        self._eof.set()

    def _consume_output(self, chunk: bytes) -> None:
        marker = self._completion_marker
        assert marker is not None
        with self._completion_lock:
            if self._completion_terminal.is_set():
                self._buffer.write(chunk)
                return
            data = self._completion_pending + chunk
            marker_at = data.find(marker)
            if marker_at >= 0:
                self._buffer.write(data[:marker_at])
                self._completion_pending = b""
                self._completion_output = self._buffer.text()
                self._completion_terminal.set()
                self._buffer.write(data[marker_at + len(marker) :])
                return
            retained = 0
            for size in range(min(len(data), len(marker) - 1), 0, -1):
                if data.endswith(marker[:size]):
                    retained = size
                    break
            self._buffer.write(data[:-retained] if retained else data)
            self._completion_pending = data[-retained:] if retained else b""

    def _abandon_completion(self) -> None:
        with self._completion_lock:
            if self._completion_terminal.is_set():
                return
            self._buffer.write(self._completion_pending)
            self._completion_pending = b""
            self._completion_terminal.set()

    def _wait_for_completion(self) -> str | None:
        self._completion_terminal.wait()
        return self._completion_output

    def _report(self) -> None:
        # Finalize at foreground completion (status channel), not EOF, so
        # `cmd &` does not hang the await; the shell then `wait`s for its
        # background jobs, keeping the journaled group identity alive.
        status: int | None = None
        try:
            status = self._read_status()
            # Reserve the delivered status before draining so a shell death during
            # the drain window cannot override it with wait()'s signal exit code.
            with self._callback_lock:
                self._status = status
        finally:
            # _watch blocks on this event without a timeout, so every exit path
            # (parsed status, EOF, garbage, exception) must set it.
            self._status_known.set()
        if status is not None:
            output = self._wait_for_completion()
            if output is None:
                self._drain_grace()
            self._finalize(status, output)

    def _watch(self) -> None:
        # Observe shell death independently of the status socket: an early
        # `exit`/`exec`/`set -e`/fatal signal skips `printf`, and background
        # children can hold the socket open past the shell's lifetime.
        exit_code = self._proc.wait()
        if self._wake_write >= 0:
            # Unblock _read_status: background children can hold the status socket
            # open past the shell's lifetime via bash's saved-fd duplicate.
            try:
                os.write(self._wake_write, b"x")
            except OSError:
                pass
            os.close(self._wake_write)
        # _report always sets _status_known (try/finally), so wait indefinitely:
        # a slow reporter can never lose a delivered status to wait()'s code.
        self._status_known.wait()
        with self._callback_lock:
            delivered = self._status
        if delivered is None and not self._done.is_set():
            self._abandon_completion()
            self._drain_grace()
            self._finalize(exit_code)
        with self._kill_lock:
            delivered = self._reap_group()
            self._reaped = True
            if not _IS_POSIX:
                # Reaped: pid fallbacks are gone, so the handle may finally close.
                cast("_winjob.JobProcess", self._proc).close()
        with self._callback_lock:
            callback, self._reap_callback = self._reap_callback, None
        if callback is not None:
            callback()
        if delivered:
            _record_journal(self._pid, active=False)
        with _live_lock:
            _live_handles.discard(self)

    def _reap_group(self) -> bool:
        # Group liveness, not leader death, gates the inactive record: members
        # that outlive the leader would leak behind a stale journal anchor.
        if not _IS_POSIX:
            # Terminate then close the last handle: kill-on-close reaps
            # stragglers. An unproven terminate falls back to taskkill; if
            # that also fails the record stays active for the host reaper.
            delivered = False
            if self._job is not None:
                delivered = _winjob.terminate(self._job)
                job, self._job = self._job, None
                _winjob.close(job)
            return delivered or _taskkill_tree(self._pid)
        try:
            os.killpg(self._pid, 0)
        except ProcessLookupError:
            return True  # group already gone
        except PermissionError:
            pass
        return _signal_group(self._pid, signal.SIGKILL)

    def _read_status(self) -> int | None:
        if self._status_read < 0:
            return None
        try:
            # DefaultSelector (kqueue/epoll) instead of select(): select() rejects
            # fds >= FD_SETSIZE (1024) even when the process fd limit is higher.
            with selectors.DefaultSelector() as sel:
                sel.register(self._status_read, selectors.EVENT_READ)
                sel.register(self._wake_read, selectors.EVENT_READ)
                line = b""
                while b"\n" not in line:
                    ready = {key.fd for key, _ in sel.select()}
                    # Prefer status bytes: any status write happens before shell exit,
                    # so it is already readable whenever the wake fd fires.
                    if self._status_read not in ready:
                        break  # shell died without writing a status
                    chunk = os.read(self._status_read, 64)
                    if not chunk:
                        break  # EOF without a full status line
                    line += chunk
            return int(line)
        except (OSError, ValueError):
            return None
        finally:
            os.close(self._status_read)
            os.close(self._wake_read)

    def _drain_grace(self) -> None:
        # Best-effort fallback when process exit/EOF arrives without a sentinel.
        deadline = time.monotonic() + 0.5
        size = self._buffer.size()
        while time.monotonic() < deadline:
            if self._eof.wait(0.05):
                return
            # A chunk between pipe read and buffer commit (transfer flag) is
            # invisible to both FIONREAD and the buffer size; wait it out.
            if self._pipe_pending() or self._pump_transfer:
                size = self._buffer.size()
                continue
            current = self._buffer.size()
            if current == size:
                return
            size = current

    def _pipe_pending(self) -> bool:
        # POSIX only: FIONREAD on the capture pipe; Windows keeps the
        # quiescence heuristic (best-effort parity).
        if not _IS_POSIX or self._eof.is_set():
            return False
        stdout = self._proc.stdout
        if stdout is None:
            return False
        try:
            pending = struct.unpack("i", fcntl.ioctl(stdout.fileno(), termios.FIONREAD, struct.pack("i", 0)))[0]
        except (OSError, ValueError):
            return False
        return pending > 0

    def _finalize(self, exit_code: int, output: str | None = None) -> None:
        with self._callback_lock:
            if self._done.is_set():
                return
            self._result = BashResult(
                exit_code=exit_code,
                output=self._buffer.text() if output is None else output,
                duration=time.monotonic() - self._started,
            )
            self._done.set()
            callbacks = self._callbacks
            self._callbacks = []
        for callback in callbacks:
            callback()

    def _add_done_callback(self, callback: Callable[[], None]) -> None:
        with self._callback_lock:
            if not self._done.is_set():
                self._callbacks.append(callback)
                return
        callback()

    def _note_result_consumed(self, awaiter: asyncio.Task[Any] | None = None) -> None:
        """Record a result read that reaches the model: only reads during a live
        cell count (a detached reader between turns must keep the notice — it is
        the idle session's only wake-up), and an awaiting reader must be one the
        live cell waits for."""
        if not self._done.is_set():
            return
        owner = _live_cell_owner()
        if owner is None:
            return
        if awaiter is not None and not _creating_cell_waits_for(owner, awaiter):
            return
        with self._callback_lock:
            if self._result_consumed:
                return
            self._result_consumed = True
            notice, self._consumed_notice = self._consumed_notice, None
        if notice is not None:
            notice()

    def _schedule_background_completion_notice(self) -> None:
        cell_finished = self._creating_cell_finished
        if cell_finished is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        from . import repl

        activity = {"id": secrets.token_hex(16), "pid": self._pid, "active": True}
        # Publish synchronously before bash() returns and the creating cell can end.
        repl.emit({"application/vnd.prime-agent.bash-activity+json": activity})
        notice = self._notify_background_completion(cell_finished, activity)
        try:
            task = loop.create_task(notice)
        except BaseException:
            self.kill(signal.SIGKILL if _IS_POSIX else signal.SIGTERM)
            notice.close()
            repl.emit({"application/vnd.prime-agent.bash-activity+json": {**activity, "active": False}})
            raise
        task.add_done_callback(_consume_notice_task)

    async def _notify_background_completion(
        self, cell_finished: asyncio.Event, activity: dict[str, Any]
    ) -> None:
        from . import repl

        try:
            result = await self._wait()
            await self._wait_reaped()
            # The cell may do other work before awaiting this handle. Do not classify
            # it as detached until that whole cell has crossed its completion barrier.
            await cell_finished.wait()
            if self._awaited_by_creating_cell or self._result_consumed or not repl.is_active():
                return
            command = self.command
            if len(command) > _COMPLETION_NOTICE_COMMAND_CAP:
                command = command[:_COMPLETION_NOTICE_COMMAND_CAP] + "\n... [command truncated]"
            reply = await repl.host_request(
                {
                    "type": "bash.completed",
                    "pid": self._pid,
                    "command": command,
                    "exitCode": result.exit_code,
                }
            )
            if isinstance(reply, dict) and reply.get("status") == "ok":
                # Notice accepted by the host; later reads must ask it to withdraw.
                self._arm_consumed_notice(command)
            else:
                sys.stderr.write(
                    f"Background bash completion follow-up for pid {self._pid} was not accepted. "
                    "Inspect the saved handle with poll(), output(), or tail().\n"
                )
        except (OSError, RuntimeError):
            # Standalone runtimes have no host handler, and teardown can close
            # the bridge while a process is finishing. Shell results stay usable.
            return
        finally:
            # Reap and deliver (or report rejection) before releasing kernel residency.
            repl.emit({"application/vnd.prime-agent.bash-activity+json": {**activity, "active": False}})

    def _arm_consumed_notice(self, command: str) -> None:
        # Armed only post-acceptance: the withdrawal can never overtake its notice.
        loop = asyncio.get_running_loop()

        def dispatch() -> None:
            def start() -> None:
                task = loop.create_task(self._notify_result_consumed(command))
                task.add_done_callback(_consume_notice_task)

            try:
                loop.call_soon_threadsafe(start)
            except RuntimeError:
                pass  # notifying loop already closed

        with self._callback_lock:
            if not self._result_consumed:
                self._consumed_notice = dispatch
                return
        dispatch()

    async def _notify_result_consumed(self, command: str) -> None:
        from . import repl

        if not repl.is_active():
            return
        try:
            await repl.host_request(
                {"type": "bash.consumed", "pid": self._pid, "command": command}
            )
        except (OSError, RuntimeError):
            return  # bridge closed at teardown; old hosts error-reply — both fine

    async def _wait_reaped(self) -> None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()

        def wake() -> None:
            try:
                loop.call_soon_threadsafe(lambda: future.done() or future.set_result(None))
            except RuntimeError:
                pass

        with self._callback_lock:
            if self._reaped:
                return
            self._reap_callback = wake
        try:
            await future
        finally:
            with self._callback_lock:
                if self._reap_callback is wake:
                    self._reap_callback = None

    async def _wait(self) -> BashResult:
        # Asyncio-native wakeup: no executor thread is parked for the command's
        # duration, so many concurrent awaits cannot exhaust the default pool.
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()

        def _wake() -> None:
            try:
                loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(None))
            except RuntimeError:
                pass  # awaiting loop already closed

        self._add_done_callback(_wake)
        await fut
        assert self._result is not None
        return self._result

    async def _wait_owned(self) -> BashResult:
        # One-shot `await bash(cmd)` owns the process: a cancelled await (e.g.
        # a kernel interrupt) must not leave the command running. TERM, bounded
        # grace, group KILL, then a bounded confirmed-exit wait before the
        # CancelledError propagates, so no side effect can land after it.
        try:
            return await self._wait()
        except asyncio.CancelledError:
            # Signal synchronously first: even if the cleanup awaits below are
            # re-cancelled, TERM is already delivered and the escalation timer
            # armed. The confirm wait runs as a shielded task so repeated
            # cancels of this task cannot skip it (they re-raise into awaits
            # inside this except block); the loop re-awaits until it finishes
            # (the confirm coroutine itself is bounded).
            self.kill(grace=_CANCEL_TERM_GRACE)
            confirm = asyncio.ensure_future(self._confirm_group_exit())
            while not confirm.done():
                try:
                    await asyncio.shield(confirm)
                except asyncio.CancelledError:
                    continue
            raise

    async def _confirm_group_exit(self) -> None:
        if not await self._await_group_death(_CANCEL_TERM_GRACE):
            if _IS_POSIX:
                _signal_group(self._pid, signal.SIGKILL)
            else:
                # kill() holds the escalation lock; to_thread keeps the loop free.
                await asyncio.to_thread(self.kill)
            await self._await_group_death(_CANCEL_KILL_WAIT)

    def _group_alive(self) -> bool:
        if not _IS_POSIX:
            job = self._job  # snapshot: _watch may clear it concurrently
            if job is not None:
                # Job accounting sees detached descendants a dead leader hides.
                empty = _winjob.is_empty(job)
                if empty is not None:
                    return not empty
            return self._proc.poll() is None
        try:
            os.killpg(self._pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True

    async def _await_group_death(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self._group_alive():
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.02)
        return True

    def _abort_spawn(self) -> None:
        # Enrollment or containment failed before the gate opened (POSIX) or
        # while the child is still suspended, before resume (Windows): kill
        # the child and unwind the handle before threads start.
        if _IS_POSIX:
            for fd in (self._status_read, self._wake_read, self._wake_write):
                if fd >= 0:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self._status_read = self._wake_read = self._wake_write = -1
            delivered = _signal_group(self._pid, signal.SIGKILL)
        else:
            with self._kill_lock:
                delivered = False
                if self._job is not None:
                    delivered = _winjob.terminate(self._job)
                    job, self._job = self._job, None
                    _winjob.close(job)
                if not delivered:
                    # Pre-resume abort: the never-run leader has no descendants, so a
                    # delivered kill retires the journal record.
                    try:
                        self._proc.kill()
                        delivered = True
                    except OSError:
                        pass
        if self._proc.stdout is not None:
            self._proc.stdout.close()
        # The blocking wait stays outside the lock: hProcess is still open, so a
        # concurrent raw-pid fallback stays pinned to the right process.
        try:
            self._proc.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
        with self._kill_lock:
            self._reaped = True
            if not _IS_POSIX:
                # Reaped commits before close: later lock holders skip raw-pid fallbacks.
                cast("_winjob.JobProcess", self._proc).close()
        with _live_lock:
            _live_handles.discard(self)
        if delivered:
            _record_journal(self._pid, active=False)

    def __await__(self) -> Generator[Any, None, BashResult]:
        # A handle awaited before any other API use is a one-shot command tied
        # to the await (kill-on-cancel); touching the handle API first marks it
        # as a deliberate background handle whose awaits only wait.
        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None
        creating_cell_waited = _creating_cell_waits_for(self._creating_cell_task, current_task)
        owned = not self._released
        wait = self._wait_owned() if owned else self._wait()
        self._released = True
        completed = False
        try:
            result = yield from wait.__await__()
            completed = True
            return result
        finally:
            if (completed or owned) and (
                creating_cell_waited
                or _creating_cell_waits_for(self._creating_cell_task, current_task)
            ):
                self._awaited_by_creating_cell = True
            if completed:
                self._note_result_consumed(current_task)

    def __repr__(self) -> str:
        state = f"exit_code={self._result.exit_code}" if self._result else "running"
        return f"<BashHandle pid={self._pid} {state} command={self.command!r}>"


# ---------------------------------------------------------------------------
# Destructive-git dirty-tree guard. Ported from the coding-agent bash tool
# (packages/coding-agent/src/core/tools/bash.ts); the command taxonomy and
# bypass semantics must stay identical between the two tools. On top of the
# shared taxonomy, this port additionally hardens eval-wrapped payloads,
# attached short options, shell line continuations, and shell redirections
# (hardening the coding-agent tool still lacks; port it back when touching
# that file).

# Bypass env var for the destructive-git dirty-tree guard. Read once at
# kernel start (module import) and frozen: it is a user-launch option, not a
# mid-session switch (see _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START); the
# per-call allow_destructive_git kwarg is the only in-session bypass.
BASH_DESTRUCTIVE_GIT_BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_GIT"

GIT_STATUS_PORCELAIN_COMMAND = "git status --porcelain --untracked-files=all"

# How many dirty paths the refusal lists before eliding the rest.
MAX_DIRTY_PATHS_LISTED = 10

# The probe is read-only, but a wedged git must not wedge the kernel. Killing
# the probe's process group normally closes its output pipe at once; the grace
# only bounds the wait for the reading thread to notice.
_PROBE_TIMEOUT_SECONDS = 10.0
_PROBE_KILL_GRACE_SECONDS = 1.0
# Bound the parsed probe output; dirtiness beyond the cap still triggers the
# refusal, so a huge tree cannot grow the message without limit.
_PROBE_OUTPUT_CAP_BYTES = 64 * 1024


class DestructiveGitRefusalError(RuntimeError):
    """A destructive git discard was refused on a dirty working tree."""


@dataclass(frozen=True)
class _DiscardProbeTarget:
    """Where a discard command's probe must run.

    A `cd` chain earlier in the command and `git -C <dir>` on the discard
    invocation both relocate the repository being discarded, so the probe
    follows them instead of assuming the kernel cwd.
    """

    relocation_prefix: str | None = None
    git_status_command: str = GIT_STATUS_PORCELAIN_COMMAND


class _UnresolvableDiscardTarget:
    """The probe cannot safely determine the repository the discard targets."""


_UNRESOLVABLE_DISCARD_TARGET = _UnresolvableDiscardTarget()


@dataclass(frozen=True)
class _DiscardSite:
    """One destructive git discard found in a scanned command.

    `index` is where the `git` word starts in the scanned text. `revealed`
    marks a discard that shows up only after a command word was revealed to a
    value holding more than a bare executable word (for example
    `G='git -C sub reset --hard'; $G`): the shell runs that value as argv, but
    the guard cannot name the repository it relocates to from the text, so it
    refuses instead of probing a directory the text does not name.
    """

    index: int
    revealed: bool

# Detection for git commands that discard uncommitted working-tree changes
# (the "clean the worktree" discard idiom). Conservative by design: a false
# positive costs one `git status` probe and an explicit-bypass retry; a false
# negative silently loses work. Matching is best-effort shell-text
# heuristics, not a parse.

# Optional git global options between `git` and the subcommand, for example
# `git -C dir reset --hard`, `git -c key=value checkout -- .`, or
# `git --git-dir=dir/.git reset --hard`. Kept within one shell segment
# (no ;&|) so it cannot swallow the rest of a chained command.
#
# The option token and the separate value word that may follow it are written
# as disjoint shapes, so each token has exactly one reading: a `-`-led token
# is another option rather than the value of the one before it (git reads it
# as an option too), a `--` token cannot also parse as a one-dash token, and
# the value's unquoted run never starts with `-`. Two readings of the same
# argv cost nothing while the command matches and everything when it does
# not: the engine then tries every re-partitioning of `git -x -x ... -x
# status` before rejecting it, and one model-supplied cell hangs the kernel.
# Disjoint shapes leave exactly one way to consume each token, so the scan
# stays linear.
_GIT_OPTION_TOKEN = r'''-(?:-[^\s;&|]*|[^-\s;&|][^\s;&|]*)'''
_GIT_OPTION_VALUE = r'''(?:"[^"]*"|'[^']*'|[^-\s;&|][^\s;&|]*)'''
_GIT_GLOBAL_OPTIONS = (
    r"(?:" + _GIT_OPTION_TOKEN + r"(?:\s+" + _GIT_OPTION_VALUE + r")?\s+)*"
)
# A pathspec read from a file (`--pathspec-from-file=X`, or `-` for stdin) can
# name any path, `.` and `:/` included, so the option itself carries the same
# weight as an inline pathspec: the discard matches and the dirtiness probe
# decides. The value is read with its quoting masked, exactly like the tokens
# around it; a `--`-terminated checkout that repeats the token as a literal
# pathspec names a file git cannot find, so matching it is only the same
# conservative refusal the plain pathspec forms already take.
_PATHSPEC_FROM_FILE = r"""--pathspec-from-file(?:=\S+|\s+\S+)"""

_DISCARD_CHECKOUT_PATTERN = re.compile(
    r"\bgit\s+"
    + _GIT_GLOBAL_OPTIONS
    + r"checkout\s+"
    + r"""(?:(?:(?:-[fm]|--ours|--theirs|--conflict=\S+)\s+)*(?:(?:--\s+)?(?:\./?|:/)|"""
    + _PATHSPEC_FROM_FILE
    + r""")"""
    + r"""|[^\s;&|()]+\s+(?:(?:--\s+)?(?:\./?|:/)|"""
    + _PATHSPEC_FROM_FILE
    + r""")"""
    + r"""|(?:-f|--force)\s+[^\s;&|()]+)(?=\s|$|[;&|)])"""
)
# Restore options accepted before the pathspec; the capture lets the finder
# check whether staged (index-only) or worktree flags are in play. Every
# option is one token (`-sHEAD`, `--source=HEAD`, `-qs`, `--worktree`), with an
# optional separate value (`-s HEAD`, `--source HEAD`) that covers the tree-ish
# of the value-taking spellings, so `_restore_options_discard_worktree` reads
# exactly the tokens the shell would and stays in step with the getopt rule
# encoded in it. Unknown options fall through to its default (worktree
# restore), the fail-closed direction: patch mode (`-p`) is refused too,
# because a non-interactive kernel shell cannot answer its prompts. The option
# and value shapes are the ones the global options use, so a run of repeated
# `--source` tokens cannot re-partition exponentially here either.
_RESTORE_OPTION = re.compile(
    _GIT_OPTION_TOKEN + r"(?:\s+" + _GIT_OPTION_VALUE + r")?\s+"
)
_DISCARD_RESTORE_PATTERN = re.compile(
    r"\bgit\s+"
    + _GIT_GLOBAL_OPTIONS
    + r"restore\s+"
    + r"((?:"""
    + _RESTORE_OPTION.pattern
    + r""")*)"""
    + r"""(?:"""
    + _PATHSPEC_FROM_FILE
    + r"""|\./?|:/)(?=\s|$|[;&|)])"""
)


def _restore_options_discard_worktree(option_region: str) -> bool:
    """`git restore` targets the working tree by default; `--staged`/`-S`
    alone restores only the index. Bundled shorts keep their meaning
    (`-SW` restores both targets), but the tree-ish value of `-s`/`--source`
    is data: a source ref named `STASH` is not a cluster of short flags."""
    worktree = False
    staged = False
    source_value_next = False
    for token in re.split(r"\s+", option_region):
        if not token:
            continue
        if source_value_next:
            source_value_next = False
            continue  # the tree-ish value, not a flag cluster
        if token == "--":
            break  # everything after -- is a pathspec
        if token.startswith("--"):
            if token.startswith("--worktree"):
                worktree = True
            elif token.startswith("--staged"):
                staged = True
            elif token == "--source":
                source_value_next = True  # `--source HEAD`
            continue
        flags = token[1:]
        if "s" in flags:
            # getopt: the first `s` in a cluster takes the rest of the token
            # as its value (`-sHEAD`), or the next word when it ends there.
            index = flags.index("s")
            source_value_next = index == len(flags) - 1
            flags = flags[:index]
        if "W" in flags:
            worktree = True
        if "S" in flags:
            staged = True
    if worktree:
        return True
    if staged:
        return False
    return True  # no flags: default worktree restore
_DISCARD_RESET_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"reset\s+(?:(?:-[^\s;&|]+)\s+)*--hard\b"
)
_DISCARD_CLEAN_PATTERN = re.compile(
    # The argument region ends at a newline: the shell ends the command there,
    # so a `-n` on the following line (`git clean -f` + newline + `echo -n`) is
    # not a dry-run flag for this segment.
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"clean(?=\s|$|[;&|)])([^;&|\n]*)"
)


def _starts_comment(text: str, index: int) -> bool:
    """True when the `#` at `index` opens a comment.

    The shell starts a comment only at the beginning of a word, so a `#` inside
    a word (`foo#bar`) is literal text and comments are judged the same way by
    every pass that walks the command text.
    """
    return text[index] == "#" and (
        index == 0 or text[index - 1].isspace() or text[index - 1] in ";&|(){}"
    )


def _separates_commands(text: str) -> bool:
    """True when `text` holds an unquoted shell separator.

    The text between two words can carry `;`, `&`, `|`, a newline, or a
    grouping parenthesis, all of which end the simple command that ran before
    them (redirections do not and are masked out before this runs).
    """
    return any(ch in ";&|\n()" for ch in text)


def _join_line_continuations(command: str) -> str:
    """Remove backslash-newline line continuations the way the shell does.

    Bash deletes an unquoted or double-quoted backslash-newline pair
    entirely, so `r\\\n`m -rf x` is the single token sequence `rm -rf x`;
    the space-preserving rewrite below would see `r  m` and miss it.
    Positions in the result no longer map back to the source, which is fine
    for the rm guard: every downstream scan runs on this joined form.
    Single-quoted pairs are literal data and stay; a newline always ends a
    comment, so comments are passed through whole."""
    out: list[str] = []
    quote: str | None = None
    comment = False
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if comment:
            out.append(ch)
            if ch == "\n":
                comment = False
        elif quote is None:
            if ch in ('"', "'"):
                quote = ch
                out.append(ch)
            elif ch == "#" and (i == 0 or command[i - 1] in " \t\r\n;&|(){}"):
                comment = True
                out.append(ch)
            elif ch == "\\" and i + 1 < n:
                if command[i + 1] == "\n":
                    pass  # the shell removes the pair: tokens on both sides join
                else:
                    # The escape keeps the next character from opening a
                    # quoted span (`\'` is a literal quote, not a span).
                    out.append(ch)
                    out.append(command[i + 1])
                i += 1
            else:
                out.append(ch)
        elif quote == "'":
            out.append(ch)
            if ch == "'":
                quote = None
        else:  # double quotes
            if ch == "\\" and i + 1 < n and command[i + 1] == "\n":
                i += 1  # removed inside double quotes too
            else:
                out.append(ch)
                if ch == '"':
                    quote = None
                elif ch == "\\" and i + 1 < n:
                    out.append(command[i + 1])
                    i += 1
        i += 1
    return "".join(out)


def _segment_separator(text: str, from_end: bool = True) -> str | None:
    """The separator nearest one end of `text`, or None when it has none.

    `from_end` picks the separator that ends the command before the text, which
    says whether that command was piped or backgrounded; otherwise it picks the
    one that starts the command after it, which says whether that command runs
    in the current shell.
    """
    indices = range(len(text) - 1, -1, -1) if from_end else range(len(text))
    for index in indices:
        ch = text[index]
        if ch not in ";&|\n()":
            continue
        doubled = text[index - 1] if from_end and index else text[index + 1 : index + 2]
        if ch == "&" and doubled == "&":
            return "&&"
        if ch == "|" and doubled == "|":
            return "||"
        return ch
    return None


# A function definition: `function NAME {` or `NAME() {`. The guard does not
# model when a function is called or which shell it runs in, so a body that can
# change directory leaves a later discard's directory unknowable.
# A function name may hold hyphens in both spellings (`function f-g { ... }`
# and `f-g() { ... }` are definitions bash accepts), so the name class must
# read them or the body below is never examined.
# The function name is captured (either `function NAME` or the `NAME ()`
# form) so the shadowing reader can read it through quoting and escapes.
_FUNCTION_DEFINITION = re.compile(
    r"(?:\bfunction\s+([A-Za-z_][A-Za-z0-9_-]*)|\b([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\))\s*\{"
)


def _brace_group_end(text: str, open_index: int) -> int:
    """Index just past the `}` closing the `{` at `open_index`, or `len(text)`."""
    depth = 0
    for index in range(open_index, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return len(text)


def _defines_directory_changing_function(prefix: str) -> bool:
    """True when `prefix` defines a function that can change directory.

    The definition and its body extent are read on masked text, so quoting
    and comments cannot confuse the brace scan, and the guard does not model
    invocation or shell scope: a body that cds (or pushds) is treated like
    the other relocations it cannot replay, refusing instead of replaying a
    directory the shell may never choose. The body itself is then read the
    way the shell runs it, because quoting does not stop a builtin: `"cd"
    sub`, `c\\d sub` and `'cd' sub` change directory like the plain
    spelling, so its command words are read with escapes removed and quoting
    stripped, while a quoted argument (`echo "cd"`) stays inert data.
    """
    masked_prefix = _mask_quoted_spans(prefix)
    for match in _FUNCTION_DEFINITION.finditer(masked_prefix):
        body_end = _brace_group_end(masked_prefix, match.end() - 1) - 1
        if re.search(r"\b(?:cd|pushd)\b", masked_prefix[match.end() : body_end]):
            return True
        revealed_body = _strip_shell_escapes(prefix[match.end() : body_end])[0]
        for word in _shell_word_positions(revealed_body):
            if word.command and _plain_word_text(
                revealed_body[word.start : word.end]
            ) in ("cd", "pushd"):
                return True
    return False


def _defines_git_shadowing_function(prefix: str) -> bool:
    """True when `prefix` defines a function named `git`.

    The definition shadows the `git` the discard patterns matched, so every
    later `git` word in the command runs the function instead
    (`git() { command git -C sub "$@"; }; git reset --hard` discards the
    nested repository while the resolver would probe the caller), and the
    repository the discard targets is code the guard cannot replay. Like the
    directory-changing bodies, a definition is treated as if it ran: the
    guard does not model invocation or shell scope, so it refuses instead of
    probing a repository the discard may never touch. A quoted name does
    not shadow (`"git"()` is not a definition bash accepts), and a
    differently named function never runs for a later bare `git` word.
    """
    masked_prefix = _mask_quoted_spans(prefix)
    for match in _FUNCTION_DEFINITION.finditer(masked_prefix):
        name = match.group(1) or match.group(2)
        if _plain_word_text(_strip_shell_escapes(name)[0]) == "git":
            return True
    return False


def _builtin_words(words: list[str]) -> list[str]:
    """`words` with the wrapper words and their own options dropped.

    `command` and `builtin` run the word after them, and their own options come
    before that word (`command -p unset GIT_DIR`), so a builtin is only found by
    reading past both. The wrapper's spelling is revealed, because quoting and
    escapes do not stop it (`"command" -p unset GIT_DIR` removes the name).
    """
    index = 0
    while index < len(words):
        head = _revealed_word_text(words[index])
        if head in _TRANSPARENT_BUILTINS:
            index += 1
            while index < len(words) and _revealed_word_text(words[index]).startswith("-"):
                index += 1  # `command "-p" unset GIT_DIR` removes the name too
            continue
        break
    return words[index:]


def _installs_relocating_trap(prefix: str) -> bool:
    """True when `prefix` installs a trap whose action can change directory.

    A trap action runs in the shell that installed it, so one that cds moves
    the shell a following discard runs in, and the guard does not model when a
    trap fires: refuse instead of probing the caller. The signal name is not
    read, because each of them can run before the discard - `DEBUG` before
    every command, `ERR` after a failing one, a signal trap when its signal
    arrives - and the action is the part that relocates. Clearing a trap
    (`trap - DEBUG`) has no action and is left alone, and an `EXIT` action is
    refused with the rest rather than special-cased: the cost is one refused
    command on a dirty tree, never lost work.
    """
    masked = _mask_quoted_spans(prefix)
    # The names the text set are read too: `A=trap; $A 'cd sub' DEBUG` installs
    # the same trap with a revealed builtin.
    known = _reveal_shell_command_words(prefix)[4]
    written, revealed, revealed_segment = _revealed_words(prefix, known)
    for index, word in enumerate(_shell_word_positions(revealed_segment)):
        if not word.command or revealed[index] != "trap":
            continue
        region_end = len(prefix)
        for j in range(written[index].end, len(masked)):
            if masked[j] in ";&|\n":
                region_end = j
                break
        # The action is the first argument that is not one of trap's own
        # options (`trap -- 'cd sub' DEBUG`), and it is read after unquoting,
        # so a quoted action (`trap 'cd sub' DEBUG`) is judged as the shell
        # runs it.
        start = written[index].end
        for candidate in _shell_word_positions(prefix[start : region_end]):
            raw = prefix[start + candidate.start : start + candidate.end]
            # trap's own options come first, and their spelling is revealed so a
            # quoted one counts (`trap '--' 'cd sub' DEBUG` really installs the
            # trap: bash reads the quoted `--` as its option terminator).
            option = _revealed_word_text(raw)
            if option.startswith("-"):
                if re.fullmatch(r"-[A-Za-z]*[pl][A-Za-z]*", option):
                    break  # `trap -p`/`trap -l` prints or lists: nothing installed
                continue
            # The whole action is read, because a trap action may be a command
            # list (`trap 'true; cd sub' DEBUG`) and the cd can come after a
            # command that does not move the shell. A trap that does not
            # relocate is not the end of the search: an earlier harmless trap
            # must not hide a later relocating one.
            if _prefix_holds_directory_command(_unquote_one_level(raw)):
                return True
            break  # the action is read: the words after it are signal names
    return False


def _runs_in_current_shell(opens_with: str | None, closes_with: str | None) -> bool:
    """True when a command between those two separators changes this shell.

    `unalias` only affects the shell that runs it, so a name is dropped only
    for a command that runs in the current shell: a pipeline stage, a
    background command, and a `( ... )` group all run in a subshell, while `;`,
    a newline, `&&` and `||` do not.
    """
    subshell = ("|", "&", "(", ")")
    return opens_with not in subshell and closes_with not in subshell


def _normalize_line_continuations(command: str) -> str:
    """Collapse unquoted backslash-newline line continuations to spaces.

    The shell runs `git reset \
--hard` (one backslash before the newline) as a single `git reset --hard`
    command, so the discard patterns must see through continuations. The
    replacement is length-preserving so the scan's
    character indices stay aligned with the original command. Single-quoted
    backslash-newlines are literal data and a newline always ends a comment,
    so those are left untouched (both are still masked or live as before).
    """
    chars = list(command)
    quote: str | None = None
    comment = False
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if comment:
            if ch == "\n":
                comment = False
        elif quote is None:
            if ch in ('"', "'"):
                quote = ch
            elif _starts_comment(chars, i):
                comment = True
            elif ch == "\\" and i + 1 < n and chars[i + 1] == "\n":
                chars[i] = " "
                chars[i + 1] = " "
                i += 1
        elif quote == "'":
            if ch == "'":
                quote = None
        elif ch == '"':
            quote = None
        elif ch == "\\" and i + 1 < n:
            i += 1  # inside double quotes the mask already folds escapes
        i += 1
    return "".join(chars)


def _backtick_end(text: str, start: int, limit: int) -> int:
    """Index one past the backtick that closes the one at `start`.

    A backslash escapes the next character inside backticks, and a span
    without its closing backtick runs to `limit`.
    """
    i = start + 1
    while i < limit:
        if text[i] == "\\" and i + 1 < limit:
            i += 2
            continue
        if text[i] == "`":
            return i + 1
        i += 1
    return limit


def _substitution_end(text: str, start: int, limit: int) -> int:
    """Index of the `)` that closes the `$(` whose `(` is at `start`.

    Only an unquoted `)` closes the substitution, quoting inside it starts
    fresh, and parentheses nest, so `"$(echo ")")"` ends at its last `)`
    instead of the one inside the quoted argument. Returns `limit` when the
    substitution never closes.
    """
    depth = 0
    quote: str | None = None
    i = start
    while i < limit:
        ch = text[i]
        if quote == "'":
            if ch == "'":
                quote = None
        elif quote == '"':
            if ch == '"':
                quote = None
            elif ch == "\\" and i + 1 < limit:
                i += 1
            elif ch == "$" and text[i + 1 : i + 2] == "(":
                i = _substitution_end(text, i + 1, limit) - 1
            elif ch == "`":
                i = _backtick_end(text, i, limit) - 1
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "\\" and i + 1 < limit:
            i += 1
        elif ch == "`":
            i = _backtick_end(text, i, limit) - 1
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return limit


def _heredoc_delimiter(command: str, start: int) -> tuple[int, int, str, bool] | None:
    """The delimiter word of a heredoc whose `<<` operator ends at `start`.

    Returns `(word_start, word_end, delimiter, expands)`. A quoted or escaped
    delimiter (`<<'EOF'`, `<<"EOF"`, `<<\\EOF`) turns expansion off, so
    `expands` is False and the whole body is inert data. A delimiter the shell
    would build from a variable or a substitution is unknowable and yields
    None: its body then stays live for the scan.
    """
    i = start
    n = len(command)
    while i < n and command[i].isspace():
        i += 1  # the shell takes its delimiter word from the next word
    word_start = i
    while i < n and not command[i].isspace() and command[i] not in ";&|<>()":
        i += 1
    word = command[word_start:i]
    if not word or "$" in word or "`" in word:
        return None
    if len(word) > 2 and word[0] in ("'", '"') and word[-1] == word[0]:
        return word_start, i, word[1:-1], False
    if word.startswith("\\"):
        return word_start, i, word[1:], False
    return word_start, i, word, True


def _heredoc_body_end(
    command: str, line_end: int, delimiter: str, strip_tabs: bool = False
) -> int | None:
    """Just past the line that ends a heredoc body, or None when it never ends.

    `line_end` is the newline that ends the line holding the `<<` operator:
    the body starts on the line after it, so what a command line carries after
    the delimiter (`cat <<EOF && git reset --hard`) still runs. The shell ends
    the body on a line that is exactly the delimiter, with leading tabs
    stripped for a `<<-` heredoc and nothing else stripped, so a body the
    shell keeps reading (`EOF   `, a `<<-EOF` terminator that is not tab
    indented) is never ended early here. A body without its terminator keeps
    its text live: the shell would read the rest of the command as heredoc
    data, which the scan cannot know.
    """
    pos = command.find("\n", line_end)
    while pos != -1:
        line_stop = command.find("\n", pos + 1)
        line = command[pos + 1 :] if line_stop == -1 else command[pos + 1 : line_stop]
        if (line.lstrip("\t") if strip_tabs else line) == delimiter:
            return len(command) if line_stop == -1 else line_stop
        pos = line_stop
    return None


def _mask_heredoc_body(
    chars: list[str], command: str, start: int, end: int, expands: bool
) -> None:
    """Blank heredoc data in place.

    A heredoc body never executes as shell commands. With an unquoted
    delimiter the shell still expands `$(...)` and backtick spans before cat
    sees the text, and those execute, so they stay live for the discard scan.
    A quoted or escaped delimiter turns expansion off and the whole body,
    substitutions included, is inert data.
    """
    if not expands:
        for i in range(start, end):
            chars[i] = " "
        return
    i = start
    while i < end:
        ch = command[i]
        if ch == "$" and command[i + 1 : i + 2] == "(":
            i = _substitution_end(command, i + 1, end) + 1
        elif ch == "`":
            i = _backtick_end(command, i, end)
        else:
            chars[i] = " "
            i += 1


# A shell redirection word: optional fd, the operator, an optional &fd
# duplication (which has no filename target), and an attached target (empty
# for the `2> file` split form). Targets containing quotes, substitution, or
# process-substitution syntax stay live: masking them could hide a command
# substitution that executes.
_REDIRECT_OPERATOR = re.compile(r"(?:&>{1,2}|>&|[0-9]*[<>]{1,3}(&[0-9]+)?)")
_STATIC_REDIRECT_TARGET = re.compile(r"""[^\s;&|<>()$`"']*""")


def _mask_shell_redirections(command: str) -> str:
    """Blank out shell redirection words, keeping character positions.

    The shell consumes redirections (`2>/dev/null`, `> log`, `2>&1`,
    `</dev/null`, heredoc markers) before git sees its argv, so a discard
    like `git reset 2>/dev/null --hard` must scan as `git reset --hard`.
    Only the operator and a fully static attached or next-word target are
    masked (pure syntax); quoted data, comments, command substitution, and
    process substitution stay live so the guard keeps seeing what executes.
    """
    chars = list(command)
    quote: str | None = None
    comment = False
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if comment:
            if ch == "\n":
                comment = False
            i += 1
            continue
        if quote is None:
            if ch in ('"', "'"):
                quote = ch
                i += 1
                continue
            if _starts_comment(chars, i):
                comment = True
                i += 1
                continue
            if ch == "\\" and i + 1 < n:
                i += 2  # escaped character stays as-is
                continue
            operator = _REDIRECT_OPERATOR.match(command, i)
            if operator:
                for j in range(operator.start(), operator.end()):
                    chars[j] = " "
                i = operator.end()
                if operator.group(0) == "<<":
                    # `<<-` drops the `-` from its delimiter word and lets the
                    # terminator line be tab indented, so both the word to
                    # match and the line to end on change; the `-` itself is
                    # redirection syntax and is blanked with the operator.
                    tabbed = command[i : i + 1] == "-"
                    if tabbed:
                        chars[i] = " "
                    heredoc = _heredoc_delimiter(command, i + 1 if tabbed else i)
                    if heredoc is not None:
                        # A heredoc body is inert data: blank it up to its
                        # delimiter line. An unquoted delimiter still expands
                        # command substitution (which executes), so those spans
                        # stay live; a quoted one turns expansion off entirely.
                        # Without a terminator, leave the text live (conservative).
                        word_start, word_end, delimiter, expands = heredoc
                        for j in range(word_start, word_end):
                            chars[j] = " "
                        line_end = command.find("\n", word_end)
                        body_end = (
                            _heredoc_body_end(command, line_end, delimiter, tabbed)
                            if line_end != -1
                            else None
                        )
                        if body_end is not None:
                            _mask_heredoc_body(chars, command, line_end + 1, body_end, expands)
                        i = word_end
                        continue
                attached = _STATIC_REDIRECT_TARGET.match(command, i)
                if attached.end() > i:
                    target_start, target_end = attached.start(), attached.end()
                elif operator.group(1):
                    # A `2>&1` duplication carries its own target; the next
                    # word belongs to the command, not the redirection.
                    target_start = target_end = i
                else:
                    # `2> /dev/null`: a bare operator takes the next word.
                    j = i
                    while j < n and chars[j].isspace():
                        j += 1
                    detached = _STATIC_REDIRECT_TARGET.match(command, j)
                    if detached.end() > j and j > i:
                        target_start, target_end = detached.start(), detached.end()
                    else:
                        target_start = target_end = i
                for j in range(target_start, target_end):
                    chars[j] = " "
                i = target_end
                continue
        elif quote == "'":
            if ch == "'":
                quote = None
        elif ch == '"':
            quote = None
        elif ch == "\\" and i + 1 < n:
            i += 1  # escaped character inside double quotes stays
        elif ch == "$" and chars[i + 1 : i + 2] == "(":
            # Command substitution inside double quotes still executes; mask
            # redirections inside it too (its own redirects are syntax). An
            # unclosed substitution is a shell error: the text after it stays
            # live instead of being scanned as its interior.
            close = _substitution_end(command, i + 1, n)
            if close < n:
                interior = _mask_shell_redirections(command[i + 2 : close])
                chars[i + 2 : close] = list(interior)
                i = close
        elif ch == "`":
            close = _backtick_end(command, i, n)
            if close < n:
                interior = _mask_shell_redirections(command[i + 1 : close - 1])
                chars[i + 1 : close - 1] = list(interior)
                i = close - 1
        i += 1
    return "".join(chars)


def _strip_shell_escapes(command: str) -> tuple[str, list[int]]:
    """Remove unquoted backslash escapes, mapping indices back to the input.

    The shell treats an unquoted `\\X` as a literal X, so `g\\it reset
    --ha\\rd` must scan as `git reset --hard`. Quoted and commented spans
    keep their backslashes: those are data or syntax handled elsewhere.
    """
    chars: list[str] = []
    index_map: list[int] = []
    quote: str | None = None
    comment = False
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if comment:
            chars.append(ch)
            index_map.append(i)
            if ch == "\n":
                comment = False
            i += 1
        elif quote is None:
            if ch in ('"', "'"):
                quote = ch
                chars.append(ch)
                index_map.append(i)
            elif ch == "#" and (i == 0 or re.match(r"[\s;&|(){}]", command[i - 1])):
                comment = True
                chars.append(ch)
                index_map.append(i)
            elif ch == "\\" and i + 1 < n and command[i + 1] != "\n":
                chars.append(command[i + 1])  # literal X: drop the backslash
                index_map.append(i + 1)
                i += 1
            else:
                chars.append(ch)
                index_map.append(i)
            i += 1
        else:
            chars.append(ch)
            index_map.append(i)
            if quote == "'":
                if ch == "'":
                    quote = None
            elif ch == '"':
                quote = None
            elif ch == "\\" and i + 1 < n:
                chars.append(command[i + 1])
                index_map.append(i + 1)
                i += 1
            i += 1
    return "".join(chars), index_map


def _mask_quoted_spans(command: str) -> str:
    """Blank out quoted data and comments, keeping character positions.

    The discard matcher must not match quoted data (for example
    `echo 'git reset --hard'`) or comments, but command substitution
    (`$(...)`, backticks) stays live because it executes.
    """
    chars = list(command)
    quote: str | None = None
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if quote is None:
            # An unquoted # at a word boundary starts a comment; mask to the
            # end of the line.
            if _starts_comment(chars, i):
                j = i
                while j < n and chars[j] != "\n":
                    chars[j] = " "
                    j += 1
                i = j
                continue
            if ch in ('"', "'"):
                quote = ch
        elif quote == "'":
            # No expansion happens inside single quotes; mask it all.
            if ch == "'":
                quote = None
            else:
                chars[i] = " "
        elif ch == '"':
            quote = None
        elif ch == "\\" and i + 1 < n:
            chars[i] = " "
            chars[i + 1] = " "
            i += 1
        elif ch == "$" and i + 1 < n and chars[i + 1] == "(":
            # Command substitution inside double quotes still executes; keep
            # it live, but its interior is a fresh shell context: quoted data
            # inside it must stay data (recursively masked). A substitution
            # that never closes is a shell error, and the text after it is
            # left live rather than masked as quoted data.
            close = _substitution_end(command, i + 1, n)
            if close < n:
                interior = _mask_quoted_spans(command[i + 2 : close])
                chars[i + 2 : close] = list(interior)
                i = close - 1
        elif ch == "`":
            # Backtick substitution inside double quotes still executes; keep
            # it live, masking quoted data in its interior like $(). An
            # unclosed backtick is a shell error, and the text after it stays
            # live: masking it as data would hide a later discard
            # (`cat <<EOF` with `$(echo "`")` in its body still runs the
            # command that follows the heredoc).
            close = _backtick_end(command, i, n)
            if close < n:
                interior = _mask_quoted_spans(command[i + 1 : close - 1])
                chars[i + 1 : close - 1] = list(interior)
                i = close - 1
        else:
            chars[i] = " "
        i += 1
    return "".join(chars)


# The command word the shell would execute, when it can be rebuilt from the
# text: plain character runs joined by quoting only, or a `$NAME`/`${NAME}`
# reference to a literal assignment of the git executable earlier in the same
# command. Anything holding spaces, expansion, or substitution stays unknown
# and is left as written for the masking pass below.
_PLAIN_WORD_RUN = re.compile(r"[A-Za-z0-9_./-]+")
_VARIABLE_REFERENCE = re.compile(r"\$(?:([A-Za-z_][A-Za-z0-9_]*)\b|\{([A-Za-z_][A-Za-z0-9_]*)\})")
# A literal assignment the shell would apply: only a word the shell reads at
# command position, or an argument of `export` and its siblings, sets a name.
# A bare word, or a quoted word sequence with no expansion or substitution
# (`G=git`, `G=/usr/bin/git`, `G='git reset --hard'`).
_LITERAL_ASSIGNMENT = re.compile(
    r"""([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"$`]*)"|'([^']*)'|([A-Za-z0-9_./-]+))"""
)
# An assignment whose whole value is a reference to a known name copies that
# value into the new name (`H="$G"`), which the walk can follow one level.
_COPIED_ASSIGNMENT = re.compile(
    r"""([A-Za-z_][A-Za-z0-9_]*)=(?:"?\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})"?)"""
)
# A literal assignment the probe can replay verbatim: no quoting, expansion,
# or substitution.
_REPLAYABLE_ASSIGNMENT = re.compile(r'''[A-Za-z_][A-Za-z0-9_]*=[^\s$`;&|()<>"]+''')
# A `NAME=value` shell word in front of a command word. Its value may be a
# quoted word (`FOO="a b"`), which the shell applies but the probe cannot
# replay as one token.
_ASSIGNMENT_WORD = re.compile(
    r"""[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|()<>"']*)"""
)
# The commands whose arguments the shell applies as assignments, so the names
# stay set after the command (`readonly` and the declaration builtins included).
_EXPORT_COMMANDS = frozenset({"export", "declare", "typeset", "local", "readonly"})
# Builtins that run the next word as a command themselves: an assignment in
# front of them (`G=other command export H=1`) is scoped to that one command.
_TRANSPARENT_BUILTINS = frozenset({"command", "builtin"})
# Reserved words that introduce a command instead of being one, so the word
# after them is still at command position (`then eval ...`, `{ cd sub; }`).
_SHELL_KEYWORDS = frozenset(
    {
        "{", "}", "!", "if", "then", "elif", "else", "fi", "while", "until",
        "do", "done", "for", "in", "case", "esac", "select", "time", "function",
    }
)


class _ShellWord(NamedTuple):
    """One shell word and the position the shell gives it.

    `assignment` is True when the shell reads a `NAME=value` word there and
    `keeps` when it also leaves that name set after the command, which is what
    `export G=git` and its siblings do. `command` marks the word the shell
    would execute (an `eval` there runs its payload). `open_prefix` holds when
    the simple command still has no command word after this word: only then
    does a bare prefix assignment survive, because any command word scopes it
    to that one command.
    """

    start: int
    end: int
    assignment: bool
    keeps: bool
    command: bool
    open_prefix: bool


def _shell_word_positions(command: str) -> list[_ShellWord]:
    """Spans of the shell words in `command`, with the position each one holds.

    Quotes never end a word and braces stay inside one (`${G}` is a single
    word), exactly as the discard patterns expect. Comment text is not a shell
    word at all and is skipped, so neither an argument nor a comment word can
    pass for the real assignment or the real command. The family builtins keep
    their own options (`declare -xi`, `local -r`, `declare --`) from ending the
    run of assignments they apply, and `command`/`builtin` run the word after
    them without taking the command word for themselves.
    """
    words: list[_ShellWord] = []
    assignment_slot = True
    command_word = True
    export_args = False
    prefix_open = True
    function_name = False
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if ch == "#" and _starts_comment(command, i):
            line_stop = command.find("\n", i)
            i = n if line_stop == -1 else line_stop
            continue
        if ch.isspace() or ch in ";&|()<>":
            if ch in ";&|\n()":
                assignment_slot = command_word = prefix_open = True
                export_args = False
                function_name = False
            i += 1
            continue
        start = i
        quote: str | None = None
        while i < n:
            ch = command[i]
            if quote is None:
                if ch in ('"', "'"):
                    quote = ch
                elif ch.isspace() or ch in ";&|()<>":
                    break
            elif ch == quote:
                quote = None
            i += 1
        word = command[start:i]
        # The flags describe this word's own position, so they are read before
        # the word moves the parser on.
        at_slot = assignment_slot or export_args
        keeps_name = export_args
        is_command_word = command_word and word not in _TRANSPARENT_BUILTINS
        is_function_word = command_word and word == "function"
        if is_function_word:
            pass  # `function NAME { ... }`: the name is no command word
        elif function_name:
            is_command_word = False  # the name of a `function` definition
        elif command_word and word in _SHELL_KEYWORDS:
            pass  # a keyword opens the next command position
        elif (assignment_slot or export_args) and (
            _LITERAL_ASSIGNMENT.fullmatch(word) or _COPIED_ASSIGNMENT.fullmatch(word)
        ):
            pass  # an assignment prefix: the command word still follows
        elif command_word and word in _TRANSPARENT_BUILTINS:
            prefix_open = False  # it runs a command, but not as the command word
        elif command_word and word in _EXPORT_COMMANDS:
            command_word = prefix_open = False
            export_args = True
            assignment_slot = True  # the words after it are assignments
        elif export_args and word.startswith("-"):
            pass  # the family's own options (`declare -xi`, `local -r`)
        else:
            assignment_slot = command_word = prefix_open = False
            export_args = False
        function_name = is_function_word
        words.append(
            _ShellWord(
                start,
                i,
                assignment=at_slot,
                keeps=keeps_name,
                command=is_command_word,
                open_prefix=prefix_open,
            )
        )
    return words


def _plain_word_text(word: str) -> str | None:
    """The word's text when quoting is its only shell syntax, else None."""
    content: list[str] = []
    i = 0
    n = len(word)
    while i < n:
        if word[i] in ('"', "'"):
            close = word.find(word[i], i + 1)
            if close == -1:
                return None  # unterminated quoting: leave the text alone
            run = word[i + 1 : close]
            # An empty quoted run contributes nothing (`g''it` is `git`),
            # so it stays plain; only a non-empty run needs validating.
            if run and not _PLAIN_WORD_RUN.fullmatch(run):
                return None
            content.append(run)
            i = close + 1
            continue
        run = _PLAIN_WORD_RUN.match(word, i)
        if run is None:
            return None
        content.append(run.group(0))
        i = run.end()
    return "".join(content) or None


def _revealed_shell_word(word: str, assignments: dict[str, str]) -> str | None:
    """The command word the shell would execute for `word`, when knowable."""
    reference = _VARIABLE_REFERENCE.fullmatch(word)
    if reference is None and len(word) > 2 and word[0] == word[-1] == '"':
        # Double quotes still expand; single quotes never do.
        reference = _VARIABLE_REFERENCE.fullmatch(word[1:-1])
    if reference is not None:
        return assignments.get(reference.group(1) or reference.group(2))
    return _plain_word_text(word)


def _apply_unalias(aliases: dict[str, str], words: list[str]) -> None:
    """Apply one `unalias` invocation the way bash parses it.

    Bash reads `unalias [-a] [--] NAME...` with getopt: the first operand ends
    the option list, `--` ends it explicitly, and an option token it rejects
    (`unalias -n g`, `unalias -an g`) makes the builtin remove nothing at all.
    So an unknown `-` token keeps every alias defined, which only adds
    detection, and a name is dropped only when the shell would drop it.
    """
    clears_all = False
    names: list[str] = []
    options = True
    for word in words:
        if options and word.startswith("-") and word != "-":
            if word == "--":
                options = False
            elif word == "-a":
                clears_all = True
            else:
                return  # bash rejects this option and removes nothing
        else:
            options = False  # the first operand ends the option list
            names.append(word)
    if clears_all:
        aliases.clear()
    for name in names:
        aliases.pop(_plain_word_text(name) or name, None)


def _reveal_shell_command_words(
    command: str,
    resolve_aliases: bool = True,
    aliases: dict[str, str] | None = None,
    assignments: dict[str, str] | None = None,
) -> tuple[str, list[int], set[int], dict[str, str], dict[str, str]]:
    """Rebuild each shell word the way the shell executes it.

    Quoting is stripped before exec, so `"git"` and `g'it'` run `git`, and a
    `$G` reference to an earlier literal assignment runs that value (`G=git`,
    or `G='git reset --hard'` as a word sequence). Revealing those words keeps
    the discard patterns shell-faithful. A word holding spaces, expansion, or
    substitution stays as written, so quoted data (`echo 'git reset --hard'`)
    still masks as data. Only a word the shell reads as an assignment is
    recorded, so a `G=other` argument or comment can never overwrite the real
    value, and a command-scoped prefix (`G=other git status`) is dropped again
    because the shell applies it to that one command. An `alias NAME=VALUE`
    command word in the scanned text (the replayed prefix included) is
    resolved the same way: a later command word spelled NAME runs VALUE. The
    shell's own options are not visible to a static scan, so a visible alias
    is resolved even in a shell that would not expand it, and an alias value
    the walk cannot read verbatim registers nothing, so the word stays as
    written instead of vanishing. The walk is flat, so an assignment inside a
    command substitution (`$(G=git; true); $G reset --hard`) stays visible and
    is refused: that leaks an inner scope outward and so refuses more, not
    less.

    The returned map points every emitted character back into `command`, and
    the returned set holds the words whose revealed value is more than a bare
    executable word: the shell runs such a value as argv, but the probe cannot
    name the repository it runs in, so a discard found through one is refused.
    The returned alias and assignment maps are the ones the walk ended with, so
    a caller that re-reads text the shell parses later (an `eval` payload)
    starts from the names this text defined. The returned eval map holds, for
    each `eval` command word's position in the revealed text, the names live
    at that eval, because a reassignment after the eval must not replace the
    value its payload expands.
    """
    assignments = dict(assignments) if assignments else {}
    pending: dict[str, str] = {}
    aliases = dict(aliases) if aliases else {}
    alias_args = False
    unalias_words: list[str] | None = None
    eval_live: dict[int, tuple[dict[str, str], dict[str, str]]] = {}
    out: list[str] = []
    index_map: list[int] = []
    unnameable: set[int] = set()
    cursor = 0
    prefix_open = True
    opened_with: str | None = None
    for word in _shell_word_positions(command):
        out.append(command[cursor : word.start])
        index_map.extend(range(cursor, word.start))
        gap = command[cursor : word.start]
        if _separates_commands(gap):
            closes_with = _segment_separator(gap, from_end=False)
            # A new simple command: a bare prefix of the previous one survives
            # only when that command held no other word, because the shell then
            # applies the assignment to the shell itself. This mirrors the rule
            # the probe resolver applies to its own segments, and the two must
            # stay in step.
            if prefix_open:
                assignments.update(pending)
            pending.clear()
            alias_args = False
            if unalias_words is not None:
                if _runs_in_current_shell(opened_with, closes_with):
                    _apply_unalias(aliases, unalias_words)
                unalias_words = None  # a subshell keeps its aliases to itself
            opened_with = _segment_separator(gap)
        cursor = word.end
        text = command[word.start : word.end]
        plain = _plain_word_text(text)
        revealed = _revealed_shell_word(text, assignments)
        if resolve_aliases and word.command and plain is not None and text == plain:
            # A command word spelled like an alias this text defined runs the
            # alias value, so reveal it exactly as a `$NAME` reference is
            # revealed. An unquoted word only: the shell does not expand a
            # quoted alias name.
            alias = aliases.get(plain)
            if alias is not None:
                revealed = alias
        # The builtin can be spelled by a word that only reveals to it
        # (`A=alias; $A g=git`), so the check reads the revealed text too.
        spoken = _plain_word_text(revealed) if revealed is not None else plain
        if word.command and spoken == "eval":
            # The names live at this eval are the ones its payload expands,
            # so they are recorded at the eval's revealed position: an
            # assignment or alias redefined after the eval must not hide the
            # value the payload runs. `pending` joins the snapshot because a
            # command-scoped prefix applies to the eval it precedes.
            eval_live[len(index_map)] = (dict(aliases), {**assignments, **pending})
        elif word.command and spoken == "alias":
            alias_args = True  # the words after the builtin are definitions
        elif word.command and spoken == "unalias":
            if unalias_words is not None:
                _apply_unalias(aliases, unalias_words)
            unalias_words = []  # the words after it are its operands
        elif unalias_words is not None:
            unalias_words.append(text)
        elif alias_args:
            definition = _LITERAL_ASSIGNMENT.fullmatch(text)
            if definition:
                aliases[definition.group(1)] = next(
                    group for group in definition.groups()[1:] if group is not None
                )
            else:
                alias_args = False  # not a definition (`alias -p`, a bare name)
        replacement = text if revealed is None else revealed
        if revealed is not None:
            # A revealed value is data the shell runs as a word, never shell
            # syntax: an unbalanced quote or a `#` in it would otherwise pair
            # with the text after it and hide a later discard from masking.
            replacement = re.sub(r"""["'#\\]""", "_", replacement)
            if len(replacement) < len(text):
                # Keep the revealed word from running into the next one.
                replacement = replacement.ljust(len(text))
        out.append(replacement)
        if replacement == text:
            index_map.extend(range(word.start, word.end))
        else:
            # A revealed match starts at this word's first character.
            index_map.extend([word.start] * len(replacement))
            if not _PLAIN_WORD_RUN.fullmatch(revealed):
                unnameable.add(word.start)
        if word.assignment:
            assignment = _LITERAL_ASSIGNMENT.fullmatch(text)
            if assignment:
                # A later reference to this name execs this literal value, so
                # the word walk reveals it verbatim; the discard patterns then
                # judge the value exactly as they judge the bare spelling. The
                # last literal assignment wins, so a reassignment replaces the
                # value. A reassignment the guard cannot read (substitution or
                # expansion) keeps the earlier value, which is the
                # conservative direction.
                name, value = assignment.group(1), next(
                    group for group in assignment.groups()[1:] if group is not None
                )
                if word.keeps:
                    # `export G=git` and its siblings set the shell's own name.
                    assignments[name] = value
                    pending.pop(name, None)
                else:
                    pending[name] = value
            else:
                copied = _COPIED_ASSIGNMENT.fullmatch(text)
                source = copied and (copied.group(2) or copied.group(3))
                # The shell applies the assignments of one command left to
                # right, so a value set earlier in this command (pending) is
                # the one the copy expands; only a name this command has not
                # reassigned falls back to the value an earlier segment left
                # (assignments). Reading them the other way kept the older
                # value and hid the discard the copy carried.
                inherited = source and (
                    pending.get(source) or assignments.get(source)
                )
                if inherited:
                    target = assignments if word.keeps else pending
                    target[copied.group(1)] = inherited
        prefix_open = word.open_prefix
    out.append(command[cursor:])
    index_map.extend(range(cursor, len(command)))
    return "".join(out), index_map, unnameable, aliases, assignments, eval_live


def _is_destructive_clean_segment(args: str) -> bool:
    """True when a `git clean` segment can delete untracked files.

    A force flag is one route but not the only one: without one, git still
    deletes whenever `clean.requireForce` is false in any config the command
    reads (`-c`, the `GIT_CONFIG_*` environment, the repository, or the
    user), and a static scan cannot see those settings. So every segment
    but a dry run matches and the dirtiness probe decides: on a tree the
    probe finds dirty the refusal is required when the config disables the
    force requirement and harmless otherwise (git refuses the unforced
    clean itself), and a clean tree has nothing untracked to delete.
    """
    tokens = [token for token in re.split(r"\s+", args) if token]
    # Everything after -- is a pathspec, not options (git clean -f -- -n is forced).
    if "--" in tokens:
        option_tokens = tokens[: tokens.index("--")]
    else:
        option_tokens = tokens
    return not any(
        token == "--dry-run"
        or (token.startswith("-") and not token.startswith("--") and "n" in token)
        for token in option_tokens
    )


def _scan_discard_sites(
    normalized: str,
    index_map: list[int],
    resolve_aliases: bool,
    aliases: dict[str, str] | None = None,
    assignments: dict[str, str] | None = None,
) -> list[_DiscardSite]:
    """Find the discards in already-normalized text, mapped back to the input."""
    words, word_map, unnameable, _aliases, _assignments, _eval_live = _reveal_shell_command_words(
        normalized, resolve_aliases=resolve_aliases, aliases=aliases, assignments=assignments
    )
    masked = _mask_quoted_spans(words)
    matches: list[tuple[int, int]] = []
    for pattern in (_DISCARD_CHECKOUT_PATTERN, _DISCARD_RESET_PATTERN):
        matches.extend((match.start(), match.end()) for match in pattern.finditer(masked))
    for match in _DISCARD_RESTORE_PATTERN.finditer(masked):
        if _restore_options_discard_worktree(match.group(1)):
            matches.append((match.start(), match.end()))
    for match in _DISCARD_CLEAN_PATTERN.finditer(masked):
        if _is_destructive_clean_segment(match.group(1)):
            matches.append((match.start(), match.end()))
    return [
        _DiscardSite(
            index_map[word_map[start]],
            # Any revealed word inside the match can carry part of the argv the
            # shell runs (`X=git Y='-C sub reset --hard'; $X $Y`), so the whole
            # span decides, not just where it starts.
            any(word_map[index] in unnameable for index in range(start, end)),
        )
        for start, end in sorted(matches)
    ]


def _find_destructive_git_discard_sites(
    command: str,
    aliases: dict[str, str] | None = None,
    assignments: dict[str, str] | None = None,
) -> list[_DiscardSite]:
    """Find every destructive git discard command in `command`, returning
    where each `git` token starts (empty when none match). `aliases` and
    `assignments` seed the names a caller already knows about, so text the
    shell parses later (an `eval` payload) resolves a name the outer text
    defined."""
    normalized, index_map = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(command))
    )
    sites = _scan_discard_sites(
        normalized, index_map, resolve_aliases=True, aliases=aliases, assignments=assignments
    )
    if "alias" in normalized:
        # A shell expands an alias defined in this text only when its own
        # options say so, and the scan cannot see them, so the text is read
        # both ways (`alias echo=git; echo reset --hard` discards expanded,
        # while `alias git=echo; git reset --hard` discards unexpanded): a
        # discard under either reading is refused.
        sites.extend(
            _scan_discard_sites(
                normalized,
                index_map,
                resolve_aliases=False,
                aliases=aliases,
                assignments=assignments,
            )
        )
    unique: list[_DiscardSite] = []
    seen: set[tuple[int, bool]] = set()
    for site in sorted(sites, key=lambda site: site.index):
        if (site.index, site.revealed) not in seen:
            seen.add((site.index, site.revealed))
            unique.append(site)
    return unique


def is_destructive_git_discard_command(command: str) -> bool:
    """True when `command` contains a git command that discards uncommitted
    working-tree changes (`git checkout -- .`, `git restore .`,
    `git reset --hard`, `git clean` that is not a dry run: the force
    requirement can be turned off in a config the text cannot see)."""
    return bool(_find_destructive_git_discard_sites(command))


# `eval` re-parses its payload, so a quoted argument that the masking of the
# plain scan must treat as data still executes. Unquote each eval payload one
# shell quoting layer at a time and rescan; a discard found in any layer is
# refused outright because the payload can relocate or chain freely.
_MAX_EVAL_SCAN_DEPTH = 10
# The eval gate reads the command with quoting and escapes dropped, because a
# split-spelled command word (`e\val`, `e'va'l`) still runs the builtin.
_EVAL_GATE_STRIP = re.compile(r"""["'\\]""")

# Alias expansion is iterated to a fixed point; each pass resolves at least one
# link of an alias chain, and a definition is dropped once it has been used, so
# a self-referential alias (`alias rm='rm -rf x'`) cannot grow without bound.
_MAX_ALIAS_EXPANSION_PASSES = 8


def _unquote_one_level(text: str) -> str:
    """Remove the outermost quoting layer from `text`.

    Inner quotes stay quoted so the next scan layer still treats them as
    data: `eval "echo 'git reset --hard'"` must stay harmless after the first
    unquote, while `eval 'cd sub && git reset --hard'` must not. Quote
    characters become spaces so unquoting never joins separate words.
    """
    chars = list(text)
    quote: str | None = None
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if quote is None:
            if ch in ('"', "'"):
                quote = ch
                chars[i] = " "
            elif ch == "\\" and i + 1 < n:
                i += 1  # keep escaped characters as they are
        elif quote == "'":
            if ch == "'":
                quote = None
                chars[i] = " "
        elif ch == '"':
            quote = None
            chars[i] = " "
        elif ch == "\\" and i + 1 < n:
            i += 1  # escaped character inside double quotes stays
        i += 1
    return "".join(chars)


def _eval_payloads_hide_destructive_git(
    command: str,
    depth: int = 0,
    aliases: dict[str, str] | None = None,
    assignments: dict[str, str] | None = None,
) -> bool:
    """True when a quoted `eval` payload hides a destructive git discard.

    Only a real eval is scanned: eval has to be the command word the shell
    runs, so an `eval` argument (`echo eval 'git reset --hard'`) is inert
    text. A quoted or referenced spelling of the word still runs the builtin,
    so the words are revealed first. Each payload is unquoted one layer at a
    time so nested evals and nested quoting levels are handled without ever
    confusing quoted data with executable text. Command substitution stays
    outside this check: its output is unknowable statically, and the
    substitution itself already runs (and is scanned) before eval sees the
    result. The aliases a caller already knows about are carried in, because
    `eval` re-parses its payload at run time, where an alias the outer text
    defined does expand.
    """
    if depth > _MAX_EVAL_SCAN_DEPTH:
        return True  # absurdly nested evals: refuse rather than risk a miss
    command = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(command))
    )[0]
    revealed, _word_map, _unnameable, visible, known, eval_live = _reveal_shell_command_words(
        command, aliases=aliases, assignments=assignments
    )
    if _revealed_eval_payloads_hide_destructive_git(revealed, depth, visible, known, eval_live):
        return True
    if "alias" in command:
        # Same both-ways reading as the discard scan: an alias may or may not
        # be expanded, so the text as written is scanned too.
        (
            as_written,
            _as_map,
            _as_un,
            _as_aliases,
            _as_known,
            as_eval_live,
        ) = _reveal_shell_command_words(
            command, resolve_aliases=False, aliases=aliases, assignments=assignments
        )
        if _revealed_eval_payloads_hide_destructive_git(
            as_written, depth, visible, known, as_eval_live
        ):
            return True
    return False


def _eval_payloads(revealed: str) -> list[tuple[int, str]]:
    """Each `(eval word position, payload)` that a revealed command runs.

    A payload runs from just after the `eval` token to the next unquoted
    command separator (the masked text keeps those live), and substitution
    interiors are not separators because the outer command does not parse them.
    The payload is unquoted one layer so nested quoting levels are read as the
    text eval re-parses. Only a command word runs eval, so an `eval` argument
    (`echo eval 'git reset --hard'`) is not a payload at all.
    """
    masked = _mask_quoted_spans(revealed)
    payloads: list[tuple[int, str]] = []
    for word in _shell_word_positions(revealed):
        if not word.command or _plain_word_text(revealed[word.start : word.end]) != "eval":
            continue
        region_end = len(revealed)
        interior = [
            (word.end + start, word.end + end)
            for start, end in _substitution_interiors(revealed[word.end :])
        ]
        for j in range(word.end, len(masked)):
            if masked[j] in ";&|\n" and not any(
                start <= j < end for start, end in interior
            ):
                region_end = j
                break
        payloads.append((word.start, _unquote_one_level(revealed[word.end : region_end])))
    return payloads


def _revealed_eval_payloads_relocate(
    revealed: str,
    aliases: dict[str, str],
    assignments: dict[str, str],
    eval_live: dict[int, tuple[dict[str, str], dict[str, str]]] | None = None,
) -> bool:
    """True when a revealed command runs eval over a payload that cds or pushds.

    `eval` runs its payload in the current shell, so such a payload moves the
    shell the later discard runs in, and the probe would check the caller. The
    payload is read twice for the reason the discard scan reads the whole text
    twice: eval re-parses it at run time, where a name an earlier command set
    does expand (`alias c=cd`, or `X=cd`, then `eval 'c dirty'` / `eval '$X
    dirty'`) even though the same spelling does not expand in the outer command,
    so a relocation under either reading is refused.
    """
    for start, payload in _eval_payloads(revealed):
        if _prefix_holds_directory_command(payload):
            return True
        # The names live at this eval decide what its payload expands, and the
        # maps the walk ended with are the conservative reading for names it
        # changed later (a reassignment after the eval must not replace the
        # value the payload ran), so both are read.
        readings = [(aliases, assignments)]
        if eval_live and start in eval_live:
            readings.append(eval_live[start])
        for read_aliases, read_assignments in readings:
            if not (read_aliases or read_assignments):
                continue
            expanded = _reveal_shell_command_words(
                payload, aliases=read_aliases, assignments=read_assignments
            )[0]
            if expanded != payload and _prefix_holds_directory_command(expanded):
                return True
    return False


def _eval_payloads_relocate(command: str) -> bool:
    """True when a quoted `eval` payload in `command` can change directory."""
    normalized = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(command))
    )[0]
    revealed, _map, _unnameable, aliases, assignments, eval_live = _reveal_shell_command_words(
        normalized
    )
    return _revealed_eval_payloads_relocate(revealed, aliases, assignments, eval_live)


def _revealed_eval_payloads_hide_destructive_git(
    revealed: str,
    depth: int,
    aliases: dict[str, str],
    assignments: dict[str, str],
    eval_live: dict[int, tuple[dict[str, str], dict[str, str]]] | None = None,
) -> bool:
    """True when a revealed command runs eval over a payload holding a discard.

    `aliases` and `assignments` are the names the scanned text defined (and any
    a caller carried in): the payload is re-parsed by eval at run time, where
    those names run their values, so the payload is read with them resolved as
    well as exactly as written. `eval_live` holds the names live at each eval
    (keyed by the eval word's position in `revealed`), which the payload is
    also read with: the final maps are the conservative reading for names
    defined later, but the live ones decide what the payload really expands.
    """
    for start, payload in _eval_payloads(revealed):
        live = (eval_live or {}).get(start)
        if live is not None and (live[0] or live[1]):
            if _find_destructive_git_discard_sites(payload, aliases=live[0], assignments=live[1]):
                return True
            if _payload_substitution_hides_a_discard(payload, live[0]):
                return True
        if _find_destructive_git_discard_sites(payload):
            return True
        if _payload_substitution_hides_a_discard(payload, aliases):
            return True
        if aliases or assignments:
            if _find_destructive_git_discard_sites(
                payload, aliases=aliases, assignments=assignments
            ):
                return True
        if "eval" in payload and _eval_payloads_hide_destructive_git(
            payload, depth + 1, aliases, assignments
        ):
            return True
    return False


def _substitution_interiors(text: str) -> list[tuple[int, int]]:
    """Spans of the text inside each `$(...)` and backtick substitution."""
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "$" and text[i + 1 : i + 2] == "(":
            close = _substitution_end(text, i + 1, n)
            spans.append((i + 2, close))
            i = close
        elif text[i] == "`":
            close = _backtick_end(text, i, n)
            spans.append((i + 1, close - 1))
            i = close
        else:
            i += 1
    return spans


def _payload_substitution_hides_a_discard(payload: str, aliases: dict[str, str]) -> bool:
    """True when a substitution in an unrunnable payload can deliver a discard.

    The payload is built at run time, so neither its command word nor the text a
    substitution prints can be judged directly: a substitution whose own text
    (with its quoting removed) holds a discard, or that spells a name whose
    value discards, is refused instead of allowed. Text that discards nothing is
    left alone, and the payload as written is scanned separately.
    """
    discarding = {
        name
        for name, value in aliases.items()
        if _find_destructive_git_discard_sites(value)
    }
    for inner_start, inner_end in _substitution_interiors(payload):
        inner = payload[inner_start:inner_end]
        if _find_destructive_git_discard_sites(_unquote_one_level(inner)):
            return True
        if not discarding:
            continue
        for word in _shell_word_positions(inner):
            spelled = _plain_word_text(inner[word.start : word.end])
            if spelled is not None and spelled in discarding:
                return True
    return False


def _revealed_word_text(word: str, assignments: dict[str, str] | None = None) -> str:
    """The text the shell runs for one written word.

    Quoting and escapes are removed when the value can be read (`"cd"` runs
    `cd`, `c\\d` runs `cd`). A shell keyword or a wrapper keeps its spelling,
    because that is what makes the shell read syntax rather than a command
    there. A `NAME=value` word keeps an assignment's shape, because its value
    may hold characters the plain reader rejects (`HOME=~/x`) while the slot
    it holds still decides where the command word is. Any other word the
    reader cannot name (a substitution) becomes a placeholder: it holds the
    command position the written text gives it without naming a builtin.
    """
    plain = _plain_word_text(_strip_shell_escapes(word)[0])
    if plain is not None:
        return plain
    if assignments:
        # A name the text set can spell the word the shell runs (`A=trap; $A
        # 'cd sub' DEBUG` installs the trap), and only a value that is one
        # plain word is substituted: anything longer would change how many
        # words the revealed text holds, which the caller's position mapping
        # relies on.
        reference = _VARIABLE_REFERENCE.fullmatch(word)
        if reference is None and len(word) > 2 and word[0] == word[-1] == '"':
            reference = _VARIABLE_REFERENCE.fullmatch(word[1:-1])  # `"$A"` still expands
        value = reference and assignments.get(reference.group(1) or reference.group(2))
        if value is not None and _PLAIN_WORD_RUN.fullmatch(value):
            return value
    if word in _SHELL_KEYWORDS or word in _TRANSPARENT_BUILTINS:
        return word  # syntax, not a value
    if _ASSIGNMENT_WORD.fullmatch(word) is not None:
        return "N=x"
    return "x"


def _revealed_words(
    segment: str, assignments: dict[str, str] | None = None
) -> "tuple[list[_ShellWord], list[str], str]":
    """The written words of `segment`, their revealed text, and the text built
    from them with separators, comments, and whitespace left in place.

    Re-reading that text with `_shell_word_positions` gives the word the shell
    executes by the shell's own rules, including spellings the written text
    hides behind quoting or a wrapper (`"cd" sub`, `"command" "cd" sub`). No
    revealed word holds quoting or a separator, so the rebuilt text has
    exactly one word per written word, in the same order.
    """
    written = _shell_word_positions(segment)
    revealed: list[str] = []
    parts: list[str] = []
    cursor = 0
    for word in written:
        parts.append(segment[cursor : word.start])
        revealed.append(_revealed_word_text(segment[word.start : word.end], assignments))
        parts.append(revealed[-1])
        cursor = word.end
    parts.append(segment[cursor:])
    return written, revealed, "".join(parts)


def _directory_command_parts(
    segment: str,
) -> "tuple[str, str, str] | _UnresolvableDiscardTarget | None":
    """The directory builtin a segment's command word runs, with its prefix.

    Returns `(prefix, name, arguments)`: `prefix` holds the words in front of
    the builtin that the probe replays verbatim (command-scoped `NAME=value`
    assignments and the `command`/`builtin` wrappers), `name` is `cd` or
    `pushd` with its quoting and escapes removed, and `arguments` is the
    segment's text after that word, kept as written so the caller still sees
    its quoting. Quoting and escapes do not stop a builtin, and a keyword or a
    wrapper in command position is syntax rather than the command, so the
    reader follows the revealed words (`"command" "cd" sub` and `then cd sub`
    both change directory) until a real command word ends the scan (`echo
    "cd"` is an argument, not a cd). A directory command behind `!` is
    `_UNRESOLVABLE_DISCARD_TARGET`, because the negation decides which branch
    the discard runs in without deciding where the shell ends up. Returns
    `_UNRESOLVABLE_DISCARD_TARGET` when a word the replay would need cannot be
    replayed verbatim, and None for a segment that runs no directory builtin.
    """
    written, revealed, revealed_segment = _revealed_words(segment)
    prefix: list[str] = []
    negated = False
    for index, word in enumerate(_shell_word_positions(revealed_segment)):
        if not word.command:
            continue  # an argument never decides the command
        raw = segment[written[index].start : written[index].end]
        plain = revealed[index]
        if plain in ("cd", "pushd"):
            if negated:
                return _UNRESOLVABLE_DISCARD_TARGET  # `! cd`: see below
            return " ".join(prefix), plain, segment[written[index].end :]
        if plain in _TRANSPARENT_BUILTINS:
            prefix.append(raw)  # `"command" cd` still runs the builtin
        elif plain == "!":
            # `then` and `{` are syntax the command word still follows, but `!`
            # inverts the status of what follows without undoing a relocation:
            # `! cd sub && git reset --hard` discards in the directory the cd
            # reached only when the cd failed (so the caller's), while `! cd
            # sub; git reset --hard` discards in sub itself. Which shell the
            # discard runs in cannot be read from the segment, so a directory
            # command behind `!` is refused rather than replayed as one.
            negated = True
        elif raw == plain and plain in _SHELL_KEYWORDS:
            continue  # shell syntax: the command word still follows
        elif _ASSIGNMENT_WORD.fullmatch(raw) is not None:
            if _REPLAYABLE_ASSIGNMENT.fullmatch(raw) is None:
                return _UNRESOLVABLE_DISCARD_TARGET
            prefix.append(raw)
        else:
            return None  # a real command word: the words after it are arguments
    return None


def _prefix_holds_directory_command(prefix: str) -> bool:
    """True when a word the shell executes in `prefix` could be a builtin.

    The cd-chain reader only has to run when some word the shell would run
    could be `cd` or `pushd`, and quoting and escapes do not stop a builtin
    (`"c"d sub` changes directory), so this gate reads the same revealed words
    the reader reads. A `cd` in argument position (`echo "cd"`) is not a
    command word and does not open the gate by itself.
    """
    _, revealed, revealed_segment = _revealed_words(prefix)
    return any(
        word.command and plain in ("cd", "pushd")
        for word, plain in zip(_shell_word_positions(revealed_segment), revealed)
    )


def _directory_replay(prefix: str, arguments: str) -> str:
    """The `cd` command the probe replays for one entry of a cd chain.

    The words in front of the builtin are part of the relocation: a
    command-scoped `HOME=<dir> cd` lands in that directory while a plain `cd`
    would land in the probe's own `HOME`. Keywords carry no directory and are
    dropped by the reader, so what is left here is replayable verbatim.
    """
    return " ".join(part for part in (prefix, "cd", arguments) if part)


def _resolve_discard_probe_target(
    command: str, discard_index: int, user_command_start: int = 0
) -> "_DiscardProbeTarget | _UnresolvableDiscardTarget | None":
    prefix = command[:discard_index]
    invocation = command[discard_index:]
    # A discard inside the configured command prefix would be replayed by the
    # probe itself; refuse instead of executing it during probing.
    if user_command_start > 0 and discard_index < user_command_start:
        return _UNRESOLVABLE_DISCARD_TARGET
    tokens = re.split(r"\s+", invocation)

    # git -C <dir> (or repository-relocating global options) on the discard
    # invocation itself.
    dash_c_dir: str | None = None
    subcommand_index = -1
    for index, token in enumerate(tokens):
        if index == 0:
            continue  # "git"
        if token in ("reset", "checkout", "clean", "restore"):
            subcommand_index = index
            break
        # Attached short options such as `git -Csub reset --hard` relocate exactly
        # like the space-separated forms, so treat their values the same way.
        if token == "-C" or (token.startswith("-C") and len(token) > 2):
            directory = (
                token[2:]
                if token != "-C"
                else tokens[index + 1] if index + 1 < len(tokens) else None
            )
            # A quoted, escaped, or substituted path cannot be replayed as a
            # single token; refuse rather than probe a truncated directory.
            if not directory or re.search(r"""["'\\$`]""", directory):
                return _UNRESOLVABLE_DISCARD_TARGET
            # Repeated -C paths are relative to the preceding one, so replay
            # the whole sequence instead of keeping only the last directory.
            dash_c_dir = f"{dash_c_dir} -C {directory}" if dash_c_dir else directory
        elif token.startswith(("--git-dir", "--work-tree", "--prefix")):
            return _UNRESOLVABLE_DISCARD_TARGET
        elif token == "-c" or (token.startswith("-c") and len(token) > 2):
            config = (
                token[2:]
                if token != "-c"
                else tokens[index + 1] if index + 1 < len(tokens) else None
            )
            # core.worktree/core.bare relocate the repository the discard targets.
            if config and re.match(r"core\.(worktree|bare)(=|$)", config):
                return _UNRESOLVABLE_DISCARD_TARGET
        elif token.startswith("--config-env"):
            # `--config-env NAME=ENVVAR` (or `--config-env NAME`) sets a config
            # value from the environment, so a `core.worktree`/`core.bare` name
            # relocates the repository exactly like `-c core.worktree=...`, and
            # the probe cannot replay the environment it reads.
            config = (
                token.split("=", 1)[1]
                if token != "--config-env" and "=" in token
                else tokens[index + 1] if index + 1 < len(tokens) else None
            )
            if config and re.match(r"core\.(worktree|bare)(=|$)", config):
                return _UNRESOLVABLE_DISCARD_TARGET
        elif (
            token.startswith("-")
            and not token.startswith("--")
            and re.search(r"[Cc]", token[1:])
        ):
            # Bundled short options that include -C/-c (for example
            # `git -pCsub reset --hard`) relocate the repository in ways the
            # token replay above cannot express; refuse instead of probing
            # the wrong directory.
            return _UNRESOLVABLE_DISCARD_TARGET
        # Other flags do not relocate.

    # git clean -x/-X also deletes ignored files, so its probe must include them.
    clean_removes_ignored = False
    if subcommand_index != -1 and tokens[subcommand_index] == "clean":
        for token in tokens[subcommand_index + 1 :]:
            if token == "--":
                break  # everything after -- is a pathspec
            if token.startswith("--"):
                continue
            if token.startswith("-") and re.search(r"[xX]", token[1:]):
                clean_removes_ignored = True
                break

    # Inline env assignments directly before the git invocation (for example
    # GIT_DIR=.../GIT_WORK_TREE=... git reset --hard) relocate the target
    # repository; replay them in the probe, or refuse when they cannot be.
    env_prefix = ""
    segments = re.split(r"&&|\|\||;|\||\n", prefix)
    last_segment = segments[-1]
    leading_tokens = [token for token in re.split(r"\s+", last_segment.strip()) if token]
    for token in leading_tokens:
        if _REPLAYABLE_ASSIGNMENT.fullmatch(token):
            continue  # replayable assignment
        # Wrappers that cannot change directory or select another repository.
        if token in ("sudo", "env", "command", "builtin") or token.endswith("/"):
            continue
        return _UNRESOLVABLE_DISCARD_TARGET
    assignments = [token for token in leading_tokens if "=" in token]
    # Standalone assignments (with or without `export`) persist across
    # separators in the same shell, so `GIT_DIR=...; git reset --hard` (or
    # the export form) relocates the discard; replay them in the probe, or
    # refuse when an export cannot be replayed verbatim. Assignments inside
    # a mixed segment (for example `FOO=1 git status`) only apply to that
    # command, and a piped segment runs in a subshell, so neither persists.
    persistent_assignments: list[str] = []
    if len(segments) > 1:
        parts = re.split(r"(&&|\|\||;|\||\n)", prefix)
        seg_positions: list[int] = []
        offset = 0
        for index, part in enumerate(parts):
            if index % 2 == 0:
                seg_positions.append(offset)
            offset += len(part)
        for index in range(len(segments) - 1):
            if seg_positions[index] < user_command_start:
                continue  # command-prefix region: replayed verbatim
            # A brace group runs in the current shell, so `{ export GIT_DIR=...
            # ; git reset --hard; }` persists its assignments like bare ones.
            # The bodies a shell keyword introduces (`then`, `do`, `else`,
            # including a `{` inside them) run in the current shell too.
            segment = re.sub(r"^(?:\{\s*|(?:then|do|else)\s+)*", "", segments[index].strip())
            seg_tokens = [token for token in re.split(r"\s+", segment) if token]
            if seg_tokens and seg_tokens[0] in ("source", "."):
                # A sourced script runs in the current shell and may `cd`,
                # so the discard's directory cannot be replayed safely.
                return _UNRESOLVABLE_DISCARD_TARGET
            # `unset` still applies when its segment short-circuits (`||
            # true`), and removing a git-environment variable can change
            # which repository the discard targets while the probe would
            # keep inheriting the variable (`GIT_DIR=sub/.git; unset
            # GIT_DIR; git reset --hard` really discards the caller). A
            # removal cannot be replayed in the probe's assignment prefix,
            # so refuse rather than probe a repository the discard may not
            # touch; a piped unset runs in a subshell and never applies. The
            # builtin is read from the revealed word, because quoting, escapes,
            # and the `command` wrapper do not stop it (`"unset" GIT_DIR`,
            # `\unset GIT_DIR`, and `command unset GIT_DIR` all remove it).
            removal = _builtin_words(seg_tokens)
            if (
                removal
                and _revealed_word_text(removal[0]) == "unset"
                and parts[2 * index + 1] != "|"
                and any(
                    (plain := _plain_word_text(token)) is not None and plain.startswith("GIT_")
                    for token in removal[1:]
                )
            ):
                return _UNRESOLVABLE_DISCARD_TARGET
            if parts[2 * index + 1] not in (";", "&&", "\n"):
                continue  # pipe/subshell or short-circuit: the env does not persist
            if not seg_tokens:
                continue
            if seg_tokens[0] == "export":
                seg_tokens = seg_tokens[1:]
                if not seg_tokens or not all(
                    _REPLAYABLE_ASSIGNMENT.fullmatch(token) for token in seg_tokens
                ):
                    return _UNRESOLVABLE_DISCARD_TARGET
                persistent_assignments.extend(seg_tokens)
            elif all(_REPLAYABLE_ASSIGNMENT.fullmatch(token) for token in seg_tokens):
                persistent_assignments.extend(seg_tokens)
    env_prefix = (
        " ".join(persistent_assignments + assignments) + " "
        if persistent_assignments or assignments
        else ""
    )

    # A function definition whose body can change directory relocates a later
    # discard whenever the function is called, and the guard does not model
    # invocation or shell scope: refuse instead of replaying a guess. A
    # function named `git` shadows the discard itself, so it refuses for the
    # same reason: the repository the wrapped git targets is unknowable.
    if (
        _defines_directory_changing_function(prefix)
        or _defines_git_shadowing_function(prefix)
        or _installs_relocating_trap(prefix)
    ):
        return _UNRESOLVABLE_DISCARD_TARGET

    # cd relocations earlier in the command. cds inside grouping parentheses
    # do not persist: they only matter when the discard itself runs inside the
    # still-open group, tracked via paren depth. Segments before
    # userCommandStart belong to the configured command prefix, which the
    # probe already replays verbatim, so their cds are not re-applied.
    persistent_cd_commands: list[str] = []
    grouped_cd_commands: list[str] = []
    saw_cd = False
    paren_depth = 0
    cd_pending_separator = False
    # The gate reads the revealed command words: quoting and escapes do not
    # stop a builtin (`"c"d sub`), and a keyword or wrapper in front of one does
    # not hide it either (`then cd sub`, `"command" "cd" sub`).
    if _prefix_holds_directory_command(prefix) or "(" in prefix:
        offset = 0
        for part in re.split(r"(&&|\|\||;|\||\n)", prefix):
            start = offset
            offset += len(part)
            if start < user_command_start:
                continue  # command-prefix region: replayed as-is
            if part in ("&&", "||", ";", "|", "\n"):
                if cd_pending_separator and part in (";", "\n"):
                    # The discard's directory depends on the cd succeeding; refuse
                    # instead of probing only one of the two outcomes.
                    return _UNRESOLVABLE_DISCARD_TARGET
                if part in ("||", "|"):
                    if saw_cd:
                        return _UNRESOLVABLE_DISCARD_TARGET  # cd success no longer guaranteed
                    continue
                cd_pending_separator = False
                continue
            trimmed = part.strip()
            opens = len(re.findall(r"\(", part))
            closes = len(re.findall(r"\)", part))
            inside_group = paren_depth > 0 or opens > 0
            paren_depth = max(0, paren_depth + opens - closes)
            if inside_group:
                body = re.sub(r"[)\s]+$", "", re.sub(r"^[(\s]+", "", trimmed))
                directory_command = _directory_command_parts(body)
                if directory_command is _UNRESOLVABLE_DISCARD_TARGET:
                    return _UNRESOLVABLE_DISCARD_TARGET
                if directory_command is not None:
                    prefix_text, name, arguments = directory_command
                    if name == "pushd":
                        # pushd keeps a directory stack the probe cannot replay.
                        return _UNRESOLVABLE_DISCARD_TARGET
                    arg = arguments.strip()
                    if not arg or re.search(r'''[$`;&|()<>#"]''', arg):
                        return _UNRESOLVABLE_DISCARD_TARGET
                    saw_cd = True
                    cd_pending_separator = True
                    grouped_cd_commands.append(_directory_replay(prefix_text, arg))
                elif re.search(r"\b(?:cd|pushd)\b", trimmed):
                    return _UNRESOLVABLE_DISCARD_TARGET  # group content we cannot replay
                # A closed group's cds do not persist and must not leak into a
                # later still-open group's chain.
                if paren_depth == 0:
                    grouped_cd_commands.clear()
                continue
            # Brace groups run in the current shell, so a `{ cd sub && git
            # reset --hard; }` relocates the discard like a bare cd chain.
            group_free = re.sub(r"^\{\s*", "", trimmed)
            directory_command = _directory_command_parts(group_free)
            if directory_command is _UNRESOLVABLE_DISCARD_TARGET:
                return _UNRESOLVABLE_DISCARD_TARGET
            if directory_command is None:
                cd_pending_separator = False
                continue  # not a cd: cannot change cwd
            prefix_text, name, arguments = directory_command
            if name == "pushd":
                return _UNRESOLVABLE_DISCARD_TARGET  # pushd cannot be replayed as a cd
            arg = arguments.strip()
            # An arg we cannot replay safely (substitution, redirection,
            # backgrounding, comments, or quotes split by segmenting) leaves
            # the target repository unknown; refuse rather than probe blindly.
            balanced = arg.count('"') % 2 == 0 and arg.count("'") % 2 == 0
            if not balanced or (arg and re.search(r'''[$`;&|()<>#]''', arg)):
                return _UNRESOLVABLE_DISCARD_TARGET
            saw_cd = True
            cd_pending_separator = True
            persistent_cd_commands.append(_directory_replay(prefix_text, arg))

    # When the discard runs inside a still-open group, its directory is the
    # persistent cd chain inherited by the group plus the group's own cds.
    cd_commands = (
        persistent_cd_commands + grouped_cd_commands if paren_depth > 0 else persistent_cd_commands
    )

    if not cd_commands and dash_c_dir is None and not clean_removes_ignored and not env_prefix:
        return None
    ignored = " --ignored=matching" if clean_removes_ignored else ""
    cd_prefix = " && ".join(cd_commands) + " && " if cd_commands else ""
    if dash_c_dir:
        git_status = f"git -C {dash_c_dir} status --porcelain --untracked-files=all{ignored}"
    else:
        git_status = f"git status --porcelain --untracked-files=all{ignored}"
    # The persistent assignments are replayed twice on purpose. Before the
    # chain they are statements, because a shell variable decides where a later
    # `cd` lands (`CDPATH=<dir>; cd sub` lands in <dir>/sub and a persistent
    # `HOME` decides a bare `cd`); an inline prefix there would scope them to
    # that one `cd` and leave the probe command without them. As the inline
    # prefix of the probe command they are what the command's own environment
    # reads (`GIT_DIR`/`GIT_WORK_TREE`), which is the replay the discard
    # patterns have always used and which an unexported statement does not
    # carry into a child process.
    statement_prefix = (
        " && ".join(persistent_assignments) + " && " if persistent_assignments and cd_commands else ""
    )
    return _DiscardProbeTarget(
        relocation_prefix=(statement_prefix + cd_prefix + env_prefix) or None,
        git_status_command=git_status,
    )


def _is_truthy_env_value(value: str | None) -> bool:
    return value is not None and value not in ("", "0")


# The bypass env var is a user-launch option, not a model-visible switch:
# the kernel snapshots it once at import (kernel start), so a cell that
# writes it mid-session cannot silently disarm the guard. Only the
# per-call allow_destructive_git kwarg is visible to the running model.
_BASH_DESTRUCTIVE_GIT_BYPASS_AT_START = _is_truthy_env_value(
    os.environ.get(BASH_DESTRUCTIVE_GIT_BYPASS_ENV)
)


def _probe_group(process: subprocess.Popen) -> int | None:
    """The probe's process-group id, while it is still the group leader.

    `start_new_session=True` makes the probe the leader of a fresh group, so
    its group survives the child itself: a descendant that keeps the output
    pipe open is reached by a group kill. Read while the child is still a
    zombie, because a reaped pid is free for reuse.
    """
    if not _IS_POSIX:
        return None
    try:
        return os.getpgid(process.pid)
    except (OSError, ValueError):
        return None


def _kill_probe(process: subprocess.Popen, pgid: int | None) -> None:
    """Kill a probe and anything it left holding the output pipe."""
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (OSError, ValueError):
            pass  # the group is already gone
    try:
        process.kill()
    except (OSError, ValueError):
        pass


def _read_probe_output(process: subprocess.Popen, pgid: int | None, into: list[bytes]) -> None:
    """Read at most the output cap from the probe, then stop the probe."""
    try:
        data = process.stdout.read(_PROBE_OUTPUT_CAP_BYTES + 1) if process.stdout else b""
    except (OSError, ValueError):
        data = b""
    if len(data) > _PROBE_OUTPUT_CAP_BYTES:
        # The listing is already long enough: do not wait for the rest of it.
        _kill_probe(process, pgid)
    into.append(data)


def _probe_uncommitted_changes(probe_command: str, cwd: str) -> list[str] | None:
    """Probe at-risk files via `git status --porcelain --untracked-files=all`
    (plus `--ignored=matching` when the discard deletes ignored files) in
    `cwd`. Returns None when dirtiness cannot be determined (not a repo, git
    missing, probe failure, timeout) so the guard fails open instead of
    blocking on a guess.

    The listing is read with the cap already in place on a thread of its own,
    so a repository with a very large untracked or ignored listing never
    buffers the whole `git status` in the kernel: once the cap is reached the
    tree is known to be dirty, the probe's process group is killed, and the
    paths read so far are used. The waiting thread is the real timeout: a probe
    that hangs, or one whose descendant keeps the output pipe open after the
    probe itself exited, is killed with its process group after
    `_PROBE_TIMEOUT_SECONDS` and the caller fails open (returns None) instead of
    waiting for the pipe.
    """
    try:
        process = subprocess.Popen(
            [_shell(), "-c", probe_command],
            cwd=cwd,
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        return None
    pgid = _probe_group(process)
    output: list[bytes] = []
    reader = threading.Thread(
        target=_read_probe_output, args=(process, pgid, output), daemon=True
    )
    reader.start()
    reader.join(_PROBE_TIMEOUT_SECONDS)
    if reader.is_alive():
        # A wedged probe, or a descendant still holding the output pipe: kill
        # the group (which closes the pipe) and give the reader a moment.
        _kill_probe(process, pgid)
        reader.join(_PROBE_KILL_GRACE_SECONDS)
    try:
        if reader.is_alive() or not output:
            return None
        raw = output[0]
        truncated = len(raw) > _PROBE_OUTPUT_CAP_BYTES
        returncode = process.wait(timeout=_PROBE_KILL_GRACE_SECONDS)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        return None
    finally:
        if reader.is_alive() or process.poll() is None:
            _kill_probe(process, pgid)
        if process.stdout is not None:
            process.stdout.close()
    if returncode != 0 and not truncated:
        return None
    text = raw[:_PROBE_OUTPUT_CAP_BYTES].decode("utf-8", errors="replace")
    if truncated:
        # The cap can cut the last entry in half; it still proves dirtiness.
        text = text.rsplit("\n", 1)[0]
    return [line.removesuffix("\r") for line in text.split("\n") if line.strip()]


def _format_dirty_tree_refusal(dirty_paths: list[str], includes_ignored_files: bool = False) -> str:
    listed = dirty_paths[:MAX_DIRTY_PATHS_LISTED]
    elided = len(dirty_paths) - len(listed)
    noun = "uncommitted or ignored file(s)" if includes_ignored_files else "uncommitted change(s)"
    lines = [
        "Refusing to run this destructive git command: the working tree has"
        f" {len(dirty_paths)} {noun}.",
        *(f"  {line}" for line in listed),
    ]
    if elided > 0:
        lines.append(f"  ... and {elided} more")
    lines.append("")
    lines.append("Commit, stash, or stage your work first.")
    lines.append(
        "To discard these changes intentionally, retry with"
        " bash(command, allow_destructive_git=True)."
    )
    note = _format_late_bypass_env_note()
    if note:
        lines.extend(("", note))
    return "\n".join(lines)


def _format_late_bypass_env_note() -> str:
    """Loud note when the bypass env var appears mid-session.

    The variable is read once at kernel start, so a later write cannot
    disarm the guard; saying so explicitly keeps the refusal honest
    instead of silently ignoring the change.
    """
    if _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START:
        return ""
    if not _is_truthy_env_value(os.environ.get(BASH_DESTRUCTIVE_GIT_BYPASS_ENV)):
        return ""
    return (
        f"{BASH_DESTRUCTIVE_GIT_BYPASS_ENV} appeared after the kernel started,"
        " so the guard ignores it: the variable is read once at launch, by the"
        " user who starts the kernel. Use bash(command,"
        " allow_destructive_git=True) for an intentional discard, or relaunch"
        " the kernel with the variable in the environment."
    )


def _format_eval_refusal() -> str:
    lines = [
        "Refusing to run this destructive git command: it wraps a git"
        " discard in eval, and the uncommitted changes of the repository"
        " it targets cannot be checked safely.",
        "",
        "Run the discard directly, or retry with"
        " bash(command, allow_destructive_git=True).",
    ]
    note = _format_late_bypass_env_note()
    if note:
        lines.extend(("", note))
    return "\n".join(lines)


def _format_revealed_command_refusal() -> str:
    lines = [
        "Refusing to run this destructive git command: the command word is an"
        " expanded value whose argv cannot be replayed, and the uncommitted"
        " changes of the repository it targets cannot be checked safely.",
        "",
        "Run the discard directly, or retry with"
        " bash(command, allow_destructive_git=True).",
    ]
    note = _format_late_bypass_env_note()
    if note:
        lines.extend(("", note))
    return "\n".join(lines)


def _format_relocation_refusal() -> str:
    lines = [
        "Refusing to run this destructive git command: it changes directory (or"
        " repository) first, and the uncommitted changes of the repository it"
        " targets cannot be checked safely.",
        "",
        "Run the discard as its own command from the target directory, or retry"
        " with bash(command, allow_destructive_git=True).",
    ]
    note = _format_late_bypass_env_note()
    if note:
        lines.extend(("", note))
    return "\n".join(lines)


def _guard_destructive_git(command: str, allow_destructive_git: bool) -> None:
    """Refuse destructive git discard commands while the tree they target is
    dirty. The pattern check is string-only and the probe runs only on a
    match, so clean runs pay nothing."""
    if allow_destructive_git or _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START:
        return
    # Match the prefixed command exactly as the shell will run it; the prefix
    # is replayed in the probe, so hook-provided shell setup applies to both.
    # Line continuations and shell redirections are normalized first (both
    # length-preserving) so the patterns and the probe resolution see the
    # same argv the shell will hand to git.
    resolved = _mask_shell_redirections(_normalize_line_continuations(_with_prefix(command)))
    # An escaped or split-spelled command word (`e\val`, `e'va'l`) still
    # runs the eval builtin, so the gate reads the text with quoting and
    # escapes dropped before the substring check; the scan itself still
    # judges the command exactly as written.
    eval_present = "eval" in _EVAL_GATE_STRIP.sub("", resolved)
    if eval_present and _eval_payloads_hide_destructive_git(resolved):
        # An eval payload hides where the discard runs; refuse rather than
        # probe a command the guard cannot replay.
        raise DestructiveGitRefusalError(_format_eval_refusal())
    sites = _find_destructive_git_discard_sites(resolved)
    if not sites:
        return
    if eval_present and _eval_payloads_relocate(resolved):
        # An eval payload that cds moves the shell the discard runs in, and the
        # probe cannot replay that from the text: refuse instead of checking the
        # caller's repository. Only reached when a discard is really present, so
        # a harmless `eval 'cd /tmp'` on its own still runs.
        raise DestructiveGitRefusalError(_format_relocation_refusal())
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    user_command_start = len(prefix) + 1 if prefix else 0
    probes: list[tuple[str, bool]] = []
    seen_probes: set[str] = set()
    for site in sites:
        if site.revealed:
            # The shell runs the revealed value as argv, and that value holds
            # more than the executable word: the repository it discards in
            # cannot be named from the text, so refuse instead of probing a
            # directory that may not be the one the discard targets.
            raise DestructiveGitRefusalError(_format_revealed_command_refusal())
        target = _resolve_discard_probe_target(resolved, site.index, user_command_start)
        if target is _UNRESOLVABLE_DISCARD_TARGET:
            raise DestructiveGitRefusalError(_format_relocation_refusal())
        if target is None:
            relocation_prefix = ""
            git_status = GIT_STATUS_PORCELAIN_COMMAND
        else:
            relocation_prefix = target.relocation_prefix or ""
            git_status = target.git_status_command
        probe_command = _with_prefix(relocation_prefix + git_status)
        if probe_command in seen_probes:
            continue
        seen_probes.add(probe_command)
        probes.append((probe_command, "--ignored=matching" in git_status))
    try:
        cwd = os.getcwd()
    except OSError:
        return  # the spawn itself will fail; the guard must not mask that error
    for probe_command, includes_ignored_files in probes:
        dirty_paths = _probe_uncommitted_changes(probe_command, cwd)
        if dirty_paths:
            raise DestructiveGitRefusalError(
                _format_dirty_tree_refusal(dirty_paths, includes_ignored_files)
            )


# ---------------------------------------------------------------------------
# Recursive-force rm guard. The dirty-tree guard above protects uncommitted
# git work; this one stops recursive-force rm invocations whose operands
# escape the kernel workspace (HOME itself, /, parent directories, other
# trees) or name protected dot paths (.., .git, .env-class files). Detection
# is a word-level shell scan, conservative by design: a false positive costs
# one explicit-bypass retry, a false negative silently deletes files.

# Bypass env var for the recursive-force rm guard. Unlike the git guard's
# bypass, the value is FROZEN at kernel start: this module is imported once
# when the kernel boots and the guard consults only that frozen copy. A live
# os.environ read would let one model-side os.environ write neuter the guard
# mid-session (wave-1 safety audit, gap 1), so a mid-session change is
# ignored and warned about loudly instead of honored.
BASH_DESTRUCTIVE_RM_BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_RM"

# The launch-time snapshot, read once at import (kernel bootstrap). Tests
# simulate a different launch environment by patching this attribute.
_BASH_RM_BYPASS_AT_KERNEL_START: str | None = os.environ.get(BASH_DESTRUCTIVE_RM_BYPASS_ENV)

# How many refused rm operands the refusal lists before eliding the rest.
_MAX_RM_REFUSALS_LISTED = 10


class DestructiveRmRefusalError(RuntimeError):
    """A recursive-force rm was refused: its targets escape the kernel
    workspace or name protected dot paths."""


@dataclass(frozen=True)
class _RmShellWord:
    """One shell word: its unquoted argv value plus the span it came from."""

    value: str
    start: int
    end: int
    starts_command: bool  # first word of a fresh (sub)command context
    splittable: bool = False  # carries an unquoted expansion, so it can split


def _quote_span_end(command: str, start: int, end: int) -> int:
    """Index just past the quoted span starting at `command[start]` (a single
    or double quote), skipping escaped characters inside double quotes."""
    quote = command[start]
    i = start + 1
    while i < end:
        ch = command[i]
        if quote == '"' and ch == "\\":
            i += 2
            continue
        if ch == quote:
            return i + 1
        i += 1
    return end


def _matching_paren(command: str, open_index: int, end: int) -> int:
    """Index of the `)` matching the `(` at `open_index`, or `end - 1`.

    Quote-aware: a `)` inside a single- or double-quoted span or after a
    backslash escape never closes the substitution, mirroring how the shell
    parses it. Unterminated quotes or an unmatched `(` scan to the end, so
    the whole region stays live-command territory rather than a miss."""
    depth = 0
    i = open_index
    while i < end:
        ch = command[i]
        if ch == "\\":
            i += 2
        elif ch in "'\"":
            i = _quote_span_end(command, i, end)
        elif ch == "(":
            depth += 1
            i += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
            i += 1
        else:
            i += 1
    return end - 1  # unterminated: scan to the end


def _scan_shell_words(command: str) -> list[_RmShellWord]:
    """Split `command` into shell words the way the shell builds argv.

    Quotes and backslash escapes fold into the word value, comments are
    skipped, and command substitution (`$(...)`, backticks) keeps its
    interior scanned as live commands because it executes; the substituted
    result itself stays in the enclosing word, so an operand carrying it
    reads as unresolvable. `splittable` marks a word holding an unquoted
    expansion, which the shell splits into whatever words the value carries.
    Redirections are masked by the caller. This is a conservative
    approximation, not a parse: anything it cannot represent exactly ends up
    refused, never silently allowed.
    """
    words: list[_RmShellWord] = []

    def scan_region(start: int, end: int, *, starts_command: bool) -> None:
        i = start
        value: list[str] = []
        word_start = -1
        word_starts_command = False
        word_splittable = False
        first_word_pending = starts_command

        def flush(starts_next_command: bool) -> None:
            nonlocal word_start, word_splittable, first_word_pending
            if word_start != -1:
                words.append(
                    _RmShellWord(
                        "".join(value),
                        word_start,
                        i,
                        word_starts_command,
                        word_splittable,
                    )
                )
                value.clear()
                word_start = -1
                word_splittable = False
                first_word_pending = starts_next_command
            else:
                first_word_pending = first_word_pending or starts_next_command

        while i < end:
            ch = command[i]
            if ch in " \t\r":
                flush(False)  # whitespace: the next word continues this command
                i += 1
                continue
            if ch in "\n;|&()<>":
                flush(True)  # command boundary: the next word starts a command
                i += 1
                continue
            if ch == "#" and word_start == -1:
                while i < end and command[i] != "\n":
                    i += 1
                continue
            if word_start == -1:
                word_start = i
                word_starts_command = first_word_pending
                first_word_pending = False
            if ch == "\\" and i + 1 < end:
                value.append(command[i + 1])
                i += 2
                continue
            if ch == "'":
                j = i + 1
                while j < end and command[j] != "'":
                    j += 1
                value.append(command[i + 1 : j])
                i = j + 1
                continue
            if ch == '"':
                j = i + 1
                while j < end:
                    inner = command[j]
                    if inner == "\\" and j + 1 < end:
                        value.append(command[j + 1])
                        j += 2
                        continue
                    if inner == '"':
                        j += 1
                        break
                    if inner == "$" and command[j + 1 : j + 2] == "(":
                        close = _matching_paren(command, j + 1, end)
                        scan_region(j + 2, close, starts_command=True)
                        value.append(command[j + 1 : close + 1])
                        j = close + 1
                        continue
                    if inner == "`":
                        close = command.find("`", j + 1, end)
                        if close == -1:
                            close = end - 1
                        scan_region(j + 1, close, starts_command=True)
                        value.append(command[j + 1 : close + 1])
                        j = close + 1
                        continue
                    value.append(inner)
                    j += 1
                i = j
                continue
            if ch == "$" and command[i + 1 : i + 2] == "(":
                close = _matching_paren(command, i + 1, end)
                scan_region(i + 2, close, starts_command=True)
                value.append(command[i + 1 : close + 1])
                word_splittable = True  # an unquoted substitution word-splits
                i = close + 1
                continue
            if ch == "`":
                close = command.find("`", i + 1, end)
                if close == -1:
                    close = end - 1
                scan_region(i + 1, close, starts_command=True)
                value.append(command[i + 1 : close + 1])
                word_splittable = True  # an unquoted substitution word-splits
                i = close + 1
                continue
            if ch in "$`{}":
                word_splittable = True  # unquoted, so it splits into any words
            value.append(ch)
            i += 1
        flush(False)

    scan_region(0, len(command), starts_command=True)
    return words


def _is_rm_word(value: str) -> bool:
    """True when the word invokes rm, including slash-qualified forms
    (`/bin/rm`, `./rm`) that basename-match the real command."""
    return os.path.basename(value) == "rm"


def _find_rf_rm_invocations_in_words(
    words: list[_RmShellWord],
) -> list[tuple[int, list[str]]]:
    """Find every rm invocation combining recursive and force flags
    (-r/-R/--recursive plus -f, including combined -rf/-fr), returning the
    rm word index and operand list of each matched invocation. Flags may sit
    anywhere in the invocation (`rm sub -rf`); a lone -r or lone -f never
    matches."""
    invocations: list[tuple[int, list[str]]] = []
    for index, word in enumerate(words):
        if not _is_rm_word(word.value):
            continue
        recursive = False
        force = False
        operands: list[str] = []
        end_of_options = False
        for follower in words[index + 1 :]:
            if follower.starts_command:
                break
            token = follower.value
            if end_of_options or not token.startswith("-") or token == "-":
                operands.append(token)
                continue
            if token == "--":
                end_of_options = True
                continue
            if token.startswith("--"):
                # GNU long options accept unambiguous abbreviations, so any
                # prefix of --recursive/--force behaves like the full option.
                name = token[2:].split("=", 1)[0]
                recursive = recursive or "recursive".startswith(name)
                force = force or "force".startswith(name)
                continue
            body = token[1:]
            recursive = recursive or "r" in body or "R" in body
            force = force or "f" in body
        if recursive and force:
            invocations.append((index, operands))
    return invocations


def _find_recursive_force_rm_invocations(command: str) -> list[list[str]]:
    """The operand lists of every recursive-force rm invocation in `command`;
    see _find_rf_rm_invocations_in_words for the matching rules."""
    prepared = _mask_shell_redirections(_join_line_continuations(command))
    return [
        operands
        for _, operands in _find_rf_rm_invocations_in_words(_scan_shell_words(prepared))
    ]


def is_recursive_force_rm_command(command: str) -> bool:
    """True when `command` contains an rm invocation combining recursive and
    force flags (`rm -rf x`, `-fr`, `-Rf`, `--recursive --force`), regardless
    of its operands. Here-document bodies are masked consumer-agnostically in
    this helper, so rm text inside them goes undetected; guard decisions use
    the runner-aware scan path instead."""
    return bool(_find_recursive_force_rm_invocations(command))


# Expansion characters that can turn one scanned word into different shell
# argv at run time. `$HOME`/`$PWD` prefixes are statically resolvable, so
# they are stripped before a word counts as unresolvable.
_UNRESOLVED_EXPANSION_CHARS = ("$", "`", "{", "}")


_EXPANSION_NAME = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)")


def _expansion_is_resolvable(token: str) -> bool:
    """True when every expansion in `token` is a statically resolvable
    `$HOME`/`${HOME}`/`$PWD`/`${PWD}` reference, matched by full variable
    name so `$HOMEFOO` (a different variable) stays unresolvable."""
    rest = token
    while rest:
        match = _EXPANSION_NAME.search(rest)
        if match is None:
            return not any(ch in rest for ch in _UNRESOLVED_EXPANSION_CHARS)
        if match.group(1) not in ("HOME", "PWD"):
            return False
        rest = rest[match.end() :]
        if match.group(0).startswith("${"):
            if rest.startswith("}"):
                rest = rest[1:]
            else:
                return False  # unterminated ${NAME: treat as unresolvable
    return True


def _unresolvable_expansion_rm_reasons(words: list[_RmShellWord]) -> list[str]:
    """Refusal reasons for rm-shaped invocations whose command word or
    flags/operands hide behind expansion the shell performs after the guard
    runs. A `R=rm; $R -rf x` command word and a `flags=-rf; rm $flags /`
    follower cannot be resolved statically, so the invocation is refused as
    unresolvable instead of guessed at. Fail closed."""
    reasons: list[str] = []
    for index, word in enumerate(words):
        follower_words: list[_RmShellWord] = []
        for follower in words[index + 1 :]:
            if follower.starts_command:
                break
            follower_words.append(follower)
        followers = [follower.value for follower in follower_words]
        if not _expansion_is_resolvable(word.value):
            # The word expands at run time. In command position — first word,
            # after an assignment prefix, env/sudo-style words, keywords, or
            # grouping tokens — it could expand to rm, so if any follower
            # could be an rm flag the pair could complete into
            # recursive-force rm.
            shows_rm_flag = False
            for token in followers:
                if token.startswith("--"):
                    name = token[2:].split("=", 1)[0]
                    shows_rm_flag = (
                        shows_rm_flag
                        or "recursive".startswith(name)
                        or "force".startswith(name)
                    )
                elif token.startswith("-") and token != "-":
                    body = token[1:]
                    shows_rm_flag = (
                        shows_rm_flag or "r" in body or "R" in body or "f" in body
                    )
            if shows_rm_flag:
                reasons.append(
                    f"{word.value!r}: names the command through shell"
                    " expansion, which the guard cannot resolve"
                )
        elif _is_rm_word(word.value):
            # An rm follower carrying unresolved expansion could expand to
            # recursive-force flags or out-of-workspace paths. A follower the
            # shell word-splits (`rm $flags /`) can supply those flags on its
            # own, and a single-word expansion sharing the invocation with
            # another operand (`rm "$flags" /outside`) can be that operand's
            # flags, so both stay refused. A lone unresolvable operand with
            # nothing but options around it (`rm "$file"`, `rm -f "$file"`,
            # `rm -- "$file"`) cannot turn an rm into a recursive-force rm, so
            # variable-based cleanup keeps running.
            for follower in follower_words:
                if _expansion_is_resolvable(follower.value):
                    continue
                if follower.splittable or any(
                    other is not follower and _could_be_operand(other)
                    for other in follower_words
                ):
                    reasons.append(
                        f"{follower.value!r}: expands inside an rm invocation,"
                        " so the flags or paths it produces cannot be checked"
                    )
                    break
    return reasons


def _could_be_operand(word: _RmShellWord) -> bool:
    """True when rm could read the word as an operand: anything but an option
    cluster or the `--` end-of-options marker (`-` alone is still an operand,
    and rm reads the names from stdin for it)."""
    return word.value == "-" or not word.value.startswith("-")


# A quoted argument to `sh -c` (and friends) is a live command string, so
# those payloads are scanned exactly like eval payloads. Only shell
# interpreters are listed: non-shell `-c` payloads (python, awk, node) are
# not shell syntax, and any shell command substitution in them already runs
# before their own parser sees the text.
_SHELL_DASH_C_INTERPRETERS = frozenset(
    {"sh", "ash", "bash", "csh", "dash", "ksh", "tcsh", "zsh"}
)


def _alias_definitions(words: list[_RmShellWord]) -> dict[str, str]:
    """Alias definitions made by the command (`alias name='command text'`),
    applied in order so redefinitions and `unalias` win."""
    aliases: dict[str, str] = {}
    for index, word in enumerate(words):
        if word.value not in ("alias", "unalias"):
            continue
        for follower in words[index + 1 :]:
            if follower.starts_command:
                break
            token = follower.value
            if word.value == "alias" and "=" in token:
                name, _, value = token.partition("=")
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    aliases[name] = value
            elif word.value == "unalias":
                aliases.pop(token, None)
    return aliases


def _wrapped_payloads_hide_recursive_force_rm(
    command: str,
    depth: int = 0,
    words: list[_RmShellWord] | None = None,
    aliases: dict[str, str] | None = None,
) -> bool:
    """True when a quoted `eval` or shell `-c` payload hides a
    recursive-force rm.

    Mirrors the git guard's eval scan: only unquoted wrapper tokens are
    scanned, each payload uses the scanner's folded word values (so adjacent
    quoted fragments like 'r''m stay one word, exactly as the shell passes
    them), and a recursive-force rm in any layer is refused outright because
    the payload can relocate or chain freely. Shell `-c` payloads are scanned
    when the wrapper word names a shell interpreter or carries unresolvable
    expansion (`$BASH -c ...`): literal non-shell wrappers (`python -c`) stay
    unscanned because their payload is not shell syntax. `trap` action
    strings are live commands the shell runs later (at signal/exit), so the
    argument is scanned as a payload too."""
    if depth > _MAX_EVAL_SCAN_DEPTH:
        return True  # absurdly nested wrappers: refuse rather than risk a miss
    if words is None:
        words = _scan_shell_words(command)
    if aliases is None:
        aliases = _alias_definitions(words)
    else:
        aliases = {**aliases, **_alias_definitions(words)}
    for index, word in enumerate(words):
        payload_parts: list[str] = []
        if word.value == "eval":
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                # Aliases expand at parse time in the same shell, so an
                # eval payload word may be an alias defined earlier.
                payload_parts.append(aliases.get(follower.value, follower.value))
        elif word.value == "trap":
            # The action string is the first argument after any -l/-p flags
            # or a `--` end-of-options marker; the rest are signals.
            action = None
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                if follower.value.startswith("-"):
                    continue
                action = follower
                break
            if action is None:
                continue
            # Trap actions run in the same shell, so aliases apply.
            payload_parts.append(aliases.get(action.value, action.value))
        elif "BASH_FUNC_" in word.value and "%%=" in word.value:
            # An exported shell function travels in the environment
            # (`env 'BASH_FUNC_rm%%=() { rm -rf /; }' bash -c 'rm x'`), where
            # the child shell imports it and runs the body under a command name
            # the literal scan reads as harmless: scan the body as its own
            # command text, with the `() {...}` wrapper stripped.
            body = word.value.split("%%=", 1)[1]
            body = re.sub(r"^\s*\(\s*\)\s*(?:\{|\()", "", body)
            payload_parts.append(re.sub(r"(?:\}|\))\s*$", "", body))
        else:
            is_shell = os.path.basename(word.value) in _SHELL_DASH_C_INTERPRETERS
            if not is_shell and _expansion_is_resolvable(word.value):
                continue  # python/node -c payloads are not shell syntax
            # `-c` may sit anywhere in the option list (`bash -e -c ...`,
            # bundled `-ce`/`-uc`, behind argument-taking options like
            # `-o pipefail`); locate any short cluster containing `c` and
            # take the word that follows it as the command string. Long
            # options and non-option words are skipped so positional
            # arguments do not end the search early (over-scanning a
            # positional is only a conservative refusal).
            payload_word = None
            for offset, follower in enumerate(words[index + 1 :]):
                if follower.starts_command:
                    break
                token = follower.value
                if token == "-" or token.startswith("--"):
                    continue
                if token.startswith("-") and "c" in token[1:]:
                    candidate = words[index + 2 + offset : index + 3 + offset]
                    if candidate and not candidate[0].starts_command:
                        payload_word = candidate[0]
                    break
            if payload_word is None:
                continue  # no `-c` payload: nothing to scan
            payload_parts.append(payload_word.value)
        payload = " ".join(payload_parts)
        # A payload word in command position that expands at run time
        # (`sh -c "$SCRIPT"`, `sh -c "$HOME ..."`) could be any command,
        # including rm — even $HOME/$PWD resolve to a path the environment
        # controls, and brace expansion / backticks assemble commands the
        # same way: refuse rather than scan the expansion text literally.
        if any(
            payload_word.starts_command
            and any(ch in payload_word.value for ch in "$`{}")
            for payload_word in _scan_shell_words(payload)
        ):
            return True
        if _find_recursive_force_rm_invocations(payload):
            return True
        # Expansion inside the payload hides the same recursion the outer scan
        # refuses (`sh -c 'flags=-rf; rm $flags /outside'`).
        if _unresolvable_expansion_rm_reasons(_scan_shell_words(payload)):
            return True
        if _wrapped_payloads_hide_recursive_force_rm(payload, depth + 1, aliases=aliases):
            return True
        # The shell a payload runs in parses its own input one command at a
        # time, so an alias the payload defines on an earlier line does expand
        # there (`sh -c 'alias rm=...\nrm x'`), even though the enclosing
        # command's parse unit never sees it.
        expanded = _expand_effective_aliases(payload)
        if expanded is not None and (
            _find_recursive_force_rm_invocations(expanded)
            or _wrapped_payloads_hide_recursive_force_rm(expanded, depth + 1, aliases=aliases)
        ):
            return True
    return False


# cd and pushd relocate the spawned shell before later words run, so rm
# operands must resolve against the tracked directory, not the kernel cwd.
_CD_BUILTINS = ("cd", "pushd")

# cd/pushd options that are not directory operands.
_CD_OPTIONS = frozenset({"-L", "-P", "-LP", "-PL", "--"})


def _strip_cd_options(targets: list[str]) -> list[str]:
    """Drop leading cd/pushd options (-L/-P/--) from the target list."""
    index = 0
    while index < len(targets) and targets[index] in _CD_OPTIONS:
        index += 1
    return targets[index:]


def _resolve_cd_target(
    targets: list[str],
    tracked: str | None,
    builtin: str,
    *,
    home_untrackable: bool = False,
    pwd_untrackable: bool = False,
    cdpath_untrackable: bool = False,
) -> str | None:
    """The shell's directory after `cd`/`pushd` with the follower values
    `targets`, or None when the destination cannot be established statically
    (variable, glob, brace, substitution, stack-relative, CDPATH-redirected,
    or reassigned-HOME/PWD targets). Fail closed: never guess."""
    if tracked is None:
        return None
    targets = _strip_cd_options(targets)
    if not targets:
        if builtin == "pushd":
            return None  # swaps with the directory stack: unknowable statically
        home = os.environ.get("HOME")
        if not home:
            return None  # bare cd goes to HOME, which is unset here
        try:
            return os.path.realpath(home)
        except (OSError, ValueError):
            return None
    if len(targets) > 1:
        # cd errors on extra operands; refuse rather than guess which one
        # wins in other shells.
        return None
    target = targets[0]
    if target == "-":
        return None  # $OLDPWD is unknowable statically
    if builtin == "pushd" and re.fullmatch(r"[+-]\d+", target):
        return None  # a stack rotation lands on another stack entry
    if target == "":
        return tracked  # cd '' errors; the shell stays put
    home = os.environ.get("HOME")
    expanded = target
    if expanded.startswith("~"):
        if home_untrackable:
            return None  # HOME is reassigned in this command: untrackable
        if not home:
            return None
        if expanded == "~":
            expanded = home
        elif expanded.startswith("~/"):
            expanded = home + expanded[1:]
        else:
            return None  # ~otheruser homes cannot be checked statically
    else:
        for prefix in ("${HOME}", "$HOME"):
            if expanded.startswith(prefix):
                if home_untrackable or not home:
                    return None
                expanded = home + expanded[len(prefix) :]
                break
        else:
            for prefix in ("${PWD}", "$PWD"):
                if expanded.startswith(prefix):
                    if pwd_untrackable:
                        return None  # PWD is reassigned in this command
                    expanded = tracked + expanded[len(prefix) :]
                    break
    if not _expansion_is_resolvable(expanded) or any(
        ch in expanded for ch in "*?\\"
    ):
        return None
    if cdpath_untrackable and not (
        os.path.isabs(expanded) or expanded.startswith(".")
    ):
        # CDPATH can redirect a plain relative cd to any of its entries.
        return None
    try:
        return os.path.realpath(
            expanded if os.path.isabs(expanded) else os.path.join(tracked, expanded)
        )
    except (OSError, ValueError):
        return None


def _boundary_positions(command: str) -> list[tuple[int, str]]:
    """Positions and kinds of unquoted control boundaries: `&&`, `||`, `;`,
    `&`, `|`, `|&`, newlines, subshell parens, and word-position braces
    (`{ cmd; }` groups); quoted spans and escapes are skipped. Used to model
    which commands may be skipped at run time and where pipeline producers
    start."""
    positions: list[tuple[int, str]] = []
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if ch == "\\":
            i += 2
        elif ch in "'\"":
            i = _quote_span_end(command, i, n)
        elif ch in "();\n":
            positions.append((i, ch))
            i += 1
        elif ch in "&|":
            kind = ch
            following = command[i + 1 : i + 2]
            if following == ch:
                kind = ch * 2
                i += 1
            elif ch == "|" and following == "&":
                kind = "|&"
                i += 1
            positions.append((i, kind))
            i += 1
        elif ch in "{}" and (i == 0 or command[i - 1] in " \t\n;&|(){}"):
            # A group brace at word position (not ${...} expansion or brace
            # expansion attached to a word).
            positions.append((i, ch))
            i += 1
        else:
            i += 1
    return positions


def _tracked_cwd_at_words(
    command: str,
    words: list[_RmShellWord],
    start_cwd: str | None,
    *,
    home_untrackable: bool = False,
    pwd_untrackable: bool = False,
    cdpath_untrackable: bool = False,
) -> list[list[str | None]]:
    """For each word, the set of directories the shell may be in when that
    word runs (an over-approximation of the control flow).

    `cd`/`pushd` relocations are resolved statically against every tracked
    directory; unquoted parens scope those changes the way `(...)` isolates
    them in the shell (command substitutions included), and a command that
    may be skipped (after `||` or `&`) leaves the pre-command directories in
    play alongside the relocated ones — `cd A && true || cd B && rm` can run
    the rm in A even though B never executed. A None entry means the runtime
    directory could not be established, so relative rm operands after it
    must be refused."""
    def dedupe(values: list[str | None]) -> list[str | None]:
        return list(dict.fromkeys(values))

    states: list[str | None] = [start_cwd]
    # Directories from which the current chain can exit early: a failed
    # command leaves the `&&` chain (and a `;` statement then runs in that
    # directory), so every failing command's pre-state stays in play.
    chain_states: list[str | None] = []
    stack: list[tuple[list[str | None], list[str | None]]] = []
    boundaries = _boundary_positions(command)
    boundary_index = 0
    result: list[list[str | None]] = []
    may_skip = False
    for index, word in enumerate(words):
        while boundary_index < len(boundaries) and boundaries[boundary_index][0] < word.start:
            position, kind = boundaries[boundary_index]
            if kind == "(":
                stack.append((states, chain_states))
            elif kind == ")":
                if stack:
                    states, chain_states = stack.pop()
            elif kind == "||" or kind == "&":
                # The next command may be skipped: its failure/success
                # predecessors also stay in play.
                may_skip = True
                states = dedupe(states + chain_states)
            elif kind == "&&":
                may_skip = False
            else:  # ; | newline: a fresh statement
                may_skip = False
                states = dedupe(states + chain_states)
            boundary_index += 1
        if word.value in _CD_BUILTINS:
            targets: list[str] = []
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                targets.append(follower.value)
            relocated = [
                _resolve_cd_target(
                    targets,
                    state,
                    word.value,
                    home_untrackable=home_untrackable,
                    pwd_untrackable=pwd_untrackable,
                    cdpath_untrackable=cdpath_untrackable,
                )
                for state in states
            ]
            definite = all(
                target is not None and os.path.isdir(target) for target in relocated
            )
            if may_skip or not definite:
                # The relocation may be skipped (|| continuation) or may
                # fail (missing target): the earlier directories stay in
                # play alongside the relocated ones.
                chain_states = dedupe(chain_states + states)
                states = dedupe(states + relocated)
            else:
                # The relocation provably runs and succeeds, so no earlier
                # directory can survive it inside this chain.
                states = dedupe(relocated)
            chain_states = dedupe(chain_states + states)
        elif word.value == "popd":
            # The stack top is whatever earlier pushd or stack subtraction left
            # there, which the tracker does not model, so the runtime directory
            # stays unknowable until a later cd/pushd pins it down (a failed
            # popd leaves the current directory in play).
            chain_states = dedupe(chain_states + states)
            states = dedupe(states + [None])
            chain_states = dedupe(chain_states + states)
        elif word.starts_command:
            chain_states = dedupe(chain_states + states)
        result.append(list(states))
    return result


def _resolve_rm_operand(operand: str, workspace_root: str, cwd: str) -> str | None:
    """Return why `operand` (one unquoted rm argv entry) must be refused from
    inside `workspace_root`, or None when it is safe. `cwd` is the directory
    the rm will actually run in (cd-relocated, not the kernel cwd), so $PWD
    and relative operands resolve the way the spawned shell sees them; `~`
    and `$HOME` expand from the environment the spawned shell inherits.
    Fail closed: anything that cannot be resolved statically is refused,
    including symlinked operands (their target can change between check and
    run) and paths that do not exist yet (they can still be created as
    symlinks)."""
    if operand == "-":
        return "reads the list of names from stdin, so its targets cannot be checked"
    if "{}" in operand:
        return "is a find -exec placeholder, so its targets cannot be checked"
    if "{" in operand or "}" in operand:
        return "uses brace expansion, which expands to multiple paths at run time"
    home = os.environ.get("HOME")
    expanded = operand
    if expanded.startswith("~"):
        if not home:
            return "expands ~ with HOME unset, so its target cannot be checked"
        if expanded == "~":
            expanded = home
        elif expanded.startswith("~/"):
            expanded = home + expanded[1:]
        else:
            return "expands to another user's home directory, which cannot be checked"
    else:
        for prefix, name in (("${HOME}", "HOME"), ("$HOME", "HOME")):
            if expanded.startswith(prefix):
                if not home:
                    return f"expands {prefix} with HOME unset, so its target cannot be checked"
                expanded = home + expanded[len(prefix) :]
                break
        else:
            for prefix in ("${PWD}", "$PWD"):
                if expanded.startswith(prefix):
                    # The spawned shell resets PWD to its own cwd at startup,
                    # so $PWD here is the real kernel cwd, not the env copy.
                    expanded = cwd + expanded[len(prefix) :]
                    break
    if re.search(r"""[$`"']""", expanded):
        return "uses shell expansion the guard cannot resolve (variables, substitutions)"
    if any(ch in expanded for ch in "*?["):
        return "uses a glob pattern; list explicit paths instead"
    components = [part for part in expanded.split("/") if part not in ("", ".")]
    if any(part == ".." for part in components):
        return "names a parent directory (..), which escapes the workspace"
    if any(part == ".git" for part in components):
        return "names .git, destroying repository history"
    dot = next((part for part in components if part.startswith(".")), None)
    if dot is not None:
        return f"names the dot path {dot!r}; dot files and dot directories (.env-class, .git) are refused"
    try:
        raw = expanded if os.path.isabs(expanded) else os.path.join(cwd, expanded)
    except (OSError, ValueError):
        return "cannot be resolved on this filesystem"
    try:
        # A trailing slash makes lstat follow the link, so probe the link
        # itself: `rm -rf alias/` deletes through the symlink.
        st = os.lstat(raw.rstrip("/") or raw)
    except FileNotFoundError:
        return (
            "does not exist yet, so its runtime target cannot be verified"
            " (a command could still create or replace it as a symlink)"
        )
    except (OSError, ValueError):
        return "cannot be checked on this filesystem"
    if stat.S_ISLNK(st.st_mode):
        return (
            "names a symlink, whose target can change between the check and"
            " the run; remove the link itself without -rf or list explicit paths"
        )
    try:
        resolved = os.path.realpath(raw)
    except (OSError, ValueError):
        return "cannot be resolved on this filesystem"
    if resolved == os.sep:
        return "resolves to the filesystem root"
    if home:
        try:
            if resolved == os.path.realpath(home):
                return "resolves to HOME itself"
        except (OSError, ValueError):
            pass
    if resolved == workspace_root:
        return "resolves to the workspace root itself, including .git"
    if not (resolved + os.sep).startswith(workspace_root + os.sep):
        return f"resolves outside the workspace ({workspace_root})"
    return None


def _arithmetic_substitution_end(command: str, start: int) -> int:
    """Index just past the `$((...))` arithmetic substitution starting at
    `start` (quote- and escape-aware, so a quoted paren cannot keep the skip
    open past a real heredoc); unterminated input scans to the end."""
    depth = 2
    i = start + 3
    n = len(command)
    while i < n and depth > 0:
        ch = command[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "'\"":
            i = _quote_span_end(command, i, n)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        i += 1
    return i


def _heredoc_body_spans(command: str) -> list[tuple[int, int, bool]]:
    """Body extents of every parsable here-document in `command`.

    Each span is `(start, end, expands)`: `expands` is False for a quoted or
    escaped delimiter, whose body is inert data, and True otherwise, because
    the shell expands `$(...)` and backtick spans there before the consumer
    sees the text. Structural and quote- and comment-aware: heredoc operators
    inside quoted spans, comments, or other heredoc bodies are skipped, and an
    unterminated or unparsable heredoc reports no span (its body stays live,
    which is the conservative direction)."""
    spans: list[tuple[int, int, bool]] = []
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if ch in "'\"":
            i = _quote_span_end(command, i, n)
            continue
        if ch == "$" and command[i + 1 : i + 3] == "((":
            # Arithmetic substitution: its `<<` is a shift, not a heredoc.
            i = _arithmetic_substitution_end(command, i)
            continue
        if ch == "#" and (i == 0 or command[i - 1] in " \t\n;&|(){}"):
            while i < n and command[i] != "\n":
                i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == "<" and command[i + 1 : i + 2] == "<":
            # The operator is valid attached to the command word too
            # (`sh<<EOF`); arithmetic shifts never reach here because
            # $((...)) spans are skipped above.
            j = i + 2
            strip_tabs = False
            if command[j : j + 1] == "-":
                strip_tabs = True
                j += 1
            while j < n and command[j] in " \t":
                j += 1
            expands = True
            if command[j : j + 1] in ('"', "'"):
                quote = command[j]
                closing = command.find(quote, j + 1)
                if closing == -1:
                    i = j  # unterminated quote: not a parsable heredoc
                    continue
                delimiter = command[j + 1 : closing]
                j = closing + 1
                expands = False  # a quoted word turns expansion off
            else:
                k = j
                while k < n and command[k] not in " \t\n;&|<>":
                    k += 1
                delimiter = command[j:k]
                j = k
            if not delimiter:
                i = j
                continue
            body_start = command.find("\n", j)
            if body_start == -1:
                i = j  # unterminated: leave the whole thing live
                continue
            end = None
            scan = body_start + 1
            while scan <= n:
                line_end = command.find("\n", scan)
                if line_end == -1:
                    line_end = n
                line = command[scan:line_end]
                candidate = line.lstrip("\t") if strip_tabs else line
                if candidate == delimiter or candidate.rstrip("\r") == delimiter:
                    end = scan
                    break
                if line_end >= n:
                    break
                scan = line_end + 1
            if end is None:
                i = j  # unterminated heredoc: leave live
                continue
            spans.append((body_start + 1, end, expands))
            i = end
            continue
        i += 1
    return spans


# Words that run other commands: their followers are command-position too
# (`exec ./s.sh`, `sudo ./s.sh`), so a slash-qualified word after them is a
# script invocation even without starting one itself.
_EXEC_STYLE_PREFIXES = frozenset(
    {"exec", "sudo", "env", "nohup", "command", "builtin", "timeout", "nice", "time", "stdbuf"}
)


def _script_runner_word_indices(words: list[_RmShellWord]) -> list[int]:
    """Indices of words that can run heredoc text: an interpreter feeding on
    stdin (`sh <<EOF`), a pipeline consumer after the terminator
    (`{ cat <<EOF ... } | sh`), a script invocation (`sh s.sh`, `./s.sh`,
    `. s.sh`, `source s.sh`, `exec ./s.sh`), or an unresolvable-expansion
    word that could be any of them. Exec-style prefixes reach through their
    options and arguments (`sudo -E ./s.sh`, `env -i ./s.sh`), so the
    prefix may sit several words back; cd/pushd targets are not runners."""
    indices: list[int] = []
    for index, word in enumerate(words):
        value = word.value
        if os.path.basename(value) in _SHELL_DASH_C_INTERPRETERS:
            indices.append(index)
        elif value == "source":
            indices.append(index)
        elif word.starts_command and ("/" in value or value == "."):
            indices.append(index)
        elif "/" in value:
            for back in range(index - 1, -1, -1):
                if words[back].starts_command:
                    if words[back].value in _EXEC_STYLE_PREFIXES:
                        indices.append(index)
                    break
        elif not _expansion_is_resolvable(value):
            indices.append(index)
    return indices


def _heredoc_bodies_reach_script_runners(command_without_bodies: str) -> bool:
    """True when any word in `command_without_bodies` (heredoc bodies already
    blanked) can run heredoc text; see _script_runner_word_indices."""
    return bool(_script_runner_word_indices(_scan_shell_words(command_without_bodies)))


def _interpret_shell_escapes(text: str) -> str:
    """Interpret the printf-style escapes a producer may emit (`\\n`, `\\t`,
    `\\r`) so piped command text scans the way the consuming shell reads it."""
    return re.sub(
        r"\\([ntr])",
        lambda match: {"n": "\n", "t": "\t", "r": "\r"}[match.group(1)],
        text,
    )


def _stdin_shell_feed_texts(prepared: str, words: list[_RmShellWord]) -> list[tuple[str, int]]:
    """(producer text, interpreter word index) pairs for pipelines feeding a
    bare stdin shell: `printf 'rm -rf x\\n' | sh` runs the producer's
    output as commands, so that text must be scanned. Literal interpreters
    read stdin when they carry no file/script argument and no `-c` payload
    (`-s` keeps stdin live with positional arguments); an interpreter named
    through unresolved expansion (`| $SHELL_BIN`) cannot be inspected, so it
    is treated as a stdin shell. The producer window crosses `;`, newlines,
    and other boundaries inside `{...}`/`(...)` groups, where the group's
    whole output feeds the pipe; `|` and `|&` both count as the pipe."""
    boundaries = _boundary_positions(prepared)
    feeds: list[tuple[str, int]] = []
    for index, word in enumerate(words):
        is_shell = os.path.basename(word.value) in _SHELL_DASH_C_INTERPRETERS
        is_expansion_shell = not _expansion_is_resolvable(word.value)
        if not (is_shell or is_expansion_shell):
            continue
        if is_shell:
            has_c = has_s = False
            has_argument = False
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                token = follower.value
                if token.startswith("-") and token != "-":
                    if not token.startswith("--"):
                        has_c = has_c or "c" in token[1:]
                        has_s = has_s or "s" in token[1:]
                    continue
                has_argument = True
                break
            if has_c:
                continue  # a -c payload is handled by the wrapper scan
            if has_argument and not has_s:
                continue  # runs a script file, not stdin
        # Is a pipe feeding this word, and where does its producer start?
        pipe_position = None
        segment_start = 0
        group_depth = 0
        for position, kind in boundaries:
            if position >= word.start:
                break
            if kind in ("(", "{"):
                group_depth += 1
            elif kind in (")", "}"):
                group_depth = max(0, group_depth - 1)
            elif kind in ("|", "|&"):
                pipe_position = position
            elif group_depth == 0:
                segment_start = position
        if pipe_position is None:
            continue
        producer_words = [
            other for other in words if segment_start < other.start < pipe_position
        ]
        if not producer_words:
            continue
        feeds.append((" ".join(other.value for other in producer_words), index))
    return feeds


def _shell_word_end(command: str, start: int) -> int:
    """Index just past the shell word starting at `start`: quote- and
    escape-aware, and stopping at whitespace and unquoted shell operators."""
    i = start
    n = len(command)
    while i < n:
        ch = command[i]
        if ch in " \t\n;&|<>()":
            break
        if ch in "'\"":
            i = _quote_span_end(command, i, n)
            continue
        if ch == "\\":
            i += 2
            continue
        i += 1
    return i


def _inline_shell_text_spans(
    command: str,
) -> tuple[list[tuple[int, int, int]], list[tuple[int, int, int]]]:
    """Spans of the shell text a command hands to another shell inline.

    Returns `(here_strings, process_substitutions)`. A here-string span is
    `(operator_start, operand_start, operand_end)`: `sh <<< 'rm -rf x'` feeds
    the operand word to the interpreter's stdin. A process-substitution span is
    `(word_start, interior_start, interior_end)`: `bash <(printf ...)` runs the
    producer's output as a script file. Both are found outside quoted spans,
    comments, and here-document bodies, so a command that only prints an
    operator keeps it as data."""
    here_strings: list[tuple[int, int, int]] = []
    substitutions: list[tuple[int, int, int]] = []
    bodies = _heredoc_body_spans(command)
    body_index = 0
    i = 0
    n = len(command)
    while i < n:
        while body_index < len(bodies) and bodies[body_index][1] <= i:
            body_index += 1
        if body_index < len(bodies) and bodies[body_index][0] <= i:
            i = bodies[body_index][1]  # a here-document body never runs inline
            continue
        ch = command[i]
        if ch in "'\"":
            i = _quote_span_end(command, i, n)
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == "#" and (i == 0 or command[i - 1] in " \t\n;&|(){}"):
            while i < n and command[i] != "\n":
                i += 1
            continue
        if ch == "$" and command[i + 1 : i + 3] == "((":
            i = _arithmetic_substitution_end(command, i)
            continue
        if ch == "<" and command[i + 1 : i + 2] == "<":
            if command[i + 2 : i + 3] == "<":
                operand_start = i + 3
                while operand_start < n and command[operand_start] in " \t":
                    operand_start += 1
                operand_end = _shell_word_end(command, operand_start)
                if operand_end > operand_start:
                    here_strings.append((i, operand_start, operand_end))
                i = max(operand_end, i + 3)
                continue
            i += 2  # a here-document: its body spans were computed above
            continue
        if ch == "<" and command[i + 1 : i + 2] == "(":
            close = _matching_paren(command, i + 1, n)
            substitutions.append((i, i + 2, close))
            i = close + 1
            continue
        i += 1
    return here_strings, substitutions


def _static_here_string_text(operand: str) -> str | None:
    """The literal text a here-string feeds to a shell's stdin, or None when
    the shell builds that text from expansion the guard cannot resolve."""
    if len(operand) >= 2 and operand[0] == operand[-1] and operand[0] in "'\"":
        inner = operand[1:-1]
        if operand[0] == '"' and any(ch in inner for ch in "$`"):
            return None  # double quotes still expand
        return inner
    if any(ch in operand for ch in "$`{}'\"\\"):
        return None
    return operand


def _stdin_shell_interpreter_index(
    words: list[_RmShellWord], operand_start: int, operand_end: int
) -> int | None:
    """Index of the word that reads a here-string operand from its stdin: a
    shell interpreter with no `-c` payload and no script argument (`-s` keeps
    stdin live with positional arguments), or a word that expands at run time
    and could be one."""
    for index, word in enumerate(words):
        if operand_start <= word.start and word.end <= operand_end:
            continue  # the operand word itself
        is_shell = os.path.basename(word.value) in _SHELL_DASH_C_INTERPRETERS
        if not (is_shell or not _expansion_is_resolvable(word.value)):
            continue
        has_c = has_s = has_argument = False
        for follower in words[index + 1 :]:
            if follower.starts_command:
                break
            if operand_start <= follower.start and follower.end <= operand_end:
                continue  # the here-string is stdin, not an argument
            token = follower.value
            if token.startswith("-") and token != "-":
                if not token.startswith("--"):
                    has_c = has_c or "c" in token[1:]
                    has_s = has_s or "s" in token[1:]
                continue
            has_argument = True
            break
        if has_c or (has_argument and not has_s):
            continue
        return index
    return None


def _here_string_shell_feed_texts(
    command: str, words: list[_RmShellWord]
) -> tuple[list[tuple[str, int]], list[str]]:
    """(feed texts, refusal reasons) for here-strings a shell executes.

    `sh <<< 'rm -rf x'` hands the operand to the interpreter's stdin exactly
    like `printf ... | sh`, so a bare stdin shell's operand is scanned as
    command text. A data consumer (`cat <<< ...`) keeps its operand as data.
    An operand the shell builds from expansion (`sh <<< "$payload"`) runs text
    the guard cannot check statically, so it is refused."""
    feeds: list[tuple[str, int]] = []
    reasons: list[str] = []
    if "<<<" not in command:
        return feeds, reasons  # cheap gate: no here-string to check
    here_strings, _substitutions = _inline_shell_text_spans(command)
    for _operator, operand_start, operand_end in here_strings:
        interpreter = _stdin_shell_interpreter_index(words, operand_start, operand_end)
        if interpreter is None:
            continue
        operand = command[operand_start:operand_end]
        literal = _static_here_string_text(operand)
        if literal is None:
            reasons.append(
                f"{operand!r}: a here-string feeding a shell names the text it"
                " runs through expansion, which the guard cannot resolve"
            )
            continue
        if literal.strip():
            feeds.append((literal, interpreter))
    return feeds, reasons


def _process_substitution_script_reasons(
    command: str, words: list[_RmShellWord], runner_indices: list[int]
) -> list[str]:
    """Refusal reasons for process substitutions a script-running word consumes.

    `bash <(printf 'rm -rf /\n')` runs the producer's output as a script file,
    so the text the shell executes is built at run time and cannot be checked:
    refuse it. A data argument (`cat <(...)`, `diff <(...) <(...)`) is not a
    script, and a runner with its own `-c` payload or script argument keeps the
    substitution as a positional argument, so both stay untouched."""
    reasons: list[str] = []
    if "<(" not in command:
        return reasons  # cheap gate: no process substitution to check
    _here_strings, substitutions = _inline_shell_text_spans(command)
    for word_start, interior_start, interior_end in substitutions:
        for index in runner_indices:
            word = words[index]
            if word.start >= word_start:
                continue
            has_c = has_argument = False
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                if word_start <= follower.start and follower.end <= interior_end:
                    continue  # the substitution is the script argument itself
                token = follower.value
                if token.startswith("-") and token != "-":
                    if not token.startswith("--"):
                        has_c = has_c or "c" in token[1:]
                    continue
                has_argument = True
                break
            if has_c or has_argument:
                continue
            reasons.append(
                f"{command[word_start : interior_end + 1]!r}: hands this shell a"
                " process substitution whose produced script text the guard"
                " cannot check"
            )
            break
    return reasons


def _rm_feed_reasons(
    text: str,
    prepared: str,
    words: list[_RmShellWord],
    *,
    workspace_root: str,
    starts_for: Callable[[int], list[str]],
    reassigns_home: bool,
    reassigns_pwd: bool,
    cdpath_untrackable: bool,
) -> list[str]:
    """Refusal reasons for command text a shell is handed at run time.

    Pipelines feeding a bare stdin shell run the producer's output as
    commands, and a here-string operand is the same text for an interpreter's
    stdin, so both are scanned against the interpreter's tracked directories
    (`starts_for`). A process substitution consumed as a script argument is
    refused instead: its produced script text cannot be checked. The fed shell
    parses its input one command at a time, so alias definitions inside the fed
    text substitute command words there too."""
    reasons: list[str] = []
    reasons.extend(
        _process_substitution_script_reasons(
            text, words, _script_runner_word_indices(words)
        )
    )
    here_feeds, here_reasons = _here_string_shell_feed_texts(text, words)
    reasons.extend(here_reasons)
    for feed_text, interp_index in (
        *_stdin_shell_feed_texts(prepared, words),
        *here_feeds,
    ):
        for variant in (feed_text, _interpret_shell_escapes(feed_text)):
            # A fed text can itself wrap commands in heredocs; split it
            # with the runner-aware scanner before masking, so the
            # blanket redirection masking cannot blank an interpreter-fed
            # body here (the blanked outer still masks > redirects).
            feed_stack = [variant]
            while feed_stack:
                fed = feed_stack.pop()
                expanded_fed = _expand_effective_aliases(fed)
                if expanded_fed is not None:
                    feed_stack.append(expanded_fed)
                fed_outer, inner_texts = _rm_guard_scan_texts(fed)
                feed_stack.extend(inner_texts)
                fed_prepared = _mask_shell_redirections(fed_outer)
                fed_words = _scan_shell_words(fed_prepared)
                if _wrapped_payloads_hide_recursive_force_rm(
                    fed_prepared, words=fed_words
                ):
                    raise DestructiveRmRefusalError(_format_rm_wrapper_refusal())
                reasons.extend(
                    _process_substitution_script_reasons(
                        fed_outer, fed_words, _script_runner_word_indices(fed_words)
                    )
                )
                fed_invocations = _find_rf_rm_invocations_in_words(fed_words)
                if fed_invocations:
                    for start in starts_for(interp_index):
                        fed_tracked_at = _tracked_cwd_at_words(
                            fed_prepared,
                            fed_words,
                            start,
                            home_untrackable=reassigns_home,
                            pwd_untrackable=reassigns_pwd,
                            cdpath_untrackable=cdpath_untrackable,
                        )
                        reasons.extend(
                            _rm_invocation_reasons(
                                fed_words,
                                fed_invocations,
                                workspace_root,
                                fed_tracked_at,
                                reassigns_home,
                                reassigns_pwd,
                            )
                        )
                reasons.extend(_unresolvable_expansion_rm_reasons(fed_words))
    return reasons


def _rm_guard_scan_texts(normalized: str) -> tuple[str, list[str]]:
    """Scan texts for the rm guard: the command with here-document bodies
    blanked, plus each body that can reach a script runner as its own
    command text (returned as a pair).

    A heredoc body is data for the command that reads it (`cat <<EOF`), so
    blanking it avoids false refusals from data text. But a body can still
    run through stdin (`sh <<EOF`), a pipeline consumer after the terminator
    (`{ cat <<EOF ... } | sh`), or a script file written in the same command
    and run through `sh s.sh`, `./s.sh`, `. s.sh`, or `source s.sh`; when
    any word outside the bodies can run shell text, every body is scanned as
    its own command, so its rm invocations are still seen and an unbalanced
    quote inside one body cannot swallow the scan of later text. Bodies that
    cannot reach a runner are never scanned as commands, but their command
    substitution stays live in the outer text: the shell expands $(...) and
    backticks in an unquoted body even when the consumer only prints it.
    Unterminated heredocs report no span and stay part of the outer text
    (conservative)."""
    spans = _heredoc_body_spans(normalized)
    if not spans:
        return normalized, []
    outer = list(normalized)
    for start, end, _expands in spans:
        for pos in range(start, end):
            outer[pos] = " "
    outer_text = "".join(outer)
    if not _heredoc_bodies_reach_script_runners(outer_text):
        # Data bodies are inert for the outer scan, but their command
        # substitution stays live: the shell expands $(...) and backticks in
        # an unquoted heredoc body even when the consumer (cat) only prints
        # the result, so those spans still execute (same rule as the git
        # guard's heredoc masking).
        outer = list(normalized)
        for start, end, expands in spans:
            _mask_heredoc_body(outer, normalized, start, end, expands)
        outer_text = "".join(outer)
        return outer_text, []
    return outer_text, [normalized[start:end] for start, end, _expands in spans]


def _format_rm_operand_refusal(reasons: list[str], live_bypass_attempt: bool) -> str:
    listed = reasons[:_MAX_RM_REFUSALS_LISTED]
    elided = len(reasons) - len(listed)
    lines = [
        "Refusing to run this recursive-force rm command: it targets paths"
        " outside the kernel workspace or protected dot paths.",
        *(f"  {reason}" for reason in listed),
    ]
    if elided > 0:
        lines.append(f"  ... and {elided} more")
    lines += [
        "",
        "Delete inside the workspace with explicit subdirectories instead.",
        "To delete these intentionally, retry with"
        " bash(command, allow_destructive_rm=True), or set"
        f" {BASH_DESTRUCTIVE_RM_BYPASS_ENV}=1 in the kernel's launch"
        " environment (the value is frozen when the kernel starts).",
    ]
    if live_bypass_attempt:
        lines += [
            "",
            f"WARNING: {BASH_DESTRUCTIVE_RM_BYPASS_ENV} was set in os.environ"
            " after the kernel started. Mid-session writes are ignored by"
            " design; set the variable before the kernel launches.",
        ]
    return "\n".join(lines)


def _format_rm_wrapper_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive-force rm command: it wraps rm in"
            " eval, a `sh -c`/`bash -c` payload, or a trap action, and the"
            " paths it would delete cannot be checked safely.",
            "",
            "Run the deletion directly with explicit paths, or retry with"
            " bash(command, allow_destructive_rm=True), or set"
            f" {BASH_DESTRUCTIVE_RM_BYPASS_ENV}=1 in the kernel's launch"
            " environment (the value is frozen when the kernel starts).",
        ]
    )


def _command_reassigns_env(words: list[_RmShellWord], name: str) -> bool:
    """True when the command assigns, appends to, exports, or unsets `name`,
    so operands whose expansion depends on it cannot be taken from the
    kernel environment."""
    for index, word in enumerate(words):
        if re.match(rf"^{name}\+?=", word.value):
            return True
        if word.value in ("export", "unset"):
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                if re.match(rf"^{name}(=|$)", follower.value):
                    return True
    return False


def _rm_invocation_reasons(
    words: list[_RmShellWord],
    invocations: list[tuple[int, list[str]]],
    workspace_root: str,
    tracked_at: list[list[str | None]],
    reassigns_home: bool,
    reassigns_pwd: bool,
) -> list[str]:
    """Refusal reasons for one scan text's recursive-force rm invocations,
    resolving operands against every precomputed candidate directory (any
    escape refuses)."""
    reasons: list[str] = []
    for word_index, operands in invocations:
        candidates = tracked_at[word_index]
        if not operands:
            reasons.append(
                "receives no explicit operand, so names could arrive from"
                " xargs or stdin and cannot be checked"
            )
            continue
        if any(candidate is None for candidate in candidates):
            reasons.append(
                "runs after a cd/pushd the guard cannot resolve, so its"
                " relative targets cannot be checked"
            )
            continue
        for operand in operands:
            if reassigns_home and (
                operand.startswith("~") or re.match(r"^\$\{?HOME", operand)
            ):
                reasons.append(
                    f"{operand!r}: the command reassigns HOME, so the"
                    " expansion the shell performs cannot be tracked"
                )
                continue
            if reassigns_pwd and re.match(r"^\$\{?PWD", operand):
                reasons.append(
                    f"{operand!r}: the command reassigns PWD, so the"
                    " expansion the shell performs cannot be tracked"
                )
                continue
            reason = None
            for candidate in candidates:
                reason = _resolve_rm_operand(operand, workspace_root, candidate)
                if reason:
                    break
            if reason:
                reasons.append(f"{operand!r}: {reason}")
    return reasons


def _expand_effective_aliases(text: str) -> str | None:
    """`text` with every command word an alias replaces substituted by its
    body, or None when no alias applies.

    Aliases substitute command text at parse time, so a later line can run a
    command the source never names (`alias del='rm'` then `del -rf /outside`).
    Only definitions the shell can still apply count: it reads one complete
    command at a time, so a definition only reaches a command on a *later*
    line, and a definition is dropped once its name has been substituted so a
    self-referential alias cannot grow without bound. The substitution is
    iterated (up to _MAX_ALIAS_EXPANSION_PASSES), so alias chains resolve."""
    if "alias" not in text:
        return None  # cheap gate: no definition can apply
    current = text
    for _pass in range(_MAX_ALIAS_EXPANSION_PASSES):
        words = _scan_shell_words(current)
        definitions: list[tuple[int, str, str, tuple[int, int]]] = []
        edits: list[tuple[int, int, str]] = []
        for index, word in enumerate(words):
            if word.value in ("alias", "unalias"):
                line_end = current.find("\n", word.end)
                if line_end == -1:
                    continue  # a same-line definition parses before it applies
                for follower in words[index + 1 :]:
                    if follower.starts_command:
                        break
                    if word.value == "unalias":
                        definitions.append(
                            (line_end, follower.value, "", (follower.start, follower.start))
                        )
                        continue
                    name, separator, body = follower.value.partition("=")
                    if separator and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                        definitions.append(
                            (line_end, name, body, (follower.start, follower.end))
                        )
                continue
            if not word.starts_command:
                continue
            chosen: tuple[int, str, str, tuple[int, int]] | None = None
            for definition in definitions:
                if definition[0] >= word.start:
                    break
                if definition[1] == word.value:
                    chosen = definition
            if chosen is None:
                continue
            if not chosen[2]:
                continue  # unaliased (or an empty body): nothing to substitute
            edits.append((word.start, word.end, chosen[2]))
            start, end = chosen[3]
            edits.append((start, end, " " * (end - start)))
        if not edits:
            return current if current != text else None
        for start, end, replacement in reversed(edits):
            current = current[:start] + replacement + current[end:]
    return current


def _built_command_rm_reasons(
    expanded: str,
    *,
    workspace_root: str,
    starts: list[str],
    reassigns_home: bool,
    reassigns_pwd: bool,
    cdpath_untrackable: bool,
) -> list[str]:
    """Refusal reasons for command text the shell builds at run time.

    The text is scanned as its own command against every directory the
    invocation may run in, because the shell runs it exactly as written here:
    an alias can turn `del victim` into `rm -rf victim`, and a literal
    assignment can turn `$X` into `rm -rf /outside`. Command text that wraps rm
    (`alias wipe='sh -c "rm -rf x"'`) is refused like any other wrapper
    payload."""
    prepared = _mask_shell_redirections(expanded)
    words = _scan_shell_words(prepared)
    if _wrapped_payloads_hide_recursive_force_rm(prepared, words=words):
        raise DestructiveRmRefusalError(_format_rm_wrapper_refusal())
    reasons: list[str] = []
    home = reassigns_home or _command_reassigns_env(words, "HOME")
    pwd = reassigns_pwd or _command_reassigns_env(words, "PWD")
    cdpath = cdpath_untrackable or _command_reassigns_env(words, "CDPATH")
    invocations = _find_rf_rm_invocations_in_words(words)
    for start in starts:
        reasons.extend(
            _rm_invocation_reasons(
                words,
                invocations,
                workspace_root,
                _tracked_cwd_at_words(
                    prepared,
                    words,
                    start,
                    home_untrackable=home,
                    pwd_untrackable=pwd,
                    cdpath_untrackable=cdpath,
                ),
                home,
                pwd,
            )
        )
    reasons.extend(_unresolvable_expansion_rm_reasons(words))
    return reasons


def _alias_expanded_rm_reasons(
    text: str,
    *,
    workspace_root: str,
    starts: list[str],
    reassigns_home: bool,
    reassigns_pwd: bool,
    cdpath_untrackable: bool,
) -> list[str]:
    """Refusal reasons for the command text with effective aliases substituted.

    A later line can invoke a command the source never names (`alias
    del='rm'`), so the substituted text is scanned as its own command; see
    _built_command_rm_reasons."""
    expanded = _expand_effective_aliases(text)
    if expanded is None:
        return []
    return _built_command_rm_reasons(
        expanded,
        workspace_root=workspace_root,
        starts=starts,
        reassigns_home=reassigns_home,
        reassigns_pwd=reassigns_pwd,
        cdpath_untrackable=cdpath_untrackable,
    )


def _assigned_command_rm_reasons(
    text: str,
    *,
    workspace_root: str,
    starts: list[str],
    reassigns_home: bool,
    reassigns_pwd: bool,
    cdpath_untrackable: bool,
) -> list[str]:
    """Refusal reasons for command words the command builds through assignment.

    `X='rm -rf /outside'; $X` runs exactly that invocation, so a command word
    that is a plain `$NAME` reference is substituted with the literal value the
    command assigned to NAME and rescanned; a word whose value the command
    builds from expansion or substitution (`X=$(cat cmd); $X`) runs text the
    guard cannot read, so it is refused. A reference the command never assigns
    stays unresolvable, which the caller's refusal keeps covering."""
    words = _scan_shell_words(text)
    assignments: dict[str, tuple[str, bool]] = {}
    edits: list[tuple[int, int, str]] = []
    reasons: list[str] = []
    for index, word in enumerate(words):
        name, separator, assigned = word.value.partition("=")
        if separator and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            # The shell expands the assigned word at run time, so a value built
            # from an expansion or substitution cannot be read statically.
            literal = not any(ch in text[word.start : word.end] for ch in "$`\\")
            assignments[name] = (assigned, literal)
            continue
        if word.value == "unset":
            for follower in words[index + 1 :]:
                if follower.starts_command:
                    break
                assignments.pop(follower.value, None)
            continue
        if not word.starts_command:
            continue
        reference = _VARIABLE_REFERENCE.fullmatch(word.value)
        if reference is None:
            continue
        assignment = assignments.get(reference.group(1) or reference.group(2))
        if assignment is None:
            continue  # not assigned in this command: leave the word unresolvable
        assigned, literal = assignment
        if not literal:
            reasons.append(
                f"{word.value!r}: is assigned text the guard cannot read"
                " statically, so the command it runs cannot be checked"
            )
            continue
        edits.append((word.start, word.end, assigned))
    if not edits:
        return reasons
    resolved = text
    for start, end, replacement in reversed(edits):
        resolved = resolved[:start] + replacement + resolved[end:]
    reasons.extend(
        _built_command_rm_reasons(
            resolved,
            workspace_root=workspace_root,
            starts=starts,
            reassigns_home=reassigns_home,
            reassigns_pwd=reassigns_pwd,
            cdpath_untrackable=cdpath_untrackable,
        )
    )
    return reasons


def _shell_startup_env_reasons(words: list[_RmShellWord]) -> list[str]:
    """Refusal reasons for assignments that point a child shell's startup at
    text the guard cannot check.

    Non-interactive bash sources `$BASH_ENV` before it runs a command, so
    `BASH_ENV=file bash -c ...` executes a file the guard never sees (the spawn
    already strips an inherited `BASH_ENV`). Exported shell functions travel
    through the environment the same way; their bodies are scanned as wrapper
    payloads by _wrapped_payloads_hide_recursive_force_rm."""
    reasons: list[str] = []
    for word in words:
        name, separator, value = word.value.partition("=")
        if separator and name == "BASH_ENV" and value:
            reasons.append(
                f"{word.value!r}: points a child shell's startup file at a path"
                " whose commands the guard cannot check"
            )
    return reasons


def _guard_destructive_rm(command: str, allow_destructive_rm: bool) -> None:
    """Refuse recursive-force rm invocations whose operands escape the
    workspace or name protected paths. The word scan is pure string work and
    runs only when an rm invocation carries both flags, so other commands pay
    nothing. The scan covers exactly what the spawned shell will run (spawn
    prefix included) and refuses what it cannot resolve statically: quoted
    shell `-c` and eval payloads, quote-blind substitution layouts,
    expansion-hidden commands and flags, cd/pushd relocations, brace
    expansion, HOME/PWD reassignments, symlinked operands, and paths that do
    not exist yet."""
    frozen_bypass = _is_truthy_env_value(_BASH_RM_BYPASS_AT_KERNEL_START)
    if allow_destructive_rm or frozen_bypass:
        return
    # Scan what the shell will run: the spawn prepends
    # PRIME_AGENT_BASH_COMMAND_PREFIX, and that env value is model-writable
    # mid-session, so the guard must not assume it stays benign.
    normalized = _join_line_continuations(_with_prefix(command))
    outer_text, body_texts = _rm_guard_scan_texts(normalized)
    reasons: list[str] = []
    try:
        cwd = os.getcwd()
        workspace_root = os.path.realpath(cwd)
    except OSError:
        cwd = None  # the spawn itself will fail; the guard must not mask that error
    # ---- outer pass ----
    prepared = _mask_shell_redirections(outer_text)
    # The wrapper scan matches parsed word values, so escaped names
    # (`t\\rap`, `ev\\al`) cannot slip past a raw substring gate; it runs on
    # the pre-scanned words, so other commands only pay a light pass.
    words = _scan_shell_words(prepared)
    if _wrapped_payloads_hide_recursive_force_rm(prepared, words=words):
        raise DestructiveRmRefusalError(_format_rm_wrapper_refusal())
    invocations = _find_rf_rm_invocations_in_words(words)
    runner_indices = _script_runner_word_indices(words)
    reassigns_home = _command_reassigns_env(words, "HOME")
    reassigns_pwd = _command_reassigns_env(words, "PWD")
    if cwd is None:
        if invocations or body_texts:
            return  # the spawn itself will fail; the guard must not mask that error
        reasons.extend(_unresolvable_expansion_rm_reasons(words))
    else:
        cdpath_untrackable = bool(os.environ.get("CDPATH")) or _command_reassigns_env(
            words, "CDPATH"
        )
        tracked_at = _tracked_cwd_at_words(
            prepared,
            words,
            workspace_root,
            home_untrackable=reassigns_home,
            pwd_untrackable=reassigns_pwd,
            cdpath_untrackable=cdpath_untrackable,
        )
        reasons.extend(
            _rm_invocation_reasons(
                words, invocations, workspace_root, tracked_at, reassigns_home, reassigns_pwd
            )
        )
        reasons.extend(_unresolvable_expansion_rm_reasons(words))
        if runner_indices:
            # A command-level BASH_ENV points a child shell's startup file at a
            # path whose commands the guard never sees (the spawn already
            # strips an inherited value).
            reasons.extend(_shell_startup_env_reasons(words))
        # Aliases substitute command text at parse time, so a later line can
        # run a command the source never names, and a literal assignment can
        # hand a later `$NAME` command word a whole invocation.
        for built_command_reasons in (
            _alias_expanded_rm_reasons,
            _assigned_command_rm_reasons,
        ):
            reasons.extend(
                built_command_reasons(
                    outer_text,
                    workspace_root=workspace_root,
                    starts=[workspace_root],
                    reassigns_home=reassigns_home,
                    reassigns_pwd=reassigns_pwd,
                    cdpath_untrackable=cdpath_untrackable,
                )
            )
        # The bodies run wherever the outer command has relocated to: resolve
        # them against every script runner's tracked directory (any escape
        # refuses), and inherit the outer HOME/PWD reassignments.
        runner_starts = list(
            dict.fromkeys(
                candidate for word_index in runner_indices for candidate in tracked_at[word_index]
            )
        )
        # Pipelines feeding a bare stdin shell run the producer's output as
        # commands, and a here-string hands a bare stdin shell the text it
        # runs: scan both against the interpreter's tracked state.
        reasons.extend(
            _rm_feed_reasons(
                outer_text,
                prepared,
                words,
                workspace_root=workspace_root,
                starts_for=lambda index: tracked_at[index],
                reassigns_home=reassigns_home,
                reassigns_pwd=reassigns_pwd,
                cdpath_untrackable=cdpath_untrackable,
            )
        )
    # ---- body passes ----
    # A body can itself wrap commands in heredocs; split it with the
    # runner-aware scanner before masking, so the blanket redirection
    # masking cannot blank an interpreter-fed body here either (the blanked
    # outer still masks > redirects). Data bodies never come back from the
    # splitter, so consumer-aware silencing survives. Each queued text
    # carries the HOME/PWD/CDPATH reassignment context of everything above
    # it: a reassignment made in an outer body keeps tracking the bodies it
    # wraps, the way the pre-split whole-body scan saw it.
    scan_queue = [
        (text, reassigns_home, reassigns_pwd, cdpath_untrackable)
        for text in body_texts
    ]
    while scan_queue:
        body_text, body_home, body_pwd, body_cdpath_inherited = scan_queue.pop()
        if "$(" in body_text or "`" in body_text:
            # An unquoted heredoc body is expanded before the consuming
            # interpreter sees it, and the child executes the substitution
            # output either way: that text is unknowable at guard time.
            reasons.append(
                "its here-document body carries command substitution, whose"
                " output the consuming shell executes and the guard cannot"
                " check statically"
            )
        body_outer, inner_body_texts = _rm_guard_scan_texts(body_text)
        body_prepared = _mask_shell_redirections(body_outer)
        body_words = _scan_shell_words(body_prepared)
        if _wrapped_payloads_hide_recursive_force_rm(body_prepared, words=body_words):
            raise DestructiveRmRefusalError(_format_rm_wrapper_refusal())
        body_reassigns_home = body_home or _command_reassigns_env(body_words, "HOME")
        body_reassigns_pwd = body_pwd or _command_reassigns_env(body_words, "PWD")
        body_cdpath = body_cdpath_inherited or bool(os.environ.get("CDPATH")) or _command_reassigns_env(
            body_words, "CDPATH"
        )
        scan_queue.extend(
            (text, body_reassigns_home, body_reassigns_pwd, body_cdpath)
            for text in inner_body_texts
        )
        # A body can itself feed a shell inline: a pipeline producer or a
        # here-string inside it hands that shell text to run.
        reasons.extend(
            _rm_feed_reasons(
                body_outer,
                body_prepared,
                body_words,
                workspace_root=workspace_root,
                starts_for=lambda _index: runner_starts or [workspace_root],
                reassigns_home=body_reassigns_home,
                reassigns_pwd=body_reassigns_pwd,
                cdpath_untrackable=body_cdpath,
            )
        )
        # A body runs in its own shell, so aliases it defines and invokes on a
        # later line, or a command word it builds by assignment, substitute
        # command text the body never names.
        for body_built_reasons in (
            _alias_expanded_rm_reasons,
            _assigned_command_rm_reasons,
        ):
            reasons.extend(
                body_built_reasons(
                    body_outer,
                    workspace_root=workspace_root,
                    starts=runner_starts or [workspace_root],
                    reassigns_home=body_reassigns_home,
                    reassigns_pwd=body_reassigns_pwd,
                    cdpath_untrackable=body_cdpath,
                )
            )
        body_invocations = _find_rf_rm_invocations_in_words(body_words)
        if not body_invocations:
            reasons.extend(_unresolvable_expansion_rm_reasons(body_words))
            continue
        for start in runner_starts or [workspace_root]:
            body_tracked_at = _tracked_cwd_at_words(
                body_prepared,
                body_words,
                start,
                home_untrackable=body_reassigns_home,
                pwd_untrackable=body_reassigns_pwd,
                cdpath_untrackable=body_cdpath,
            )
            reasons.extend(
                _rm_invocation_reasons(
                    body_words,
                    body_invocations,
                    workspace_root,
                    body_tracked_at,
                    body_reassigns_home,
                    body_reassigns_pwd,
                )
            )
        reasons.extend(_unresolvable_expansion_rm_reasons(body_words))
    if reasons:
        live_bypass_attempt = _is_truthy_env_value(
            os.environ.get(BASH_DESTRUCTIVE_RM_BYPASS_ENV)
        )
        raise DestructiveRmRefusalError(
            _format_rm_operand_refusal(reasons, live_bypass_attempt)
        )


def bash(command: str, *, allow_destructive_git: bool = False, allow_destructive_rm: bool = False) -> BashHandle:
    """Start a shell command immediately; await the handle for the result.

    `await bash(cmd)` is a one-shot: cancelling the await (e.g. an interrupt)
    kills the command's process group. `h = bash(cmd)` used as a background
    handle (any .pid/.running/.output()/.tail()/.poll()/.kill() access before
    the first await) survives cancellation; awaiting it only waits. Leak
    containment is per-platform: process groups plus the orphan journal on
    POSIX; a kill-on-close job object on Windows entered while the child is
    still suspended, so no descendant can escape it and kill()/crash cleanup
    are unconditional -- bash() raises if containment cannot be established.
    Output written after the completion fence (e.g. by an EXIT trap or a
    background job) is not in BashResult.output but stays visible via
    handle.output()/tail().

    Destructive git discard commands (`git checkout -- .`, `git restore .`,
    `git reset --hard`, `git clean` that is not a dry run) are refused while
    the repository they target has uncommitted changes; retry with
    allow_destructive_git=True
    only when the discard is intentional. PI_BASH_ALLOW_DESTRUCTIVE_GIT=1 in
    the launching environment disables the guard for the whole kernel; it is
    read once at kernel start, so writing it mid-session has no effect.

    Recursive-force rm commands (`rm -rf`, `-fr`, `-Rf`,
    `--recursive --force`) are refused when an operand resolves outside the
    current workspace (HOME itself, /, parent directories, other trees,
    relocations through cd/pushd), names a protected dot path (`..`, `.git`,
    `.env`-class), or cannot be checked statically (globs, substitutions,
    stdin lists, eval and `sh -c`/`bash -c` payloads, brace expansion,
    symlinked operands, paths that do not exist yet); retry with
    allow_destructive_rm=True (or
    PI_BASH_ALLOW_DESTRUCTIVE_RM=1 frozen at kernel start) only when the
    deletion is intentional.
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    _guard_destructive_git(command, allow_destructive_git)
    _guard_destructive_rm(command, allow_destructive_rm)
    return BashHandle(command)


def _shell() -> str:
    # Read per call so env changes made in the REPL apply to later commands.
    override = os.environ.get("PRIME_AGENT_BASH_SHELL")
    if override:
        if not os.path.isabs(override):
            raise ValueError("PRIME_AGENT_BASH_SHELL must be an absolute path")
        return override
    if not _IS_POSIX:
        # Never consult PATH on Windows: a repo-controlled PATH could supply
        # the shell. The host injects PRIME_AGENT_BASH_SHELL when one exists.
        raise RuntimeError(
            "bash() needs PRIME_AGENT_BASH_SHELL set to the absolute path of a "
            "POSIX shell on Windows (e.g. install Git Bash in its default "
            "location so the host injects it)"
        )
    # PATH fallback only serves bare/standalone POSIX runtime use: the host
    # always injects PRIME_AGENT_BASH_SHELL (an absolute path) when a shell exists.
    shell = shutil.which("bash")
    return shell or "/bin/sh"


def _with_prefix(command: str) -> str:
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    return f"{prefix}\n{command}" if prefix else command


def _fence_printf() -> str:
    # `\command -p printf` defeats alias expansion but not a user-defined shell
    # function named `command`, which would swallow both fence frames and leave
    # the await hanging until the shell dies (wedged behind background jobs). A
    # slash-qualified command name bypasses function and alias lookup for
    # ordinary command names, so resolve printf on the system default utility PATH.
    path = shutil.which("printf", path=os.confstr("CS_PATH") or os.defpath)
    if path and "'" not in path:
        return f"'{path}'"
    return "\\command -p printf"


def _status_script(command: str, completion_a: str, completion_b: str) -> str:
    # Closed control fds preserve background behavior; supported shells atomically write the frame.
    emit = _fence_printf()
    return (
        f"exec {_STATUS_FD}>&0 {_OUTPUT_FD}>&1 0</dev/null\n"
        f"read -r _prime_agent_gate <&{_STATUS_FD} || exit 127\n"
        "{\n"
        f"{command}\n"
        f"}} {_OUTPUT_FD}>&- {_STATUS_FD}>&-\n"
        "__prime_status=$?\n"
        "\\set +x\n"
        f"{emit} '\\036prime-agent-complete:%s%s\\037' "
        f"'{completion_a}' '{completion_b}' >&{_OUTPUT_FD} || exit \"$__prime_status\"\n"
        f"{emit} '%s\\n' \"$__prime_status\" >&{_STATUS_FD}\n"
        f"exec {_OUTPUT_FD}>&- {_STATUS_FD}>&-\n"
        "wait\n"
        'exit "$__prime_status"\n'
    )


def _child_env() -> dict[str, str]:
    """Environment for kernel-spawned shell commands.

    Same non-interactive guard as the coding-agent shell tool
    (packages/coding-agent/src/utils/shell.ts): agent shell commands have no
    usable stdin, so interactive prompts (git commit without -m opening
    $EDITOR, credential asks, pagers) can only hang. Fail fast or no-op
    instead. Deliberately overrides inherited terminal settings; a
    per-command inline assignment (`GIT_EDITOR=vim git commit`) still wins
    because it replaces the exported value for that command.
    """
    env = {
        **os.environ,
        "NO_COLOR": "1",
        "TERM": "dumb",
        "CLICOLOR": "0",
        "FORCE_COLOR": "0",
        "GIT_EDITOR": "true",
        "GIT_SEQUENCE_EDITOR": "true",
        "GIT_TERMINAL_PROMPTS": "0",
        "GIT_ASKPASS": "true",
        "SSH_ASKPASS_REQUIRE": "never",
        "EDITOR": "true",
        "VISUAL": "true",
        "PAGER": "cat",
        "GIT_PAGER": "cat",
        "DEBIAN_FRONTEND": "noninteractive",
    }
    if not _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START:
        # Do not leak a mid-session bypass write into child kernels: they
        # freeze their own launch-time copy, and an inherited forged value
        # would arm as if the user had authorized it at launch.
        env.pop(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, None)
    if not _is_truthy_env_value(_BASH_RM_BYPASS_AT_KERNEL_START):
        # Same rationale for the rm bypass: strip it unless the launch-time
        # snapshot authorizes it, so a mid-session write cannot arm a child
        # kernel's frozen copy (a falsy launch value like "0" stays stripped).
        env.pop(BASH_DESTRUCTIVE_RM_BYPASS_ENV, None)
    # Non-interactive bash sources $BASH_ENV (and some shells $ENV) before
    # the command; the env is model-writable mid-session, so never let it
    # smuggle an unscanned startup file past the guards.
    env.pop("BASH_ENV", None)
    env.pop("ENV", None)
    # Bash also imports exported shell functions from `BASH_FUNC_name%%`
    # entries in its environment, which would run under a command name the
    # guards read literally (`BASH_FUNC_rm%%=() { rm -rf /; }` shadows rm).
    for name in [name for name in env if name.startswith("BASH_FUNC_")]:
        env.pop(name, None)
    return env


def _signal_group(pid: int, sig: int) -> bool:
    """True when the signal was delivered or the group is already gone."""
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        return True  # already dead: safe to mark the journal record inactive
    except OSError:
        return False  # not delivered: the record must stay active for the host reaper
    return True


def _system32(*parts: str) -> str:
    # Absolute paths for Windows helper binaries: PATH (and CWD on Windows
    # CPython) lookup could resolve a planted taskkill.exe/powershell.exe.
    root = os.environ.get("SystemRoot", r"C:\Windows")
    return os.path.join(root, "System32", *parts)


def _helper_env() -> dict[str, str]:
    return {**os.environ, "NoDefaultCurrentDirectoryInExePath": "1"}


def _taskkill_tree(pid: int) -> bool:
    # Windows has no process groups to signal; taskkill /T kills the whole tree.
    try:
        return (
            subprocess.run(
                [_system32("taskkill.exe"), "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
                env=_helper_env(),
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _process_start_id(pid: int) -> str | None:
    if os.name == "nt":
        # Mirrors getWindowsProcessStartId in session-lease.ts byte-for-byte so
        # the host's identity comparison matches the journaled string.
        try:
            out = subprocess.run(
                [
                    _system32("WindowsPowerShell", "v1.0", "powershell.exe"),
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    f"([System.Diagnostics.Process]::GetProcessById({pid})).StartTime.ToUniversalTime().Ticks",
                ],
                capture_output=True,
                text=True,
                timeout=5,
                env=_helper_env(),
            ).stdout.strip()
            return f"win:{out}" if out.isdigit() else None
        except (OSError, subprocess.SubprocessError):
            return None
    try:
        with open(f"/proc/{pid}/stat", "r") as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2 :].split(" ")
        if len(fields) > 19 and fields[19]:
            return f"proc:{fields[19]}"
    except (OSError, ValueError):
        pass
    try:
        # macOS has no /proc; /bin/ps is always present there, so use the
        # absolute path (bare `ps` stays only as the exotic-POSIX last resort).
        ps = "/bin/ps" if sys.platform == "darwin" else "ps"
        out = subprocess.run(
            [ps, "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=5
        ).stdout.strip()
        return f"ps:{out}" if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def _record_journal(pid: int, active: bool) -> bool:
    # Returns False only when the journal is configured but enrollment failed;
    # active-record callers must then fail closed. Active records always carry
    # a processStartId so host reaping stays identity-verified.
    path = os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL")
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    if not path or not owner:
        return True
    try:
        owner_pid = int(owner)
    except ValueError:
        return False
    start_id = _process_start_id(pid) if active else None
    if active and start_id is None:
        return False
    record: dict[str, Any] = {
        "version": 1,
        "pid": pid,
        "ownerPid": owner_pid,
        # The host reaps bash children per kernel pid when it kills or loses this kernel.
        "kernelPid": os.getpid(),
        **({"processStartId": start_id} if start_id else {}),
        "active": active,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    data = (json.dumps(record) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            # Complete-write loop: a short write would leave a truncated JSON
            # line that the host discards, which must count as failure.
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    return False
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        return False
    return True


def _kill_live_handles() -> None:
    with _live_lock:
        handles = list(_live_handles)
    for handle in handles:
        if _IS_POSIX:
            delivered = _signal_group(handle._pid, signal.SIGKILL)
        else:
            with handle._kill_lock:
                if handle._reaped:
                    continue
                delivered = handle._job is not None and _winjob.terminate(handle._job)
                if not delivered:
                    delivered = _taskkill_tree(handle._pid)
                if not delivered:
                    # Leader-only fallback cannot prove the tree died: never
                    # justifies an inactive record.
                    try:
                        handle._proc.kill()
                    except OSError:
                        pass
        if delivered:
            _record_journal(handle._pid, active=False)


def _install_shutdown_hook() -> None:
    global _hook_installed
    with _hook_lock:
        if _hook_installed:
            return
        _hook_installed = True
    atexit.register(_kill_live_handles)
