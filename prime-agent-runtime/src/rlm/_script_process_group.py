"""Process-group isolation and interrupt escalation for %%bash/%%script cells.

IPython's ``ScriptMagics.shebang`` (``IPython/core/magics/script.py``, a
third-party, pip-installed dependency -- not part of this repo) spawns a
``%%bash``/``%%script`` cell's shell via ``asyncio.create_subprocess_exec``
with no process-group isolation, so the shell (and anything it execs or
forks, e.g. a backgrounded ``grep``) shares this kernel process's own OS
process group. Interrupting the cell (Esc in Prime Agent) only ever reaches
the kernel's own pid -- via ipykernel's SIGINT delivery for the host's
``interrupt_request`` -- never the shell's own children, so a stuck or
backgrounded child leaks and keeps running at full CPU indefinitely (see
prime-agent#849).

This module, imported unconditionally from :mod:`rlm` at kernel bootstrap:

1. Scopes a process-group-isolating ``asyncio.create_subprocess_exec`` proxy
   to ``IPython.core.magics.script``'s own module namespace only (no other
   code in the process is affected).
2. Tracks every subprocess spawned that way in a small, self-pruning
   registry.
3. Installs a ``SIGINT`` handler (chaining to whatever was previously
   installed, e.g. ipykernel's own) that escalates SIGINT -> SIGTERM ->
   SIGKILL against each tracked subprocess's *process group* -- never the
   kernel process itself, which is never made a member of any of these
   groups and is therefore untouched.

An explicitly backgrounded script (``%%bash --bg``, tracked in IPython's own
``ScriptMagics.bg_processes``) is excluded: it is expected to outlive its
cell, so an unrelated later interrupt must not sweep it.
"""

from __future__ import annotations

import os
import signal
import threading
from typing import Any, Callable

try:
    from IPython.core.magics import script as _ipython_script_magics
except Exception:  # pragma: no cover - only available inside a real kernel
    _ipython_script_magics = None  # type: ignore[assignment]

# Escalation timeline. Kept as module attributes (not local constants) so
# tests can shrink them instead of sleeping through production-sized delays.
SIGTERM_DELAY_SECONDS = 1.0
SIGKILL_DELAY_SECONDS = 0.5

_INSTALLED_MARKER = "_prime_agent_script_process_group_patch"

# pid -> pgid, for every process the proxy below has spawned that has not yet
# been confirmed dead. Pruned opportunistically; never grows unbounded across
# a long session because every registration prunes first.
_tracked_pids: dict[int, int] = {}
_tracked_lock = threading.Lock()


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _group_alive(pgid: int) -> bool:
    """Whether any process remains in the group -- NOT whether the original
    spawned (leader) pid is still alive. A non-interactive bash exits as soon
    as it hits EOF on its script input, often well before a backgrounded
    child (`cmd &`) it started finishes; checking the leader's own pid would
    then wrongly conclude the whole group is already gone -- both here
    (pruning it out of the tracked registry before an interrupt ever
    arrives) and during escalation (skipping straight past SIGTERM/SIGKILL)
    -- and leak exactly the child this module exists to stop.
    """
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _prune_tracked_locked() -> None:
    for pid, pgid in [(pid, pgid) for pid, pgid in _tracked_pids.items() if not _group_alive(pgid)]:
        _tracked_pids.pop(pid, None)


def _register_tracked_pid(pid: int, pgid: int) -> None:
    with _tracked_lock:
        _prune_tracked_locked()
        _tracked_pids[pid] = pgid


