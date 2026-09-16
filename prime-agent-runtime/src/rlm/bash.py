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
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Generator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

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

# The probe is read-only, but a wedged git must not wedge the kernel.
_PROBE_TIMEOUT_SECONDS = 10.0
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

# Detection for git commands that discard uncommitted working-tree changes
# (the "clean the worktree" discard idiom). Conservative by design: a false
# positive costs one `git status` probe and an explicit-bypass retry; a false
# negative silently loses work. Matching is best-effort shell-text
# heuristics, not a parse.

# Optional git global options between `git` and the subcommand, for example
# `git -C dir reset --hard`, `git -c key=value checkout -- .`, or
# `git --git-dir=dir/.git reset --hard`. Kept within one shell segment
# (no ;&|) so it cannot swallow the rest of a chained command.
_GIT_GLOBAL_OPTIONS = r'''(?:-{1,2}[^\s;&|]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s+)*'''

_DISCARD_CHECKOUT_PATTERN = re.compile(
    r"\bgit\s+"
    + _GIT_GLOBAL_OPTIONS
    + r"checkout\s+"
    + r"""(?:(?:(?:-[fm]|--ours|--theirs|--conflict=\S+)\s+)*(?:--\s+)?(?:\./?|:/)"""
    + r"""|[^\s;&|()]+\s+(?:--\s+)?(?:\./?|:/)"""
    + r"""|(?:-f|--force)\s+[^\s;&|()]+)(?=\s|$|[;&|)])"""
)
# Restore options accepted before the pathspec; the capture lets the finder
# check whether staged (index-only) or worktree flags are in play.
_RESTORE_OPTION = re.compile(
    r"""(?:--source(?:=\S+)?|--worktree|--staged|--quiet|-s\s+\S+|-s[^\s;&|]+|-S[^\s;&|]*|-W[^\s;&|]*|-q[^\s;&|]*|--)\s+"""
)
_DISCARD_RESTORE_PATTERN = re.compile(
    r"\bgit\s+"
    + _GIT_GLOBAL_OPTIONS
    + r"restore\s+"
    + r"((?:"""
    + _RESTORE_OPTION.pattern
    + r""")*)"""
    + r"""(?:\./?|:/)(?=\s|$|[;&|)])"""
)


def _restore_options_discard_worktree(option_region: str) -> bool:
    """`git restore` targets the working tree by default; `--staged`/`-S`
    alone restores only the index. Bundled shorts keep their meaning:
    `-SW` restores both targets."""
    tokens = [token for token in re.split(r"\s+", option_region) if token]
    for token in tokens:
        if token == "--":
            break  # everything after -- is a pathspec
        if token.startswith("--"):
            if token.startswith("--worktree"):
                return True
        elif "W" in token:
            return True
    for token in tokens:
        if token == "--":
            break
        if token.startswith("--"):
            if token.startswith("--staged"):
                return False
        elif "S" in token:
            return False
    return True  # no flags: default worktree restore
_DISCARD_RESET_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"reset\s+(?:(?:-[^\s;&|]+)\s+)*--hard\b"
)
_DISCARD_CLEAN_PATTERN = re.compile(
    r"\bgit\s+" + _GIT_GLOBAL_OPTIONS + r"clean\s+([^;&|]*)"
)


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
            elif ch == "#" and (i == 0 or re.match(r"[\s;&|(){}]", chars[i - 1])):
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


