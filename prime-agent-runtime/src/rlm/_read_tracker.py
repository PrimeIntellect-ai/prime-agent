"""Which files this kernel session read, for the edit skill's staleness guard.

The kernel installs the audit hook once at boot (``repl.main``); a plain
``import rlm`` never installs it, so outside the kernel ``is_installed()`` stays
False and callers degrade to a no-op. Reads are recorded from the ``open``
audit event, so any library that opens a file counts — no monkey-patching.
"""

from __future__ import annotations

import os
import stat
import sys
import sysconfig
from typing import Any

# A session reads far more files than it edits; keep the recorded window bounded.
_MAX_ENTRIES = 2048

# Cheap pre-realpath rejection for interpreter trees (stdlib, venv, site-packages).
_SKIP_MARKERS = ("site-packages", "dist-packages", "/lib/python", "/lib64/python")

_reads: dict[str, tuple[int, int]] = {}
_installed = False
_skip_roots: tuple[str, ...] = ()


def _skip_roots_now() -> tuple[str, ...]:
    paths = sysconfig.get_paths()
    roots = {
        paths.get("stdlib"),
        paths.get("purelib"),
        paths.get("platlib"),
        sys.prefix,
        sys.base_prefix,
    }
    return tuple(sorted({os.path.realpath(root) for root in roots if root}))


def _is_skipped(raw: str, real: str) -> bool:
    if any(marker in raw for marker in _SKIP_MARKERS):
        return True
    return any(real == root or real.startswith(root + os.sep) for root in _skip_roots)


def _record(path: str | bytes) -> None:
    try:
        raw = os.fsdecode(path)
        real = os.path.realpath(raw)
        if _is_skipped(raw, real):
            return
        st = os.stat(real)
        if not stat.S_ISREG(st.st_mode):
            return
        _reads.pop(real, None)
        _reads[real] = (st.st_mtime_ns, st.st_size)
        while len(_reads) > _MAX_ENTRIES:
            del _reads[next(iter(_reads))]
    except (OSError, ValueError, TypeError):
        return


def _audit(event: str, args: tuple[Any, ...]) -> None:
    # A raising hook breaks the audited open(), so nothing here may escape.
    try:
        if event != "open":
            return
        path, mode = args[0], args[1]
        if not isinstance(path, (str, bytes)):
            return
        if not isinstance(mode, str) or any(flag in mode for flag in "wax+"):
            return
        _record(path)
    except Exception:
        return


def install() -> None:
    """Record read-mode opens in this process. Idempotent; kernel boot calls it."""
    global _installed, _skip_roots
    if _installed:
        return
    _skip_roots = _skip_roots_now()
    sys.addaudithook(_audit)
    _installed = True


def is_installed() -> bool:
    """True inside a kernel process, False in a plain interpreter (e.g. pytest)."""
    return _installed


def last_read(path: str | os.PathLike[str]) -> tuple[int, int] | None:
    """``(st_mtime_ns, st_size)`` of ``path`` at its last recorded read, else None."""
    try:
        return _reads.get(os.path.realpath(os.fsdecode(os.fspath(path))))
    except (OSError, ValueError, TypeError):
        return None


def note_write(path: str | os.PathLike[str]) -> None:
    """Re-record ``path`` after the session wrote it, so its own write is not external.

    Without this, back-to-back edits of one file would each demand a re-read.
    """
    _record(os.fspath(path))
