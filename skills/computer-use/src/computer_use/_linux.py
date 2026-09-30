"""Linux X11 backend: xwininfo observation, xdotool input, maim capture.

This module is the Linux half of the computer-use backend seams. It mirrors the
mac modules the App layer consumes (ax observation, inject input, capture,
apps discovery) keyed by X11 window id instead of pid, and every top-level
name is underscore-private: the module is internal, only the App layer's
dispatch (through _compat.require_linux) reaches it.

Observation runs `xwininfo -root -tree -int` and parses the whole root tree
with one parser shared with app discovery. X11 window tree observation is the
fallback for at-spi: the design reserves the at-spi source to slot in later
with richer element roles and values; every element here renders as role
"window" with the WM_CLASS as the subrole. The observed window must appear in
the root tree (the tree lists children only, and the root window itself is
never a listed child), so the bound window's own geometry - the root-relative
absolute position - comes from its own line in the root tree; window_rect is
that absolute (x, y, width, height) and element positions are absolute
root-window coordinates, matching the mac App layer's screen-space contract.

Input goes through xdotool, window-bound without activation where supported:
`xdotool key --window <id> <chords>` and `xdotool type --window <id> --delay
<ms> <text>` deliver synthetic (XSendEvent) keyboard input to the bound
window, and `xdotool mousemove --window <id> <x> <y>` moves the pointer with
WINDOW-RELATIVE coordinates (input seams take window-relative points, unlike
the mac inject's screen-space points) followed by a plain XTest click at the
moved pointer. Apps that ignore synthetic events make the plain forms (which
deliver to the focused window or the real pointer) the documented fallback;
this module never retries with them because a plain retry can deliver input to
whatever app currently holds focus, which breaks app scoping.

Capture prefers `maim -i <window_id>` and falls back to `scrot -u -o <path>`
(capture of the FOCUSED window, not the bound one - documented divergence
when maim fails or is absent); the file management, retention sweep, and PNG
dimension verification are reused from computer_use.capture.

X11 window metadata exposes no secure-input role (no AXSecureTextField
equivalent), so type_text on Linux cannot refuse password fields; the gap is
documented in _focused_is_secure.

Errors follow the shared ComputerUseError taxonomy, model-facing:
TRANSPORT_ERROR says the backend is broken (missing tools, a missing DISPLAY,
an unrunnable or hung tool run, and every capture failure) and INVALID_ARGUMENT
covers bad ids, points, buttons, and chords; a completed INPUT run that exits
nonzero raises INJECTION_FAILED instead - the action failed to deliver, so
the model should retry it. APP_NOT_RUNNING covers a bound window missing from
the tree.

Platform gaps this backend documents (each also noted at its seam): X11
window metadata has no secure-input role (no AXSecureTextField equivalent),
there is no session-lock probe (the mac policy check fails open as False on
linux), no TCC grants apply, there is no app-launch story (binding resolves
running windows only), and there is no clipboard or per-element value API
(paste, set_value, select_text, and secondary actions have no X11 backing).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, NamedTuple
from uuid import uuid4

from . import capture
from .ax import Observation
from .errors import ComputerUseError
from .keymap import ParsedChord, _parse_chord

_ERROR_LIMIT = 200
_TIMEOUT_SECONDS = 10.0
_MAX_DEPTH = 12
_MAX_ELEMENTS = 1500
_MIN_INDENT = 5
_INDENT_STEP = 3

_TYPE_DELAY_MS = 12
_WHEEL_CLICKS_PER_PAGE = 10
_WHEEL_REPEAT_DELAY_MS = 50

_TOOL_PATHS: dict[str, str] = {
    "xdotool": "/usr/bin/xdotool",
    "xwininfo": "/usr/bin/xwininfo",
    "maim": "/usr/bin/maim",
    "scrot": "/usr/bin/scrot",
}

_BUTTON_NUMBERS: dict[str, int] = {"left": 1, "middle": 2, "right": 3}
_SCROLL_BUTTONS: dict[str, int] = {"up": 4, "down": 5, "left": 6, "right": 7}
_MODIFIER_KEYSYMS: dict[str, str] = {"cmd": "super", "ctrl": "ctrl", "alt": "alt", "shift": "shift"}
_KEYSYMS: dict[str, str] = {
    "Return": "Return",
    "Tab": "Tab",
    "Escape": "Escape",
    "Space": "space",
    "Delete": "BackSpace",
    "ForwardDelete": "Delete",
    "Home": "Home",
    "End": "End",
    "PageUp": "Prior",
    "PageDown": "Next",
    "Up": "Up",
    "Down": "Down",
    "Left": "Left",
    "Right": "Right",
}
for _index in range(1, 13):
    _KEYSYMS[f"F{_index}"] = f"F{_index}"


class _Window(NamedTuple):
    """One parsed xwininfo tree node: an X11 window with its tree position and metadata."""

    window_id: int
    depth: int
    title: str | None
    instance: str | None
    wm_class: str | None
    width: int | None
    height: int | None
    rel_x: int | None
    rel_y: int | None
    abs_x: int | None
    abs_y: int | None


_GEOMETRY_RE = re.compile(
    r"\s+(?P<width>\d+)x(?P<height>\d+)(?P<rel_x>[+-]\d+)(?P<rel_y>[+-]\d+)"
    r"(?:\s+(?P<abs_x>[+-]\d+)(?P<abs_y>[+-]\d+))?\s*$"
)
_CLASS_RE = re.compile(
    r": (?P<group>\((?:\"(?P<instance>[^\"]*)\"|\(none\)) ?(?:\"(?P<res_class>[^\"]*)\"|\(none\))?\)|\(\))\s*$"
)
_ID_RE = re.compile(r"^(?P<indent>[ ]+)(?P<id>\d+)(?: \(the root window\))?(?P<namepart> .*)?$")
_COUNT_RE = re.compile(r"^[ ]+\d+ (child|children)[:.]$")


def _run(argv: list[str]) -> subprocess.CompletedProcess[bytes]:
    """Run one X11 tool, raising TRANSPORT_ERROR for an unrunnable tool or a timeout."""
    try:
        return subprocess.run(argv, capture_output=True, timeout=_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"{Path(argv[0]).name} timed out after {int(_TIMEOUT_SECONDS)} seconds"
        ) from error
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"{Path(argv[0]).name} is not available: {str(error)[:_ERROR_LIMIT]}"
        ) from error


def _capped_output(finished: subprocess.CompletedProcess[bytes]) -> str:
    """Render one command's stderr (or stdout) capped for an error message."""
    return (finished.stderr or finished.stdout).decode("utf-8", "replace").strip()[:_ERROR_LIMIT]


