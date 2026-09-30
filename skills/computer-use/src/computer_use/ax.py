"""Accessibility observation and element actions for macOS apps.

Observation results are pure data: nested element dicts with the contract
keys (role, subrole, title, value, description, placeholder, actions,
position, size, children). The pyobjc paths import lazily inside their
functions so the module imports cleanly on every platform.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, NamedTuple

from ._compat import _require_mac
from .errors import ComputerUseError

_MAX_DEPTH = 12
_MAX_ELEMENTS = 1500
_MAX_OBSERVE_SECONDS = 3.0
_MESSAGING_TIMEOUT_SECONDS = 1.5
_MAX_ATTRIBUTE_CHARS = 2000
_MAX_ACTIONS = 16
_FINGERPRINT_VALUE_CHARS = 200
_ELLIPSIS = "…"

_SECURE_ROLE = "AXTextField"
_SECURE_SUBROLE = "AXSecureTextField"
_WINDOW_ID_ATTRIBUTE = "_AXWindowID"

_SKILL_ROOT = Path(__file__).resolve().parents[2]
_PACKAGED_INSTRUCTIONS_DIR = Path(__file__).resolve().parent / "references" / "app-instructions"
_SKILL_INSTRUCTIONS_DIR = _SKILL_ROOT / "references" / "app-instructions"
_SANITIZER = re.compile(r"[^A-Za-z0-9.-]")


class Observation(NamedTuple):
    """One accessibility snapshot of an app's focused window.

    tree holds the window's children (the window itself is not indexed), refs
    holds the AX element reference for each tree element in walk order,
    window_rect is the window's global (x, y, width, height) when known,
    focused_index is the focused element's tree index when known, and
    window_id is the window's CGWindowID when readable.
    """

    window_title: str | None
    tree: list[dict[str, Any]]
    refs: list[Any]
    window_rect: tuple[float, float, float, float] | None = None
    focused_index: int | None = None
    window_id: int | None = None
    truncated: bool = False


def _is_secure_field(element: dict[str, Any]) -> bool:
    """Report whether one element is a secure text field (password input)."""
    return element.get("role") == _SECURE_ROLE and element.get("subrole") == _SECURE_SUBROLE


def _flatten(tree: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten one element tree depth-first into element-index order."""
    flat: list[dict[str, Any]] = []
    stack = list(reversed(tree))
    while stack:
        element = stack.pop()
        flat.append(element)
        stack.extend(reversed(element.get("children") or []))
    return flat


def _instructions_path(bundle_id: str) -> Path:
    """Return the per-app instruction file path for one bundle id.

    Guide files are keyed by the app's bundle id (for example
    com.tinyspeck.slackmacgap.md), so the lookup works identically in the
    packaged wheel and the skill-dir layout. The packaged location wins; the
    skill-dir layout is the fallback.
    """
    sanitized = _SANITIZER.sub("_", bundle_id)
    if _PACKAGED_INSTRUCTIONS_DIR.is_dir():
        return _PACKAGED_INSTRUCTIONS_DIR / f"{sanitized}.md"
    return _SKILL_INSTRUCTIONS_DIR / f"{sanitized}.md"


