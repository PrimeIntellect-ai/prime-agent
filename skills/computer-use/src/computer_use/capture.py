"""Window screenshots through the macOS screencapture tool, plus the attach hook.

screenshot_window is synchronous and shells out to screencapture; the App layer
calls it from its async wrapper. origin and size are CG screen-space integer
pairs derived from AX window bounds by the App layer; window_id scopes the
capture to one window so occluding content is never included.
"""

from __future__ import annotations

import errno
import os
import shutil
import stat
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from ._compat import _require_mac
from .errors import ComputerUseError

_TIMEOUT_SECONDS = 10.0
_ERROR_LIMIT = 200
_SCREENSHOTS_DIR = Path.home() / ".prime" / "agent" / "tmp" / "computer-use"
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


def _sweep_screenshots(dir_fd: int, keep_name: str | None = None) -> None:
    """Best-effort sweep: delete files older than 24 hours, then keep only the
    most recent 20 entries.

    Operates through the opened directory descriptor only, and never follows
    a planted entry: an unlink removes the planted entry itself. keep_name is
    never unlinked and always counts toward the cap, so the capture just
    written survives even when older files carry future timestamps.
    """
    try:
        now = time.time()
        entries = []
        with os.scandir(dir_fd) as listing:
            for entry in listing:
                try:
                    entries.append(
                        (os.stat(entry.name, dir_fd=dir_fd, follow_symlinks=False).st_mtime, entry.name)
                    )
                except OSError:
                    continue
        entries.sort(reverse=True)
        kept = 0
        if keep_name is not None:
            kept += 1
        for modified, name in entries:
            try:
                if name == keep_name:
                    continue
                if now - modified > _SWEEP_MAX_AGE_SECONDS:
                    os.unlink(name, dir_fd=dir_fd)
                elif kept < _SWEEP_MAX_FILES:
                    kept += 1
                else:
                    os.unlink(name, dir_fd=dir_fd)
            except OSError:
                continue
    except Exception:
        return


def _open_capture_dir() -> int:
    """Open the capture directory through a no-follow component chain.

    Each component below the user's home is opened with O_NOFOLLOW and
    created 0700 when missing, so a symlink planted into the state tree after
    the check cannot redirect the sweep, the mode change, or the write at the
    target. Paths outside home keep following system symlinks (the macOS /var
    and /tmp), matching _refuse_symlinked.
    """
    path = _SCREENSHOTS_DIR
    home = Path.home()
    if not (path == home or home in path.parents):
        if path.is_symlink():
            raise ComputerUseError("TRANSPORT_ERROR", f"screenshot path component is a symlink: {path}")
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ComputerUseError(
                "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
            ) from error
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass
        try:
            return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        except OSError as error:
            raise ComputerUseError(
                "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
            ) from error
    fd = _open_home_dir(home)
    try:
        for component in path.relative_to(home).parts:
            next_fd = _open_component(fd, component)
            os.close(fd)
            fd = next_fd
    except OSError as error:
        os.close(fd)
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    except Exception:
        os.close(fd)
        raise
    try:
        os.fchmod(fd, 0o700)
    except OSError:
        pass
    return fd


def _open_home_dir(home: Path) -> int:
    """Open the home directory the no-follow chain starts from."""
    try:
        return os.open(home, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
        ) from error


def _open_component(dir_fd: int, component: str) -> int:
    """Open one component under the chain, creating it 0700 when missing.

    O_NOFOLLOW refuses a symlinked component at open time, which is the check
    that cannot be raced between validation and use; a missing component is
    created and the open retried once.
    """
    try:
        return os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        try:
            os.mkdir(component, 0o700, dir_fd=dir_fd)
        except FileExistsError:
            pass  # a concurrent capture created it first; the open is retried below
        return os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError as error:
        # Linux reports ENOTDIR for O_NOFOLLOW|O_DIRECTORY on a symlink, macOS ELOOP
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            try:
                if stat.S_ISLNK(os.lstat(component, dir_fd=dir_fd).st_mode):
                    raise ComputerUseError(
                        "TRANSPORT_ERROR", f"screenshot path component is a symlink: {component}"
                    ) from error
            except OSError:
                pass
        raise


def _refuse_non_regular_target(dir_fd: int, name: str) -> None:
    """Refuse a capture target that exists and is not a regular file."""
    try:
        mode = os.lstat(name, dir_fd=dir_fd).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise ComputerUseError("TRANSPORT_ERROR", f"screenshot target path is not a regular file: {name}")


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


