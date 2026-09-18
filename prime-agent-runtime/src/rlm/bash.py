"""Async-by-default shell execution: bash() spawns immediately and returns a live handle."""

from __future__ import annotations

import functools
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable, Collection, Generator
from dataclasses import dataclass, replace
from typing import Any, cast

from . import _winjob

# Boot-lean imports: asyncio, secrets, shutil, datetime, selectors, struct,
# fcntl/termios, and atexit load on first use below so `import rlm` (and with
# it the kernel's pre-ready startup path) stays small. asyncio is bound onto
# this module's globals by BashHandle.__init__ before any code path here can
# touch it; every other user imports inside the function that needs it.

_IS_POSIX = os.name == "posix"

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
        # Every asyncio use in this module runs on a handle path (bash() is the
        # only constructor), so bind the module global here, before
        # _schedule_background_completion_notice or any await can run.
        global asyncio
        import asyncio

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
            import secrets

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
        import selectors

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
        import selectors

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
        import fcntl
        import struct
        import termios
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
        import secrets

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


def _normalize_line_continuations(command: str) -> str:
    """Collapse unquoted backslash-newline line continuations.

    The shell removes the pair before it builds words, so `chmod -R \
755 ~` runs as `chmod -R 755 ~` and `chmo\
d -R 755 ~` runs as `chmod -R 755 ~` (an in-word continuation joins the
    word). A continuation between words becomes two spaces, which is
    length-preserving so the scan's character indices stay aligned with the
    original command; inside a word the pair is left for
    `_strip_shell_escapes` to remove, because a two-character placeholder
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
                # `_strip_shell_escapes` removes both characters, so
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
_REDIRECT_OPERATOR = re.compile(r"(?:&>{1,2}|>&|[0-9]*[<>]{1,3}(&[0-9]+)?)(?!\()")
_STATIC_REDIRECT_TARGET = re.compile(r"""[^\s;&|<>()$`"']*""")


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
        delim_match = _STATIC_REDIRECT_TARGET.match(command, j)
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


def _mask_shell_redirections(command: str, depth: int = 0) -> str:
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
            operator = _REDIRECT_OPERATOR.match(command, i)
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
            interior = _mask_shell_redirections(command[i + 2 : j], depth + 1)
            chars[i + 2 : j] = list(interior)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n and chars[j] != "`":
                j += 1
            interior = _mask_shell_redirections(command[i + 1 : j], depth + 1)
            chars[i + 1 : j] = list(interior)
            i = j
        i += 1
    return "".join(chars)


def _strip_shell_escapes(command: str) -> tuple[str, list[int]]:
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
_MAX_EVAL_SCAN_DEPTH = 10


def _unquote_one_level(text: str) -> str:
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
class _ShellWord:
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


def _matching_paren(command: str, open_index: int, end: int) -> int:
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
        if esc in _ANSI_C_SIMPLE_ESCAPES:
            out.append(_ANSI_C_SIMPLE_ESCAPES[esc])
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
    words: list[_ShellWord],
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


def _scan_shell_words(command: str) -> list[_ShellWord]:
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
    words: list[_ShellWord] = []

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
                words.append(_ShellWord("".join(value), word_start, i, word_starts_command))
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
                    close = _matching_paren(command, j + 1, end)
                    _mark_contained_interiors(words, scan_region, j + 2, close, depth)
                    value.append(command[j + 1 : close + 1])
                    j = close + 1
                    continue
                if inner == "`":
                    close = command.find("`", j + 1, end)
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
                close = _matching_paren(command, i + 1, end)
                _mark_contained_interiors(words, scan_region, i + 2, close, depth)
                value.append(command[i + 1 : close + 1])
                i = close + 1
                continue
            if ch == "`":
                close = command.find("`", i + 1, end)
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
    abbreviation of it (`--rec` through `--recursiv`)."""
    for token in tokens:
        if token in _RECURSIVE_LONG_FLAGS:
            return True
        if token.startswith("-") and not token.startswith("--") and "R" in token[1:]:
            return True
    return False


def _contained_in_later_word(words: list[_ShellWord], index: int) -> bool:
    """True when words[index] is a command-substitution interior: its span
    sits inside the enclosing word, which the scanner appends after the
    interiors it recursed into, and the scan marks the flag at scan time.
    Interiors execute inside the substitution, so walkers must look
    through them, not stop at them."""
    return words[index].contained


def _find_recursive_chmod_chown_invocations(
    command: str,
    words: list[_ShellWord] | None = None,
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
        words = _scan_shell_words(command)
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
    return invocations


_HASH_BUILTIN = "hash"


def _hash_registered_command_names(
    words: list[_ShellWord],
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
        if os.path.basename(word.value) != _HASH_BUILTIN:
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
    words: list[_ShellWord], text: str, kinds: tuple[str, ...]
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


def _payload_text_hides_shell_code(text: str, depth: int = 0) -> str | None:
    """Why a one-level-unquoted wrapper payload hides shell code the guard
    must refuse, or None when it does not: a recursive chmod/chown
    (directly, or behind further quoted wrappers: mixed or nested eval and
    `sh -c` forms), the argv an `env -S` string splits into, a command name
    a variable, substitution, or `hash -p` registration could point at, a
    BASH_ENV arming, a shell wrapper that would source a startup file, or a
    process substitution feeding a shell wrapper. Each layer is unquoted one
    shell quoting level at a time, so quoted data stays inert while quoted
    code is caught. Absurd nesting is refused outright."""
    if depth > _MAX_EVAL_SCAN_DEPTH:
        return "recursive_chmod"  # absurdly nested wrappers: refuse rather than risk a miss
    normalized, _index_map = _strip_shell_escapes(
        _mask_shell_redirections(_normalize_line_continuations(text))
    )
    words = _scan_shell_words(normalized)
    hash_alias_names, hash_unreadable = _hash_registered_command_names(words)
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
    env_split_feeds, env_split_reasons = _env_split_string_feeds(words)
    for feed in env_split_feeds:
        reason = _payload_text_hides_shell_code(feed, depth + 1)
        if reason is not None:
            return reason
    if env_split_reasons:
        return "env_split_expansion"
    if any(os.path.basename(w.value) in _SCRIPT_INPUT_WRAPPERS for w in words):
        script_reason = _unscanned_wrapper_script_reason(text, normalized, words, 0)
        if script_reason == "startup":
            return "shell_startup"
        if script_reason is not None:
            return "unscanned_script"
    for source in _wrapper_payload_sources(words, normalized, _WRAPPER_PAYLOAD_KINDS):
        payload = _unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, depth + 1)
        if reason is not None:
            return reason
    return None


def _eval_payloads_hide_recursive_chmod(command: str, depth: int = 0) -> str | None:
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
    if depth > _MAX_EVAL_SCAN_DEPTH:
        return "recursive_chmod"  # absurdly nested evals: refuse rather than risk a miss
    words = _scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("eval",)):
        payload = _unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload, depth)
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
    words, well_formed = _shell_words(raw)
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


def _shell_words(region: str) -> tuple[list[str | None], bool]:
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
_ASSIGNMENT_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
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
_COMMAND_SLOT_NOISE = ("{", "}", "(", ")", "then", "do", "else", "elif", "!")
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


def _run_tokens_from(words: list[_ShellWord], index: int) -> list[str]:
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


def _word_could_expand(word: _ShellWord, span_source: str) -> bool:
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
    words: list[_ShellWord],
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
    head: _ShellWord | None = None
    for index, word in enumerate(words):
        # Substitution interiors execute inside the substitution; the run
        # head for the enclosing word is the word before it, not them.
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if _ASSIGNMENT_WORD.match(word.value):
            continue  # a variable assignment, not a command name
        span_source = (
            normalized[word.start : word.end] if normalized is not None else word.value
        )
        if not _word_could_expand(word, span_source):
            continue
        effective_command = word.starts_command
        executor_run = head is not None and (
            _ASSIGNMENT_WORD.match(head.value)
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


def _path_can_shadow_command_lookup(words: list[_ShellWord], workspace: str) -> bool:
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


def _bash_env_words_arm_shell_code(words: list[_ShellWord]) -> bool:
    """True when the scanned words arm BASH_ENV for a command:
    non-interactive bash runs that file's shell code before the command
    text, so the guard cannot scan what executes and the run is refused.
    Reading or removing BASH_ENV (`echo $BASH_ENV`, `unset BASH_ENV`,
    `env -u BASH_ENV`) stays fine."""
    head: _ShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if not _BASH_ENV_ASSIGNMENT.match(word.value):
            continue
        if word.starts_command or (
            head is not None
            and (
                _ASSIGNMENT_WORD.match(head.value)
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
                close = _matching_paren(command, i + 1, n)
                spans.append((i, close))
                i = close
            elif ch == "`":
                close = command.find("`", i + 1)
                if close == -1:
                    close = n - 1
                spans.append((i, close))
                i = close
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "$" and command[i + 1 : i + 2] == "(":
            close = _matching_paren(command, i + 1, n)
            spans.append((i, close))
            i = close
        elif ch == "`":
            close = command.find("`", i + 1)
            if close == -1:
                close = n - 1
            spans.append((i, close))
            i = close
        i += 1
    return spans


def _heredoc_bodies_hide_shell_code(raw: str, allow_destructive_chmod: bool) -> None:
    """Refuse here-document bodies that execute as shell code: a shell
    wrapper directly fed by the heredoc (`bash <<EOF ... EOF`) runs the
    body as its script, so the body is scanned with the full guard
    (in-workspace recursion stays allowed); a heredoc inside a command
    substitution or backtick (`eval "$(cat <<EOF ...)"`) flows out as text
    that can become code, so its body is scanned the same way. Bodies read
    as data by non-wrapper commands stay inert (masked), and an
    unterminated heredoc executes nothing after it."""
    substitution_spans = _substitution_spans(raw)
    for operator in _REDIRECT_OPERATOR.finditer(raw):
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
            # (operand resolution included), propagating its refusal.
            _guard_destructive_chmod(body.strip("\n"), allow_destructive_chmod)


def _process_substitution_feeds_wrapper(
    normalized: str, words: list[_ShellWord] | None = None
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
        words = _scan_shell_words(normalized)
    head: _ShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if os.path.basename(word.value) not in _PROC_SUB_WRAPPERS:
            continue
        introduced = word.starts_command or (
            head is not None
            and (
                _ASSIGNMENT_WORD.match(head.value)
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
        region = re.split(r"[;&|\n]", normalized[rest_from:], 1)[0]
        if "<(" in region or ">(" in region or "<<<" in region:
            return True
    return False


# Wrappers that execute a named script file (argument or stdin redirect).
_SCRIPT_INPUT_WRAPPERS = ("sh", "bash", "zsh", "dash", "ksh", "source", ".")
# A PATH assignment changes where a slash-free `source` operand resolves.
_PATH_ASSIGNMENT = re.compile(r"(?<![A-Za-z0-9_])PATH\+?=")

_FUNCTION_DEFINITION = re.compile(r"\(\s*\)\s*[({]|function\s+[A-Za-z_]")


def _function_definition_could_recurse(
    normalized: str, words: list[_ShellWord]
) -> bool:
    """True when a shell function definition could carry a recursive
    chmod/chown: bash forwards the call arguments into the definition
    (`f() { chmod "$@"; }; f -R 755 /`), so a chmod/chown word in the
    definition plus a recursive flag anywhere in the command are refused
    together rather than resolved apart."""
    if not _FUNCTION_DEFINITION.search(normalized):
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


def _unscanned_wrapper_script_reason(
    raw: str,
    normalized: str,
    words: list[_ShellWord],
    user_command_start: int,
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
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    prefix_relocates = bool(prefix) and bool(
        re.search(r"\b(?:cd|pushd|popd)\b", prefix)
    )
    head: _ShellWord | None = None
    for index, word in enumerate(words):
        if word.starts_command and not _contained_in_later_word(words, index):
            head = word
        if os.path.basename(word.value) not in _SCRIPT_INPUT_WRAPPERS:
            continue
        introduced = word.starts_command or (
            head is not None
            and (
                _ASSIGNMENT_WORD.match(head.value)
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
        script_word: _ShellWord | None = None
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
        region = re.split(r"[;&|\n]", raw[raw_end:], 1)[0]
        for match in re.finditer(r"<>?\s*([^\s;&|<>()]+)", region):
            candidates.append(match.group(1))
        if not candidates:
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
                found = None
                for path_dir in (os.environ.get("PATH") or "").split(os.pathsep):
                    if not path_dir:
                        continue
                    hit = os.path.join(path_dir, candidate)
                    try:
                        if os.path.isfile(hit):
                            found = hit
                            break
                    except OSError:
                        continue
                if found is None:
                    continue  # bash errors on a missing PATH hit; harmless
                try:
                    resolved = os.path.realpath(found)
                except (OSError, RuntimeError, ValueError):
                    resolved = None
            else:
                resolved = _resolve_chmod_operand(candidate, base, home_env)
            if _script_input_violation(resolved, workspace, home_real):
                return candidate
    return None


def _shell_wrapper_reads_pipe(normalized: str, words: list[_ShellWord]) -> bool:
    """True when a bare shell wrapper takes its commands from a pipeline
    or a here-string/redirect: the fed script content cannot be scanned
    statically, so the wrapper form is refused. Wrappers governed by a
    `-c` payload or a script argument read that instead and stay fine."""
    for index, word in enumerate(words):
        if not word.starts_command:
            continue
        if os.path.basename(word.value) not in _SHELL_C_INTERPRETERS:
            continue
        before = normalized[: word.start].rstrip()
        if not before.endswith("|"):
            continue
        c_payload = False
        script_arg = False
        for follower_index in range(index + 1, len(words)):
            follower = words[follower_index]
            if follower.starts_command:
                if _contained_in_later_word(words, follower_index):
                    continue
                break
            token = follower.value
            if token.startswith("-") and token != "-" and not token.startswith("--"):
                if "c" in token[1:]:
                    c_payload = True
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


def _shell_c_payloads_hide_recursive_chmod(command: str) -> str | None:
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
    words = _scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("shell_c",)):
        payload = _unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload)
        if reason is not None:
            return reason
    return None


def _alias_payloads_hide_recursive_chmod(command: str) -> str | None:
    """Why a quoted alias body hides shell code the guard must refuse
    (truthy), or None when it does not: an alias body executes as shell
    code at use time, and a body carrying a recursive chmod/chown is
    refused because the call site shows none of it."""
    words = _scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("alias",)):
        payload = _unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload)
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


def _env_option_value(tokens: list[str], short: str, long: str) -> str | None:
    """The first value `env` passes for one of its value options, or None
    when the command does not use it."""
    values = _env_option_values(tokens, short, long)
    return values[0] if values else None


def _split_env_string(value: str) -> str | None:
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


def _env_split_string_feeds(words: list[_ShellWord]) -> tuple[list[str], list[str]]:
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
            split = _split_env_string(value)
            if split is None:
                reasons.append(
                    f"{value!r}: names the argv env runs through shell"
                    " expansion, which the guard cannot resolve"
                )
                continue
            feeds.append(split)
    return feeds, reasons


def _env_split_string_payloads_hide_recursive_chmod(command: str) -> str | None:
    """Why a GNU env -S/--split-string payload hides shell code the guard
    must refuse (truthy), or None when it does not: env splits the string
    into a command line and executes it, so every split argv is scanned like
    a wrapper payload, in each spelling of the flag (detached, attached, or
    bundled in a cluster) and for every `env` word. env without -S executes
    only a literal command word and is scanned by the plain invocation scan
    already."""
    feeds, reasons = _env_split_string_feeds(_scan_shell_words(command))
    for feed in feeds:
        reason = _payload_text_hides_shell_code(feed)
        if reason is not None:
            return reason
    if reasons:
        return "env_split_expansion"
    return None


def _trap_payloads_hide_recursive_chmod(command: str) -> str | None:
    """Why a trap body hides shell code the guard must refuse (truthy), or
    None when it does not: a trap body executes at trigger time (EXIT,
    DEBUG runs before every command), and a body carrying a recursive
    chmod/chown is refused because nothing else in the command shows it."""
    words = _scan_shell_words(command)
    for source in _wrapper_payload_sources(words, command, ("trap",)):
        payload = _unquote_one_level(_expand_ansi_c_payloads(source))
        reason = _payload_text_hides_shell_code(payload)
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
        if run_words[index] in _COMMAND_SLOT_NOISE or _ASSIGNMENT_WORD.match(
            run_words[index]
        ):
            # An assignment prefix, a grouping token, or a group keyword holds
            # the command slot without being the command: the wrapper after it
            # is the one that runs (`FOO=1 env -C / chmod ...`, `{ env -C / ... }`).
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


def _guard_destructive_chmod(command: str, allow_destructive_chmod: bool) -> None:
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
    resolver runs only on a match, so other commands pay nothing."""
    if allow_destructive_chmod or _DESTRUCTIVE_CHMOD_BYPASS_AT_KERNEL_START:
        return
    command_prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    raw = _normalize_line_continuations(_with_prefix(command))
    resolved = _mask_shell_redirections(raw)
    normalized, index_map = _strip_shell_escapes(resolved)
    words = _scan_shell_words(normalized)
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
    hash_alias_names, hash_unreadable = _hash_registered_command_names(words)
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
        _heredoc_bodies_hide_shell_code(raw, allow_destructive_chmod)
    # The cheap gates are word-driven, not raw-text-driven: quote- and
    # ANSI-C-encoded wrapper names (`e"val"`, `$'bash'`) fold to the
    # wrapper word in the scan even though no contiguous `eval`/`bash` text
    # appears, so the parsed words decide whether to scan wrapper payloads.
    # The payload scanners re-tokenize their input, so they get the
    # escape-stripped text: an in-word line continuation left in the
    # pre-strip text would fold into the wrapper word's value (`ba<cont>sh`
    # scans as `ba\nsh`, not `bash`) and hide the wrapper payload entirely.
    eval_reason = (
        _eval_payloads_hide_recursive_chmod(normalized)
        if any(word.value == "eval" for word in words)
        or re.search(r"\beval\b", normalized)
        else None
    )
    shell_c_reason = (
        _shell_c_payloads_hide_recursive_chmod(normalized)
        if any(os.path.basename(word.value) in _SHELL_C_INTERPRETERS for word in words)
        or re.search(r"\b(?:sh|bash|zsh|dash|ksh)\b", normalized)
        else None
    )
    alias_reason = (
        _alias_payloads_hide_recursive_chmod(normalized)
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
        _env_split_string_payloads_hide_recursive_chmod(normalized)
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
        _trap_payloads_hide_recursive_chmod(normalized)
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
            raw, normalized, words, user_command_start
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
    if command_prefix and re.search(r"\b(?:cd|pushd|popd)\b", command_prefix):
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
                _env_option_value(tokens, "C", "chdir") is not None
            ):
                raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
            if wrapper == "find" and "-execdir" in tokens:
                raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
        effective_cwd = _resolve_chmod_effective_cwd(normalized[:start], user_command_start, workspace)
        if effective_cwd is _UNRESOLVABLE_CHMOD_CWD:
            raise DestructiveChmodRefusalError(_format_chmod_relocation_refusal())
        base = workspace if effective_cwd is None else effective_cwd
        region_words, well_formed = _shell_words(normalized[start:end])
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


def bash(command: str, *, allow_destructive_chmod: bool = False) -> BashHandle:
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
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    _guard_destructive_chmod(command, allow_destructive_chmod)
    return BashHandle(command)


def _shell() -> str:
    import shutil

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
    import shutil

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

    BASH_ENV and ENV are dropped entirely: non-interactive bash runs
    $BASH_ENV before every command, so an inherited value could execute
    shell code the chmod/chown guard never scanned (arming BASH_ENV from
    the command text is refused by the guard; this removes the inherited
    form). Exported shell functions (`BASH_FUNC_name%%`) are dropped for the
    same reason: bash imports them before the command text runs, so a body
    the guard never reads could run a recursive chmod/chown, and a command
    word would then not be the program the guard checked.
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
    env.pop("BASH_ENV", None)
    env.pop("ENV", None)
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
    from datetime import datetime, timezone

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
    import atexit

    with _hook_lock:
        if _hook_installed:
            return
        _hook_installed = True
    atexit.register(_kill_live_handles)