def _require_display() -> None:
    """Refuse X11 work without a DISPLAY, naming the missing environment."""
    if not os.environ.get("DISPLAY"):
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use backend unavailable: DISPLAY is not set; the Linux backend needs an X server",
        )


def _optional_tool(name: str) -> str | None:
    """Resolve one tool to its executable path, absolute candidates first, or None."""
    absolute = _TOOL_PATHS.get(name)
    if absolute is not None and os.path.isfile(absolute):
        return absolute
    return shutil.which(name)


def _tool(name: str) -> str:
    """Resolve one required X11 tool, raising TRANSPORT_ERROR naming it when missing."""
    found = _optional_tool(name)
    if found is None:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"computer use backend unavailable: the Linux backend needs the {name} tool on PATH",
            {"tool": name},
        )
    return found


def _run_checked(argv: list[str], action: str) -> None:
    """Run one xdotool input command, raising INJECTION_FAILED with its capped stderr on failure.

    A nonzero exit means the action failed to deliver (INJECTION_FAILED, so
    the model retries); an unrunnable or hung run raises TRANSPORT_ERROR from
    _run because the backend itself is broken.
    """
    finished = _run(argv)
    if finished.returncode != 0:
        reason = _capped_output(finished)
        raise ComputerUseError(
            "INJECTION_FAILED",
            f"{action} failed with exit code {finished.returncode}: {reason}",
            {"argv": " ".join(argv)[:_ERROR_LIMIT]},
        )