def _load_instructions(bundle_id: str) -> str | None:
    """Read per-app usage instructions, tolerating a missing or empty file."""
    try:
        text = _instructions_path(bundle_id).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _observe(pid: int) -> Observation:
    """Snapshot the focused window of one app process.

    The walk is bounded by _MAX_OBSERVE_SECONDS; the per-read messaging
    timeout never exceeds the remaining observation time, so an
    unresponsive app cannot run past the deadline with one slow attribute.
    """
    """Snapshot the focused window of one app process.

    Walks the focused window's children depth-first, capped at _MAX_DEPTH
    levels below the window and _MAX_ELEMENTS elements, collecting each
    element's role, subrole, title, value, description, placeholder, actions,
    position, and size. Raises ComputerUseError TRANSPORT_ERROR off darwin or
    when the frameworks are missing.
    """
    app_services = _require_mac().app_services
    app_element = app_services.AXUIElementCreateApplication(pid)
    _set_messaging_timeout(app_services, app_element)
    window = _copy_value(app_services, app_element, "AXFocusedWindow")
    if window is None or _text(_copy_value(app_services, window, "AXRole")) == "AXApplication":
        # A windowless app reports the application element (or nothing) as its
        # focused window; there is no window tree to observe yet.
        return Observation(window_title=None, tree=[], refs=[], window_rect=None)
    tree: list[dict[str, Any]] = []
    refs: list[Any] = []
    stopped: list[bool] = []
    deadline = time.monotonic() + _MAX_OBSERVE_SECONDS
    _walk(app_services, window, 1, tree, refs, deadline=deadline, stopped=stopped)
    remaining = min(_MESSAGING_TIMEOUT_SECONDS, max(deadline - time.monotonic(), 0.05))
    return Observation(
        window_title=_cap(_text(_copy_value(app_services, window, "AXTitle", remaining))),
        tree=tree,
        refs=refs,
        window_rect=_window_rect(app_services, window, remaining),
        focused_index=_focused_index(app_services, app_element, refs, remaining),
        window_id=_window_id(app_services, window, remaining),
        truncated=bool(stopped) or time.monotonic() > deadline,
    )


def _focused_index(app_services: Any, app_element: Any, refs: list[Any], timeout_seconds: float | None = None) -> int | None:
    """Resolve the app's focused element to its tree index, or None when unknown."""
    focused = _copy_value(app_services, app_element, "AXFocusedUIElement", timeout_seconds)
    if focused is None:
        return None
    for index, ref in enumerate(refs):
        if ref is focused or ref == focused:
            return index
    return None


def _live_fingerprint(ref: Any) -> tuple[str | None, str | None]:
    """Read one live element's current (role, title) for freshness checking."""
    app_services = _require_mac().app_services
    return (
        _text(_copy_value(app_services, ref, "AXRole")),
        _text(_copy_value(app_services, ref, "AXTitle")),
    )


def _focused_is_secure(pid: int) -> bool | None:
    """Report whether the app's live focused element is a secure field.

    Returns None only when the live focus read fails, and callers fail
    closed on it. A successful read with no focused element reports False:
    nothing is focused, so no secure field can receive the keystrokes.
    """
    app_services = _require_mac().app_services
    app_element = app_services.AXUIElementCreateApplication(pid)
    _set_messaging_timeout(app_services, app_element)
    try:
        result = app_services.AXUIElementCopyAttributeValue(app_element, "AXFocusedUIElement", None)
    except Exception:
        return None
    error, focused = _split_result(app_services, result)
    if error != app_services.kAXErrorSuccess:
        return None
    if focused is None:
        return False
    role_ok, role = _read_attribute(app_services, focused, "AXRole")
    subrole_ok, subrole = _read_attribute(app_services, focused, "AXSubrole")
    if not role_ok or not subrole_ok:
        return None  # an unreadable focused element is unverifiable: fail closed
    return _is_secure_field({"role": role, "subrole": subrole})


def _live_is_secure(ref: Any) -> bool | None:
    """Report whether one live element ref is currently a secure text field.

    Reads the live role and subrole, so an element that turned into a
    password field after the snapshot (keeping role and title) is still
    refused at action time. Returns None when the live state cannot be
    read, and callers fail closed on it: an unverifiable field never
    receives a write.
    """
    app_services = _require_mac().app_services
    role_ok, role = _read_attribute(app_services, ref, "AXRole")
    subrole_ok, subrole = _read_attribute(app_services, ref, "AXSubrole")
    if not role_ok or not subrole_ok:
        return None
    return _is_secure_field({"role": role, "subrole": subrole})


def _read_attribute(app_services: Any, element: Any, attribute: str, timeout_seconds: float | None = None) -> tuple[bool, str | None]:
    """Copy one attribute as text, telling a failed read from a None value.

    Both surface as None through _copy_value; a failed read must be
    distinguishable so security-relevant attributes can fail closed.
    Returns (ok, value); ok=False means the read itself failed.
    """
    _set_messaging_timeout(app_services, element, timeout_seconds)
    try:
        result = app_services.AXUIElementCopyAttributeValue(element, attribute, None)
    except Exception:
        return False, None
    error, value = _split_result(app_services, result)
    if error != app_services.kAXErrorSuccess:
        return False, None
    return True, _text(value)


