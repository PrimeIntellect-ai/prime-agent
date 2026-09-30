"""App-scoped input injection through CGEvents (macOS, pyobjc imported lazily).

All functions are synchronous; the App layer calls them from its async wrappers.
Every event is posted to the target app's process with CGEventPostToPid, never to
the global event stream. All coordinates are CG screen-space points: the App layer
converts window-relative coordinates to screen coordinates before calling.
"""

from __future__ import annotations

from ._compat import _require_mac
from .errors import ComputerUseError
from .keymap import KEYCODES, _parse_chord

_ERROR_LIMIT = 200
_PIXELS_PER_PAGE = 800
_UTF16_UNITS_PER_EVENT = 2

_MOUSE_BUTTONS = ("left", "right", "middle")
_SCROLL_DIRECTIONS = ("up", "down", "left", "right")


def _point(value: tuple[float, float], name: str) -> tuple[float, float]:
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or not all(isinstance(coordinate, (int, float)) and not isinstance(coordinate, bool) for coordinate in value)
    ):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"{name} must be an (x, y) tuple of numbers", {name: repr(value)[:64]}
        )
    return value


def _injection_failed(action: str, pid: int, error: BaseException) -> ComputerUseError:
    return ComputerUseError("INJECTION_FAILED", f"{action} failed: {str(error)[:_ERROR_LIMIT]}", {"pid": pid})


def _transport_failed(action: str, pid: int, error: BaseException) -> ComputerUseError:
    return ComputerUseError("TRANSPORT_ERROR", f"{action} failed: {str(error)[:_ERROR_LIMIT]}", {"pid": pid})


def _click(pid: int, point: tuple[float, float], button: str = "left", count: int = 1) -> None:
    """Post one or more _click cycles to the app process with the given pid.

    button is left, right, or middle; count is the number of press/release cycles,
    so a double _click is count=2. point is a CG screen-space (x, y) tuple of
    numbers (int or float). Raises
    ComputerUseError INVALID_ARGUMENT for a bad button, count, or point, and
    INJECTION_FAILED with the underlying CG error text when a CG call fails.
    """
    if button not in _MOUSE_BUTTONS:
        raise ComputerUseError(
            "INVALID_ARGUMENT", "button must be one of left, right, middle", {"button": str(button)[:32]}
        )
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ComputerUseError("INVALID_ARGUMENT", "count must be an integer of at least 1", {"count": count})
    x, y = _point(point, "point")
    try:
        quartz = _require_mac().quartz
        down_type, up_type, code = {
            "left": (quartz.kCGEventLeftMouseDown, quartz.kCGEventLeftMouseUp, 0),
            "right": (quartz.kCGEventRightMouseDown, quartz.kCGEventRightMouseUp, 1),
            "middle": (quartz.kCGEventOtherMouseDown, quartz.kCGEventOtherMouseUp, 2),
        }[button]
        for _ in range(count):
            down = quartz.CGEventCreateMouseEvent(None, down_type, (x, y), code)
            quartz.CGEventPostToPid(pid, down)
            up = quartz.CGEventCreateMouseEvent(None, up_type, (x, y), code)
            quartz.CGEventPostToPid(pid, up)
    except ComputerUseError:
        raise
    except OSError as error:
        raise _transport_failed("_click", pid, error) from error
    except Exception as error:
        raise _injection_failed("click", pid, error) from error


def _drag(pid: int, start: tuple[float, float], end: tuple[float, float]) -> None:
    """Drag with the left button: press at start, move to end, release.

    start and end are CG screen-space (x, y) tuples of numbers (int or float).
    Raises ComputerUseError
    INVALID_ARGUMENT for a bad point and INJECTION_FAILED with the underlying CG
    error text when a CG call fails.
    """
    start_x, start_y = _point(start, "start")
    end_x, end_y = _point(end, "end")
    try:
        quartz = _require_mac().quartz
        down = quartz.CGEventCreateMouseEvent(None, quartz.kCGEventLeftMouseDown, (start_x, start_y), 0)
        quartz.CGEventPostToPid(pid, down)
        moved = quartz.CGEventCreateMouseEvent(None, quartz.kCGEventLeftMouseDragged, (end_x, end_y), 0)
        quartz.CGEventPostToPid(pid, moved)
        up = quartz.CGEventCreateMouseEvent(None, quartz.kCGEventLeftMouseUp, (end_x, end_y), 0)
        quartz.CGEventPostToPid(pid, up)
    except ComputerUseError:
        raise
    except OSError as error:
        raise _transport_failed("_drag", pid, error) from error
    except Exception as error:
        raise _injection_failed("drag", pid, error) from error