def _window_id(value: int) -> int:
    """Validate one X11 window id as an integer."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"window id must be an integer, got {type(value).__name__}",
            {"window_id": type(value).__name__},
        )
    return value


def _point(value: tuple[float, float], name: str) -> tuple[float, float]:
    """Validate one (x, y) pair of numbers."""
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or not all(isinstance(coordinate, (int, float)) and not isinstance(coordinate, bool) for coordinate in value)
    ):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"{name} must be an (x, y) pair of numbers", {name: repr(value)[:64]}
        )
    return value


def _coord(value: float) -> str:
    """Format one coordinate for an xdotool argv as a rounded integer string."""
    return str(int(round(value)))


def _parse_tree(output: str) -> list[_Window]:
    """Parse xwininfo -tree -int output into window nodes in depth-first order.

    Child lines print the id, the raw window name, the WM_CLASS pair, a
    parent-relative geometry, and a root-relative absolute position; the parse
    anchors on the trailing geometry, then the trailing WM_CLASS group, then
    the leading id, so names containing quotes, colons, or class-shaped
    fragments stay intact. Header, root, parent, and children-count lines are
    skipped.
    """
    windows: list[_Window] = []
    for line in output.splitlines():
        if _COUNT_RE.match(line):
            continue
        geometry = _GEOMETRY_RE.search(line)
        head = line[: geometry.start()].rstrip() if geometry is not None else line.rstrip()
        found = _CLASS_RE.search(head)
        instance: str | None = None
        res_class: str | None = None
        if found is not None:
            instance = found.group("instance")
            res_class = found.group("res_class")
            head = head[: found.start()].rstrip()
        identified = _ID_RE.match(head)
        if identified is None:
            continue
        indent = identified.group("indent")
        if len(indent) < _MIN_INDENT:
            continue
        namepart = identified.group("namepart")
        title = _window_name(namepart)
        windows.append(
            _Window(
                window_id=int(identified.group("id")),
                depth=(len(indent) - _MIN_INDENT) // _INDENT_STEP,
                title=title,
                instance=instance,
                wm_class=res_class,
                width=int(geometry.group("width")) if geometry is not None else None,
                height=int(geometry.group("height")) if geometry is not None else None,
                rel_x=int(geometry.group("rel_x")) if geometry is not None else None,
                rel_y=int(geometry.group("rel_y")) if geometry is not None else None,
                abs_x=int(geometry.group("abs_x")) if geometry is not None and geometry.group("abs_x") is not None else None,
                abs_y=int(geometry.group("abs_y")) if geometry is not None and geometry.group("abs_y") is not None else None,
            )
        )
    return windows


def _window_name(namepart: str | None) -> str | None:
    """Extract a quoted window title from an xwininfo name part, or None when unreadable."""
    if namepart is None:
        return None
    trimmed = namepart.strip()
    if len(trimmed) >= 2 and trimmed.startswith('"') and trimmed.endswith('"'):
        return trimmed[1:-1]
    return None


def _root_windows() -> list[_Window]:
    """Read the whole root window tree through xwininfo, in depth-first order."""
    _require_display()
    finished = _run([_tool("xwininfo"), "-root", "-tree", "-int"])
    if finished.returncode != 0:
        reason = _capped_output(finished)
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"xwininfo failed with exit code {finished.returncode}: {reason}",
        )
    return _parse_tree(finished.stdout.decode("utf-8", "replace"))


def _search_windows(pattern: str, *, by: str = "class", only_visible: bool = True) -> list[int]:
    """Find window ids with `xdotool search`, matching a case-insensitive extended regex.

    by is "class" (WM_CLASS) or "name" (window title) and only_visible adds
    --onlyvisible. No matches read as an empty list: xdotool search exits 1
    like grep when nothing matches, so an empty result with no stderr is a
    normal miss, while a failed run with stderr raises TRANSPORT_ERROR.
    """
    if by not in ("class", "name"):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"by must be one of class, name, got {by!r}", {"by": str(by)[:32]}
        )
    if not isinstance(pattern, str) or not pattern:
        raise ComputerUseError(
            "INVALID_ARGUMENT", "the search pattern must be a non-empty string", {"pattern": type(pattern).__name__}
        )
    _require_display()
    argv = [_tool("xdotool"), "search"]
    if only_visible:
        argv.append("--onlyvisible")
    argv += [f"--{by}", pattern]
    finished = _run(argv)
    ids = [int(token) for token in finished.stdout.decode("utf-8", "replace").split() if token.lstrip("-").isdigit()]
    if not ids and finished.returncode != 0 and _capped_output(finished):
        reason = _capped_output(finished)
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"xdotool search failed with exit code {finished.returncode}: {reason}"
        )
    return ids


def _list_apps() -> list[dict[str, Any]]:
    """List running apps as {"id", "name", "running"} dicts, one entry per distinct WM_CLASS.

    Every mapped window in the root tree carries a class line; windows
    without a WM_CLASS (window-manager frames and internal helpers) are not
    apps and are skipped. The id is the raw WM_CLASS (the policy gate's app
    identity on Linux); the name is the same string, since X11 has no
    localized display names.
    """
    apps: dict[str, dict[str, Any]] = {}
    for window in _root_windows():
        if window.wm_class is None or window.wm_class in apps:
            continue
        apps[window.wm_class] = {"id": window.wm_class, "name": window.wm_class, "running": True}
    return list(apps.values())


def _resolve_app(spec: str | dict[str, str]) -> list[_Window]:
    """Match one app spec against running windows by WM_CLASS, casefolded.

    A string or a {"bundle_id"|"name"} dict matches each window's WM_CLASS
    res_class case-insensitively; every matching window is returned (an app
    may own several). A {"path"} spec or another dict shape raises
    INVALID_ARGUMENT: X11 windows resolve by class, not by launch path. The
    empty spec raises INVALID_ARGUMENT like the mac apps.resolve.
    """
    wanted = _spec_class(spec)
    return [
        window
        for window in _root_windows()
        if window.wm_class is not None and window.wm_class.casefold() == wanted.casefold()
    ]


def _spec_class(spec: str | dict[str, str]) -> str:
    """Extract the WM_CLASS to match from one app spec, rejecting unresolvable shapes."""
    if isinstance(spec, str):
        if not spec.strip():
            raise ComputerUseError("INVALID_ARGUMENT", "the app spec must not be empty", {"spec": ""})
        return spec.strip()
    if isinstance(spec, dict):
        for key in ("bundle_id", "name"):
            value = spec.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    raise ComputerUseError(
        "INVALID_ARGUMENT",
        "the app spec must be an app name or a {\"bundle_id\"|\"name\"} dict; X11 windows have no launch paths",
        {"spec": str(spec)[:64]},
    )


def _observe(window_id: int) -> Observation:
    """Snapshot one window's child tree into the same Observation the mac backend builds.

    Runs `xwininfo -root -tree -int` and takes the bound window's subtree from
    the root tree: the tree lists each window's children recursively with
    ids, titles, WM_CLASS pairs, and geometry, so the bound window's own
    root-relative geometry (its absolute screen position) is available from
    its own line - that is window_rect. The element dicts use the contract
    keys the diff/serialize engine renders: role "window", the WM_CLASS as
    the subrole, the window title, and absolute root-window positions (not
    window-relative); refs are the children's X11 window ids in walk order,
    window_id is the bound id (capture consumes it), and focused_index is
    always None (X11 exposes no accessibility focus; a later at-spi source
    can fill it). The walk caps at _MAX_DEPTH levels below the window and
    _MAX_ELEMENTS elements like the mac walk. Raises ComputerUseError
    TRANSPORT_ERROR for a missing display, tool, or failed xwininfo run, and
    APP_NOT_RUNNING when the window is not in the root tree (including the
    root window itself, which the tree never lists as a child).
    """
    window_id = _window_id(window_id)
    windows = _root_windows()
    index = next((position for position, window in enumerate(windows) if window.window_id == window_id), None)
    if index is None:
        raise ComputerUseError(
            "APP_NOT_RUNNING",
            f"window {window_id} is not in the window tree; call get_app again to re-bind it",
            {"window_id": window_id},
        )
    bound = windows[index]
    tree, refs = _subtree(windows, index)
    rect = (
        (float(bound.abs_x), float(bound.abs_y), float(bound.width), float(bound.height))
        if bound.abs_x is not None and bound.abs_y is not None and bound.width is not None and bound.height is not None
        else None
    )
    return Observation(
        window_title=bound.title,
        tree=tree,
        refs=refs,
        window_rect=rect,
        focused_index=None,
        window_id=window_id,
    )


def _subtree(windows: list[_Window], index: int) -> tuple[list[dict[str, Any]], list[int]]:
    """Build the element dicts and refs for one bound window's children, capped like the mac walk."""
    bound = windows[index]
    tree: list[dict[str, Any]] = []
    refs: list[int] = []
    stack: list[dict[str, Any]] = []
    for window in windows[index + 1:]:
        depth = window.depth - bound.depth
        if depth <= 0:
            break
        if depth > _MAX_DEPTH:
            continue
        if len(refs) >= _MAX_ELEMENTS:
            break
        element = _element(window)
        if depth == 1:
            tree.append(element)
            stack = [element]
        else:
            while len(stack) >= depth:
                stack.pop()
            stack[-1]["children"].append(element)
            stack.append(element)
        refs.append(window.window_id)
    return tree, refs