def _window_fingerprint(pid: int, timeout_seconds: float | None = None) -> tuple[Any, ...] | None:
    """Read a cheap live identity of the focused window and its focused element.

    Used to wait for injected input to settle: the fingerprint changes while
    the app processes events and stops changing once the UI is settled. The
    focused element's role, subrole, and (for non-secure fields) value head
    ride along so ordinary edits inside one control settle too, and a value
    is never read from a secure field. timeout_seconds bounds each AX read
    so a hung app cannot outlast the settle budget. Returns None when the
    focused window cannot be read.
    """
    app_services = _require_mac().app_services
    timeout = _MESSAGING_TIMEOUT_SECONDS if timeout_seconds is None else max(timeout_seconds, 0.05)
    app_element = app_services.AXUIElementCreateApplication(pid)
    _set_messaging_timeout(app_services, app_element, timeout)
    window = _copy_value(app_services, app_element, "AXFocusedWindow", timeout)
    if window is None:
        return None
    title = _text(_copy_value(app_services, window, "AXTitle", timeout))
    children = _copy_value(app_services, window, "AXChildren", timeout)
    try:
        count = len(children) if children is not None else 0
    except TypeError:
        count = 0
    focused = _copy_value(app_services, app_element, "AXFocusedUIElement", timeout)
    if focused is None:
        return (title, count, None, None, None)
    role_ok, role = _read_attribute(app_services, focused, "AXRole", timeout)
    subrole_ok, subrole = _read_attribute(app_services, focused, "AXSubrole", timeout)
    if not role_ok or not subrole_ok or (role == _SECURE_ROLE and subrole == _SECURE_SUBROLE):
        value_head = ""  # an unverifiable or secure field's value is never read
    else:
        value = _copy_value(app_services, focused, "AXValue", timeout)
        value_head = _cap(_text(value)) if value is not None else None
        if value_head is not None:
            value_head = value_head[:_FINGERPRINT_VALUE_CHARS]
    return (title, count, role, subrole, value_head)


def _current_value(ref: Any) -> str | None:
    """Read one element's current AXValue as text, or None when unreadable."""
    app_services = _require_mac().app_services
    return _text(_copy_value(app_services, ref, "AXValue"))


def _perform_action(ref: Any, action: str) -> None:
    """Perform one named accessibility action on an element."""
    app_services = _require_mac().app_services
    _set_messaging_timeout(app_services, ref)
    error = app_services.AXUIElementPerformAction(ref, action)
    if error != app_services.kAXErrorSuccess:
        raise ComputerUseError(
            "ACTION_UNSUPPORTED",
            f"the element did not perform {action} (AX error {error})",
            {"action": str(action)[:32]},
        )


def _is_settable(ref: Any, attribute: str) -> bool:
    """Report whether an element accepts writes for one attribute."""
    app_services = _require_mac().app_services
    _set_messaging_timeout(app_services, ref)
    try:
        result = app_services.AXUIElementIsAttributeSettable(ref, attribute, None)
    except Exception:
        return False
    error, settable = _split_result(app_services, result)
    return error == app_services.kAXErrorSuccess and bool(settable)


def _set_value(ref: Any, value: str) -> None:
    """Set an element's AXValue attribute to a string."""
    app_services = _require_mac().app_services
    _set_messaging_timeout(app_services, ref)
    error = app_services.AXUIElementSetAttributeValue(ref, "AXValue", value)
    if error != app_services.kAXErrorSuccess:
        raise ComputerUseError(
            "ACTION_UNSUPPORTED",
            f"setting the value failed with AX error {error}",
            {},
        )


