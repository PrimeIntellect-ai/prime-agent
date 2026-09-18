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
# needs `if`/`then` so the pipeline inside a compound is still read.
_PIPE_SHELL_RESERVED_WORDS = (
    "!",
    "{",
    "}",
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


def _command_name(value: str) -> str:
    """The command name a word runs: its basename, as the shell resolves it."""
    return value.rsplit("/", 1)[-1]


def _matching_paren(command: str, open_index: int, end: int) -> int:
    """Index of the `)` matching the `(` at `open_index`, or `end - 1`.

    Quotes and escapes are read because a `)` inside them does not close the
    substitution (`$( : ')'; curl URL)` must scan the curl, not stop at the
    quoted paren)."""
    depth = 0
    index = open_index
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
            elif char == "\\" and index + 1 < end:
                index += 2
                continue
            index += 1
            continue
        if char == "\\":
            index += 2
            continue
        if char in "'\"":
            quote = char
            index += 1
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return end - 1


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
        name = _command_name(value)
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
        if resolved is not None and _command_name(resolved[0].value) in _DOWNLOAD_COMMANDS:
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
    name = _command_name(words[command_index].value)
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


def _stage_heredoc_body_runs_download(
    command: str, stage: _PipeShellStage, depth: int = 0
) -> bool:
    """Whether this stage's here-document bodies are a script that runs a
    download through a shell: a runner (`sh <<EOF`) executes the body's text,
    whether the pipeline is spelled in the body or arrives through a
    `$(curl ...)` the shell expands first, and a stage whose stdout continues
    into a runner hands it the same text, so the caller reads it the same
    way."""
    for body_start, body_end, _quoted in stage.heredoc_bodies:
        if (
            _pipe_shell_violation(command, body_start, body_end, depth + 1)
            is not None
        ):
            return True
        region = _scan_pipe_shell_region(command, body_start, body_end)
        for body_stage in region.stages:
            resolved = _stage_command_word(body_stage.words)
            if resolved is not None and _word_runs_download(command, resolved[0]):
                # The runner executes the expansion's output as a command
                # (`sh <<EOF` ... `$(curl ...) ... `EOF`), so a download whose
                # text the body hands to it is refused.
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
        if _command_name(word.value) == "env":
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
        if resolved is not None and _command_name(resolved[0].value) in _DOWNLOAD_COMMANDS:
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
            if resolved is not None and _command_name(resolved[0].value) in _RUNNERS:
                return True
            if resolved is None and _stage_runs_stdin_shell(inner.words):
                return True
    return False


def _stage_runs_stdin_shell(words: tuple[_PipeShellWord, ...]) -> bool:
    """Whether a wrapper-only stage starts a shell reading stdin: `sudo -s`
    and `sudo -i` with no further command run the user's shell with the
    pipeline's output on stdin, exactly like a bare `sh`."""
    for index, word in enumerate(words):
        if _command_name(word.value) == "sudo":
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
                if _command_name(resolved[0].value) in _RUNNERS:
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
            name = _command_name(word.value)
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
                if operand_resolved is not None and _command_name(
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
            resolved is not None and _command_name(resolved[0].value) in _RUNNERS
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


def _guard_pipe_to_shell(command: str, allow_pipe_to_shell: bool) -> None:
    """Refuse a curl/wget download that a shell interpreter would run: piped
    into one, or substituted into its argv. The scan is string-only and runs
    before any spawn, so a refused command never starts a process, and a
    command the patterns do not name pays for one linear pass."""
    if allow_pipe_to_shell or _PIPE_TO_SHELL_BYPASS_AT_KERNEL_START:
        return
    violation = _pipe_shell_violation(_with_prefix(command))
    if violation is None:
        return
    _warn_once_about_late_pipe_to_shell_bypass()
    raise PipeToShellRefusalError(_format_pipe_to_shell_refusal(violation))


def bash(command: str, *, allow_pipe_to_shell: bool = False) -> BashHandle:
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
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    _guard_pipe_to_shell(command, allow_pipe_to_shell)
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
