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
from collections.abc import Callable, Generator
from dataclasses import dataclass
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
                command,
                completion_token[:token_midpoint],
                completion_token[token_midpoint:],
            )
        else:
            # Windows lacks a foreground-status channel, so its exit drain stays best-effort.
            script = command
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
# wedged git (huge repo, hung filesystem) cannot hang the guard with it.
_FORCE_PUSH_PROBE_TIMEOUT_SECONDS = 10.0


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


def bash(command: str, *, allow_force_push: bool = False) -> BashHandle:
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

    Force-push commands (`git push --force`, `git push -f`, `+`-prefixed
    refspecs) are refused while their target is protected: a refspec naming
    main/master or `@{u}`, every branch under `--all`/`--mirror`, or, when
    the refspec is implicit, the current upstream (probed with `git rev-parse
    @{u}`), including a branch that has no upstream at all. A push the scan
    cannot resolve is refused too: an argument carrying a variable, glob, or
    substitution; an ANSI-C-quoted command word; a git alias the command line
    defines for itself; `env -S`/`xargs` wrappers; a command that changes
    directory or repository first. A literal `--force-with-lease` or
    `--force-if-includes` is never refused, but an argument the scan cannot
    resolve is refused regardless of them: the shell can expand it into `-f`,
    and `-f` skips the lease compare-and-swap. Retry a deliberate force-push
    with bash(command, allow_force_push=True), or start the kernel with
    PI_BASH_ALLOW_FORCE_PUSH=1.
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    # One read of the prefix feeds both the scan and the spawn, so a change of
    # the environment mid-call can no longer make the spawned script differ
    # from the text the guard scanned.
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    # `_with_prefix` re-reads the environment for an unset value, so only a
    # set prefix is joined here: the pinned read above is the only one.
    command_text = _with_prefix(command, prefix) if prefix else command
    _guard_force_push(command_text, allow_force_push, prefix or "")
    return BashHandle(command_text)


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


def _with_prefix(command: str, prefix: str | None = None) -> str:
    """The command as the kernel runs it: the setup prefix on its own line,
    when one is set. `prefix` pins the value so one caller can share a single
    environment read between the guard and the spawn."""
    if prefix is None:
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
    """
    return {
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