def _select_text_range(ref: Any, location: int, length: int) -> None:
    """Set the element's selected text range, leaving its content untouched."""
    app_services = _require_mac().app_services
    _set_messaging_timeout(app_services, ref)
    error = app_services.AXUIElementSetAttributeValue(
        ref, "AXSelectedTextRange", app_services.CFRangeMake(location, length)
    )
    if error != app_services.kAXErrorSuccess:
        raise ComputerUseError(
            "ACTION_UNSUPPORTED",
            f"selecting the text range failed with AX error {error}",
            {"location": location, "length": length},
        )


def _walk(
    app_services: Any,
    parent: Any,
    depth: int,
    siblings: list[dict[str, Any]],
    refs: list[Any],
    ancestors: tuple[Any, ...] = (),
    deadline: float | None = None,
    stopped: list[bool] | None = None,
) -> None:
    """Append parent's described children into siblings, recursing depth-first.

    A child identical to an ancestor is pruned: some app states (a windowless
    app reports itself as its own child) would otherwise recurse to the
    element cap. The walk also stops at the deadline, so a hung app cannot
    stall the kernel for the per-call timeout times thousands of reads; the
    tree is capped like the element cap rather than failing.
    """
    if deadline is None:
        deadline = time.monotonic() + _MAX_OBSERVE_SECONDS
    stopped = stopped if stopped is not None else []
    if time.monotonic() > deadline:
        stopped.append(True)
        return
    children = _copy_value(app_services, parent, "AXChildren", min(_MESSAGING_TIMEOUT_SECONDS, max(deadline - time.monotonic(), 0.05)))
    for child in children or ():
        if len(refs) >= _MAX_ELEMENTS or time.monotonic() > deadline:
            stopped.append(True)
            return
        if depth > _MAX_DEPTH:
            stopped.append(True)  # a depth cutoff is a truncation too
            return
        if child is parent or any(child is ancestor for ancestor in ancestors):
            continue
        described = _describe(app_services, child, min(_MESSAGING_TIMEOUT_SECONDS, max(deadline - time.monotonic(), 0.05)))
        siblings.append(described)
        refs.append(child)
        _walk(app_services, child, depth + 1, described["children"], refs, ancestors + (child,), deadline, stopped)


def _describe(app_services: Any, element: Any, timeout_seconds: float | None = None) -> dict[str, Any]:
    """Collect one element's contract attributes into a plain dict.

    Every string attribute is capped at _MAX_ATTRIBUTE_CHARS so a hostile app
    cannot flood the kernel or the model context with megabyte payloads. A
    text field whose subrole cannot be read is treated as secure and its
    value is never collected: an unreadable secure state must fail closed,
    not leak the field's content as ordinary text.
    """
    role = _cap(_text(_copy_value(app_services, element, "AXRole", timeout_seconds)))
    subrole_ok, subrole = _read_attribute(app_services, element, "AXSubrole", timeout_seconds)
    subrole = _cap(subrole)
    if not subrole_ok and role == _SECURE_ROLE:
        subrole = _SECURE_SUBROLE
    value = None if subrole == _SECURE_SUBROLE else _cap(_text(_copy_value(app_services, element, "AXValue", timeout_seconds)))
    return {
        "role": role,
        "subrole": subrole,
        "title": _cap(_text(_copy_value(app_services, element, "AXTitle", timeout_seconds))),
        "value": value,
        "description": _cap(_text(_copy_value(app_services, element, "AXDescription", timeout_seconds))),
        "placeholder": _cap(_text(_copy_value(app_services, element, "AXPlaceholderValue", timeout_seconds))),
        "actions": _actions(app_services, element, timeout_seconds),
        "position": _point(app_services, _copy_value(app_services, element, "AXPosition", timeout_seconds)),
        "size": _point(app_services, _copy_value(app_services, element, "AXSize", timeout_seconds)),
        "children": [],
    }


def _copy_value(app_services: Any, element: Any, attribute: str, timeout_seconds: float | None = None) -> Any:
    """Copy one accessibility attribute value, returning None on any AX error.

    The per-reference messaging timeout is applied first: the timeout is a
    property of each AXUIElementRef, so window, child, and action references
    must each be bounded, not just the application element.
    """
    _set_messaging_timeout(app_services, element, timeout_seconds)
    try:
        result = app_services.AXUIElementCopyAttributeValue(element, attribute, None)
    except Exception:
        return None
    error, value = _split_result(app_services, result)
    if error != app_services.kAXErrorSuccess:
        return None
    return value


