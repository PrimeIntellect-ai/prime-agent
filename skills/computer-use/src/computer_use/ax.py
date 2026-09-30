"""Accessibility observation and element actions for macOS apps.

Observation results are pure data: nested element dicts with the contract
keys (role, subrole, title, value, description, placeholder, actions,
position, size, children). The pyobjc paths import lazily inside their
functions so the module imports cleanly on every platform.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, NamedTuple

from ._compat import _require_mac
from .errors import ComputerUseError

_MAX_DEPTH = 12
_MAX_ELEMENTS = 1500
_MESSAGING_TIMEOUT_SECONDS = 1.5
_MAX_ATTRIBUTE_CHARS = 2000
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

    The packaged location (a wheel install ships the files inside the
    package) wins; the skill-dir layout is the fallback.
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
        # focused window; there is no window tree to _observe yet.
        return Observation(window_title=None, tree=[], refs=[], window_rect=None)
    tree: list[dict[str, Any]] = []
    refs: list[Any] = []
    _walk(app_services, window, 1, tree, refs)
    window_id = _window_id(app_services, window)
    return Observation(
        window_title=_text(_copy_value(app_services, window, "AXTitle")),
        tree=tree,
        refs=refs,
        window_rect=_window_rect(app_services, window) or _window_server_rect(window_id),
        focused_index=_focused_index(app_services, app_element, refs),
        window_id=window_id,
    )


def _focused_index(app_services: Any, app_element: Any, refs: list[Any]) -> int | None:
    """Resolve the app's focused element to its tree index, or None when unknown."""
    focused = _copy_value(app_services, app_element, "AXFocusedUIElement")
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

    Returns None when the live focus cannot be read; callers fall back to
    their last snapshot.
    """
    app_services = _require_mac().app_services
    app_element = app_services.AXUIElementCreateApplication(pid)
    _set_messaging_timeout(app_services, app_element)
    focused = _copy_value(app_services, app_element, "AXFocusedUIElement")
    if focused is None:
        return None
    return _is_secure_field(
        {
            "role": _text(_copy_value(app_services, focused, "AXRole")),
            "subrole": _text(_copy_value(app_services, focused, "AXSubrole")),
        }
    )


def _current_value(ref: Any) -> str | None:
    """Read one element's current AXValue as text, or None when unreadable."""
    app_services = _require_mac().app_services
    return _text(_copy_value(app_services, ref, "AXValue"))


def _perform_action(ref: Any, action: str) -> None:
    """Perform one named accessibility action on an element."""
    app_services = _require_mac().app_services
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
    try:
        result = app_services.AXUIElementIsAttributeSettable(ref, attribute)
    except Exception:
        return False
    error, settable = _split_result(app_services, result)
    return error == app_services.kAXErrorSuccess and bool(settable)


def _set_value(ref: Any, value: str) -> None:
    """Set an element's AXValue attribute to a string."""
    app_services = _require_mac().app_services
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
) -> None:
    """Append parent's described children into siblings, recursing depth-first.

    A child identical to an ancestor is pruned: some app states (a windowless
    app reports itself as its own child) would otherwise recurse to the
    element cap.
    """
    children = _copy_value(app_services, parent, "AXChildren")
    for child in children or ():
        if len(refs) >= _MAX_ELEMENTS or depth > _MAX_DEPTH:
            return
        if child is parent or any(child is ancestor for ancestor in ancestors):
            continue
        described = _describe(app_services, child)
        siblings.append(described)
        refs.append(child)
        _walk(app_services, child, depth + 1, described["children"], refs, ancestors + (child,))


def _describe(app_services: Any, element: Any) -> dict[str, Any]:
    """Collect one element's contract attributes into a plain dict.

    Every string attribute is capped at _MAX_ATTRIBUTE_CHARS so a hostile app
    cannot flood the kernel or the model context with megabyte payloads.
    """
    return {
        "role": _cap(_text(_copy_value(app_services, element, "AXRole"))),
        "subrole": _cap(_text(_copy_value(app_services, element, "AXSubrole"))),
        "title": _cap(_text(_copy_value(app_services, element, "AXTitle"))),
        "value": _cap(_text(_copy_value(app_services, element, "AXValue"))),
        "description": _cap(_text(_copy_value(app_services, element, "AXDescription"))),
        "placeholder": _cap(_text(_copy_value(app_services, element, "AXPlaceholderValue"))),
        "actions": _actions(app_services, element),
        "position": _point(_copy_value(app_services, element, "AXPosition")),
        "size": _point(_copy_value(app_services, element, "AXSize")),
        "children": [],
    }


def _copy_value(app_services: Any, element: Any, attribute: str) -> Any:
    """Copy one accessibility attribute value, returning None on any AX error."""
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


def _actions(app_services: Any, element: Any) -> list[str]:
    """Copy the element's action names, tolerating any AX error."""
    try:
        result = app_services.AXUIElementCopyActions(element, None)
    except Exception:
        return []
    error, actions = _split_result(app_services, result)
    if error != app_services.kAXErrorSuccess:
        return []
    return [_cap(str(action)) for action in actions or ()]


def _point(value: Any) -> tuple[float, float] | None:
    """Convert one AX position or size value into an (x, y) pair of floats."""
    if value is None:
        return None
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


def _window_id(app_services: Any, window: Any) -> int | None:
    """Read the window's CGWindowID, or None when unavailable."""
    value = _copy_value(app_services, window, _WINDOW_ID_ATTRIBUTE)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _window_rect(app_services: Any, window: Any) -> tuple[float, float, float, float] | None:
    """Read the window's global position and size as (x, y, width, height)."""
    position = _point(_copy_value(app_services, window, "AXPosition"))
    size = _point(_copy_value(app_services, window, "AXSize"))
    if position is None or size is None:
        return None
    return (position[0], position[1], size[0], size[1])


def _window_server_rect(window_id: int | None) -> tuple[float, float, float, float] | None:
    """Read one window's bounds from the window server by its CGWindowID.

    Electron windows often omit AXPosition/AXSize on the AX element while
    the window server always knows the bounds; the CGWindowID comes from
    the private _AXWindowID attribute. Returns None when unknown.
    """
    if window_id is None:
        return None
    try:
        quartz = _require_mac().quartz
        options = quartz.kCGWindowListOptionOnScreenOnly | quartz.kCGWindowListExcludeDesktopElements
        for info in quartz.CGWindowListCopyWindowInfo(options, window_id):
            bounds = info.get("kCGWindowBounds")
            if bounds is None:
                continue
            return (
                float(bounds.get("X", 0.0)),
                float(bounds.get("Y", 0.0)),
                float(bounds.get("Width", 0.0)),
                float(bounds.get("Height", 0.0)),
            )
    except Exception:
        return None
    return None


def _set_messaging_timeout(app_services: Any, element: Any) -> None:
    """Bound AX calls to one app so an unresponsive process cannot stall the kernel."""
    try:
        app_services.AXUIElementSetMessagingTimeout(element, _MESSAGING_TIMEOUT_SECONDS)
    except Exception:
        return