def _element(window: _Window) -> dict[str, Any]:
    """Convert one parsed window into the element dict contract the diff engine renders."""
    position = (
        [float(window.abs_x), float(window.abs_y)]
        if window.abs_x is not None and window.abs_y is not None
        else None
    )
    size = [float(window.width), float(window.height)] if window.width is not None and window.height is not None else None
    return {
        "role": "window",
        "subrole": window.wm_class,
        "title": window.title,
        "value": None,
        "description": None,
        "placeholder": None,
        "actions": [],
        "position": position,
        "size": size,
        "children": [],
    }


def _live_fingerprint(window_id: int) -> tuple[str | None, str | None]:
    """Read one window's live (role, title) for freshness checks.

    The role is the constant "window" and the title comes from
    `xdotool getwindowname`; a window whose title cannot be read (gone, or
    genuinely unnamed) reads as ("window", None), so a window whose stored
    title differs from its live title compares stale while an unnamed window
    stays usable.
    """
    window_id = _window_id(window_id)
    _require_display()
    finished = _run([_tool("xdotool"), "getwindowname", str(window_id)])
    if finished.returncode != 0 or not (finished.stdout or b"").strip():
        return ("window", None)
    return ("window", (finished.stdout or b"").decode("utf-8", "replace").strip())


def _focused_is_secure(window_id: int) -> bool | None:
    """Report whether the window's focused element is a secure field; always None on X11.

    X11 window metadata has no secure-input role (no AXSecureTextField
    equivalent), so this backend cannot detect password fields: type_text on
    Linux cannot refuse a focused password field the way the mac backend
    does, and callers read None as "unknown" while the skill documents the
    gap to the user.
    """
    _window_id(window_id)
    return None


