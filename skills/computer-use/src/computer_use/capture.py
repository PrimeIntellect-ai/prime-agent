"""Window screenshots through the macOS screencapture tool, plus the attach hook.

_screenshot_window is synchronous and shells out to screencapture; the App layer
calls it from its async wrapper. origin and size are CG screen-space integer
pairs derived from AX window bounds by the App layer; window_id scopes the
capture to one window so occluding content is never included.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from .errors import ComputerUseError

_TIMEOUT_SECONDS = 10.0
_ERROR_LIMIT = 200
def _screenshots_dir() -> Path:
    """The capture tmp dir under the agent state dir (env-overridable)."""
    override = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
    base = Path(override).expanduser() if override else Path.home() / ".prime" / "agent"
    return base / "tmp" / "computer-use"


_SCREENSHOTS_DIR = _screenshots_dir()
_SCREENCAPTURE_TOOL = "/usr/sbin/screencapture"
_SWEEP_MAX_FILES = 20
_SWEEP_MAX_AGE_SECONDS = 24 * 60 * 60


def _pair(value: tuple[int, int], name: str) -> tuple[int, int]:
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or not all(isinstance(coordinate, int) and not isinstance(coordinate, bool) for coordinate in value)
    ):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"{name} must be an (x, y) pair of integers", {name: repr(value)[:64]}
        )
    return value


def _sweep_screenshots() -> None:
    """Best-effort sweep before each capture: delete files older than 24 hours,
    then keep only the most recent 20 entries."""
    try:
        now = time.time()
        entries = []
        for path in _SCREENSHOTS_DIR.iterdir():
            try:
                entries.append((path.stat().st_mtime, path))
            except OSError:
                continue
        entries.sort(reverse=True)
        kept = 0
        for modified, path in entries:
            try:
                if now - modified > _SWEEP_MAX_AGE_SECONDS:
                    path.unlink()
                elif kept < _SWEEP_MAX_FILES:
                    kept += 1
                else:
                    path.unlink()
            except OSError:
                continue
    except Exception:
        return


def _refuse_symlinked(path: Path) -> None:
    """Refuse a capture path that is or contains a symlink component.

    Components below the user's home directory are all checked (the product's
    state tree is attacker-plantable); paths outside home check the path
    itself, matching the macOS system symlinks like /var and /tmp.
    """
    home = Path.home()
    component = path
    while component != home and component != component.parent:
        if component.is_symlink():
            raise ComputerUseError(
                "TRANSPORT_ERROR", f"screenshot path component is a symlink: {component}"
            )
        if home not in component.parents:
            return
        component = component.parent


def _png_dimensions(path: Path) -> tuple[int, int]:
    """Read the IHDR width and height of a written PNG, rejecting invalid output."""
    try:
        with path.open("rb") as handle:
            header = handle.read(24)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture did not write a readable PNG: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ComputerUseError("TRANSPORT_ERROR", f"screencapture did not write a valid PNG: {path.name}")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width < 1 or height < 1:
        raise ComputerUseError("TRANSPORT_ERROR", f"screencapture wrote an empty PNG: {path.name}")
    return width, height


def _screenshot_window(
    origin: tuple[int, int], size: tuple[int, int], window_id: int | None = None
) -> dict[str, str | int]:
    """Capture the target window, or the screen region as a documented fallback, into a PNG file.

    When window_id is given, the capture is scoped to that one window with
    screencapture -l, so occluding windows and other apps' content are never
    included; when it is None, the region at origin with size is captured with
    screencapture -R and contains whatever is currently on screen there. The
    file is written under ~/.prime/agent/tmp/computer-use/ with a random name
    after the directory is swept (files older than 24 hours are deleted and
    only the 20 most recent are kept); the directory is kept private with
    mode 0700 and each PNG is set to 0600, both best-effort. Paths that are or
    contain symlinks are refused, and the written PNG's IHDR dimensions are
    verified: region captures wildly beyond the requested rect (over twice
    each axis) are rejected instead of handed to the model. Returns {"path":
    str, "width": int, "height": int}. Raises ComputerUseError INVALID_ARGUMENT
    for a bad region or window id, APP_NOT_RUNNING when screencapture reports
    that the target window is gone, and TRANSPORT_ERROR for any other failure,
    including an unavailable or symlinked screenshot path, an unavailable
    screencapture binary, and an invalid or mismatched capture.
    """
    x, y = _pair(origin, "origin")
    width, height = _pair(size, "size")
    if width < 1 or height < 1:
        raise ComputerUseError(
            "INVALID_ARGUMENT", "size must be a (width, height) pair with positive values", {"size": size}
        )
    if window_id is not None and (not isinstance(window_id, int) or isinstance(window_id, bool)):
        raise ComputerUseError(
            "INVALID_ARGUMENT", "window_id must be an integer", {"window_id": repr(window_id)[:32]}
        )
    _refuse_symlinked(_SCREENSHOTS_DIR)
    try:
        _SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    try:
        os.chmod(_SCREENSHOTS_DIR, 0o700)
    except OSError:
        pass
    _sweep_screenshots()
    if os.path.isfile(_SCREENCAPTURE_TOOL):
        binary = _SCREENCAPTURE_TOOL
    else:
        binary = shutil.which("screencapture")
        if binary is not None:
            binary = os.path.abspath(binary)
    if binary is None:
        raise ComputerUseError("TRANSPORT_ERROR", "screencapture is not available on this system")
    path = _SCREENSHOTS_DIR / f"{uuid4()}.png"
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ComputerUseError("TRANSPORT_ERROR", f"screenshot target path is not a regular file: {path.name}")
    if window_id is None:
        command = [binary, "-x", "-o", "-R", f"{x},{y},{width},{height}", str(path)]
    else:
        command = [binary, "-x", "-o", "-l", str(window_id), str(path)]
    try:
        finished = subprocess.run(command, capture_output=True, timeout=_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture timed out after {int(_TIMEOUT_SECONDS)} seconds"
        ) from error
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture is not available: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    if finished.returncode != 0:
        reason = (finished.stderr or finished.stdout).decode("utf-8", errors="replace").strip()
        capped = reason[:_ERROR_LIMIT]
        if "window" in capped.lower():
            raise ComputerUseError("APP_NOT_RUNNING", f"screencapture could not find the window: {capped}")
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture failed with exit code {finished.returncode}: {capped}"
        )
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    png_width, png_height = _png_dimensions(path)
    if window_id is None and (png_width > width * 2 or png_height > height * 2):
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"captured image is {png_width}x{png_height}, far from the requested {width}x{height} region",
        )
    return {"path": str(path), "width": width, "height": height}


async def _attach_image_if_available(path: str) -> None:
    """Load the screenshot at path into the model's context as an image attachment.

    Best-effort: every failure is swallowed silently, including a non-vision
    model, a missing attach_image module, and older hosts without the skill.
    """
    try:
        from attach_image import run

        await run(path)
    except Exception:
        return


_attach = _attach_image_if_available