def _split_result(app_services: Any, result: Any) -> tuple[Any, Any]:
    """Split one pyobjc out-param return into (error, value), tolerating bridge variants."""
    if isinstance(result, tuple) and len(result) == 2:
        return result
    return app_services.kAXErrorSuccess, result


def _actions(app_services: Any, element: Any, timeout_seconds: float | None = None) -> list[str]:
    """Copy the element's action names, tolerating any AX error.

    At most _MAX_ACTIONS names are kept, so a hostile element exposing
    thousands of actions cannot flood the serialized payload.
    """
    _set_messaging_timeout(app_services, element, timeout_seconds)
    try:
        result = app_services.AXUIElementCopyActions(element, None)
    except Exception:
        return []
    error, actions = _split_result(app_services, result)
    if error != app_services.kAXErrorSuccess:
        return []
    return [_cap(str(action)) for action in (actions or ())[:_MAX_ACTIONS]]


def _point(app_services: Any, value: Any) -> tuple[float, float] | None:
    """Convert one AX position or size value into an (x, y) pair of floats.

    macOS wraps both attributes in an opaque AXValueRef, so unwrap the point
    first and the size second (AXValueGetValue reports False for the wrong
    kind) before falling back to the bridge-friendly shapes.
    """
    if value is None:
        return None
    point_type = getattr(app_services, "kAXValueCGPointType", None)
    size_type = getattr(app_services, "kAXValueCGSizeType", None)
    for value_type in (point_type, size_type):
        if value_type is None:
            break
        try:
            ok, decoded = app_services.AXValueGetValue(value, value_type, None)
        except Exception:
            break
        if not ok or decoded is None:
            continue
        try:
            return (float(decoded[0]), float(decoded[1]))
        except (TypeError, IndexError, ValueError):
            continue
    try:
        return (float(value.x), float(value.y))
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        return (float(value["x"]), float(value["y"]))
    except (TypeError, KeyError, ValueError):
        pass
    try:
        return (float(value[0]), float(value[1]))
    except (TypeError, IndexError, KeyError, ValueError):
        return None


def _text(value: Any) -> str | None:
    """Copy one AX attribute value as text, or None when it is unreadable."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def _cap(text: str | None) -> str | None:
    """Cap one attribute string at _MAX_ATTRIBUTE_CHARS with an ellipsis marker."""
    if text is None or len(text) <= _MAX_ATTRIBUTE_CHARS:
        return text
    return text[:_MAX_ATTRIBUTE_CHARS] + _ELLIPSIS


def _window_id(app_services: Any, window: Any, timeout_seconds: float | None = None) -> int | None:
    """Read the window's CGWindowID, or None when unavailable."""
    value = _copy_value(app_services, window, _WINDOW_ID_ATTRIBUTE, timeout_seconds)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _window_rect(app_services: Any, window: Any, timeout_seconds: float | None = None) -> tuple[float, float, float, float] | None:
    """Read the window's global position and size as (x, y, width, height)."""
    position = _point(app_services, _copy_value(app_services, window, "AXPosition", timeout_seconds))
    size = _point(app_services, _copy_value(app_services, window, "AXSize", timeout_seconds))
    if position is None or size is None:
        return None
    return (position[0], position[1], size[0], size[1])


def _set_messaging_timeout(app_services: Any, element: Any, seconds: float | None = None) -> None:
    """Bound AX calls through one element ref so an unresponsive app cannot stall.

    The timeout is per AXUIElementRef, so this is applied on every element
    the module reads from or acts on, not just the application element.
    seconds caps the timeout below the default when a caller holds a
    deadline (the observe walk and the settle poll).
    """
    try:
        timeout = _MESSAGING_TIMEOUT_SECONDS if seconds is None else max(seconds, 0.0)
        app_services.AXUIElementSetMessagingTimeout(element, timeout)
    except Exception:
        return