def _chord_keysym(chord: ParsedChord) -> str:
    """Translate one parsed chord into an xdotool keysequence with X11 keysym names.

    Modifiers translate to xdotool naming (cmd to super; ctrl, alt, and shift
    keep their names) and sort deterministically; keys translate to X11
    keysyms (Delete to BackSpace, ForwardDelete to Delete, PageUp to Prior,
    PageDown to Next, Space to space), single characters pass through.
    """
    parts = sorted(_MODIFIER_KEYSYMS[modifier] for modifier in chord.modifiers)
    parts.append(_KEYSYMS.get(chord.key, chord.key))
    return "+".join(parts)


def _click(window_id: int, point: tuple[float, float], button: str = "left", count: int = 1) -> None:
    """Click at one window-relative point through `xdotool mousemove --window` plus a click.

    mousemove takes WINDOW-RELATIVE coordinates with --window and positions
    the pointer inside the bound window without activating it; the click
    follows as a plain XTest click (button 1 left, 2 middle, 3 right) at the
    moved pointer, which lands on whatever window is topmost there - the
    bound window unless it is occluded at that point. count>1 passes
    --repeat to xdotool click for multi-click cycles. Raises
    ComputerUseError INVALID_ARGUMENT for a bad id, point, button, or count,
    TRANSPORT_ERROR for a missing display, tool, or hung run, and
    INJECTION_FAILED when the xdotool run exits nonzero.
    """
    window_id = _window_id(window_id)
    if button not in _BUTTON_NUMBERS:
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"button must be one of left, middle, right, got {button!r}",
            {"button": str(button)[:32]},
        )
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ComputerUseError("INVALID_ARGUMENT", f"count must be an integer of at least 1, got {count!r}", {"count": count})
    x, y = _point(point, "point")
    _require_display()
    xdotool = _tool("xdotool")
    _run_checked(
        [xdotool, "mousemove", "--window", str(window_id), _coord(x), _coord(y)],
        "mousemove",
    )
    argv = [xdotool, "click"]
    if count > 1:
        argv += ["--repeat", str(count)]
    argv.append(str(_BUTTON_NUMBERS[button]))
    _run_checked(argv, "click")


