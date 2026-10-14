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
import uuid
from collections import deque
from collections.abc import Callable, Collection, Generator
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, NamedTuple, NoReturn, cast

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
# Display MIME the host aggregates into a per-cell summary of the bash()
# commands the cell ran (first capped command, count, line total).
_BASH_COMMAND_MIME = "application/vnd.prime-agent.bash-command+json"
_ASYNCIO_WRAPPER_CALLBACKS = {
    ("asyncio.tasks", "gather.<locals>._done_callback"),
    ("asyncio.tasks", "shield.<locals>._inner_done_callback"),
    ("asyncio.tasks", "_wait.<locals>._on_completion"),
    ("asyncio.tasks", "as_completed.<locals>._on_completion"),
    ("asyncio.tasks", "_release_waiter"),
}

_live_handles: set["BashHandle"] = set()
# Kernel-owned opaque IDs: retained results are bounded, never resolved by PID.
_activity_handles: dict[str, "BashHandle"] = {}
_activity_order: deque[str] = deque()
_ACTIVITY_HISTORY_CAP = 64
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


def _capped(command: str) -> str:
    if len(command) > _COMPLETION_NOTICE_COMMAND_CAP:
        return command[:_COMPLETION_NOTICE_COMMAND_CAP] + "\n... [command truncated]"
    return command


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

    def __init__(
        self, command: str, script: str | None = None, _validated: bool = False
    ) -> None:
        # `command` is the text the caller wrote and stays the display value
        # (the completion notice and repr use it). `script` is the text the
        # shell runs, computed once by `bash()` from a single read of
        # PRIME_AGENT_BASH_COMMAND_PREFIX and already validated there; a handle
        # built directly is guarded here on the same one read that supplies its
        # script, so constructing the class is not a way around the guards.
        if script is None:
            command_prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
            script = _prefix_command(command, command_prefix)
            _run_kernel_bash_guards(command, script, command_prefix)
        elif not _validated:
            # A caller-supplied script has no trusted prefix region: scan the
            # whole text as user text so a prefix boundary cannot hide words.
            _run_kernel_bash_guards(command, script, None)
        self.command = command
        self._script = script
        self._activity_id = secrets.token_hex(16)
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
        self._started_at = datetime.now(timezone.utc).isoformat()
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
                self._script,
                completion_token[:token_midpoint],
                completion_token[token_midpoint:],
            )
        else:
            # Windows lacks a foreground-status channel, so its exit drain stays best-effort.
            script = self._script
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
            _activity_handles[self._activity_id] = self
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
            _activity_order.append(self._activity_id)
            while len(_activity_order) > _ACTIVITY_HISTORY_CAP:
                _activity_handles.pop(_activity_order.popleft(), None)

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

        activity = {"id": self._activity_id, "pid": self._pid, "active": True}
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
            command = _capped(self.command)
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
        dispatch = functools.partial(self._notify_result_consumed, command)

        with self._callback_lock:
            if not self._result_consumed:
                self._consumed_notice = dispatch
                return
        dispatch()

    def _notify_result_consumed(self, command: str) -> None:
        """Ship the withdrawal inside the read, ahead of the cell's done event.

        The host delivers a queued notice at the reading cell's turn boundary,
        which begins when that cell's done event is processed: a withdrawal
        frame that leaves the kernel after done arrives too late, and the stale
        notice wakes the model anyway. Reads happen inside a live cell, so
        writing the frame right here puts it ahead of done on the wire, where
        the host must withdraw before it can dispatch. The reply never matters
        (unknown reply ids are dropped), so the request is fire-and-forget:
        no future to await, no event-loop hop that could run after the cell.
        """
        from . import repl

        if not repl.is_active():
            return
        repl._send(
            {
                "event": "host_request",
                "id": uuid.uuid4().hex,
                "data": {"type": "bash.consumed", "pid": self._pid, "command": command},
            }
        )

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
            _activity_handles.pop(self._activity_id, None)
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

    def __reduce__(self) -> NoReturn:
        # Reviving a handle would resurrect a stale pid and raw fd numbers: dill
        # restores the pickled pipe by reopening its fd number in the new kernel
        # (and closing it), so a snapshot must never persist a live handle.
        raise TypeError("cannot pickle 'BashHandle' object: live process handle")

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
# Tokens that open a command context without being the command word, so the
# shell still reads an assignment after them (`{ PWD=/x; }`,
# `if true; then PWD=/x; fi`). The grouping parens never reach the word list as
# words, but the shell reads an assignment after them the same way.
_COMMAND_CONTEXT_TOKENS = _SHELL_KEYWORDS | frozenset({"(", ")"})
# Reserved words after which the next word runs as a command, so an assigned
# `$NAME` there is substituted like a command-boundary reference (`{ $X; }`,
# `if $X; then ...; fi`); list and terminator positions (`for`, `in`, `case`,
# `fi`, `done`) never execute their next word, so those stay unresolvable.
_EXECUTING_KEYWORDS = frozenset(
    {
        "{", "!", "if", "elif", "else", "then", "while", "until", "do", "time",
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


def _guard_destructive_git(
    command: str,
    allow_destructive_git: bool,
    command_prefix: str | None = None,
    script: str | None = None,
) -> None:
    """Refuse destructive git discard commands while the tree they target is
    dirty. The pattern check is string-only and the probe runs only on a
    match, so clean runs pay nothing. `script` is the text the shell will run
    and `command_prefix` the `PRIME_AGENT_BASH_COMMAND_PREFIX` value pinned by
    the caller, so the scan reads the prefix once instead of re-reading the
    environment."""
    if allow_destructive_git or _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START:
        return
    # Match the prefixed command exactly as the shell will run it; the prefix
    # is replayed in the probe, so hook-provided shell setup applies to both.
    # Line continuations and shell redirections are normalized first (both
    # length-preserving) so the patterns and the probe resolution see the
    # same argv the shell will hand to git.
    if script is None:
        if command_prefix is None:
            command_prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
        script = _with_prefix(command, command_prefix)
    resolved = _mask_shell_redirections(_normalize_line_continuations(script))
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
    # The caller pinned the prefix (bash() reads it once per call), so the
    # boundary below never re-reads the environment.
    user_command_start = len(command_prefix) + 1 if command_prefix else 0
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
        probe_command = _with_prefix(relocation_prefix + git_status, command_prefix)
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

# Recursive chmod/chown workspace-escape guard (wave-1 safety audit gap 4).
# The kernel cwd can be HOME or any directory outside a project checkout, so
# a recursive chmod/chown issued from the kernel can silently take out the
# home directory or the filesystem root. Detection is string-only best-effort
# shell-text heuristics; on a match every operand the guard can resolve is
# checked, and operands it cannot resolve statically are refused, never
# silently allowed.

# Bypass env var for the recursive chmod/chown guard.
BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_CHMOD"

# The bypass env var is honored only when present at kernel start: the model
# can write os.environ, so a live read on each guard call would let a single
# os.environ assignment neuter the guard. The frozen copy cannot change after
# import; a value that appears mid-session only triggers a loud warning and
# is ignored.
_DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START = os.environ.get(
    BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV
) not in (None, "", "0")

_destructive_chmod_late_bypass_warned = False


class DestructiveChmodRefusalError(RuntimeError):
    """A recursive chmod/chown was refused for escaping the workspace."""


# Shell-text normalization for the guard's scans: line continuations and
# redirections are folded or masked first so the patterns and the operand
# resolver see the argv the shell will hand to chmod/chown.


def _chmod_normalize_line_continuations(command: str) -> str:
    """Collapse unquoted backslash-newline line continuations.

    The shell removes the pair before it builds words, so `chmod -R \
755 ~` runs as `chmod -R 755 ~` and `chmo\
d -R 755 ~` runs as `chmod -R 755 ~` (an in-word continuation joins the
    word). A continuation between words becomes two spaces, which is
    length-preserving so the scan's character indices stay aligned with the
    original command; inside a word the pair is left for
    `_chmod_strip_shell_escapes` to remove, because a two-character placeholder
    there would fuse with a preceding `$` into ANSI-C quoting and hide the
    expansion. Single-quoted
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
                if i == 0 or re.match(r"[\s;&|(){}<>]", chars[i - 1]):
                    # Between words: the pair separates them, so two spaces
                    # keep the word layout and the indices aligned.
                    chars[i] = " "
                    chars[i + 1] = " "
                # Inside a word the pair must join it, and the empty quoted
                # string it used to be replaced with fused with a preceding
                # `$` into ANSI-C quoting; the pair now stays and
                # `_chmod_strip_shell_escapes` removes both characters, so
                # `chmo<continuation>d` scans as `chmod` while
                # `$<continuation>cmd` stays the expansion `$cmd`.
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


# A shell redirection word: optional fd, the operator, an optional &fd
# duplication (which has no filename target), and an attached target (empty
# for the `2> file` split form). Targets containing quotes, substitution, or
# process-substitution syntax stay live: masking them could hide a command
# substitution that executes. An operator directly followed by `(` is a
# process substitution (`<(...)`, `>(...)`), not a redirection: it stays
# live too, so the guard can see that a wrapper consumes its output.
_CHMOD_REDIRECT_OPERATOR = re.compile(r"(?:&>{1,2}|>&|[0-9]*[<>]{1,3}(&[0-9]+)?)(?!\()")
_CHMOD_STATIC_REDIRECT_TARGET = re.compile(r"""[^\s;&|<>()$`"']*""")


def _locate_heredoc(command: str, operator: re.Match) -> tuple[str | None, int, int | None, bool]:
    """Locate the here-document starting after `operator` (an already
    matched fd-prefixed `<<`/`<<-`): returns the delimiter text, the end of
    the delimiter word, the end of the terminator line (None when the
    terminator is missing or the delimiter cannot be resolved statically --
    an expandable delimiter leaves the body extent unknowable), and whether
    `<<-` strips leading tabs from terminator lines."""
    n = len(command)
    heredoc_tabs = command[operator.end() : operator.end() + 1] == "-"
    j = operator.end() + (1 if heredoc_tabs else 0)
    while j < n and command[j].isspace():
        j += 1
    delim_start = j
    if j < n and command[j] in ("'", '"'):
        quote_char = command[j]
        j += 1
        while j < n and command[j] != quote_char:
            j += 1
        delim = command[delim_start + 1 : j]
        j += 1
    else:
        delim_match = _CHMOD_STATIC_REDIRECT_TARGET.match(command, j)
        j = delim_match.end()
        delim = delim_match.group(0)
    if not delim or re.search(r"[$`\\]", delim):
        return None, min(j, n), None, heredoc_tabs
    pos = j
    while pos < n:
        line_end = command.find("\n", pos)
        line = command[pos :] if line_end == -1 else command[pos : line_end]
        if heredoc_tabs:
            line = line.lstrip("\t")
        if line == delim:
            return delim, j, (n if line_end == -1 else line_end), heredoc_tabs
        if line_end == -1:
            break
        pos = line_end + 1
    return delim, j, None, heredoc_tabs


# The deepest nesting of command substitutions (`$(...)`, backticks) any
# scan will recurse into. Real commands nest a handful of levels, so this
# never trips on legitimate text; deeper nesting is hostile input that
# would otherwise exhaust the scan stack (Python frames per level), and
# hostile input must refuse, not crash.
_MAX_SUBSTITUTION_NESTING = 100

# Heredoc bodies scanned as shell code recurse one guard pass per wrapper
# level; deeper hostile nesting refuses with the guard's own error instead
# of exhausting the Python stack (same bound class as substitutions).
_MAX_HEREDOC_NESTING = 25


def _format_chmod_nesting_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: its command text nests more"
            f" than {_MAX_SUBSTITUTION_NESTING} levels of command"
            " substitution, too deep for the guard to scan.",
            "",
            "Simplify the command, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _chmod_mask_shell_redirections(command: str, depth: int = 0) -> str:
    """Blank out shell redirection words, keeping character positions.

    The shell consumes redirections (`2>/dev/null`, `> log`, `2>&1`,
    `</dev/null`, heredoc markers) before chmod sees its argv, so a command
    like `chmod 2>/dev/null -R 755 ~` must scan as `chmod -R 755 ~`.
    Only the operator and a fully static attached or next-word target are
    masked (pure syntax); quoted data, comments, command substitution, and
    process substitution stay live so the guard keeps seeing what executes.
    Redirections inside a substitution or backtick are masked recursively;
    hostile nesting deeper than `_MAX_SUBSTITUTION_NESTING` refuses with
    the guard's own error instead of exhausting the Python stack.
    """
    if depth > _MAX_SUBSTITUTION_NESTING:
        raise DestructiveChmodRefusalError(_format_chmod_nesting_refusal())
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
            operator = _CHMOD_REDIRECT_OPERATOR.match(command, i)
            if operator and "<<<" in operator.group(0):
                # A here-string feeds a command's stdin from command text:
                # it stays live so the wrapper-fed gates can see the form.
                i = operator.end()
                continue
            if operator and operator.group(0).endswith("<<"):
                # A here-document: the delimiter, the body, and the
                # terminator line are all consumed by the shell, and the
                # body is data (an unmatched quote in it must not corrupt
                # the later scan), so they are masked through the
                # terminator. Without a terminator bash swallows the whole
                # rest as body and nothing after it executes, so the rest
                # may stay live; a body that executes as a wrapper's
                # script is scanned separately by the guard.
                delim, delim_end, body_end, _tabs = _locate_heredoc(command, operator)
                for k in range(operator.start(), min(delim_end, n)):
                    chars[k] = " "
                if body_end is not None:
                    for k in range(delim_end, body_end):
                        chars[k] = " "
                i = delim_end if body_end is None else body_end
                continue
            if operator:
                for j in range(operator.start(), operator.end()):
                    chars[j] = " "
                i = operator.end()
                attached = _CHMOD_STATIC_REDIRECT_TARGET.match(command, i)
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
                    detached = _CHMOD_STATIC_REDIRECT_TARGET.match(command, j)
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
            # redirections inside it too (its own redirects are syntax).
            paren_depth = 0
            j = i + 1
            while j < n:
                if chars[j] == "(":
                    paren_depth += 1
                elif chars[j] == ")":
                    paren_depth -= 1
                    if paren_depth == 0:
                        break
                j += 1
            interior = _chmod_mask_shell_redirections(command[i + 2 : j], depth + 1)
            chars[i + 2 : j] = list(interior)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n and chars[j] != "`":
                j += 1
            interior = _chmod_mask_shell_redirections(command[i + 1 : j], depth + 1)
            chars[i + 1 : j] = list(interior)
            i = j
        i += 1
    return "".join(chars)


def _chmod_strip_shell_escapes(command: str) -> tuple[str, list[int]]:
    """Remove unquoted backslash escapes, mapping indices back to the input.

    The shell treats an unquoted `\\X` as a literal X, so `ch\\mod -R
    755 ~` must scan as `chmod -R 755 ~`. Quoted and commented spans
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
            elif ch == "\\" and i + 1 < n and command[i + 1] == "\n":
                # An in-word line continuation: the shell removes both
                # characters before it builds the word, so they are dropped.
                i += 1
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
            elif ch == "\\" and i + 1 < n and command[i + 1] == "\n":
                # A line continuation is removed even inside double
                # quotes, so the word it splits joins back together.
                chars.pop()
                index_map.pop()
                i += 1
            elif ch == "\\" and i + 1 < n:
                chars.append(command[i + 1])
                index_map.append(i + 1)
                i += 1
            i += 1
    return "".join(chars), index_map


# `eval` re-parses its payload, so a quoted argument that the plain scan
# must treat as data still executes. Unquote each eval payload one
# shell quoting layer at a time and rescan; a recursive chmod/chown found in
# any layer is refused outright because the payload can relocate or chain
# freely.
_CHMOD_MAX_EVAL_SCAN_DEPTH = 10


def _chmod_unquote_one_level(text: str) -> str:
    """Remove the outermost quoting layer from `text`.

    Inner quotes stay quoted so the next scan layer still treats them as
    data: `eval "echo 'chmod -R 755 ~'"` must stay harmless after the first
    unquote, while `eval 'cd sub && chmod -R 755 ~'` must not. Quote
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


@dataclass(frozen=True)
class _ChmodShellWord:
    """One shell word: its unquoted argv value plus the span it came from."""

    value: str
    start: int
    end: int
    starts_command: bool  # first word of a fresh (sub)command context
    # True when the word is a command-substitution interior: its span sits
    # inside the enclosing word, which the scanner appends after the
    # interiors it recursed into. Computed at scan time so walkers answer
    # containment in O(1) instead of rescanning every later word.
    contained: bool = False


def _chmod_matching_paren(command: str, open_index: int, end: int) -> int:
    """Index of the `)` matching the `(` at `open_index`, or `end - 1`.

    A command substitution is a full subshell context, so parens inside
    quotes or behind a backslash are data, not syntax: `$(echo ')'; chmod
    -R 755 /)` closes at the final `)`, and a blind paren count that stops
    at the quoted one hides the chmod from the interior scan. Quote and
    escape state are tracked while matching; inside double quotes and
    backticks only a nested `$(` counts (its `)` closes it), and an
    unbalanced open paren never matches, so the interior extends to
    `end - 1` and stays scanned."""
    depth = 0  # nesting of $() below the one whose close is being sought
    quote: str | None = None
    i = open_index
    while i < end:
        ch = command[i]
        if quote is None:
            if ch == "\\" and i + 1 < end:
                i += 2  # an escaped paren is a literal, never syntax
                continue
            if ch in ("'", '"', "`"):
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return i
        elif quote == "'":
            if ch == "'":
                quote = None
        elif quote in ('"', "`"):
            if ch == "\\" and i + 1 < end:
                i += 2  # a backslash still escapes inside these
                continue
            if ch == quote:
                quote = None
            elif ch == "$" and command[i + 1 : i + 2] == "(":
                depth += 1  # $() still nests inside double quotes
                i += 1
            elif ch == ")" and depth > 1:
                depth -= 1  # closes the nested $() it opened; a quoted
                # `)` never closes the substitution itself
        i += 1
    return end - 1


# ANSI-C ($'...') escape folding: bash decodes these into the word before
# matching the command, so `$'chmod'` must scan as `chmod` and `$'-R'` as
# `-R`. Bash keeps the backslash for escapes it does not recognize, so the
# same folding here keeps command names, flags, and operands exact; an
# unterminated word folds to end-of-string (bash would refuse the command).
_CHMOD_ANSI_C_SIMPLE_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
    "`": "`",
}


def _fold_ansi_c(body: str) -> str:
    """Fold the escape sequences of a $'...' body exactly like bash."""
    out: list[str] = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        esc = body[i + 1]
        if esc in _CHMOD_ANSI_C_SIMPLE_ESCAPES:
            out.append(_CHMOD_ANSI_C_SIMPLE_ESCAPES[esc])
            i += 2
            continue
        if esc in "01234567":
            digits = esc
            j = i + 2
            while len(digits) < 3 and j < n and body[j] in "01234567":
                digits += body[j]
                j += 1
            out.append(chr(int(digits, 8) & 0xFF))
            i = j
            continue
        if esc == "x":
            digits = ""
            j = i + 2
            while len(digits) < 2 and j < n and body[j] in "0123456789abcdefABCDEF":
                digits += body[j]
                j += 1
            if digits:
                out.append(chr(int(digits, 16)))
                i = j
            else:
                out.append("\\")
                out.append("x")
                i += 2
            continue
        if esc == "c":
            nxt = body[i + 2 : i + 3]
            if nxt:
                out.append("\x7f" if nxt == "?" else chr(ord(nxt) & 0x1F))
                i += 3
            else:
                out.append("\\")
                out.append("c")
                i += 2
            continue
        if esc in "uU":
            width = 4 if esc == "u" else 8
            digits = ""
            j = i + 2
            while len(digits) < width and j < n and body[j] in "0123456789abcdefABCDEF":
                digits += body[j]
                j += 1
            if digits:
                try:
                    out.append(chr(int(digits, 16)))
                except ValueError:
                    # Above Unicode's maximum code point: preserve the
                    # escape instead of crashing the guard on command text.
                    out.append("\\" + esc + digits)
                i = j
            else:
                out.append("\\")
                out.append(esc)
                i += 2
            continue
        out.append("\\")
        out.append(esc)
        i += 2
    return "".join(out)


def _fold_ansi_c_span(text: str, i: int, end: int) -> tuple[str, int]:
    """Fold the $'...' starting at index i (the `$`), bounded by end.

    Returns the folded word text and the index just past the closing quote
    (or end when the word is unterminated)."""
    j = i + 2
    while j < end and text[j] != "'":
        j += 2 if text[j] == "\\" else 1
    return _fold_ansi_c(text[i + 2 : min(j, end)]), j + 1


def _expand_ansi_c_payloads(text: str) -> str:
    """Fold $'...' spans to their expanded content and $\"...\" spans to
    their double-quoted form, so a payload (or a cd argument) scans like
    the string bash actually hands the wrapper."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "$" and text[i + 1 : i + 2] == "'":
            folded, i = _fold_ansi_c_span(text, i, n)
            out.append(folded)
            continue
        if ch == "$" and text[i + 1 : i + 2] == '"':
            out.append('"')
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _mark_contained_interiors(
    words: list[_ChmodShellWord],
    scan_region: "Callable[..., None]",
    start: int,
    end: int,
    depth: int,
) -> None:
    """Scan a substitution interior and mark every word it produced as
    contained: its span sits inside the enclosing word that follows, so
    walkers answer containment in O(1) via the flag instead of rescanning
    every later word."""
    mark_from = len(words)
    scan_region(start, end, starts_command=True, depth=depth + 1)
    for k in range(mark_from, len(words)):
        words[k] = replace(words[k], contained=True)


def _chmod_scan_shell_words(command: str) -> list[_ChmodShellWord]:
    """Split `command` into shell words the way the shell builds argv.

    Quotes and backslash escapes fold into the word value, comments are
    skipped, and command substitution (`$(...)`, backticks) keeps its
    interior scanned as live commands because it executes; the substituted
    result itself stays in the enclosing word, so an operand carrying it
    reads as unresolvable. Redirections are masked by the caller. This is
    a conservative approximation, not a parse: anything it cannot represent
    exactly ends up refused, never silently allowed. Substitution interiors
    recurse one scan per nesting level, so hostile nesting deeper than
    `_MAX_SUBSTITUTION_NESTING` refuses with the guard's own error instead
    of exhausting the Python stack.
    """
    words: list[_ChmodShellWord] = []

    def scan_region(
        start: int, end: int, *, starts_command: bool, depth: int = 0
    ) -> None:
        if depth > _MAX_SUBSTITUTION_NESTING:
            raise DestructiveChmodRefusalError(_format_chmod_nesting_refusal())
        i = start
        value: list[str] = []
        word_start = -1
        word_starts_command = False
        first_word_pending = starts_command

        def flush(starts_next_command: bool) -> None:
            nonlocal word_start, first_word_pending
            if word_start != -1:
                words.append(_ChmodShellWord("".join(value), word_start, i, word_starts_command))
                value.clear()
                word_start = -1
                first_word_pending = starts_next_command
            else:
                first_word_pending = first_word_pending or starts_next_command

        def scan_double_quote(j: int, depth: int) -> int:
            """Scan a double-quoted region starting just after its opening
            quote, folding escapes and scanning substitution interiors."""
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
                    close = _chmod_matching_paren(command, j + 1, end)
                    _mark_contained_interiors(words, scan_region, j + 2, close, depth)
                    value.append(command[j + 1 : close + 1])
                    j = close + 1
                    continue
                if inner == "`":
                    close = _backtick_close(command, j + 1, end)
                    if close == -1:
                        close = end - 1
                    _mark_contained_interiors(words, scan_region, j + 1, close, depth)
                    value.append(command[j + 1 : close + 1])
                    j = close + 1
                    continue
                value.append(inner)
                j += 1
            return j

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
                i = scan_double_quote(i + 1, depth)
                continue
            if ch == "$" and command[i + 1 : i + 2] == "'":
                # ANSI-C quoting: bash folds $'...' escapes into the word
                # before command matching, so the guard scans the folded
                # value exactly, never the bare `$` (which never matches a
                # command name).
                folded, i = _fold_ansi_c_span(command, i, end)
                value.append(folded)
                continue
            if ch == "$" and command[i + 1 : i + 2] == '"':
                # $"..." is locale double quoting: it scans like a double
                # quote (the `$` adds nothing to the word value).
                i = scan_double_quote(i + 2, depth)
                continue
            if ch == "$" and command[i + 1 : i + 2] == "(":
                close = _chmod_matching_paren(command, i + 1, end)
                _mark_contained_interiors(words, scan_region, i + 2, close, depth)
                value.append(command[i + 1 : close + 1])
                i = close + 1
                continue
            if ch == "`":
                close = _backtick_close(command, i + 1, end)
                if close == -1:
                    close = end - 1
                _mark_contained_interiors(words, scan_region, i + 1, close, depth)
                value.append(command[i + 1 : close + 1])
                i = close + 1
                continue
            value.append(ch)
            i += 1
        flush(False)

    scan_region(0, len(command), starts_command=True)
    return words


def _is_chmod_chown_word(value: str) -> bool:
    """True when the word invokes chmod/chown, including slash-qualified
    forms (`/bin/chmod`, `./chown`) that basename-match the real command."""
    return os.path.basename(value) in ("chmod", "chown")


_RECURSIVE_LONG_FLAGS = (
    # GNU getopt accepts every unambiguous prefix of --recursive, so the
    # guard must match --rec through --recursiv exactly like --recursive
    # (the ambiguous --re/--ref prefixes stay out: GNU rejects those).
    "--rec",
    "--recur",
    "--recurse",
    "--recurs",
    "--recursi",
    "--recursiv",
    "--recursive",
)


def _is_recursive_chmod_chown_token_run(tokens: list[str]) -> bool:
    """True when a token run contains a recursive flag: `-R` (bundled with
    other short options anywhere), `--recursive`, or any unambiguous GNU
    abbreviation of it (`--rec` through `--recursiv`). The `--` terminator
    ends option parsing, so a `-R` after it is an operand naming a file,
    not the recursive flag."""
    for token in tokens:
        if token == "--":
            break
        if token in _RECURSIVE_LONG_FLAGS:
            return True
        if token.startswith("-") and not token.startswith("--") and "R" in token[1:]:
            return True
    return False


def _backtick_close(command: str, start: int, end: int) -> int:
    """Index of the backtick closing a substitution, or -1. Bash's scanner
    consumes a backslash pair before it looks for the closer, so an escaped
    backtick never closes the substitution; a blind find() would stop the
    span early and hide executable text inside the substitution from the
    interior scan (the escaped-backtick vector in the tests runs its chmod
    in real bash and must be refused, not hidden)."""
    i = start
    while i < end:
        ch = command[i]
        if ch == "\\":
            i += 2  # an escaped character: the pair is data, not a closer
            continue
        if ch == "`":
            return i
        i += 1
    return -1


def _contained_in_later_word(words: list[_ChmodShellWord], index: int) -> bool:
    """True when words[index] is a command-substitution interior: its span
    sits inside the enclosing word, which the scanner appends after the
    interiors it recursed into, and the scan marks the flag at scan time.
    Interiors execute inside the substitution, so walkers must look
    through them, not stop at them."""
    return words[index].contained


def _find_recursive_chmod_chown_invocations(
    command: str,
    words: list[_ChmodShellWord] | None = None,
    hash_alias_names: Collection[str] | None = None,
) -> list[tuple[int, int, int]]:
    """Find every recursive chmod/chown invocation, returning each as a
    (start, end, word_index) span: from the command word to the last word of
    the invocation (before the next command). Words fold quotes and escapes
    into their values, so quoted command names (`"chmod" -R 755 ~`) and
    quoted flags (`chmod '-R' 755 ~`) scan exactly like their unquoted
    forms. `hash_alias_names` carries the names a `hash -p` registration in
    the command points at chmod/chown (`hash -p /bin/chmod safe`), which run
    that file whatever the command word looks like."""
    if words is None:
        words = _chmod_scan_shell_words(command)
    invocations: list[tuple[int, int, int]] = []
    for index, word in enumerate(words):
        if not _is_chmod_chown_word(word.value) and not (
            hash_alias_names is not None and word.value in hash_alias_names
        ):
            continue
        end = word.end
        tokens = [word.value]
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if _contained_in_later_word(words, follower_index):
                    continue  # substitution interior: the enclosing word follows
                break
            tokens.append(follower.value)
            end = follower.end
        if _is_recursive_chmod_chown_token_run(tokens):
            invocations.append((word.start, end, index))
            continue
        # An expansion-carrying word in the flag region (before the mode
        # operand) can expand to the recursive flag itself (`r=-R; chmod
        # "$r" 755 /`), so the invocation stays in scope for the operand
        # resolver to fail closed on. The region ends at the first token
        # that is neither an option nor expansion-built: that is the mode.
        for token in tokens[1:]:
            if not token.startswith("-") and not _CHMOD_GLOB_OR_SUBSTITUTION.search(token):
                break
            if _CHMOD_GLOB_OR_SUBSTITUTION.search(token):
                invocations.append((word.start, end, index))
                break
    return invocations


_CHMOD_HASH_BUILTIN = "hash"


def _chmod_hash_registered_command_names(
    words: list[_ChmodShellWord],
) -> tuple[set[str], bool]:
    """(names a `hash -p` registration points at chmod/chown, unreadable).

    Bash's command hash table maps a name to the file it resolved to, and
    `hash -p pathname name` installs such an entry by hand, so a later `name`
    runs `pathname` however the name looks (`hash -p /bin/chmod safe; safe -R
    755 /`). The guard resolves the entry, so the registered name scans like
    the command it runs; a registration whose target or name is built from
    expansion is reported as unreadable, because that entry could point
    anywhere. `hash` without `-p` only reads or clears the table, which
    cannot make a word run chmod/chown."""
    aliased: set[str] = set()
    unreadable = False
    for index, word in enumerate(words):
        if os.path.basename(word.value) != _CHMOD_HASH_BUILTIN:
            continue
        # The builtin only registers from the command slot; an argument like
        # `echo hash hash` is data, and rescanning its suffix would make the
        # guard quadratic on command-text length. The slot passes through
        # assignment prefixes and grouping tokens the way the wrapper chain
        # reads them, so `FOO=1 hash -p ...` still registers while an
        # argument-position `hash` does not.
        if not word.starts_command:
            slot = True
            for before in reversed(words[:index]):
                if _CHMOD_ASSIGNMENT_WORD.match(before.value) or before.value in _COMMAND_SLOT_NOISE:
                    if before.starts_command:
                        break  # an assignment/grouping run head passes the slot
                    continue
                if before.value.startswith("-") and before.value != "-":
                    continue  # a dispatcher or command option word: the head still decides
                slot = False  # an argument or command word takes the slot
                break
            if not slot:
                continue
        has_pathname_option = False
        attached: str | None = None
        operands: list[str] = []
        for token in _run_tokens_from(words, index)[1:]:
            if token.startswith("-") and token != "-" and not token.startswith("--"):
                position = token[1:].find("p")
                if position != -1:
                    has_pathname_option = True
                    value = token[position + 2 :]
                    if value:
                        attached = value  # `hash -p/bin/chmod safe`
                continue
            if token.startswith("--"):
                continue
            if not has_pathname_option:
                break  # `hash name`/`hash -d name`: no registration
            operands.append(token)
            if len(operands) == 2:
                break
        if not has_pathname_option:
            continue
        if attached is not None and operands:
            pathname, name = attached, operands[0]
        elif len(operands) == 2:
            pathname, name = operands
        else:
            continue
        if _UNRESOLVED_EXPANSION.search(pathname + name) or (
            _EXPANDABLE_GLOB_CHARS.search(pathname)
        ):
            # An expansion or glob builds the pathname the shell resolves, so
            # the command this entry registers cannot be read statically.
            unreadable = True
        elif os.path.basename(pathname) in ("chmod", "chown"):
            aliased.add(name)
    return aliased, unreadable


_WRAPPER_PAYLOAD_KINDS = ("eval", "shell_c", "alias", "trap")


def _wrapper_payload_sources(
    words: list[_ChmodShellWord], text: str, kinds: tuple[str, ...]
) -> list[str]:
    """Raw payload sources handed to wrapper words in already-scanned
    `words`: the words after each `eval` (joined with spaces), or the
    payload word after the `-c` flag of each sh/bash/zsh/dash/ksh wrapper.
    `text` is the exact string the word spans index into (quotes intact).
    Only quoted `sh -c` payloads are returned for the shell_c kind:
    unquoted payloads already scan as plain invocations."""
    sources: list[str] = []
    for index, word in enumerate(words):
        kind = None
        if "eval" in kinds and word.value == "eval":
            kind = "eval"
        elif "shell_c" in kinds and os.path.basename(word.value) in _SHELL_C_INTERPRETERS:
            kind = "shell_c"
        elif "alias" in kinds and os.path.basename(word.value) == "alias":
            kind = "alias"
        elif "trap" in kinds and word.value == "trap":
            kind = "trap"
        if kind in ("eval", "alias", "trap"):
            payload_parts: list[str] = []
            for follower_index in range(index + 1, len(words)):
                follower = words[follower_index]
                if follower.starts_command:
                    if _contained_in_later_word(words, follower_index):
                        continue  # substitution interior: the enclosing word follows
                    break
                payload_parts.append(text[follower.start : follower.end])
            if payload_parts:
                sources.append(" ".join(payload_parts))
        elif kind == "shell_c":
            c_pending = False
            for follower_index in range(index + 1, len(words)):
                follower = words[follower_index]
                if follower.starts_command:
                    if _contained_in_later_word(words, follower_index):
                        continue  # substitution interior: the enclosing word follows
                    break
                token = follower.value
                if c_pending:
                    if _contained_in_later_word(words, follower_index):
                        continue  # substitution interior: the enclosing word is the payload
                    payload_source = text[follower.start : follower.end]
                    # An unquoted command substitution or backtick payload
                    # is unscannable output: accept it so the payload scan
                    # fails closed on it.
                    if payload_source.startswith(("'", '"', "$'", '$"', "$(", "`")):
                        sources.append(payload_source)
                    break  # the payload word ends this shell invocation
                if token == "--":
                    break
                if (
                    token.startswith("-")
                    and token != "-"
                    and not token.startswith("--")
                    and "c" in token[1:]
                ):
                    c_pending = True
    return sources


def _payload_text_hides_shell_code(
    text: str, depth: int = 0, command_prefix: str | None = None
) -> str | None:
    """Why a one-level-unquoted wrapper payload hides shell code the guard
    must refuse, or None when it does not: a recursive chmod/chown
    (directly, or behind further quoted wrappers: mixed or nested eval and
    `sh -c` forms), the argv an `env -S` string splits into, a command name
    a variable, substitution, or `hash -p` registration could point at, a
    BASH_ENV arming, a shell wrapper that would source a startup file, or a
    process substitution feeding a shell wrapper. Each layer is unquoted one
    shell quoting level at a time, so quoted data stays inert while quoted
    code is caught. Absurd nesting is refused outright."""
    if depth > _CHMOD_MAX_EVAL_SCAN_DEPTH:
        return "recursive_chmod"  # absurdly nested wrappers: refuse rather than risk a miss
    normalized, _index_map = _chmod_strip_shell_escapes(
        _chmod_mask_shell_redirections(_chmod_normalize_line_continuations(text))
    )
    words = _chmod_scan_shell_words(normalized)
    hash_alias_names, hash_unreadable = _chmod_hash_registered_command_names(words)
    if hash_unreadable:
        return "unresolvable_command"
    if _find_recursive_chmod_chown_invocations(normalized, words, hash_alias_names):
        return "recursive_chmod"
    if _bash_env_words_arm_shell_code(words):
        return "bash_env"
    if _unresolvable_words_could_recurse(
        words, normalized, require_recursive_flag=False
    ):
        return "unresolvable_command"
    if _process_substitution_feeds_wrapper(normalized, words):
        return "process_substitution"
    env_split_feeds, env_split_reasons = _chmod_env_split_string_feeds(words)
    for feed in env_split_feeds:
        reason = _payload_text_hides_shell_code(feed, depth + 1, command_prefix)
        if reason is not None:
            return reason
    if env_split_reasons:
        return "env_split_expansion"
    if any(os.path.basename(w.value) in _SCRIPT_INPUT_WRAPPERS for w in words):
        script_reason = _unscanned_wrapper_script_reason(
            text, normalized, words, 0, command_prefix
        )
        if script_reason == "startup":
            return "shell_startup"
        if script_reason is not None:
            return "unscanned_script"
    for source in _wrapper_payload_sources(words, normalized, _WRAPPER_PAYLOAD_KINDS):
        payload = _chmod_unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, depth + 1, command_prefix)
        if reason is not None:
            return reason
    return None


def _eval_payloads_hide_recursive_chmod(
    command: str, depth: int = 0, command_prefix: str | None = None
) -> str | None:
    """Why a quoted `eval` payload hides shell code the guard must refuse
    (truthy), or None when it does not: a recursive chmod/chown, a command
    name a variable or substitution could expand into one, a BASH_ENV
    arming, or a process substitution feeding a shell wrapper.

    Each eval word's payload (the words up to the next command boundary) is
    unquoted one shell quoting layer at a time and rescanned (ANSI-C and
    locale-quoted payloads included), so nested evals, nested quoting
    levels, and mixed or nested eval/`sh -c` wrappers are handled without
    ever confusing quoted data with executable text; shell code the
    scanner cannot resolve is refused outright because the payload can
    relocate or chain freely. Command substitution stays outside this
    check: its output is unknowable statically, and the substitution
    itself already runs (and is scanned) before eval sees the result.
    """
    if depth > _CHMOD_MAX_EVAL_SCAN_DEPTH:
        return "recursive_chmod"  # absurdly nested evals: refuse rather than risk a miss
    words = _chmod_scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("eval",)):
        payload = _chmod_unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, depth, command_prefix)
        if reason is not None:
            return reason
    return None


class _UnresolvableChmodCwd:
    """The directory a recursive chmod/chown would run in cannot be determined."""


_UNRESOLVABLE_CHMOD_CWD = _UnresolvableChmodCwd()


# `CDPATH+=` arms the search path exactly like `CDPATH=`.
_CDPATH_ASSIGNMENT = re.compile(r"(?<![A-Za-z0-9_])CDPATH\+?=")


def _resolve_chmod_cd_target(
    arg: str, current: str | None, workspace: str, cdpath_armed: bool = False
) -> str | None:
    """Resolve one statically-known `cd` argument against the running
    directory (None = the kernel workspace), logical like the shell's default
    `cd -L`. Returns None when the target cannot be resolved statically (bare
    `cd` without a usable HOME, `cd -`/options, another user's home, or a
    relative target while CDPATH is armed: bash searches CDPATH directories
    before the current directory, so the target is not provably inside the
    workspace)."""
    if not arg:
        # A bare `cd` goes home; expanduser matches what the child shell sees.
        try:
            return os.path.expanduser("~")
        except (OSError, RuntimeError):
            return None
    if arg.startswith("-"):
        return None  # `cd -`, `cd -L`, `cd -- ...`: not statically resolvable
    if arg.startswith("~"):
        if arg == "~" or arg.startswith("~/"):
            try:
                return os.path.expanduser(arg)
            except (OSError, RuntimeError):
                return None
        return None  # ~otheruser: another user's home directory
    # CDPATH applies to relative targets and lands in any CDPATH directory
    # before the current directory, so a run with CDPATH armed (inherited,
    # or assigned earlier in the command) is refused rather than guessed
    # at. Bash skips CDPATH only for exactly `.`, `..`, and `./`/`../`-
    # prefixed targets: dot-named targets like `.config` still consult
    # CDPATH (verified against bash), so they are not exempt. Absolute
    # targets never consult CDPATH.
    cdpath_exempt = arg in (".", "..") or arg.startswith("./") or arg.startswith("../")
    if (
        not os.path.isabs(arg)
        and not cdpath_exempt
        and (cdpath_armed or os.environ.get("CDPATH"))
    ):
        return None
    return arg if os.path.isabs(arg) else os.path.join(current or workspace, arg)


def _statically_resolvable_cd_arg(raw: str) -> str | None:
    """Unquote one cd argument to its literal path, or None when it cannot
    be resolved statically. Quotes fold before resolution: `cd ".."`
    relocates to the parent directory, and resolving the raw text with its
    quote characters would name a directory that does not exist."""
    if not raw:
        return None
    # $'sub' folds to sub before the quote-aware split: ANSI-C quoting must
    # not make a plain literal path look unresolvable.
    raw = _expand_ansi_c_payloads(raw)
    if re.search(r"[$`;&|()<>#]", raw):
        return None
    words, well_formed = _chmod_shell_words(raw)
    if not well_formed or len(words) != 1 or not words[0]:
        return None  # empty, multi-word, or inexact: refuse to guess
    return words[0]


def _resolve_chmod_effective_cwd(
    prefix: str, user_command_start: int, workspace: str
) -> "str | None | _UnresolvableChmodCwd":
    """Resolve the directory a chmod/chown at the end of `prefix` runs in.

    Statically-known `cd` relocations earlier in the command are replayed:
    parens groups run in subshells (their cds do not persist, an open
    group's do), brace groups run in the current shell, and anything that
    could relocate but cannot be resolved statically (pushd/popd, cd with
    substitution, an untrackable or unquotable argument, a `;`-separated cd
    whose success is unknowable) returns _UNRESOLVABLE_CHMOD_CWD so the
    caller refuses. Returns None when no cd moved the shell: the kernel
    workspace."""
    if not (re.search(r"\b(?:cd|pushd|popd)\b", prefix) or "(" in prefix):
        return None
    current: str | None = None
    # CDPATH (inherited or assigned earlier in the command) makes a bare
    # relative `cd` land in any CDPATH directory before the current one.
    cdpath_armed = bool(os.environ.get("CDPATH"))
    open_groups: list[str | None] = []
    paren_depth = 0
    saw_cd = False
    cd_pending_separator = False
    offset = 0
    for part in re.split(r"(&&|\|\||;|\||\n)", prefix):
        start = offset
        offset += len(part)
        if start < user_command_start:
            continue  # command-prefix region: user shell setup, not model text
        if part in ("&&", "||", ";", "|", "\n"):
            if cd_pending_separator and part in (";", "\n"):
                # The cd may or may not have succeeded; both outcomes leave
                # the chmod in a different directory the guard cannot pick.
                return _UNRESOLVABLE_CHMOD_CWD
            if part in ("||", "|") and saw_cd:
                return _UNRESOLVABLE_CHMOD_CWD  # cd success no longer guaranteed
            cd_pending_separator = False
            continue
        trimmed = part.strip()
        if _CDPATH_ASSIGNMENT.search(trimmed):
            # A CDPATH assigned earlier in the command redirects later
            # relative `cd`s into its directories first.
            cdpath_armed = True
        opens = len(re.findall(r"\(", part))
        closes = len(re.findall(r"\)", part))
        inside_group = paren_depth > 0 or opens > 0
        for _ in range(opens):
            open_groups.append(current)  # a subshell starts from a copy
        paren_depth = max(0, paren_depth + opens - closes)
        if inside_group:
            body = re.sub(r"[)\s]+$", "", re.sub(r"^[(\s]+", "", trimmed))
            cd_match = re.match(r"cd\s*(.*)$", body)
            if cd_match:
                arg = _statically_resolvable_cd_arg(cd_match.group(1).strip())
                if arg is None:
                    return _UNRESOLVABLE_CHMOD_CWD
                resolved = _resolve_chmod_cd_target(arg, current, workspace, cdpath_armed)
                if resolved is None:
                    return _UNRESOLVABLE_CHMOD_CWD
                current = resolved
                saw_cd = True
                cd_pending_separator = True
            elif re.search(r"\b(?:cd|pushd|popd)\b", trimmed):
                return _UNRESOLVABLE_CHMOD_CWD  # group content we cannot track
            # A closed group's cds do not persist: restore the pre-group dir.
            if paren_depth == 0 and open_groups:
                current = open_groups.pop()
            continue
        # Brace groups run in the current shell, so a `{ cd sub && chmod -R
        # 755 .; }` relocates like a bare cd chain.
        group_free = re.sub(r"^\{\s*", "", trimmed)
        cd_match = re.match(r"cd\s*(.*)$", group_free)
        if not cd_match:
            if re.search(r"\b(?:cd|pushd|popd)\b", group_free):
                # An assignment or wrapper prefix before cd (for example
                # `FOO=1 cd sub`) relocates in ways the resolver cannot replay.
                return _UNRESOLVABLE_CHMOD_CWD
            cd_pending_separator = False
            continue
        arg = _statically_resolvable_cd_arg(cd_match.group(1).strip())
        if arg is None:
            return _UNRESOLVABLE_CHMOD_CWD
        resolved = _resolve_chmod_cd_target(arg, current, workspace, cdpath_armed)
        if resolved is None:
            return _UNRESOLVABLE_CHMOD_CWD
        current = resolved
        saw_cd = True
        cd_pending_separator = True
    return current


_CHMOD_GLOB_OR_SUBSTITUTION = re.compile(r"""[$`*?{}\[\]]""")


def _resolve_chmod_operand(text: str, base: str, home_env: str | None) -> str | None:
    """Resolve one operand to the absolute path chmod/chown will act on.

    `base` is the effective directory and `home_env` the HOME the child
    shell expands, both matching what the command will actually see. Returns
    the realpath'd target, or None when the operand cannot be resolved
    statically (a glob, command substitution, an unknown env var, or another
    user's home): callers must refuse those rather than guess."""
    s = text
    if s.startswith("~"):
        if not (s == "~" or s.startswith("~/")):
            return None  # ~otheruser: another user's home directory
        try:
            s = os.path.expanduser(s)
        except (OSError, RuntimeError):
            return None
        if not s or s.startswith("~"):
            return None
    if home_env is not None:
        s = s.replace("${HOME}", home_env).replace("$HOME", home_env)
    elif "${HOME}" in s or "$HOME" in s:
        return None  # HOME unset: the shell expands it to an empty string
    s = s.replace("${PWD}", base).replace("$PWD", base)
    if not s or _CHMOD_GLOB_OR_SUBSTITUTION.search(s):
        return None
    candidate = s if os.path.isabs(s) else os.path.join(base, s)
    try:
        # realpath, not normpath: a symlinked operand or a `..` that follows a
        # symlink resolves the way the filesystem will, so the escape check
        # sees the directory chmod actually reaches.
        return os.path.realpath(candidate)
    except (OSError, RuntimeError, ValueError):
        return None


def _chmod_operand_violation(
    resolved: str | None, workspace: str, home_real: str | None
) -> str | None:
    """Why a resolved operand must be refused, or None when it is safe.

    A target must stay inside the kernel workspace and must never name the
    home directory, the filesystem root, or anything under a dot-directory
    or dotfile (for example .git). When the workspace itself is / every
    operand escapes it, so the check refuses everything."""
    if resolved is None:
        return "cannot be resolved statically (glob, substitution, or quotes)"
    if resolved == os.sep:
        return "names the filesystem root (/)"
    if home_real is not None and resolved == home_real:
        return "names the home directory"
    if resolved != workspace and not resolved.startswith(workspace + os.sep):
        return "escapes the kernel workspace"
    if resolved != workspace:
        components = resolved[len(workspace) + 1 :].split(os.sep)
        if any(component.startswith(".") for component in components):
            return "names a dot-directory or dotfile (e.g. .git)"
    return None


def _chmod_shell_words(region: str) -> tuple[list[str | None], bool]:
    """Split one invocation region into shell words, quoting-aware.

    Each word is the literal text the shell would pass (quotes removed,
    unquoted escapes folded) or None when the word contains something the
    resolver must refuse to guess at: command substitution, an unterminated
    quote, or a process substitution. Unquoted separators and comments stop
    the scan. The second value is False when the region ended mid-quote."""
    words: list[str | None] = []
    current: list[str] = []
    unknown = False
    well_formed = True

    def flush_word() -> None:
        nonlocal unknown
        if current:
            words.append(None if unknown else "".join(current))
        current.clear()
        unknown = False

    i = 0
    n = len(region)
    while i < n and well_formed:
        ch = region[i]
        if ch.isspace():
            flush_word()
            i += 1
        elif ch == "\\" and i + 1 < n:
            current.append(region[i + 1])
            i += 2
        elif ch == "$" and region[i + 1 : i + 2] == "'":
            # ANSI-C quoting folds into the word exactly like bash does.
            folded, j = _fold_ansi_c_span(region, i, n)
            current.extend(folded)
            i = j
        elif ch == "$" and region[i + 1 : i + 2] == '"':
            # $"..." is locale double quoting: scan it like a double quote.
            end_ = i + 2
            closed = False
            while end_ < n:
                c = region[end_]
                if c == "\\" and end_ + 1 < n and region[end_ + 1] in '"$`\\':
                    end_ += 2
                    continue
                if c == '"':
                    closed = True
                    break
                end_ += 1
            if not closed:
                well_formed = False
                break
            body = re.sub(r'\\(["$`\\])', r"\1", region[i + 2 : end_])
            if re.search(r"[$`]", body):
                unknown = True  # substitution inside: unknowable
            current.extend(body)
            i = end_ + 1
        elif ch == "'":
            end = region.find("'", i + 1)
            if end == -1:
                well_formed = False
                break
            current.extend(region[i + 1 : end])
            i = end + 1
        elif ch == '"':
            end = i + 1
            closed = False
            while end < n:
                c = region[end]
                if c == "\\" and end + 1 < n and region[end + 1] in '"$`\\':
                    end += 2
                    continue
                if c == '"':
                    closed = True
                    break
                end += 1
            if not closed:
                well_formed = False
                break
            body = re.sub(r'\\(["$`\\])', r"\1", region[i + 1 : end])
            if re.search(r"[$`]", body):
                unknown = True  # substitution inside double quotes: unknowable
            current.extend(body)
            i = end + 1
        elif ch == "#" and not current:
            break  # a comment ends the invocation region
        elif ch in ";&|\n)":
            flush_word()
            break  # end of this invocation
        elif ch in "(<>":
            flush_word()
            words.append(None)
            break  # process substitution or a stray operator: refuse to guess
        else:
            current.append(ch)
            i += 1
    flush_word()
    return words, well_formed


def _chmod_operand_words(words: list[str | None], well_formed: bool) -> list[str | None]:
    """Pick the operand words of one chmod/chown invocation.

    Options are skipped (with the separate values of --reference/--from, whose
    files are only read, never modified), and after `--` every word is an
    operand. The first word is the command itself and the first operand is the
    mode (or chown owner spec); that token flows through the same resolution
    as the rest, which is harmless for a mode token and required for every
    file operand after it. A region that ended mid-quote contributes one
    unresolvable operand so the caller refuses it."""
    operands: list[str | None] = []
    after_ddash = False
    skip_value = False
    for index, word in enumerate(words):
        if index == 0:
            continue
        if skip_value:
            skip_value = False
            continue
        if not after_ddash and word == "--":
            after_ddash = True
            continue
        if (
            not after_ddash
            and word is not None
            and word.startswith("-")
            and word != "-"
        ):
            if word in ("--reference", "--from"):
                skip_value = True  # the next word is that option's value
            continue
        operands.append(word)
    if not well_formed:
        operands.append(None)
    return operands


def _format_chmod_operand_refusal(
    operand: str | None, resolved: str | None, workspace: str, reason: str
) -> str:
    lines = ["Refusing to run this recursive chmod/chown command:"]
    if operand is None:
        lines.append(f"  an operand {reason}.")
    elif resolved is None:
        lines.append(f'  the operand "{operand}" {reason}.')
    else:
        lines.append(f'  the operand "{operand}" {reason} ({resolved}).')
    lines.extend(
        [
            "Recursive chmod/chown must stay inside the kernel workspace"
            f" ({workspace}) and must never target the home directory,"
            ' dot-directories (e.g. .git), dotfiles, or the filesystem root.',
            "",
            "To run it intentionally, retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )
    return "\n".join(lines)


def _format_chmod_relocation_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it changes"
            " directory (or wraps the command in xargs) first, and the"
            " directory or targets it would act on cannot be determined"
            " safely.",
            "",
            "Run it as its own command from the target directory, or retry"
            " with bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_eval_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it wraps a"
            " recursive chmod/chown in eval, and the directories it targets"
            " cannot be resolved safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


# Expansion markers that make a command word unresolvable: variables and
# substitutions always, and the glob/brace characters when they sit inside
# a longer word (a bare `{` is a brace group and a bare `[` is the test
# command, not expansion; `chmo?` and `{ch,}mod` can become chmod).
_UNRESOLVED_EXPANSION = re.compile(r"[$`]")
_EXPANDABLE_GLOB_CHARS = re.compile(r"[*?{\[]")
# A plain assignment, or an append assignment (`PATH+=...`), which the shell
# also applies to the command it prefixes rather than running as a command.
_CHMOD_ASSIGNMENT_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
# An append assignment arms the file just like a plain one (`BASH_ENV+=file`).
_BASH_ENV_ASSIGNMENT = re.compile(r"^BASH_ENV\+?=")
# The PATH assignments that decide where a bare command word resolves.
_PATH_SET_ASSIGNMENT = re.compile(r"^PATH=")
_PATH_APPEND_ASSIGNMENT = re.compile(r"^PATH\+?=")
# Command words that hand their arguments to a program: an unresolvable word
# inside one of these runs could still be chmod/chown.
_UNRESOLVABLE_COMMAND_EXECUTORS = (
    "xargs",
    "sudo",
    "env",
    "nohup",
    "exec",
    "command",
    "find",
    "nice",
    "timeout",
    "setsid",
    "stdbuf",
    "ionice",
    "parallel",
    "time",
    "strace",
    "valgrind",
)
# Words that hold a run's command slot without being the command itself:
# grouping tokens and the keywords that introduce the simple command inside a
# group. A wrapper behind one of them still runs (`{ bash -l -c ...; }`).
# `command` and `builtin` dispatch the word behind them, and the compound
# introducers (`if`, `while`, `until`, `time`, `coproc`) run the word after
# them as the condition command, so all of them hold the command slot
# without being the command.
_COMMAND_SLOT_NOISE = (
    "{", "}", "(", ")", "then", "do", "else", "elif", "!",
    "command", "builtin", "if", "while", "until", "time", "coproc",
)
# Heads whose operand arming BASH_ENV executes before the command runs.
_ENV_ARMING_HEADS = ("env", "export", "declare", "typeset", "sudo", "nohup")
# Wrappers that execute a process substitution's output as shell code.
_PROC_SUB_WRAPPERS = ("sh", "bash", "zsh", "dash", "ksh", "source", ".")
_PROC_SUB_INTRODUCERS = ("env", "nohup", "exec", "sudo")


def _expanded_command_word_value(value: str) -> str:
    """Expand the statically-known HOME and PWD forms of a command word, so
    `$HOME/bin/tool` reads as its literal path and stays resolvable;
    anything else carrying `$` or a backtick stays unresolvable."""
    s = value
    home = os.environ.get("HOME") or None
    if home is not None:
        s = s.replace("${HOME}", home).replace("$HOME", home)
    elif "${HOME}" in s or "$HOME" in s:
        return s  # HOME unset: the expansion is unknowable
    try:
        cwd = os.getcwd()
    except OSError:
        return s
    return s.replace("${PWD}", cwd).replace("$PWD", cwd)


def _run_tokens_from(words: list[_ChmodShellWord], index: int) -> list[str]:
    """The command word at `index` plus its followers, up to the next
    command boundary."""
    tokens = [words[index].value]
    for follower_index in range(index + 1, len(words)):
        follower = words[follower_index]
        if follower.starts_command:
            if _contained_in_later_word(words, follower_index):
                continue  # substitution interior: the enclosing word follows
            break
        tokens.append(follower.value)
    return tokens


def _word_could_expand(word: _ChmodShellWord, span_source: str) -> bool:
    """True when a word may not be the literal the scanner folded: the
    value still carries `$`/backtick/glob/brace characters after the known
    HOME/PWD expansions (any of which bash can expand into a different
    command word), or the word's raw span contains a command substitution.
    Substitution interiors fold their `$(...)`/backtick text into the
    enclosing word's value, but the value drops the `$` and the backtick
    itself -- the raw span is what proves the word was built from a
    substitution."""
    expanded = _expanded_command_word_value(word.value)
    if _UNRESOLVED_EXPANSION.search(expanded):
        return True
    if len(expanded) > 1 and _EXPANDABLE_GLOB_CHARS.search(expanded):
        return True
    return re.search(r"\$\(|`", span_source) is not None


def _unresolvable_words_could_recurse(
    words: list[_ChmodShellWord],
    normalized: str | None = None,
    *,
    require_recursive_flag: bool = True,
) -> bool:
    """True when a word the scanner cannot statically resolve could expand
    into a recursive chmod/chown command: a variable, command or process
    substitution, or backtick expansion in command position, or inside a
    run of command-executing wrappers (xargs, sudo, env, nohup, exec,
    command, find, nice, timeout, setsid, stdbuf, ionice, parallel, time,
    strace, valgrind). Fail-closed: with a recursive flag in the run the
    command is refused, never guessed at; inside a quoted wrapper payload
    the flag requirement is dropped (require_recursive_flag=False),
    because the whole payload could be the recursive chmod, flags and
    all, folded into the unresolvable word."""
    head: _ChmodShellWord | None = None
    for index, word in enumerate(words):
        # Substitution interiors execute inside the substitution; the run
        # head for the enclosing word is the word before it, not them.
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if _CHMOD_ASSIGNMENT_WORD.match(word.value):
            continue  # a variable assignment, not a command name
        span_source = (
            normalized[word.start : word.end] if normalized is not None else word.value
        )
        if not _word_could_expand(word, span_source):
            continue
        effective_command = word.starts_command
        executor_run = head is not None and (
            _CHMOD_ASSIGNMENT_WORD.match(head.value)
            or os.path.basename(head.value) in _UNRESOLVABLE_COMMAND_EXECUTORS
        )
        if not (effective_command or executor_run):
            continue
        if require_recursive_flag and not _is_recursive_chmod_chown_token_run(
            _run_tokens_from(words, index)
        ):
            continue
        return True
    return False


def _path_can_shadow_command_lookup(words: list[_ChmodShellWord], workspace: str) -> bool:
    """True when the PATH this command runs under can resolve a bare command
    word inside a directory the guard cannot trust.

    An empty, `.`, `..`, or relative PATH entry makes the shell search a
    directory that may hold a file named `chmod`/`chown` (the kernel
    workspace is writable), so `PATH=.:$PATH chmod -R 755 sub` runs that file
    instead of the real command and the operands the guard resolved are not
    the ones that run. A PATH assignment in the command replaces or appends to
    the inherited value, so the assigned values are read; without an
    assignment the inherited PATH decides, and it is just as untrustworthy.
    An absolute entry that resolves inside the workspace counts too: the
    workspace is writable, so a file there shadows the real command."""
    set_values = [
        word.value.split("=", 1)[1]
        for word in words
        if _PATH_SET_ASSIGNMENT.match(word.value)
    ]
    appended = [
        word.value.split("=", 1)[1]
        for word in words
        if _PATH_APPEND_ASSIGNMENT.match(word.value)
    ]
    checked = [set_values[-1]] if set_values else [os.environ.get("PATH") or ""]
    checked.extend(appended)
    for value in checked:
        # HOME/PWD forms expand like the shell expands them; anything else
        # still carrying `$` is not an absolute entry the guard can trust.
        for entry in _expanded_command_word_value(value).split(os.pathsep):
            if not entry or not os.path.isabs(entry):
                return True
            try:
                resolved = os.path.realpath(entry)
            except (OSError, RuntimeError, ValueError):
                return True  # an entry the guard cannot read fails closed
            if resolved == workspace or resolved.startswith(workspace + os.sep):
                # The kernel workspace is writable, so a command file there
                # can shadow the real one even through an absolute entry.
                return True
    return False


def _bash_env_words_arm_shell_code(words: list[_ChmodShellWord]) -> bool:
    """True when the scanned words arm BASH_ENV for a command:
    non-interactive bash runs that file's shell code before the command
    text, so the guard cannot scan what executes and the run is refused.
    Reading or removing BASH_ENV (`echo $BASH_ENV`, `unset BASH_ENV`,
    `env -u BASH_ENV`) stays fine."""
    head: _ChmodShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if not _BASH_ENV_ASSIGNMENT.match(word.value):
            continue
        if word.starts_command or (
            head is not None
            and (
                _CHMOD_ASSIGNMENT_WORD.match(head.value)
                or os.path.basename(head.value) in _ENV_ARMING_HEADS
            )
        ):
            return True
    return False


def _word_before(command: str, end: int, *, skip_options: bool = False) -> str | None:
    """The shell word ending at `end` (ignoring trailing whitespace), or
    None when none exists. With skip_options, option words are skipped
    backward so the reader of a redirection is found (bash -s <<EOF reads
    as bash)."""
    j = end
    while True:
        while j > 0 and command[j - 1].isspace():
            j -= 1
        k = j
        while k > 0 and not command[k - 1].isspace() and command[k - 1] not in ";&|<>(){}":
            k -= 1
        word = command[k:j]
        if not word:
            return None
        if skip_options and word != "--" and word.startswith("-"):
            j = k
            continue
        return word


def _substitution_spans(command: str) -> list[tuple[int, int]]:
    """Spans of command substitutions (`$(...)`) and backticks in
    `command`, honoring quoting: their output becomes shell text, so a
    here-document inside one can flow out as code."""
    spans: list[tuple[int, int]] = []
    quote: str | None = None
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if quote == "'":
            if ch == "'":
                quote = None
        elif quote == '"':
            if ch == "\\":
                i += 1
            elif ch == '"':
                quote = None
            elif ch == "$" and command[i + 1 : i + 2] == "(":
                # Substitutions still execute inside double quotes: their
                # output is shell text, so they are recorded here too.
                close = _chmod_matching_paren(command, i + 1, n)
                spans.append((i, close))
                i = close
            elif ch == "`":
                close = _backtick_close(command, i + 1, n)
                if close == -1:
                    close = n - 1
                spans.append((i, close))
                i = close
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "$" and command[i + 1 : i + 2] == "(":
            close = _chmod_matching_paren(command, i + 1, n)
            spans.append((i, close))
            i = close
        elif ch == "`":
            close = _backtick_close(command, i + 1, n)
            if close == -1:
                close = n - 1
            spans.append((i, close))
            i = close
        i += 1
    return spans


def _heredoc_bodies_hide_shell_code(
    raw: str, allow_destructive_chmod: bool, command_prefix: str | None, heredoc_depth: int = 0
) -> None:
    """Refuse here-document bodies that execute as shell code: a shell
    wrapper directly fed by the heredoc (`bash <<EOF ... EOF`) runs the
    body as its script, so the body is scanned with the full guard
    (in-workspace recursion stays allowed); a heredoc inside a command
    substitution or backtick (`eval "$(cat <<EOF ...)"`) flows out as text
    that can become code, so its body is scanned the same way. Bodies read
    as data by non-wrapper commands stay inert (masked), and an
    unterminated heredoc executes nothing after it."""
    substitution_spans = _substitution_spans(raw)
    for operator in _CHMOD_REDIRECT_OPERATOR.finditer(raw):
        op_text = operator.group(0)
        if "<<<" in op_text or not op_text.endswith("<<"):
            continue
        delim, delim_end, body_end, _tabs = _locate_heredoc(raw, operator)
        if not delim or body_end is None:
            continue
        body = raw[delim_end:body_end]
        if not body.strip():
            continue
        reader = _word_before(raw, operator.start(), skip_options=True)
        reader_is_wrapper = reader is not None and os.path.basename(reader) in _SHELL_C_INTERPRETERS
        inside_substitution = any(
            start < operator.start() < end for start, end in substitution_spans
        )
        if reader_is_wrapper or inside_substitution:
            # The body executes as shell code: run the full guard on it
            # (operand resolution included), propagating its refusal. The
            # prefix the shell already ran applies to the body too, so the
            # rescan sees exactly prefix + body, from the one env read.
            _guard_destructive_chmod(
                _prefix_command(body.strip("\n"), command_prefix),
                allow_destructive_chmod,
                command_prefix,
                heredoc_depth + 1,
            )


def _process_substitution_feeds_wrapper(
    normalized: str, words: list[_ChmodShellWord] | None = None
) -> bool:
    """True when a shell wrapper's first argument is a process substitution
    (`bash <(...)`, `sh >(...)`), or the wrapper's stdin is a here-string
    (`bash <<< ...`): the wrapper executes the fed content as shell code,
    and that content cannot be scanned statically, so the command is
    refused. Substitutions and here-strings feeding non-wrappers (cat,
    diff, bc) stay fine."""
    if "<(" not in normalized and ">(" not in normalized and "<<<" not in normalized:
        return False
    if words is None:
        words = _chmod_scan_shell_words(normalized)
    head: _ChmodShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if os.path.basename(word.value) not in _PROC_SUB_WRAPPERS:
            continue
        introduced = word.starts_command or (
            head is not None
            and (
                _CHMOD_ASSIGNMENT_WORD.match(head.value)
                or os.path.basename(head.value) in _PROC_SUB_INTRODUCERS
            )
        )
        if not introduced:
            continue
        # Skip wrapper options and `--` between the wrapper and its first
        # script argument: `bash -- <(...)`, `bash -x <(...)`, the stdin
        # redirect `bash < <(...)`, and the here-string `bash <<< ...` all
        # end in the wrapper executing content the guard cannot scan. A
        # `-c` payload governs instead and the wrapper stays fine.
        rest_from = word.end
        governed = False
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if _contained_in_later_word(words, follower_index):
                    continue
                break
            token = follower.value
            if token.startswith("-") and token != "-" and not token.startswith("--"):
                if "c" in token[1:]:
                    governed = True  # the -c payload governs, not an argument
                rest_from = follower.end
                continue
            if token == "--":
                rest_from = follower.end
                continue
            break  # the first non-flag word is the script argument
        if governed:
            continue
        # Fail closed over the wrapper's own command region: an option
        # word, its argument, or a long option between the wrapper and the
        # marker must not hide it, so any input-feeding marker in the
        # region before the next command boundary refuses the wrapper.
        region = re.split(r"[;&|\n]", normalized[rest_from:], maxsplit=1)[0]
        if "<(" in region or ">(" in region or "<<<" in region:
            return True
    return False


# Wrappers that execute a named script file (argument or stdin redirect).
_SCRIPT_INPUT_WRAPPERS = ("sh", "bash", "zsh", "dash", "ksh", "source", ".")
# A PATH assignment changes where a slash-free `source` operand resolves.
_PATH_ASSIGNMENT = re.compile(r"(?<![A-Za-z0-9_])PATH\+?=")

_CHMOD_FUNCTION_DEFINITION = re.compile(r"\(\s*\)\s*[({]|function\s+[A-Za-z_]")


def _function_definition_could_recurse(
    normalized: str, words: list[_ChmodShellWord]
) -> bool:
    """True when a shell function definition could carry a recursive
    chmod/chown: bash forwards the call arguments into the definition
    (`f() { chmod "$@"; }; f -R 755 /`), so a chmod/chown word in the
    definition plus a recursive flag anywhere in the command are refused
    together rather than resolved apart."""
    if not _CHMOD_FUNCTION_DEFINITION.search(normalized):
        return False
    has_chmod_word = any(_is_chmod_chown_word(word.value) for word in words)
    has_recursive_flag = any(
        _is_recursive_chmod_chown_token_run([word.value]) for word in words
    )
    return has_chmod_word and has_recursive_flag


def _shell_short_option_flags(token: str) -> str:
    """The short option letters a shell option cluster sets. `-o`/`-O` consume
    the rest of their own cluster as the option name (`-ovi` sets `vi`, it
    does not set `i`), so only the letters before them are flags."""
    flags = token[1:]
    cut = len(flags)
    for value_option in ("o", "O"):
        found = flags.find(value_option)
        if found != -1:
            cut = min(cut, found)
    return flags[:cut]


def _shell_startup_option(token: str) -> bool:
    """True when a shell option word makes the shell read a startup file
    before it runs the command it was given: a login shell (`-l`, `--login`)
    sources the profile files and an interactive one (`-i`, `--interactive`)
    sources the rc file (`--rcfile`/`--init-file` name the rc file to run
    instead of the default). `--norc`/`--noprofile` do not exempt the
    invocation: bash still reads the system-wide startup file for an
    interactive shell on some platforms."""
    if token in ("--login", "--interactive"):
        return True
    if token.startswith("-") and token != "-" and not token.startswith("--"):
        flags = _shell_short_option_flags(token)
        return "l" in flags or "i" in flags
    return False


_WRAPPER_LONG_OPTIONS = (
    "--posix",
    "--restricted",
    "--noprofile",
    "--norc",
    "--verbose",
    "--debug",
    "--login",
    "--interactive",
    "--help",
    "--version",
)
# `--init-file` is bash's other name for `--rcfile` (both name the rc file an
# interactive shell runs instead of ~/.bashrc).
_WRAPPER_LONG_OPTIONS_WITH_VALUE = ("--rcfile", "--init-file")


def _path_hit(candidate: str) -> str | None:
    """The first PATH entry holding `candidate` as a file, or None.

    Shared by the slash-free script-name resolutions (`source` operands and
    interpreter script arguments): bash searches PATH for those, so the
    guard resolves the same file the shell will read."""
    for path_dir in (os.environ.get("PATH") or "").split(os.pathsep):
        if not path_dir:
            continue
        hit = os.path.join(path_dir, candidate)
        try:
            if os.path.isfile(hit):
                return hit
        except OSError:
            continue
    return None


def _script_input_violation(
    resolved: str | None, workspace: str, home_real: str | None
) -> bool:
    """True when a resolved script input must be refused. Script inputs
    follow the location policy only (outside the workspace, the home
    directory, the root, or unresolvable): dot-components inside the
    workspace are legitimate scripts, so the chmod dotfile policy does
    not apply here."""
    if resolved is None:
        return True
    if resolved == os.sep:
        return True
    if home_real is not None and resolved == home_real:
        return True
    return resolved != workspace and not resolved.startswith(workspace + os.sep)


def _prefix_relocates(prefix: str | None) -> bool:
    """True when the command prefix moves the shell (cd/pushd/popd) in any
    spelling the shell builds. The raw-text check stays first (any textual
    mention refuses, exactly as before); escapes and quoting then fold into
    command words, so `c\\d /` or `c"d" /` relocates without the raw text
    spelling the builtin, and the guard must not validate operands against
    a workspace the shell has already left."""
    if not prefix:
        return False
    if re.search(r"\b(?:cd|pushd|popd)\b", prefix):
        return True
    resolved = _chmod_mask_shell_redirections(_chmod_normalize_line_continuations(prefix))
    normalized, _index_map = _chmod_strip_shell_escapes(resolved)
    return any(
        word.starts_command and word.value in ("cd", "pushd", "popd")
        for word in _chmod_scan_shell_words(normalized)
    )


def _unscanned_wrapper_script_reason(
    raw: str,
    normalized: str,
    words: list[_ChmodShellWord],
    user_command_start: int,
    command_prefix: str | None,
) -> str | None:
    """Why a bare shell wrapper executes a script the guard cannot scan, or
    None when it does not: a script argument or stdin redirection from a
    path outside the kernel workspace (or one that cannot be resolved),
    with the wrapper's cd relocations replayed so relative scripts resolve
    where the wrapper will actually read them. Slash-free `source`
    operands resolve through PATH like bash does. A `-c` payload governs
    and stays fine, and a wrapper option whose value convention the
    scanner cannot know fails closed. A login or interactive shell
    (`-l`, `--login`, `-i`, `--interactive`) sources profile and rc files
    the guard cannot scan, so that invocation is refused outright."""
    try:
        kernel_cwd = os.getcwd()
    except OSError:
        return None  # the spawn itself will fail; the guard must not mask that error
    workspace = os.path.realpath(kernel_cwd)
    home_env = os.environ.get("HOME") or None
    home_real = None
    if home_env is not None:
        try:
            home_real = os.path.realpath(home_env)
        except (OSError, RuntimeError, ValueError):
            home_real = None
    prefix = command_prefix
    prefix_relocates = _prefix_relocates(prefix)
    head: _ChmodShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if os.path.basename(word.value) not in _SCRIPT_INPUT_WRAPPERS:
            continue
        introduced = word.starts_command or (
            head is not None
            and (
                _CHMOD_ASSIGNMENT_WORD.match(head.value)
                or os.path.basename(head.value) in _UNRESOLVABLE_COMMAND_EXECUTORS
                # A grouping token or keyword in the command slot is not the
                # command: the wrapper behind it runs with the same options
                # (`{ bash -l -c ...; }`, `then bash -l ...`).
                or head.value in _COMMAND_SLOT_NOISE
            )
        )
        if not introduced:
            # A word that merely shares a wrapper's name (an argument, a
            # file named `source`, a bare `.` operand) does not run a
            # script, so none of the wrapper gates apply to it.
            continue
        # Startup files belong to a shell interpreter, not to the `source`
        # builtin: only the interpreter names carry -l/-i options at all.
        reads_startup_files = os.path.basename(word.value) in _SHELL_C_INTERPRETERS
        if prefix_relocates:
            # A relocating prefix moves the shell before every command,
            # so the wrapper reads its script somewhere the resolver
            # cannot replay.
            return "relocation"
        script_word: _ChmodShellWord | None = None
        governed = False
        skip_next = False
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if _contained_in_later_word(words, follower_index):
                    continue
                break
            token = follower.value
            if skip_next:
                skip_next = False
                continue
            if reads_startup_files and _shell_startup_option(token):
                # A login or interactive shell sources profile and rc files
                # before it runs the payload it was given, so that code
                # executes whatever the payload says: the wrapper cannot be
                # treated as governed by its `-c` text.
                return "startup"
            if token.startswith("-") and token != "-" and not token.startswith("--"):
                if "c" in token[1:]:
                    governed = True
                    break
                # -o and -O take the shell option name as their value,
                # but only when they end the cluster: a bundled value
                # (`-ovi`) carries its own argument in the same word.
                skip_next = token[-1] in "oO"
                continue
            if token == "--":
                continue
            if token in _WRAPPER_LONG_OPTIONS_WITH_VALUE:
                skip_next = True
                continue
            if token.startswith("--"):
                if token not in _WRAPPER_LONG_OPTIONS:
                    # An unknown long option's value convention is
                    # unknowable: fail closed instead of guessing whether
                    # the next word is its value or the script.
                    return token
                continue
            if _contained_in_later_word(words, follower_index):
                continue  # substitution interior: the enclosing word follows
            script_word = follower
            break
        if governed:
            continue
        candidates: list[str] = []
        if script_word is not None:
            candidates.append(script_word.value)
        # A stdin redirection from a file: the text is masked in
        # `normalized`, so read the wrapper's raw command region instead
        # (an ordinary `<` or `<>`, not <<, <<<, or <( ...)).
        raw_end = script_word.end if script_word is not None else word.end
        region = re.split(r"[;&|\n]", raw[raw_end:], maxsplit=1)[0]
        for match in re.finditer(r"<>?\s*([^\s;&|<>()]+)", region):
            candidates.append(match.group(1))
        if not candidates and os.path.basename(word.value) in _SHELL_C_INTERPRETERS:
            # An executor chain (xargs, env, nohup, ...) supplies a bare
            # interpreter's script operand at runtime from data the guard
            # never sees (`printf %s | xargs bash`), so that input cannot
            # be scanned: the run is refused like the other unreadable
            # inputs. The introducer may sit behind slot holders (a group
            # or keyword: `{ xargs bash; }`, `time xargs bash`), so the
            # walk reads the word holding the command slot, not just the
            # run head. An operand-position dot or `source` stays data.
            introducer = head
            for before in reversed(words[:index]):
                if before.starts_command:
                    introducer = before
                    break
                if _CHMOD_ASSIGNMENT_WORD.match(before.value) or before.value in _COMMAND_SLOT_NOISE:
                    continue  # the slot holder passes through
                if before.value.startswith("-") and before.value != "-":
                    continue  # a dispatcher or command option word
                introducer = before
                break
            if introducer is not None and os.path.basename(introducer.value) in _UNRESOLVABLE_COMMAND_EXECUTORS:
                return "unscanned_script"
            continue
        # Replay cd relocations so relative scripts resolve where the
        # wrapper will actually read them.
        effective_cwd = _resolve_chmod_effective_cwd(
            normalized[: word.start], user_command_start, workspace
        )
        if effective_cwd is _UNRESOLVABLE_CHMOD_CWD:
            return "relocation"
        base = workspace if effective_cwd is None else effective_cwd
        reader = os.path.basename(word.value)
        for candidate in candidates:
            if candidate.startswith("-"):
                continue
            if reader in ("source", ".") and "/" not in candidate:
                # Bash resolves slash-free source operands through PATH
                # first, not the current directory (no execute bit needed:
                # source reads the file, it does not exec it). A PATH
                # assignment in the command makes the search unresolvable
                # statically, and the hit is realpath'd so a workspace-
                # looking entry cannot smuggle `..` or a symlink outside.
                if _PATH_ASSIGNMENT.search(normalized):
                    return candidate
                found = _path_hit(candidate)
                if found is None:
                    continue  # bash errors on a missing PATH hit; harmless
                try:
                    resolved = os.path.realpath(found)
                except (OSError, RuntimeError, ValueError):
                    resolved = None
            else:
                resolved = _resolve_chmod_operand(candidate, base, home_env)
                if (
                    reader in _SHELL_C_INTERPRETERS
                    and "/" not in candidate
                    and resolved is not None
                    and not os.path.isfile(resolved)
                ):
                    # The script is not in the current directory, so bash
                    # falls back to searching PATH for a slash-free name (no
                    # execute bit needed: bash reads the file). A hit outside
                    # the workspace runs shell code the guard never scanned,
                    # and a PATH assignment makes that search unresolvable
                    # statically. A miss everywhere is a bash error, and the
                    # current-directory resolution below still decides.
                    if _PATH_ASSIGNMENT.search(normalized):
                        return candidate
                    found = _path_hit(candidate)
                    if found is not None:
                        try:
                            hit_real = os.path.realpath(found)
                        except (OSError, RuntimeError, ValueError):
                            hit_real = None
                        if _script_input_violation(hit_real, workspace, home_real):
                            return candidate
            if _script_input_violation(resolved, workspace, home_real):
                return candidate
    return None


def _shell_wrapper_reads_pipe(normalized: str, words: list[_ChmodShellWord]) -> bool:
    """True when a bare shell wrapper takes its commands from a pipeline
    or a here-string/redirect: the fed script content cannot be scanned
    statically, so the wrapper form is refused. Wrappers governed by a
    `-c` payload or a script argument read that instead and stay fine."""
    for index, word in enumerate(words):
        # A group opener introduces the wrapper the way a command position
        # does (`{ bash; }` runs bash), so the wrapper word itself needs no
        # command position when it directly follows `{` or `(`.
        introduced_by_opener = normalized[: word.start].rstrip()[-1:] in ("{", "(")
        if not word.starts_command and not introduced_by_opener:
            continue
        if os.path.basename(word.value) not in _SHELL_C_INTERPRETERS:
            continue
        before = normalized[: word.start].rstrip()
        if "|" in before:
            # A group opener between the pipe and the wrapper still feeds it
            # (`printf ... | { bash; }` runs bash on the piped text).
            between = re.sub(r"\s+", "", before[before.rfind("|") + 1 :])
            if between and any(ch not in "{(" for ch in between):
                continue
        else:
            continue
        c_payload = False
        script_arg = False
        skip_next = False  # the value of -o/-O/--rcfile/--init-file is not an argument
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if _contained_in_later_word(words, follower_index):
                    continue
                break
            token = follower.value
            if skip_next:
                skip_next = False
                continue
            if token.startswith("-") and token != "-" and not token.startswith("--"):
                if "c" in token[1:]:
                    c_payload = True
                if token[-1] in "oO":
                    skip_next = True  # `bash -o vi`: the option value follows
                continue
            if token in ("--rcfile", "--init-file"):
                skip_next = True
                continue
            if token == "--":
                continue
            if _contained_in_later_word(words, follower_index):
                continue  # substitution interior: the enclosing word follows
            script_arg = True
            break
        if not c_payload and not script_arg:
            return True
    return False


def _format_chmod_bash_env_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: it arms BASH_ENV, and bash runs"
            " that file's shell code before the command text -- code the"
            " guard cannot scan, so a recursive chmod/chown could escape"
            " the workspace unseen.",
            "",
            "Run it without BASH_ENV, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_process_substitution_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: it feeds a process substitution"
            " to a shell wrapper (for example `bash <(...)`), and the"
            " wrapper executes that output as shell code that cannot be"
            " scanned statically.",
            "",
            "Run it without the process substitution, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_definition_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it defines"
            " a shell function (or alias) whose chmod/chown and recursive"
            " flag can combine at call time, and the resulting run cannot"
            " be resolved statically.",
            "",
            "Write the chmod/chown command literally, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_wrapper_script_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: a shell wrapper executes a script"
            " from outside the kernel workspace (or a path the guard"
            " cannot resolve), and that file's content cannot be scanned"
            " statically.",
            "",
            "Run it from inside the workspace, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_env_split_string_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it runs a"
            " recursive chmod/chown inside a quoted `env -S` payload whose"
            " targets cannot be resolved safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_env_split_string_expansion_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: its `env -S`"
            " string builds the argv env runs through shell expansion, which"
            " the guard cannot resolve.",
            "",
            "Write the command literally, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_shell_startup_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: it starts a login or interactive"
            " shell, which sources profile and rc files before it runs the"
            " command it was given, and startup code cannot be scanned",
            "statically.",
            "",
            "Run the command in a non-interactive, non-login shell"
            " (`bash -c ...`), or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_hash_alias_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: it installs a command-hash entry"
            " (`hash -p`) whose target the guard cannot resolve, so a later"
            " command word could run a recursive chmod/chown the scanner"
            " never sees.",
            "",
            "Register the command with a literal path, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_shadowed_command_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: a PATH"
            " assignment here makes the shell search a relative directory for"
            " the command word, so a file named chmod/chown in the workspace"
            " could run instead and act on targets the guard never checked.",
            "",
            "Run it with an absolute command path and an absolute PATH, or"
            " retry with bash(command, allow_destructive_chmod=True), or start"
            f" the kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_trap_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it"
            " installs a trap whose body runs a recursive chmod/chown the"
            " guard cannot resolve safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _format_chmod_pipe_fed_wrapper_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this command: a bare shell wrapper reads its"
            " commands from a pipe (or here-string/redirect) whose content"
            " cannot be scanned statically.",
            "",
            "Run the commands directly, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _payload_reason_message(reason: str) -> str:
    """The refusal message for a payload-hidden reason."""
    if reason == "bash_env":
        return _format_chmod_bash_env_refusal()
    if reason == "unresolvable_command":
        return _format_chmod_unresolvable_command_refusal()
    if reason == "unscanned_script":
        return _format_chmod_wrapper_script_refusal()
    if reason == "shell_startup":
        return _format_chmod_shell_startup_refusal()
    if reason == "env_split_expansion":
        return _format_chmod_env_split_string_expansion_refusal()
    return _format_chmod_process_substitution_refusal()


def _format_chmod_unresolvable_command_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: its"
            " command name cannot be determined statically because it is"
            " built from a variable or a substitution (directly, or behind"
            " xargs/sudo/env and similar wrappers); a recursive flag is"
            " present, so the run is refused rather than guessed at.",
            "",
            "Write the chmod/chown command literally, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _warn_once_about_late_destructive_chmod_bypass() -> None:
    """Warn (once) when the bypass env var appears mid-session.

    The frozen launch-time copy is the only honored bypass, so a value that
    shows up later is ignored; one os.environ write cannot unlock the guard.
    Warn loudly so a deliberate bypass takes the documented path (restart
    the kernel with the variable set) instead of looking like a no-op."""
    global _destructive_chmod_late_bypass_warned
    if _destructive_chmod_late_bypass_warned:
        return
    value = os.environ.get(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV)
    if value is None or value in ("", "0"):
        return
    _destructive_chmod_late_bypass_warned = True
    print(
        f"prime-agent bash: {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV} appeared after"
        " kernel start and is ignored; the recursive chmod/chown guard only"
        " honors it when the kernel is started with it set.",
        file=sys.stderr,
        flush=True,
    )


_SHELL_C_INTERPRETERS = ("sh", "bash", "zsh", "dash", "ksh")


def _shell_c_payloads_hide_recursive_chmod(command: str, command_prefix: str | None = None) -> str | None:
    """Why a quoted `sh -c`-style payload hides shell code the guard must
    refuse (truthy), or None when it does not: a recursive chmod/chown, a
    command name a variable or substitution could expand into one, a
    BASH_ENV arming, or a process substitution feeding a shell wrapper.

    A quoted `-c` payload executes exactly like an eval payload, but the
    plain scan cannot see into it (the quoted payload folds into one word),
    so the payload is unquoted one shell quoting level and rescanned
    (ANSI-C `$'...'` and locale `$"..."` payloads included), and the same
    scan descends into further quoted wrappers found inside the payload,
    so mixed or nested eval and `sh -c` forms are caught too. Short flags
    may be bundled, so any short-option cluster carrying `c` (a bare `-c`,
    or `-lc` and friends) hands the shell its payload. Doubly-quoted data
    stays inert: `sh -c 'echo "chmod -R 755 ~"'` must not trigger, while
    `sh -c 'chmod -R 755 ~'` must. Unquoted payloads are scanned as plain
    invocations already and are skipped here."""
    words = _chmod_scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("shell_c",)):
        payload = _chmod_unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, command_prefix=command_prefix)
        if reason is not None:
            return reason
    return None


def _alias_payloads_hide_recursive_chmod(command: str, command_prefix: str | None = None) -> str | None:
    """Why a quoted alias body hides shell code the guard must refuse
    (truthy), or None when it does not: an alias body executes as shell
    code at use time, and a body carrying a recursive chmod/chown is
    refused because the call site shows none of it."""
    words = _chmod_scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("alias",)):
        payload = _chmod_unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, command_prefix=command_prefix)
        if reason is not None:
            return reason
    return None


_ENV_COMMAND = "env"


def _env_option_values(tokens: list[str], short: str, long: str) -> list[str]:
    """Every value `env` passes for one of its value options, in order.
    `tokens` are the words after the `env` command word, up to the next
    command.

    GNU `env` accepts the short form with a detached or attached value
    (`-C dir`, `-Cdir`), a cluster where the option takes the rest of its own
    word (`-iC/`) or the next word when it ends the cluster (`-iC dir`), and
    the long form with an attached value (`--chdir=dir`). Every occurrence is
    returned: the same option can repeat, and the guard reads all of them
    rather than guessing which one the platform honors."""
    values: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.startswith("--"):
            name, _, inline = token[2:].partition("=")
            # GNU getopt accepts any unambiguous prefix of a long option, so
            # `--chdi=dir` names `--chdir` on a GNU env even though a BSD env
            # rejects it. Only the prefixes of this option count.
            matches_long = bool(name) and long.startswith(name)
            if matches_long and not inline and index + 1 < len(tokens):
                values.append(tokens[index + 1])
                index += 1
            elif matches_long and inline:
                values.append(inline)
            index += 1
            continue
        if token.startswith("-") and token != "-":
            cluster = token[1:]
            position = cluster.find(short)
            if position != -1:
                attached = cluster[position + 1 :]
                if attached:
                    values.append(attached)
                elif index + 1 < len(tokens):
                    values.append(tokens[index + 1])
                    index += 1
        index += 1
    return values


def _chmod_env_option_value(tokens: list[str], short: str, long: str) -> str | None:
    """The first value `env` passes for one of its value options, or None
    when the command does not use it."""
    values = _env_option_values(tokens, short, long)
    return values[0] if values else None


def _chmod_split_env_string(value: str) -> str | None:
    """The argv text `env -S` splits its string into, or None when the string
    carries expansion.

    GNU `env` splits the string on whitespace, honors single and double
    quotes and backslash escapes, and expands variables; the guard reads the
    literal words and refuses a string it cannot read statically rather than
    guessing which argv `env` would run."""
    if any(ch in value for ch in "$`"):
        return None
    parts: list[str] = []
    current: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            if value[i + 1] == "_":
                # GNU env splits argv at `\_` in the string: it is a space,
                # not a literal underscore (`chmod\_-R\_755\_/` runs the
                # recursive chmod as argv).
                if current:
                    parts.append("".join(current))
                    current = []
            else:
                current.append(value[i + 1])
            i += 2
            continue
        if quote is None and ch in "'\"":
            quote = ch
            i += 1
            continue
        if quote is not None and ch == quote:
            quote = None
            i += 1
            continue
        if quote is None and ch.isspace():
            if current:
                parts.append("".join(current))
                current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    if current:
        parts.append("".join(current))
    return " ".join(parts)


def _chmod_env_split_string_feeds(words: list[_ChmodShellWord]) -> tuple[list[str], list[str]]:
    """(split argv texts, refusal reasons) for every `env -S/--split-string`
    operand in already-scanned `words`.

    GNU `env` splits that string into the argv it runs (`env -S 'chmod -R
    755 /'`), so the split words are scanned like any other command text.
    Every `env` word in the command counts, because a clean string does not
    make a later one safe, and a string carrying expansion is reported
    instead of scanned, because the argv `env` builds from it cannot be read
    statically."""
    feeds: list[str] = []
    reasons: list[str] = []
    for index, word in enumerate(words):
        if os.path.basename(word.value) != _ENV_COMMAND:
            continue
        for value in _env_option_values(
            _run_tokens_from(words, index)[1:], "S", "split-string"
        ):
            if not value.strip():
                continue
            split = _chmod_split_env_string(value)
            if split is None:
                reasons.append(
                    f"{value!r}: names the argv env runs through shell"
                    " expansion, which the guard cannot resolve"
                )
                continue
            feeds.append(split)
    return feeds, reasons


def _env_split_string_payloads_hide_recursive_chmod(command: str, command_prefix: str | None = None) -> str | None:
    """Why a GNU env -S/--split-string payload hides shell code the guard
    must refuse (truthy), or None when it does not: env splits the string
    into a command line and executes it, so every split argv is scanned like
    a wrapper payload, in each spelling of the flag (detached, attached, or
    bundled in a cluster) and for every `env` word. env without -S executes
    only a literal command word and is scanned by the plain invocation scan
    already."""
    feeds, reasons = _chmod_env_split_string_feeds(_chmod_scan_shell_words(command))
    for feed in feeds:
        reason = _payload_text_hides_shell_code(feed, command_prefix=command_prefix)
        if reason is not None:
            return reason
    if reasons:
        return "env_split_expansion"
    return None


def _trap_payloads_hide_recursive_chmod(command: str, command_prefix: str | None = None) -> str | None:
    """Why a trap body hides shell code the guard must refuse (truthy), or
    None when it does not: a trap body executes at trigger time (EXIT,
    DEBUG runs before every command), and a body carrying a recursive
    chmod/chown is refused because nothing else in the command shows it."""
    words = _chmod_scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("trap",)):
        payload = _chmod_unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, command_prefix=command_prefix)
        if reason is not None:
            return reason
    return None


def _format_chmod_shell_c_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this recursive chmod/chown command: it runs a"
            " recursive chmod/chown inside a quoted `sh -c` payload whose"
            " targets cannot be resolved safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_destructive_chmod=True), or start the"
            f" kernel with {BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV}=1.",
        ]
    )


def _wrapper_chain_groups(run_words: list[str]) -> list[tuple[str, list[str]]]:
    """The command-executing wrappers of one command run, in execution order,
    with the tokens each one consumes before handing over to the next.

    `run_words` holds the words before the invocation in shell order. Each
    wrapper hands the rest of the run to the command it runs, so
    `nice env -C / chmod -R 755 .` is a two-link chain and a check that only
    looked at the run head would miss the relocation behind `nice`. The chain
    stops at the first word that is not an executor from
    `_UNRESOLVABLE_COMMAND_EXECUTORS` once assignments, grouping tokens, and
    group keywords are skipped: any other command word runs its arguments
    itself, so a later `xargs` or an operand named `env` is not a wrap."""
    groups: list[tuple[str, list[str]]] = []
    index = 0
    while index < len(run_words):
        if run_words[index] in _COMMAND_SLOT_NOISE or _CHMOD_ASSIGNMENT_WORD.match(
            run_words[index]
        ):
            # An assignment prefix, a grouping token, or a group keyword holds
            # the command slot without being the command: the wrapper after it
            # is the one that runs (`FOO=1 env -C / chmod ...`, `{ env -C / ... }`).
            index += 1
            continue
        if run_words[index].startswith("-") and run_words[index] != "-":
            # An option word reached here follows only slot holders (noise or
            # assignments: `command -p env ...`), so it is consumed by the
            # dispatcher, not a command that breaks the chain.
            index += 1
            continue
        name = os.path.basename(run_words[index])
        if name not in _UNRESOLVABLE_COMMAND_EXECUTORS:
            break
        tokens: list[str] = []
        index += 1
        while index < len(run_words) and (
            os.path.basename(run_words[index]) not in _UNRESOLVABLE_COMMAND_EXECUTORS
        ):
            tokens.append(run_words[index])
            index += 1
        groups.append((name, tokens))
    return groups


def _guard_destructive_chmod(
    script: str,
    allow_destructive_chmod: bool,
    command_prefix: str | None,
    heredoc_depth: int = 0,
) -> None:
    """Refuse recursive chmod/chown commands whose operands could escape the
    kernel workspace or hit the home directory, dot-directories, dotfiles, or
    the filesystem root, and fail closed on what the scanner cannot resolve:
    command names built from variables or substitutions, ANSI-C quoted forms,
    process substitutions feeding shell wrappers, BASH_ENV arming, CDPATH-
    affected relocations, nested quoted wrappers, `env -S` split strings,
    login or interactive shell wrappers that would source startup files,
    executor chains that relocate or feed the invocation (xargs,
    env -C/--chdir, find -execdir, in any spelling and behind assignments
    and grouping tokens), unreadable `hash -p` registrations, a PATH
    entry that can shadow a bare command word, and abbreviated
    recursive flags. Pattern matching is string-only and the operand
    resolver runs only on a match, so other commands pay nothing. `script`
    is exactly the text the shell runs, prefix already prepended by the
    caller from one env read, so the scan never diverges from the spawn."""
    if allow_destructive_chmod or _DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START:
        return
    if heredoc_depth > _MAX_HEREDOC_NESTING:
        # A heredoc body scanned as shell code can itself carry a heredoc
        # wrapper, and hostile nesting would exhaust the Python stack; refuse
        # past the bound like the substitution scanner does.
        raise DestructiveChmodRefusalError(_format_chmod_nesting_refusal())
    raw = _chmod_normalize_line_continuations(script)
    resolved = _chmod_mask_shell_redirections(raw)
    normalized, index_map = _chmod_strip_shell_escapes(resolved)
    words = _chmod_scan_shell_words(normalized)
    # `normalized` drops backslash escapes, so the prefix boundary maps
    # through the strip index map instead of the raw prefix length.
    if command_prefix:
        prefix_end = len(command_prefix) + 1
        user_command_start = next(
            (i for i, orig in enumerate(index_map) if orig >= prefix_end),
            len(normalized),
        )
    else:
        user_command_start = 0
    # BASH_ENV: non-interactive bash runs that file before the command
    # text, so arming it is refused no matter how harmless the visible
    # command looks (an inherited BASH_ENV never reaches the child: it is
    # stripped from the kernel child environment).
    if _bash_env_words_arm_shell_code(words):
        raise DestructiveChmodRefusalError(_format_chmod_bash_env_refusal())
    # `hash -p pathname name` installs a command-hash entry by hand, so a
    # later `name` runs `pathname` whatever the word looks like: those names
    # scan as the command they run, and a registration the guard cannot read
    # is refused, because the command it hides cannot be resolved at all.
    hash_alias_names, hash_unreadable = _chmod_hash_registered_command_names(words)
    if hash_unreadable:
        raise DestructiveChmodRefusalError(_format_chmod_hash_alias_refusal())
    # A process substitution feeding a shell wrapper executes content the
    # guard cannot scan, so that wrapper form is refused.
    if re.search(r"[<>]\(|<<<", normalized) and _process_substitution_feeds_wrapper(normalized, words):
        raise DestructiveChmodRefusalError(_format_chmod_process_substitution_refusal())
    # Here-document bodies that execute as shell code (a wrapper fed by the
    # heredoc, or a heredoc flowing out of a substitution) are scanned with
    # the full guard; data bodies stay masked and inert.
    if "<<" in raw:
        _heredoc_bodies_hide_shell_code(raw, allow_destructive_chmod, command_prefix, heredoc_depth)
    # The cheap gates are word-driven, not raw-text-driven: quote- and
    # ANSI-C-encoded wrapper names (`e"val"`, `$'bash'`) fold to the
    # wrapper word in the scan even though no contiguous `eval`/`bash` text
    # appears, so the parsed words decide whether to scan wrapper payloads.
    # The payload scanners re-tokenize their input, so they get the
    # escape-stripped text: an in-word line continuation left in the
    # pre-strip text would fold into the wrapper word's value (`ba<cont>sh`
    # scans as `ba\nsh`, not `bash`) and hide the wrapper payload entirely.
    eval_reason = (
        _eval_payloads_hide_recursive_chmod(normalized, command_prefix=command_prefix)
        if any(word.value == "eval" for word in words)
        or re.search(r"\beval\b", normalized)
        else None
    )
    shell_c_reason = (
        _shell_c_payloads_hide_recursive_chmod(normalized, command_prefix=command_prefix)
        if any(os.path.basename(word.value) in _SHELL_C_INTERPRETERS for word in words)
        or re.search(r"\b(?:sh|bash|zsh|dash|ksh)\b", normalized)
        else None
    )
    alias_reason = (
        _alias_payloads_hide_recursive_chmod(normalized, command_prefix=command_prefix)
        if any(os.path.basename(word.value) == "alias" for word in words)
        or re.search(r"\balias\b", normalized)
        else None
    )
    if _function_definition_could_recurse(normalized, words):
        # A function forwards its call arguments into its definition, so
        # the definition's chmod/chown and the call's recursive flag can
        # combine at runtime; the run is refused rather than guessed at.
        raise DestructiveChmodRefusalError(_format_chmod_definition_refusal())
    if _shell_wrapper_reads_pipe(normalized, words):
        # A bare shell wrapper fed by a pipe executes the piped text as
        # shell code, which the guard cannot scan statically.
        raise DestructiveChmodRefusalError(_format_chmod_pipe_fed_wrapper_refusal())
    env_s_reason = (
        _env_split_string_payloads_hide_recursive_chmod(normalized, command_prefix=command_prefix)
        if any(os.path.basename(word.value) == "env" for word in words)
        or re.search(r"\benv\b", normalized)
        else None
    )
    if env_s_reason == "recursive_chmod":
        # GNU env -S splits its string into a command and executes it.
        raise DestructiveChmodRefusalError(_format_chmod_env_split_string_refusal())
    if env_s_reason:
        raise DestructiveChmodRefusalError(_payload_reason_message(env_s_reason))
    trap_reason = (
        _trap_payloads_hide_recursive_chmod(normalized, command_prefix=command_prefix)
        if any(word.value == "trap" for word in words)
        else None
    )
    if trap_reason == "recursive_chmod":
        # A trap body executes at trigger time; a recursive chmod in it is
        # refused because nothing else in the command shows it.
        raise DestructiveChmodRefusalError(_format_chmod_trap_refusal())
    if trap_reason:
        raise DestructiveChmodRefusalError(_payload_reason_message(trap_reason))
    if eval_reason == "recursive_chmod":
        # An eval payload hides where the recursion runs; refuse rather than
        # resolve a command the guard cannot see.
        raise DestructiveChmodRefusalError(_format_chmod_eval_refusal())
    if shell_c_reason == "recursive_chmod":
        # A quoted `sh -c` payload executes like an eval payload and hides
        # its operands from the plain scan.
        raise DestructiveChmodRefusalError(_format_chmod_shell_c_refusal())
    if alias_reason:
        # An alias body is shell code: a body carrying a recursive
        # chmod/chown (or shell code the scanner cannot resolve) is refused
        # because the call site shows none of it.
        raise DestructiveChmodRefusalError(_format_chmod_definition_refusal())
    if eval_reason or shell_c_reason:
        # A quoted payload hides shell code the scanner cannot resolve
        # (BASH_ENV, an unresolvable command name, or a process substitution
        # feeding a wrapper): report that reason, not the wrapper it hid
        # behind.
        raise DestructiveChmodRefusalError(
            _payload_reason_message(eval_reason or shell_c_reason)
        )
    if any(os.path.basename(word.value) in _SCRIPT_INPUT_WRAPPERS for word in words):
        # A bare shell wrapper executes a script file, or sources startup
        # files, that the guard cannot scan: inputs from outside the
        # workspace (or unresolvable paths) and login/interactive shells are
        # refused; in-workspace scripts and plain -c payloads stay fine.
        # This gate runs after the payload gates so a payload that itself
        # hides a recursive chmod is reported as that payload, not as the
        # wrapper around it.
        script_reason = _unscanned_wrapper_script_reason(
            raw, normalized, words, user_command_start, command_prefix
        )
        if script_reason == "relocation":
            raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
        if script_reason == "startup":
            raise DestructiveChmodRefusalError(_format_chmod_shell_startup_refusal())
        if script_reason:
            raise DestructiveChmodRefusalError(_format_chmod_wrapper_script_refusal())
    if _unresolvable_words_could_recurse(words, normalized):
        # A variable or substitution could expand into chmod/chown itself;
        # with a recursive flag present the run is refused, not guessed at.
        raise DestructiveChmodRefusalError(_format_chmod_unresolvable_command_refusal())
    invocations = _find_recursive_chmod_chown_invocations(
        normalized, words, hash_alias_names
    )
    if not invocations:
        return
    # The command prefix is user-configured shell setup replayed before every
    # command; a cd in it relocates everything, which the resolver cannot
    # track from model text alone.
    if _prefix_relocates(command_prefix):
        raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
    _warn_once_about_late_destructive_chmod_bypass()
    try:
        kernel_cwd = os.getcwd()
    except OSError:
        return  # the spawn itself will fail; the guard must not mask that error
    workspace = os.path.realpath(kernel_cwd)
    home_env = os.environ.get("HOME") or None
    home_real = None
    if home_env is not None:
        try:
            home_real = os.path.realpath(home_env)
        except (OSError, RuntimeError, ValueError):
            home_real = None
    # A bare command word resolved through a relative PATH entry can be a
    # workspace file, so the operands resolved here are not the ones that
    # run. A slash-qualified word and a `hash -p` registration bypass PATH
    # lookup and stay checked as before. The answer is command-wide, so it is
    # computed once.
    shadows_command_lookup = _path_can_shadow_command_lookup(words, workspace)
    for start, end, word_index in invocations:
        invocation_word = words[word_index].value
        if (
            shadows_command_lookup
            and _is_chmod_chown_word(invocation_word)
            and "/" not in invocation_word
        ):
            raise DestructiveChmodRefusalError(
                _format_chmod_shadowed_command_refusal()
            )
        # xargs feeds paths on stdin the guard never sees, env -C/--chdir
        # relocates before executing, and find -execdir runs the command in
        # each searched directory: all three act outside the resolver's
        # reach, so they are refused rather than checked. The walk stops at
        # the command word itself: when the chmod word is the first word
        # (index 0) there is nothing before it, and operands or later
        # commands must not be read as a wrap (`words[-1::-1]` would
        # reverse the whole list).
        run_words: list[str] = []
        for earlier in reversed(words[:word_index]):
            run_words.append(earlier.value)
            if earlier.starts_command:
                break
        run_words.reverse()
        # xargs feeds paths on stdin the guard never sees, env -C/--chdir
        # relocates before executing, and find -execdir runs the command in
        # each searched directory: all three act outside the resolver's
        # reach, so they are refused rather than checked. The whole wrapper
        # chain is walked, not just its head (a relocation behind `nice` or
        # `timeout` is the same relocation), and the walk stops at the
        # command word itself: when the chmod word is the first word (index
        # 0) there is nothing before it, and operands or later commands must
        # not be read as a wrap.
        for wrapper, tokens in _wrapper_chain_groups(run_words):
            if wrapper == "xargs":
                raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
            if wrapper == "env" and (
                _chmod_env_option_value(tokens, "C", "chdir") is not None
            ):
                raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
            if wrapper == "find" and "-execdir" in tokens:
                raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
        effective_cwd = _resolve_chmod_effective_cwd(normalized[:start], user_command_start, workspace)
        if effective_cwd is _UNRESOLVABLE_CHMOD_CWD:
            raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
        base = workspace if effective_cwd is None else effective_cwd
        region_words, well_formed = _chmod_shell_words(normalized[start:end])
        for operand in _chmod_operand_words(region_words, well_formed):
            resolved_operand = (
                _resolve_chmod_operand(operand, base, home_env)
                if operand is not None
                else None
            )
            reason = _chmod_operand_violation(resolved_operand, workspace, home_real)
            if reason is not None:
                raise DestructiveChmodRefusalError(
                    _format_chmod_operand_refusal(operand, resolved_operand, workspace, reason)
                )

# Force-push guard (wave-1 safety audit gap 2): a `git push` carrying a force
# flag (`--force`, `-f`, or a `+`-prefixed refspec) would overwrite remote
# history on protected targets -- named main/master refs, `@{u}`-style upstream
# refs, or, when the refspec is implicit, the current upstream probed with
# `git rev-parse @{u}` -- and it ran unguarded from the kernel, so one
# command could rewrite origin/main on a machine that trusts the kernel.
# Detection is string-only shell-text scanning in the shape of the other
# kernel bash guards; the upstream probe runs only after a force pattern
# matches, and non-force pushes pay nothing.
#
# The scan sees the text the way the shell does -- line continuations joined,
# quoted and escaped characters folded, ANSI-C (`$'...'`) escapes decoded,
# git aliases defined with `-c alias.X=...` expanded -- and something it
# cannot resolve is refused rather than guessed at: a push argument carrying a
# variable, glob, or substitution; an implicit refspec when the branch has no
# upstream (the target then comes from push.default / remote.<name>.push /
# remote.<name>.mirror); a git command line whose `env`/`xargs`/alias wrapper
# hides what runs; or a command that changes directory before pushing. It
# fails open only where git fails on its own: not a repository, a detached
# HEAD, or a remote that does not exist.

# Bypass env var for the force-push guard.
BASH_FORCE_PUSH_BYPASS_ENV = "PI_BASH_ALLOW_FORCE_PUSH"

# Command words that run git. Matched case-insensitively: the kernel runs on
# macOS and Windows, whose filesystems resolve `GIT`, `/usr/bin/GIT`, and
# `SH` to the same binaries as their lowercase spellings.
_FP_GIT_COMMAND_NAMES = ("git", "git.exe")
_FP_ENV_COMMAND_NAMES = ("env", "env.exe")
_FP_XARGS_COMMAND_NAMES = ("xargs", "xargs.exe")
_FP_COMMAND_WRAPPERS = (
    "sudo",
    "env",
    "command",
    "builtin",
    "nice",
    "nohup",
    "stdbuf",
    "setsid",
    "time",
)


def _fp_command_name(value: str) -> str:
    """A command word's name, folded for the filesystems the kernel runs on."""
    return os.path.basename(value).casefold()


# git's own command table: `git --list-cmds=builtins,main` -- the builtins plus
# the commands git ships as scripts (submodule, subtree, send-email, daemon,
# filter-branch, ...) -- calibrated to the two git versions verified here:
# Apple git 2.50.1 (/usr/bin/git, 170 names) intersected with Homebrew git
# 2.55.0 (/opt/homebrew/bin/git, 181 names) = 169 names.
#
# git resolves a name in this table before any alias: a builtin is dispatched
# directly and a shipped script is found as `git-<name>` on the exec path, both
# ahead of `alias.<name>` (verified: `-c alias.status=... status` and
# `-c alias.submodule=... submodule` run the command, while `-c alias.p=... p`
# runs the alias). A name OUTSIDE the table is therefore either a repository or
# user alias or an external `git-<name>` program, and either can run a force
# push the command text does not show.
#
# The set is static on purpose. The running git cannot be asked: the guard
# cannot see a per-command PATH change, so `PATH=/usr/bin git history` would be
# resolved as "known" from a newer git while the older one actually runs and
# expands `alias.history`. Calibrating to the older baseline refuses a command
# that only a newer git knows (history, repo, url-parse, format-rev,
# last-modified, instaweb, cvsserver, ...) rather than trusting it.
#
# "No allowlisted name is alias-reachable" holds for gits at or above the
# calibration baseline (Apple 2.50.1, the older of the two). A host git older
# than that could still ship a command on this list that its own dispatcher does
# not know, and `alias.<name>` would then run instead: that version skew is a
# known limitation, not a checked property.
_FP_GIT_COMMANDS = frozenset(
    (
    "add", "am", "annotate", "apply", "archive", "backfill", "bisect", "blame",
    "branch", "bugreport", "bundle", "cat-file", "check-attr", "check-ignore",
    "check-mailmap", "check-ref-format", "checkout", "checkout--worker",
    "checkout-index", "cherry", "cherry-pick", "clean", "clone", "column", "commit",
    "commit-graph", "commit-tree", "config", "count-objects", "credential",
    "credential-cache", "credential-cache--daemon", "credential-osxkeychain",
    "credential-store", "daemon", "describe", "diagnose", "diff", "diff-files",
    "diff-index", "diff-pairs", "diff-tree", "difftool", "difftool--helper",
    "fast-export", "fast-import", "fetch", "fetch-pack", "filter-branch",
    "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck",
    "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep",
    "hash-object", "help", "hook", "http-backend", "http-fetch", "http-push",
    "imap-send", "index-pack", "init", "init-db", "interpret-trailers", "log",
    "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge",
    "merge-base", "merge-file", "merge-index", "merge-octopus", "merge-one-file",
    "merge-ours", "merge-recursive", "merge-recursive-ours", "merge-recursive-theirs",
    "merge-resolve", "merge-subtree", "merge-tree", "mergetool", "mktag", "mktree",
    "multi-pack-index", "mv", "name-rev", "notes", "p4", "pack-objects",
    "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune", "prune-packed",
    "pull", "push", "quiltimport", "range-diff", "read-tree", "rebase", "receive-pack",
    "reflog", "refs", "remote", "remote-ext", "remote-fd", "remote-ftp", "remote-ftps",
    "remote-http", "remote-https", "repack", "replace", "replay", "request-pull",
    "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "send-email",
    "send-pack", "sh-i18n--envsubst", "shell", "shortlog", "show", "show-branch",
    "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status",
    "stripspace", "submodule", "submodule--helper", "subtree", "switch", "symbolic-ref",
    "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
    "update-server-info", "upload-archive", "upload-archive--writer", "upload-pack",
    "var", "verify-commit", "verify-pack", "verify-tag", "version", "web--browse",
    "whatchanged", "worktree", "write-tree",
    )
)

# The bypass env var is honored only when present at kernel start: the model
# can write os.environ, so a live read on each guard call would let a single
# os.environ assignment neuter the guard. The frozen copy cannot change after
# import; a value that appears mid-session only triggers a loud warning and
# is ignored.
_FORCE_PUSH_BYPASS_AT_KERNEL_START = os.environ.get(BASH_FORCE_PUSH_BYPASS_ENV) not in (
    None,
    "",
    "0",
)

_force_push_late_bypass_warned = False

# Every guarded push spawns at most one upstream probe; keep it bounded so a
# wedged git (huge repo, hung filesystem) cannot hang the guard with it. The
# probe runs inside bash() -- synchronously, on the kernel's event loop -- so
# this budget is also the whole session's worst-case freeze: a local rev-parse
# finishes in tens of milliseconds, and a probe that cannot answer inside the
# budget fails closed instead of letting the push through.
_FORCE_PUSH_PROBE_TIMEOUT_SECONDS = 2.0


class ForcePushRefusalError(RuntimeError):
    """A force-push to a protected branch or the upstream was refused."""


# The scan walks command-substitution interiors recursively (`_fp_scan_words`,
# `_fp_mask_redirections`), so a command that nests substitutions -- `$(a $(b
# $(c ...)))`, and the same built with backticks -- costs work exponential in
# the nesting depth rather than proportional to its length: 10 KB of nested
# substitutions measured 13.8s and 41 KB did not finish in 30s, which would
# wedge kernel bash() before it spawns anything. The scan therefore spends a
# deterministic work budget (units of scanned text, never wall-clock time) and
# refuses when it runs out: a command the guard could not finish scanning is
# refused, never allowed.
# The budget counts NESTED RE-SCANS, not characters: entering a substitution
# interior, a payload, or an alias body costs one unit, and the linear passes
# (normalization, redaction masking, escape folding, the top-level word scan)
# cost nothing. Length alone must never be a reason to refuse - a 34 KB heredoc
# is ordinary text - while the shapes that really blow up are the ones with
# exponentially many nested re-scans (depth x fanout). Measured entries: a flat
# 34 KB command 0; realistic commands with a few substitutions or payloads
# 1-400; the nesting shapes 81 (depth 4 fanout 3) up to 2187 (backtick depth 7
# fanout 3).
_FP_SCAN_WORK_BUDGET = 4_000
# Nesting deeper than this is refused on its own, with its own message: three
# levels of nested substitution is already more than any real command needs,
# and the cap keeps Python's recursion shallow.
_FP_MAX_SUBSTITUTION_DEPTH = 3


class _FpScanLimitExceeded(Exception):
    """The scan budget ran out: too many nested re-scans."""


class _FpNestingTooDeep(Exception):
    """Command substitutions nest deeper than the guard follows."""


class _FpScanBudget:
    """Deterministic work budget for one guard call."""

    __slots__ = ("remaining", "depth")

    def __init__(self, command_length: int = 0) -> None:
        self.remaining = _FP_SCAN_WORK_BUDGET
        self.depth = 0

    def charge(self, amount: int = 1) -> None:
        self.remaining -= amount
        if self.remaining < 0:
            raise _FpScanLimitExceeded()

    def descend(self) -> None:
        self.depth += 1
        if self.depth > _FP_MAX_SUBSTITUTION_DEPTH:
            raise _FpNestingTooDeep()

    def ascend(self) -> None:
        self.depth -= 1


_active_scan_budget: _FpScanBudget | None = None


def _fp_scan_charge(amount: int = 1) -> None:
    """Spend scan work; raises _FpScanLimitExceeded when the budget is gone."""
    budget = _active_scan_budget
    if budget is not None:
        budget.charge(amount)


def _fp_scan_descend() -> None:
    budget = _active_scan_budget
    if budget is not None:
        budget.descend()


def _fp_scan_ascend() -> None:
    budget = _active_scan_budget
    if budget is not None:
        budget.ascend()


def _fp_normalize_continuations(command: str) -> str:
    """Remove backslash-newline line continuations the way the shell does.

    The shell deletes the pair and joins what surrounds it, so it runs
    `git push -f \
origin main` as one `git push -f origin main` command and splits
    nothing: `ma\
in` is the single word `main`. Every later step works on the string
    this returns, so dropping the two characters keeps the scan aligned with
    what executes. Single-quoted backslash-newlines are literal data and a
    newline always ends a comment, so those are left untouched; inside double
    quotes the shell drops the pair too and resolves backslash escapes (so a
    `\\"` does not end the string).
    """
    chars: list[str] = []
    quote: str | None = None
    comment = False
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if comment:
            chars.append(ch)
            if ch == "\n":
                comment = False
        elif quote is None:
            if ch in ('"', "'"):
                quote = ch
            elif ch == "#" and (i == 0 or re.match(r"[\s;&|(){}]", command[i - 1])):
                comment = True
            if ch == "\\" and i + 1 < n and command[i + 1] == "\n":
                i += 2  # a continuation: the shell joins the two sides
                continue
            chars.append(ch)
        elif quote == "'":
            chars.append(ch)
            if ch == "'":
                quote = None
        elif ch == "\\" and i + 1 < n:
            # Inside double quotes a backslash-newline joins the two sides;
            # any other escape ends the string only after the escaped
            # character, so the pair is kept for the later scan.
            if command[i + 1] == "\n":
                i += 2
                continue
            chars.append(ch)
            chars.append(command[i + 1])
            i += 2
            continue
        else:
            chars.append(ch)
            if ch == '"':
                quote = None
        i += 1
    return "".join(chars)


# A shell redirection word: optional fd, the operator, an optional &fd
# duplication (which has no filename target), and an attached target (empty
# for the `2> file` split form). Targets containing quotes, substitution, or
# process-substitution syntax stay live: masking them could hide a command
# substitution that executes.
_FP_REDIRECT_OPERATOR = re.compile(r"(?:&>{1,2}|>&|[0-9]*[<>]{1,3}(&[0-9]+)?)")
_FP_STATIC_REDIRECT_TARGET = re.compile(r"""[^\s;&|<>()$`"']*""")


def _fp_mask_redirections(command: str) -> str:
    """Blank out shell redirection words, keeping character positions.

    The shell consumes redirections (`2>/dev/null`, `> log`, `2>&1`,
    `</dev/null`) before git sees its argv, so `git push 2>/dev/null -f
    origin main` must scan as `git push -f origin main`. Only the operator
    and a fully static attached or next-word target are masked (pure
    syntax); quoted data, comments, command substitution, and process
    substitution stay live so the guard keeps seeing what executes.
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
            operator = _FP_REDIRECT_OPERATOR.match(command, i)
            if operator:
                for j in range(operator.start(), operator.end()):
                    chars[j] = " "
                i = operator.end()
                attached = _FP_STATIC_REDIRECT_TARGET.match(command, i)
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
                    detached = _FP_STATIC_REDIRECT_TARGET.match(command, j)
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
        elif quote == '"':
            if ch == '"':
                quote = None
            elif ch == "\\" and i + 1 < n:
                i += 1  # escaped character inside double quotes stays
            elif ch == "$" and chars[i + 1 : i + 2] == "(":
                # Command substitution inside double quotes still executes;
                # mask redirections inside it too (its own redirects are
                # syntax).
                j = _fp_matching_paren(command, i + 1, n)
                _fp_scan_charge()
                _fp_scan_descend()
                interior = _fp_mask_redirections(command[i + 2 : j])
                _fp_scan_ascend()
                chars[i + 2 : j] = list(interior)
                i = j
            elif ch == "`":
                j = _fp_matching_backtick(command, i, n)
                _fp_scan_charge()
                _fp_scan_descend()
                interior = _fp_mask_redirections(command[i + 1 : j])
                _fp_scan_ascend()
                chars[i + 1 : j] = list(interior)
                i = j
        i += 1
    return "".join(chars)


def _fp_strip_escapes(command: str) -> tuple[str, list[int]]:
    """Remove unquoted backslash escapes, mapping indices back to the input.

    The shell treats an unquoted `\\X` as a literal X, so `g\\it push -f
    origin main` must scan as `git push ...`. Quoted and commented spans keep
    their backslashes: those are data or syntax handled elsewhere.
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
            elif quote == '"':
                if ch == '"':
                    quote = None
                elif ch == "\\" and i + 1 < n:
                    # A quoted escape stays in the text: the word scan resolves
                    # it, and skipping the pair keeps `\\"` from ending the
                    # string here.
                    chars.append(command[i + 1])
                    index_map.append(i + 1)
                    i += 1
            i += 1
    return "".join(chars), index_map


def _fp_unquote_one_level(text: str) -> str:
    """Remove the outermost quoting layer from `text`.

    Inner quotes stay quoted so the next scan layer still treats them as
    data: `eval 'echo "git push -f origin main"'` must stay harmless after
    the first unquote, while `eval 'git push -f origin main'` must not.
    Quote characters become spaces so unquoting never joins separate words.
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
        elif quote == '"':
            if ch == '"':
                quote = None
                chars[i] = " "
        elif ch == "\\" and i + 1 < n:
            i += 1  # escaped character inside double quotes stays
        i += 1
    return "".join(chars)


# bash `$'...'` (ANSI-C quoting) escapes. The shell decodes them before it
# builds argv, so `$'\x67it'` is the command word `git`; a scan that keeps the
# raw text cannot see that.
_FP_ANSI_C_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
}
_FP_ANSI_C_OCTAL = "01234567"
_FP_ANSI_C_HEX = "0123456789abcdefABCDEF"


def _fp_ansi_c_decoded(body: str) -> str:
    """Decode the body of a `$'...'` word the way bash does.

    Unknown escapes resolve to the escaped character itself, exactly as the
    shell resolves them, so the decoded text is what git would see in argv."""
    out: list[str] = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        esc = body[i + 1]
        i += 2
        if esc in _FP_ANSI_C_ESCAPES:
            out.append(_FP_ANSI_C_ESCAPES[esc])
            continue
        if esc in _FP_ANSI_C_OCTAL:
            digits = esc
            while len(digits) < 3 and i < n and body[i] in _FP_ANSI_C_OCTAL:
                digits += body[i]
                i += 1
            out.append(chr(int(digits, 8) & 0xFF))
            continue
        if esc in ("x", "u", "U"):
            width = {"x": 2, "u": 4, "U": 8}[esc]
            digits = ""
            while len(digits) < width and i < n and body[i] in _FP_ANSI_C_HEX:
                digits += body[i]
                i += 1
            # Bound the code point: `$'\UFFFFFFFF'` would otherwise raise
            # ValueError and take `bash()` down with it before it spawns
            # anything. bash itself does not produce that character either.
            out.append(chr(min(int(digits, 16), 0x10FFFF)) if digits else esc)
            continue
        if esc == "c" and i < n:
            out.append(chr(ord(body[i].upper()) & 0x1F))
            i += 1
            continue
        out.append(esc)  # an unknown escape is the character itself
    return "".join(out)


@dataclass(frozen=True)
class _FpShellWord:
    """One shell word: its unquoted argv value plus the span it came from."""

    value: str
    start: int
    end: int
    starts_command: bool  # first word of a fresh (sub)command context


def _fp_matching_paren(command: str, open_index: int, end: int) -> int:
    """Index of the `)` matching the `(` at `open_index`, or `end - 1`.

    A `)` inside quotes or behind a backslash is data rather than the end of
    the substitution, so the scan follows the shell's quoting:
    `"$(printf ')'; git push -f origin main)"` closes at the last `)`, and the
    interior -- which is where the push runs -- is scanned. An unterminated
    substitution reports the last character, so its whole tail is scanned."""
    depth = 0
    quote: str | None = None
    i = open_index
    while i < end:
        ch = command[i]
        if quote is None:
            if ch == "\\" and i + 1 < end:
                i += 2
                continue
            if ch == "$" and i + 1 < end and command[i + 1] == "'":
                # ANSI-C quoting: `\'` inside `$'...'` is an escaped quote, so
                # the span runs to the next unescaped `'` and a `)` inside it is
                # data rather than the end of the substitution.
                quote = "ansi"
                i += 2
                continue
            if ch in ("'", '"'):
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return i
        elif quote == "ansi":
            if ch == "\\" and i + 1 < end:
                i += 2
                continue
            if ch == "'":
                quote = None
        elif quote == "'":
            if ch == "'":
                quote = None
        elif ch == "\\" and i + 1 < end:
            i += 2
            continue
        elif ch == '"':
            quote = None
        i += 1
    return end - 1


def _fp_matching_backtick(command: str, open_index: int, end: int) -> int:
    """Index of the backtick closing the one at `open_index`, or `end - 1`.

    Bash ends an old-style substitution at the first backtick a backslash does
    not escape: quotes inside the backquotes do not protect one, so
    ``echo "`printf '`' ; git push -f origin main`"`` closes at the backtick
    inside the single quotes. This lookup therefore follows the backslash rule
    only -- `_fp_matching_paren` keeps the quote-aware rule, because a `)` in a
    `$(...)` really is protected by quotes. An unterminated substitution reports
    the last character so its tail is still scanned."""
    i = open_index + 1
    while i < end:
        ch = command[i]
        if ch == "\\" and i + 1 < end:
            i += 2
            continue
        if ch == "`":
            return i
        i += 1
    return end - 1


def _fp_unquoted_paren_counts(text: str) -> tuple[int, int]:
    """Open and close parens outside quotes and escapes, the shell's own rule
    (the same quoting `_fp_matching_paren` follows): `echo "("` opens no
    group, so a cd chain around one still replays instead of dying with a
    spurious frame."""
    opens = closes = 0
    quote: str | None = None
    i = 0
    end = len(text)
    while i < end:
        ch = text[i]
        if quote is None:
            if ch == "\\" and i + 1 < end:
                i += 2
                continue
            if ch == "$" and i + 1 < end and text[i + 1] == "'":
                quote = "ansi"  # `$'...'`: `\'` is an escaped quote
                i += 2
                continue
            if ch in ("'", '"'):
                quote = ch
            elif ch == "(":
                opens += 1
            elif ch == ")":
                closes += 1
        elif quote == "ansi":
            if ch == "\\" and i + 1 < end:
                i += 2
                continue
            if ch == "'":
                quote = None
        elif quote == "'":
            if ch == "'":
                quote = None
        elif ch == "\\" and i + 1 < end:
            i += 2
            continue
        elif ch == '"':
            quote = None
        i += 1
    return opens, closes


def _fp_scan_words(command: str) -> list[_FpShellWord]:
    """Split `command` into shell words the way the shell builds argv.

    Quotes and backslash escapes fold into the word value, comments are
    skipped, and command substitution (`$(...)`, backticks) keeps its
    interior scanned as live commands because it executes; the substituted
    result itself stays in the enclosing word, so a refspec carrying it
    reads as unresolvable. Redirections are masked by the caller. This is a
    conservative approximation, not a parse: anything it cannot represent
    exactly ends up refused, never silently allowed.
    """
    words: list[_FpShellWord] = []
    contained: list[bool] = []
    interior_depth = 0  # > 0 while the scanner is inside a substitution

    def scan_region(
        start: int, end: int, *, starts_command: bool, nested: bool = True
    ) -> None:
        # One unit per nested re-scan, and no charge for the text itself: the
        # top-level pass over what the agent wrote is O(n) and must never be a
        # reason to refuse, while every interior this walk enters is another
        # pass over text a deeper level already covered.
        nonlocal interior_depth
        if not nested:
            _scan_region(start, end, starts_command=starts_command)
            return
        _fp_scan_charge()
        _fp_scan_descend()
        interior_depth += 1
        try:
            _scan_region(start, end, starts_command=starts_command)
        finally:
            interior_depth -= 1
            _fp_scan_ascend()

    def _scan_region(start: int, end: int, *, starts_command: bool) -> None:
        i = start
        value: list[str] = []
        word_start = -1
        word_starts_command = False
        first_word_pending = starts_command

        def flush(starts_next_command: bool) -> None:
            nonlocal word_start, first_word_pending
            if word_start != -1:
                words.append(_FpShellWord("".join(value), word_start, i, word_starts_command))
                contained.append(interior_depth > 0)
                value.clear()
                word_start = -1
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
            if ch == "$" and command[i + 1 : i + 2] == "'":
                # `$'...'` is ANSI-C quoting: its escapes are decoded before
                # the shell builds argv, so `$'\x67it'` is the command word
                # `git` and `$'ma\in'` is the word `main`.
                j = i + 2
                body: list[str] = []
                while j < end:
                    if command[j] == "\\" and command[j + 1 : j + 2] == "'":
                        body.append("'")  # \' is a literal quote, not the end
                        j += 2
                        continue
                    if command[j] == "'":
                        break
                    body.append(command[j])
                    j += 1
                value.append(_fp_ansi_c_decoded("".join(body)))
                i = j + 1
                continue
            if ch == "$" and command[i + 1 : i + 2] == '"':
                # `$"..."` is a translatable double-quoted string: drop the `$`
                # and let the double-quote scan read it.
                i += 1
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
                        close = _fp_matching_paren(command, j + 1, end)
                        scan_region(j + 2, close, starts_command=True)
                        value.append(command[j : close + 1])
                        j = close + 1
                        continue
                    if inner == "`":
                        close = _fp_matching_backtick(command, j, end)
                        scan_region(j + 1, close, starts_command=True)
                        value.append(command[j : close + 1])
                        j = close + 1
                        continue
                    value.append(inner)
                    j += 1
                i = j
                continue
            if ch == "$" and command[i + 1 : i + 2] == "(":
                close = _fp_matching_paren(command, i + 1, end)
                scan_region(i + 2, close, starts_command=True)
                value.append(command[i : close + 1])
                i = close + 1
                continue
            if ch == "`":
                close = _fp_matching_backtick(command, i, end)
                scan_region(i + 1, close, starts_command=True)
                value.append(command[i : close + 1])
                i = close + 1
                continue
            value.append(ch)
            i += 1
        flush(False)

    scan_region(0, len(command), starts_command=True, nested=False)
    return _FpShellWords(words, contained)


class _FpShellWords(list):
    """The words of one scan, with each word's interior flag recorded.

    `contained[i]` says words[i] is a command-substitution interior: it was
    emitted while the scanner was inside a substitution, and the word that
    encloses it is appended right after that interior is scanned. Recording the
    flag as the word is built is what keeps the walkers linear -- testing each
    word against every later word was quadratic in the word count (a 56 KB
    benign command spent 3.6s in that one test)."""

    __slots__ = ("contained",)

    def __init__(self, words: list[_FpShellWord], contained: list[bool]) -> None:
        super().__init__(words)
        self.contained = contained


def _fp_contained_in_later_word(words: list[_FpShellWord], index: int) -> bool:
    """True when words[index] is a command-substitution interior.

    Interiors execute inside the substitution, so walkers must look through
    them, not stop at them. The answer is precomputed by `_fp_scan_words`; for
    a plain list the slow test is used instead."""
    contained = getattr(words, "contained", None)
    if contained is not None and len(contained) == len(words):
        return contained[index]
    word = words[index]
    return any(
        word.start >= later.start and word.end <= later.end
        for later in words[index + 1 :]
    )


def _fp_invocation_tokens(words: list[_FpShellWord], index: int) -> list[str]:
    """The argv values of the command that starts at words[index].

    Everything up to the next command boundary is one invocation; a
    command-substitution interior is skipped because it runs as its own
    command and the enclosing word follows it."""
    tokens = [words[index].value]
    for follower_index in range(index + 1, len(words)):
        follower = words[follower_index]
        if follower.starts_command:
            if not _fp_contained_in_later_word(words, follower_index):
                break
            continue  # substitution interior: the enclosing word follows
        tokens.append(follower.value)
    return tokens


# git global options that take the next token as their value (space-separated
# form); attached `--opt=value` forms never consume a separate token.
_FP_GIT_GLOBAL_VALUE_SHORT = {"-c", "-C"}
_FP_GIT_GLOBAL_VALUE_LONG = {
    "--git-dir",
    "--git-common-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
}
# git push options that take the next token as their value (space-separated
# form); `--signed[=x]` and `--recurse-submodules[=x]` are attached-only, and
# `--force-with-lease[=x]`/`--force-if-includes` are never force flags.
# git's own push long options (`git push -h`, git 2.55), resolved by unique
# prefix the way parse-options resolves them: `git push --mir origin` really
# mirrors every ref, so an abbreviation of an option the guard reads has to be
# read too. parse-options accepts `--no-<name>` for every boolean it declares,
# so both spellings are resolved. An ambiguous prefix (`--f` matches --force,
# --force-with-lease, --force-if-includes and --follow-tags) is rejected by git
# itself and refused here, because the guard cannot tell which option it names.
_FP_PUSH_LONG_OPTIONS = (
    "verbose", "quiet", "repo", "all", "branches", "mirror", "delete", "tags",
    "dry-run", "porcelain", "force", "force-with-lease", "force-if-includes",
    "recurse-submodules", "thin", "receive-pack", "exec", "set-upstream",
    "progress", "prune", "verify", "no-verify", "follow-tags", "signed",
    "atomic", "push-option", "ipv4", "ipv6",
)
# `--no-verify` is both a declared option and the negation of `verify`, so the
# spellings are de-duplicated: a name that appears twice would look ambiguous.
_FP_PUSH_LONG_SPELLINGS = tuple(
    dict.fromkeys(
        spelling
        for option in _FP_PUSH_LONG_OPTIONS
        for spelling in (option, "no-" + option)
    )
)


def _fp_push_long_option(token: str) -> tuple[str | None, bool]:
    """The push long option a `--word` token names, and whether that is
    ambiguous: (option, False) for a unique prefix or an exact name, (None,
    True) when more than one option matches, and (None, False) for a token that
    names none of git's own push options at all."""
    name = token[2:].partition("=")[0]
    if name in _FP_PUSH_LONG_SPELLINGS:
        return name, False  # parse-options prefers an exact name over a prefix
    matches = [
        option for option in _FP_PUSH_LONG_SPELLINGS if option.startswith(name)
    ]
    if len(matches) > 1:
        return None, True
    return (matches[0] if matches else None), False


_FP_PUSH_VALUE_SHORT = {"o"}
_FP_PUSH_VALUE_LONG = {"--receive-pack", "--exec", "--repo", "--push-option"}


def _fp_find_push_subcommand(tokens: list[str]) -> tuple[int | None, bool]:
    """Index of the `push` subcommand token in `tokens` (tokens[0] is the
    git word) plus whether global options relocate the repository, or
    (None, relocated). Global options between `git` and the subcommand are
    stepped over; `--exec-path` alone prints and exits without running any
    push, so it ends the search."""
    i = 1
    n = len(tokens)
    relocated = False
    while i < n:
        token = tokens[i]
        if token == "--":
            return None, relocated
        if not token.startswith("-") or token == "-":
            return (i if token == "push" else None), relocated
        if token == "-C":
            relocated = True  # the push targets another repository
            i += 2
            continue
        if token.startswith("-C") and len(token) > 2:
            relocated = True  # attached -C<path>
            i += 1
            continue
        if token in _FP_GIT_GLOBAL_VALUE_SHORT:
            i += 2  # -c plus its space-separated value: no relocation
            continue
        if token in _FP_GIT_GLOBAL_VALUE_LONG or token.startswith(
            ("--git-dir=", "--git-common-dir=", "--work-tree=", "--namespace=", "--super-prefix=", "--config-env=")
        ):
            relocated = True  # selects the repository a push targets
            if token in _FP_GIT_GLOBAL_VALUE_LONG:
                i += 2  # option plus its space-separated value
            else:
                i += 1  # attached value
            continue
        if token == "--exec-path" or token == "-h" or token == "--help":
            return None, relocated  # git prints and exits without pushing
        i += 1  # attached-value or valueless global option
    return None, relocated


@dataclass(frozen=True)
class _FpPushRun:
    """One `git ... push` invocation found by the word scan."""

    git_index: int  # index of the git word in the scan
    push_index: int  # index of the push token within `tokens`
    tokens: list[str]  # argv values from the git word to the run's end
    relocated: bool  # -C/--git-dir-style relocation or GIT_DIR=... prefix
    xargs_fed: bool  # xargs feeds refspecs the guard cannot see
    unresolvable_alias: bool = False  # an inline `alias.X` hides this run


@dataclass(frozen=True)
class _FpPushArgs:
    """Semantics of one git push invocation that matter to the guard."""

    force: bool
    dry_run: bool
    wildcard: bool  # --all / --mirror: every branch is a target
    refspecs: list[str]
    unresolvable: str | None = None  # argv word holding a variable/glob/...


# An inline configuration that defines an alias for the subcommand the very
# same command line invokes: git rewrites argv with the alias body, so
# `git -c alias.p='push -f origin main' p` runs a force push that a scan
# looking for the `push` word never sees.
_FP_MAX_ALIAS_DEPTH = 10
# An alias body the guard must not guess at: a shell (`!`) alias, or a body
# carrying substitution, quoting, or control syntax whose split the guard
# cannot reproduce exactly.
_FP_UNRESOLVABLE_ALIAS_BODY = re.compile(r"""[$`'"\\;&|()<>#!\n]""")


class _FpUnresolvableAlias:
    """An inline git alias whose expansion cannot be resolved statically."""


_FP_UNRESOLVABLE_ALIAS = _FpUnresolvableAlias()


def _fp_inline_alias_configs(tokens: list[str]) -> tuple[dict[str, str | None], int]:
    """Inline `alias.*` bodies in the global-option region of `tokens`, plus
    the index of the subcommand word (`len(tokens)` when there is none).

    A body is None when the definition does not carry it statically:
    `--config-env=alias.p=SOME_VAR` reads the body from the environment."""
    aliases: dict[str, str | None] = {}
    i = 1
    n = len(tokens)
    while i < n:
        token = tokens[i]
        if token == "--":
            return aliases, n
        if not token.startswith("-") or token == "-":
            return aliases, i
        value: str | None = None
        from_environment = False
        if token in ("-c", "--config-env"):
            if i + 1 >= n:
                return aliases, n
            value = tokens[i + 1]
            from_environment = token == "--config-env"
            i += 2
        elif token.startswith("--config-env="):
            value = token[len("--config-env=") :]
            from_environment = True
            i += 1
        elif token.startswith("-c") and len(token) > 2:
            value = token[2:]  # the attached -c<name>=<value> form
            i += 1
        elif token in _FP_GIT_GLOBAL_VALUE_SHORT or token in _FP_GIT_GLOBAL_VALUE_LONG:
            i += 2  # an option with a space-separated value
        else:
            i += 1  # an attached-value or valueless global option
        if value is None or not value.startswith("alias."):
            continue
        name, separator, body = value[len("alias.") :].partition("=")
        if separator and name:
            aliases[name] = None if from_environment else body
    return aliases, n


def _fp_expand_one_inline_git_alias(
    tokens: list[str],
) -> "list[str] | _FpUnresolvableAlias | None":
    """Rewrite `git ... -c alias.X=<body> ... X ...` into the argv git runs.

    Returns None when no inline alias applies, the rewritten tokens when one
    does, and _FP_UNRESOLVABLE_ALIAS when the body cannot be expanded
    statically (a `!` shell alias, a body from the environment, or one
    carrying substitution the guard cannot reproduce)."""
    aliases, subcommand_index = _fp_inline_alias_configs(tokens)
    if not aliases or subcommand_index >= len(tokens):
        return None
    subcommand = tokens[subcommand_index]
    if subcommand not in aliases:
        return None
    body = aliases[subcommand]
    if body is None or _FP_UNRESOLVABLE_ALIAS_BODY.search(body):
        return _FP_UNRESOLVABLE_ALIAS
    _fp_scan_charge()  # an alias body is re-scanned as argv
    words, well_formed = _fp_literal_words(body.strip())
    if not well_formed or not words or any(word is None for word in words):
        return _FP_UNRESOLVABLE_ALIAS
    return [
        tokens[0],
        *tokens[1:subcommand_index],
        *words,
        *tokens[subcommand_index + 1 :],
    ]


def _fp_expand_alias_chain(tokens: list[str]) -> "list[str] | _FpUnresolvableAlias":
    """Expand inline `alias.X` definitions until the argv stops changing.

    Refuses (_FP_UNRESOLVABLE_ALIAS) a body the guard cannot expand, and a
    chain longer than _FP_MAX_ALIAS_DEPTH."""
    current = tokens
    for _ in range(_FP_MAX_ALIAS_DEPTH):
        expanded = _fp_expand_one_inline_git_alias(current)
        if expanded is _FP_UNRESOLVABLE_ALIAS:
            return _FP_UNRESOLVABLE_ALIAS
        if expanded is None or expanded == current:
            return current  # no alias applies, or the chain reached a fixpoint
        current = expanded
    return _FP_UNRESOLVABLE_ALIAS  # a chain longer than the guard follows


def _fp_effective_subcommand(tokens: list[str]) -> "str | _FpUnresolvableAlias | None":
    """The subcommand git would run for this `git ...` command line.

    None when the line invokes no subcommand. A name in git's own command table
    is the subcommand git runs whatever aliases exist (git ignores
    `alias.status`, `alias.push`, ...), so it is returned as written; any other
    name is first looked up through the inline `-c alias.X=...` definitions, and
    an expansion the guard cannot follow comes back as _FP_UNRESOLVABLE_ALIAS."""
    _aliases, subcommand_index = _fp_inline_alias_configs(tokens)
    if subcommand_index >= len(tokens):
        return None
    subcommand = tokens[subcommand_index]
    if subcommand in _FP_GIT_COMMANDS:
        return subcommand
    expanded = _fp_expand_alias_chain(tokens)
    if expanded is _FP_UNRESOLVABLE_ALIAS:
        return _FP_UNRESOLVABLE_ALIAS
    _expanded_aliases, expanded_index = _fp_inline_alias_configs(expanded)
    if expanded_index >= len(expanded):
        return None
    return expanded[expanded_index]


def _fp_expand_inline_git_aliases(tokens: list[str]) -> "list[str] | _FpUnresolvableAlias":
    """Resolve inline `alias.X` definitions for the invoked subcommand.

    Returns the tokens unchanged when no inline alias applies, when the invoked
    name is one git resolves itself (`-c alias.status=... status` still runs the
    builtin, `-c alias.push=... push` still runs the builtin push), or when the
    expansion holds no `push`: only an expansion that carries a push may replace
    the argv the guard already sees. Refuses a body the guard cannot expand, and
    an alias chain deeper than _FP_MAX_ALIAS_DEPTH."""
    _aliases, subcommand_index = _fp_inline_alias_configs(tokens)
    if subcommand_index < len(tokens) and tokens[subcommand_index] in _FP_GIT_COMMANDS:
        return tokens  # git runs its own command, not the alias
    expanded = _fp_expand_alias_chain(tokens)
    if expanded is _FP_UNRESOLVABLE_ALIAS:
        return _FP_UNRESOLVABLE_ALIAS
    if expanded == tokens or _fp_find_push_subcommand(expanded)[0] is None:
        return tokens
    return expanded


# Characters a re-parsed payload can leave on the edge of a word when one
# escaping layer is consumed (`git status\"` scans as the command word
# `status`): the name check trims them so a mangled view of a command git runs
# itself is not mistaken for an alias. The mangling only ever adds or drops
# quote characters, so it cannot turn one command name into another.
_FP_WORD_EDGE_NOISE = " \t\r\n\"'\\`;&|()<>"


# A command word the guard cannot resolve: it holds a shell expansion (an
# unquoted `$` or backtick) or an unquoted brace expansion (`{a,b}`, `{1..3}`).
# `$(printf git) push -f origin main` and `{git,-c} ... push -f origin main`
# really run `git push -f origin main`, but the command word scans as the
# substitution text or the brace text, so no git invocation is visible.
_FP_DYNAMIC_COMMAND_WORD = re.compile(r"""[$`]""")
_FP_BRACE_EXPANSION = re.compile(r"\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}")


def _fp_unquoted_text(text: str, *, keep_expansions: bool = False) -> str:
    """`text` with every quoted or backslash-escaped span blanked out.

    Only what the shell expands unquoted matters here, and inside quotes a
    brace is data. `keep_expansions` keeps the content of a DOUBLE-quoted span
    instead, because the shell still expands `$` and backticks there -- a quoted
    command word (`"$c" push -f origin main`, `"$(printf git)" ...`) runs what
    the expansion produces just like an unquoted one, so the dynamic-word test
    reads this view. A backslash escape is folded in both views (an escaped
    `$` is a literal), and single-quoted spans stay data."""
    chars = list(text)
    quote: str | None = None
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if quote is None:
            if ch in ("'", '"'):
                quote = ch
                chars[i] = " "
            elif ch == "\\" and i + 1 < n:
                chars[i] = " "
                chars[i + 1] = " "
                i += 1
        elif quote == "'":
            if ch == "'":
                quote = None
            chars[i] = " "
        elif ch == "\\" and i + 1 < n:
            chars[i] = " "
            chars[i + 1] = " "
            i += 1
        elif keep_expansions:
            if ch == '"':
                quote = None
                chars[i] = " "
        else:
            if ch == '"':
                quote = None
            chars[i] = " "
        i += 1
    return "".join(chars)


# The "argv the guard cannot statically resolve" family:
#
#   P = a force-push pattern is present (in the visible text, including text the
#       scanner folds into a quoted word value)
#   U = a command run's command word is argv the guard cannot resolve: an
#       expansion (variable, substitution, backtick, `${IFS}`), an unquoted
#       brace expansion, or a wrapper the guard does not model
#   E = an execution conduit: a pipe or input redirect into a shell
#       interpreter, a here-string, or xargs driving one
#
# A shell text guard cannot follow any of those to the command that really runs,
# so (P and U) and E are refused (and an unmodeled wrapper in command position
# is refused whenever a force-push pattern is anywhere in the text, which also
# covers `ssh build-box "git push -f origin main"`).
_FP_PUSH_IN_TEXT = re.compile(r"(?<![A-Za-z0-9_])push(?![A-Za-z0-9_])")
_FP_FORCE_IN_TEXT = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?:--forc(?:e)?(?![A-Za-z0-9_-])|--m(?:ir(?:r(?:or)?)?)?(?![A-Za-z0-9_-])"
    r"|-[A-Za-z]*f(?![A-Za-z0-9_-])|\+[^\s;&|()])"
)
# Wrappers that can change what or where the command runs (a child process, a
# container, another host, another user, a changed root): the guard cannot model
# them, so a force-push pattern next to one is refused.
_FP_UNMODELED_WRAPPERS = (
    "ssh",
    "chroot",
    "timeout",
    "parallel",
    "docker",
    "podman",
    "nsenter",
    "unshare",
    "bwrap",
    "firejail",
    "flatpak",
    "systemd-run",
    "runuser",
    "su",
    "doas",
    "sudo",
    "time",
    "setsid",
    "stdbuf",
    "nohup",
    "nice",
    "xargs",
)
# Shells that read a script from their stdin when given a conduit. A leading
# slash is allowed (and a preceding dot is not), so a path-qualified or
# relative interpreter (`/bin/sh`, `/bin/bash`, `./sh`) counts while a script
# file whose name merely ends in one (`payload.sh`) stays data.
_FP_SHELL_INTERPRETER_IN_TEXT = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:sh|bash|zsh|dash|ksh|fish|tcsh|csh)(?:\.exe)?(?![A-Za-z0-9_.-])",
    re.IGNORECASE,
)


def _fp_flattened_text(words: list[_FpShellWord]) -> str:
    """The command's word values joined by spaces.

    Quotes are already folded away by the scanner, so a payload quoted into one
    word (`ssh build-box "git push -f origin main"`) shows its text here."""
    return " ".join(word.value for word in words)


def _fp_force_push_pattern_in_text(text: str) -> bool:
    """True when the text carries `push` together with a force signal."""
    if not _FP_PUSH_IN_TEXT.search(text):
        return False
    return bool(_FP_FORCE_IN_TEXT.search(text))


def _fp_is_unmodeled_wrapper(value: str) -> bool:
    return _fp_command_name(value) in _FP_UNMODELED_WRAPPERS


# remote.<name>.mirror and remote.<name>.push both turn a plain push into a
# forced one: a mirror remote force-updates every ref (git treats
# `git push <name>` with remote.<name>.mirror=true as `git push --mirror`),
# and a configured push refspec can itself carry a `+`. git reads the section
# and the variable name case-insensitively (only the subsection is
# case-sensitive), so the key is matched case-folded; both are read from the
# word itself, so the inline `-c` value and the `git config` argument
# spellings match alike.
_FP_MIRROR_OR_PUSH_KEY = re.compile(r"^remote\.[^.]+\.(?:mirror|push)(?:=|$)", re.IGNORECASE)
# The env spelling of the same write: git reads a GIT_CONFIG_COUNT=<n> header
# plus GIT_CONFIG_KEY_<i>/GIT_CONFIG_VALUE_<i> pairs as command-scope
# configuration, and GIT_CONFIG_PARAMETERS carries the same pairs serialized in
# one word (it is the variable `git -c` itself sets). An env key word arms a
# push exactly like an inline `-c` or a `git config` argument, and a key the
# guard cannot read statically (an expansion) is refused like the rest of the
# unresolvable family rather than trusted.
_FP_ENV_CONFIG_KEY = re.compile(r"^GIT_CONFIG_KEY_\d+=(?P<key>.*)$", re.IGNORECASE)
_FP_ENV_CONFIG_PARAMETERS = re.compile(r"^GIT_CONFIG_PARAMETERS=", re.IGNORECASE)


def _fp_mirror_or_push_refspec_configured(words: list[_FpShellWord]) -> bool:
    """True when a word sets remote.<name>.mirror or remote.<name>.push, in
    any of the spellings git reads: the config key itself, an env-injected key
    word, or the serialized GIT_CONFIG_PARAMETERS word."""
    for word in words:
        value = word.value
        if _FP_MIRROR_OR_PUSH_KEY.match(value):
            return True
        if _FP_ENV_CONFIG_PARAMETERS.match(value):
            return True  # the pairs inside are one shell-quoted blob
        env_key = _FP_ENV_CONFIG_KEY.match(value)
        if env_key is not None and (
            _FP_MIRROR_OR_PUSH_KEY.match(env_key["key"])
            or _FP_GLOB_OR_SUBSTITUTION.search(env_key["key"])
        ):
            return True
    return False


def _fp_mirror_config_refusal() -> str:
    return _fp_format_refusal(
        "a remote.<name>.mirror or remote.<name>.push setting in this command"
        " can turn the push into a forced one the guard cannot verify (a"
        " mirror remote force-updates every ref; a configured push refspec"
        " can carry a +)"
    )


# git's inline config options (verified against git 2.55, which accepts
# `-c <name>=<value>` and `--config-env <name>=<envvar>` in both the spaced and
# the attached form, and rejects `--config` and a glued `-c<name>=<value>`
# with `unknown option`). A literal operand is already read by the word-level
# remote.<name>.mirror/push rule; the helpers below read the operands that
# hide the key or the value from that rule.
_FP_SIMPLE_VARIABLE = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")
_FP_ASSIGNMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FP_EXPORT_BUILTINS = ("export", "declare", "typeset", "local", "readonly")


def _fp_literal_assignments(
    words: list[_FpShellWord], before: int
) -> dict[str, str | None]:
    """NAME -> value for the assignments made before words[`before`].

    Only a word in assignment position counts: the first word of a command
    (`CFG='...'; git -c $CFG ...`) or the operand of an export-style builtin.
    A value carrying an expansion or a glob is not the literal text the shell
    passes, so it maps to None: a caller that needs the value refuses to guess
    rather than fall back to an environment the shell does not use."""
    assignments: dict[str, str | None] = {}
    for index, word in enumerate(words[:before]):
        name, separator, assigned = word.value.partition("=")
        if not separator or not _FP_ASSIGNMENT_NAME.fullmatch(name):
            continue
        previous = words[index - 1].value if index else ""
        if not word.starts_command and previous not in _FP_EXPORT_BUILTINS:
            continue
        assignments[name] = (
            None if _FP_GLOB_OR_SUBSTITUTION.search(assigned) else assigned
        )
    return assignments


def _fp_cd_environment(
    words: list[_FpShellWord], limit: int
) -> dict[str, str | None]:
    """The HOME and CDPATH the command's own `cd` commands read.

    The replay uses one snapshot for every cd in the prefix, so it is only
    trusted for a command that is simple enough for that to be exact: HOME and
    CDPATH assigned at most once each, both before the first cd, and with a
    value that needs no tilde expansion (an unquoted `~` in an assignment is
    expanded against the HOME in effect at that point, which the guard does not
    track). Anything else marks both names unreadable, and the replay refuses
    rather than probing a directory the shell did not enter. A name the command
    never assigns is absent, so the caller falls back to the environment the
    guard itself spawns with."""
    first_cd = next(
        (
            index
            for index in range(limit)
            if words[index].value in ("cd", "pushd")
        ),
        limit,
    )
    tracked: dict[str, str | None] = {}
    for index, word in enumerate(words[:limit]):
        name, separator, assigned = word.value.partition("=")
        if not separator or name not in ("HOME", "CDPATH"):
            continue
        previous = words[index - 1].value if index else ""
        if not word.starts_command and previous not in _FP_EXPORT_BUILTINS:
            continue
        if index >= first_cd or name in tracked or assigned.startswith("~"):
            # A later assignment, a repeated one, or a value the shell would
            # tilde-expand: one snapshot cannot describe every cd.
            tracked["HOME"] = None
            tracked["CDPATH"] = None
            break
        tracked[name] = (
            None if _FP_GLOB_OR_SUBSTITUTION.search(assigned) else assigned
        )
    return tracked


def _fp_config_variable_value(word: str, assignments: dict[str, str]) -> str | None:
    """The literal value this command assigns to `word`, when `word` is exactly
    one variable (`$CFG` or `${CFG}`); None otherwise."""
    variable = _FP_SIMPLE_VARIABLE.fullmatch(word)
    if variable is None:
        return None
    return assignments.get(variable[1])  # None: the command sets it unreadably


def _fp_inline_config_key(word: str, assignments: dict[str, str]) -> str | None:
    """The config key a `-c`/`--config-env` operand writes, or None when the
    guard cannot read it.

    A literal `name=value` word writes `name`; a word that is exactly one
    variable is the literal assignment this command makes to it (so
    `CFG='remote.origin.push=+main:main'; git -c $CFG ...` is read); a dynamic
    key part is resolved the same way; and a substitution, a longer expansion,
    or a variable the command does not set is unreadable, which the caller
    refuses rather than trusts. Only the key decides which configuration is
    written, so a dynamic value under a literal key stays readable."""
    key, separator, _ = word.partition("=")
    if separator and key and not _FP_GLOB_OR_SUBSTITUTION.search(key):
        return key
    if separator and key:
        resolved = _fp_config_variable_value(key, assignments)
        return None if resolved is None else _fp_inline_config_key(
            resolved + "=", assignments
        )
    resolved = _fp_config_variable_value(word, assignments)
    return None if resolved is None else _fp_inline_config_key(resolved, assignments)


def _fp_unreadable_inline_config(
    run: _FpPushRun, words: list[_FpShellWord]
) -> str | None:
    """Why this invocation carries inline config the guard cannot read, or None.

    Walks the git global-option region of the run, pairing each `-c` with its
    operand and each `--config-env` with its `name=envvar` word the way git
    parses them. A key naming remote.<name>.mirror or remote.<name>.push is
    refused as the config write it is, a key the guard cannot read is refused
    because the configuration it writes is unknown, and a `--config-env` value
    whose env var this command does not set literally is refused for the same
    reason."""
    assignments = _fp_literal_assignments(words, run.git_index)
    tokens = run.tokens
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--" or not token.startswith("-") or token == "-":
            return None  # the subcommand ends the global-option region
        operand: str | None = None
        from_environment = False
        if token in ("-c", "--config-env"):
            operand = tokens[index + 1] if index + 1 < len(tokens) else None
            from_environment = token == "--config-env"
            index += 2
        elif token.startswith("--config-env="):
            operand = token[len("--config-env=") :]
            from_environment = True
            index += 1
        elif token.startswith("-c") and len(token) > 2:
            operand = token[2:]  # the glued -c<name>=<value> form
            index += 1
        elif token in _FP_GIT_GLOBAL_VALUE_SHORT or token in _FP_GIT_GLOBAL_VALUE_LONG:
            index += 2  # an option with a space-separated value
        else:
            index += 1  # an attached-value or valueless global option
        if operand is None:
            continue
        key = _fp_inline_config_key(operand, assignments)
        if key is None:
            return _fp_format_config_option_refusal(operand)
        if _FP_MIRROR_OR_PUSH_KEY.match(key):
            return _fp_mirror_config_refusal()
        if from_environment:
            _, _, variable = operand.partition("=")
            if not _FP_ASSIGNMENT_NAME.fullmatch(variable):
                return _fp_format_config_option_refusal(operand)
            if assignments.get(variable) is None:
                # The value comes from an environment variable this command
                # does not set to a literal, so the config it applies is
                # unreadable.
                return _fp_format_config_option_refusal(operand)
    return None


_FP_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Value-taking options per wrapper the command-word walk steps over (from each
# tool's synopsis, as the sudo guard's audited table records them): env alone
# has them, and a wrongly listed boolean would swallow the command word while
# a missing value option reads the operand as the command (`env -vu NAME $c
# push -f ...` loses $c entirely), so both directions fail closed here.
# Optional-argument options (env's --block-signal family) are deliberately
# absent: their separate operand is the command itself.
_FP_WRAPPER_VALUE_OPTIONS: dict[str, frozenset[str]] = {
    "env": frozenset(
        {"-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0", "-P", "--env0-from"}
    ),
    "command": frozenset(),
    "builtin": frozenset(),
}
# Short letters of the value options above: a bundle such as `env -vu NAME`
# ends on a value-taking letter, so the walk must consume its operand there.
_FP_WRAPPER_VALUE_LETTERS: dict[str, str] = {
    "env": "uCSaP",
    "command": "",
    "builtin": "",
}
# GNU env's long options (`env --help`, coreutils 9.11). getopt_long resolves
# an unambiguous prefix (`--s` and `--split` are --split-string, `--uns` is
# --unset, `--ignore-env` is --ignore-environment) and refuses an ambiguous one
# (`--i` is both --ignore-environment and --ignore-signal), so a prefix has to
# be resolved, not compared exactly. --block-signal, --default-signal and
# --ignore-signal take an optional argument, which is why their separate
# operand is the command itself and they are not value options here.
_FP_ENV_LONG_OPTIONS = (
    "argv0", "unset", "chdir", "split-string", "ignore-environment", "null",
    "debug", "block-signal", "default-signal", "ignore-signal",
    "list-signal-handling", "help", "version",
)
_FP_ENV_LONG_VALUE_OPTIONS = frozenset({"argv0", "unset", "chdir", "split-string"})


def _fp_env_long_option(value: str) -> tuple[str | None, str | None, bool]:
    """Resolve a `--name[=operand]` env word: (option, glued operand, ambiguous).

    An unambiguous prefix names its option, an exact name names itself, a word
    that is no env option at all leaves the option None (env itself errors on
    it), and a prefix matching more than one option is reported ambiguous.
    Only a value-taking option hands back an operand; `--name=operand` glues it
    to the word, the space-separated form leaves it to the next word."""
    name, separator, glued = value[2:].partition("=")
    if not name:
        return None, None, False  # the bare `--` terminator ends the options
    matches = [option for option in _FP_ENV_LONG_OPTIONS if option.startswith(name)]
    if len(matches) > 1:
        return None, None, True
    if not matches or matches[0] not in _FP_ENV_LONG_VALUE_OPTIONS:
        return None, None, False
    # An empty attached operand (`env --argv0=`) is an operand, not a missing
    # one: it belongs to the option, so the next word is still the command.
    return matches[0], (glued if separator else None), False


def _fp_split_wrapper_option(value: str, wrapper: str) -> tuple[str | None, str | None]:
    """(option, glued operand) when a wrapper flag word takes a value, else
    (None, None). A flag that is an exact match, a `--long=value` word, or a
    short bundle whose first value-taking letter hands it the rest of the
    bundle as its operand (`env -vu NAME` -> -u with the next word, `env
    -uFOO $c ...` -> -u with FOO glued) consumes the operand the same way
    getopt does."""
    options = _FP_WRAPPER_VALUE_OPTIONS.get(wrapper, frozenset())
    if value in options:
        return value, None
    if wrapper == "env" and value.startswith("--"):
        # A long option is resolved by prefix, like getopt_long: `env --uns
        # FOO $c push -f ...` hands the operand to --unset, so the expansion
        # after it is the command word rather than the option's operand.
        option, glued, _ = _fp_env_long_option(value)
        return (value, glued) if option is not None else (None, None)
    if value.startswith("--") and "=" in value:
        option, _, glued = value.partition("=")
        return (option, glued) if option in options else (None, None)
    letters = _FP_WRAPPER_VALUE_LETTERS.get(wrapper, "")
    if letters and len(value) > 2 and value[0] == "-" and value[1] != "-":
        offset = next(
            (index for index, char in enumerate(value[1:]) if char in letters),
            None,
        )
        if offset is None:
            return None, None
        return "-" + value[1 + offset], value[2 + offset :] or None
    return None, None


def _fp_unresolvable_command_words(
    words: list[_FpShellWord], command: str
) -> set[int]:
    """Indices of command words the guard cannot resolve.

    A command word is what the shell would run: the first word of a run that is
    neither an env-assignment prefix, a wrapper the guard models (`env`,
    `command`, `builtin`, ...), nor an option word such a wrapper takes. A
    prefix is skipped (`X=$Y git push -f origin feature` and `env -i git push -f
    origin feature` both run the visible git word, and the rest of the guard
    already treats such prefixes as benign: relocation, force, and target rules
    still apply to it), while a command word the guard cannot resolve -- an
    expansion (quoted or not: a double-quoted `$c` expands), an unquoted brace
    expansion, or an unmodeled wrapper -- is recorded."""
    found: set[int] = set()
    index = 0
    total = len(words)
    while index < total:
        word = words[index]
        if not word.starts_command:
            index += 1
            continue
        # A substitution interior is its own command text (`echo "$(c=git; $c
        # push -f origin main)"` really runs the push), so a command word that
        # starts one is judged here too, even though the enclosing word is the
        # one the enclosing command passes on. Its run ends at the enclosing
        # word, and the prefix walk below steps over the interior's own words
        # the way it steps over a top-level run.
        interior = _fp_contained_in_later_word(words, index)
        run_end = (
            next(
                (
                    probe
                    for probe in range(index, total)
                    if not _fp_contained_in_later_word(words, probe)
                ),
                total,
            )
            if interior
            else total
        )
        probe = index
        wrapper = ""
        while probe < run_end and (
            interior or not _fp_contained_in_later_word(words, probe)
        ):
            value = words[probe].value
            if _FP_ENV_ASSIGNMENT.match(value) or value.startswith("-"):
                # An env assignment or a wrapper option: the command word is
                # still ahead (`env -i $c push -f origin main` really runs $c).
                probe += 1
                option, glued = _fp_split_wrapper_option(value, wrapper)
                if (
                    option is not None
                    and glued is None
                    and probe < run_end
                    and (interior or not _fp_contained_in_later_word(words, probe))
                ):
                    probe += 1  # the option's value (`env -u NAME`) is not it
                continue
            if (
                _fp_command_name(value) in _FP_COMMAND_WRAPPERS
                and not _fp_is_unmodeled_wrapper(value)
            ):
                # A modeled wrapper runs the word that follows it, so that word
                # is the command word the guard has to resolve. An unmodeled
                # wrapper is the command word instead: it is recorded below and
                # refused as a wrapper.
                wrapper = _fp_command_name(value)
                probe += 1
                continue
            break
        if probe >= run_end or (probe != index and words[probe].starts_command):
            # The prefix had no command of its own (`X=1; git ...`): the next
            # run is handled on its own.
            index += 1
            continue
        candidate = words[probe]
        span = command[candidate.start : candidate.end]
        unquoted = _fp_unquoted_text(span)
        if (
            _FP_DYNAMIC_COMMAND_WORD.search(
                _fp_unquoted_text(span, keep_expansions=True)
            )
            or _FP_BRACE_EXPANSION.search(unquoted)
            or _fp_is_unmodeled_wrapper(candidate.value.strip(_FP_WORD_EDGE_NOISE))
        ):
            found.add(probe)
        index += 1
    return found


def _fp_execution_conduit(words: list[_FpShellWord], text: str) -> bool:
    """True when a shell interpreter can read the command it runs from stdin.

    `echo 'git push -f origin main' | sh`, `bash <<< '...'`, `sh < payload.sh`,
    and `xargs -I{} sh -c '...'` all hand the guard's text to a shell the guard
    cannot see into, so they are refused rather than scanned."""
    if "<<<" in text:
        return True
    if not _FP_SHELL_INTERPRETER_IN_TEXT.search(text):
        return False
    if "|" in text or "<" in text:
        return True
    return any(_fp_command_name(word.value) == "xargs" for word in words)


def _fp_family_violation(
    words: list[_FpShellWord], text: str, scan_text: str | None = None
) -> str | None:
    """Why this command belongs to the unresolvable-argv family, or None.

    `text` is the command as written (before redirection masking), because a
    conduit is made of the redirection characters the masker removes.
    `scan_text` is the text `words` were scanned from, which is the same string
    unless a line continuation or an escape was folded away before the scan:
    the word spans index into `scan_text`, so slicing `text` with them would
    read the wrong word (`echo a\\<newline>; ssh build-box "git push -f origin
    main"` slipped past the wrapper check that way)."""
    command = _fp_mask_redirections(text if scan_text is None else scan_text)
    if _fp_execution_conduit(words, text):
        return (
            "a shell reads the command it runs from a pipe, a here-string, or a"
            " redirect, so the guard cannot see what executes"
        )
    flat = _fp_flattened_text(words)
    if not _fp_force_push_pattern_in_text(flat):
        return None
    unresolvable = _fp_unresolvable_command_words(words, command)
    if not unresolvable:
        return None
    if any(_fp_is_unmodeled_wrapper(words[index].value) for index in unresolvable):
        return (
            "an unmodeled wrapper (ssh, chroot, timeout, sudo, docker,"
            " xargs, ...) is"
            " in command position next to a force-push pattern, and the guard"
            " cannot see what it runs or where"
        )
    return (
        "its command word is argv the guard cannot resolve (an expansion or an"
        " unquoted brace expansion) next to a force-push pattern, so what it"
        " runs is decided at run time"
    )


def _fp_unresolvable_command_word_hides_force_push(
    words: list[_FpShellWord], command: str
) -> bool:
    """True when an unresolvable command word sits in a force-push command run.

    The word decides what runs, so when the same run also carries `push` with a
    force signal (a force flag, an unresolvable argument, a `+`-refspec, or
    `--mirror`) the run is refused. The same word with no push pattern next to
    it stays inert: `$HOME/bin/tool args`, `$(which x) --version`,
    `cp {a,b}.txt /tmp`, and `ls '*.{ts,tsx}'` (quoted braces are data)."""
    for index in sorted(_fp_unresolvable_command_words(words, command)):
        if _fp_is_unmodeled_wrapper(words[index].value):
            continue  # the family rule covers wrappers with P anywhere
        tokens = _fp_invocation_tokens(words, index)
        for push_index, token in enumerate(tokens[1:], start=1):
            if token != "push":
                continue
            if _fp_is_guarded_push(_fp_parse_push_args(tokens, push_index)):
                return True
    return False


def _fp_unresolvable_git_subcommand(words: list[_FpShellWord]) -> str | None:
    """The first git subcommand the guard cannot resolve, or None.

    A name outside git's own command table is resolved through `alias.<name>`
    (repository, user, or system config) or through an external `git-<name>`
    program on PATH; either can run a force push the command text does not
    show. An inline `-c alias.<name>=...` is followed first, so a name the guard
    can still resolve to a command git runs itself passes."""
    for index, word in enumerate(words):
        if _fp_command_name(word.value) not in _FP_GIT_COMMAND_NAMES:
            continue
        tokens = _fp_invocation_tokens(words, index)
        subcommand = _fp_effective_subcommand(tokens)
        if subcommand is None or subcommand is _FP_UNRESOLVABLE_ALIAS:
            continue  # no subcommand, or already refused as an alias
        name = subcommand.strip(_FP_WORD_EDGE_NOISE)
        if not name:
            continue
        if name in _FP_GIT_COMMANDS:
            continue  # git runs this command itself, whatever aliases exist
        return name
    return None


def _fp_find_git_push_runs(words: list[_FpShellWord]) -> list[_FpPushRun]:
    """Find every `git ... push` invocation, as argv token runs.

    Words fold quotes and escapes into their values, so quoted command names
    (`"git" push -f origin main`), quoted subcommands, and quoted flags scan
    exactly like their unquoted forms. A `sudo`/env-assignment prefix and
    slash-qualified command words are tolerated the way the other kernel
    bash guards tolerate them, at the cost of matching an unquoted echo of
    the same text: conservative in the safe direction.
    """
    runs: list[_FpPushRun] = []
    for index, word in enumerate(words):
        if _fp_command_name(word.value) not in _FP_GIT_COMMAND_NAMES:
            continue
        tokens = _fp_invocation_tokens(words, index)
        prefix_relocated, xargs_fed = _fp_invocation_context(words, index)
        expanded = _fp_expand_inline_git_aliases(tokens)
        if expanded is _FP_UNRESOLVABLE_ALIAS:
            # The command line defines an alias for the word it invokes and the
            # guard cannot read the body: refuse rather than miss a push.
            runs.append(_FpPushRun(index, 0, tokens, prefix_relocated, xargs_fed, True))
            continue
        push_index, global_relocated = _fp_find_push_subcommand(expanded)
        if push_index is None:
            continue
        runs.append(
            _FpPushRun(
                index,
                push_index,
                expanded,
                global_relocated or prefix_relocated,
                xargs_fed,
            )
        )
    return runs


def _fp_invocation_context(
    words: list[_FpShellWord], git_index: int
) -> tuple[bool, bool]:
    """Whether the git invocation is relocated or xargs-fed, from the words
    immediately before it in the same command run. Env assignments (a git
    word often follows one as the first word of the command), wrappers, and
    xargs may directly precede the invocation even while starting the
    command, so the walk looks through them; a real preceding command word
    stops it."""
    relocated = False
    xargs_fed = False
    command_start = git_index
    while command_start > 0 and not words[command_start].starts_command:
        command_start -= 1
    if any(
        _fp_command_name(word.value) in _FP_ENV_COMMAND_NAMES
        for word in words[command_start:git_index]
    ):
        # `env` can move the invocation (`env -C DIR git push -f`) and its
        # option words end the walk below, so the cwd the guard would probe is
        # not necessarily the one the push runs in.
        relocated = True
    j = git_index - 1
    while j >= 0:
        prev = words[j]
        value = prev.value
        name = _fp_command_name(value)
        if prev.starts_command and not (
            re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", value)
            or name in _FP_XARGS_COMMAND_NAMES
            or name in _FP_COMMAND_WRAPPERS
        ):
            break  # a real command precedes: nothing of this invocation's
        if _fp_contained_in_later_word(words, j):
            j -= 1  # substitution interior before the enclosing word
            continue
        if name in _FP_XARGS_COMMAND_NAMES:
            xargs_fed = True  # refspecs arrive on stdin, unseen by the guard
        elif re.match(r"^GIT_[A-Z_]+=", value):
            relocated = True  # GIT_DIR/GIT_WORK_TREE/... select another repository
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", value):
            pass  # a benign env assignment applies only to this invocation
        elif name in _FP_COMMAND_WRAPPERS:
            if name in _FP_UNMODELED_WRAPPERS:
                # `sudo`/`time`/`ssh`-style wrappers can run the command
                # somewhere else (a child process, another user, another
                # repository), so the cwd the guard would probe is not known.
                relocated = True
        elif _fp_is_unmodeled_wrapper(value):
            relocated = True  # an unmodeled wrapper in front of the invocation
        else:
            break  # an argument or unknown wrapper: nothing more to learn
        j -= 1
    return relocated, xargs_fed


def _fp_parse_push_args(tokens: list[str], push_index: int) -> _FpPushArgs:
    """Parse the `git push` argv after the subcommand word: force flags,
    dry-run, wildcard refspecs, and the positionals (remote and refspecs) in
    the order git parses them."""
    force = False
    dry_run = False
    all_refs = False
    mirror = False
    unresolvable: str | None = None
    positionals: list[str] = []
    options_done = False
    i = push_index + 1
    n = len(tokens)
    while i < n:
        token = tokens[i]
        if (
            unresolvable is None
            and _FP_GLOB_OR_SUBSTITUTION.search(token)
            and not _FP_STATIC_AT_BRACE.fullmatch(token)
        ):
            # A word the shell expands (a variable, a substitution, a glob) can
            # become `-f`, or a `+`-refspec naming a protected branch, or the
            # remote, so the invocation cannot be proven non-force. A word that
            # is exactly `@{...}` is git's own syntax rather than a shell
            # expansion, so that one is not unresolvable; the dedicated `@{`
            # target check still refuses a forced push that names it
            # (`git push -f origin @{u}`, and `HEAD:@{u}` through its own
            # target). Anything else in the same word (`@{u}$(printf " -f
            # main")`, `@{u}$X`, a backtick tail) is an expansion tail and stays
            # unresolvable.
            unresolvable = token
        if options_done:
            positionals.append(token)
            i += 1
            continue
        if token == "--":
            options_done = True
            i += 1
            continue
        if token.startswith("--"):
            # parse-options also takes an unambiguous abbreviation of any long
            # option, so `--mir` is `--mirror` and a name is normalised before
            # it is read; an ambiguous abbreviation is refused, because which
            # option it would name cannot be told.
            resolved, ambiguous = _fp_push_long_option(token)
            if ambiguous:
                unresolvable = token
            elif resolved is not None:
                attached = token[len(token[2:].partition("=")[0]) + 2 :]
                # `--branches` is git's own alias of `--all`, which the
                # wildcard rule below reads.
                token = "--" + ("all" if resolved == "branches" else resolved) + attached
            # git's own parse-options accepts the `--no-` form of every
            # valueless boolean here, and the last one on the line wins, so
            # `-f --dry-run --no-dry-run` really forces and
            # `--force --no-force` does not.
            if token == "--force":
                force = True
            elif token == "--no-force":
                force = False
            elif token.startswith(("--force-with-lease", "--force-if-includes")):
                pass  # lease-protected or advisory forms are never bare force
            elif token == "--dry-run":
                dry_run = True
            elif token == "--no-dry-run":
                dry_run = False
            elif token == "--all":
                all_refs = True
            elif token == "--no-all":
                all_refs = False
            elif token == "--mirror":
                mirror = True
            elif token == "--no-mirror":
                mirror = False
            elif token == "--repo":
                i += 1  # consume the space-separated repository value
            elif token in _FP_PUSH_VALUE_LONG:
                i += 1  # consume the space-separated value
            elif token.startswith(
                ("--receive-pack=", "--exec=", "--push-option=", "--signed=", "--recurse-submodules=")
            ):
                pass  # attached value: nothing to consume
            # other valueless long options (and unknown ones) are inert here
            i += 1
            continue
        if token.startswith("-") and token != "-":
            cluster = token[1:]
            consumes_value = False
            for position, ch in enumerate(cluster):
                if ch == "f":
                    force = True
                elif ch == "n":
                    dry_run = True
                elif ch in _FP_PUSH_VALUE_SHORT:
                    # git reads the REST of the cluster as this option's value,
                    # so nothing after it is a flag: `-oo` is `-o o` (and the
                    # next token is still a flag), while `-of` is `-o f` and
                    # never carries a force flag.
                    consumes_value = position == len(cluster) - 1
                    break
            i += 1 if consumes_value else 0
            i += 1
            continue
        positionals.append(token)
        i += 1
    # git always reads the first positional as the repository, whatever it
    # looks like: `git push localhost:repo.git`, `git push origin:main`,
    # `git push +main:main`, `git push refs/heads/main:refs/heads/main`, and
    # `git push :main` all try to reach a remote by that name (real git answers
    # with ssh host errors for the colon forms), so a lone positional never
    # carries a refspec. `--repo` does not change that: the option is
    # equivalent to the positional and the positional wins (verified:
    # `git push -f --repo=<bare> origin` force-updates origin's main through an
    # implicit refspec, while `git push -f --repo=<bare> main` tries to reach a
    # repository named `main`), so the refspecs are the positionals after the
    # first one either way. A remote named by a URL, an scp-like path, or a
    # `name:path` leaves the refspec implicit, and the implicit path (upstream
    # probe, or a refusal when there is nothing to verify against) decides what
    # it would rewrite.
    refspecs = positionals[1:]
    # `--mirror` is `--all` plus a forced, prune-by-default push of every ref,
    # so it carries force with it; `--all` only fast-forwards and does not.
    return _FpPushArgs(
        force or mirror, dry_run, all_refs or mirror, refspecs, unresolvable
    )


def _fp_is_guarded_push(args: _FpPushArgs) -> bool:
    """True when the invocation carries force and is not a dry run.

    A word the scanner cannot resolve counts as force: the shell may expand it
    into a force flag or into a `+`-refspec before git reads argv, and it can
    also expand into `--no-dry-run`, which turns a visible dry run back into a
    real push, so an unresolvable argument is guarded even alongside
    `--dry-run`."""
    if args.unresolvable is not None:
        return True
    if args.dry_run:
        return False
    return args.force or any(spec.startswith("+") for spec in args.refspecs)


def _fp_run_is_guarded(run: _FpPushRun) -> bool:
    """Whether one scanned `git ... push` run needs the violation check."""
    return run.unresolvable_alias or _fp_is_guarded_push(
        _fp_parse_push_args(run.tokens, run.push_index)
    )


_FP_MAX_PAYLOAD_DEPTH = 10


def _fp_payload_hides_force_push(payload: str, depth: int = 0) -> bool:
    """True when a payload the shell re-reads as a command hides a force push.

    The payload is command text, so it goes through the same normalization,
    masking, escape folding, and word scan as a top-level command -- and then
    through the same nested-payload scans, because a payload can hold another
    payload (`env -S 'sh -c "git push -f origin main"'`) that the plain scan
    reads as one quoted word. Nesting deeper than _FP_MAX_PAYLOAD_DEPTH is
    refused rather than missed."""
    if depth > _FP_MAX_PAYLOAD_DEPTH:
        return True  # too deeply nested to follow: refuse rather than miss
    _fp_scan_charge()  # entering a payload is one more nested re-scan
    normalized, _index_map = _fp_strip_escapes(
        _fp_mask_redirections(_fp_normalize_continuations(payload))
    )
    words = _fp_scan_words(normalized)
    if _fp_family_violation(words, payload, normalized) is not None:
        return True  # the payload belongs to the unresolvable-argv family
    runs = _fp_find_git_push_runs(words)
    if runs:
        for run in runs:
            if _fp_unreadable_inline_config(run, words) is not None:
                # A payload runs the same commands a top-level line does, so
                # the inline-config rule applies inside it too.
                return True
        if _fp_mirror_or_push_refspec_configured(words):
            # ... and so does the mirror/push-refspec config rule.
            return True
    if _fp_unresolvable_command_word_hides_force_push(words, normalized):
        return True  # the payload's command word decides what runs
    if _fp_unresolvable_git_subcommand(words) is not None:
        # A payload runs the same commands a top-level line does, so a git
        # subcommand the guard cannot resolve is refused here too: a repository
        # alias or an external `git-` program (`sh -c "git p"`) would otherwise
        # run unchecked inside the payload.
        return True
    if any(_fp_run_is_guarded(run) for run in runs):
        return True
    if re.search(r"\beval\b", normalized) and _fp_eval_payloads_hide_force_push(
        normalized, depth + 1
    ):
        return True
    if _FP_SHELL_INTERPRETER_GATE.search(normalized) and (
        _fp_shell_c_payloads_hide_force_push(normalized, depth + 1)
    ):
        return True
    # The command-name checks fold case (`ENV`, `ENV.EXE`, `SH`), so the cheap
    # gate has to match them the same way or the scan never runs.
    return bool(
        re.search(r"\benv\b", normalized, re.IGNORECASE)
        and _fp_env_payloads_hide_force_push(normalized, depth + 1)
    )


_FP_PAYLOAD_EXPANSION = re.compile(r"""[$`]""")


def _fp_payload_has_expansion(text: str) -> bool:
    """True when a payload's text carries a shell expansion.

    `cmd='git push -f origin main'; sh -c "$cmd"` runs the value of `$cmd`, not
    the literal text the guard reads, so a payload holding `$` or a backtick
    cannot be scanned statically and is refused."""
    return bool(_FP_PAYLOAD_EXPANSION.search(text))


def _fp_payload_is_ansi_c(source: str) -> bool:
    """True for a `$'...'`/`$"..."` payload word.

    ANSI-C quoting decodes escapes before the payload runs, and the guard does
    not reproduce that split, so a payload carrying one is refused outright
    rather than scanned as text it is not."""
    return source.startswith("$'") or source.startswith('$"')


# `eval` re-parses its payload, so a quoted argument that the plain scan must
# treat as data still executes. Unquote each eval payload one shell quoting
# layer at a time and rescan; a force push found in any layer is refused
# outright because the payload can relocate or chain freely.
_FP_MAX_EVAL_DEPTH = 10


def _fp_eval_payloads_hide_force_push(command: str, depth: int = 0) -> bool:
    if depth > _FP_MAX_EVAL_DEPTH:
        return True  # absurdly nested evals: refuse rather than risk a miss
    words = _fp_scan_words(command)
    for index, word in enumerate(words):
        if word.value != "eval":
            continue
        payload_parts: list[str] = []
        value_parts: list[str] = []
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if not _fp_contained_in_later_word(words, follower_index):
                    break
                continue  # substitution interior: the enclosing word follows
            payload_source = command[follower.start : follower.end]
            if _fp_payload_is_ansi_c(payload_source):
                return True  # the guard does not reproduce an ANSI-C payload
            payload_parts.append(payload_source)
            value_parts.append(follower.value)
        payload = _fp_unquote_one_level(" ".join(payload_parts))
        if _fp_payload_has_expansion(payload):
            # The expansion decides what runs: `cmd='git push -f origin main';
            # eval "$cmd"` never contains the push text.
            return True
        if _fp_payload_hides_force_push(payload, depth + 1):
            return True
        # The raw sources lose one escaping layer per nesting level, and the
        # folded word values are the same text with that layer already resolved
        # (they are exactly what the shell passes to the inner command), so look
        # at both: an `eval`-first chain of alternating eval/sh layers is only
        # reachable through the second look.
        if _fp_payload_hides_force_push(" ".join(value_parts), depth + 1):
            return True
        if _fp_eval_payloads_hide_force_push(payload, depth + 1):
            return True
    return False


# fish carries `-c`/`--command` and `-C`/`--init-command` payloads, and the
# csh family carries `-c`; both also read a piped stdin as a script, so they
# are governed like the POSIX set (a plain push payload in any of them is
# caught by the same word scan).
_FP_SHELL_C_INTERPRETERS = ("sh", "bash", "zsh", "dash", "ksh", "fish", "tcsh", "csh")
# The cheap gate that decides whether the payload scan is worth running: the
# same names as above, spelled case-insensitively (`SH` on a case-insensitive
# filesystem) and boundary-guarded.
_FP_SHELL_INTERPRETER_GATE = re.compile(
    r"\b(?:sh|bash|zsh|dash|ksh|fish|tcsh|csh)\b", re.IGNORECASE
)


def _fp_shell_c_payloads_hide_force_push(command: str, depth: int = 0) -> bool:
    """True when a quoted `sh -c`-style payload hides a force push.

    A quoted `-c` payload executes exactly like an eval payload, but the
    plain scan cannot see into it (the quoted payload folds into one word).
    Short flags may be bundled, so any short-option cluster carrying `c`
    hands the shell its payload. fish spells the same idea three more ways
    (`-C`/`--init-command` pre-configuration, `--command`, and getopt-glued
    values such as `fish -c'git push -f origin main'`, which only fish
    accepts), so all of them hand the shell a payload too. Doubly-quoted
    data stays inert: `sh -c 'echo "git push -f origin main"'` must not
    trigger. Unquoted payloads are scanned as plain invocations already and
    are skipped here."""
    if depth > _FP_MAX_PAYLOAD_DEPTH:
        return True  # nested too deep to follow: refuse
    words = _fp_scan_words(command)
    for index, word in enumerate(words):
        shell_name = _fp_command_name(word.value)
        if shell_name not in _FP_SHELL_C_INTERPRETERS:
            continue
        # `c` is the payload letter for every interpreter here; `C` is fish's
        # --init-command only. For the POSIX shells and the csh family `-C` is
        # a valueless flag (bash/zsh/dash/ksh noclobber; tcsh and csh reject
        # it), so reading it as a payload would hand the `-c` that follows to
        # it as its operand and drop the real payload from the scan.
        payload_letters = "cC" if shell_name == "fish" else "c"
        c_pending = False
        attach_offset = 0
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if _fp_contained_in_later_word(words, follower_index):
                # A substitution interior is scanned as its own command; the
                # word that holds it follows and is the payload candidate, so
                # `sh -c "$(echo hi)"` is not mistaken for `sh -c echo`.
                continue
            if follower.starts_command:
                break
            token = follower.value
            if not c_pending:
                attach_offset = 0
                if token == "--":
                    break
                # fish spells `-c`/`-C` long as --command/--init-command, and
                # getopt allows the payload glued on
                # (`fish --command='git push ...'`, `fish -c'git push ...'`).
                attached = next(
                    (
                        flag
                        for flag in ("--command=", "--init-command=")
                        if token.startswith(flag)
                    ),
                    None,
                )
                if attached is not None:
                    c_pending = True
                    attach_offset = len(attached)
                elif token in ("--command", "--init-command"):
                    c_pending = True
                elif (
                    token.startswith("-")
                    and token != "-"
                    and not token.startswith("--")
                ):
                    # Short flags may be bundled, and a `c` (or fish's `C`)
                    # hands the shell its payload: glued on when the cluster
                    # does not end there, and otherwise the next word.
                    marker = next(
                        (i for i, ch in enumerate(token[1:]) if ch in payload_letters),
                        None,
                    )
                    if marker is not None:
                        c_pending = True
                        glued = token[2 + marker :]
                        attach_offset = 2 + marker if glued else 0
                if c_pending and attach_offset == 0:
                    continue
            if c_pending:
                payload_source = command[
                    follower.start + attach_offset : follower.end
                ]
                if _fp_payload_is_ansi_c(payload_source):
                    return True  # the guard does not reproduce an ANSI-C payload
                if _fp_payload_has_expansion(payload_source):
                    # The expansion decides what runs, quoted or not:
                    # `cmd='git push -f origin main'; sh -c "$cmd"`.
                    return True
                if payload_source.startswith(("'", '"')):
                    if _fp_payload_hides_force_push(
                        _fp_unquote_one_level(payload_source), depth + 1
                    ):
                        return True
                # The raw source loses one escaping layer per nesting level, so
                # past the first level it no longer starts with a quote and the
                # branch above stops recursing. The folded word value the scan
                # already built is the same command text with that layer gone,
                # so look at it too: `sh -c "sh -c \"sh -c \\\"...\""` is
                # three levels of shell, and only the value walk reaches the
                # third. Both looks are needed -- the value alone misses an
                # alternating eval/sh chain, whose layers consume the escaping
                # differently.
                if _fp_payload_hides_force_push(
                    follower.value[attach_offset:], depth + 1
                ):
                    return True
                if shell_name == "fish":
                    # fish runs every payload it is given (--init-command
                    # pre-configuration and --command/`-c` alike), so a later
                    # one is still a command the guard has to read.
                    c_pending = False
                    continue
                break  # the payload word ends this shell invocation
    return False


_FP_ENV_COMMAND_NAMES = ("env", "env.exe")


def _fp_env_payload_reopens_payload(payload: str) -> bool:
    """True when a payload that contributes no command word ends in a bare
    `-S`/`--split-string`, so the word after it is that option's payload.

    env re-parses the split result as argv, so `env -S '' -S 'git push -f
    origin main'` splits "" to nothing, then re-reads `-S` (the payload of the
    first option is the second one, whose own word folds to `-S`) as the option
    it is, and hands the next word to it: measured with GNU env,
    `env -S'' -S 'echo hi'` prints `hi`."""
    words, well_formed = _fp_literal_words(payload)
    if not well_formed or not words or any(word is None for word in words):
        return False
    last = words[-1]
    if last.startswith("--"):
        option, glued, _ = _fp_env_long_option(last)
        return option == "split-string" and glued is None
    return last.startswith("-") and not last.startswith("--") and "S" in last[1:]


def _fp_payload_leaves_env_options_open(payload: str) -> bool:
    """True when a `-S` payload contributes no command word.

    env re-parses the split result as argv, so a payload that is blank or holds
    only option words leaves env parsing the options that follow it: measured
    with GNU env, `env -S '' -S 'echo hi'`, `env -S'   ' -S 'echo hi'` and
    `env -S -S 'echo hi'` all run `echo hi`, while a payload carrying a command
    word (`env -S 'echo hi' -S 'echo bye'` prints `hi -S echo bye`) ends the
    option parse and makes the rest that command's arguments."""
    words, well_formed = _fp_literal_words(payload)
    if not well_formed or any(word is None for word in words):
        return False  # an unreadable split cannot be predicted: keep it closed
    return all(word.startswith("-") for word in words)


def _fp_env_payload_hides_force_push_source(
    payload_source: str, payload_value: str, depth: int
) -> bool:
    """Whether one `env -S` payload hides a force push.

    Two looks, like the `sh -c` payload scan. The raw source is the payload as
    written, one shell quoting layer deep; the folded word value is the same
    text with that layer already consumed by the word scan. A chain of nested
    payloads needs both: the raw source loses one escaping layer per level, so
    past the first level it no longer starts with a quote and only the value
    walk reaches the command inside."""
    if _fp_payload_is_ansi_c(payload_source):
        return True  # the guard does not reproduce an ANSI-C split
    if _fp_payload_has_expansion(payload_source) or _fp_payload_has_expansion(
        payload_value
    ):
        return True  # the expansion's value decides what runs
    if _fp_payload_hides_force_push(
        _fp_unquote_one_level(payload_source), depth + 1
    ):
        return True
    if payload_value == payload_source:
        return False  # nothing folded away: the look above already covered it
    return _fp_payload_hides_force_push(payload_value, depth + 1)


def _fp_env_payloads_hide_force_push(command: str, depth: int = 0) -> bool:
    """True when an `env -S`/`--split-string` payload hides a force push.

    `env -S 'git push -f origin main'` splits that one word into the argv git
    receives, so the plain scan -- which sees a single quoted word -- cannot
    see the push. An ANSI-C-quoted payload is refused outright: the guard does
    not reproduce its split. Unquoted payloads need no handling here; the plain
    scan already reads them as the words they are."""
    if depth > _FP_MAX_PAYLOAD_DEPTH:
        return True  # nested too deep to follow: refuse
    words = _fp_scan_words(command)
    for index, word in enumerate(words):
        if os.path.basename(word.value).casefold() not in _FP_ENV_COMMAND_NAMES:
            continue
        payload_pending = False
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if _fp_contained_in_later_word(words, follower_index):
                continue  # substitution interior: the enclosing word follows
            if follower.starts_command:
                break
            token = follower.value
            payload_source = command[follower.start : follower.end]
            if payload_pending:
                if _fp_env_payload_hides_force_push_source(
                    payload_source, token, depth
                ):
                    return True
                if _fp_payload_leaves_env_options_open(token):
                    # A split string that contributes no command word leaves
                    # the option walk open: env re-parses the split result, so
                    # `env -S'   ' -S '...'` and `env -S -S '...'` really run
                    # the payload behind the second -S, which this payload may
                    # itself end on. A payload with a command word ends the
                    # option parse and makes the rest that command's arguments.
                    payload_pending = _fp_env_payload_reopens_payload(token)
                    continue
                break  # this env invocation is clean; check the next one
            if token == "--":
                break
            if token.startswith("--"):
                # getopt_long resolves a prefix, so `--s` and `--split` are
                # --split-string and carry the payload too.
                option, glued, _ = _fp_env_long_option(token)
                if option == "split-string":
                    if glued is None:
                        payload_pending = True
                        continue
                    operand_at = payload_source.find("=") + 1
                    if _fp_env_payload_hides_force_push_source(
                        payload_source[operand_at:], glued, depth
                    ):
                        return True
                    if _fp_payload_leaves_env_options_open(glued):
                        payload_pending = _fp_env_payload_reopens_payload(glued)
                        continue
                    break
                continue
            if token.startswith("-") and not token.startswith("--"):
                short = token[1:]
                if "S" in short:
                    attached = short[short.index("S") + 1 :]
                    offset = follower.start + 1 + short.index("S") + 1
                    if attached:
                        if _fp_env_payload_hides_force_push_source(
                            command[offset : follower.end],
                            token[len(("-" + short[: short.index("S") + 1])) :],
                            depth,
                        ):
                            return True
                        attached_payload = token[
                            len("-" + short[: short.index("S") + 1]) :
                        ]
                        if _fp_payload_leaves_env_options_open(attached_payload):
                            payload_pending = _fp_env_payload_reopens_payload(
                                attached_payload
                            )
                            continue
                        break
                    payload_pending = True
    return False


def _fp_ambiguous_env_option(words: list[_FpShellWord]) -> str | None:
    """The first ambiguous GNU env long-option abbreviation, or None.

    getopt_long resolves an unambiguous prefix but rejects an ambiguous one
    (`--i` is both --ignore-environment and --ignore-signal), and the guard
    cannot tell whether the option such a word names takes a value, so a
    command that carries one is refused rather than read with the wrong arity.
    Only env invocations are walked, and the walk stops at the next command."""
    for index, word in enumerate(words):
        if os.path.basename(word.value).casefold() not in _FP_ENV_COMMAND_NAMES:
            continue
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if _fp_contained_in_later_word(words, follower_index):
                continue  # substitution interior: the enclosing word follows
            if follower.starts_command or follower.value == "--":
                break
            if follower.value.startswith("--") and _fp_env_long_option(
                follower.value
            )[2]:
                return follower.value
    return None


class _FpUnresolvableCwd:
    """The directory a push would run in cannot be determined."""


_FP_UNRESOLVABLE_CWD = _FpUnresolvableCwd()


def _fp_literal_words(region: str) -> tuple[list[str | None], bool]:
    """Split one region into shell words, quoting-aware. Each word is the
    literal text the shell would pass, or None when the word contains
    something the resolver must refuse to guess at: command substitution or
    an unterminated quote. The second value is False when the region ended
    mid-quote."""
    words: list[str | None] = []
    current: list[str] = []
    unknown = False
    well_formed = True

    def flush_word() -> None:
        nonlocal unknown
        if current:
            words.append(None if unknown else "".join(current))
        current.clear()
        unknown = False

    i = 0
    n = len(region)
    while i < n and well_formed:
        ch = region[i]
        if ch.isspace():
            flush_word()
            i += 1
        elif ch == "#":
            break  # comment: nothing after it is part of the argv
        elif ch == "'":
            j = region.find("'", i + 1)
            if j == -1:
                well_formed = False
                break
            current.append(region[i + 1 : j])
            i = j + 1
        elif ch == '"':
            j = i + 1
            while j < n:
                inner = region[j]
                if inner == "\\" and j + 1 < n:
                    current.append(region[j + 1])
                    j += 2
                    continue
                if inner == '"':
                    break
                if inner in "$`":
                    unknown = True
                current.append(inner)
                j += 1
            else:
                well_formed = False
                break
            if region[j : j + 1] != '"':
                well_formed = False
                break
            i = j + 1
        elif ch == "\\" and i + 1 < n:
            current.append(region[i + 1])
            i += 2
        elif ch in "$`":
            unknown = True
            current.append(ch)
            i += 1
        elif ch in ";&|()<>":
            break  # control syntax ends the region the resolver looks at
        else:
            current.append(ch)
            i += 1
    flush_word()
    return words, well_formed


@dataclass(frozen=True)
class _FpStaticArg:
    """One cd/pushd argument the resolver could read literally."""

    value: str
    tilde_expands: bool  # the raw word began with an unquoted `~`


# A bare `cd`: no argument at all, so it goes to HOME.
_FP_BARE_CD_ARG = _FpStaticArg("", False)


def _fp_static_arg(raw: str) -> _FpStaticArg | None:
    """Unquote one cd/pushd argument to its literal path, or None when it
    cannot be resolved statically (empty, multi-word, or inexact).

    The returned value also records whether the shell would expand a leading
    `~`: it does so only when the tilde is the first character of the word as
    written, so `cd ~` and `cd ~/x` move to the home directory while `cd "~"`
    and `cd '~'` enter a directory literally named `~`."""
    if not raw or re.search(r"[$`;&|()<>#]", raw):
        return None
    words, well_formed = _fp_literal_words(raw)
    if not well_formed or len(words) != 1 or not words[0]:
        return None  # empty, multi-word, or inexact: refuse to guess
    return _FpStaticArg(words[0], raw.startswith("~"))


def _fp_command_env_value(
    name: str, command_env: dict[str, str | None] | None
) -> tuple[bool, str | None]:
    """(set, value) for `name` in the environment the child's `cd` would read.

    A command that assigns the name before the push decides the value: the
    literal it assigns, or None when that value cannot be read. A name the
    command does not assign reports (False, None), so the caller falls back to
    the environment the guard itself would spawn with."""
    if command_env is not None and name in command_env:
        return True, command_env[name]
    return False, None


def _fp_cdpath_redirects(command_env: dict[str, str | None] | None = None) -> bool:
    """True when `CDPATH` could redirect a relative `cd` target.

    A non-empty CDPATH makes the shell search other directories first for a
    relative operand, so the directory the guard would replay is not the one
    the shell enters. A command that sets CDPATH itself (`export CDPATH=/x;
    cd repo && ...`) is read from the command, not from the guard's own
    environment."""
    set_in_command, assigned = _fp_command_env_value("CDPATH", command_env)
    if set_in_command:
        return assigned is None or bool(assigned)
    try:
        return bool(_child_env().get("CDPATH"))
    except (OSError, RuntimeError, ValueError):
        return True  # cannot read the environment: refuse rather than guess


def _fp_home_directory(command_env: dict[str, str | None] | None) -> str | None:
    """The home directory the child's `cd` would use, or None when the command
    sets HOME to something the guard cannot read.

    A bare `cd` and a `~`-relative operand go to the HOME the child exports:
    `export HOME=/x; cd && git push -f origin HEAD` really enters /x, so the
    replay has to use it rather than the HOME the guard itself runs with."""
    set_in_command, assigned = _fp_command_env_value("HOME", command_env)
    if set_in_command:
        return assigned
    try:
        return os.path.expanduser("~")
    except (OSError, RuntimeError):
        return None


def _fp_resolve_cd_target(
    arg: _FpStaticArg,
    current: str | None,
    workspace: str,
    command_env: dict[str, str | None] | None = None,
) -> str | None:
    """Resolve one statically-known `cd` argument against the running
    directory (None = the kernel workspace), logical like the shell's
    default `cd -L`. Returns None when the target cannot be resolved
    statically (bare `cd` without a usable HOME, `cd -`/options, another
    user's home, a quoted `~`, or anything `CDPATH` could redirect)."""
    if not arg.value:
        # A bare `cd` goes to the home the child shell has, which is the one
        # the command exported when it sets HOME itself.
        return _fp_home_directory(command_env)
    target = arg.value
    if target.startswith("-"):
        return None  # `cd -`, `cd -L`, `cd -- ...`: not statically resolvable
    if target.startswith("~"):
        if not arg.tilde_expands:
            # Quoted or escaped: the shell keeps the literal name, so `cd "~"`
            # enters `./~` rather than the home directory.
            return os.path.join(current or workspace, target)
        if target == "~" or target.startswith("~/"):
            home = _fp_home_directory(command_env)
            if home is None:
                return None
            return home if target == "~" else os.path.join(home, target[2:])
        return None  # ~otheruser: another user's home directory
    if os.path.isabs(target):
        return target
    if not target.startswith(".") and _fp_cdpath_redirects(command_env):
        # `CDPATH` is searched for a plain relative operand (a leading `/`,
        # `.`, or `..` opts out), so the target cannot be pinned down.
        return None
    return os.path.join(current or workspace, target)


# A command run that sources a script: `source` or a standalone `.` word
# followed by what it sources, however it is reached (`eval '. move.sh'`,
# `builtin source move.sh`). A `.` inside a path (`./repo`, `../x`, `a.b`) or
# as an argument on its own (`cd .`) is not a source: `.` needs an operand.
_FP_SOURCE_COMMAND = re.compile(
    r"""(?:^|[\s;&|()'"=])(?:source|\.)[ \t]+[^\s;&|()]"""
)


def _fp_part_sources_scripts(part: str) -> bool:
    """True when one command run sources a script anywhere in it.

    The pattern catches `source x` and `. x` as written, but a quoted or
    backslash-escaped dot (`. ./setup.sh`, `"." ./setup.sh`) hides the
    whitespace the pattern needs, so the scan also looks for `source` or `.`
    in command position. A dot that is only an argument (`cd .`, `ls .`,
    `git status "."`) is not a source, and `./setup.sh` runs a child process
    that cannot relocate the shell."""
    if _FP_SOURCE_COMMAND.search(part):
        return True
    return any(
        word.value in ("source", ".") and word.starts_command
        for word in _fp_scan_words(part)
    )


def _fp_resolve_push_cwd(
    prefix: str,
    user_command_start: int,
    workspace: str,
    command_env: dict[str, str | None] | None = None,
) -> "str | None | _FpUnresolvableCwd":
    """Resolve the directory a push at the end of `prefix` runs in.

    Statically-known cd relocations earlier in the command are replayed.
    Subshell groups run in child shells, so a group that closes before the
    push never relocates it (its cds are skipped and its uncertainty dies
    with it), while an open group's cds apply to the push inside it. Anything
    that could relocate but cannot be resolved statically -- pushd/popd, cd
    with substitution or options, `source`d or `.`-sourced scripts,
    repo-relocating GIT_* assignments, or a `;`/newline whose cd success is
    unknowable at a shell depth the push still runs in -- returns
    _FP_UNRESOLVABLE_CWD so the caller refuses. Returns None when no cd
    moved the shell: the kernel workspace. `command_env` carries the HOME and
    CDPATH the command itself assigns, because those are the values the
    child's cd reads."""
    if not (
        re.search(r"\b(?:cd|pushd|popd|source)\b", prefix)
        or _fp_part_sources_scripts(prefix)
        or "(" in prefix
    ):
        return None
    current: str | None = None
    # One uncertainty frame per shell nesting depth: the top level plus each
    # open subshell group. A frame's poison (a `;`/`||`/`|` whose cd success
    # it cannot confirm) is discarded when its group closes before the push.
    open_groups: list[str | None] = []
    pending: list[bool] = [False]
    saw: list[bool] = [False]
    poisoned: list[bool] = [False]
    offset = 0
    for part in re.split(r"(&&|\|\||;|\||\n)", prefix):
        start = offset
        offset += len(part)
        if start < user_command_start:
            continue  # command-prefix region: user shell setup, not model text
        if part in ("&&", "||", ";", "|", "\n"):
            if part in (";", "\n") and pending[-1]:
                # The cd may or may not have succeeded; both outcomes leave
                # the push in a different directory the guard cannot pick.
                poisoned[-1] = True
            elif part in ("||", "|") and saw[-1]:
                poisoned[-1] = True  # cd success no longer guaranteed
            pending[-1] = False
            continue
        trimmed = part.strip()
        if not trimmed:
            continue
        if _fp_part_sources_scripts(trimmed):
            # A sourced script relocates the shell arbitrarily, and it can hide
            # behind a wrapper or inside quotes (`builtin source move.sh`,
            # `eval '. move.sh'`), so the whole command run is unresolvable.
            # `sh move.sh && ...` is NOT this case: a child shell never
            # relocates the parent.
            return _FP_UNRESOLVABLE_CWD
        if re.search(r"(^|\s)GIT_[A-Z_]+=", trimmed):
            return _FP_UNRESOLVABLE_CWD  # the assignment selects another repository
        # A paren inside quotes is data (`echo "("`), so only the unquoted
        # ones open or close a replay frame.
        opens, closes = _fp_unquoted_paren_counts(trimmed)
        if opens > 0:
            for _ in range(opens):
                # A subshell starts from a copy and tracks its own cds.
                open_groups.append(current)
                pending.append(False)
                saw.append(False)
                poisoned.append(False)
        if closes > 0:
            for _ in range(closes):
                if open_groups:
                    # The closing group's cds never relocate what follows:
                    # restore the pre-group directory and drop its frame.
                    current = open_groups.pop()
                    pending.pop()
                    saw.pop()
                    poisoned.pop()
        inside_group = len(open_groups) > 0
        if opens == closes and opens > 0:
            continue  # a complete group: its cds are inert to what follows
        if inside_group:
            body = re.sub(r"[)\s]+$", "", re.sub(r"^[\(\s]+", "", trimmed))
            cd_match = re.match(r"cd(?:\s+(.*))?$", body) or re.match(
                r"pushd\s+(.*)$", body
            )
            if not cd_match:
                if re.search(r"\b(?:cd|pushd|popd)\b", body):
                    return _FP_UNRESOLVABLE_CWD  # group content we cannot track
                pending[-1] = False
                continue
            raw_arg = cd_match.group(1)
            arg = (
                _fp_static_arg(raw_arg.strip())
                if raw_arg is not None
                else _FP_BARE_CD_ARG
            )
            if arg is None:
                return _FP_UNRESOLVABLE_CWD
            resolved = _fp_resolve_cd_target(
                arg, current, workspace, command_env
            )
            if resolved is None:
                return _FP_UNRESOLVABLE_CWD
            current = resolved
            pending[-1] = True
            saw[-1] = True
            continue
        # Brace groups run in the current shell, so a `{ cd sub && ... }`
        # relocates like a bare cd chain.
        group_free = re.sub(r"^\{\s*", "", trimmed)
        cd_match = re.match(r"cd(?:\s+(.*))?$", group_free) or re.match(
            r"pushd\s+(.*)$", group_free
        )
        if not cd_match:
            if re.search(r"\b(?:cd|pushd|popd)\b", group_free):
                # An assignment or wrapper prefix before cd (for example
                # `FOO=1 cd sub`) relocates in ways the resolver cannot replay.
                return _FP_UNRESOLVABLE_CWD
            pending[-1] = False
            continue
        raw_arg = cd_match.group(1)
        arg = (
            _fp_static_arg(raw_arg.strip())
            if raw_arg is not None
            else _FP_BARE_CD_ARG
        )
        if arg is None:
            return _FP_UNRESOLVABLE_CWD
        resolved = _fp_resolve_cd_target(arg, current, workspace, command_env)
        if resolved is None:
            return _FP_UNRESOLVABLE_CWD
        current = resolved
        pending[-1] = True
        saw[-1] = True
    if any(poisoned):
        return _FP_UNRESOLVABLE_CWD
    return current


@dataclass(frozen=True)
class _FpUpstreamInfo:
    """The current branch and its upstream, from a `git rev-parse` probe."""

    upstream_ref: str | None  # e.g. "origin/main"; None when there is none
    current_branch: str  # e.g. "feature" (or "HEAD" when detached)


# One probe answers every question the guard asks about a repository: the
# upstream ref (implicit refspecs) and the current branch (explicit `HEAD`
# refspecs). An empty first line means the branch has no upstream, which is
# not the same as "not a repository": an implicit push then takes its target
# from configuration (push.default, remote.<name>.push, remote.<name>.mirror)
# the guard cannot read.
_FP_UPSTREAM_PROBE = r"""cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 1
up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || up=
printf '%s\n%s\n' "$up" "$cur"
"""


def _fp_probe_upstream(
    cwd: str, cache: dict[str, "_FpUpstreamInfo | None"]
) -> _FpUpstreamInfo | None:
    """Probe the current branch and its upstream with `git rev-parse @{u}`.

    Returns None when the probe cannot run or the directory is not a
    repository (git itself then fails an implicit push), and an info whenever
    the probe ran inside a repository -- including a detached HEAD, reported as
    the branch `HEAD`. An info with no upstream_ref is not "nothing to
    protect": the branch (or detached HEAD) has no upstream, so an implicit
    push takes its target from configuration the guard cannot read --
    push.default=matching/current push every matching branch name and
    remote.<name>.mirror pushes everything, none of which HEAD opts out of --
    and the caller must refuse. The child shell and env match what the guarded
    command itself would see."""
    if cwd in cache:
        return cache[cwd]
    info: _FpUpstreamInfo | None = None
    try:
        completed = subprocess.run(
            [_shell(), "-c", _FP_UPSTREAM_PROBE],
            cwd=cwd,
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_FORCE_PUSH_PROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        # Fail closed: a probe that cannot answer means the guard cannot see
        # the branch an implicit refspec or HEAD would rewrite, and the
        # process it already froze the event loop waiting for must not also
        # buy the push a pass.
        raise ForcePushRefusalError(_fp_format_probe_timeout_refusal()) from None
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        info = None
    else:
        if completed.returncode == 0:
            lines = completed.stdout.decode("utf-8", errors="replace").split("\n")
            upstream_ref = lines[0] if lines else ""
            current_branch = lines[1] if len(lines) > 1 else ""
            if current_branch:
                # A detached HEAD reports "HEAD": the repository exists, so the
                # configuration behind an implicit push is still in play.
                info = _FpUpstreamInfo(upstream_ref or None, current_branch)
    cache[cwd] = info
    return info


_FP_PROTECTED_BRANCHES = ("main", "master")
# Substitution, globs, and brace expansion in a refspec: the target cannot
# be checked statically, so the guard refuses rather than guess.
_FP_GLOB_OR_SUBSTITUTION = re.compile(r"""[$`*?{}\[\]]""")
# A refspec that is entirely git's `@{...}` syntax (`@{u}`, `@{upstream}`,
# `@{-1}`): git's own short form, not a shell expansion, so it is the only
# brace-bearing word the unresolvable-argument rule spares.
_FP_STATIC_AT_BRACE = re.compile(r"@\{[A-Za-z0-9_./-]*\}")


def _fp_push_violation(
    run: _FpPushRun,
    args: _FpPushArgs,
    words: list[_FpShellWord],
    normalized: str,
    user_command_start: int,
    kernel_cwd: str,
    relocating_prefix: bool,
    probe_cache: dict[str, "_FpUpstreamInfo | None"],
) -> str | None:
    """Why this force push must be refused, or None when it may run."""
    if run.unresolvable_alias:
        return _fp_format_alias_refusal()
    # The HOME and CDPATH the child's own `cd` commands would read: the
    # assignments made before the command run the push is part of, because the
    # push's own prefix assignments land after those cds ran.
    env_limit = next(
        (
            index
            for index in range(run.git_index - 1, -1, -1)
            if words[index].starts_command
        ),
        run.git_index,
    )
    command_env = _fp_cd_environment(words, env_limit)
    force = args.force or any(spec.startswith("+") for spec in args.refspecs)
    if args.unresolvable is not None:
        # Before the dry-run check: an expansion can add `--no-dry-run`, so a
        # visible dry run does not defang an argument the guard cannot read.
        return _fp_format_refusal(
            f'the push argument "{args.unresolvable}" cannot be verified'
            " statically: the shell may expand it into a force flag or into a"
            " refspec naming a protected branch before git reads argv"
        )
    if args.dry_run:
        return None  # a visible dry run changes nothing
    if not force:
        return None
    git_start = words[run.git_index].start
    in_prefix = git_start < user_command_start
    if args.wildcard:
        return _fp_format_refusal(
            "a force flag with --all/--mirror rewrites every branch, including"
            " main/master and the current upstream"
        )
    if run.xargs_fed:
        return _fp_format_refusal(
            "xargs feeds it refspecs from stdin the guard cannot see"
        )
    if args.refspecs:
        for refspec in args.refspecs:
            body = refspec[1:] if refspec.startswith("+") else refspec
            if ":" in body:
                src, dst = body.split(":", 1)
                if src and dst:
                    target = dst  # the remote side is the ref being rewritten
                elif dst and not src:
                    target = dst  # `:dst` deletes dst
                elif src and not dst:
                    target = src  # `src:` deletes src: conservatively protected
                else:
                    return _fp_format_refusal(
                        'the refspec ":" deletes every branch on the remote'
                    )
            else:
                target = body
            if not target:
                continue  # an empty refspec word errors at git level anyway
            if _FP_GLOB_OR_SUBSTITUTION.search(target):
                return _fp_format_refusal(
                    f'the push target "{target}" cannot be verified statically'
                    " (glob, substitution, or variable)"
                )
            if target.startswith("@{"):
                return _fp_format_refusal(
                    f'the refspec "{refspec}" names the current upstream'
                )
            for prefix in ("refs/heads/", "heads/"):
                # git accepts the short `heads/main` spelling for the same
                # destination, so a force push to it rewrites the branch.
                if target.startswith(prefix):
                    target = target[len(prefix) :]
                    break
            if target in _FP_PROTECTED_BRANCHES:
                return _fp_format_refusal(
                    f'it would force-push "{target}"'
                )
            if target in ("HEAD", "@"):
                # `@` is git's own synonym for HEAD, so `git push -f origin @`
                # force-updates the current branch exactly like `... origin
                # HEAD` does (verified: it reports `HEAD -> main`).
                if run.relocated or in_prefix or relocating_prefix:
                    return _fp_format_relocation_refusal()
                cwd = _fp_resolve_push_cwd(
                    normalized[:git_start], user_command_start, kernel_cwd, command_env
                )
                if cwd is _FP_UNRESOLVABLE_CWD:
                    return _fp_format_relocation_refusal()
                resolved_cwd = kernel_cwd if cwd is None else cwd
                probed = _fp_probe_upstream(resolved_cwd, probe_cache)
                if probed is not None and probed.current_branch in _FP_PROTECTED_BRANCHES:
                    return _fp_format_refusal(
                        f'HEAD names the current branch "{probed.current_branch}"'
                    )
        return None
    # Implicit refspec: push.default makes the current upstream the target,
    # so the guard probes it (the spec's `rev-parse @{u}`).
    if in_prefix:
        return _fp_format_refusal(
            "the configured command prefix force-pushes without a refspec, so"
            " the target cannot be verified"
        )
    if run.relocated:
        return _fp_format_relocation_refusal()
    if relocating_prefix:
        return _fp_format_relocation_refusal()
    cwd = _fp_resolve_push_cwd(
        normalized[:git_start], user_command_start, kernel_cwd, command_env
    )
    if cwd is _FP_UNRESOLVABLE_CWD:
        return _fp_format_relocation_refusal()
    resolved_cwd = kernel_cwd if cwd is None else cwd
    probed = _fp_probe_upstream(resolved_cwd, probe_cache)
    if probed is None:
        return None  # not a repository: fail open, git errors on its own
    if probed.upstream_ref is None:
        return _fp_format_refusal(
            "without a refspec, and with no upstream on the current branch"
            f' "{probed.current_branch}", the push target comes from'
            " push.default, remote.<name>.push, or remote.<name>.mirror"
            " configuration the guard cannot read"
        )
    return _fp_format_refusal(
        "without a refspec it would force-push the current branch onto its"
        f' upstream "{probed.upstream_ref}"'
    )


def _fp_format_refusal(reason: str) -> str:
    lines = [
        f"Refusing to run this force-push command: {reason}.",
        "",
        "Force-pushes rewrite remote history; a force-push to main/master or"
        " the current upstream can discard other people's work in one step.",
        "",
        "Use --force-with-lease instead: it refuses to overwrite unless the"
        " remote ref still matches what you have.",
        "",
        "To force-push anyway, retry with"
        " bash(command, allow_force_push=True), or start the kernel with"
        f" {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
    ]
    return "\n".join(lines)


def _fp_format_relocation_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: it changes directory (or"
            " relocates the repository) first, and the branch it would"
            " rewrite cannot be determined safely.",
            "",
            "Run it as its own command from the target directory, or retry"
            " with bash(command, allow_force_push=True), or start the kernel"
            f" with {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_eval_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: it wraps a force-push"
            " in eval, and the target it would rewrite cannot be resolved"
            " safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_force_push=True), or start the kernel with"
            f" {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_nesting_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: its command substitutions"
            f" nest more than {_FP_MAX_SUBSTITUTION_DEPTH} levels deep, which"
            " the guard does not follow, so what it runs cannot be verified.",
            "",
            "Flatten the substitutions (or run the inner command directly), or"
            " retry with bash(command, allow_force_push=True), or start the"
            f" kernel with {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_scan_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: its command substitutions"
            " nest too deeply for the guard's scan budget, so the guard cannot"
            " verify what it would run.",
            "",
            "Flatten the substitutions (or run the inner command directly), or"
            " retry with bash(command, allow_force_push=True), or start the"
            f" kernel with {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_shell_c_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: it runs a force-push"
            " inside a quoted `sh -c` payload whose target cannot be"
            " resolved safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_force_push=True), or start the kernel with"
            f" {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_alias_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: it defines a git alias"
            " (`-c alias.X=...`) for the subcommand it invokes, and the argv"
            " that alias expands to cannot be resolved safely.",
            "",
            "Run the push directly with the aliased name spelled out, or retry"
            " with bash(command, allow_force_push=True), or start the kernel"
            f" with {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_git_subcommand_refusal(subcommand: str) -> str:
    return "\n".join(
        [
            f"Refusing to run this git command: `{subcommand}` is outside the"
            " git command set this guard was calibrated against (Apple git"
            " 2.50.1 and Homebrew git 2.55.0), so it is a repository or user"
            " alias, or an external `git-` program, or a command only a newer"
            " git knows: the guard cannot verify what it runs. An alias can"
            " force-push a protected branch, which is why an unknown name is"
            " refused even when it looks harmless.",
            "",
            f"Spell out the real subcommand, or run the underlying program"
            f" (for `{subcommand}`) directly. To run this command as written,"
            " retry with bash(command, allow_force_push=True), or start the"
            f" kernel with {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_env_option_refusal(option: str) -> str:
    return _fp_format_refusal(
        f'the env option "{option}" is an abbreviation that matches more than'
        " one of env's long options, so the guard cannot tell whether it takes"
        " a value and which word it hands env"
    )


def _fp_format_config_option_refusal(operand: str) -> str:
    return _fp_format_refusal(
        f'its inline config operand "{operand}" cannot be read statically, so'
        " the configuration it applies -- which can arm a force push through"
        " remote.<name>.push or remote.<name>.mirror -- cannot be checked"
    )


def _fp_format_env_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: it runs a force-push"
            " inside an `env -S`/`--split-string` payload whose target cannot"
            " be resolved safely.",
            "",
            "Run it directly, or retry with"
            " bash(command, allow_force_push=True), or start the kernel with"
            f" {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_format_probe_timeout_refusal() -> str:
    return "\n".join(
        [
            "Refusing to run this force-push command: resolving the branch it"
            " would rewrite timed out (a `git rev-parse` probe the guard runs"
            " before spawning anything), so the target cannot be determined"
            " safely.",
            "",
            "Retry the command, or retry with"
            " bash(command, allow_force_push=True), or start the kernel with"
            f" {BASH_FORCE_PUSH_BYPASS_ENV}=1.",
        ]
    )


def _fp_warn_once_about_late_force_push_bypass() -> None:
    """Warn (once) when the bypass env var appears mid-session.

    The frozen launch-time copy is the only honored bypass, so a value that
    shows up later is ignored; one os.environ write cannot unlock the guard.
    Warn loudly so a deliberate bypass takes the documented path (restart
    the kernel with the variable set) instead of looking like a no-op."""
    global _force_push_late_bypass_warned
    if _force_push_late_bypass_warned:
        return
    value = os.environ.get(BASH_FORCE_PUSH_BYPASS_ENV)
    if value is None or value in ("", "0"):
        return
    _force_push_late_bypass_warned = True
    print(
        f"prime-agent bash: {BASH_FORCE_PUSH_BYPASS_ENV} appeared after"
        " kernel start and is ignored; the force-push guard only honors it"
        " when the kernel is started with it set.",
        file=sys.stderr,
        flush=True,
    )


def _guard_force_push(
    command: str, allow_force_push: bool, command_prefix: str | None = None
) -> None:
    """Refuse force-pushes (`git push --force`, `-f`, `+`-refspecs) whose
    target is protected: a refspec naming main/master or `@{u}`, or the
    current upstream (probed with `git rev-parse @{u}`) when the refspec is
    implicit; a branch with no upstream counts as unresolvable and is refused
    with it. Pattern matching is string-only; the upstream probe runs only on
    a match, so plain pushes pay nothing. A literal `--force-with-lease` or
    `--force-if-includes` is never refused, but an unresolvable push argument
    is refused regardless of them: it can expand to `-f`, which skips the
    lease compare-and-swap (measured on git 2.55: a bare `--force-with-lease`
    over a stale remote-tracking ref is rejected as `stale info`, while
    `--force-with-lease -f` and `--force-with-lease origin +main` rewrite the
    ref).

    `command` is the full script text the spawn runs unless `command_prefix`
    is None, in which case the prefix is read and joined here; bash() pins
    both so one environment read is shared between the scan and the spawn."""
    if allow_force_push or _FORCE_PUSH_BYPASS_AT_KERNEL_START:
        return
    if command_prefix is None:
        command_prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
        command = _with_prefix(command, command_prefix)
    global _active_scan_budget
    previous_budget = _active_scan_budget
    _active_scan_budget = _FpScanBudget(len(command))
    try:
        _fp_guard_force_push(command, command_prefix)
    except _FpNestingTooDeep:
        raise ForcePushRefusalError(_fp_format_nesting_refusal()) from None
    except _FpScanLimitExceeded:
        # The guard could not finish scanning: refuse rather than allow
        # something it never verified.
        raise ForcePushRefusalError(_fp_format_scan_refusal()) from None
    finally:
        _active_scan_budget = previous_budget


def _fp_guard_force_push(command: str, command_prefix: str | None = None) -> None:
    """The scan behind `_guard_force_push`, run under its work budget.

    `command` is the full script text (prefix included) the spawn runs, and
    `command_prefix` is the prefix the caller already read for it, so the
    guard never re-reads the environment the spawn could disagree with."""
    command_text = command
    resolved = _fp_mask_redirections(_fp_normalize_continuations(command_text))
    normalized, index_map = _fp_strip_escapes(resolved)
    # The cheap gates scan `normalized` with quotes intact: a quoted command
    # word (`"eval"`, `"bash"`) still executes, so quote-aware masking must
    # not blind them.
    if re.search(r"\beval\b", normalized) and _fp_eval_payloads_hide_force_push(resolved):
        # An eval payload hides where the push runs; refuse rather than
        # resolve a command the guard cannot see.
        raise ForcePushRefusalError(_fp_format_eval_refusal())
    if _FP_SHELL_INTERPRETER_GATE.search(normalized) and (
        _fp_shell_c_payloads_hide_force_push(resolved)
    ):
        # `SH -c '...'` runs a real shell on a case-insensitive filesystem.
        raise ForcePushRefusalError(_fp_format_shell_c_refusal())
    if re.search(r"\benv\b", normalized, re.IGNORECASE) and (
        _fp_env_payloads_hide_force_push(resolved)
    ):
        # `env -S` splits one word into the argv git receives; refuse rather
        # than resolve a command the guard cannot see.
        raise ForcePushRefusalError(_fp_format_env_refusal())
    trailing_backslashes = len(command_text) - len(command_text.rstrip("\\"))
    if trailing_backslashes % 2 and re.search(r"\bgit\b", normalized, re.IGNORECASE):
        # An odd trailing backslash escapes the newline the kernel appends
        # after the command, so the shell joins it with text the guard cannot
        # see. Refuse rather than guess where the command ends.
        raise ForcePushRefusalError(
            _fp_format_refusal(
                "it ends with a line continuation, so the shell joins it with"
                " the text that follows in the script the kernel runs"
            )
        )
    words = _fp_scan_words(normalized)
    ambiguous_env_option = _fp_ambiguous_env_option(words)
    if ambiguous_env_option is not None and _fp_force_push_pattern_in_text(
        _fp_flattened_text(words)
    ):
        # An ambiguous env long option is refused the way env refuses it, and
        # only next to a force-push pattern: the guard cannot tell whether the
        # option takes a value, so it cannot read the invocation either.
        raise ForcePushRefusalError(
            _fp_format_env_option_refusal(ambiguous_env_option)
        )
    # The conduit scan reads the text before redirection masking: `<<<` and
    # `<` are exactly what a masker removes, and they are the point here.
    family_reason = _fp_family_violation(words, command_text, normalized)
    if family_reason is not None:
        raise ForcePushRefusalError(_fp_format_refusal(family_reason))
    if _fp_unresolvable_command_word_hides_force_push(words, normalized):
        raise ForcePushRefusalError(
            _fp_format_refusal(
                "its command word is a shell or brace expansion, and the same"
                " command line carries a force-push pattern the guard cannot"
                " attribute to a command it can see"
            )
        )
    unresolvable_subcommand = _fp_unresolvable_git_subcommand(words)
    if unresolvable_subcommand is not None:
        # A subcommand git does not know is a repository alias or an external
        # `git-<name>` program: the guard cannot see what it runs.
        raise ForcePushRefusalError(
            _fp_format_git_subcommand_refusal(unresolvable_subcommand)
        )
    runs = _fp_find_git_push_runs(words)
    if runs:
        for run in runs:
            unreadable_config = _fp_unreadable_inline_config(run, words)
            if unreadable_config is not None:
                raise ForcePushRefusalError(unreadable_config)
        if _fp_mirror_or_push_refspec_configured(words):
            # The push looks plain in argv, but the same command writes config
            # that makes git force it, so argv alone cannot judge the push.
            raise ForcePushRefusalError(_fp_mirror_config_refusal())
    guarded: list[tuple[_FpPushRun, _FpPushArgs]] = []
    for run in runs:
        args = _fp_parse_push_args(run.tokens, run.push_index)
        if run.unresolvable_alias or _fp_is_guarded_push(args):
            guarded.append((run, args))
    if not guarded:
        return
    _fp_warn_once_about_late_force_push_bypass()
    try:
        kernel_cwd = os.getcwd()
    except OSError:
        return  # the spawn itself will fail; the guard must not mask that error
    prefix_end = len(command_prefix) + 1 if command_prefix else 0
    if command_prefix:
        user_command_start = next(
            (i for i, orig in enumerate(index_map) if orig >= prefix_end),
            len(normalized),
        )
    else:
        user_command_start = 0
    # A GIT_DIR/GIT_WORK_TREE/... assignment in the prefix relocates the
    # repository every later command runs in, exactly like a cd relocates the
    # directory, so both count (the adjacent-`export` shape is already caught
    # by the invocation walk; this covers the rest of the prefix).
    relocating_prefix = bool(
        command_prefix
        and re.search(
            r"\b(?:cd|pushd|popd)\b|GIT_[A-Z_]+=", command_prefix
        )
    )
    probe_cache: dict[str, "_FpUpstreamInfo | None"] = {}
    for run, args in guarded:
        violation = _fp_push_violation(
            run,
            args,
            words,
            normalized,
            user_command_start,
            kernel_cwd,
            relocating_prefix,
            probe_cache,
        )
        if violation is not None:
            raise ForcePushRefusalError(violation)

# Secret-echo guard (wave-1 safety audit gap 5). Kernel bash output is echoed
# into the transcript, so whatever a command prints there persists in session
# logs that models and users read later. Two shapes leak secrets that way: a
# bare environment dump, and a `cat`/`echo` of a known secret file under the
# user's home (only those two readers are modeled). Detection is one string
# scan of the command text -- two length-preserving mask passes, a segment
# split, a here-document line pass, a shell-faithful word split of each
# segment, and a substitution walk -- with no filesystem access and no operand
# resolution, so an ordinary command pays for that scan and nothing else, and
# its cost stays proportional to the length of the command even for a command
# built out of thousands of openers.
#
# Exact rule set:
#   * a command segment whose command word is `env` or `printenv` with nothing
#     but flags after it (`env`, `env -0`, `printenv -i`), or `export` with a
#     `-p` flag and no variable name, is a full-environment dump. Leading
#     `FOO=1` assignment words are stripped first (`FOO=1 env` is a bare dump
#     in disguise), redirection words are dropped because they never narrow
#     what is printed (`env 2>/dev/null` still reaches the transcript, and a
#     glued `env>&2` puts the dump on the stream the kernel merges into the
#     transcript), and the command word is read the way the shell builds
#     words, so `"env"`, `$'env'` (ANSI-C quoting), and `$"env"` (locale
#     quoting) still count, the operand of `-S`/`--split-string` is read as the
#     command line it is (`env -S 'env -0'` dumps, `env -S 'printenv HOME'`
#     prints that one variable, and an operand that splits to nothing leaves a
#     bare `env` and fails closed), and the re-test of that operand is
#     depth-bounded, so a chain nested past _DUMP_NESTING_LIMIT answers as a
#     dump rather than raising out of the guard;
#   * the same dump piped into `grep` for one fixed string is the targeted
#     read the refusal message suggests, so that one filtered form is allowed,
#     but only while the dump really feeds the pipe: a redirect that moves fd 1
#     onto fd 2 (`env >&2 | grep KEY`) puts the whole dump in the transcript
#     and leaves grep nothing to filter, a redirect into a file (`env >log |
#     grep KEY`, `env &>log`) leaves grep the same nothing, while `>&1` and
#     `2>&1` keep feeding it. The descriptor is read after quote removal, so a
#     masked one
#     (`env >&"2"`, `env >&\2`) moves fd 1 too, and any target that is not a
#     plain unquoted digit run counts as moving it (fail closed). An inverted
#     (`-v`) or file-supplied (`-f`) pattern, a context-widening flag (`-A`,
#     `-B`, `-C`, or the bare-number `-2` spelling, in a cluster too: `-10i`,
#     `-i2`, `-F2`; a digit run directly after an `m` is that flag's own bound
#     instead, so `-m1`, the spaced `-m 1`, and `-im1` stay bounded, unless the
#     count is zero, which prints the whole dump here), an abbreviated long flag
#     (`--cont=2`), more than one operand, or a pattern with regex
#     metacharacters (`grep .`) is not provably a bounded filter, so it is
#     refused, and a `--` word ends the options the way grep reads it, so the
#     `-v` of `grep -- -v` is the pattern rather than the inversion flag
#     (`grep -- -v KEY` is two operands and stays refused);
#   * a `cat`/`echo` segment naming `~/.ssh`, `~/.gnupg`, or `~/.aws` -- each a
#     directory, so the rule holds on it however the file inside is spelled --
#     in the `~` spelling (expands only unquoted) or the
#     `$HOME`/`${HOME}` spelling (expands unquoted and inside double quotes,
#     and matches with a closing double quote between the two: `cat
#     "$HOME"/.ssh/id_rsa`), is a secret-file read. Both spellings are read from
#     the word the shell builds, so a quote in the middle of the path does not
#     hide it (`cat ~/".ssh"/id_rsa` and `cat $HOME/".ssh"/id_rsa` read the key,
#     `$HOME/".ssh"/id_rsa` from `cat "$HOME""/.ssh/id_rsa"` too), while a `~`
#     the shell never expands stays the literal text it is: it has to be the
#     first character of the word and the next character has to be the `/` of a
#     path, read from the command text rather than from the mask, so
#     `cat "~/.ssh/id_rsa"`, `cat '~'/.ssh/id_rsa`, and `cat ~'/'.ssh/id_rsa`
#     are text while `cat ~/'/'.ssh/id_rsa` reads the key; a `$HOME` has to be
#     live in the mask that leaves double quotes live, so `cat '$HOME/.ssh/id_rsa'`
#     is the text it is. A command word that runs a reader as its own command
#     line is read the same way (`env cat ~/.ssh/id_rsa` refuses, while
#     `env head ~/.ssh/id_rsa` names a reader this scan does not model), and the
#     `-S`/`--split-string` operand of that form is read for the `${VARNAME}`
#     spelling `env` expands inside it (`env -S 'cat ${HOME}/.ssh/id_rsa'`
#     refuses) while a `~` there stays literal text and reads nothing;
#   * a command substitution runs another command, so the interior of every
#     `$(...)` and backtick span is scanned the same way, including the ones a
#     double quote hides (`echo "$(env)"`); interiors are scanned from a
#     worklist, so depth costs time rather than a RecursionError, and only the
#     outermost span of a nest is queued because its interior carries the ones
#     inside it. `$((` opens an arithmetic expansion instead, which runs
#     nothing, so it is not one of these (`echo $((env))` is the number the
#     arithmetic reads) while a substitution inside arithmetic still is
#     (`echo $(( $(env) ))` runs env). That reading holds only when the two `)`
#     closing the `$((` are adjacent, because bash reads `echo $((env) )` as
#     `$( ( env ) )`, a subshell that runs env and prints the whole
#     environment, so a `$((` whose closers are not adjacent is a command
#     substitution whose interior this same walk scans. The parentheses of an
#     expansion are syntax rather than separators, so a segment never splits
#     inside one: the interior only ever reaches the scan through this walk,
#     which is what the quoted, arithmetic, and subshell spellings all rely on;
#   * the body of a here-document is never shell input, so every body line is
#     skipped by the word checks, quoted delimiter or not: `cat <<EOF` and
#     `cat <<'EOF'` with `env` on a body line both print the text `env`. An
#     unquoted delimiter still expands command substitutions in its body, so
#     those bodies stay in the substitution walk (`cat <<EOF` with `$(env)` is
#     still refused), the line that closes a body is skipped by that walk as
#     well because it is the syntax that ends the body and expands nothing
#     (`cat <<'$(env)'` with `$(env)` on the closing line prints one word), and
#     a `<<` inside quotes is data rather than an operator
#     (`echo "a <<'EOF' b"`). That closing line is still read by the word
#     checks, so a body closed by a dump word (`cat <<'env'`) stays refused.
# Single-quoted spans and comments are literal data, so they are masked before
# the scan (see _mask_literals), which also masks the pair a backslash makes
# literal (an escaped `$HOME` prints as text instead of expanding); the
# substitution walk reads comments the same way, so `echo hi # $(env)` prints
# `hi` and runs nothing. Quoted
# command words still run the command, so the word split builds them the
# shell's way (see _shell_words); quoted operands stay single words
# (`env 'foo&bar'` is an executor form, `"env -0"` is not a command name).
# Deliberately not matched: a `.env`-class file in the workspace, a directory
# listing, a one-variable read, quoted data, and every other command the
# patterns do not name.
# `env -u FOO` and `env FOO=1` with no command word dump the environment too,
# but telling them apart from the executor forms (`env -u FOO cmd`, `env FOO=1
# cmd`) needs flag-arity knowledge this foot-gun guard does not model.
# Out of the modeled set for the same reason: a command word the scan cannot
# resolve (a path such as `/usr/bin/env`, a wrapper such as `command`, `eval`,
# `time`, or `!`, a brace group, or an expansion such as `${x:-env}`) and a
# reader other than `cat`/`echo` (`head -c 20 ~/.ssh/id_rsa`, `sed`, `grep`).
# The secret-path rule names the directories (`.ssh`, `.gnupg`) rather than the
# files in them, so it also refuses a `cat` of a file there that holds no key
# (`cat ~/.ssh/config`, `~/.ssh/known_hosts`, `~/.ssh/id_rsa.pub`) and it
# refuses a path whether or not it exists: it is a foot-gun guard on the shape
# of the command, not a sandbox and not a content check. This guard stops the
# ordinary foot-gun; it is not a sandbox.

# Bypass env var for the secret-echo guard.
BASH_SECRET_ECHO_BYPASS_ENV = "PI_BASH_ALLOW_SECRET_ECHO"

# The bypass env var is honored only when present at kernel start: the model
# can write os.environ, so a live read on each guard call would let a single
# os.environ assignment neuter the guard. The frozen copy cannot change after
# import; a value that appears mid-session only triggers a loud warning and
# is ignored.
_SECRET_ECHO_BYPASS_AT_KERNEL_START = os.environ.get(
    BASH_SECRET_ECHO_BYPASS_ENV
) not in (None, "", "0")

_secret_echo_late_bypass_warned = False


class SecretEchoRefusalError(RuntimeError):
    """A command that would echo secrets into the transcript was refused."""


# Secret paths under the user's home: private keys and credential stores. Each
# name is a directory, so the rule holds on it however the path to the file
# inside is spelled (`~/.aws//credentials`, `~/.aws/./credentials`,
# `~/.aws/cred*`), and the trailing lookahead keeps a longer name (`.sshfoo`,
# `.awsrc`) from matching.
_SECRET_HOME_NAME = r"(?:\.ssh|\.gnupg|\.aws)(?![\w.-])"
_SECRET_HOME_PATH = r"/(?:" + _SECRET_HOME_NAME + r")"
_TILDE_SECRET_PATH_RE = re.compile(r"~" + _SECRET_HOME_PATH)
# A double-quoted `$HOME` may close its quote before the path
# (`cat "$HOME"/.ssh/id_rsa`), so one optional `"` may sit between the two.
_HOME_VAR_SECRET_PATH_RE = re.compile(r"\$\{?HOME\}?\"?(?:" + _SECRET_HOME_PATH + r")")
# The same two rules read from the word the shell builds, where the quotes are
# gone and a run of slashes is one slash to the kernel: `cat ~/'/'.ssh/id_rsa`
# and `cat $HOME//.ssh/id_rsa` name the same key the single-slash spellings do.
_TILDE_WORD_SECRET_PATH_RE = re.compile(r"~/+(?:" + _SECRET_HOME_NAME + r")")
_HOME_VAR_WORD_SECRET_PATH_RE = re.compile(
    r"\$\{?HOME\}?/+(?:" + _SECRET_HOME_NAME + r")"
)
# A `$HOME` the mask leaves live: it expands unquoted and inside double quotes,
# so the mask that leaves double quotes live is the one to test.
_LIVE_HOME_VAR_RE = re.compile(r"\$\{?HOME\}?")

# Characters that end one command segment and start the next.
_SEGMENT_SEPARATORS = ";|&()\n"

# The characters a backslash escapes inside a double quote. POSIX lists the
# rest as literal, so `"\q"` keeps its backslash while `"\$HOME"` hides the
# `$` the way the shell does. A newline is on the list because a backslash
# before it is a line continuation.
_DOUBLE_QUOTE_ESCAPES = "$`\"\\\n"

# The here-document operators: `<<` opens a body and `<<-` strips the leading
# tabs from the lines in it. Three `<` (a here-string) or one `<` (a file
# redirect) opens no body.
_HEREDOC_OPERATOR = "<<"
_HEREDOC_TAB_STRIP = "-"

# An arithmetic command (`(( ... ))`, `$(( ... ))`, or the deprecated
# `$[ ... ]`) turns `<<` into a shift, so a `<<` after one of these markers on
# the same line opens no here-document body.
_ARITHMETIC_OPENS = ("((", "$[")

# Commands that print a whole environment when given no other word.
_DUMP_COMMANDS = ("env", "printenv")

# How deep the `env -S` operand re-test follows nested command lines before it
# answers as a dump: a chain deeper than this is not a shape a caller writes by
# hand, and the bound keeps that chain from raising RecursionError out of
# bash() (fail closed, and the measured answer for that shape is a refusal).
_DUMP_NESTING_LIMIT = 16

# The longest digit run a shell descriptor can name: a longer run is not a
# descriptor this scan can read, so it fails closed instead of being converted.
_MAX_DESCRIPTOR_DIGITS = 9

# `env` flags whose next word is that flag's operand rather than a command, and
# the flags whose operand is a command line of its own.
_ENV_OPERAND_FLAGS = ("-u", "--unset", "-C", "--chdir")
_ENV_SPLIT_FLAGS = ("-S", "--split-string")

# Commands whose operands the scan reads for a secret path.
_SECRET_READ_COMMANDS = ("cat", "echo")

# The pipe target that turns a bare dump into a targeted read.
_TARGETED_READ_COMMAND = "grep"

# POSIX `FOO=1` prefix words: the shell runs the rest of the command with
# those variables bound, so `FOO=1 env` is a bare dump in disguise.
_ASSIGNMENT_WORD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# The `{name}` spelling of a descriptor: the shell opens a new descriptor and
# stores its number in the variable, so it never acts on fd 1.
_BRACE_DESCRIPTOR_RE = re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*\}")

# Redirection words: they change where output goes, never what is printed, so
# they are dropped before the bare-dump check. The optional digits name the
# redirected descriptor (`2>`), and `&>>`/`>&`/`&>` cover the both-stream
# spellings. A `{name}` descriptor takes the operators that name one and not
# the both-stream spellings, where the shell reads `{name}` as an operand.
_REDIRECT_WORD_RE = re.compile(
    rf"^(\d*)(&>>|>&|>>|<<|<>|<|>|&>)|^({_BRACE_DESCRIPTOR_RE.pattern})(>&|>>|<<|<>|<|>)"
)

# Shell metacharacters: the only characters that may sit between a descriptor
# and the operator that uses it. `2>&1` redirects fd 2, while the `2` of
# `a2>&2` belongs to that word and the redirection applies to the default fd 1.
_SHELL_METACHARACTERS = "|&;()<> \t\n"

# Characters that end a word: the ones a descriptor must stop at (`>&2x` is a
# file called `2x`, not fd 2) and the boundary a `#` needs to start a comment.
# A `#` right after a redirect operator starts one in the shell too
# (`printf x >#b` is a syntax error, not a file called `#b`); the mask's own
# boundary set leaves the redirect characters out, which only keeps more text
# live for the patterns and segments that read it.
_WORD_BREAKERS = " \t\n;&|(){}<>"

# A grep pattern containing any of these is a regex, and a regex is not
# provably a bounded filter (`grep .` passes every line). A backtick is on the
# list because a pattern built by one is a command's output, not a fixed
# string the scan can read.
_GREP_PATTERN_METACHARS = set(".*[](){}^$\\|?+`")

# Short grep flag letters that make the output unbounded: `-v` inverts the
# filter, `-f` loads patterns from a file, `-A`/`-B`/`-C` widen every match
# with context lines, and `-z` reads the input as NUL-delimited records, which
# turns a whole newline-separated dump into one record that any pattern in it
# matches (whole environment printed for `env | grep -z PATH`). Case matters:
# `-F` (fixed strings), `-V` (version), and `-a`/`-b`/`-c`
# (text/byte-offset/count) stay bounded.
_GREP_UNBOUNDED_FLAG_LETTERS = "vfABCz"

# The one short flag whose digit run is its own bound: `-m1` is
# `--max-count=1`, which caps the output, so its digits are not context. The
# long spelling takes its value glued or as the next word. An all-zero count is
# not a bound on this platform (`-m0` prints the whole dump), so it widens.
_GREP_MAX_COUNT_LETTER = "m"
_GREP_MAX_COUNT_LONG_FLAG = "--max-count"

# The flag that supplies the pattern itself. Grep reads a glued value as that
# pattern (`--regexp=.` and `-e.` both grep for every line), so the pattern is
# not a word this scan read and every word after it is a FILE operand instead:
# `grep --regexp=. /dev/stdin` prints the whole piped dump, because `/dev/stdin`
# is that dump and `.` matches every line of it. A spaced value (`-e PATH`) stays
# the single word the bounded-filter test already reads as the pattern, so only
# the glued spellings are unreadable here.
_GREP_PATTERN_LETTER = "e"
_GREP_PATTERN_LONG_FLAG = "--regexp"

# Long grep flags with the same problem: inversion, patterns from a file, and
# context lines around every match. They are spelled in full because grep
# accepts any unambiguous prefix of an option name, so a `--` word is refused
# when it is a prefix of one of these names (`--cont=2`, `--after-c=2`).
_GREP_UNBOUNDED_LONG_FLAGS = (
    "--invert-match",
    "--file",
    "--after-context",
    "--before-context",
    "--context",
    "--null-data",
)


def _mask_literals(command: str, *, double_quotes: bool) -> str:
    """Blank out the spans the shell treats as literal data, length-preserving.

    Single-quoted spans never expand, and a `#` at a word boundary starts a
    comment that runs to end of line, so both are always masked. A double
    quote expands `$HOME` but not `~`, so the caller masks double-quoted spans
    for the `~` pattern and leaves them live for the `$HOME` pattern. Outside
    quotes a backslash makes the next character literal, so it masks its pair
    too, and walking the pairs keeps the parity right: in a doubled backslash
    the second one escapes the first, so the `$` after them stays live and
    expands. Inside a double quote only the escapes the shell honors mask
    their pair, which is what hides the `$` of an escaped `$HOME` there. Only
    the masked characters are blanked, so the result keeps the length and the
    character indices of the command the shell runs.
    """
    chars = list(command)
    n = len(chars)
    i = 0
    while i < n:
        ch = chars[i]
        if ch == "'" or (ch == '"' and double_quotes):
            quote = ch
            j = i + 1
            while j < n and chars[j] != quote:
                # A backslash escapes the next character inside double quotes only.
                j += 2 if quote == '"' and chars[j] == "\\" else 1
            for k in range(i + 1, min(j, n)):
                chars[k] = " "
            i = j + 1
        elif ch == '"':
            # This walk leaves the double-quoted interior live for the `$HOME`
            # pattern, so only an honored escape blanks its pair; any other
            # `\X` stays two literal characters, as the shell reads it.
            i += 1
            while i < n and chars[i] != '"':
                if chars[i] == "\\":
                    if i + 1 < n and chars[i + 1] in _DOUBLE_QUOTE_ESCAPES:
                        chars[i] = " "
                        chars[i + 1] = " "
                    i += 2
                    continue
                i += 1
            i += 1
        elif ch == "\\":
            chars[i] = " "
            if i + 1 < n:
                chars[i + 1] = " "
            i += 2
        elif ch == "#" and (i == 0 or chars[i - 1] in " \t\n;&|(){}"):
            while i < n and chars[i] != "\n":
                chars[i] = " "
                i += 1
        else:
            i += 1
    return "".join(chars)


def _command_segments(masked: str) -> list[tuple[int, int, str]]:
    """(start, end, separating character) for each command segment.

    Segments split on unquoted `;`, `&`, `|`, `(`, `)`, and newlines, so the
    scan never reads the command word of one segment together with an operand
    from another. The separating character is returned so the caller can tell
    a bare dump piped into grep from a bare dump. An `&` glued to a `>` is a
    redirect spelling (`2>&1`, `>&2`, `&>`), not a background operator, so it
    does not split: `env 2>&1 | grep PATH` stays one dump piped into grep.

    A `$(` expansion is skipped whole, because its parentheses are syntax
    rather than separators: the text inside runs as a command of its own, which
    the substitution walk reads (`echo "$(env)"` still refuses, and so does the
    subshell `echo $((env) )`), while the arithmetic spelling runs nothing at
    all, so `echo $((env))` is one segment whose words name no command. An
    expansion that never closes is a syntax error in the shell, so its `(` stays
    a separator there and the text after it is read as segments (fail closed).
    """
    segments: list[tuple[int, int, str]] = []
    start = 0
    index = 0
    n = len(masked)
    matches: dict[int, int] | None = None
    while index < n:
        char = masked[index]
        if char == "$" and masked[index + 1 : index + 2] == "(":
            if matches is None:
                # The matching paren of every `(`, for the one lookup per
                # expansion this walk needs; a command holding none pays for
                # neither this pass nor the lookups.
                matches = _paren_matches(masked)
            close_index = matches.get(index + 1, -1)
            if close_index >= 0:
                index = close_index + 1
                continue
        is_redirect_amp = char == "&" and (
            (index > 0 and masked[index - 1] == ">")
            or (index + 1 < n and masked[index + 1] == ">")
        )
        if char in _SEGMENT_SEPARATORS and not is_redirect_amp:
            segments.append((start, index, char))
            start = index + 1
        index += 1
    segments.append((start, n, ""))
    return segments


# Escapes a `$'...'` span decodes to one character. The rest of bash's list
# (`\nnn`, `\xHH`, `\uXXXX`, `\cX`) needs a parse, and an escape bash does not
# know keeps its backslash.
_HEX_DIGITS = "0123456789abcdefABCDEF"
_ANSI_C_SIMPLE_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
}


def _ansi_c_escape(command: str, index: int, end: int) -> tuple[str, int]:
    """Decode the escape at command[index] (a backslash): (text, next index).

    Bash reads a known escape as its character, ``\\nnn``/``\\0nnn`` as octal,
    ``\\xHH`` as hex, ``\\uXXXX``/``\\UXXXXXXXX`` as a code point, and ``\\cX`` as
    a control character. An escape it does not know keeps its backslash
    (``$'\\q'`` is the two characters ``\\q``), so a word built from one is
    still read as written.
    """
    following = command[index + 1] if index + 1 < end else ""
    if not following:
        return "\\", index + 1
    simple = _ANSI_C_SIMPLE_ESCAPES.get(following)
    if simple is not None:
        return simple, index + 2
    if following == "c" and index + 2 < end:
        # `\cX` masks X's low five bits, and bash masks the first byte when X is
        # multi-byte, so `$'\cß'` prints two bytes: no one-character model is
        # exact there, and a word-level scan needs only a character that is not
        # a word. Masking the code point keeps one character for every X, while
        # `.upper()` changed nothing for X in ASCII (`\ca` and `\cA` print the
        # same control character) but is two characters for 90 others, and
        # `ord` takes one, so `$'\cß'` raised its TypeError out of `bash()`.
        return chr(ord(command[index + 2]) & 0x1F), index + 3
    if following in "01234567":
        cursor = index + 1
        if command[cursor] == "0":
            # `\0nnn` is the same escape with the zero as its prefix.
            cursor += 1
        digits = ""
        while cursor < end and len(digits) < 3 and command[cursor] in "01234567":
            digits += command[cursor]
            cursor += 1
        if not digits:
            return "\\0", cursor
        return chr(int(digits, 8) & 0xFF), cursor
    if following == "x":
        digits = ""
        cursor = index + 2
        while cursor < end and len(digits) < 2 and command[cursor] in _HEX_DIGITS:
            digits += command[cursor]
            cursor += 1
        if not digits:
            return "\\x", index + 2
        return chr(int(digits, 16)), cursor
    if following in "uU":
        width = 4 if following == "u" else 8
        digits = ""
        cursor = index + 2
        while cursor < end and len(digits) < width and command[cursor] in _HEX_DIGITS:
            digits += command[cursor]
            cursor += 1
        if digits:
            try:
                return chr(int(digits, 16)), cursor
            except ValueError:
                pass  # out of range: read it as the escape that failed
        return "\\" + following, index + 2
    return "\\" + following, index + 2


def _ansi_c_quoted_word(command: str, quote_start: int, end: int) -> tuple[str, int]:
    """The word a `$'...'` span builds, and the index just past the span.

    The shell decodes the escapes inside the span and drops the `$` and the
    quotes, so `$'env'` builds the word `env` and runs it. An unterminated
    span ends with the segment, which is where the shell's own read stops.
    """
    chars: list[str] = []
    index = quote_start + 1
    while index < end:
        char = command[index]
        if char == "'":
            index += 1
            break
        if char == "\\":
            # The escape is consumed whole, so an escaped quote (`\'`) does
            # not close the span.
            text, index = _ansi_c_escape(command, index, end)
            chars.append(text)
            continue
        chars.append(char)
        index += 1
    return "".join(chars), index


def _shell_words(
    command: str,
    start: int,
    end: int,
    *,
    first_only: bool = False,
    with_starts: bool = False,
) -> list[str] | list[tuple[str, int, int]]:
    """Split command[start:end] into words the way the shell builds them.

    Whitespace separates words only outside quotes, quotes are removed from
    the words they build (`"env"` runs env, `ca"t"` runs cat), and a backslash
    makes the next character a literal part of the word. `$'...'` (ANSI-C) and
    `$"..."` (locale) quoting are those same constructs with a leading `$`, so
    the `$` is dropped and the decoded span builds the word (`$'env'` runs
    env); both stay literal inside another quote. A `#` at a word boundary
    starts a comment that runs to end of line -- a segment never contains a
    newline, so the rest of the slice is comment. An unbalanced quote ends at
    the segment end, and a quoted span still emits a word even when it is
    empty (`grep ''` keeps its empty pattern word). With `first_only` the scan
    stops at the first word boundary, so reading one word costs the length of
    that word rather than the length of the rest of the line: a line carrying
    thousands of here-document openers must not lex the rest of itself once per
    opener. With `with_starts` each word is returned with the source span it
    covers, which is what tells a caller whether a `~` was unquoted at a word
    start (`cat ~/"x"` expands) or quoted into the word (`cat "~"/x` does not)
    and which characters of the span the mask still holds live.
    """
    words: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    chars: list[str] = []
    in_word = False
    word_start = start
    quote = ""
    index = start
    while index < end:
        char = command[index]
        if quote == "'":
            # Everything inside single quotes is literal.
            if char == "'":
                quote = ""
            else:
                chars.append(char)
        elif quote == '"':
            if char == '"':
                quote = ""
            elif char == "\\" and index + 1 < end:
                index += 1
                chars.append(command[index])
            else:
                chars.append(char)
        elif char in " \t\n":
            if in_word:
                words.append("".join(chars))
                starts.append(word_start)
                ends.append(index)
                if first_only:
                    return list(zip(words, starts, ends)) if with_starts else words
                chars = []
                in_word = False
        elif char == "#" and not in_word:
            break
        else:
            if not in_word:
                word_start = index
            in_word = True
            if char == "'":
                quote = "'"
            elif char == '"':
                quote = '"'
            elif char == "$" and index + 1 < end and command[index + 1] == "'":
                # `$'...'` is ANSI-C quoting: the shell decodes the escapes
                # and drops the `$` and the quotes, so `$'env'` builds `env`.
                text, index = _ansi_c_quoted_word(command, index + 1, end)
                chars.append(text)
                index -= 1
            elif char == "$" and index + 1 < end and command[index + 1] == '"':
                # `$"..."` is locale quoting: the `$` and the quotes are
                # dropped and the interior is read like any other double-quoted
                # span. Both increments consume the `$` and the `"`.
                quote = '"'
                index += 1
            elif char == "`":
                # What a backtick span holds is one lexer token, so its blanks
                # do not separate words, and the span is kept as written
                # because the guard cannot know what it produces. This is what
                # keeps `env >&`printf 2`` a bare dump: split at its blanks,
                # the second half reads as an operand of env instead.
                stop = index + 1
                while stop < end:
                    if command[stop] == "\\":
                        stop += 2
                        continue
                    if command[stop] == "`":
                        stop += 1
                        break
                    stop += 1
                chars.append(command[index:stop])
                index = stop - 1
            elif char == "\\" and index + 1 < end:
                # A backslash always makes the next character a literal part
                # of the word, quoted or not.
                index += 1
                chars.append(command[index])
            else:
                chars.append(char)
        index += 1
    if in_word:
        words.append("".join(chars))
        starts.append(word_start)
        ends.append(index)
    return list(zip(words, starts, ends)) if with_starts else words


def _split_glued_redirect(word: str) -> tuple[str, str | None]:
    """(command word, redirection word) for a word with a glued redirection.

    `env>&2` is one shell word but two lexical pieces: the shell runs env and
    sends its output to fd 2 (`env >&2` with no space). The split takes the
    first operator that starts inside the word, because the operator-first
    spellings (`2>&1`, `12>`) already read as redirection words. An all-digit
    prefix is the descriptor of such a redirection and not a command name
    (`12>file`), so that word is left whole for the redirect match, which also
    keeps a digits-suffixed name whole: the shell runs the command `env2`, not
    `env` with a descriptor. A word that is a redirection word from its first
    character (`&>log`, `&>>log`) is left whole too, because splitting it would
    cut the leading `&` off as a command word and displace the real command.
    """
    if _REDIRECT_WORD_RE.match(word):
        return word, None
    for index, char in enumerate(word):
        if index == 0:
            continue
        if char in "><" or (char == "&" and word[index + 1 : index + 2] == ">"):
            head = word[:index]
            if head.isdigit():
                return word, None
            return head, word[index:]
    return word, None


def _live_secret_path_word(
    command: str, literal: str, expanded: str, start: int, end: int
) -> bool:
    """Whether a word the shell builds in command[start:end] names a secret path.

    The masked text matches the `~` and `$HOME` spellings only where the shell
    expands one, and the mask blanks a quoted span -- so `cat ~/".ssh"/id_rsa`
    and `cat $HOME/".ssh"/id_rsa` leave the prefix and `.ssh` off the page as
    one match while real bash reads the key. Both spellings are therefore read
    from the word the shell builds, which is the concatenation the quotes hid
    (`ca"t"` runs cat, `~/"."ssh"/id_rsa` is one path).

    A `~` only expands when it is the first character of the word and the
    character right after it is the `/` of a path, and that character is read
    from the raw command rather than from the mask: the `/` of
    `cat ~/'/'.ssh/id_rsa` is quoted, so the mask blanks it where the shell
    still reads it and still reads the key, while a quote character between the
    two (`cat ~'/'.ssh/id_rsa`) stops the expansion and the path stays literal
    text (`cat "~/.ssh/id_rsa"`, `cat '~'/.ssh/id_rsa`). A `$HOME` expands
    unquoted and inside double quotes, so it has to be live in the mask that
    leaves double quotes live (`cat '$HOME/.ssh/id_rsa'` is text).
    """
    for word, word_start, word_end in _shell_words(
        command, start, end, with_starts=True
    ):
        if (
            literal[word_start : word_start + 1] == "~"
            and command[word_start + 1 : word_start + 2] == "/"
            and _TILDE_WORD_SECRET_PATH_RE.match(word)
        ):
            return True
        if _LIVE_HOME_VAR_RE.search(
            expanded[word_start:word_end]
        ) and _HOME_VAR_WORD_SECRET_PATH_RE.search(word):
            return True
    return False


def _analysis_words(command: str, start: int, end: int) -> list[str]:
    """Shell words for one segment, minus the words that narrow nothing.

    Redirection words are dropped first: a bare operator (`2>` left over by
    the `&` split of `2>&1`, or a lone `>`) also swallows its target word,
    while a glued form (`2>/dev/null`) carries the target inside the word. A
    redirection glued to the command word (`env>&2`, `env>/dev/null`) is split
    into its two pieces first, so the command word still reaches the checks
    and the redirection is still dropped. Leading `FOO=1` assignment words go
    next, because the shell runs the rest of the command either way.
    """
    words: list[str] = []
    skip_target = False
    for word in _shell_words(command, start, end):
        if skip_target:
            skip_target = False
            continue
        head, redirect = _split_glued_redirect(word)
        for piece in (word,) if redirect is None else (head, redirect):
            match = _REDIRECT_WORD_RE.match(piece)
            if match:
                skip_target = match.group(0) == piece
                continue
            words.append(piece)
    while words and _ASSIGNMENT_WORD_RE.match(words[0]):
        words.pop(0)
    return words


def _descriptor_text(masked: str, operator_index: int) -> str:
    """The digit run that names the descriptor written before an operator.

    The digits count only when they start their own token, the way the shell
    reads them, so the `2` of `a2>&2` belongs to that word and names no
    descriptor. An empty return means no digits are written, which the callers
    read as the operator's default descriptor.
    """
    source = operator_index
    while source > 0 and masked[source - 1].isdigit():
        source -= 1
    if source == operator_index and masked[source - 1 : source] == "}":
        # `{name}>` names no digits, so it reads as another descriptor and fd 1
        # keeps the pipe. It counts only where it starts its own token, the way
        # the shell reads the form (`x{fd}>log` sends fd 1 to the file).
        brace = masked.rfind("{", 0, source)
        if brace >= 0 and _BRACE_DESCRIPTOR_RE.fullmatch(masked[brace:source]):
            if brace == 0 or masked[brace - 1] in _SHELL_METACHARACTERS:
                return masked[brace:source]
        return ""
    if source > 0 and masked[source - 1] not in _SHELL_METACHARACTERS:
        return ""
    return masked[source:operator_index]


def _descriptor_effect(digits: str) -> str:
    """How a descriptor digit run written before an operator affects fd 1.

    `written` means the run is absent or names fd 1, so the redirection acts on
    stdout; `other` means it names another descriptor (`2>&1`), so fd 1 keeps
    the pipe; `unreadable` means the run cannot be a descriptor at all, which
    counts as moving fd 1 (fail closed). The run is read as text rather than as
    an integer: a run of thousands of digits is not a number Python will
    convert, and no shell descriptor is that long. Leading zeros are ignored
    the way the shell ignores them (`01` is fd 1) and an all-zero run names
    fd 0, not fd 1.
    """
    if not digits:
        return "written"
    stripped = digits.lstrip("0")
    if len(stripped) > _MAX_DESCRIPTOR_DIGITS:
        return "unreadable"
    return "written" if stripped == "1" else "other"


def _leaves_the_pipe(masked: str) -> bool:
    """Whether a redirection in this masked segment takes fd 1 off the pipe.

    The exemption for `env | grep KEY` requires the dump to reach the pipe. In
    a pipeline the shell gives fd 1 the pipe and applies the command's
    redirections afterwards, so a redirection that sends fd 1 elsewhere breaks
    it and the dump never reaches grep: `env >&2 | grep KEY` writes it to
    stderr, which the kernel merges into the transcript, and `env >log | grep
    KEY` writes it to a file. A redirection that leaves fd 1 on the pipe
    (`env 2>/dev/null | grep KEY`, `env 2>&1 | grep KEY`) keeps the exemption,
    and `>&1` duplicates fd 1 onto itself, which keeps it too. So does a `<>`
    open on another descriptor (`env 0<>log` reads fd 0), while `<>` on fd 1 or
    with no descriptor written replaces stdout and takes the dump off the pipe.

    The masked text is faithful for the operator, because a quoted operator is
    data (`env '>&2'` runs no redirect at all), but it is not faithful for the
    descriptor: the shell removes the quotes and escapes before it reads one,
    so `env >&"2"` and `env >&\2` move fd 1 while the mask has blanked the
    digit. Only a plain unquoted digit run is therefore read as a descriptor,
    and anything else -- a quote, a backslash, `$`, a target that runs into
    more word characters (`>&2x` is a file), or no digits at all -- counts as
    taking fd 1 off the pipe. The descriptor digits are also read the way the
    shell reads them: they form one only when they start their own token, so
    the `2` of `a2>&2` belongs to that word and fd 1 leaves the pipe too.
    """
    index = 0
    while index < len(masked):
        index = masked.find(">", index)
        if index < 0:
            return False
        if masked[index - 1 : index] == "&" and masked[index - 2 : index - 1] in _SHELL_METACHARACTERS:
            # `&>` and `&>>` send both streams away from the pipe.
            return True
        if masked[index - 1 : index] == "<":
            # `<>` opens the descriptor it names read-write, so fd 1 and the
            # descriptor-less spelling (fail closed) take stdout off the pipe,
            # while another descriptor (`0<>log` reads fd 0) leaves fd 1 alone.
            if _descriptor_effect(_descriptor_text(masked, index - 1)) != "other":
                return True
            index += 1
            continue
        duplicated = masked[index + 1 : index + 2] == "&"
        effect = _descriptor_effect(_descriptor_text(masked, index))
        if effect == "unreadable":
            # A run too long to be a descriptor is not trusted either way.
            return True
        if effect == "other":
            # The redirection moves some other descriptor, so fd 1 keeps the pipe.
            index += 2 if duplicated else 1
            continue
        if not duplicated:
            # `>` and `>>` send fd 1 to a file, so grep gets no dump.
            return True
        target = index + 2
        while target < len(masked) and masked[target] in " \t":
            target += 1
        digits = target
        while target < len(masked) and masked[target].isdigit():
            target += 1
        descriptor = masked[digits:target]
        ending = masked[target : target + 1]
        if not descriptor or (ending and ending not in _WORD_BREAKERS):
            # The target is not a descriptor this scan can read, so fd 1 is
            # assumed to leave the pipe rather than trusted to stay on it.
            return True
        if _descriptor_effect(descriptor) != "written":
            return True
        index = target
    return False


def _env_flag_operands_dropped(words: list[str]) -> list[str]:
    """The words of an `env` line minus the operand each flag owns.

    `-u PATH` unsets PATH and `-C /tmp` changes directory, so those operands
    belong to their flag and the shell reads no command from them. The glued
    spellings (`--unset=PATH`, `--chdir=/tmp`) carry the operand in the word.
    """
    remaining: list[str] = []
    expect_operand = False
    for word in words:
        if expect_operand:
            expect_operand = False
            continue
        if word in _ENV_OPERAND_FLAGS:
            expect_operand = True
            continue
        if word.partition("=")[0] in _ENV_OPERAND_FLAGS:
            continue
        remaining.append(word)
    return remaining


def _env_split_words(words: list[str]) -> list[str] | None:
    """The words of an `-S`/`--split-string` operand, None when there is none.

    The operand is a command line of its own, which `env` splits on blanks and
    runs (`env -S 'env -u PATH'` runs env), so the whole operand is read the way
    a command line is read rather than only its first word: `env -S 'printenv
    HOME'` is the targeted read it looks like, while `env -S 'printenv'` dumps.
    An operand that splits to nothing comes back as an empty list rather than as
    None, because it is the bare `env` the caller has to refuse.
    """
    for index, word in enumerate(words):
        name, separator, value = word.partition("=")
        if name not in _ENV_SPLIT_FLAGS:
            continue
        if not separator:
            value = words[index + 1] if index + 1 < len(words) else ""
        return value.split()
    return None


def _executor_reader(words: list[str]) -> bool:
    """Whether an `env` invocation runs `cat`/`echo`, the readers this scan models.

    `env cat ~/.ssh/id_rsa` prints the key body, and its command word is `env`
    rather than the reader, so a path check keyed off the command word alone
    never saw it. The words after the dump command are read as the command line
    it runs -- the same reading that makes `env printenv` a dump -- and the first
    of them has to be a modeled reader, while a reader this scan does not name
    stays out of the modeled set (`env head ~/.ssh/id_rsa`).
    """
    if words[0] != "env":
        return False
    executed = _executed_command_words(words[1:])
    return bool(executed) and executed[0] in _SECRET_READ_COMMANDS


def _split_operand_secret_path(words: list[str]) -> bool:
    """Whether an `env -S` operand names a `${HOME}` secret path.

    `env` splits that operand itself and expands `${VARNAME}` inside it, so
    `env -S 'cat ${HOME}/.ssh/id_rsa'` reads the key even though the shell never
    expands the quoted operand the mask blanks. A `~` in the operand stays
    literal text and reads nothing (`env -S 'cat ~/.ssh/id_rsa'` reports no such
    file), so only the variable spelling is read from those words.
    """
    if words[0] != "env":
        return False
    split_words = _env_split_words(words[1:])
    return bool(split_words) and any(
        _HOME_VAR_WORD_SECRET_PATH_RE.search(word) for word in split_words
    )


def _executed_command_words(words: list[str]) -> list[str]:
    """The command line the words of an `env` invocation run, minus its own flags.

    `env` runs the command its remaining words name, so those words are read the
    way `_is_bare_dump` reads them: the operand of `-u`/`--unset` and
    `-C`/`--chdir` belongs to that flag, leading `FOO=1` assignments are dropped,
    the flags themselves name no command, and an `-S`/`--split-string` operand is
    the whole command line in one word. `env cat ~/.ssh/id_rsa`,
    `env FOO=1 cat ~/.ssh/id_rsa`, and `env -S 'cat ~/.ssh/id_rsa'` therefore all
    reach the reader check as the same command line, and `printenv` is not read
    this way because it runs nothing: its operands are variable names.
    """
    rest = _env_flag_operands_dropped(words)
    while rest and _ASSIGNMENT_WORD_RE.match(rest[0]):
        rest.pop(0)
    split_words = _env_split_words(rest)
    if split_words:
        return split_words
    return [word for word in rest if not word.startswith("-")]


def _is_bare_dump(words: list[str], *, depth: int = 0) -> bool:
    """Whether these words print a whole environment with no filter.

    The nested command line an `env -S` operand carries is re-tested by this
    same function, and that re-test is depth-bounded: a chain nested past
    _DUMP_NESTING_LIMIT is answered as a dump (fail closed), which is what the
    measurement of that shape answered and what keeps an unbounded chain from
    raising RecursionError out of `bash()`.
    """
    if depth > _DUMP_NESTING_LIMIT:
        return True
    if words[0] in _DUMP_COMMANDS:
        rest = words[1:]
        if words[0] == "env":
            rest = [
                word
                for word in _env_flag_operands_dropped(rest)
                if not _ASSIGNMENT_WORD_RE.match(word)
            ]
            # `env printenv`, `env -u PATH printenv`, and `env -S 'env'` run
            # another dump word: the nested command line is read the same way,
            # so `env printenv` dumps while `env printenv HOME` stays the
            # targeted read it looks like, and the `-S` operand is read as the
            # whole command line it is rather than by its first word alone
            # (`env -S 'printenv HOME'` runs the targeted read).
            for position, word in enumerate(rest):
                if word in _DUMP_COMMANDS and _is_bare_dump(
                    rest[position:], depth=depth + 1
                ):
                    return True
            split_words = _env_split_words(rest)
            if split_words is not None:
                # An operand that splits to nothing (`env -S ''`, `env -S ' '`)
                # leaves a bare `env`, which dumps, so an empty command line
                # fails closed here.
                if not split_words or _is_bare_dump(split_words, depth=depth + 1):
                    return True
        # Nothing but flags after the command word: `env -0` prints the same
        # unfiltered dump in NUL-separated form, and `env -u PATH` with its
        # operand dropped prints the whole environment minus that variable.
        return all(word.startswith("-") for word in rest)
    if words[0] == "export":
        # A named export prints no values, so only the flag-only forms are
        # dumps -- and `export` with no names prints every exported name and
        # value exactly like `export -p` (`export -n` and `export --` are the
        # same dump). The one flag that prints definitions rather than values
        # is `-f`, so a cluster of `f`s is not a value dump.
        if [word for word in words[1:] if not word.startswith("-")]:
            return False
        flags = [word for word in words[1:] if word.startswith("-")]
        return not flags or any(set(flag[1:]) != {"f"} for flag in flags)
    return False


def _max_count_bounds_output(value: str) -> bool:
    """Whether an `-m`/`--max-count` argument caps the output.

    A digit run with a non-zero digit caps it (`-m1` prints one line, `-m10`
    prints ten). An all-zero or empty value does not: this platform's grep
    prints the whole dump for `-m0` (BSD grep 2.6.0, measured), so a zero
    count is treated as widening rather than as a bound.
    """
    return value.isdigit() and bool(value.strip("0"))


def _cluster_flag_effect(cluster: str) -> str:
    """How one short-flag cluster affects the bounded-filter test.

    `wide` means the cluster is unbounded or widens matches, `value` means it
    ends with an `m` whose argument is the next word (`-m 1`), and `ok` means
    it is a bounded flag. `-v`/`-f`/`-A`/`-B`/`-C` widen, and so does an `e`
    with a glued value (`-e.`, `-ePATH`, `-Fe.`), whose pattern this scan never
    read. A digit is the `-NUM` context form (`-2` is `--context=2`, read the
    same way inside a cluster: `-10i`, `-i2`, `-F2`). The exception is a digit
    run directly after an `m`: that run is the argument of `-m`/`--max-count`,
    so it is consumed before the digit test -- unless it is all zeros, which prints the
    whole dump. A digit anywhere else stays unbounded (`-1m`).
    """
    index = 0
    while index < len(cluster):
        char = cluster[index]
        if char == _GREP_PATTERN_LETTER and index + 1 < len(cluster):
            # A glued pattern value leaves grep's pattern unread, and the word
            # that remains is a file operand rather than the filter.
            return "wide"
        if char == _GREP_MAX_COUNT_LETTER:
            digits = index + 1
            while cluster[digits : digits + 1].isdigit():
                digits += 1
            if digits == len(cluster) and digits == index + 1:
                # A bare `-m` at the end of its cluster takes the count from the
                # next word (`-m 1`).
                return "value"
            if not _max_count_bounds_output(cluster[index + 1 : digits]):
                return "wide"
            index = digits
            continue
        if char in _GREP_UNBOUNDED_FLAG_LETTERS or char.isdigit():
            return "wide"
        index += 1
    return "ok"


def _pipe_follower_words(
    command: str, segments: list[tuple[int, int, str]], index: int
) -> list[str]:
    """The words of the segment a pipe feeds, skipping the wordless ones.

    The shell reads a newline after a `|` as the pipe continuing on the next
    line, so `env |` and `grep KEY` on the line below is the same filtered read
    as one line, while the segment split leaves an empty segment where that
    newline sits. Only a wordless segment a newline ends is skipped, because the
    newline is what continues the pipe: a segment that ends on `|` or `&`
    (`env || grep KEY` prints the dump and filters nothing) reads as no words,
    which is not a bounded filter.
    """
    while index < len(segments):
        start, end, separator = segments[index]
        words = _analysis_words(command, start, end)
        if words:
            return words
        if separator != "\n":
            return []
        index += 1
    return []


def _is_bounded_grep_filter(words: list[str]) -> bool:
    """Whether these words grep for exactly one fixed string.

    Only a `grep` whose single pattern is a plain string filters a dump down
    to one named key. `-v` inverts the filter (nearly the whole dump), `-f`
    takes the patterns from a file, `-z` reads one NUL-delimited record that
    contains everything, `-A`/`-B`/`-C` and a number in the flag widen every
    match with context lines (`-2` is `--context=2`, and grep reads
    a digit in a cluster the same way: `-10i`, `-i2`, `-F2`), a long flag is
    matched from any unambiguous prefix of its name (`--cont=2`,
    `--after-c=2`), a pattern glued to the flag that supplies it (`--regexp=.`,
    `-e.`) because the pattern is then not a word this test read and the words
    that follow are files it reads instead of the pipe, and a pattern with
    regex metacharacters can match every line (`grep .`); a string-only scan
    cannot prove anything narrower about those shapes, so they stay refused. A
    lone `--` ends the options the way it does for grep, so a short-flag
    spelling after it is an operand rather than a flag (`grep -- -v` is a
    fixed-string filter, `grep -- -v KEY` is a pattern and a file). A digit run directly after an `m` is
    that flag's own bound rather than context (`-m1`, `-F -m1`, `-im1` and the
    spaced `-m 1` all print one line), so it stays a bounded filter, unless the
    count is zero, which prints the whole dump here (`-m0`).
    """
    if not words or words[0] != _TARGETED_READ_COMMAND:
        return False
    operands: list[str] = []
    flags = words[1:]
    index = 0
    options_ended = False
    while index < len(flags):
        word = flags[index]
        index += 1
        if options_ended or not word.startswith("-"):
            # A lone `--` ends the options, and every word after it is an
            # operand: the `-v` of `grep -- -v` is the pattern (one fixed string
            # that matches nothing) rather than the inversion flag.
            operands.append(word)
            continue
        if word.startswith("--"):
            name, separator, value = word.partition("=")
            if word == "--":
                options_ended = True
                continue
            # The rest is a long flag, and grep matches it from any
            # unambiguous prefix of its name.
            if any(flag.startswith(name) for flag in _GREP_UNBOUNDED_LONG_FLAGS):
                return False
            if separator and _GREP_PATTERN_LONG_FLAG.startswith(name):
                # A glued `--regexp=.` is a pattern this scan never read (grep
                # takes any unambiguous prefix of the long name), so the word
                # left over is a file operand grep reads instead of the pipe.
                return False
            if name == _GREP_MAX_COUNT_LONG_FLAG or (
                separator and _GREP_MAX_COUNT_LONG_FLAG.startswith(name)
            ):
                # grep reads any unambiguous prefix of the long name, so a glued
                # `--max-c=0` is `--max-count=0`. The count is glued
                # (`--max-count=1`) or, for the full name, the next word. A value
                # grep itself rejects (`--max-count=x`) prints nothing, so it is
                # skipped the way the unknown-option spelling is.
                if not separator:
                    value = flags[index] if index < len(flags) else ""
                    if not value.isdigit():
                        continue
                    index += 1
                elif not value.isdigit():
                    continue
                if not _max_count_bounds_output(value):
                    return False
            continue
        effect = _cluster_flag_effect(word[1:])
        if effect == "wide":
            return False
        if effect == "value":
            # A spaced count is read only when it is a digit run; anything else
            # makes grep itself fail (`grep -m PATH`), so nothing prints.
            value = flags[index] if index < len(flags) else ""
            if not value.isdigit():
                continue
            index += 1
            if not _max_count_bounds_output(value):
                return False
    if len(operands) != 1 or not operands[0]:
        return False
    return not any(char in _GREP_PATTERN_METACHARS for char in operands[0])


def _quoted_span_end(command: str, quote_index: int, n: int) -> int:
    """The index just past the quote that closes command[quote_index], or -1.

    A backslash escapes the next character inside a double quote. A -1 return
    means the span never closes, which the callers read as a reason to keep
    scanning or to fail closed rather than trust it.
    """
    quote = command[quote_index]
    index = quote_index + 1
    while index < n:
        if quote == '"' and command[index] == "\\":
            index += 2
            continue
        if command[index] == quote:
            return index + 1
        index += 1
    return -1


def _paren_matches(command: str) -> dict[int, int]:
    """For every `(` in command, the index of the `)` that closes it, or -1.

    One pass over the command, so a command built out of thousands of
    unterminated openers costs the size of the command: looking for each
    opener's closer on its own would cost the square of it. Quoting is read the
    way the shell reads it -- a substitution's interior starts a fresh quoting
    context, so `$(echo "a)")` closes at the last `)` -- because that is what
    decides whether a `)` inside quotes is a closer or a literal. Comments are
    read the way `_mask_literals` reads them, since a `)` inside a comment is
    data too.
    """
    matches: dict[int, int] = {}
    stack: list[tuple[int, bool]] = []  # (open index, quoting of the caller)
    in_double_quotes = False
    in_word = False
    index = 0
    n = len(command)
    while index < n:
        char = command[index]
        if char == "\\":
            in_word = True
            index += 2
            continue
        if char == "'":
            # An unterminated span proves nothing, so the scan continues inside
            # it rather than treating the rest of the command as quoted.
            in_word = True
            span_end = _quoted_span_end(command, index, n)
            index = span_end if span_end > 0 else index + 1
            continue
        if char == '"':
            in_double_quotes = not in_double_quotes
            in_word = True
            index += 1
            continue
        if not in_double_quotes and char == "#" and not in_word:
            # A `#` at the start of a word is a comment that runs to end of
            # line, and a comment is data rather than source: the `)` in
            # `echo "$( #)` -- with the dump on the next line -- is inside the
            # comment, so the substitution closes at the later `)` the shell
            # reads and its whole interior is scanned. Reading the comment's
            # `)` as the closer would end the interior before the command that
            # runs there, which is the one span no other pass reads.
            while index < n and command[index] != "\n":
                index += 1
            continue
        if char == "$" and command[index + 1 : index + 2] == "(":
            # A substitution opens a command, so a word starts fresh against the
            # opener rather than continuing the word before it: a `#` glued to
            # `$(` is that command's first word, and the comment it begins runs
            # to end of line. `echo "$(#)` with `env )"` on the next line runs
            # env, so the `)` that comment hides must not close the span.
            stack.append((index + 1, in_double_quotes))
            in_double_quotes = False
            in_word = False
            index += 2
            continue
        if char == "(" and not in_double_quotes:
            stack.append((index, in_double_quotes))
            in_double_quotes = False
            in_word = False
            index += 1
            continue
        if char == ")" and not in_double_quotes and stack:
            open_index, saved = stack.pop()
            matches[open_index] = index
            in_double_quotes = saved
            in_word = False
            index += 1
            continue
        in_word = char not in _WORD_BREAKERS
        index += 1
    for open_index, _saved in stack:
        matches[open_index] = -1
    return matches


def _is_arithmetic_expansion(matches: dict[int, int], dollar_index: int) -> bool:
    """Whether the `$((` at dollar_index is arithmetic rather than a subshell.

    Bash reads `$((` as an arithmetic expansion only when the two `)` that close
    it are adjacent: `echo $((env))` is the number the arithmetic reads and runs
    nothing, while `echo $((env) )` is `$( ( env ) )`, a subshell that runs env
    and prints the whole environment. The test is the closer of the inner `(`
    followed immediately by the closer of the outer one; a `$((` whose parens do
    not line up that way is a command substitution, and its interior is scanned
    as the command it runs.
    """
    inner = matches.get(dollar_index + 2, -2)
    return inner + 1 == matches.get(dollar_index + 1, -3)


def _command_substitutions(
    command: str, *, descend: bool = True
) -> list[tuple[str, bool]]:
    """The interior of every `$(...)` and backtick substitution in command.

    A substitution runs a command, so the caller scans each interior like a
    command of its own -- which is also what reads the substitution a double
    quote hides from the masking walk (`echo "$(env)"`). Single-quoted spans,
    comments, and backslash-escaped characters never start one, a `#` inside
    double quotes is not a comment, and a bare `(` outside quotes already
    splits the command into its own segment. `$((` whose two closers are
    adjacent opens an arithmetic expansion rather than a command, so it queues
    no interior and the walk steps over the `$(` alone: `echo $((env))` is the
    number the arithmetic reads, while a substitution inside it
    (`echo $(( $(env) ))`) still runs. A `$((` whose closers are not adjacent
    (`echo $((env) )`) is a command substitution around a subshell, so its
    interior is queued and scanned like any other.

    Each interior carries the flag its own scan needs. A balanced substitution
    descends. An unmatched `$(` runs to the end of the command, so every
    unmatched opener inside it is a suffix of the same tail: with `descend`
    that tail is returned once, with `descend=False`, which is what keeps a
    command of unterminated openers to one pass over the tail instead of one
    pass per opener. An unmatched backtick has no other backtick after it, so
    its tail is always returned once.
    """
    interiors: list[tuple[str, bool]] = []
    matches = _paren_matches(command)
    index = 0
    n = len(command)
    in_word = False
    in_double_quotes = False
    while index < n:
        char = command[index]
        if char == "\\":
            # A backslash makes the next character literal, and that character
            # is part of the word it sits in.
            in_word = True
            index += 2
            continue
        if char == '"':
            # A double-quoted span keeps its substitutions live, which is the
            # whole point of the walk, but its blank characters and `#`s are
            # literal, so only the quote state changes here. An escape is
            # consumed as a pair above, so this `"` always toggles.
            in_double_quotes = not in_double_quotes
            in_word = True
            index += 1
            continue
        if not in_double_quotes:
            if char == "'" or (char == "$" and command[index + 1 : index + 2] == "'"):
                # A single-quoted span, and the ANSI-C span that shares its
                # quote, are literal data: nothing inside them runs.
                in_word = True
                quote_index = index if char == "'" else index + 1
                span_end = _quoted_span_end(command, quote_index, n)
                # An unterminated span proves nothing, so it is not trusted to
                # hide a substitution: scanning continues inside it.
                index = span_end if span_end > 0 else index + 1
                continue
            if char == "#" and not in_word:
                # A `#` at a word boundary starts a comment that runs to end of
                # line, and a comment is literal data: `echo hi # $(env)`
                # prints `hi` and runs nothing.
                while index < n and command[index] != "\n":
                    index += 1
                continue
        in_word = True
        if char == "$" and command[index + 1 : index + 2] == "(":
            if command[index + 2 : index + 3] == "(" and _is_arithmetic_expansion(
                matches, index
            ):
                # `$((` opens an arithmetic expansion, not a command: bash reads
                # the text as a number and runs nothing, so no interior is
                # queued. Stepping over the `$(` alone keeps the arithmetic
                # text in this walk, so a real substitution inside it is still
                # found (`echo $(( $(env) ))` runs env and then fails the
                # arithmetic).
                index += 2
                continue
            close_index = matches.get(index + 1, -1)
            if close_index < 0:
                if descend:
                    # The tail is the whole rest of the command, so nothing
                    # after it can be outside it.
                    interiors.append((command[index + 2 :], False))
                    index = n
                else:
                    # This text is itself an unterminated tail, and the nested
                    # opener is a suffix of the same tail.
                    index += 2
                continue
            interiors.append((command[index + 2 : close_index], True))
            index = close_index + 1
            continue
        if char == "`":
            end = index + 1
            while end < n:
                if command[end] == "\\":
                    end += 2
                    continue
                if command[end] == "`":
                    break
                end += 1
            if end < n:
                interiors.append((command[index + 1 : end], True))
                index = end + 1
                continue
            # No other backtick follows an unmatched one, so the tail is read
            # once whether or not this text is itself a tail.
            interiors.append((command[index + 1 : end], False))
            index = n
            continue
        if char in _WORD_BREAKERS:
            in_word = False
            index += 1
            continue
        index += 1
    return interiors


def _heredoc_declarations(
    command: str, masked: str, start: int, end: int
) -> list[tuple[str, bool]]:
    """(delimiter, quoted) for each here-document opened in command[start:end].

    The operator is found in the masked text, so a `<<` inside quotes or a
    comment is data rather than an operator (`echo "a <<'EOF' b"` opens no
    body). A quoted delimiter (`<<'EOF'`, `<<"EOF"`) makes the body literal
    input, while an unquoted one still expands command substitutions in that
    body. An opener line that already opened an arithmetic command keeps its
    `<<` as a shift instead (`(( x = 1 << 2 ))` and the deprecated
    `$[ 1 << 2 ]` run no here-document, and their next lines are ordinary
    commands), while `let a=1<<2` is a real redirect: only the arithmetic
    spellings suppress the declaration.
    """
    declarations: list[tuple[str, bool]] = []
    index = start
    while index < end:
        if masked[index] != "<":
            index += 1
            continue
        run_end = index
        while run_end < end and masked[run_end] == "<":
            run_end += 1
        if run_end - index == len(_HEREDOC_OPERATOR):
            position = run_end
            if position < end and masked[position] == _HEREDOC_TAB_STRIP:
                position += 1
            while position < end and command[position] in " \t":
                position += 1
            if position < end:
                words = _shell_words(command, position, end, first_only=True)
                # Inside an arithmetic command `<<` is a shift, not an opener:
                # the body this would claim is really the next command.
                if words and not any(
                    marker in command[start:position] for marker in _ARITHMETIC_OPENS
                ):
                    declarations.append((words[0], command[position] in "'\""))
        index = run_end
    return declarations


def _heredoc_bodies(
    command: str, masked: str, segments: list[tuple[int, int, str]]
) -> tuple[set[int], set[int], set[int]]:
    """(segment indices of every body, of the quoted ones, of the delimiter lines).

    A here-document body is never shell input, quoted or not, so no body line
    runs as a command and a body line's words can never reach the transcript:
    `cat <<EOF` and `cat <<'EOF'` with `env` on a body line both print the text
    `env`. Only the body's expansions can leak, and the only expansion that
    runs a command is a command substitution, so the per-word checks skip every
    body while the substitution walk still reads the unquoted ones (see
    _secret_echo_violation).

    The body runs to the first line whose only word is the delimiter, and a
    line that opens more than one here-document (`cat <<'A' <<'B'`) claims its
    bodies in order. A body whose delimiter never appears proves nothing, so no
    line is claimed there and every check stays in place.

    The closing delimiter line is returned as well: it is the syntax that ends
    the body rather than input to anything, so it is not expanded either
    (`cat <<'$(env)'` with `$(env)` on the closing line prints one word). Only
    the substitution walk skips it; the word checks still read it, so a
    delimiter line that is itself a dump word (`cat <<'env'` closed by `env`)
    stays refused.

    One forward pass: the lines are listed and the delimiter lines are indexed
    by their word first, so an opener whose delimiter line never arrives costs
    one lookup instead of a rescan of the rest of the command.
    """
    lines: list[tuple[int, int]] = []
    delimiter_lines: dict[str, list[int]] = {}
    cursors: dict[str, int] = {}
    index = 0
    while index < len(segments):
        line_end_index = index
        while line_end_index + 1 < len(segments) and segments[line_end_index][2] != "\n":
            line_end_index += 1
        lines.append((index, line_end_index))
        words = _shell_words(command, segments[index][0], segments[line_end_index][1])
        if len(words) == 1:
            delimiter_lines.setdefault(words[0], []).append(len(lines) - 1)
        index = line_end_index + 1
    bodies: set[int] = set()
    quoted_bodies: set[int] = set()
    delimiter_lines_found: set[int] = set()
    line_index = 0
    while line_index < len(lines):
        # The shell reads the whole line that opens a here-document before it
        # reads the body, so the line is the unit of detection.
        first, last = lines[line_index]
        declarations = _heredoc_declarations(
            command, masked, segments[first][0], segments[last][1]
        )
        body_line = line_index + 1
        for delimiter, quoted in declarations:
            candidates = delimiter_lines.get(delimiter, ())
            # A body is claimed in order, so the delimiter cursor only moves
            # forward and every opener costs one step.
            cursor = cursors.get(delimiter, 0)
            while cursor < len(candidates) and candidates[cursor] < body_line:
                cursor += 1
            cursors[delimiter] = cursor
            if cursor == len(candidates):
                break
            closing = candidates[cursor]
            for line in range(body_line, closing):
                span = range(lines[line][0], lines[line][1] + 1)
                bodies.update(span)
                if quoted:
                    quoted_bodies.update(span)
            delimiter_lines_found.update(
                range(lines[closing][0], lines[closing][1] + 1)
            )
            # A body line is not shell input, so nothing in it opens another
            # here-document, and no word in it runs: only the walk over the
            # unquoted bodies can still see a substitution there.
            body_line = closing + 1
        line_index = body_line
    return bodies, quoted_bodies, delimiter_lines_found


def _blank_segments(
    command: str, segments: list[tuple[int, int, str]], indices: set[int]
) -> str:
    """A copy of command with the spans of `indices` blanked, length-preserving."""
    if not indices:
        return command
    chars = list(command)
    for index in indices:
        start, end, _separator = segments[index]
        for position in range(start, end):
            chars[position] = " "
    return "".join(chars)


def _secret_echo_violation(command: str) -> str | None:
    """Why `command` would echo secrets into the transcript, or None.

    The scan is text-only: the same command is refused whether or not the
    file it names exists. A command substitution runs another command, so each
    interior is scanned the same way. No here-document body line runs as a
    command, so the per-word checks skip every body, and only the unquoted
    bodies are walked for substitutions -- the line that closes a body is
    skipped there too, since it is syntax rather than input. The interiors are
    scanned from a worklist rather than by a recursive call: a command can nest
    substitutions deeper than the Python recursion limit, and an exception
    escaping the guard would be worse than a refusal.
    """
    # (command text, whether an unmatched opener in it yields another tail)
    pending: list[tuple[str, bool]] = [(command, True)]
    while pending:
        current, descend = pending.pop()
        literal = _mask_literals(current, double_quotes=True)
        expanded = _mask_literals(current, double_quotes=False)
        segments = _command_segments(literal)
        heredoc_bodies, quoted_bodies, delimiter_lines = _heredoc_bodies(
            current, literal, segments
        )
        for index, (start, end, separator) in enumerate(segments):
            if index in heredoc_bodies:
                continue
            words = _analysis_words(current, start, end)
            if not words:
                continue
            if _is_bare_dump(words):
                # `env | grep SAFE_VAR` is the targeted read the refusal
                # message suggests, so that one filtered form stays allowed --
                # but only while the dump really feeds the pipe, because a
                # redirect that takes fd 1 off it (onto stderr, where the
                # kernel merges it into the transcript, or into a file) leaves
                # grep nothing to filter.
                if (
                    separator == "|"
                    and index + 1 < len(segments)
                    and not _leaves_the_pipe(literal[start:end])
                ):
                    follower = _pipe_follower_words(current, segments, index + 1)
                    if _is_bounded_grep_filter(follower):
                        continue
                return "the full environment"
            if (
                words[0] in _SECRET_READ_COMMANDS or _executor_reader(words)
            ) and (
                _TILDE_SECRET_PATH_RE.search(literal[start:end])
                or _HOME_VAR_SECRET_PATH_RE.search(expanded[start:end])
                or _live_secret_path_word(current, literal, expanded, start, end)
                or _split_operand_secret_path(words)
            ):
                return "a known secret file"
        # Each interior is a strict substring of the text it came from, so the
        # worklist drains. A quoted here-document body is blanked first:
        # `cat <<'EOF'` with `$(env)` on a body line prints that text rather
        # than running it, while an unquoted body still expands, so its
        # substitutions stay in the walk. The line that closes a body is
        # blanked too, because it is the syntax that ends the body rather than
        # input to anything: `cat <<'$(env)'` with `$(env)` on the closing line
        # prints the one body word and runs nothing.
        runnable = _blank_segments(current, segments, quoted_bodies | delimiter_lines)
        pending.extend(_command_substitutions(runnable, descend=descend))
    return None


def _format_secret_echo_refusal(violation: str) -> str:
    return "\n".join(
        [
            f"Refusing to run this command: it would print {violation} into",
            "the transcript, where the output persists in session logs that",
            "models and users read later.",
            "",
            "Read only what you need instead: printenv SAFE_VAR for a single",
            "variable, env | grep SAFE_VAR to filter a dump, or grep KEY",
            "<file> for one key out of a file.",
            "",
            "If the full output is intentional, retry with",
            "bash(command, allow_secret_echo=True), or start the kernel with",
            f"{BASH_SECRET_ECHO_BYPASS_ENV}=1.",
        ]
    )


def _warn_once_about_late_secret_echo_bypass() -> None:
    """Warn (once) when the bypass env var appears mid-session.

    The frozen launch-time copy is the only honored bypass, so a value that
    shows up later is ignored; one os.environ write cannot unlock the guard.
    Warn loudly so a deliberate bypass takes the documented path (restart the
    kernel with the variable set) instead of looking like a no-op."""
    global _secret_echo_late_bypass_warned
    if _secret_echo_late_bypass_warned:
        return
    value = os.environ.get(BASH_SECRET_ECHO_BYPASS_ENV)
    if value is None or value in ("", "0"):
        return
    _secret_echo_late_bypass_warned = True
    print(
        f"prime-agent bash: {BASH_SECRET_ECHO_BYPASS_ENV} appeared after"
        " kernel start and is ignored; the secret-echo guard only honors it"
        " when the kernel is started with it set.",
        file=sys.stderr,
        flush=True,
    )


def _guard_secret_echo(script: str, allow_secret_echo: bool) -> None:
    """Refuse commands that would echo secrets into the transcript: a bare
    environment dump, or a read of a known secret file under the user's home.
    The caller passes the script the shell will run, prefix included, so the
    text this scan reads and the text the handle executes are one string. The
    scan is string-only and runs before any spawn, so a refused command never
    starts a process, and a command the patterns do not name pays for one
    scan of its own text: two mask passes, a segment split, a here-document
    line pass, a word split per segment, and a substitution walk, all linear in
    the length of the command."""
    if allow_secret_echo or _SECRET_ECHO_BYPASS_AT_KERNEL_START:
        return
    violation = _secret_echo_violation(script)
    if violation is None:
        return
    _warn_once_about_late_secret_echo_bypass()
    raise SecretEchoRefusalError(_format_secret_echo_refusal(violation))

# Pipe-to-shell guard (wave-1 safety audit gap 3). `curl ... | sh` and
# `sh -c "$(curl ...)"` run whatever the far end of a URL serves straight into
# a shell, with no review step and no record of the bytes that ran. Detection
# is text-only: a quote-aware split of the command into pipeline stages, a word
# scan that folds quotes and escapes the shell's way, and a fail-closed reading
# of what each stage feeds. No URL is fetched and no process starts, so a
# command pays for one pass over its text -- times the nesting of the
# substitutions it holds, which a depth cap bounds -- and nothing else.
#
# Exact rule set:
#   * piped form: a pipeline stage whose command word is `curl` or `wget` that
#     feeds a later stage of the same pipeline whose command word is a shell
#     interpreter (`sh`, `bash`, `zsh`, `dash`, or `eval`/`source`/`.`). Output
#     that passes through an intermediate stage still reaches the interpreter
#     (`curl ... | cat | sh`), so the whole pipeline is read, not only the
#     stage next to the download, and a stage whose own command word is a
#     substitution that runs a download (`$(curl ...) | sh`) counts too;
#   * substitution form: a `$(...)`, backtick, or unquoted `<(...)` payload
#     whose command word is `curl`/`wget` used as an argument of a runner
#     (`sh -c "$(curl ...)"`, `bash <(curl ...)`, `source <(curl ...)`), with
#     or without `-c`/`-s`, plus the words the runner itself executes: the
#     script a `-c`-style flag hands an interpreter (`sh -c "curl ... | sh"`,
#     `bash -lc "..."`) and every argument of `eval` (`eval "curl ... | sh"`).
#     `<(...)` is the read mirror, whose output a runner reads as a file; the
#     write mirror `>(...)` is out of scope, because the download's output does
#     not feed the runner there (`sh >(curl ...)` fetches, it does not run);
#   * wrapper prefixes are read at both ends, so the command word behind one is
#     the command: `env curl ... | sh`, `nice 5 curl ... | sh`,
#     `stdbuf -oL curl ... | sh`, `busybox sh -c "..."`,
#     `curl ... | env -i sh`, `curl ... | xargs sh`, `curl ... | busybox sh`.
#     `command -v X` only looks X up, so that lookup is not a command word;
#   * fail closed: a download that feeds a stage the scan cannot resolve
#     (`curl ... | $SHELL_CMD`, `curl ... | "$(echo sh)"`) is refused, never
#     silently allowed. An unterminated quote is unresolvable too, so a region
#     holding one is re-read with its quote characters dropped and refused when
#     the shape is still visible.
# Quotes fold into the words they build the shell's way, so `"curl" ... | sh`
# and `cu"rl" ... | sh` are the same command; single-quoted data and comments
# are inert (`echo 'curl | sh'`, `echo hi # curl | sh`); a backslash-newline
# continuation joins the words it splits; and ANSI-C `$'...'` quoting that
# spells its word plainly (`$'curl'`) builds that word literally, while an
# escape in it (`$'cur\x6c'`) makes the word unresolvable, which the receiver
# side then refuses. Deliberately allowed: a download to a file or into a
# redirect (`curl -o /tmp/x URL`, `curl URL > /tmp/x`), a download read
# downstream (`curl ... | jq .`, `curl ... | grep name`) or handed to a
# non-runner (`diff <(curl a) <(curl b)`), a plain `sh script.sh`, the
# two-statement download-then-run sequence, and every command the patterns do
# not name. Two documented over-refusals come from the same decision, that a
# curl/wget stage feeding an interpreter is refused whatever the download's own
# flags say: `curl -o /tmp/x URL | sh` writes to a file and feeds the pipe
# nothing, and `command -p curl --version | sh` prints a version banner rather
# than a script. Telling either apart from a download that does print needs the
# flag-arity knowledge this guard does not model. A here-document body is data,
# but it is scanned as live text, which can only over-refuse.
#
# The scan is linear in the size of the command, with a factor for substitution
# nesting (each level re-reads its region), which the depth cap bounds; a large
# flat command is one pass. Interpreters other than the four shells above and
# the shell's own eval/source forms are out of scope: this guard covers the
# foot-gun spellings, not every way to run code.

# Bypass env var for the pipe-to-shell guard.
BASH_PIPE_TO_SHELL_BYPASS_ENV = "PI_BASH_ALLOW_PIPE_TO_SHELL"

# The bypass env var is honored only when present at kernel start: the model
# can write os.environ, so a live read on each guard call would let a single
# os.environ assignment neuter the guard. The frozen copy cannot change after
# import; a value that appears mid-session only triggers a loud warning and
# is ignored.
_PIPE_TO_SHELL_BYPASS_AT_KERNEL_START = os.environ.get(
    BASH_PIPE_TO_SHELL_BYPASS_ENV
) not in (None, "", "0")

_pipe_to_shell_late_bypass_warned = False


class PipeToShellRefusalError(RuntimeError):
    """A curl/wget download that a shell interpreter would run was refused."""


# Commands whose output is remote code when the far end of a pipe is a URL.
_DOWNLOAD_COMMANDS = ("curl", "wget")

# Commands that run their stdin, their `-c` payload, or a named script as code.
# The set is deliberately these four: other shells (`ksh`, `ash`, `mksh`,
# `fish`) and other interpreters (`python3 -`, `perl`, `node`) are out of scope
# for this foot-gun guard.
_SHELL_INTERPRETERS = ("sh", "bash", "zsh", "dash")

# Interpreters, plus the shell's own run-a-string-builtin forms: `eval` and
# `source`/`.` run a payload the same way, so they are receivers too.
_RUNNERS = _SHELL_INTERPRETERS + ("eval", "source", ".")

# Wrapper commands that run another command: the word they name is the command
# word, so a download or an interpreter behind one of these is still that
# command (`env curl URL | sh`, `curl URL | nice sh`).
_WRAPPER_COMMANDS = (
    "env",
    "time",
    "nice",
    "nohup",
    "command",
    "builtin",
    "exec",
    "timeout",
    "stdbuf",
    "ionice",
    "xargs",
    "busybox",
    "sudo",
)

# Flags that consume the following word, per wrapper: only these take a value,
# so `env -i sh` keeps `sh` as the command word while `stdbuf -i 0 sh` does
# not (`-i` is boolean for env and a value flag for stdbuf). `env -a NAME`
# renames argv[0] of the command env runs, so the word it consumes is that
# name, not the command.
_WRAPPER_VALUE_FLAGS = {
    "env": ("-u", "-C", "-S", "-a"),
    "nice": ("-n",),
    "timeout": ("-s", "-k"),
    "stdbuf": ("-i", "-o", "-e"),
    "ionice": ("-c", "-n", "-p", "-P", "-u"),
    "sudo": ("-u", "-g", "-p", "-C", "-h", "-U", "-T", "-R", "-D"),
    "xargs": ("-I", "-E", "-L"),
}

# `command -v X` and `command -V X` only look X up, so the prefix ends there
# and X is never read as the command.
_WRAPPER_LOOKUP_FLAGS = ("-v", "-V")

# A `-c`-style flag (`-c`, `-lc`, `--command`) makes the next word a script the
# interpreter runs, so that word is scanned as a nested command.
_PAYLOAD_FLAG_RE = re.compile(r"^-[A-Za-z]*c[A-Za-z]*$")

# Operators that join the stages of one pipeline.
_PIPE_OPERATORS = ("|", "|&")

# Operators that group commands without ending a pipeline: `(curl URL) | sh`
# still pipes the download into the interpreter.
_GROUPING_OPERATORS = ("(", ")")

# Every character that ends a command stage.
_PIPE_SHELL_SEPARATORS = "\n;|&()"

# The stage separators that end one statement, not just one stage: a stage
# behind one of them starts a new command, so no pipeline state carries over.
_PIPE_SHELL_STATEMENT_SEPARATORS = (";", "\n", "&", "&&", "||")

# Characters a redirection operator can reach for as its target word.
_REDIRECT_OPERATOR_CHARS = "<>"

# POSIX `FOO=1` prefix words: the shell runs the rest of the stage with those
# variables bound, so `FOO=1 curl ... | sh` is still a download piped into sh.
_PIPE_SHELL_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# Reserved words that group, negate, or bracket a compound command without
# being the command themselves: `{ sh; } | curl` needs the brace skipped to see
# `sh`, `! curl ... | sh` needs the bang, and `if curl ... | sh; then ...`
# needs `if`/`then` so the pipeline inside a compound is still read; `coproc`
# starts its compound the same way, so `coproc { curl ... | sh; }` is the
# download piped into the shell the group runs.
_PIPE_SHELL_RESERVED_WORDS = (
    "!",
    "{",
    "}",
    "coproc",
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "do",
    "done",
    "while",
    "until",
    "for",
    "in",
    "case",
    "esac",
)

# A bare duration word a wrapper takes as its operand (`timeout 30s sh`).
_WRAPPER_DURATION_RE = re.compile(r"^\d+(\.\d+)?[smhd]?$")

# Nesting of command substitutions the scan follows before refusing outright.
_MAX_SUBSTITUTION_SCAN_DEPTH = 16

# Loose shape for a region an unterminated quote left unresolvable: with the
# quote characters dropped, a download word, a pipe, and an interpreter word
# after it are enough to refuse.
_LOOSE_PIPE_TO_SHELL_RE = re.compile(
    r"\b(?:curl|wget)\b[^;\n]*\|[^;\n]*\b(?:" + "|".join(_SHELL_INTERPRETERS) + r")\b"
)


@dataclass(frozen=True)
class _PipeShellWord:
    """One shell word: the value the shell would build for it, the command
    substitutions it carries, and whether the scan could resolve it."""

    value: str
    substitutions: tuple[tuple[int, int], ...]
    resolvable: bool
    # Whether quote characters built this word: a quoted word is data the
    # shell passed through, never a reserved word (`"{"` runs a program
    # named `{`; it does not open a brace group).
    quoted: bool = False


@dataclass(frozen=True)
class _PipeShellStage:
    """One command stage: the operator that ended it, its words, and the
    command substitutions a redirection took out of those words (the shell
    consumes the redirection, but its substitution still runs)."""

    separator: str
    words: tuple[_PipeShellWord, ...]
    target_substitutions: tuple[tuple[int, int], ...]
    # Here-document bodies feeding this stage (`sh <<EOF ... EOF`): the span
    # each body occupies and whether its delimiter was quoted (an unquoted
    # body's substitutions expand at read time), so the owner's script is
    # readable where the shell makes it one.
    heredoc_bodies: tuple[tuple[int, int, bool], ...] = ()


@dataclass(frozen=True)
class _PipeShellRegion:
    """One scanned region: its stages, the substitution interiors inside them,
    and whether an unterminated quote left the region unresolvable."""

    stages: tuple[_PipeShellStage, ...]
    substitutions: tuple[tuple[int, int], ...]
    unterminated_quote: bool


def _pipe_shell_command_name(value: str) -> str:
    """The command name a word runs: its basename, as the shell resolves it."""
    return value.rsplit("/", 1)[-1]


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


def _parenthesized_span(command: str, index: int, end: int) -> tuple[int, int]:
    """The interior span of the substitution whose opening parenthesis sits at
    `index`, with the caller passing the index of that `(` (`$(` and `<(` both
    pass `index + 1`). An unmatched opening keeps the rest of the region
    visible, so a truncated payload still scans."""
    close = _matching_paren(command, index, end)
    if close == end - 1 and command[end - 1 : end] != ")":
        return index + 1, end
    return index + 1, close


def _substitution_span(command: str, index: int, end: int) -> tuple[int, int] | None:
    """The interior span of the command substitution starting at `index`, or
    None when no substitution starts there. Both spellings are read: `$(...)`,
    with its parenthesis matched, and the backtick pair."""
    if command[index] == "`":
        # A backslash-escaped backtick does not close the substitution (the
        # shell only ends one at an unescaped backtick), so the close is
        # searched skipping escaped characters.
        close = index + 1
        while close < end:
            if command[close] == "\\" and close + 1 < end:
                close += 2
                continue
            if command[close] == "`":
                break
            close += 1
        else:
            close = -1
        return index + 1, end if close == -1 else close
    if command[index] == "$" and command[index + 1 : index + 2] == "(":
        return _parenthesized_span(command, index + 1, end)
    return None


def _process_substitution_span(command: str, index: int, end: int) -> tuple[int, int]:
    """The interior span of the process substitution starting at `<(`, whose
    output is a file the command reads. Only the unquoted spelling counts:
    quoting suppresses a process substitution the way it suppresses `$(...)`
    in some contexts, and `echo "<(cmd)"` must stay inert."""
    return _parenthesized_span(command, index + 1, end)


def _scan_redirect_operator(command: str, index: int, end: int) -> tuple[int, bool]:
    """Consume one redirection operator: the index after it, plus whether it
    duplicates a descriptor (`2>&1`, `>&2`), which has no target word."""
    if command[index] == "&":
        index += 1  # `&>` / `&>>`: both streams, one target word
    while index < end and command[index] in _REDIRECT_OPERATOR_CHARS:
        index += 1
    if index < end and command[index] == "&":
        duplicate_end = index + 1
        while duplicate_end < end and (
            command[duplicate_end].isdigit() or command[duplicate_end] == "-"
        ):
            duplicate_end += 1
        return duplicate_end, True
    return index, False


def _skip_redirect_target(
    command: str, index: int, end: int
) -> tuple[int, list[tuple[int, int]]]:
    """Consume one redirection target word, reporting the command
    substitutions inside it: the shell takes the redirection out of the argv,
    but a substitution in the target still runs."""
    substitutions: list[tuple[int, int]] = []
    quote = ""
    while index < end:
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = ""
            index += 1
            continue
        if quote == '"':
            if char == '"':
                quote = ""
                index += 1
                continue
            if char == "\\" and index + 1 < end:
                index += 2
                continue
            span = _substitution_span(command, index, end)
            if span is not None:
                substitutions.append(span)
                index = span[1] + 1
                continue
            index += 1
            continue
        if char == "<" and command[index + 1 : index + 2] == "(":
            # `sh < <(curl ...)`: the redirect target is a process substitution.
            span = _process_substitution_span(command, index, end)
            substitutions.append(span)
            index = span[1] + 1
            continue
        if (
            char in " \t\r\n"
            or char in _PIPE_SHELL_SEPARATORS
            or char in _REDIRECT_OPERATOR_CHARS
        ):
            break
        if char == "\\" and index + 1 < end:
            index += 2
            continue
        if char in "'\"":
            quote = char
            index += 1
            continue
        span = _substitution_span(command, index, end)
        if span is not None:
            substitutions.append(span)
            index = span[1] + 1
            continue
        index += 1
    return index, substitutions


def _scan_heredoc_delimiter(
    command: str, index: int, end: int
) -> tuple[int, tuple[str, bool] | None]:
    """Consume a here-document's `<<` operator and its delimiter word: the
    index after the delimiter, plus the delimiter and whether it was quoted.
    The body is read at the line's newline, so the line's own pipeline
    (`cat <<EOF | sh`) stays in the stream to be read as stages. Quoting the
    delimiter only stops the shell from expanding the body (a runner still
    executes its text), and `<<-` only strips tabs."""
    index += 2
    if index < end and command[index] == "-":
        index += 1
    while index < end and command[index] in " \t":
        index += 1
    delimiter = ""
    quoted = False
    while index < end:
        char = command[index]
        if char in "'\"":
            quoted = True
            index += 1
            continue  # quoting a delimiter only suppresses expansion
        if char in " \t\r\n" or char in _PIPE_SHELL_SEPARATORS:
            break
        delimiter += char
        index += 1
    if not delimiter:
        return index, None
    return index, (delimiter, quoted)


def _scan_heredoc_body(
    command: str, index: int, end: int, delimiter: str
) -> tuple[int, tuple[int, int] | None]:
    """Consume a here-document body at `index` (its opening newline): the
    index its delimiter line starts at, plus the body's span. A body whose
    delimiter line never comes runs to the end, and an empty one reads
    none."""
    body_start = index + 1
    line_start = body_start
    body_end = end
    while line_start < end:
        line_end = command.find("\n", line_start)
        if line_end == -1 or line_end >= end:
            break
        if command[line_start:line_end].lstrip("\t").rstrip("\r") == delimiter:
            body_end = line_start
            break
        line_start = line_end + 1
    if body_end <= body_start:
        return body_end, None
    return body_end, (body_start, body_end)


def _scan_pipe_shell_region(command: str, start: int, end: int) -> _PipeShellRegion:
    """Split command[start:end] into pipeline stages and their words.

    Quotes fold into the words they build (`"curl"` and `cu"rl"` both run
    curl), a backslash-newline continuation joins the words it splits, ANSI-C
    `$'...'` quoting builds its word literally, a `#` at a word boundary starts
    a comment that runs to the end of the line, and a redirection is consumed
    with its target word because the shell takes both out of the argv before
    the command runs. A command substitution keeps its interior text inside the
    enclosing word -- so a word carrying one never resolves -- while its
    interior span is reported for the caller to scan as live commands. This is
    a conservative approximation, not a parse: anything it cannot represent
    exactly is reported as unresolvable, never silently allowed.
    """
    from dataclasses import replace

    stages: list[_PipeShellStage] = []
    substitutions: list[tuple[int, int]] = []
    target_substitutions: list[tuple[int, int]] = []
    pending_heredocs: list[tuple[str, bool, int]] = []
    stage_heredoc_bodies: dict[int, list[tuple[int, int, bool]]] = {}
    words: list[_PipeShellWord] = []
    chars: list[str] = []
    word_start = -1
    word_substitutions: list[tuple[int, int]] = []
    word_quoted = False
    resolvable = True
    quote = ""
    index = start

    def flush_word(*, drop_numeric: bool = False) -> None:
        nonlocal chars, word_start, word_substitutions, word_quoted, resolvable
        if word_start != -1:
            value = "".join(chars)
            # A redirection's descriptor digit (`2>`) is not an argv word.
            if not (drop_numeric and value.isdigit()):
                words.append(
                    _PipeShellWord(
                        value, tuple(word_substitutions), resolvable, word_quoted
                    )
                )
        chars = []
        word_start = -1
        word_substitutions = []
        word_quoted = False
        resolvable = True

    def end_stage(separator: str) -> None:
        flush_word()
        stages.append(
            _PipeShellStage(
                separator,
                tuple(words),
                tuple(target_substitutions),
            )
        )
        words.clear()
        target_substitutions.clear()

    def start_word(offset: int) -> None:
        nonlocal word_start
        if word_start == -1:
            word_start = offset

    while index < end:
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = ""
            else:
                chars.append(char)
            index += 1
            continue
        if quote == '"':
            if char == '"':
                quote = ""
                index += 1
                continue
            if char == "\\" and index + 1 < end and command[index + 1] in '"\\$`':
                chars.append(command[index + 1])
                index += 2
                continue
            span = _substitution_span(command, index, end)
            if span is not None:
                start_word(index)
                word_substitutions.append(span)
                substitutions.append(span)
                resolvable = False
                chars.append(command[index : span[1] + 1])
                index = span[1] + 1
                continue
            if char == "$" or char == "`":
                resolvable = False  # an expansion the scan cannot follow
            chars.append(char)
            index += 1
            continue
        if char == "\\":
            if index + 1 < end and command[index + 1] == "\n":
                index += 2  # line continuation: the word around it continues
                continue
            if index + 1 < end:
                start_word(index)
                chars.append(command[index + 1])
                index += 2
                continue
            resolvable = False  # a region cut in half by a continuation
            index += 1
            continue
        if char in " \t\r":
            flush_word()
            index += 1
            continue
        if char == "#" and word_start == -1:
            while index < end and command[index] != "\n":
                index += 1
            continue
        if char == "<" and command[index + 1 : index + 2] == "(":
            # `<(...)` with no space is a process substitution (a file the
            # command reads); `< (` with a space is a redirect, so this test
            # runs before the redirection branch.
            start_word(index)
            span = _process_substitution_span(command, index, end)
            word_substitutions.append(span)
            substitutions.append(span)
            resolvable = False
            chars.append(command[index : span[1] + 1])
            index = span[1] + 1
            continue
        if char in _REDIRECT_OPERATOR_CHARS or (
            char == "&" and command[index + 1 : index + 2] in ("<", ">")
        ):
            if command[index : index + 2] == ">(":
                # A write process substitution: the redirection feeds this
                # process its bytes on stdin, so a runner there executes them.
                flush_word(drop_numeric=True)
                span = _parenthesized_span(command, index + 1, end)
                substitutions.append(span)
                target_substitutions.append(span)
                index = span[1] + 1
                continue
            if command[index : index + 2] == "<<" and command[index + 2 : index + 3] != "<":
                # A here-document's body is stdin below the line's newline, so
                # only its delimiter is consumed here: the line's own pipeline
                # (`cat <<EOF | sh`) is read as stages, and the body is
                # attached to the stage that owns the `<<`.
                flush_word(drop_numeric=True)
                index, pending = _scan_heredoc_delimiter(command, index, end)
                if pending is not None:
                    pending_heredocs.append((*pending, len(stages)))
                continue
            flush_word(drop_numeric=True)
            index, duplicates = _scan_redirect_operator(command, index, end)
            if not duplicates:
                while index < end and command[index] in " \t":
                    index += 1
                if index < end and (
                    command[index] not in _PIPE_SHELL_SEPARATORS
                    and command[index] not in _REDIRECT_OPERATOR_CHARS
                ):
                    index, nested = _skip_redirect_target(command, index, end)
                    substitutions.extend(nested)
                    target_substitutions.extend(nested)
            continue
        if char in _PIPE_SHELL_SEPARATORS:
            resume = None
            if char == "\n" and pending_heredocs:
                # The here-document bodies start below this newline, in the
                # order their `<<` operators appeared, and each ends at its
                # own delimiter line, where the stream resumes.
                cursor = index
                open_newline = index
                for (
                    pending_delimiter,
                    pending_quoted,
                    pending_stage,
                ) in pending_heredocs:
                    cursor, body = _scan_heredoc_body(
                        command, open_newline, end, pending_delimiter
                    )
                    if body is not None:
                        stage_heredoc_bodies.setdefault(pending_stage, []).append(
                            (*body, pending_quoted)
                        )
                    delimiter_newline = command.find("\n", cursor)
                    if delimiter_newline == -1 or delimiter_newline >= end:
                        break
                    # The next body starts below the delimiter line's
                    # newline, which is the opening newline
                    # _scan_heredoc_body expects.
                    open_newline = delimiter_newline
                    cursor = delimiter_newline + 1
                # Each consumed body's delimiter line is here-document
                # mechanics, not stages: the stream resumes past its newline.
                resume = cursor
                pending_heredocs.clear()
            operator = char
            follower = command[index + 1 : index + 2]
            if char in "|&" and follower == char:
                operator = char * 2  # `||` and `&&` are not pipes
                index += 1
            elif char == "|" and follower == "&":
                operator = "|&"  # stderr and stdout both reach the next stage
                index += 1
            end_stage(operator)
            index = resume if resume is not None else index + 1
            continue
        if char == "$" and command[index + 1 : index + 2] == "'":
            start_word(index)
            word_quoted = True
            index += 2
            closed = False
            while index < end:
                if command[index] == "\\" and index + 1 < end:
                    resolvable = False  # ANSI-C escapes can spell any byte
                    index += 1
                    chars.append(command[index])
                    index += 1
                    continue
                if command[index] == "'":
                    closed = True
                    index += 1
                    break
                chars.append(command[index])
                index += 1
            if not closed:
                quote = "'"
            continue
        span = _substitution_span(command, index, end)
        if span is not None:
            start_word(index)
            word_substitutions.append(span)
            substitutions.append(span)
            resolvable = False
            chars.append(command[index : span[1] + 1])
            index = span[1] + 1
            continue
        if char in "'\"":
            start_word(index)
            word_quoted = True
            quote = char
            index += 1
            continue
        if char == "$" or char == "`":
            resolvable = False  # an expansion the scan cannot follow
        start_word(index)
        chars.append(char)
        index += 1
    end_stage("")
    stages = [
        replace(stage, heredoc_bodies=tuple(stage_heredoc_bodies.get(position, ())))
        for position, stage in enumerate(stages)
    ]
    return _PipeShellRegion(tuple(stages), tuple(substitutions), bool(quote))


def _stage_command_word(
    words: tuple[_PipeShellWord, ...],
) -> tuple[_PipeShellWord, int] | None:
    """The word a stage would run, with its index: the first word after the
    prefix the shell consumes before the command runs.

    The prefix is read in one interleaved pass because its parts compose in any
    order: assignments (`FOO=1`), wrapper commands (`env`, `nice`, `xargs`,
    `sudo`), their flags and value words (`sudo -u root`, `timeout 5`), and
    bare numbers (`nice 5 curl ...`). `command -v X` only looks X up, so that
    lookup ends the prefix instead of handing X to the scan."""
    index = 0
    while index < len(words):
        value = words[index].value
        name = _pipe_shell_command_name(value)
        if _PIPE_SHELL_ASSIGNMENT_RE.match(value):
            index += 1
            continue
        if value in _PIPE_SHELL_RESERVED_WORDS and not words[index].quoted:
            # A quoted word is data the shell passed through, not a reserved
            # word, so `"{" sh` runs a program named `{`.
            index += 1
            continue
        if name not in _WRAPPER_COMMANDS:
            break
        if (
            name == "command"
            and words[index + 1 : index + 2]
            and words[index + 1].value in _WRAPPER_LOOKUP_FLAGS
        ):
            break
        index += 1
        value_flags = _WRAPPER_VALUE_FLAGS.get(name, ())
        while index < len(words) and words[index].value.startswith("-"):
            _, cluster_operand = _wrapper_cluster_flags(name, words[index].value)
            if words[index].value in value_flags or cluster_operand:
                index += 2
            else:
                index += 1
        if index < len(words) and (
            words[index].value.isdigit()
            or (name == "timeout" and _WRAPPER_DURATION_RE.match(words[index].value))
        ):
            index += 1
    if index >= len(words):
        return None
    return words[index], index


def _region_runs_download(command: str, start: int, end: int, depth: int = 0) -> bool:
    """Whether this region runs curl/wget as a command word, at any nesting."""
    if depth > _MAX_SUBSTITUTION_SCAN_DEPTH:
        return True  # absurdly nested: refuse rather than risk a miss
    region = _scan_pipe_shell_region(command, start, end)
    for stage in region.stages:
        resolved = _stage_command_word(stage.words)
        if resolved is not None and _pipe_shell_command_name(resolved[0].value) in _DOWNLOAD_COMMANDS:
            return True
        for body_start, body_end, _quoted in stage.heredoc_bodies:
            # A here-document body inside this region is live text: whatever
            # the region feeds runs it, and a download spelled in it counts
            # (`sh -c "$(cat <<EOF ... curl ... EOF ...)"`).
            if _region_runs_download(command, body_start, body_end, depth + 1):
                return True
    return any(
        _region_runs_download(command, nested_start, nested_end, depth + 1)
        for nested_start, nested_end in region.substitutions
    )


def _word_runs_download(command: str, word: _PipeShellWord) -> bool:
    """Whether a word's own substitutions run a download, so a stage whose
    command word is one (`$(curl ...) | sh`) feeds the download downstream."""
    return any(
        _region_runs_download(command, nested_start, nested_end)
        for nested_start, nested_end in word.substitutions
    )


def _stage_payload_runs_download(stage: _PipeShellStage, command_index: int) -> bool:
    """Whether the words a runner was handed are a download it would run.

    Each runner takes its code differently, so each reads its own words: a
    `-c`-style flag hands an interpreter one script (`sh -c "curl URL | sh"`,
    `bash -lc "..."`), `eval` runs every non-flag argument it is given
    (`eval "curl URL | sh"`), and `source`/`.` runs the file its first argument
    names. Words a runner does not execute are left alone, so a script argument
    (`sh deploy.sh 'curl URL | sh'`) and a script path
    (`. /dev/stdin 'curl URL | sh'`) stay data."""
    words = stage.words
    name = _pipe_shell_command_name(words[command_index].value)
    if name == "eval":
        # `eval` passes every argument through to the shell as script text
        # (it has no flags of its own), so nothing is filtered before joining.
        args = list(words[command_index + 1 :])
        # `eval` concatenates its arguments into one script, so a pipeline that
        # only exists after joining (`eval "curl U" "| sh"`) must be read joined.
        joined = " ".join(word.value for word in args)
        if joined and _pipe_shell_violation(joined) is not None:
            return True
        return any(
            _pipe_shell_violation(word.value) is not None for word in args
        )
    if name in ("source", "."):
        operand = words[command_index + 1 : command_index + 2]
        return bool(operand) and _pipe_shell_violation(operand[0].value) is not None
    for index in range(command_index + 1, len(words) - 1):
        value = words[index].value
        if value == "--command" or _PAYLOAD_FLAG_RE.match(value):
            if _pipe_shell_violation(words[index + 1].value) is not None:
                return True
    return False


def _stage_args_run_download(
    command: str, stage: _PipeShellStage, command_index: int
) -> bool:
    """Whether a shell interpreter's argv carries a substitution that runs a
    download of its own (`sh -c "$(curl ...)"`, `sh <<< "$(curl ...)"`)."""
    nested_spans = [
        span
        for word in stage.words[command_index + 1 :]
        for span in word.substitutions
    ]
    nested_spans.extend(stage.target_substitutions)
    return any(
        _region_runs_download(command, nested_start, nested_end)
        for nested_start, nested_end in nested_spans
    )


def _heredoc_read_time_text(body: str) -> str:
    r"""The text an unquoted here-document body delivers: the read-time pass
    unescapes `$`, the backtick, and the backslash (`\$` becomes `$`) and
    drops a backslash-newline, so the shell that reads the body parses what
    the raw text kept escaped."""
    out: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char == "\\" and index + 1 < len(body):
            if body[index + 1] == "\n":
                index += 2
                continue
            if body[index + 1] in ("$", "`", "\\"):
                out.append(body[index + 1])
                index += 2
                continue
        out.append(char)
        index += 1
    return "".join(out)


def _heredoc_text_runs_a_download(text: str, depth: int) -> bool:
    """Whether a here-document body's own text runs a download through a
    shell: the violation scan of the text plus the command-word walk of its
    stages (`sh <<EOF` ... `$(curl ...) ... `EOF` -- the runner executes the
    expansion's output as a command, and the word carrying the substitution,
    not the region scan, is what names it)."""
    if _pipe_shell_violation(text, 0, None, depth + 1) is not None:
        return True
    region = _scan_pipe_shell_region(text, 0, len(text))
    for body_stage in region.stages:
        resolved = _stage_command_word(body_stage.words)
        if resolved is not None and _word_runs_download(text, resolved[0]):
            return True
    return False


def _stage_heredoc_body_runs_download(
    command: str, stage: _PipeShellStage, depth: int = 0
) -> bool:
    """Whether this stage's here-document bodies are a script that runs a
    download through a shell: a runner (`sh <<EOF`) executes the body's text,
    whether the pipeline is spelled in the body or arrives through a
    `$(curl ...)` the shell expands first, and a stage whose stdout continues
    into a runner hands it the same text, so the caller reads it the same
    way."""
    for body_start, body_end, quoted in stage.heredoc_bodies:
        if _heredoc_text_runs_a_download(command[body_start:body_end], depth):
            return True
        if not quoted:
            # The read-time pass unescapes `\$` (and `\\`) before the
            # runner parses the body, so a `\$`-hidden `$(curl ...)` the raw
            # text kept inert arrives as live text: scan the delivered text
            # too.
            delivered = _heredoc_read_time_text(command[body_start:body_end])
            if delivered != command[body_start:body_end] and (
                _heredoc_text_runs_a_download(delivered, depth)
            ):
                return True
    return False


def _wrapper_cluster_flags(name: str, value: str) -> tuple[bool, bool]:
    """(shell flag, next word is an operand) for a bundled short-option
    cluster, read the way getopt reads it: left to right, where the FIRST
    value-taking character either ends the cluster (`-su root` binds root as
    `-u`'s operand) or has the rest attached as its operand (`-uMath sh`:
    `Math` is the operand and `sh` stays the command)."""
    if not value.startswith("-") or value.startswith("--") or len(value) < 2:
        return False, False
    value_chars = {
        flag[1:] for flag in _WRAPPER_VALUE_FLAGS.get(name, ()) if len(flag) == 2
    }
    shell = False
    for position, char in enumerate(value[1:]):
        if char in value_chars:
            takes_next = len(value) - 2 == position
            return shell, takes_next
        if name == "sudo" and char in ("s", "i"):
            shell = True
    return shell, False


def _stage_env_s_operand(words: tuple[_PipeShellWord, ...]) -> _PipeShellWord | None:
    """The operand a `env -S` prefix hands the shell as argv, or None. GNU env
    runs the string as a command line, so the operand is live text."""
    for index, word in enumerate(words):
        if _pipe_shell_command_name(word.value) == "env":
            cursor = index + 1
            while cursor < len(words):
                value = words[cursor].value
                # The exact forms and the attached forms come first: an
                # attached `-S<...>` operand does not end in S by accident
                # of its payload (`-S'echo S'` is the attached form, not a
                # cluster).
                if value in ("-S", "--split-string"):
                    return words[cursor + 1] if cursor + 1 < len(words) else None
                if value.startswith("-S") and len(value) > 2:
                    return _PipeShellWord(value[2:], (), True, True)
                if value.startswith("--split-string="):
                    return _PipeShellWord(value[len("--split-string=") :], (), True, True)
                if (
                    value.startswith("-")
                    and not value.startswith("--")
                    and value.endswith("S")
                    and len(value) > 1
                ):
                    # A bundled cluster ending in the -S flag (`-iS`) takes
                    # the next word as its operand.
                    return words[cursor + 1] if cursor + 1 < len(words) else None
                if value.startswith("-"):
                    _, cluster_operand = _wrapper_cluster_flags("env", value)
                    cursor += 2 if cluster_operand else 1
                    continue
                break
    return None


def _text_runs_download(text: str, depth: int = 0) -> bool:
    """Whether a command-line string runs curl/wget anywhere in it: as a
    stage's command word, or inside a word the string carries (a `-c` payload
    `sh -c "curl URL"` folded to one word)."""
    if depth > 4:
        return True  # fail closed: absurdly nested text
    region = _scan_pipe_shell_region(text, 0, len(text))
    for stage in region.stages:
        resolved = _stage_command_word(stage.words)
        if resolved is not None and _pipe_shell_command_name(resolved[0].value) in _DOWNLOAD_COMMANDS:
            return True
        for word in stage.words:
            # Only a word that carries shell separators can hold a nested
            # script (`sh -c "curl URL"` folds to one word); a bare token
            # (`echo`, `hi`) is never a script of its own.
            if any(
                char.isspace() or char in _PIPE_SHELL_SEPARATORS
                for char in word.value
            ) and _text_runs_download(word.value, depth + 1):
                return True
    return False


def _stage_targets_run_shell(command: str, stage: _PipeShellStage) -> bool:
    """Whether a redirection target of this stage is a process substitution
    that runs a shell: `>(sh)` receives the stage's output on stdin and
    executes it."""
    for start, end in stage.target_substitutions:
        region = _scan_pipe_shell_region(command, start, end)
        for inner in region.stages:
            resolved = _stage_command_word(inner.words)
            if resolved is not None and _pipe_shell_command_name(resolved[0].value) in _RUNNERS:
                return True
            if resolved is None and _stage_runs_stdin_shell(inner.words):
                return True
    return False


def _stage_runs_stdin_shell(words: tuple[_PipeShellWord, ...]) -> bool:
    """Whether a wrapper-only stage starts a shell reading stdin: `sudo -s`
    and `sudo -i` with no further command run the user's shell with the
    pipeline's output on stdin, exactly like a bare `sh`."""
    for index, word in enumerate(words):
        if _pipe_shell_command_name(word.value) == "sudo":
            value_flags = _WRAPPER_VALUE_FLAGS.get("sudo", ())
            cursor = index + 1
            shell_flag = False
            while cursor < len(words):
                value = words[cursor].value
                if value in value_flags:
                    cursor += 2  # the flag's operand is not a command
                    continue
                cluster_shell, cluster_operand = _wrapper_cluster_flags("sudo", value)
                if cluster_operand:
                    if cluster_shell:
                        # A bundled cluster can carry both (`-su`: the shell
                        # flag and the operand-taking `-u` at its tail).
                        shell_flag = True
                    cursor += 2  # the flag's operand is not a command
                elif value in ("--shell", "--login"):
                    shell_flag = True
                    cursor += 1
                elif (
                    value.startswith("-")
                    and not value.startswith("--")
                    and len(value) > 1
                    and ("s" in value or "i" in value)
                ):
                    # A combined short cluster containing -s or -i (`-si`)
                    # starts the shell the same way.
                    shell_flag = True
                    cursor += 1
                elif value.startswith("-"):
                    cursor += 1
                else:
                    return False  # a command follows: this is a normal sudo
            return shell_flag
    return False


def _continuation_runs_shell(region: _PipeShellRegion, position: int) -> bool:
    """Whether the stages this one pipes into (its own continuation, not the
    whole region) run a shell: a here-document body is read as a script only
    when the pipe chain it feeds actually reaches an interpreter."""
    cursor = position + 1
    # The caller walks only stages whose separator is a pipe, so the
    # pipeline is open until its right-hand side arrives -- the same
    # pipeline-open tracking _pipe_shell_stage_violation reads.
    pipeline_open = True
    while cursor < len(region.stages):
        stage = region.stages[cursor]
        if stage.words:
            resolved = _stage_command_word(stage.words)
            if resolved is not None:
                if _pipe_shell_command_name(resolved[0].value) in _RUNNERS:
                    return True
            elif _stage_runs_stdin_shell(stage.words):
                return True
            pipeline_open = stage.separator in _PIPE_OPERATORS
            if (
                stage.separator not in _PIPE_OPERATORS
                and stage.separator not in _GROUPING_OPERATORS
            ):
                # A grouping separator continues the chain (`cat <<EOF | (sh)`
                # pipes into the subshell's sh); the pipeline's right-hand
                # side has arrived, so a statement after it is a new chain.
                return False
        elif (
            stage.separator in _PIPE_SHELL_STATEMENT_SEPARATORS
            and not pipeline_open
        ):
            # An empty stage is a statement separator or a blank line: it
            # ends the chain only once the pipeline's right-hand side has
            # arrived (`cat <<EOF | (wc)` body `EOF` blank `sh` hands the
            # body to the group's wc, and the sh past the blank line is a
            # fresh statement); until then the blanks still belong to the
            # open pipeline and feed the receiver its body.
            return False
        cursor += 1
    return False


def _stage_body_substitution_violation(
    command: str, stage: _PipeShellStage, depth: int
) -> str | None:
    """Why the substitutions of an unquoted here-document body run a
    download through a shell, whatever stage owns the body. The shell
    expands an unquoted body at read time, so `cat <<EOF` ... `$(curl ... |
    sh)` ... `EOF` runs the pipeline inside the substitution without the
    body's text ever reaching a runner; a quoted delimiter leaves the body
    inert data."""
    for body_start, body_end, quoted in stage.heredoc_bodies:
        if quoted:
            continue
        region = _scan_pipe_shell_region(command, body_start, body_end)
        for nested_start, nested_end in region.substitutions:
            violation = _pipe_shell_violation(
                command, nested_start, nested_end, depth + 1
            )
            if violation is not None:
                return violation
    return None


def _pipe_shell_stage_violation(
    command: str, region: _PipeShellRegion, depth: int = 0
) -> str | None:
    """Why these stages run a download through a shell, or None."""
    piped_download = False
    brace_depth = 0
    paren_depth = 0
    # A pipe separator opens the pipeline until its right-hand side arrives:
    # blank lines and grouping between the two do not end it (real bash reads
    # `curl U |` newline newline `sh` as one pipeline).
    pipeline_open = False
    for position, stage in enumerate(region.stages):
        if not stage.words:
            # An empty stage is a grouping character, a doubled operator, or
            # the newline of a continued pipeline (`curl ... |` newline `sh`).
            # A statement separator does end the chain: `(curl URL); sh` runs
            # two statements, and the second one inherits no pipeline state.
            # The newline right after a pipe only continues that pipeline.
            if stage.separator == "(":
                paren_depth += 1
            elif stage.separator == ")":
                paren_depth = max(0, paren_depth - 1)
            elif (
                stage.separator in _PIPE_SHELL_STATEMENT_SEPARATORS
                and not pipeline_open
            ):
                piped_download = False
            continue
        if stage.words[0].value == "{" and not stage.words[0].quoted:
            # A brace group keeps the stages inside it feeding the same
            # pipeline (`{ curl ...; } | sh`), so the separators inside it
            # must not end the chain.
            brace_depth += 1
        resolved = _stage_command_word(stage.words)
        if resolved is None and piped_download and _stage_runs_stdin_shell(
            stage.words
        ):
            return "a download piped into a shell"
        if resolved is None and piped_download and any(
            not word.resolvable for word in stage.words
        ):
            # A stage that resolves no command word at all (`env -a $(sh)`,
            # `FOO=$(sh)`): a wrapper value flag or an assignment consumed the
            # substitution as its operand, and that substitution runs with
            # the pipeline on stdin, so the unreadable operand may be the
            # receiver -- the same fail-closed rule as the unresolvable
            # command word, applied to the only argv the stage has.
            return "a download piped into a command the scan cannot resolve"
        if resolved is not None:
            word, command_index = resolved
            name = _pipe_shell_command_name(word.value)
            if piped_download:
                if name in _RUNNERS:
                    return "a download piped into a shell"
                if not word.resolvable:
                    # Fail closed: the receiver cannot be read, so it cannot be
                    # cleared either.
                    return "a download piped into a command the scan cannot resolve"
                if any(
                    not prefix.resolvable for prefix in stage.words[:command_index]
                ):
                    # A resolved command word can still be preceded by a
                    # prefix word the scan cannot read (`env -a $(sh) cat`,
                    # `FOO=$(sh) grep x`): the wrapper or assignment consumed
                    # the substitution as its operand, and that substitution
                    # runs with the pipeline on stdin, so the unreadable word
                    # may execute the download before the command the scan
                    # did resolve.
                    return "a download piped into a command the scan cannot resolve"
            if (
                name in _DOWNLOAD_COMMANDS
                or _word_runs_download(command, word)
                # Fail closed: an unresolvable producer (`$(printf curl) URL |
                # sh`) could be the download itself, so the receiver decides.
                or not word.resolvable
            ):
                piped_download = True
            elif name in _RUNNERS and (
                _stage_args_run_download(command, stage, command_index)
                or _stage_payload_runs_download(stage, command_index)
                or _stage_heredoc_body_runs_download(command, stage, depth)
            ):
                return "a download substituted into a shell"
        if piped_download and _stage_targets_run_shell(command, stage):
            # A `>(sh)` target receives this stage's output and executes it.
            return "a download piped into a shell"
        env_s_operand = _stage_env_s_operand(stage.words)
        if env_s_operand is not None:
            # `env -S` runs its operand as a command line.
            violation = _pipe_shell_violation(
                env_s_operand.value, 0, None, depth + 1
            )
            if violation is not None:
                return violation
            if _text_runs_download(env_s_operand.value):
                piped_download = True
            operand_region = _scan_pipe_shell_region(
                env_s_operand.value, 0, len(env_s_operand.value)
            )
            for operand_stage in operand_region.stages:
                operand_resolved = _stage_command_word(operand_stage.words)
                if operand_resolved is not None and _pipe_shell_command_name(
                    operand_resolved[0].value
                ) in _RUNNERS:
                    # The operand names the runner, so the stage's other
                    # inputs are that runner's payload (`env -S 'sh' <
                    # <(curl ...)` reads the mirror into the sh it starts).
                    if _stage_args_run_download(
                        command, stage, operand_resolved[1]
                    ) or _stage_heredoc_body_runs_download(command, stage, depth):
                        return "a download substituted into a shell"
        if stage.heredoc_bodies and not (
            resolved is not None and _pipe_shell_command_name(resolved[0].value) in _RUNNERS
        ):
            # A stage that is not itself a runner holds its here-document
            # bodies as data, with the two reads the shell forces anyway: the
            # substitutions of an unquoted body expand at read time whatever
            # the owner, and a body whose owner's stdout continues into a
            # runner of this region is that runner's script.
            violation = _stage_body_substitution_violation(command, stage, depth)
            if violation is not None:
                return violation
            if (
                stage.separator in _PIPE_OPERATORS
                and _continuation_runs_shell(region, position)
                and _stage_heredoc_body_runs_download(command, stage, depth)
            ):
                return "a download piped into a shell"
        if stage.words:
            pipeline_open = stage.separator in _PIPE_OPERATORS
        if brace_depth and stage.words[-1].value == "}" and not stage.words[-1].quoted:
            # Close the group before the reset check: a group that ends on a
            # statement separator (`{ curl URL; }; sh`) leaves no pipeline
            # state for the next statement.
            brace_depth -= 1
        if stage.separator == "(":
            paren_depth += 1
        elif stage.separator == ")":
            # A group usually closes on its last command's separator
            # (`(echo start)`), not on an empty stage, so the word stages
            # balance the depth the empty `(` opens: a depth left open pins
            # one statement's pipeline state onto the next.
            paren_depth = max(0, paren_depth - 1)
        if (
            stage.separator not in _PIPE_OPERATORS
            and stage.separator not in _GROUPING_OPERATORS
            and brace_depth == 0
            and paren_depth == 0
        ):
            piped_download = False
    return None


def _loose_shell_text(text: str) -> str:
    """Text with its quote and escape characters dropped, for the fail-closed
    re-read of a region an unterminated quote left unresolvable."""
    return text.replace("'", "").replace('"', "").replace("\\", "")


def _pipe_shell_violation(
    command: str, start: int = 0, end: int | None = None, depth: int = 0
) -> str | None:
    """Why `command` would run a curl/wget download through a shell, or None.

    The scan is text-only: the same command is refused whether or not the URL
    answers, and nothing is fetched, spawned, or executed to decide.
    """
    if end is None:
        end = len(command)
    if depth > _MAX_SUBSTITUTION_SCAN_DEPTH:
        # Fail closed, but state only what the scan knows: the region was not
        # read, so it cannot be cleared.
        return "substitutions nested too deeply for the scan to read"
    region = _scan_pipe_shell_region(command, start, end)
    violation = _pipe_shell_stage_violation(command, region, depth)
    if violation is not None:
        return violation
    for nested_start, nested_end in region.substitutions:
        violation = _pipe_shell_violation(command, nested_start, nested_end, depth + 1)
        if violation is not None:
            return violation
    if region.unterminated_quote and _LOOSE_PIPE_TO_SHELL_RE.search(
        _loose_shell_text(command[start:end])
    ):
        return "a download piped or substituted into a shell"
    return None


def _format_pipe_to_shell_refusal(violation: str) -> str:
    return "\n".join(
        [
            "Refusing to run this command: piping or substituting curl/wget",
            "output into a shell interpreter downloads and executes remote code",
            f"without review ({violation}).",
            "",
            "Download the script to a file, read the file, then run it in a",
            "later command (curl -o script.sh URL, then sh script.sh).",
            "",
            "If the download is trusted, retry with",
            "bash(command, allow_pipe_to_shell=True), or start the kernel with",
            f"{BASH_PIPE_TO_SHELL_BYPASS_ENV}=1; the variable is frozen at kernel start,",
            "so writing it mid-session never unlocks the guard.",
        ]
    )


def _warn_once_about_late_pipe_to_shell_bypass() -> None:
    """Warn (once) when the bypass env var appears mid-session.

    The frozen launch-time copy is the only honored bypass, so a value that
    shows up later is ignored; one os.environ write cannot unlock the guard.
    Warn loudly so a deliberate bypass takes the documented path (restart the
    kernel with the variable set) instead of looking like a no-op."""
    global _pipe_to_shell_late_bypass_warned
    if _pipe_to_shell_late_bypass_warned:
        return
    value = os.environ.get(BASH_PIPE_TO_SHELL_BYPASS_ENV)
    if value is None or value in ("", "0"):
        return
    _pipe_to_shell_late_bypass_warned = True
    print(
        f"prime-agent bash: {BASH_PIPE_TO_SHELL_BYPASS_ENV} appeared after"
        " kernel start and is ignored; the pipe-to-shell guard only honors it"
        " when the kernel is started with it set.",
        file=sys.stderr,
        flush=True,
    )


def _guard_pipe_to_shell(script: str, allow_pipe_to_shell: bool) -> None:
    """Refuse a curl/wget download that a shell interpreter would run: piped
    into one, or substituted into its argv. The caller passes the script the
    shell will run, prefix included, so the text this scan reads and the text
    the handle executes are one string. The scan is string-only and runs
    before any spawn, so a refused command never starts a process, and a
    command the patterns do not name pays for one linear pass."""
    if allow_pipe_to_shell or _PIPE_TO_SHELL_BYPASS_AT_KERNEL_START:
        return
    violation = _pipe_shell_violation(script)
    if violation is None:
        return
    _warn_once_about_late_pipe_to_shell_bypass()
    raise PipeToShellRefusalError(_format_pipe_to_shell_refusal(violation))

# Privilege escalation (sudo/doas) is the one class no other guard can contain:
# a command that becomes root escapes every per-command restriction below, so it
# is refused before any process starts.
BASH_SUDO_BYPASS_ENV = "PI_BASH_ALLOW_SUDO"
# Frozen at import: the model can write os.environ mid-session, so a live read
# would let one write neuter the guard. Late writes only warn (see below).
_SUDO_BYPASS_AT_KERNEL_START = os.environ.get(BASH_SUDO_BYPASS_ENV) not in (None, "", "0")
_sudo_late_bypass_warned = False


class PrivilegeEscalationRefusalError(RuntimeError):
    """Raised when a command would run as root (or another user) via sudo/doas."""


@dataclass
class _Word:
    """One shell word/operator/redirect with its position and quote-folded value."""

    value: str
    start: int
    end: int
    kind: str = "word"
    starts_command: bool = False
    has_expansion: bool = False
    is_operand: bool = False
    is_assignment: bool = False
    is_data: bool = False
    heredoc: str | None = None
    heredoc_delim: str | None = None
    heredoc_body: str | None = None

    @property
    def is_operator(self) -> bool:
        return self.kind == "operator"

    @property
    def is_redirect(self) -> bool:
        return self.kind == "redirect"


_SUDO_COMMAND_WORDS = frozenset({"sudo", "doas"})
# A word that is itself a plausible program name: letters, digits, and the
# punctuation real executable names use. Such a word is judged by its basename
# alone, so `sudoku` and `sudo-report` stay runnable; the letters fallback below
# then only covers words that carry quoting or expansion (`${SUDO_CMD:-sudo}`,
# `su do`, `\"sudo\"`), where the folded value is not a literal program name.
_PLAIN_COMMAND_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*")
_WRAPPERS = frozenset(
    {
        "env",
        "nice",
        "nohup",
        "stdbuf",
        "timeout",
        "setsid",
        "ionice",
        "builtin",
        "exec",
        "busybox",
        "strace",
        "ltrace",
        "watch",
        "faketime",
        "systemd-run",
        "chroot",
    }
)
# These report on a program instead of running it, so a later sudo/doas is a name
# being looked up, not a command being escalated.
_LOOKUP_COMMANDS = frozenset({"type", "which", "whereis"})
_SHELL_RUNNERS = frozenset({"sh", "bash", "zsh", "dash"})
_PAYLOAD_RUNNERS = _SHELL_RUNNERS | frozenset({"eval", "source", "."})
# Compound-command words are syntax, not programs: skipping them lets the body's
# command word (e.g. sudo after `do`/`then`/`else`) reach the command position.
_KEYWORDS = frozenset(
    {
        "!",
        "time",
        "if",
        "then",
        "elif",
        "else",
        "fi",
        "do",
        "done",
        "while",
        "until",
        "for",
        "in",
        "case",
        "esac",
        "coproc",
    }
)
_BREAK_CHARS = frozenset(";&|()<>")
_REDIRECT_OPERATORS = ("<<<", "<<-", "<<", ">>", "<>", ">&", "<&", ">|", ">", "<")
_MAX_PAYLOAD_DEPTH = 6
_DEPTH_VIOLATION = "the payload nests deeper than the sudo scan can follow"
# Value-taking options of a wrapper: their operand is a value or (for env
# -S/--split-string) a whole command line, never the command the wrapper runs.
# Value-taking options per wrapper, from each tool's usage synopsis. Both a missing
# value option and a wrongly value-taking boolean stop the walk (it then reads the
# operand as the command, or the command as an operand), so the boolean options are
# listed beside their tool for review:
#   env: -i/--ignore-environment, -0/--null, -v/--debug boolean; -u, -C, -S, and
#     the GNU -a/--argv0 (9.5+) and --env0-from (9.12+) take a value, as does BSD
#     -P ALTPATH. The --block/--default/--ignore-signal options are
#     optional-argument (written --opt=SIG), so they must not eat the next word.
#   timeout: -s/--signal, -k/--kill-after take a value; --preserve-status,
#     --foreground, -v/--verbose boolean.
#   stdbuf: -i, -o, -e take a value; no boolean options.
#   ionice: -c/--class, -n/--classdata, -p/--pid, -P/--pgid, -u/--uid take a value;
#     -t/--ignore boolean.
#   nice: -n/--adjustment takes a value; -h, -V are help/version.
#   exec: -a NAME takes a value; -l and -c boolean.
#   strace: the short -a -b -e -E -I -o -O -p -P -s -S -u -U -X and the long
#     forms taking a required argument (src/strace.c longopts: --abbrev, --argv0,
#     --attach, --color, --columns, --const-print-style, --decode-pids,
#     --detach-on, --env, --fault, --inject, --interruptible, --kvm, --output,
#     --raw, --read, --signals, --stack-trace-frame-limit, --status,
#     --string-limit, --summary-columns, --summary-sort-by,
#     --summary-syscall-overhead, --syscall-limit, --trace, --trace-fds,
#     --trace-path, --user, --verbose, --write) take a value; -c -C -D -f -i -k
#     -n -q -t -T -v -V -w -x -y -z boolean, including -DDD. strace's other long
#     options are boolean or optional-argument.
#   ltrace: -A -a -d -D -e -F -l -n -o -p -s -u -w -x take a value, and so do the
#     longs with a required argument in options.c: --align --config --debug
#     --indent --library --output --where. -c -C -f -i -L -q -S -T -r -t boolean;
#     `-d` is not in ltrace's own optstring, so it is kept only because the walk
#     then treats its operand as a value (fail closed) and ltrace rejects it.
#   watch: -n/--interval, -q/--equexit (procps 4.0+), and -s/--shotsdir (4.0.6+)
#     take a value; -d/--differences, -b, -e, -g, -p, -t, -w, -c, -x boolean.
#   faketime [options] timestamp program [args...]: -p PID and --date-prog PROG
#     take a value; -m (multi-threading) and -f (advanced timestamp format) are
#     boolean, and the timestamp after the options is positional.
#   chroot NEWROOT [COMMAND [ARG]...]: --userspec and --groups take a value;
#     --skip-chdir boolean; NEWROOT is positional.
#   systemd-run: -u/--unit, -p/--property, -E/--setenv, -M/--machine, -C/--capsule,
#     -H/--host, --uid, --gid, --host, --working-directory, --root-directory,
#     --slice, --description, --nice, --job-mode, --service-type, --output,
#     --json, --background, --expand-environment, --path-property,
#     --socket-property, --timer-property, and the timer options --on-active,
#     --on-boot, --on-startup, --on-unit-active, --on-unit-inactive, --on-calendar
#     take a value; --user, --system, --scope, --pty, -t, --pipe, -P, -q,
#     --no-block, --collect, --remain-after-exit, --same-dir, --wait, --shell,
#     --no-ask-password boolean. systemd-run has no --drop-in, --kill-who, or
#     --wait-timeout, so those entries are gone: an entry for an option the tool
#     does not have swallows the command word, which is what a guard must not do.
_WRAPPER_VALUE_OPTIONS: dict[str, frozenset[str]] = {
    "env": frozenset(
        {
            "-u",
            "--unset",
            "-C",
            "--chdir",
            "-S",
            "--split-string",
            "-a",
            "--argv0",
            "-P",
            "--env0-from",
        }
    ),
    "timeout": frozenset({"-s", "--signal", "-k", "--kill-after"}),
    "stdbuf": frozenset({"-i", "--input", "-o", "--output", "-e", "--error"}),
    "ionice": frozenset(
        {"-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"}
    ),
    "nice": frozenset({"-n", "--adjustment"}),
    "exec": frozenset({"-a", "--argv0"}),
    # -D, -f, -i, -q, -t, -T, -x, -y, -c, -C, -n, -v, -V are boolean in strace.
    "strace": frozenset(
        {
            "-a",
            "-b",
            "-e",
            "-E",
            "-I",
            "-o",
            "-O",
            "-p",
            "-P",
            "-s",
            "-S",
            "-u",
            "-U",
            "-X",
            "--abbrev",
            "--argv0",
            "--attach",
            "--color",
            "--columns",
            "--const-print-style",
            "--decode-pids",
            "--detach-on",
            "--env",
            "--fault",
            "--inject",
            "--interruptible",
            "--kvm",
            "--output",
            "--raw",
            "--read",
            "--signals",
            "--stack-trace-frame-limit",
            "--status",
            "--string-limit",
            "--summary-columns",
            "--summary-sort-by",
            "--summary-syscall-overhead",
            "--syscall-limit",
            "--trace",
            "--trace-fds",
            "--trace-path",
            "--user",
            "--verbose",
            "--write",
        }
    ),
    # -L, -i, -q, -f, -c, -S, -T are boolean in ltrace; -n takes a value here.
    "ltrace": frozenset(
        {
            "-A",
            "-a",
            "-d",
            "-D",
            "-e",
            "-F",
            "-l",
            "-n",
            "-o",
            "-p",
            "-s",
            "-u",
            "-w",
            "-x",
            "--align",
            "--config",
            "--debug",
            "--indent",
            "--library",
            "--output",
            "--where",
        }
    ),
    # -d and -t are boolean in watch: only the interval and the newer -q/-s do.
    "watch": frozenset({"-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"}),
    "faketime": frozenset({"-p", "--date-prog"}),
    "chroot": frozenset({"--userspec", "--groups"}),
    "systemd-run": frozenset(
        {
            "-u",
            "-p",
            "-E",
            "-C",
            "-M",
            "-H",
            "--capsule",
            "--unit",
            "--property",
            "--setenv",
            "--machine",
            "--uid",
            "--gid",
            "--host",
            "--job-mode",
            "--service-type",
            "--working-directory",
            "--slice",
            "--description",
            "--nice",
            "--background",
            "--expand-environment",
            "--json",
            "--on-active",
            "--on-boot",
            "--on-calendar",
            "--on-startup",
            "--on-unit-active",
            "--on-unit-inactive",
            "--output",
            "--path-property",
            "--root-directory",
            "--socket-property",
            "--timer-property",
        }
    ),
}
# Wrappers whose first non-flag operands are values, not the command they run.
_WRAPPER_LEADING_OPERANDS: dict[str, int] = {"chroot": 1, "faketime": 1}
# xargs options whose operand is a value, not the command xargs runs.
_XARGS_OPERAND_OPTIONS = frozenset(
    {
        "-I",
        "--replace",
        "-n",
        "--max-args",
        "-a",
        "--arg-file",
        "-d",
        "--delimiter",
        "-E",
        "--eof",
        "-L",
        "--max-lines",
        "-P",
        "--max-procs",
        "-s",
        "--max-chars",
        "-J",
        "--process-slot-var",
    }
)
# find [path...] -exec|-execdir|-ok|-okdir COMMAND ;|+ : the command follows the flag.
# fd [OPTIONS] [pattern] [path]...: -x/--exec and -X/--exec-batch take the command
#   line, and fd treats everything after them as that command line (a flag there is
#   the command name), so fd's own value options (-e/--extension, -E/--exclude,
#   -d/--max-depth, -t/--type, -S/--size, -j/--threads, -c/--color, --min-depth,
#   --max-results, --owner, ...) are deliberately not consulted after the flag.
_FIND_EXEC_FLAGS = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
_FD_EXEC_FLAGS = frozenset({"-x", "--exec", "-X", "--exec-batch"})
# Launchers whose `exec` flag hands the following words to a command.
_EXEC_LAUNCHER_FLAGS: dict[str, frozenset[str]] = {
    "find": _FIND_EXEC_FLAGS,
    "fd": _FD_EXEC_FLAGS,
    "fdfind": _FD_EXEC_FLAGS,
}
# Letters of the short flags above: a bundle such as `env -vu NAME` still starts
# with a value-taking letter, so the walk must consume its operand there too.
_WRAPPER_VALUE_LETTERS: dict[str, str] = {
    "env": "uCSaP",
    "timeout": "sk",
    "stdbuf": "ioe",
    "ionice": "cnpPu",
    "nice": "n",
    "exec": "a",
    "strace": "oepsaubIPOUXSE",
    "ltrace": "oepsluaFAwnDx",
    "watch": "nqs",
    "faketime": "p",
    "chroot": "",
    "systemd-run": "upEMCH",
}
_XARGS_OPERAND_LETTERS = "InadELPsJ"
# xargs: -I/--replace, -n/--max-args, -a/--arg-file, -d/--delimiter, -E/--eof,
#   -L/--max-lines, -P/--max-procs, -s/--max-chars, -J/--process-slot-var take a
#   value; -0, -p, -r, -t, -x boolean; -e and -i are BSD/GNU optional-argument
#   forms, so the walk keeps treating their next word as the command (fail closed).
# GNU parallel, from the GetOptions specs in src/parallel: -a/--arg-file,
#   -C/--colsep, -d/--delimiter, -D/--debug, -E, -I, -J/--profile, -L,
#   -N/--max-replace-args, -P/--max-procs, -S/--sshlogin, -j/--jobs,
#   -n/--max-args, -s/--max-chars, and the long options in the table take a
#   value; -k/--keep-order, --eta, --bar, --dry-run, --line-buffer boolean. The
#   optional-argument specs -i/--replace, -l/--max-lines, and -e/--eof are
#   deliberately absent: their operand is optional, so the next word is the
#   command and stays judged. There is no bare --ssh in the spec.
_PARALLEL_OPERAND_OPTIONS = frozenset(
    {
        "-j",
        "-N",
        "-n",
        "-L",
        "-S",
        "-a",
        "-I",
        "-C",
        "-d",
        "-D",
        "-E",
        "-J",
        "-P",
        "-s",
        "--jobs",
        "--max-args",
        "--max-replace-args",
        "--sshlogin",
        "--joblog",
        "--results",
        "--tmpdir",
        "--tempdir",
        "--colsep",
        "--arg-file",
        "--delay",
        "--timeout",
        "--retries",
        "--load",
        "--memfree",
        "--tagstring",
        "--rpl",
        "--debug",
        "--delimiter",
        "--profile",
        "--max-procs",
        "--max-chars",
        "--halt",
        "--halt-on-error",
        "--nice",
        "--env",
        "--workdir",
        "--work-dir",
        "--wd",
        "--sshdelay",
        "--sshloginfile",
        "--slf",
        "--recstart",
        "--recend",
        "--block",
        "--block-size",
        "--basefile",
        "--bf",
        "--arg-sep",
        "--arg-file-sep",
        "--header",
        "--minversion",
        "--min-version",
        "--return",
        "--trc",
        "--trim",
        "--compress-program",
        "--decompress-program",
        "--semaphorename",
        "--id",
        "--semaphoretimeout",
        "--seqreplace",
        "--slotreplace",
        "--dirnamereplace",
        "--dnr",
        "--basenamereplace",
        "--bnr",
        "--basenameextensionreplace",
        "--bner",
        "--extensionreplace",
        "--er",
        "--parens",
    }
)
# Launchers that run their first non-flag word as a command, like xargs.
_LAUNCHER_OPERAND_OPTIONS: dict[str, frozenset[str]] = {
    "xargs": _XARGS_OPERAND_OPTIONS,
    "parallel": _PARALLEL_OPERAND_OPTIONS,
}
_LAUNCHER_OPERAND_LETTERS: dict[str, str] = {"xargs": _XARGS_OPERAND_LETTERS, "parallel": "jNnLSaI"}
# Shell builtins the command hash table cannot shadow: bash consults the table
# only after reserved words, functions, and builtins, so a `hash -p` entry never
# changes what one of these words does. External launchers the walk models
# (`env`, `timeout`, `strace`, `which`, `bash`, ...) are not builtins, so an
# entry pointing at sudo/doas does change what they run.
_SHADOWPROOF_BUILTINS = frozenset(
    {"alias", "builtin", "command", "eval", "exec", "hash", "source", ".", "type"}
)
_BRACE_EXPANSION_CAP = 64
_SUDO_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_ANSI_C_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
}


def _sudo_join_line_continuations(command: str) -> str:
    """Drop backslash-newline pairs the way the shell does (not inside single quotes)."""
    out: list[str] = []
    single = False
    double = False
    index = 0
    length = len(command)
    while index < length:
        char = command[index]
        following = command[index + 1] if index + 1 < length else ""
        if char == "\\" and following == "\n":
            if not single:
                index += 2
                continue
            out.append(char)
            index += 1
            continue
        if char == "\\" and following and not single:
            # Keep the escaped pair intact: the tokenizer folds it later.
            out.append(char + following)
            index += 2
            continue
        if char == "'" and not double:
            single = not single
        elif char == '"' and not single:
            double = not double
        out.append(char)
        index += 1
    return "".join(out)


def _match_redirect(text: str, start: int) -> tuple[str, int] | None:
    """Redirect operator at `start` (optional leading fd digits), or None."""
    index = start
    while index < len(text) and text[index].isdigit():
        index += 1
    for operator in _REDIRECT_OPERATORS:
        if text.startswith(operator, index):
            return operator, index + len(operator)
    return None


def _is_assignment(value: str) -> bool:
    name, separator, _ = value.partition("=")
    if not separator:
        return False
    if name.endswith("+"):
        name = name[:-1]
    if not name or not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(char.isalnum() or char == "_" for char in name)


def _code_point_char(code: int) -> str | None:
    """Character for a decoded code point, or None when it is not a valid one."""
    if code < 0 or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
        return None
    return chr(code)


def _read_ansi_c(command: str, quote_index: int) -> tuple[str, int]:
    """Decode `$'...'` text from its opening quote; return the text and the next index."""
    out: list[str] = []
    index = quote_index + 1
    length = len(command)
    while index < length:
        char = command[index]
        if char == "'":
            return "".join(out), index + 1
        if char != "\\" or index + 1 >= length:
            out.append(char)
            index += 1
            continue
        code = command[index + 1]
        if code in _ANSI_C_ESCAPES:
            out.append(_ANSI_C_ESCAPES[code])
            index += 2
            continue
        if code in "01234567":
            digits = ""
            cursor = index + 1
            while cursor < length and len(digits) < 3 and command[cursor] in "01234567":
                digits += command[cursor]
                cursor += 1
            decoded = _code_point_char(int(digits, 8) & 0xFF)
            if decoded is not None:
                out.append(decoded)
                index = cursor
                continue
        if code == "x":
            digits = ""
            cursor = index + 2
            while cursor < length and len(digits) < 2 and command[cursor] in _SUDO_HEX_DIGITS:
                digits += command[cursor]
                cursor += 1
            decoded = _code_point_char(int(digits, 16)) if digits else None
            if decoded is not None:
                out.append(decoded)
                index = cursor
                continue
        if code in ("u", "U"):
            width = 4 if code == "u" else 8
            digits = command[index + 2 : index + 2 + width]
            if len(digits) == width and all(digit in _SUDO_HEX_DIGITS for digit in digits):
                decoded = _code_point_char(int(digits, 16))
                if decoded is not None:
                    out.append(decoded)
                    index += 2 + width
                    continue
        if code == "c":
            control = command[index + 2 : index + 3]
            decoded = _code_point_char(ord(control.upper()) ^ 0x40) if control else None
            if decoded is not None and control != "\\":
                out.append(decoded)
                index += 3
                continue
        # Unknown or out-of-range escape: keep the backslash and the character.
        out.append(char)
        index += 1
    return "".join(out), index


def _tokenize(command: str) -> list[_Word]:
    """Split shell text into words, operators, and redirects, folding quotes."""
    words: list[_Word] = []
    buffer: list[str] = []
    started = False
    expansion = False
    single = False
    double = False
    segment_start = True
    operand_next = False
    word_start = 0
    index = 0
    length = len(command)

    def flush() -> None:
        nonlocal buffer, started, expansion, segment_start, operand_next, word_start
        if not started:
            return
        value = "".join(buffer)
        words.append(
            _Word(
                value=value,
                start=word_start,
                end=index,
                starts_command=segment_start,
                has_expansion=expansion,
                is_operand=operand_next,
            )
        )
        buffer = []
        started = False
        expansion = False
        segment_start = False
        operand_next = False
        word_start = index

    def note_character() -> None:
        nonlocal started, word_start
        if not started:
            started = True
            word_start = index

    while index < length:
        char = command[index]
        if single:
            if char == "'":
                single = False
            else:
                note_character()
                buffer.append(char)
            index += 1
            continue
        if double:
            if char == '"':
                double = False
                index += 1
                continue
            note_character()
            if char in "$`":
                expansion = True
            buffer.append(char)
            index += 1
            continue
        if char == "\\" and index + 1 < length:
            note_character()
            buffer.append(command[index + 1])
            index += 2
            continue
        if char == "'":
            note_character()
            single = True
            index += 1
            continue
        if char == '"':
            note_character()
            double = True
            index += 1
            continue
        if char == "$" and index + 1 < length and command[index + 1] in "'\"":
            note_character()
            if command[index + 1] == "'":
                # $'...' is ANSI-C text: decode it so escapes cannot hide a name.
                text, index = _read_ansi_c(command, index + 1)
                buffer.append(text)
                if any(escaped in "$`" for escaped in text):
                    expansion = True
            else:
                double = True  # $"..." folds like double quotes
                index += 2
            continue
        if char == "#" and not started:
            while index < length and command[index] != "\n":
                index += 1
            continue
        if char in "\t\n " or char in "\r\v\f":
            flush()
            if char == "\n":
                segment_start = True
            index += 1
            continue
        if char in "<>" and command.startswith("(", index + 1):
            # Process substitution (`<(cmd)`, `>(cmd)`) runs the span as a command
            # of its own. Keep it in one word so the span scan recurses into it.
            note_character()
            close = _matching_paren(command, index + 1, length)
            expansion = True
            buffer.append(command[index : close + 1])
            index = close + 1
            continue
        redirect = None
        if started or char.isdigit() or char in "<>":
            redirect = _match_redirect(command, index)
        if redirect is not None:
            flush()
            if not started:
                word_start = index
            operator, after = redirect
            target_end = after
            quote: str | None = None
            while target_end < length:
                char = command[target_end]
                if quote is None:
                    if char.isspace() or char in _BREAK_CHARS:
                        break
                    if char in "'\"":
                        quote = char
                elif char == quote:
                    quote = None
                # A quoted target is one word: `bash<<<"sh -c 'sudo id'"` is a script.
                target_end += 1
            target = command[after:target_end]
            heredoc = operator.startswith("<<")
            words.append(
                _Word(
                    value=command[index:after] + target,
                    start=index,
                    end=target_end,
                    kind="redirect",
                    starts_command=segment_start,
                    is_operand=operand_next,
                    heredoc=operator if heredoc else None,
                    heredoc_delim=_strip_quotes(target) if heredoc and target else None,
                )
            )
            segment_start = False
            operand_next = not target
            index = target_end
            continue
        if char in _BREAK_CHARS:
            flush()
            operator_text = char
            if char in "&|" and command[index : index + 2] == char * 2:
                operator_text = char * 2
            kind = "operator"
            words.append(
                _Word(
                    value=operator_text,
                    start=index,
                    end=index + len(operator_text),
                    kind=kind,
                )
            )
            segment_start = True
            index += len(operator_text)
            continue
        note_character()
        if char in "$`":
            expansion = True
        buffer.append(char)
        index += 1
    flush()
    _classify_words(words)
    return words


def _strip_quotes(value: str) -> str:
    return value.strip("\"'")


def _classify_words(words: list[_Word]) -> None:
    """Mark assignments and standalone group braces; `}` starts the next command."""
    for index, word in enumerate(words):
        if word.kind != "word":
            continue
        if word.value in ("{", "}"):
            word.kind = "group"
            if index + 1 < len(words):
                words[index + 1].starts_command = True
        elif _is_assignment(word.value):
            word.is_assignment = True


def _apply_heredocs(text: str, words: list[_Word]) -> None:
    """Resolve heredoc delimiters and mark body words as data (not commands)."""
    for index, word in enumerate(words):
        if not word.heredoc or word.heredoc == "<<<" or word.heredoc_delim:
            continue
        if index + 1 < len(words):
            word.heredoc_delim = _strip_quotes(words[index + 1].value)
    for word in words:
        if not word.heredoc or word.heredoc == "<<<" or not word.heredoc_delim:
            continue
        newline = text.find("\n", word.end)
        if newline < 0:
            continue
        body_start = newline + 1
        cursor = body_start
        while cursor <= len(text):
            line_end = text.find("\n", cursor)
            line_end = len(text) if line_end < 0 else line_end
            if text[cursor:line_end].strip() == word.heredoc_delim:
                break
            cursor = line_end + 1
        else:
            cursor = len(text)
        word.heredoc_body = text[body_start:cursor]
        for other in words:
            # Only the body itself is data; the rest of the command line still runs.
            if body_start <= other.start < cursor:
                other.is_data = True


def _is_flag_word(word: _Word) -> bool:
    return word.value.startswith("-") and word.value != "-"






def _expansion_spans(value: str) -> list[str]:
    """`$(...)` and backtick spans of an expansion word, as command text."""
    spans: list[str] = []
    index = 0
    length = len(value)
    while index < length:
        char = value[index]
        if (char == "$" and value.startswith("$(", index)) or (
            char in "<>" and value.startswith("(", index + 1)
        ):
            close = _matching_paren(value, index + 1, length)
            if value[close : close + 1] == ")":
                spans.append(value[index + 2 : close])  # matched: the interior runs
                index = close + 1
            else:
                spans.append(value[index + 2 :])  # unterminated: the remainder runs
                index = length
            continue
        if char == "`":
            end = value.find("`", index + 1)
            if end < 0:
                break
            spans.append(value[index + 1 : end])
            index = end + 1
            continue
        index += 1
    return spans


def _scan_expansion(value: str, depth: int, parent_mentions_sudo: bool = False) -> str | None:
    """Scan substitution spans inside a word: they run as commands of their own."""
    if depth >= _MAX_PAYLOAD_DEPTH:
        return _DEPTH_VIOLATION
    for span in _expansion_spans(value):
        violation = _scan_text(span, depth + 1, parent_mentions_sudo)
        if violation:
            return violation
    return None


def _scan_text(text: str, depth: int, parent_mentions_sudo: bool = False) -> str | None:
    words = _tokenize(text)
    _apply_heredocs(text, words)
    inner = parent_mentions_sudo or _mentions_sudo(words)
    # `hash -p pathname name` installs a command-hash entry by hand, so a later
    # `name` runs `pathname` whatever the name looks like: those names scan as
    # the command they run, and an entry the guard cannot read is refused,
    # because the command it hides cannot be resolved at all.
    hash_alias_names, hash_unreadable = _hash_registered_command_names(words)
    if hash_unreadable:
        return (
            "a `hash -p` registration builds the command it runs from expansion, "
            "so that entry cannot be resolved"
        )
    # Word indices the walk reaches as command words, so the heredoc gate below
    # uses the same judgment as the refusals instead of guessing from the tokens.
    command_words: set[int] = set()
    for word in words:
        if word.is_data or not word.has_expansion:
            continue
        violation = _scan_expansion(word.value, depth, inner)
        if violation:
            return violation
    for index, word in enumerate(words):
        if word.is_data or not word.starts_command:
            continue
        violation = _scan_segment(
            words, index, depth, inner, command_words, hash_alias_names
        )
        if violation:
            return violation
    # A heredoc body that the same text feeds to a runner is a script, not data.
    runner_alias = _alias_body_names_runner(words, command_words)
    if depth < _MAX_PAYLOAD_DEPTH and (
        runner_alias
        or any(
            os.path.basename(_registered_command(words[position].value, hash_alias_names))
            in _PAYLOAD_RUNNERS
            for position in command_words
        )
    ):
        for word in words:
            if word.is_data or not word.heredoc_body:
                continue
            violation = _scan_text(word.heredoc_body, depth + 1, inner)
            if violation:
                return violation
    if runner_alias and depth < _MAX_PAYLOAD_DEPTH:
        # An alias whose body names a runner can still read a redirect as its
        # script, so judge this text's redirects the way a runner's own are judged.
        return _scan_script_source(words, list(range(len(words))), depth, inner)
    return None


def _scan_segment(
    words: list[_Word],
    start: int,
    depth: int,
    parent_mentions_sudo: bool = False,
    command_words: set[int] | None = None,
    hash_alias_names: dict[str, str] | None = None,
) -> str | None:
    """Walk one command segment to its command word and judge that word."""
    while start < len(words):
        word = words[start]
        if word.is_operator:
            return None
        if word.is_data or word.is_redirect or word.is_operand or word.is_assignment:
            start += 1
            continue
        if word.value in ("for", "select"):
            start = _skip_loop_header(words, start + 1)
            continue
        if word.value == "case":
            start = _skip_case_header(words, start + 1)
            continue
        if word.value == "time":
            # `time` is a keyword, not a program: its own flags are not the command
            # word, so `time -p sudo id` still reaches the word that runs.
            start += 1
            while start < len(words) and _is_flag_word(words[start]):
                start += 1
            continue
        if word.value == "coproc":
            # `coproc [NAME] command`: bash takes the first plain word as the
            # coprocess name only when the next word starts a compound command
            # (`coproc worker if sudo id; then :; fi`), so that name is syntax
            # rather than the command word.
            start += 1
            if (
                start + 1 < len(words)
                and words[start].kind == "word"
                and (words[start + 1].value in _KEYWORDS or words[start + 1].kind == "group")
            ):
                start += 1
            continue
        if word.kind == "group" or word.value in _KEYWORDS:
            start += 1
            continue
        # A `hash -p` registration makes the word run a file whatever the word
        # looks like, so every judgement below reads that file's name. The entry
        # can be inert by run time (`hash -r`, `hash -d`, `set +h`), so the same
        # segment is judged under the word's own spelling too.
        registered = _registered_command(word.value, hash_alias_names)
        if registered != word.value:
            own_reading = _scan_segment(
                words, start, depth, parent_mentions_sudo, command_words, None
            )
            if own_reading:
                return own_reading
        name = os.path.basename(registered)
        if name in _LOOKUP_COMMANDS:
            return None  # `which sudo`, `type sudo`: operands are just names
        if name == "command":
            # `command` only defeats functions and aliases; it is a lookup with
            # -v/-V, and otherwise it still runs the next word.
            start += 1
            lookup = False
            while start < len(words) and _is_flag_word(words[start]):
                if "v" in words[start].value or "V" in words[start].value:
                    lookup = True
                start += 1
            if lookup:
                return None
            continue
        if name in _WRAPPERS:
            start, violation = _skip_wrapper_operands(
                words, start + 1, name, depth, parent_mentions_sudo
            )
            if violation:
                return violation
            continue
        if command_words is not None:
            command_words.add(start)
        if _word_names_sudo(word.value):
            return f"{os.path.basename(word.value)} would run this command as root or another user"
        if _word_names_sudo(registered):
            return (
                f"a `hash -p` entry makes {word.value} run {registered}, which "
                "would run this command as root or another user"
            )
        if name == "alias":
            return _scan_alias_bodies(words, start + 1, depth, parent_mentions_sudo)
        if name in _EXEC_LAUNCHER_FLAGS:
            return _scan_find_execs(
                words,
                start + 1,
                depth,
                parent_mentions_sudo,
                command_words,
                _EXEC_LAUNCHER_FLAGS[name],
                hash_alias_names,
            )
        if word.has_expansion:
            if _mentions_sudo(words) or parent_mentions_sudo:
                return (
                    "the command position expands to an unknown program while the "
                    "text invokes sudo/doas"
                )
            return None
        return _scan_interpreter(
            words, start, depth, parent_mentions_sudo, command_words, hash_alias_names
        )
    return None


def _is_duration(value: str) -> bool:
    # GNU timeout takes a floating-point NUMBER with an optional s/m/h/d suffix,
    # and the kernel's own `timeout 0.1 sudo id` spelling must not read as the
    # command word; an integer is the subset that `nice` accepts.
    digits = value[:-1] if value[-1:].isalpha() else value
    return bool(re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)", digits))


def _skip_loop_header(words: list[_Word], start: int) -> int:
    """Index after a `for`/`select` header: the loop variable and `in` list are names."""
    while start < len(words):
        word = words[start]
        if word.is_operator or word.value in ("do", "done"):
            break
        start += 1
    return start


def _skip_case_header(words: list[_Word], start: int) -> int:
    """Index of the `)` that closes the first `case` label list: subject and labels are names."""
    while start < len(words):
        word = words[start]
        if word.is_operator:
            if word.value == ")":
                break
            if word.value not in ("(", "|"):
                break
        elif word.value == "esac":
            break
        start += 1
    return start


def _ends_segment(word: _Word) -> bool:
    return word.is_operator or word.is_redirect or word.is_data or word.is_operand


def _skip_wrapper_operands(
    words: list[_Word],
    index: int,
    wrapper: str,
    depth: int,
    parent_mentions_sudo: bool = False,
) -> tuple[int, str | None]:
    """Index after a wrapper's own operands, plus any violation their text carries."""
    value_options = _WRAPPER_VALUE_OPTIONS.get(wrapper, frozenset())
    value_letters = _WRAPPER_VALUE_LETTERS.get(wrapper, "")
    leading = _WRAPPER_LEADING_OPERANDS.get(wrapper, 0)
    while index < len(words):
        word = words[index]
        if word.is_operator or word.is_redirect or word.is_data:
            break
        if word.is_assignment:
            index += 1
            continue
        if _is_flag_word(word):
            option, glued = _split_option(word.value, value_options, value_letters)
            if option is None:
                index += 1
                continue
            # env -S/--split-string takes a whole command line, so its operand is
            # text a shell runs; every other value operand is just a value.
            split_string = wrapper == "env" and option in ("-S", "--split-string")
            if glued is None:
                operand = index + 1
                if split_string and operand < len(words) and not _ends_segment(words[operand]):
                    violation = _scan_text(words[operand].value, depth + 1, parent_mentions_sudo)
                    if violation:
                        return index, violation
                index += 2
                continue
            if split_string:
                violation = _scan_text(glued, depth + 1, parent_mentions_sudo)
                if violation:
                    return index, violation
            index += 1
            continue
        if wrapper in ("nice", "timeout") and _is_duration(word.value):
            index += 1
            continue
        if leading:
            # A positional operand such as chroot's NEWROOT or faketime's
            # timestamp: consume it and keep walking, so later flags still cannot
            # swallow the command.
            leading -= 1
            index += 1
            continue
        break
    return index, None


def _mentions_sudo(words: list[_Word]) -> bool:
    """True when any word (or assignment value) names sudo/doas, obfuscations included."""
    for word in words:
        if word.is_operator:
            continue
        candidates = [word.value]
        if word.is_assignment:
            candidates.append(word.value.partition("=")[2].lstrip("+"))
        for candidate in candidates:
            if _word_names_sudo(candidate):
                return True
    return False


def _word_names_sudo(value: str) -> bool:
    """True when a command word can name sudo/doas: braces, globs, and letters.

    Every test reads the basename, because that is the name the shell resolves:
    a directory prefix does not change which program runs, so `/usr/bin/sudoku`
    is the sudoku binary while `/usr/bin/sudo` is the tool. A plain program name
    is judged by that basename alone, so `sudoku`, `sudo-report`, and `s-u-d-o`
    run, while globs (`/usr/bin/su*`) and every word that carries quoting or
    expansion (`${SUDO_CMD:-sudo}`, `su do`) still fall back to their surviving
    letters and fail closed.
    """
    alternatives = _brace_alternatives(value)
    if alternatives is None:
        return True  # too many alternatives to enumerate: fail closed
    for candidate in alternatives:
        name = os.path.basename(candidate)
        # Folded case: on a case-insensitive filesystem (`SUDO`, `Sudo`) the
        # name is the same program, so the basename test cannot be exact.
        if name.lower() in _SUDO_COMMAND_WORDS:
            return True
        if _matches_sudo_pattern(name):
            return True
        letters = "".join(char for char in candidate if char.isalpha()).lower()
        if ("sudo" in letters or "doas" in letters) and not _PLAIN_COMMAND_NAME.fullmatch(name):
            return True
    return False


# POSIX character classes as the regex ranges bash matches: `[[:lower:]]udo`
# expands like `[a-z]udo`, so the guard must read the class, not the first `]`.
_POSIX_CLASS_RANGES: dict[str, str] = {
    "alnum": "a-zA-Z0-9",
    "alpha": "a-zA-Z",
    "ascii": "\\x00-\\x7f",
    "blank": " \\t",
    "cntrl": "\\x00-\\x1f\\x7f",
    "digit": "0-9",
    "graph": "!-~",
    "lower": "a-z",
    "print": " -~",
    "punct": "!-/:-@\\[-`{-~",
    "space": " \\t\\r\\n\\v\\f",
    "upper": "A-Z",
    "word": "a-zA-Z0-9_",
    "xdigit": "0-9A-Fa-f",
}


def _bracket_end(value: str, start: int) -> int:
    """Index of the `]` closing the bracket expression at `start`, or -1.

    A POSIX class (`[:lower:]`) nests its own brackets, so the closing bracket of
    the enclosing expression is only the one after the class ends. A `]` in the
    first position is a literal, as in bash.
    """
    index = start + 1
    if index < len(value) and value[index] in "!^":
        index += 1
    if index < len(value) and value[index] == "]":
        index += 1
    while index < len(value):
        if value.startswith("[:", index):
            close = value.find(":]", index + 2)
            if close >= 0:
                index = close + 2
                continue
        if value[index] == "]":
            return index
        index += 1
    return -1


def _bracket_body(body: str) -> str:
    """Regex ranges for a bracket body, expanding POSIX classes like `[:lower:]`.

    A class the table does not name still matches one character in bash, so it
    becomes `.`: refusing too much is the fail-closed direction.
    """
    out: list[str] = []
    index = 0
    while index < len(body):
        if body.startswith("[:", index):
            close = body.find(":]", index + 2)
            if close >= 0:
                name = body[index + 2 : close]
                out.append(_POSIX_CLASS_RANGES.get(name, "."))
                index = close + 2
                continue
        out.append(body[index])
        index += 1
    return "".join(out)


def _matches_sudo_pattern(value: str) -> bool:
    """True when the glob pattern in a word matches the name sudo or doas."""
    if not any(char in value for char in "*?["):
        return False
    pattern: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "*":
            pattern.append(".*")
        elif char == "?":
            pattern.append(".")
        elif char == "[":
            end = _bracket_end(value, index)
            if end < 0:
                pattern.append("\\[")
            else:
                # Negation is the literal first character of the body, tested
                # before classes expand: `[:graph:]` and `[:punct:]` ranges start
                # with `!` themselves and must not be read as negation.
                negated = value[index + 1] == "!"
                body = _bracket_body(value[index + 2 if negated else index + 1 : end])
                pattern.append("[" + ("^" if negated else "") + body + "]")
                index = end
        else:
            pattern.append(re.escape(char))
        index += 1
    try:
        compiled = re.compile("".join(pattern))
    except re.error:
        return False
    return any(compiled.fullmatch(name) for name in _SUDO_COMMAND_WORDS)


def _is_integer(value: str) -> bool:
    return value.lstrip("-").isdigit() and value.lstrip("-") != ""


def _sequence_elements(body: str) -> tuple[int, list[str] | None] | None:
    """Elements of a `x..y`/`x..y..step` brace sequence as (count, elements), else None.

    The count is computed arithmetically first, so an oversized range such as
    `{1..9999999}` fails closed without ever building its elements.
    """
    parts = body.split("..")
    if len(parts) not in (2, 3):
        return None
    start_text, end_text = parts[0], parts[1]
    step_text = parts[2].strip() if len(parts) == 3 else "1"
    if not _is_integer(step_text):
        return None
    numeric = _is_integer(start_text) and _is_integer(end_text)
    if not numeric and not (len(start_text) == 1 and len(end_text) == 1):
        return None
    try:
        step = abs(int(step_text))
        if step == 0:
            return None  # `{1..9..0}` does not expand in bash
        if numeric:
            low, high = int(start_text), int(end_text)
        else:
            low, high = ord(start_text), ord(end_text)
    except ValueError:
        # A range too large for CPython's integer conversion limit: fail closed the
        # same way an over-cap range does, and never raise out of the guard.
        return 0, None
    if low > high:
        step = -step
    count = (high - low) // step + 1
    if count > _BRACE_EXPANSION_CAP:
        return count, None  # over the cap: fail closed, unbuilt
    bounds = range(low, high + step, step)
    if numeric:
        return count, [str(number) for number in bounds]
    return count, [chr(code) for code in bounds]


def _brace_group_elements(body: str) -> tuple[int, list[str] | None] | None:
    """Elements of an expanding brace group as (count, elements), or None when it stays literal.

    `elements` is None when the group holds more than the cap, so the caller can fail
    closed without building the product.
    """
    sequence = _sequence_elements(body)
    if sequence is not None:
        return sequence
    parts = _top_level_split(body)
    if parts is None:
        return 0, None  # over the cap: `_top_level_split` stopped early
    if len(parts) < 2:
        return None  # `su{d}o` has no comma, so bash does not expand it
    return len(parts), parts


def _brace_group_chain(value: str) -> tuple[list[tuple[str, int, list[str] | None]], str] | None:
    """Left-to-right expanding brace groups of a word, with the literal tail."""
    chain: list[tuple[str, int, list[str] | None]] = []
    tail = value
    while True:
        group = _first_brace_group(tail)
        if group is None:
            break
        prefix, body, suffix = group
        count, elements = _brace_group_elements(body)
        chain.append((prefix, count, elements))
        tail = suffix
    return (chain, tail) if chain else None


def _brace_alternatives(value: str) -> list[str] | None:
    """Brace-expansion candidates of a word, or None when they exceed the cap."""
    if value.count("{") > _BRACE_EXPANSION_CAP:
        return None  # a brace flood: more groups than the cap enumerates, fail closed
    chain = _brace_group_chain(value)
    if chain is None:
        return [value]
    groups, tail = chain
    total = 1
    for _prefix, count, elements in groups:
        if elements is None or count > _BRACE_EXPANSION_CAP:
            return None
        total *= count
        if total > _BRACE_EXPANSION_CAP:
            return None
    expanded = [""]
    for prefix, _count, elements in groups:
        assert elements is not None
        expanded = [candidate + prefix + element for candidate in expanded for element in elements]
    return [candidate + tail for candidate in expanded]


def _first_brace_group(value: str) -> tuple[str, str, str] | None:
    """Leftmost expanding brace group, as (prefix, body, suffix), else None.

    One pass with a stack of open groups matches every `{` to its `}` once, so a
    brace-heavy word stays linear instead of rescanning the tail for each `{`.
    """
    open_groups: list[int] = []
    groups: list[tuple[int, int]] = []
    for index, char in enumerate(value):
        if char == "{":
            open_groups.append(index)
        elif char == "}" and open_groups:
            groups.append((open_groups.pop(), index))
    for start, end in sorted(groups):
        if _brace_group_elements(value[start + 1 : end]) is not None:
            return value[:start], value[start + 1 : end], value[end + 1 :]
    return None


def _top_level_split(body: str) -> list[str] | None:
    """Split a brace group body on its top-level commas, or None past the cap."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    for char in body:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            if len(parts) > _BRACE_EXPANSION_CAP:
                return None  # stop early instead of materialising a huge group
            current = []
            continue
        current.append(char)
    parts.append("".join(current))
    return parts


def _alias_body(word: _Word) -> str | None:
    """Value half of an `alias NAME=BODY` operand, else None."""
    if word.is_data or word.is_redirect or "=" not in word.value:
        return None
    return word.value.partition("=")[2].lstrip("+") or None


def _body_reaches_runner(body: str, depth: int = 0) -> bool:
    """True when a runner is a command word of the body, wrapper chains and the
    aliases the body itself defines included."""
    words = _tokenize(body)
    _apply_heredocs(body, words)
    hash_alias_names, _ = _hash_registered_command_names(words)
    reached: set[int] = set()
    for index, word in enumerate(words):
        if word.is_data or not word.starts_command:
            continue
        _scan_segment(words, index, 0, False, reached, hash_alias_names)
    if any(
        os.path.basename(_registered_command(words[index].value, hash_alias_names))
        in _PAYLOAD_RUNNERS
        for index in reached
    ):
        return True
    if depth >= _MAX_PAYLOAD_DEPTH:
        # Too deep to resolve: the chain could still reach a runner, so the body
        # counts as one and its heredocs are scanned as scripts, exactly as the
        # rest of the scan refuses `_DEPTH_VIOLATION` at this cap.
        return True
    # `alias a='alias b=sh'` runs the payload through `b`, so the aliases a body
    # defines are followed the way `_alias_body_names_runner` follows the text's.
    for index in reached:
        if os.path.basename(words[index].value) != "alias":
            continue
        for candidate in _segment_tail(words, index + 1):
            nested = _alias_body(words[candidate])
            if nested is not None and _body_reaches_runner(nested, depth + 1):
                return True
    return False


def _alias_body_names_runner(words: list[_Word], command_words: set[int]) -> bool:
    """True when an alias defined in this text runs a payload runner as its command."""
    for index in command_words:
        if os.path.basename(words[index].value) != "alias":
            continue
        for candidate in _segment_tail(words, index + 1):
            body = _alias_body(words[candidate])
            if body is not None and _body_reaches_runner(body):
                return True
    return False


def _split_option(
    value: str, options: frozenset[str], value_letters: str = ""
) -> tuple[str | None, str | None]:
    """Match a flag word against an option set: (option, glued operand) or (None, None).

    A short bundle (`env -vu NAME`, `xargs -rn 2`) is scanned for a value-taking
    letter: letters before it are plain flags, letters after it are the glued operand.
    """
    if value in options:
        return value, None
    if value.startswith("--") and "=" in value:
        option, _, glued = value.partition("=")
        return (option, glued) if option in options else (None, None)
    if len(value) > 2 and value[0] == "-" and value[1] != "-":
        offset = next(
            (index for index, char in enumerate(value[1:]) if char in value_letters), None
        )
        if offset is None:
            return None, None
        return "-" + value[1 + offset], value[2 + offset :] or None
    return None, None


def _process_substitution_body(value: str) -> str | None:
    """Inner command text of a `<(cmd)` process substitution, else None."""
    if not value.startswith("<("):
        return None
    close = _matching_paren(value, 1, len(value))
    if value[close : close + 1] != ")":
        close = len(value)  # unterminated: the remainder runs as the command
    return value[2:close]


def _is_command_flag(value: str) -> bool:
    """`-c`, a bundled flag containing c (e.g. `-lc`), or `--command`."""
    if value == "--command":
        return True
    return len(value) >= 2 and value[0] == "-" and "c" in value[1:] and value[1:].isalpha()


def _glued_payload(value: str) -> str | None:
    """Payload folded onto the flag word itself (`-c$'sudo id'` -> `-csudo id`)."""
    # Only short bundles fold a payload: a long option such as `--rcfile` merely
    # contains a `c` and must stay in the flag loop.
    if not value.startswith("-") or value.startswith("--") or "c" not in value[1:]:
        return None
    return value[value.index("c") + 1 :] or None


def _scan_interpreter(
    words: list[_Word],
    index: int,
    depth: int,
    parent_mentions_sudo: bool = False,
    command_words: set[int] | None = None,
    hash_alias_names: dict[str, str] | None = None,
) -> str | None:
    """Judge payloads a runner executes: shell -c, eval, xargs operands, heredocs."""
    # A registered name runs its target, so the target's name decides whether
    # this word is a payload runner (`hash -p /bin/bash safe; safe -c 'sudo id'`).
    name = os.path.basename(_registered_command(words[index].value, hash_alias_names))
    if name not in _PAYLOAD_RUNNERS and name not in _LAUNCHER_OPERAND_OPTIONS:
        return None
    if depth >= _MAX_PAYLOAD_DEPTH:
        return _DEPTH_VIOLATION
    following = _segment_tail(words, index + 1)
    if name in _LAUNCHER_OPERAND_OPTIONS:
        return _scan_xargs(
            words, following, depth, parent_mentions_sudo, command_words, name, hash_alias_names
        )
    if name in _SHELL_RUNNERS:
        for offset, candidate in enumerate(following):
            word = words[candidate]
            if word.is_data:
                break
            if word.is_redirect:
                # A redirect between the flag and its operand is not the script:
                # `bash -c >/tmp/out 'sudo id'` still runs the payload.
                continue
            command_flag = _is_command_flag(word.value)
            if command_flag:
                payload_offset = offset + 1
                while (
                    payload_offset < len(following)
                    and words[following[payload_offset]].is_redirect
                ):
                    payload_offset += 1
                if payload_offset < len(following):
                    payload = words[following[payload_offset]]
                    violation = _scan_text(
                        _strip_quotes(payload.value), depth + 1, parent_mentions_sudo
                    )
                    if violation:
                        return violation
            glued = _glued_payload(word.value)
            if glued:
                violation = _scan_text(glued, depth + 1, parent_mentions_sudo)
                if violation:
                    return violation
                break
            if command_flag:
                break
    if name == "eval":
        joined = " ".join(words[i].value for i in following if not words[i].is_data)
        if joined:
            violation = _scan_text(joined, depth + 1, parent_mentions_sudo)
            if violation:
                return violation
    violation = _scan_script_source(words, following, depth, parent_mentions_sudo)
    if violation:
        return violation
    # A heredoc body owned by a runner is a script, not data.
    for candidate in following:
        body = words[candidate].heredoc_body
        if body:
            violation = _scan_text(body, depth + 1, parent_mentions_sudo)
            if violation:
                return violation
    return None


def _scan_xargs(
    words: list[_Word],
    following: list[int],
    depth: int,
    parent_mentions_sudo: bool,
    command_words: set[int] | None = None,
    launcher: str = "xargs",
    hash_alias_names: dict[str, str] | None = None,
) -> str | None:
    """xargs/parallel run their first non-flag word; option operands are judged fail-closed."""
    operand_options = _LAUNCHER_OPERAND_OPTIONS.get(launcher, _XARGS_OPERAND_OPTIONS)
    operand_letters = _LAUNCHER_OPERAND_LETTERS.get(launcher, _XARGS_OPERAND_LETTERS)
    position = 0
    while position < len(following):
        word = words[following[position]]
        if word.is_data or word.is_redirect:
            return None
        if not _is_flag_word(word):
            return _scan_segment(
                words,
                following[position],
                depth,
                parent_mentions_sudo,
                command_words,
                hash_alias_names,
            )
        option, glued = _split_option(word.value, operand_options, operand_letters)
        if option is not None and glued is None and position + 1 < len(following):
            # BSD and GNU disagree on which operands are optional, so the operand
            # is judged as a command either way.
            operand = words[following[position + 1]]
            if not operand.is_data and not operand.is_redirect:
                violation = _scan_segment(
                    words,
                    following[position + 1],
                    depth,
                    parent_mentions_sudo,
                    command_words,
                    hash_alias_names,
                )
                if violation:
                    return violation
            position += 2
            continue
        position += 1
    return None


def _scan_script_source(
    words: list[_Word], following: list[int], depth: int, parent_mentions_sudo: bool
) -> str | None:
    """Judge a runner's script given as a redirect: `<<<` text or `<(cmd)` output."""
    for candidate in following:
        word = words[candidate]
        if word.heredoc == "<<<":
            # The payload can be attached to the operator (`bash<<<'sudo id'`) or
            # be the next word (`bash <<< 'sudo id'`); both are the script.
            sources = [word.value[3:]] if word.value[3:] else []
            operand = candidate + 1
            if operand < len(words) and not words[operand].is_data:
                sources.append(words[operand].value)
            for source in sources:
                violation = _scan_text(_strip_quotes(source), depth + 1, parent_mentions_sudo)
                if violation:
                    return violation
            continue
        if word.is_data:
            continue
        body = _process_substitution_body(word.value)
        if body and (parent_mentions_sudo or _mentions_sudo(_tokenize(body))):
            return (
                "the shell reads its script from a process substitution whose "
                "text invokes sudo/doas"
            )
    return None


_HASH_BUILTIN = "hash"


def _hash_registered_command_names(words: list[_Word]) -> tuple[dict[str, str], bool]:
    """(`hash -p pathname name` entries that run sudo/doas, unreadable).

    Bash's command hash table maps a name to the file it resolved to, and
    `hash -p pathname name` installs such an entry by hand, so a later `name`
    runs `pathname` however the name looks (`hash -p /usr/bin/sudo safe; safe
    id`). The guard resolves the entry, so the registered name scans as the
    command it runs. A registration whose target or name is built from
    expansion is reported as unreadable, because that entry could point
    anywhere. `hash` without `-p` only reads or clears the table, which cannot
    make a word run sudo/doas.
    """
    aliased: dict[str, str] = {}
    unreadable = False
    for index, word in enumerate(words):
        if word.value != _HASH_BUILTIN:
            continue
        has_pathname_option = False
        operands: list[str] = []
        for candidate in _segment_tail(words, index + 1):
            token = words[candidate].value
            if words[candidate].is_data or words[candidate].is_redirect:
                break
            if _is_flag_word(words[candidate]) and not token.startswith("--"):
                if "p" in token[1:]:
                    has_pathname_option = True
                    # `hash -p/path name` glues the pathname to the flag.
                    glued = token[token.index("p") + 1 :]
                    if glued:
                        operands.append(glued)
                continue
            if token.startswith("--"):
                continue
            if not has_pathname_option:
                break  # `hash name`, `hash -d name`, `hash -t name`: no entry
            operands.append(token)
        if not has_pathname_option or len(operands) < 2:
            continue
        # Every operand after the pathname is a name bash binds to that file.
        pathname = operands[0]
        names = operands[1:]
        if any(char in pathname + "".join(names) for char in "$`"):
            unreadable = True
            continue
        if any(char in name for name in names for char in "*?[]{}"):
            # A pattern name registers whatever it expands to (`hash -p
            # /usr/bin/sudo elevat?` binds `elevate`), which the scan cannot
            # resolve, so the entry is refused like any other unreadable one.
            unreadable = True
            continue
        for name in names:
            aliased[name] = pathname
    return aliased, unreadable


def _registered_command(value: str, hash_alias_names: dict[str, str] | None) -> str:
    """The file a `hash -p` registration makes this word run, else the word.

    A shell builtin keeps its own meaning: `_SHADOWPROOF_BUILTINS` covers the
    builtins the hash table cannot shadow (`eval`, `command`, `exec`, `builtin`,
    `type`, `alias`, `source`, `.`, `hash`), while a registration naming an
    external launcher is resolved to the file it runs.
    """
    if not hash_alias_names:
        return value
    target = hash_alias_names.get(value)
    if target is None or value in _SHADOWPROOF_BUILTINS:
        return value
    return target


def _scan_alias_bodies(
    words: list[_Word], start: int, depth: int, parent_mentions_sudo: bool = False
) -> str | None:
    """An alias body is text that a later use of the alias runs."""
    for candidate in _segment_tail(words, start):
        body = _alias_body(words[candidate])
        if body is None:
            continue
        violation = _scan_text(body, depth + 1, parent_mentions_sudo)
        if violation:
            return violation
    return None


def _scan_find_execs(
    words: list[_Word],
    start: int,
    depth: int,
    parent_mentions_sudo: bool,
    command_words: set[int] | None = None,
    flags: frozenset[str] = _FIND_EXEC_FLAGS,
    hash_alias_names: dict[str, str] | None = None,
) -> str | None:
    """`find -exec cmd` (and `fd -x cmd`) runs cmd, so its operand is judged as a command."""
    tail = _segment_tail(words, start)
    for offset, candidate in enumerate(tail):
        if words[candidate].value not in flags or offset + 1 >= len(tail):
            continue
        operand = words[tail[offset + 1]]
        if operand.is_data or operand.is_redirect:
            continue
        violation = _scan_segment(
            words,
            tail[offset + 1],
            depth,
            parent_mentions_sudo,
            command_words,
            hash_alias_names,
        )
        if violation:
            return violation
    return None


def _segment_tail(words: list[_Word], start: int) -> list[int]:
    """Indices of the words after the command word, up to the segment boundary."""
    indices: list[int] = []
    for index in range(start, len(words)):
        if words[index].is_operator:
            break
        indices.append(index)
    return indices
def _sudo_violation(command: str) -> str | None:
    """Reason phrase when the text invokes sudo/doas as a command, else None."""
    return _scan_text(_sudo_join_line_continuations(command), 0)


def _format_sudo_refusal(violation: str) -> str:
    return (
        f"Refusing to run this command: {violation}. sudo and doas run the command as "
        "root (or another user), which escapes the containment every other guard "
        "relies on; on a passwordless-sudo setup the escalation is silent. "
        "Bypass deliberately, so the intent stays visible in the transcript: "
        "call bash(command, allow_sudo=True), or start the kernel with "
        f"{BASH_SUDO_BYPASS_ENV}=1."
    )


def _warn_once_about_late_sudo_bypass() -> None:
    global _sudo_late_bypass_warned
    if _sudo_late_bypass_warned:
        return
    value = os.environ.get(BASH_SUDO_BYPASS_ENV)
    if value is None or value in ("", "0"):
        return
    _sudo_late_bypass_warned = True
    print(
        f"prime-agent bash: {BASH_SUDO_BYPASS_ENV} appeared after kernel start and is "
        "ignored; the sudo guard only honors it when the kernel is started with it set.",
        file=sys.stderr,
        flush=True,
    )


def _guard_sudo(script: str, allow_sudo: bool) -> None:
    """String-only scan for sudo/doas in the text the shell will run;
    refusals never start a process."""
    if allow_sudo or _SUDO_BYPASS_AT_KERNEL_START:
        return
    violation = _sudo_violation(script)
    if violation is None:
        return
    _warn_once_about_late_sudo_bypass()
    raise PrivilegeEscalationRefusalError(_format_sudo_refusal(violation))


def _run_kernel_bash_guards(
    command: str,
    script: str,
    command_prefix: str | None,
    *,
    allow_destructive_git: bool = False,
    allow_destructive_chmod: bool = False,
    allow_force_push: bool = False,
    allow_secret_echo: bool = False,
    allow_pipe_to_shell: bool = False,
    allow_sudo: bool = False,
) -> None:
    """Run every kernel-bash refusal guard on the text the shell will run.

    One entry point so `bash()` and a directly built `BashHandle` cannot
    disagree about which guards apply. `command` is the caller's text; `script`
    is the text the shell runs; `command_prefix` is the
    `PRIME_AGENT_BASH_COMMAND_PREFIX` value pinned by the caller, or None when
    the script has no trusted prefix region (a caller-supplied script).
    """
    _guard_destructive_git(command, allow_destructive_git, command_prefix, script)
    _guard_destructive_chmod(script, allow_destructive_chmod, command_prefix)
    _guard_force_push(script, allow_force_push, command_prefix or "")
    _guard_secret_echo(script, allow_secret_echo)
    _guard_pipe_to_shell(script, allow_pipe_to_shell)
    _guard_sudo(script, allow_sudo)


def bash(
    command: str,
    *,
    allow_destructive_git: bool = False,
    allow_destructive_chmod: bool = False,
    allow_force_push: bool = False,
    allow_secret_echo: bool = False,
    allow_pipe_to_shell: bool = False,
    allow_sudo: bool = False,
) -> BashHandle:
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

    Recursive chmod/chown commands (`chmod -R ...`, `chown -R ...`) are
    refused while any operand they name resolves outside the kernel
    workspace or onto the home directory, a dot-directory (e.g. .git), a
    dotfile, or the filesystem root; the guard fails closed on forms it
    cannot resolve (variable- or substitution-built command names, ANSI-C
    quoting, process substitutions feeding shell wrappers, BASH_ENV
    arming, CDPATH-affected relocations, nested quoted wrappers,
    abbreviated recursive flags, executor chains that relocate or feed
    the invocation (xargs, env -C/--chdir, find -execdir), `env -S`
    split strings, unreadable `hash -p` registrations, a PATH entry that
    can shadow the command word, and login or interactive shell
    wrappers that would source startup files);
    retry with allow_destructive_chmod=True
    (or start the kernel with PI_BASH_ALLOW_DESTRUCTIVE_CHMOD=1) only when
    the recursion is intentional.

    Force-push commands (`git push --force`, `git push -f`, `+`-prefixed
    refspecs) are refused while their target is protected: a refspec naming
    main/master or `@{u}`, every branch under `--all`/`--mirror`, or, when
    the refspec is implicit, the current upstream (probed with `git rev-parse
    @{u}`), including a branch that has no upstream at all. The probe is
    bounded and synchronous -- it runs on the kernel's event loop inside
    bash() -- and a probe that does not answer inside its budget is refused
    like any other unresolvable target. A push the scan
    cannot resolve is refused too: an argument carrying a variable, glob, or
    substitution; an ANSI-C-quoted command word; a git alias the command line
    defines for itself; `env -S`/`xargs` wrappers; a command that changes
    directory or repository first. A literal `--force-with-lease` or
    `--force-if-includes` is never refused, but an argument the scan cannot
    resolve is refused regardless of them: the shell can expand it into `-f`,
    and `-f` skips the lease compare-and-swap. Retry a deliberate force-push
    with bash(command, allow_force_push=True), or start the kernel with
    PI_BASH_ALLOW_FORCE_PUSH=1.

    Commands that echo secrets into the transcript are refused before any
    process starts, because that output persists in session logs that models
    and users read later: a bare environment dump (`env`, `printenv`,
    `export -p`, and flags-only forms such as `env -0`, with leading `FOO=1`
    assignments stripped, redirections such as `2>/dev/null` ignored, and
    quoted command words such as `"env"` read the shell's way), or a
    `cat`/`echo` -- the only readers modeled -- of a file under a known secret
    directory in the home directory (`~/.ssh`,
    `~/.gnupg`, `~/.aws`, written with either the `~` or the
    `$HOME` spelling, which also matches when a closing double quote sits
    between `$HOME` and the path). Read one value instead
    (`printenv SAFE_VAR`), filter a dump through a grep for the single fixed
    key you need (`env | grep SAFE_VAR`), and retry with allow_secret_echo=True
    (or start the kernel with PI_BASH_ALLOW_SECRET_ECHO=1) only when the full
    output is intentional; the env var is read once at kernel start, so
    writing it mid-session never unlocks the guard.

    Downloads that a shell interpreter would run are refused before any
    process starts: a `curl`/`wget` pipeline stage feeding a later stage of
    the same pipeline whose command word is a runner (`sh`, `bash`, `zsh`,
    `dash`, or `eval`/`source`/`.`), as in `curl -fsSL URL | sh`, `... | sudo
    bash`, `curl URL | cat | sh`, `curl URL | env -i sh`, or `curl URL |
    xargs sh`; a `$(...)`, backtick, or unquoted `<(...)` payload whose command
    word is `curl`/`wget` used as an argument of a runner (`sh -c "$(curl
    ...)"`, `bash <(curl ...)`); the words the runner itself executes, the
    script a `-c`-style flag hands an interpreter (`sh -c "curl ... | sh"`) and
    every argument of `eval` (`eval "curl ... | sh"`); and a wrapper-prefixed
    download
    (`env -i curl ... | sh`, `nice 5 curl ... | sh`). A stage the scan cannot
    resolve (`curl URL | $SHELL_CMD`) is refused too, and quoted spellings are
    read the shell's way (`"curl" URL | sh`). Download the script to a file,
    read the file, then run it in a later command (`curl -o script.sh URL`,
    then `sh script.sh`), and retry with allow_pipe_to_shell=True (or start the
    kernel with PI_BASH_ALLOW_PIPE_TO_SHELL=1) only when the download is
    trusted; the env var is frozen at kernel start, so writing it mid-session
    never unlocks the guard.

    A command that invokes sudo or doas is refused before any process starts,
    because root escapes the containment every other guard relies on. Bypass it
    deliberately with allow_sudo=True, or by starting the kernel with
    PI_BASH_ALLOW_SUDO=1 (honored only when set at kernel start, so a mid-session
    environment write cannot disable the guard).
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    # One read of the prefix feeds the guards and the spawn, so a mid-call
    # environment change cannot make the executed script differ from the text
    # the guards scanned. `_with_prefix` is called once for the script itself.
    command_prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    script = _with_prefix(command, command_prefix)
    _run_kernel_bash_guards(
        command,
        script,
        command_prefix,
        allow_destructive_git=allow_destructive_git,
        allow_destructive_chmod=allow_destructive_chmod,
        allow_force_push=allow_force_push,
        allow_secret_echo=allow_secret_echo,
        allow_pipe_to_shell=allow_pipe_to_shell,
        allow_sudo=allow_sudo,
    )
    handle = BashHandle(command, script=script, _validated=True)
    from . import repl

    repl.emit(
        {
            _BASH_COMMAND_MIME: {
                "command": _capped(command),
                "lines": sum(1 for line in command.splitlines() if line.strip()),
            }
        }
    )
    return handle


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


_PREFIX_UNSET: Any = object()


def _prefix_command(command: str, prefix: str | None) -> str:
    """The shell script for `command`, `prefix` prepended as its own line.

    The prefix text is threaded alongside the script so the guards scan the
    exact text the handle runs; the format lives in one place.
    """
    return f"{prefix}\n{command}" if prefix else command


def _with_prefix(command: str, prefix: Any = _PREFIX_UNSET) -> str:
    """The command as the kernel runs it: the setup prefix on its own line,
    when one is set. `prefix` pins the value so one caller can share a single
    environment read between the guards and the spawn; pass None explicitly to
    pin "no prefix" without re-reading the environment."""
    if prefix is _PREFIX_UNSET:
        prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    return _prefix_command(command, prefix)


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

    The guard bypass variables are dropped unless the kernel was launched with
    them, and `BASH_ENV`/`ENV` plus any exported `BASH_FUNC_name%%` function are
    dropped entirely: a mid-session write must not arm a nested kernel's frozen
    launch snapshot, point a child shell at an unscanned startup file, or shadow
    a command word the guards read literally.
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
    # Bypass variables are honored only when the kernel was launched with them:
    # a mid-session os.environ write this kernel ignores must not arm a nested
    # kernel's frozen launch-time snapshot.
    if not _BASH_DESTRUCTIVE_GIT_BYPASS_AT_START:
        env.pop(BASH_DESTRUCTIVE_GIT_BYPASS_ENV, None)
    if not _DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START:
        env.pop(BASH_DESTRUCTIVE_CHMOD_BYPASS_ENV, None)
    if not _FORCE_PUSH_BYPASS_AT_KERNEL_START:
        env.pop(BASH_FORCE_PUSH_BYPASS_ENV, None)
    if not _SECRET_ECHO_BYPASS_AT_KERNEL_START:
        env.pop(BASH_SECRET_ECHO_BYPASS_ENV, None)
    if not _PIPE_TO_SHELL_BYPASS_AT_KERNEL_START:
        env.pop(BASH_PIPE_TO_SHELL_BYPASS_ENV, None)
    if not _SUDO_BYPASS_AT_KERNEL_START:
        env.pop(BASH_SUDO_BYPASS_ENV, None)
    # Non-interactive bash sources $BASH_ENV (and some shells $ENV) before the
    # command; the env is model-writable mid-session, so never let it smuggle
    # an unscanned startup file past the guards.
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
        # `lstart` renders in the subprocess timezone and locale, so pin both
        # for a durable identity (TS getPsProcessStartId; the Rust host reads
        # the same pinned values - an unpinned match would drift on non-UTC
        # hosts and the identity comparison would never agree).
        out = subprocess.run(
            [ps, "-p", str(pid), "-o", "lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "LC_ALL": "C", "LC_TIME": "C", "LANG": "C", "TZ": "UTC"},
        ).stdout.strip()
        return f"ps:{out}" if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def _record_journal(pid: int, active: bool) -> bool:
    # Best-effort per the TS (core/orphan-process-journal.ts): journaling
    # failures never fail the spawn - a misconfigured owner pid is the only
    # hard False. Identity-free records (no processStartId) are valid and
    # still safely reaped on POSIX (the group-scoped kill).
    path = os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL")
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    if not path or not owner:
        return True
    try:
        owner_pid = int(owner)
    except ValueError:
        return False
    start_id = _process_start_id(pid) if active else None
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
    # TS parity (core/orphan-process-journal.ts): process tracking must not
    # make a successfully spawned command fail - a journal that cannot be
    # written (a vanished dir, a full disk) means the command runs untracked,
    # never that the spawn dies. The short-write guard still drops truncated
    # lines (the host discards them) but returns True: the command is alive.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    break
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass
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


def activity_request(action: str, activity_id: str | None = None, lines: int = 50) -> dict[str, Any]:
    """Inspect/stop only handles created by this kernel; called off the cell queue."""
    with _live_lock:
        if action == "list":
            handles = list(_activity_handles.items())
        else:
            handle = _activity_handles.get(activity_id or "")
            if handle is None:
                raise KeyError("Unknown kernel bash activity")
    if action == "list":
        rows = [
            {
                "id": key,
                "command": handle.command[:512],
                "pid": handle._pid,
                "startedAt": handle._started_at,
                "durationMs": int((handle._result.duration if handle._result else time.monotonic() - handle._started) * 1000),
                "status": "finished" if handle._reaped else "running",
                "exitCode": handle._result.exit_code if handle._result else None,
            }
            for key, handle in handles
        ]
        # The serialized list frame stays under the same 16 KiB cap as the
        # tail: long commands are truncated per row first, then rows drop
        # until the response fits - finished rows drop before running ones,
        # so live processes never fall off the activity list while they
        # are still the ones the user can act on.
        while len(json.dumps({"activities": rows})) > 16_384 and len(rows) > 1:
            victim = next(
                (index for index, row in enumerate(rows) if row["status"] != "running"),
                0,
            )
            rows.pop(victim)
        return {"activities": rows}
    if action == "tail":
        if isinstance(lines, bool) or not isinstance(lines, int) or not 1 <= lines <= 200:
            raise ValueError("lines must be an integer between 1 and 200")
        # Each retained buffer is bounded, and the response has a further byte cap.
        tail = "\n".join(handle._buffer.text().splitlines()[-lines:])
        payload = tail.encode("utf-8")[-16_384:].decode("utf-8", errors="replace")
        # json escaping can expand one character to six bytes, so a
        # byte-slice of the decoded text cannot bound the serialized size
        # alone. Trim the wrapped payload from the oldest end; the repl
        # handler enforces the same cap on the complete response frame.
        while len(json.dumps({"tail": payload})) > 16_384:
            excess = len(json.dumps({"tail": payload})) - 16_384
            keep = max(1, len(payload) - excess // 6 - 1)
            payload = payload[-keep:]
        return {"activityId": activity_id, "tail": payload}
    if action == "kill":
        if handle._reaped:
            return {"activityId": activity_id, "killed": False}
        handle.kill()
        return {"activityId": activity_id, "killed": True}
    raise ValueError("Unknown kernel bash action")