def _png_dimensions(dir_fd: int, name: str) -> tuple[int, int]:
    """Read the IHDR width and height of a written PNG, rejecting invalid output.

    Opens the file through the already-verified directory descriptor with
    O_NOFOLLOW and O_NONBLOCK, and refuses anything but a regular file, so a
    target swapped into place after the capture — including a planted FIFO —
    can neither be read back nor block the read.
    """
    try:
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture did not write a readable PNG: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    try:
        mode = os.fstat(file_fd).st_mode
    except OSError as error:
        os.close(file_fd)
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture did not write a readable PNG: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    if not stat.S_ISREG(mode):
        os.close(file_fd)
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture did not write a regular PNG: {name}"
        )
    try:
        with os.fdopen(file_fd, "rb") as handle:
            header = handle.read(24)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screencapture did not write a readable PNG: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ComputerUseError("TRANSPORT_ERROR", f"screencapture did not write a valid PNG: {name}")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width < 1 or height < 1:
        raise ComputerUseError("TRANSPORT_ERROR", f"screencapture wrote an empty PNG: {name}")
    return width, height


def _live_window_bounds(window_id: int) -> tuple[float, float, float, float] | None:
    """Read one window's live global bounds through its CGWindowID, or None.

    The window-id capture scope renders the observed window whatever its
    current size, so the pixel-to-logical scale must divide by the window's
    LIVE bounds - the observation's rect is a cache that a resize between
    observe and capture invalidates.
    """
    try:
        quartz = _require_mac().quartz
        info = quartz.CGWindowListCopyWindowInfo(quartz.kCGWindowListOptionIncludingWindow, window_id)
        if not info:
            return None
        bounds = info[0].get("kCGWindowBounds") if isinstance(info[0], dict) else None
        if bounds is None:
            return None
        # the CoreGraphics dictionary converter, not CGRectMakeWithString:
        # the window-list entry carries an {X, Y, Width, Height} dictionary
        rect = quartz.CGRectMakeWithDictionaryRepresentation(bounds, None)
        if rect is None:
            return None
        return (
            float(rect.origin.x),
            float(rect.origin.y),
            float(rect.size.width),
            float(rect.size.height),
        )
    except Exception:
        return None


def _screenshot_window(
    origin: tuple[int, int], size: tuple[int, int], window_id: int | None = None
) -> dict[str, str | int]:
    """Capture the target window, or the screen region as a documented fallback, into a PNG file.

    When window_id is given, the capture is scoped to that one window with
    screencapture -l, so occluding windows and other apps' content are never
    included; when it is None, the region at origin with size is captured with
    screencapture -R and contains whatever is currently on screen there. The
    file is written under ~/.prime/agent/tmp/computer-use/ with a random name
    with the directory swept both before and after the write (files older
    than 24 hours are deleted and only the 20 most recent are kept); the
    directory is opened through a
    no-follow component chain so a symlink planted into the state tree can
    never redirect the sweep, the mode change, or the write, and the
    directory is kept private with mode 0700 with each PNG set to 0600, both
    best-effort. Paths that are or contain symlinks are refused, and the
    written PNG's IHDR dimensions are verified: region captures wildly beyond
    the requested rect (over twice each axis) are rejected instead of handed
    to the model. Returns {"path": str, "width": int, "height": int} — the
    PNG's own pixel dimensions, which on Retina captures are 2x the window's
    logical bounds. Raises ComputerUseError INVALID_ARGUMENT for a bad region
    or window id, APP_NOT_RUNNING when screencapture reports that the target
    window is gone, and TRANSPORT_ERROR for any other failure, including an
    unavailable or symlinked screenshot path, an unavailable screencapture
    binary, and an invalid or mismatched capture.
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
    dir_fd = _open_capture_dir()
    try:
        _sweep_screenshots(dir_fd)
        if os.path.isfile(_SCREENCAPTURE_TOOL):
            binary = _SCREENCAPTURE_TOOL
        else:
            binary = shutil.which("screencapture")
            if binary is not None:
                binary = os.path.abspath(binary)
        if binary is None:
            raise ComputerUseError("TRANSPORT_ERROR", "screencapture is not available on this system")
        path = _SCREENSHOTS_DIR / f"{uuid4()}.png"
        _refuse_non_regular_target(dir_fd, path.name)
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
            os.chmod(path.name, 0o600, dir_fd=dir_fd, follow_symlinks=False)
        except OSError:
            pass
        png_width, png_height = _png_dimensions(dir_fd, path.name)
        if window_id is None and (png_width > width * 2 or png_height > height * 2):
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                f"captured image is {png_width}x{png_height}, far from the requested {width}x{height} region",
            )
        # the sweep also runs after a successful capture — with the new file
        # protected — so the retention cap holds once it exists instead of
        # leaving 21 screenshots
        _sweep_screenshots(dir_fd, keep_name=path.name)
        return {"path": str(path), "width": png_width, "height": png_height}
    finally:
        os.close(dir_fd)


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