def _drag(window_id: int, start: tuple[float, float], end: tuple[float, float]) -> None:
    """Drag with the left button between two window-relative points.

    The pointer jumps: mousemove --window to start, plain XTest mousedown 1,
    mousemove --window to end, plain mouseup 1. xdotool moves the pointer in
    one step, so applications that want intermediate motion along the drag
    path see none. Raises ComputerUseError INVALID_ARGUMENT for bad ids or
    points, TRANSPORT_ERROR like _click (missing display or tool, hung run),
    and INJECTION_FAILED when a run exits nonzero.
    """
    window_id = _window_id(window_id)
    start_x, start_y = _point(start, "start")
    end_x, end_y = _point(end, "end")
    _require_display()
    xdotool = _tool("xdotool")
    _run_checked(
        [xdotool, "mousemove", "--window", str(window_id), _coord(start_x), _coord(start_y)],
        "mousemove",
    )
    _run_checked([xdotool, "mousedown", "1"], "mousedown")
    _run_checked(
        [xdotool, "mousemove", "--window", str(window_id), _coord(end_x), _coord(end_y)],
        "mousemove",
    )
    _run_checked([xdotool, "mouseup", "1"], "mouseup")


def _scroll(window_id: int, direction: str, pages: int = 1, point: tuple[float, float] | None = None) -> None:
    """Scroll one direction at one window-relative point via wheel clicks.

    direction is up (button 4), down (5), left (6), or right (7); one page is
    _WHEEL_CLICKS_PER_PAGE wheel clicks per direction, matching the mac
    backend's roughly-800-pixel page scale - X11 wheel clicks carry no pixel
    deltas, so the page size is an approximation. With a point the pointer
    moves into the bound window first (window-relative, no activation);
    without one the wheel clicks land on whatever window is under the
    pointer. Raises ComputerUseError INVALID_ARGUMENT for a bad direction,
    page count, or point, TRANSPORT_ERROR like _click (missing display
    or tool, hung run), and INJECTION_FAILED when a run exits nonzero.
    """
    window_id = _window_id(window_id)
    if direction not in _SCROLL_BUTTONS:
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"direction must be one of up, down, left, right, got {direction!r}",
            {"direction": str(direction)[:32]},
        )
    if not isinstance(pages, int) or isinstance(pages, bool) or pages < 1:
        raise ComputerUseError("INVALID_ARGUMENT", f"pages must be an integer of at least 1, got {pages!r}", {"pages": pages})
    location = None if point is None else _point(point, "point")
    _require_display()
    xdotool = _tool("xdotool")
    if location is not None:
        _run_checked(
            [xdotool, "mousemove", "--window", str(window_id), _coord(location[0]), _coord(location[1])],
            "mousemove",
        )
    argv = [
        xdotool,
        "click",
        "--repeat",
        str(pages * _WHEEL_CLICKS_PER_PAGE),
        "--delay",
        str(_WHEEL_REPEAT_DELAY_MS),
    ]
    argv.append(str(_SCROLL_BUTTONS[direction]))
    _run_checked(argv, "click")