def _backgrounded_pids() -> set[int]:
    """PIDs IPython itself considers explicitly backgrounded (%%bash --bg):
    these must survive an unrelated interrupt, matching user intent.
    """
    if _ipython_script_magics is None:
        return set()
    try:
        from IPython.core.interactiveshell import InteractiveShell

        shell = InteractiveShell.instance()
        script_magics = shell.magics_manager.registry.get("ScriptMagics")
    except Exception:
        return set()
    if script_magics is None:
        return set()
    try:
        return {proc.pid for proc in getattr(script_magics, "bg_processes", []) if proc.pid is not None}
    except Exception:
        return set()


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def _escalate(pid: int, pgid: int) -> None:
    """Runs on a background daemon thread: SIGINT was already sent by the
    signal handler before this was scheduled. Wait, then escalate only if the
    group is still alive.

    SIGINT alone is not sufficient even when the group is reachable: a
    non-interactive bash sets SIGINT (and SIGQUIT) to be ignored for any
    `cmd &` backgrounded child by POSIX/bash convention specifically so an
    interactive Ctrl-C does not reach background jobs -- confirmed
    empirically (see the plan's Investigation). SIGTERM/SIGKILL are not
    auto-ignored this way, so the escalation must actually reach them.
    """
    threading.Event().wait(SIGTERM_DELAY_SECONDS)
    if _group_alive(pgid):
        _signal_group(pgid, signal.SIGTERM)
        threading.Event().wait(SIGKILL_DELAY_SECONDS)
        if _group_alive(pgid):
            _signal_group(pgid, signal.SIGKILL)
    with _tracked_lock:
        _tracked_pids.pop(pid, None)


def _handle_sigint(signum: int, frame: Any, *, _previous: Callable[..., Any] | None) -> None:
    with _tracked_lock:
        _prune_tracked_locked()
        targets = dict(_tracked_pids)
    if targets:
        excluded = _backgrounded_pids()
        for pid, pgid in targets.items():
            if pid in excluded:
                continue
            _signal_group(pgid, signal.SIGINT)
            threading.Thread(target=_escalate, args=(pid, pgid), daemon=True).start()
    # Preserve the kernel's own existing interrupt semantics unconditionally,
    # even if something above raised: ipykernel's own SIGINT handling (or
    # whatever was previously installed) must still run.
    if callable(_previous):
        _previous(signum, frame)
    elif _previous == signal.SIG_DFL:
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGINT)
        signal.signal(signal.SIGINT, lambda s, f: _handle_sigint(s, f, _previous=_previous))


class _ScriptMagicsAsyncioProxy:
    """Forwards every attribute to the real ``asyncio`` module except
    ``create_subprocess_exec``, which gets process-group isolation. Assigned
    only to ``IPython.core.magics.script``'s own ``asyncio`` name, so nothing
    else in the process is affected.
    """

    def __init__(self, real_asyncio: Any, real_create_subprocess_exec: Callable[..., Any]):
        self._real_asyncio = real_asyncio
        self._real_create_subprocess_exec = real_create_subprocess_exec

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real_asyncio, name)

    async def create_subprocess_exec(self, *args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("start_new_session", True)
        proc = await self._real_create_subprocess_exec(*args, **kwargs)
        if kwargs.get("start_new_session"):
            try:
                pgid = os.getpgid(proc.pid)
            except ProcessLookupError:
                pgid = proc.pid
            _register_tracked_pid(proc.pid, pgid)
        return proc


def install() -> None:
    """Idempotent: safe to call on every ``import rlm`` (including a kernel
    restart re-import) without installing duplicate handlers or double-
    wrapping ``create_subprocess_exec``.
    """
    if _ipython_script_magics is None:
        return
    if getattr(_ipython_script_magics, _INSTALLED_MARKER, False):
        return

    real_asyncio = _ipython_script_magics.asyncio
    real_create_subprocess_exec = real_asyncio.create_subprocess_exec
    _ipython_script_magics.asyncio = _ScriptMagicsAsyncioProxy(real_asyncio, real_create_subprocess_exec)

    previous_handler = signal.getsignal(signal.SIGINT)

    def _handler(signum: int, frame: Any) -> None:
        _handle_sigint(signum, frame, _previous=previous_handler)

    signal.signal(signal.SIGINT, _handler)
    setattr(_ipython_script_magics, _INSTALLED_MARKER, True)