def _scroll(pid: int, direction: str, pages: int = 1, point: tuple[float, float] | None = None) -> None:
    """Post a _scroll event to the app process with the given pid.

    direction is up, down, left, or right: up/down map to a negative/positive
    vertical delta and left/right to a negative/positive horizontal delta; one
    page is 800 pixels. point, when given, is a CG screen-space (x, y) tuple of
    numbers (int or float) carried as the event location (the App passes the
    target element's center); None leaves the location unset. Raises
    ComputerUseError INVALID_ARGUMENT for a bad direction, page count, or
    point, and INJECTION_FAILED with the underlying CG error text when a CG
    call fails.
    """
    if direction not in _SCROLL_DIRECTIONS:
        raise ComputerUseError(
            "INVALID_ARGUMENT", "direction must be one of up, down, left, right", {"direction": str(direction)[:32]}
        )
    if not isinstance(pages, int) or isinstance(pages, bool) or pages < 1:
        raise ComputerUseError("INVALID_ARGUMENT", "pages must be an integer of at least 1", {"pages": pages})
    location = None if point is None else _point(point, "point")
    magnitude = _PIXELS_PER_PAGE * pages
    dy, dx = {
        "up": (-magnitude, 0),
        "down": (magnitude, 0),
        "left": (0, -magnitude),
        "right": (0, magnitude),
    }[direction]
    try:
        quartz = _require_mac().quartz
        event = quartz.CGEventCreateScrollWheelEvent(None, quartz.kCGScrollEventUnitPixel, 2, dy, dx)
        if location is not None:
            quartz.CGEventSetLocation(event, location)
        quartz.CGEventPostToPid(pid, event)
    except ComputerUseError:
        raise
    except OSError as error:
        raise _transport_failed("_scroll", pid, error) from error
    except Exception as error:
        raise _injection_failed("scroll", pid, error) from error


def _press_key(pid: int, key: str) -> None:
    """Post a key chord such as "cmd+shift+f" to the app process with the given pid.

    The chord is parsed with computer_use.keymap._parse_chord; the modifier flags
    are set on both the key-down and key-up events. Raises ComputerUseError
    INVALID_ARGUMENT for an unsupported chord, and INJECTION_FAILED with the
    underlying CG error text when a CG call fails.
    """
    chord = _parse_chord(key)
    keycode = KEYCODES[chord.key]
    try:
        quartz = _require_mac().quartz
        masks = {
            "cmd": quartz.kCGEventFlagMaskCommand,
            "ctrl": quartz.kCGEventFlagMaskControl,
            "alt": quartz.kCGEventFlagMaskAlternate,
            "shift": quartz.kCGEventFlagMaskShift,
        }
        flags = 0
        for modifier in chord.modifiers:
            flags |= masks[modifier]
        down = quartz.CGEventCreateKeyboardEvent(None, keycode, True)
        quartz.CGEventSetFlags(down, flags)
        quartz.CGEventPostToPid(pid, down)
        up = quartz.CGEventCreateKeyboardEvent(None, keycode, False)
        quartz.CGEventSetFlags(up, flags)
        quartz.CGEventPostToPid(pid, up)
    except ComputerUseError:
        raise
    except OSError as error:
        raise _transport_failed("_press_key", pid, error) from error
    except Exception as error:
        raise _injection_failed("press_key", pid, error) from error


def _type_text(pid: int, text: str) -> None:
    """Type text into the app process with the given pid.

    Each keyboard event carries at most two UTF-16 code units (the macOS limit),
    and a surrogate pair never splits across events. An empty string is a no-op.
    Raises ComputerUseError INVALID_ARGUMENT for non-string text, and
    INJECTION_FAILED with the underlying CG error text when a CG call fails.
    """
    if not isinstance(text, str):
        raise ComputerUseError(
            "INVALID_ARGUMENT", f"text must be a string, got {type(text).__name__}", {"text": type(text).__name__}
        )
    if not text:
        return
    chunks: list[tuple[int, str]] = []
    pending: list[str] = []
    pending_units = 0
    for character in text:
        units = 2 if ord(character) > 0xFFFF else 1
        if pending_units + units > _UTF16_UNITS_PER_EVENT:
            chunks.append((pending_units, "".join(pending)))
            pending = []
            pending_units = 0
        pending.append(character)
        pending_units += units
    if pending:
        chunks.append((pending_units, "".join(pending)))
    try:
        quartz = _require_mac().quartz
        for units, chunk in chunks:
            down = quartz.CGEventCreateKeyboardEvent(None, 0, True)
            quartz.CGEventKeyboardSetUnicodeString(down, units, chunk)
            quartz.CGEventPostToPid(pid, down)
            up = quartz.CGEventCreateKeyboardEvent(None, 0, False)
            quartz.CGEventKeyboardSetUnicodeString(up, units, chunk)
            quartz.CGEventPostToPid(pid, up)
    except ComputerUseError:
        raise
    except OSError as error:
        raise _transport_failed("_type_text", pid, error) from error
    except Exception as error:
        raise _injection_failed("type_text", pid, error) from error