def _press_key(window_id: int, key: str) -> None:
    """Send one key chord such as "cmd+shift+f" to the bound window without activating it.

    The chord parses with computer_use.keymap._parse_chord and translates to
    xdotool's X11 keysym naming (cmd to super), delivered as
    `xdotool key --window <id> <chord>` synthetic input. Apps that ignore
    synthetic keyboard events do not receive the chord; the plain `xdotool
    key` form (focused-window delivery) is the documented fallback, which
    this module never retries with on its own because it would deliver keys
    to whatever app currently holds focus. Raises ComputerUseError
    INVALID_ARGUMENT for an unsupported chord, TRANSPORT_ERROR like _click
    (missing display or tool, hung run), and INJECTION_FAILED when a run
    exits nonzero.
    """
    window_id = _window_id(window_id)
    chord = _parse_chord(key)
    _require_display()
    _run_checked([_tool("xdotool"), "key", "--window", str(window_id), _chord_keysym(chord)], "key")


def _type_text(window_id: int, text: str) -> None:
    """Type literal text into the bound window without activating it.

    Delivered as `xdotool type --window <id> --delay <ms> <text>` synthetic
    input with the inter-keystroke delay in _TYPE_DELAY_MS; an empty string
    is a no-op. X11 window metadata has no secure-input role, so unlike the
    mac backend this cannot refuse a focused password field - the gap is
    documented in _focused_is_secure. Raises ComputerUseError
    INVALID_ARGUMENT for non-string text, TRANSPORT_ERROR like _click
    (missing display or tool, hung run), and INJECTION_FAILED when a run
    exits nonzero.
    """
    window_id = _window_id(window_id)
    if not isinstance(text, str):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"text must be a string, got {type(text).__name__}", {"text": type(text).__name__}
        )
    if not text:
        return
    _require_display()
    _run_checked(
        [_tool("xdotool"), "type", "--window", str(window_id), "--delay", str(_TYPE_DELAY_MS), text],
        "type",
    )


def _screenshot_window(window_id: int) -> dict[str, str | int]:
    """Capture the bound window to a PNG: maim preferred, scrot as the documented fallback.

    maim scopes the capture to one window with `maim -i <window_id>`, so
    occluding content is never included; when maim is missing or its run
    fails, the fallback is `scrot -u -o <path>`, which captures the currently
    FOCUSED window instead of the bound one - a documented divergence that
    only matches when the bound window holds focus. The screenshot lands in
    the same managed directory as the mac backend (mode 0700, files 0600,
    retention sweep, symlink refusal, IHDR dimension verification are reused
    from computer_use.capture); the returned width and height are the written
    PNG's actual IHDR dimensions. Raises ComputerUseError INVALID_ARGUMENT
    for a bad id, TRANSPORT_ERROR when both tools are missing or every
    attempt fails (capped stderr in the message).
    """
    window_id = _window_id(window_id)
    _require_display()
    capture._refuse_symlinked(capture._SCREENSHOTS_DIR)
    try:
        capture._SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR", f"screenshot directory unavailable: {str(error)[:_ERROR_LIMIT]}"
        ) from error
    try:
        os.chmod(capture._SCREENSHOTS_DIR, 0o700)
    except OSError:
        pass
    capture._sweep_screenshots()
    path = capture._SCREENSHOTS_DIR / f"{uuid4()}.png"
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ComputerUseError("TRANSPORT_ERROR", f"screenshot target path is not a regular file: {path.name}")
    maim = _optional_tool("maim")
    scrot = _optional_tool("scrot")
    if maim is None and scrot is None:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use backend unavailable: the Linux backend needs maim (preferred) or scrot on PATH for screenshots",
        )
    attempts: list[tuple[str, list[str]]] = []
    if maim is not None:
        attempts.append(("maim", [maim, "-i", str(window_id), str(path)]))
    if scrot is not None:
        attempts.append(("scrot", [scrot, "-u", "-o", str(path)]))
    reasons: list[str] = []
    for name, argv in attempts:
        finished = _run(argv)
        if finished.returncode != 0:
            reason = _capped_output(finished)
            reasons.append(f"{name} failed with exit code {finished.returncode}: {reason}")
            continue
        try:
            width, height = capture._png_dimensions(path)
        except ComputerUseError as error:
            reasons.append(f"{name}: {error.message}")
            continue
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return {"path": str(path), "width": width, "height": height}
    raise ComputerUseError(
        "TRANSPORT_ERROR", ("window screenshot failed: " + "; ".join(reasons))[:_ERROR_LIMIT]
    )
