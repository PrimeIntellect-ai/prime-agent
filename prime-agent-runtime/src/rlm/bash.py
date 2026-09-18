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

    def __init__(self, command: str, script: str | None = None) -> None:
        # Every asyncio use in this module runs on a handle path, so bind the
        # module global here, before _schedule_background_completion_notice or
        # any await can run.
        global asyncio
        import asyncio

        # `command` is the text the caller wrote and stays the display value
        # (the completion notice and repr use it). `script` is the text the
        # shell runs, computed once by `bash()` and validated by the guard
        # before it reached this handle; without one they are the same text, so
        # a handle built directly is guarded here instead -- the class must not
        # be a way around the guard, and the `bash()` path, whose script was
        # already validated, pays no second scan.
        if script is None:
            _guard_secret_echo(command, False)

        self.command = command
        self._script = script if script is not None else command
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
    it is a bounded flag. `-v`/`-f`/`-A`/`-B`/`-C` widen, and a digit is the
    `-NUM` context form (`-2` is `--context=2`, read the same way inside a
    cluster: `-10i`, `-i2`, `-F2`). The exception is a digit run directly
    after an `m`: that run is the argument of `-m`/`--max-count`, so it is
    consumed before the digit test -- unless it is all zeros, which prints the
    whole dump. A digit anywhere else stays unbounded (`-1m`).
    """
    index = 0
    while index < len(cluster):
        char = cluster[index]
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
    `--after-c=2`), and a pattern with regex metacharacters can match every
    line (`grep .`); a string-only scan cannot prove anything narrower about
    those shapes, so they stay refused. A lone `--` ends the options the way
    it does for grep, so a short-flag spelling after it is an operand rather
    than a flag (`grep -- -v` is a fixed-string filter, `grep -- -v KEY` is a
    pattern and a file). A digit run directly after an `m` is
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


def bash(command: str, *, allow_secret_echo: bool = False) -> BashHandle:
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
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    # One computation, read once per call: the guard validates exactly the
    # script the handle runs, so a mid-call change to the prefix cannot make
    # the validated text differ from the executed text.
    script = _with_prefix(command)
    _guard_secret_echo(script, allow_secret_echo)
    return BashHandle(command, script=script)


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
