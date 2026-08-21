"""Async-by-default shell execution: bash() spawns immediately and returns a live handle."""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import shutil
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Generator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

_IS_POSIX = os.name == "posix"

_HEAD_CAP = 512 * 1024
_TAIL_CAP = 3 * 512 * 1024
_READ_CHUNK = 65536

_live_handles: set["BashHandle"] = set()
_live_lock = threading.Lock()
_hook_installed = False
_hook_lock = threading.Lock()


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
            while self._tail_size > _TAIL_CAP and len(self._tail) > 1:
                dropped = self._tail.popleft()
                self._tail_size -= len(dropped)
                self._dropped += len(dropped)
            if self._tail_size > _TAIL_CAP:
                only = self._tail.popleft()
                excess = self._tail_size - _TAIL_CAP
                self._tail.append(only[excess:])
                self._tail_size -= excess
                self._dropped += excess

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
    """Live handle to a background shell command; await it for the BashResult."""

    def __init__(self, command: str) -> None:
        self.command = command
        self._buffer = _BoundedBuffer()
        self._done = threading.Event()
        self._result: BashResult | None = None
        self._started = time.monotonic()
        # On POSIX, start_new_session gives the child its own process group so
        # kill() and the shutdown hook can signal the whole pipeline at once.
        # On Windows there is no process-group signalling; kill() falls back to
        # Popen.kill() on the shell process.
        self._proc = subprocess.Popen(
            [_shell(), "-c", _with_prefix(command)],
            cwd=os.getcwd(),
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            **({"start_new_session": True} if _IS_POSIX else {}),
        )
        self.pid: int = self._proc.pid
        with _live_lock:
            _live_handles.add(self)
        _record_journal(self.pid, active=True)
        threading.Thread(target=self._pump, daemon=True).start()

    @property
    def running(self) -> bool:
        return not self._done.is_set()

    def output(self) -> str:
        return self._buffer.text()

    def tail(self, n: int = 50) -> str:
        return "\n".join(self._buffer.text().splitlines()[-n:])

    def poll(self) -> BashResult | None:
        return self._result if self._done.is_set() else None

    def kill(self, sig: int = signal.SIGTERM, grace: float = 5.0) -> None:
        if self._done.is_set():
            return
        if not _IS_POSIX:
            # Windows has no process-group signal; TerminateProcess the shell.
            try:
                self._proc.kill()
            except OSError:
                pass
            return
        _signal_group(self.pid, sig)
        if sig == signal.SIGTERM:
            timer = threading.Timer(grace, self._force_kill)
            timer.daemon = True
            timer.start()

    def _force_kill(self) -> None:
        if not self._done.is_set():
            _signal_group(self.pid, signal.SIGKILL)

    def _pump(self) -> None:
        stdout = self._proc.stdout
        assert stdout is not None
        try:
            while chunk := stdout.read1(_READ_CHUNK):
                self._buffer.write(chunk)
        except (OSError, ValueError):
            pass
        stdout.close()
        exit_code = self._proc.wait()
        self._result = BashResult(
            exit_code=exit_code,
            output=self._buffer.text(),
            duration=time.monotonic() - self._started,
        )
        _record_journal(self.pid, active=False)
        with _live_lock:
            _live_handles.discard(self)
        self._done.set()

    async def _wait(self) -> BashResult:
        # _pump completes on its own thread; the executor bridge just parks this
        # coroutine on the event without blocking the event loop.
        await asyncio.get_running_loop().run_in_executor(None, self._done.wait)
        assert self._result is not None
        return self._result

    def __await__(self) -> Generator[Any, None, BashResult]:
        return self._wait().__await__()

    def __repr__(self) -> str:
        state = f"exit_code={self._result.exit_code}" if self._result else "running"
        return f"<BashHandle pid={self.pid} {state} command={self.command!r}>"


def bash(command: str) -> BashHandle:
    """Start a shell command in the background; await the handle for the result."""
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    return BashHandle(command)


def _shell() -> str:
    # Read per call: the forkserver applies session env after the fork.
    return os.environ.get("PRIME_AGENT_BASH_SHELL") or shutil.which("bash") or "/bin/sh"


def _with_prefix(command: str) -> str:
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    return f"{prefix}\n{command}" if prefix else command


def _child_env() -> dict[str, str]:
    return {**os.environ, "NO_COLOR": "1", "TERM": "dumb", "CLICOLOR": "0", "FORCE_COLOR": "0"}


def _signal_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def _process_start_id(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat", "r") as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2 :].split(" ")
        if len(fields) > 19 and fields[19]:
            return f"proc:{fields[19]}"
    except (OSError, ValueError):
        pass
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=5
        ).stdout.strip()
        return f"ps:{out}" if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def _record_journal(pid: int, active: bool) -> None:
    path = os.environ.get("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL")
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    if not path or not owner:
        return
    try:
        owner_pid = int(owner)
    except ValueError:
        return
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
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (json.dumps(record) + "\n").encode())
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def _kill_live_handles() -> None:
    with _live_lock:
        handles = list(_live_handles)
    for handle in handles:
        if _IS_POSIX:
            _signal_group(handle.pid, signal.SIGKILL)
        else:
            try:
                handle._proc.kill()
            except OSError:
                pass
        _record_journal(handle.pid, active=False)


def _install_shutdown_hook() -> None:
    global _hook_installed
    with _hook_lock:
        if _hook_installed:
            return
        _hook_installed = True
    atexit.register(_kill_live_handles)
    try:
        kernel = get_ipython().kernel  # type: ignore[name-defined]
    except (AttributeError, NameError):
        return
    if getattr(kernel, "_prime_agent_bash_shutdown", False):
        return
    original = kernel.do_shutdown

    async def do_shutdown(restart: bool):
        _kill_live_handles()
        result = original(restart)
        if hasattr(result, "__await__"):
            return await result
        return result

    kernel.do_shutdown = do_shutdown
    kernel._prime_agent_bash_shutdown = True