def _mask_heredoc_body(chars: list[str], command: str, start: int, end: int) -> None:
    """Blank heredoc data in place, keeping substitution spans live.

    A heredoc body never executes as shell commands, but `$(...)` and
    backtick spans inside it expand (and so can execute) before cat sees
    the text; those stay live for the discard scan.
    """
    i = start
    while i < end:
        ch = command[i]
        if ch == "$" and command[i + 1 : i + 2] == "(":
            depth = 0
            j = i
            while j < end:
                if command[j] == "(":
                    depth += 1
                elif command[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            i = j + 1
        elif ch == "`":
            j = i + 1
            while j < end and command[j] != "`":
                j += 1
            i = j + 1
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
            if ch == "#" and (i == 0 or re.match(r"[\s;&|(){}]", chars[i - 1])):
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
                if operator.group(0) == "<<" and target_end > operator.end():
                    # A heredoc body is inert data: blank it up to the
                    # delimiter line, keeping command substitution live
                    # (it executes even inside a heredoc). Without a
                    # terminator, leave the text live (conservative).
                    delimiter = command[target_start:target_end]
                    pos = command.find("\n", target_end)
                    while pos != -1:
                        line_stop = command.find("\n", pos + 1)
                        line = (
                            command[pos + 1 :]
                            if line_stop == -1
                            else command[pos + 1 : line_stop]
                        )
                        if line.rstrip() == delimiter:
                            _mask_heredoc_body(
                                chars, command, target_end, len(command) if line_stop == -1 else line_stop
                            )
                            break
                        pos = line_stop
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
            # redirections inside it too (its own redirects are syntax).
            depth = 0
            j = i + 1
            while j < n:
                if chars[j] == "(":
                    depth += 1
                elif chars[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            interior = _mask_shell_redirections(command[i + 2 : j])
            chars[i + 2 : j] = list(interior)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n and chars[j] != "`":
                j += 1
            interior = _mask_shell_redirections(command[i + 1 : j])
            chars[i + 1 : j] = list(interior)
            i = j
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
            # An unquoted # at a word boundary starts a comment; mask to end of line.
            prev = chars[i - 1] if i > 0 else None
            if ch == "#" and (i == 0 or prev is None or re.match(r"[\s;&|(){}]", prev)):
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
            # inside it must stay data (recursively masked).
            depth = 0
            j = i
            while j < n:
                if chars[j] == "(":
                    depth += 1
                elif chars[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            interior = _mask_quoted_spans(command[i + 2 : j])
            chars[i + 2 : j] = list(interior)
            i = j - 1
        elif ch == "`":
            # Backtick substitution inside double quotes still executes; keep
            # it live, masking quoted data in its interior like $().
            j = i + 1
            while j < n and chars[j] != "`":
                j += 1
            interior = _mask_quoted_spans(command[i + 1 : j])
            chars[i + 1 : j] = list(interior)
            i = j - 1
        else:
            chars[i] = " "
        i += 1
    return "".join(chars)


def _is_forced_clean_segment(args: str) -> bool:
    tokens = [token for token in re.split(r"\s+", args) if token]
    # Everything after -- is a pathspec, not options (git clean -f -- -n is forced).
    if "--" in tokens:
        option_tokens = tokens[: tokens.index("--")]
    else:
        option_tokens = tokens
    forces = [
        token
        for token in option_tokens
        if (
            token.startswith("--force")
            if token.startswith("--")
            else token.startswith("-") and "f" in token
        )
    ]
    if not forces:
        return False
    return not any(
        token == "--dry-run"
        or (token.startswith("-") and not token.startswith("--") and "n" in token)
        for token in option_tokens
    )


def _find_destructive_git_discard_commands(command: str) -> list[int]:
    """Find every destructive git discard command in `command`, returning the
    character index where each `git` token starts (empty when none match)."""
    normalized, index_map = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(command))
    )
    masked = _mask_quoted_spans(normalized)
    indices: list[int] = []
    for pattern in (_DISCARD_CHECKOUT_PATTERN, _DISCARD_RESET_PATTERN):
        indices.extend(match.start() for match in pattern.finditer(masked))
    for match in _DISCARD_RESTORE_PATTERN.finditer(masked):
        if _restore_options_discard_worktree(match.group(1)):
            indices.append(match.start())
    for match in _DISCARD_CLEAN_PATTERN.finditer(masked):
        if _is_forced_clean_segment(match.group(1)):
            indices.append(match.start())
    return sorted(index_map[index] for index in indices)


def is_destructive_git_discard_command(command: str) -> bool:
    """True when `command` contains a git command that discards uncommitted
    working-tree changes (`git checkout -- .`, `git restore .`,
    `git reset --hard`, forced `git clean`)."""
    return bool(_find_destructive_git_discard_commands(command))


# `eval` re-parses its payload, so a quoted argument that the masking of the
# plain scan must treat as data still executes. Unquote each eval payload one
# shell quoting layer at a time and rescan; a discard found in any layer is
# refused outright because the payload can relocate or chain freely.
_MAX_EVAL_SCAN_DEPTH = 10


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


def _eval_payloads_hide_destructive_git(command: str, depth: int = 0) -> bool:
    """True when a quoted `eval` payload hides a destructive git discard.

    Only unquoted eval tokens are scanned (a masked eval cannot run), and
    each payload is unquoted one layer at a time so nested evals and nested
    quoting levels are handled without ever confusing quoted data with
    executable text. Command substitution stays outside this check: its
    output is unknowable statically, and the substitution itself already
    runs (and is scanned) before eval sees the result.
    """
    if depth > _MAX_EVAL_SCAN_DEPTH:
        return True  # absurdly nested evals: refuse rather than risk a miss
    command = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(command))
    )[0]
    masked = _mask_quoted_spans(command)
    for match in re.finditer(r"\beval\b", masked):
        # The payload runs from just after the eval token to the next
        # unquoted command separator (masked text keeps those live).
        region_end = len(command)
        for j in range(match.end(), len(masked)):
            if masked[j] in ";&|\n":
                region_end = j
                break
        payload = _unquote_one_level(command[match.end() : region_end])
        if _find_destructive_git_discard_commands(payload):
            return True
        if "eval" in payload and _eval_payloads_hide_destructive_git(payload, depth + 1):
            return True
    return False


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
        if re.fullmatch(r'''[A-Za-z_][A-Za-z0-9_]*=[^\s$`;&|()<>"]+''', token):
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
    assignment_pattern = r'''[A-Za-z_][A-Za-z0-9_]*=[^\s$`;&|()<>"]+'''
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
            seg_tokens = [token for token in re.split(r"\s+", segments[index].strip()) if token]
            if seg_tokens and seg_tokens[0] in ("source", "."):
                # A sourced script runs in the current shell and may `cd`,
                # so the discard's directory cannot be replayed safely.
                return _UNRESOLVABLE_DISCARD_TARGET
            if parts[2 * index + 1] not in (";", "&&", "\n"):
                continue  # pipe/subshell or short-circuit: the env does not persist
            if not seg_tokens:
                continue
            if seg_tokens[0] == "export":
                seg_tokens = seg_tokens[1:]
                if not seg_tokens or not all(
                    re.fullmatch(assignment_pattern, token) for token in seg_tokens
                ):
                    return _UNRESOLVABLE_DISCARD_TARGET
                persistent_assignments.extend(seg_tokens)
            elif all(re.fullmatch(assignment_pattern, token) for token in seg_tokens):
                persistent_assignments.extend(seg_tokens)
    env_prefix = (
        " ".join(persistent_assignments + assignments) + " "
        if persistent_assignments or assignments
        else ""
    )

    # cd relocations earlier in the command. cds inside grouping parentheses
    # do not persist: they only matter when the discard itself runs inside the
    # still-open group, tracked via paren depth. Segments before
    # userCommandStart belong to the configured command prefix, which the
    # probe already replays verbatim, so their cds are not re-applied.
    persistent_cd_args: list[str] = []
    grouped_cd_args: list[str] = []
    saw_cd = False
    paren_depth = 0
    cd_pending_separator = False
    if re.search(r"\b(?:cd|pushd)\b", prefix) or "(" in prefix:
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
                group_cd = re.match(r"cd\s*(.*)$", body)
                if group_cd:
                    arg = group_cd.group(1).strip()
                    if not arg or re.search(r'''[$`;&|()<>#"]''', arg):
                        return _UNRESOLVABLE_DISCARD_TARGET
                    saw_cd = True
                    cd_pending_separator = True
                    grouped_cd_args.append(arg)
                elif re.search(r"\b(?:cd|pushd)\b", trimmed):
                    return _UNRESOLVABLE_DISCARD_TARGET  # group content we cannot replay
                # A closed group's cds do not persist and must not leak into a
                # later still-open group's chain.
                if paren_depth == 0:
                    grouped_cd_args.clear()
                continue
            # Brace groups run in the current shell, so a `{ cd sub && git
            # reset --hard; }` relocates the discard like a bare cd chain.
            group_free = re.sub(r"^\{\s*", "", trimmed)
            if group_free == "pushd" or group_free.startswith("pushd "):
                return _UNRESOLVABLE_DISCARD_TARGET
            cd_match = re.match(r"cd\s*(.*)$", group_free)
            if not cd_match:
                cd_pending_separator = False
                continue  # not a cd: cannot change cwd
            arg = cd_match.group(1).strip()
            # An arg we cannot replay safely (substitution, redirection,
            # backgrounding, comments, or quotes split by segmenting) leaves
            # the target repository unknown; refuse rather than probe blindly.
            balanced = arg.count('"') % 2 == 0 and arg.count("'") % 2 == 0
            if not balanced or (arg and re.search(r'''[$`;&|()<>#]''', arg)):
                return _UNRESOLVABLE_DISCARD_TARGET
            saw_cd = True
            cd_pending_separator = True
            persistent_cd_args.append(arg)

    # When the discard runs inside a still-open group, its directory is the
    # persistent cd chain inherited by the group plus the group's own cds.
    cd_args = persistent_cd_args + grouped_cd_args if paren_depth > 0 else persistent_cd_args

    if not cd_args and dash_c_dir is None and not clean_removes_ignored and not env_prefix:
        return None
    ignored = " --ignored=matching" if clean_removes_ignored else ""
    cd_prefix = (
        " && ".join(f"cd {arg}" if arg else "cd" for arg in cd_args) + " && " if cd_args else ""
    )
    if dash_c_dir:
        git_status = f"git -C {dash_c_dir} status --porcelain --untracked-files=all{ignored}"
    else:
        git_status = f"git status --porcelain --untracked-files=all{ignored}"
    return _DiscardProbeTarget(
        relocation_prefix=(cd_prefix + env_prefix) or None,
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


def _probe_uncommitted_changes(probe_command: str, cwd: str) -> list[str] | None:
    """Probe at-risk files via `git status --porcelain --untracked-files=all`
    (plus `--ignored=matching` when the discard deletes ignored files) in
    `cwd`. Returns None when dirtiness cannot be determined (not a repo, git
    missing, probe failure) so the guard fails open instead of blocking on a
    guess."""
    try:
        completed = subprocess.run(
            [_shell(), "-c", probe_command],
            cwd=cwd,
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    output = completed.stdout[:_PROBE_OUTPUT_CAP_BYTES].decode("utf-8", errors="replace")
    return [line.removesuffix("\r") for line in output.split("\n") if line.strip()]


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
    if "eval" in resolved and _eval_payloads_hide_destructive_git(resolved):
        # An eval payload hides where the discard runs; refuse rather than
        # probe a command the guard cannot replay.
        raise DestructiveGitRefusalError(_format_eval_refusal())
    discard_indices = _find_destructive_git_discard_commands(resolved)
    if not discard_indices:
        return
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    user_command_start = len(prefix) + 1 if prefix else 0
    probes: list[tuple[str, bool]] = []
    seen_probes: set[str] = set()
    for index in discard_indices:
        target = _resolve_discard_probe_target(resolved, index, user_command_start)
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


def bash(command: str, *, allow_destructive_git: bool = False) -> BashHandle:
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
    `git reset --hard`, forced `git clean`) are refused while the repository
    they target has uncommitted changes; retry with allow_destructive_git=True
    only when the discard is intentional. PI_BASH_ALLOW_DESTRUCTIVE_GIT=1 in
    the launching environment disables the guard for the whole kernel; it is
    read once at kernel start, so writing it mid-session has no effect.
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    _guard_destructive_git(command, allow_destructive_git)
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
