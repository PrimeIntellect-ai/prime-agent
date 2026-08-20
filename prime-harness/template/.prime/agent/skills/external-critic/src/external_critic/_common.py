"""Shared conventions for prime-harness skills.

This module is intentionally duplicated (not imported) across the harness
skills so that a failed install of one skill can never break another.
Keep every copy identical; the harness doctor checks for drift.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HARNESS_DIRNAME = os.path.join("artifacts", "harness")
CONFIG_RELPATH = os.path.join("harness", "config.json")

DEFAULT_CONFIG: dict[str, Any] = {
    "artifacts_dir": HARNESS_DIRNAME,
    "max_active_children": 6,
    "min_goal_tokens_to_spawn": 20000,
    "child_summary_max_chars": 600,
    "critic": {
        "command": None,
        "order": ["claude", "codex"],
        "timeout_seconds": 900,
    },
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def repo_root(start: Path | None = None) -> Path:
    """Walk up from `start` (default cwd) to the nearest directory containing
    `.git`. Falls back to `start` itself when no repository is found."""
    cur = (start or Path.cwd()).resolve()
    for candidate in (cur, *cur.parents):
        if (candidate / ".git").exists():
            return candidate
    return cur


def load_config(root: Path | None = None) -> dict[str, Any]:
    """Read harness/config.json, deep-merged one level over DEFAULT_CONFIG."""
    root = root or repo_root()
    merged: dict[str, Any] = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_CONFIG.items()}
    path = root / CONFIG_RELPATH
    if path.is_file():
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return merged
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = {**merged[key], **value}
            else:
                merged[key] = value
    return merged


def harness_dir(root: Path | None = None, *, create: bool = True) -> Path:
    root = root or repo_root()
    rel = load_config(root).get("artifacts_dir", HARNESS_DIRNAME)
    path = root / rel
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON atomically: temp file in the same directory, then replace.

    On Windows, os.replace raises PermissionError while another process holds
    the destination open for reading; retry briefly before giving up.
    """
    import time

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False, default=str)
            handle.write("\n")
        for attempt in range(6):
            try:
                os.replace(tmp_name, path)
                return
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def current_commit(root: Path | None = None) -> str | None:
    """Best-effort HEAD SHA; None outside a repo or when git is unavailable."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root or repo_root()),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    sha = proc.stdout.strip()
    return sha or None


async def maybe_await(value: Any) -> Any:
    """Await `value` if it is awaitable; otherwise return it unchanged.

    Bundled Prime Agent skills (goal, agent_message, ...) expose host-request
    coroutines; this keeps our call sites agnostic to sync/async drift between
    Prime Agent releases.
    """
    import inspect

    if inspect.isawaitable(value):
        return await value
    return value


def kill_process_tree(proc: Any) -> None:
    """Kill a subprocess.Popen and its descendants (Windows: taskkill /T;
    POSIX: process group — spawn with start_new_session=True for this to
    reach grandchildren)."""
    import subprocess as _subprocess

    try:
        if os.name == "nt":
            _subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                            capture_output=True, timeout=30)
        else:
            import signal

            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, _subprocess.TimeoutExpired, ProcessLookupError):
        pass
    finally:
        try:
            proc.kill()
        except OSError:
            pass


def run_with_tree_kill(
    argv_or_cmd: Any,
    *,
    timeout: float,
    cwd: str | None = None,
    shell: bool = False,
) -> tuple[int | None, str, str, bool]:
    """subprocess with a timeout that reliably kills the whole tree.

    Returns (returncode, stdout, stderr, timed_out). Output decoded as UTF-8
    with replacement (never crashes on the Windows cp1252 default).
    """
    import subprocess as _subprocess

    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "shell": shell,
        "stdout": _subprocess.PIPE,
        "stderr": _subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": {**os.environ, "PYTHONIOENCODING": "utf-8"},
    }
    if os.name != "nt":
        kwargs["start_new_session"] = True
    proc = _subprocess.Popen(argv_or_cmd, **kwargs)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return proc.returncode, stdout or "", stderr or "", False
    except _subprocess.TimeoutExpired:
        kill_process_tree(proc)
        try:
            stdout, stderr = proc.communicate(timeout=15)
        except (_subprocess.TimeoutExpired, ValueError):
            stdout, stderr = "", ""
        return proc.returncode, stdout or "", stderr or "", True


class NotInKernel(RuntimeError):
    """Raised when a Prime Agent kernel facility is used outside the kernel."""


def require_kernel_module(name: str) -> Any:
    """Import a Prime Agent kernel/skill module, with a clear failure mode.

    Inside the Prime Agent kernel venv these modules are importable packages;
    outside (plain project Python, unit tests) they are absent.
    """
    import importlib

    try:
        return importlib.import_module(name)
    except ImportError as exc:
        raise NotInKernel(
            f"Module {name!r} is unavailable: this function only works inside the "
            f"Prime Agent IPython kernel (its venv installs {name!r}). "
            f"Original error: {exc}"
        ) from exc
