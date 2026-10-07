"""Prime Agent computer use: observe and operate native desktop apps.

The module is kernel-resident. get_state reports the platform surface,
get_app binds one app and returns an App whose element-indexed actions
re-observe the accessibility tree. Apps must be on the user-edited allowlist
in the settings file; every binding and every action re-checks the allowlist
gate and the locked screen.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import apps, ax, diff, errors
from ._compat import _backend, _require_mac
from .errors import ComputerUseError

__all__ = ["App", "ComputerUseError", "get_app", "get_state", "list_apps", "permissions_status"]

_PASTE_SETTLE_SECONDS = 0.1
_PASTE_FORMATS = ("text", "md", "html")
_PASTE_LOCK = threading.Lock()  # one save/write/paste/restore transaction at a time
_SETTLE_POLL_SECONDS = 0.05
_SETTLE_MAX_SECONDS = 0.5
_MAX_CLICK_COUNT = 10
_SECURE_HANDOFF = "this element is a secure field; Prime Agent never types into it — ask the user to enter the value"

_session_started: bool = False
_bound_apps: dict[str, App] = {}
_instruction_shown: set[str] = set()


async def get_state(emit: bool = True) -> dict[str, Any]:
    """Assemble the discovery snapshot: apps, permissions, allowlist, platform.

    emit=True fires the one-time computer_use_session_started telemetry on the
    first call per process and prints first-run guidance when macOS grants are
    missing; emit=False is a silent query that returns the same dict.
    """
    global _session_started
    started = time.perf_counter()
    from . import policy, permissions

    apps_list: list[dict[str, Any]] = []
    try:
        apps_list = await list_apps()
    except ComputerUseError as error:
        if error.code != "TRANSPORT_ERROR":
            raise
    status = permissions._status()
    state: dict[str, Any] = {
        "apps": apps_list,
        "permissions": status,
        "allowlist": policy._allowlist_summary(),
        "platform": _backend(),
    }
    if emit:
        _print_missing_grants(status)
        if not _session_started:
            _session_started = True
            from . import telemetry

            await telemetry._emit(telemetry.SESSION_STARTED, platform=_backend() or "unknown")
        await _emit_action("get_state", "ok", started)
    return state


async def list_apps() -> list[dict[str, Any]]:
    """List the running apps as {"id", "name", "running"} dicts."""
    return apps._list_apps()


async def get_app(app: str | dict[str, str]) -> App:
    """Bind one app by name, bundle id, or a {"bundle_id"|"name"|"path"} dict.

    Runs the allowlist gate, checks the locked screen and the macOS grants,
    launches the app when it is not running, and loads the first accessibility
    state. Raises ComputerUseError TRANSPORT_ERROR without a backend,
    SCREEN_LOCKED, APP_NOT_ALLOWED, AMBIGUOUS_APP, APP_LAUNCH_FAILED,
    APP_NOT_RUNNING, PERMISSIONS_NOT_GRANTED, or INVALID_ARGUMENT.
    """
    from . import permissions, policy

    if _backend() is None:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use backend unavailable: no macOS frameworks and no Linux X11 tools on this host",
        )
    if policy._screen_locked():
        raise ComputerUseError(
            "SCREEN_LOCKED",
            "the screen is locked; ask the user to unlock it before driving apps",
        )
    candidates = apps._resolve(app)
    allowed: list[apps.RunningApp] = []
    gate_errors: list[ComputerUseError] = []
    for candidate in candidates:
        result = policy._gate_app(candidate.bundle_id)
        if result.allowed:
            allowed.append(candidate)
        else:
            gate_errors.append(
                ComputerUseError("APP_NOT_ALLOWED", result.reason, {"bundle_id": candidate.bundle_id})
            )
    if len(allowed) > 1:
        bundle_ids = sorted(candidate.bundle_id for candidate in allowed)
        raise ComputerUseError(
            "AMBIGUOUS_APP",
            "the app spec matched several allowed apps ("
            + ", ".join(bundle_ids)
            + "); call get_app with the bundle_id of the one you want",
            {"bundle_ids": bundle_ids},
        )
    if allowed:
        bound = allowed[0]
    elif gate_errors:
        raise gate_errors[0]
    else:
        # launch blocks for up to the open timeout plus the appear poll, so
        # it must not stall the kernel's event loop
        bound = await asyncio.to_thread(_launch_and_gate, app)
    status = permissions._status()
    if status.get("accessibility") != "ok":
        raise ComputerUseError(
            "PERMISSIONS_NOT_GRANTED",
            "the Accessibility grant is missing or unknown; allow Prime Agent in System Settings > Privacy & Security > Accessibility, then retry",
            {"permission": "accessibility", "reported": str(status.get("accessibility"))[:16]},
        )
    existing = _bound_apps.get(bound.bundle_id)
    if existing is not None and existing.pid == bound.pid:
        return existing
    instance = App(bound.bundle_id, bound.name, bound.pid)
    instance._guard()  # the bind window spans launch and settle: revalidate before the first read
    await instance._refresh(diff_on=False)
    _bound_apps[bound.bundle_id] = instance
    return instance


async def permissions_status() -> dict[str, Any]:
    """Report the macOS accessibility and screen-recording grants with help text."""
    from . import permissions

    return permissions._status()


def _launch_and_gate(spec: str | dict[str, str]) -> apps.RunningApp:
    """Launch the app the spec names, gating its bundle id before any launch.

    The Accessibility grant is checked before launching, so a missing grant
    never starts an app as a side effect of a rejected bind. An unresolvable
    spec fails closed: Prime Agent never opens an app whose bundle id it
    could not determine beforehand, so a denied app cannot start as a side
    effect of a rejected bind. The launch itself targets the resolved bundle
    id (open -b), not the mutable name or path, so a spec that changes
    between resolution and launch cannot start a different app; the
    post-launch identity check remains as the backstop.
    """
    from . import permissions, policy

    status = permissions._status()
    if status.get("accessibility") != "ok":
        raise ComputerUseError(
            "PERMISSIONS_NOT_GRANTED",
            "the Accessibility grant is missing or unknown; allow Prime Agent in System Settings > Privacy & Security > Accessibility, then retry",
            {"permission": "accessibility", "reported": str(status.get("accessibility"))[:16]},
        )
    bundle_id = _prelaunch_bundle_id(spec)
    if bundle_id is None:
        raise ComputerUseError(
            "APP_NOT_ALLOWED",
            f"could not resolve {spec!r} to a bundle id without launching it, so Prime Agent fails "
            f"closed; ask the user to add the app's bundle id to `apps.allowed` in "
            f"{policy.SETTINGS_PATH} and call get_app with {{'bundle_id': ...}}",
            {"spec": str(spec)[:64]},
        )
    result = policy._gate_app(bundle_id)
    if not result.allowed:
        raise ComputerUseError("APP_NOT_ALLOWED", result.reason, {"bundle_id": bundle_id})
    launched = apps._launch({"bundle_id": bundle_id})
    if launched.bundle_id != bundle_id:
        raise ComputerUseError(
            "APP_NOT_ALLOWED",
            f"launching opened {launched.bundle_id} instead of the gated {bundle_id}; "
            "call get_app with the bundle_id of the app you want",
            {"gated_bundle_id": bundle_id, "launched_bundle_id": launched.bundle_id},
        )
    return launched


def _prelaunch_bundle_id(spec: str | dict[str, str]) -> str | None:
    """Resolve the bundle id a spec names without launching, or None when unresolvable.

    A dotted string is a bundle id; other names resolve through Spotlight;
    paths read their bundle id; dict specs use their single key.
    """
    if isinstance(spec, str):
        if not spec.strip():
            return None
        if "." in spec:
            # A dotted string is a bundle id only when it names a running app
            # or no installed app answers to it as a display name — a display
            # name can carry a dot too ("Acme 1.0"), and launching that as
            # `open -b` can never start it.
            if any(app.bundle_id == spec for app in apps._running_apps()):
                return spec
            resolved = apps._bundle_for_name(spec)
            if resolved is not None:
                return resolved
            return spec
        return apps._bundle_for_name(spec)
    kind = next((key for key in ("bundle_id", "name", "path") if key in spec), None)
    if kind == "bundle_id" and isinstance(spec["bundle_id"], str) and spec["bundle_id"].strip():
        return spec["bundle_id"]
    if kind == "path" and isinstance(spec["path"], str) and spec["path"].strip():
        return _bundle_id_for_path(spec["path"])
    if kind == "name" and isinstance(spec["name"], str) and spec["name"].strip():
        return apps._bundle_for_name(spec["name"])
    return None


def _bundle_id_for_path(path: str) -> str | None:
    """Read an app bundle's identifier from its bundle, best-effort."""
    try:
        cocoa = _require_mac().cocoa
        bundle = cocoa.NSBundle.bundleWithPath_(str(Path(path).expanduser()))
        if bundle is None:
            return None
        identifier = bundle.bundleIdentifier()
        return str(identifier) if identifier else None
    except Exception:
        return None


def _print_missing_grants(status: dict[str, Any]) -> None:
    """Print the first-run guidance when macOS grants are missing."""
    missing = [name for name in ("accessibility", "screen_recording") if status.get(name) == "missing"]
    if not missing:
        return
    print("Prime Agent computer use needs macOS permissions before it can drive apps:")
    for line in status.get("help") or []:
        print(line)


async def _emit_action(action: str, outcome: str, started: float, error_code: str | None = None) -> None:
    """Emit one computer_use_action event with the elapsed duration, best-effort.

    outcome is "ok" or "error"; errors carry their frozen code in the
    separate error_code property the telemetry catalog expects.
    """
    from . import telemetry

    properties: dict[str, Any] = {
        "action": action,
        "outcome": outcome,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }
    if error_code is not None:
        properties["error_code"] = error_code
    await telemetry._emit(telemetry.ACTION, **properties)


def _save_clipboard() -> dict[str, Any] | None:
    """Snapshot every pasteboard type's data for a later restore.

    Iterates the pasteboard's types and stores each type's data as bytes, so
    images, file lists, and other formats survive the paste round-trip. An
    empty pasteboard snapshots as an empty dict; None is reserved for a
    failed read, on which paste aborts instead of destroying the clipboard.
    """
    try:
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        saved: dict[str, Any] = {}
        for type_name in pasteboard.types() or ():
            data = pasteboard.dataForType_(type_name)
            if data is not None:
                saved[str(type_name)] = bytes(data)
        return saved
    except Exception:
        return None


def _write_clipboard(text: str, format: str) -> None:
    """Write one paste payload onto the system clipboard."""
    cocoa = _require_mac().cocoa
    pasteboard = cocoa.NSPasteboard.generalPasteboard()
    pasteboard.clearContents()
    if format == "html":
        encoded = text.encode("utf-8")
        data = cocoa.NSData.dataWithBytes_length_(encoded, len(encoded))
        pasteboard.setData_forType_(data, cocoa.NSPasteboardTypeHTML)
    pasteboard.setString_forType_(text, cocoa.NSPasteboardTypeString)


def _restore_clipboard(saved: dict[str, Any] | None) -> None:
    """Restore every saved pasteboard type, best-effort.

    None never touches the pasteboard: it is a failed snapshot, and clearing
    on it would erase the user's clipboard. Each type is restored on its own
    so one unreadable format never blocks the rest.
    """
    if saved is None:
        return
    try:
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        pasteboard.clearContents()
        for type_name, data in saved.items():
            try:
                payload = cocoa.NSData.dataWithBytes_length_(data, len(data))
                pasteboard.setData_forType_(payload, type_name)
            except Exception:
                continue
    except Exception:
        return


def _clipboard_still_holds_payload(text: str) -> bool:
    """Report whether the pasteboard still carries exactly the payload paste wrote.

    Compared before cmd+v is pressed, so a copy made between the write and
    the paste is not sent into the app and is left in place.
    """
    try:
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        current = pasteboard.dataForType_(cocoa.NSPasteboardTypeString)
        return bytes(current) == text.encode("utf-8")
    except Exception:
        return False


def _clipboard_change_count() -> int | None:
    """Read the pasteboard's change count, or None when it cannot be read.

    The count increments on every pasteboard change, so it detects a copy
    whose plain text matches the payload but whose rich or file data does
    not.
    """
    try:
        cocoa = _require_mac().cocoa
        return int(cocoa.NSPasteboard.generalPasteboard().changeCount())
    except Exception:
        return None


def _clipboard_unchanged(count: int | None, text: str) -> bool:
    """Report whether the pasteboard is unchanged since this paste's write.

    The change count is the primary token (it covers every type); a count
    that cannot be read or compared falls back to comparing the written
    payload, and an unverifiable pasteboard is treated as changed — the
    restore is skipped rather than discarding a concurrent copy.
    """
    try:
        current = _clipboard_change_count()
        if current is not None and count is not None:
            return current == count
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        payload = pasteboard.dataForType_(cocoa.NSPasteboardTypeString)
        return bytes(payload) == text.encode("utf-8")
    except Exception:
        return False


class App:
    """One bound running app with element-indexed accessibility actions.

    Every action re-checks the allowlist gate and the locked screen before it
    dispatches; element indices come from the last get_ax_state snapshot and a
    stale index raises ELEMENT_STALE.
    """

    def __init__(self, bundle_id: str, name: str, pid: int) -> None:
        """Bind one app process; get_app loads the first state."""
        self._bundle_id = bundle_id
        self._name = name
        self._pid = pid
        self._observation: ax.Observation | None = None
        self._lines: list[str] | None = None
        self._state: str | None = None
        self._shot_size: tuple[float, float] | None = None
        self._shot_rect: tuple[float, float, float, float] | None = None
        self._shot_window_id: int | None = None

    def __repr__(self) -> str:
        return f"<App {self._name} ({self._bundle_id}) pid {self._pid}>"

    @property
    def bundle_id(self) -> str:
        """The bound app's bundle identifier."""
        return self._bundle_id

    @property
    def name(self) -> str:
        """The bound app's localized name."""
        return self._name

    @property
    def pid(self) -> int:
        """The bound app's process identifier."""
        return self._pid

    @property
    def state(self) -> str | None:
        """The last accessibility text get_ax_state returned."""
        return self._state

    async def get_ax_state(self, diff: bool = True) -> str:
        """Return the element-indexed accessibility text, diffed against the previous snapshot.

        diff=False returns the full tree. Raises ComputerUseError
        TRANSPORT_ERROR when the accessibility API is unavailable.
        """
        self._guard()
        started = time.perf_counter()
        try:
            text = await self._refresh(diff_on=diff)
        except ComputerUseError as error:
            await _emit_action("get_state", "error", started, error_code=error.code)
            raise
        await _emit_action("get_state", "ok", started)
        return text

    async def get_screenshot(self, attach: bool = True) -> dict[str, Any]:
        """Capture the focused window and attach the image to the context.

        Returns {"path", "width", "height"}; attach=False skips the context
        attach. Raises ComputerUseError PERMISSIONS_NOT_GRANTED without the
        Screen Recording grant, TRANSPORT_ERROR when no window is observed,
        and APP_NOT_RUNNING when the window is gone.
        """
        self._guard()
        from . import capture, permissions

        status = permissions._status()
        if status.get("screen_recording") != "ok":
            raise ComputerUseError(
                "PERMISSIONS_NOT_GRANTED",
                "the Screen Recording grant is missing or unknown; allow Prime Agent in System Settings > Privacy & Security > Screen Recording, then retry",
                {"permission": "screen_recording", "reported": str(status.get("screen_recording"))[:16]},
            )
        observation = self._observation
        rect = observation.window_rect if observation is not None else None
        if rect is None:
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                "no focused window observed; call get_ax_state() first",
            )
        if observation.window_id is None:
            # a region capture would include whatever is on screen there —
            # other apps' content — so a window without a scoping id is
            # refused rather than captured
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                "the focused window does not expose its window id, so the capture cannot be "
                "scoped to it; call get_ax_state() again and retry",
                {},
            )
        # screencapture blocks for up to its timeout, so it must not stall the
        # kernel's event loop; the observation is snapshotted once so a
        # concurrent re-observe cannot re-tag the image with another window
        result = await asyncio.to_thread(
            capture._screenshot_window,
            (int(round(rect[0])), int(round(rect[1]))),
            (int(round(rect[2])), int(round(rect[3]))),
            window_id=observation.window_id,
        )
        self._shot_size = (float(result["width"]), float(result["height"]))
        self._shot_rect = rect
        self._shot_window_id = observation.window_id
        if attach:
            await capture._attach_image_if_available(str(result["path"]))
        return result

    async def get_state_and_screenshot(self, diff: bool = True, attach: bool = True) -> dict[str, Any]:
        """Return {"state", "screenshot"} in one call; the screenshot is None when capture fails."""
        state = await self.get_ax_state(diff)
        try:
            screenshot = await self.get_screenshot(attach)
        except ComputerUseError:
            screenshot = None
        return {"state": state, "screenshot": screenshot}

    async def click(self, target: int | tuple[float, float], button: str = "left", count: int = 1) -> None:
        """Click one element index or a window-screenshot (x, y) point.

        A single left click on an element exposing AXPress goes through the
        accessibility API; every other case injects a mouse event at the
        element's center in screen space. Raises ComputerUseError
        INVALID_ARGUMENT, ELEMENT_STALE, or ACTION_UNSUPPORTED.
        """
        from . import inject

        if button not in ("left", "right", "middle"):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"button must be one of left, right, middle, got {button!r}",
                {"button": str(button)[:32]},
            )
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= _MAX_CLICK_COUNT:
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"count must be an integer from 1 to {_MAX_CLICK_COUNT}, got {count!r}",
                {"count": count},
            )

        def dispatch() -> None:
            if isinstance(target, int) and not isinstance(target, bool):
                element, ref = self._element(target)
                actions = element.get("actions") or []
                if button == "left" and count == 1 and "AXPress" in actions:
                    ax._perform_action(ref, "AXPress")
                    return
                inject._click(self._pid, self._element_center(target), button=button, count=count)
            elif isinstance(target, tuple):
                inject._click(self._pid, self._window_point(target), button=button, count=count)
            else:
                raise ComputerUseError(
                    "INVALID_ARGUMENT",
                    f"target must be an element index or an (x, y) tuple, got {type(target).__name__}",
                    {"target": type(target).__name__},
                )

        await self._action("click", dispatch, settle=True)

    async def drag(self, from_: tuple[float, float], to: tuple[float, float]) -> None:
        """Drag between two window-screenshot (x, y) points."""
        from . import inject

        def dispatch() -> None:
            inject._drag(self._pid, self._window_point(from_), self._window_point(to))

        await self._action("drag", dispatch, settle=True)

    async def scroll(self, target: int | tuple[float, float], direction: str, pages: int = 1) -> None:
        """Scroll at one element index or window-screenshot point in one direction.

        direction is up, down, left, or right.
        """
        from . import inject

        if direction not in ("up", "down", "left", "right"):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"direction must be one of up, down, left, right, got {direction!r}",
                {"direction": str(direction)[:32]},
            )
        if not isinstance(pages, int) or isinstance(pages, bool) or pages < 1:
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"pages must be an integer of at least 1, got {pages!r}",
                {"pages": pages},
            )

        def dispatch() -> None:
            if isinstance(target, int) and not isinstance(target, bool):
                point: tuple[float, float] | None = self._element_center(target)
            elif isinstance(target, tuple):
                point = self._window_point(target)
            else:
                raise ComputerUseError(
                    "INVALID_ARGUMENT",
                    f"target must be an element index or an (x, y) tuple, got {type(target).__name__}",
                    {"target": type(target).__name__},
                )
            inject._scroll(self._pid, direction, pages=pages, point=point)

        await self._action("scroll", dispatch, settle=True)

    async def press_key(self, key: str) -> None:
        """Post one key chord such as "cmd+shift+f" or "Return" to the app.

        Refuses when the focused element is a secure field (secrets are the
        user's to type). The refusal runs after the guards, so a locked
        screen or a revoked allowlist reports its own error code instead of
        the secure-field hand-off.
        """
        from . import inject

        def dispatch() -> None:
            self._refuse_secure_focus()
            inject._press_key(self._pid, key)

        await self._action("press_key", dispatch, settle=True)

    async def type_text(self, text: str) -> None:
        """Type literal text into the app.

        Refuses with ACTION_UNSUPPORTED when the focused element is a secure
        field: passwords are the user's to type, not the agent's.
        """
        from . import inject

        def dispatch() -> None:
            self._refuse_secure_focus()
            inject._type_text(self._pid, text)

        await self._action("type_text", dispatch, settle=True)

    def _refuse_secure_focus(self) -> None:
        """Refuse keyboard entry into a focused secure field (hand-off to the user).

        The live focus wins: a post-snapshot focus change onto a secure field
        is still refused, and an unreadable live focus fails closed — the
        last snapshot never approves typing into a field it cannot verify.
        """
        focused_secure = ax._focused_is_secure(self._pid)
        if focused_secure is None:
            raise ComputerUseError(
                "ACTION_UNSUPPORTED",
                "could not verify that the focused element is not a secure text field; "
                "ask the user to type passwords and other secrets themselves",
                {"live": False},
            )
        if focused_secure:
            raise ComputerUseError(
                "ACTION_UNSUPPORTED",
                "the focused element is a secure text field; ask the user to type "
                "passwords and other secrets themselves",
                {"live": True},
            )

    async def set_value(self, element_index: int, value: str) -> None:
        """Set one element's value through the accessibility API.

        Secure fields are refused with ACTION_UNSUPPORTED and handed to the
        user.
        """
        if not isinstance(value, str):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"value must be a string, got {type(value).__name__}",
                {"value": type(value).__name__},
            )

        def dispatch() -> None:
            element, ref = self._element(element_index)
            live_secure = ax._live_is_secure(ref)
            if ax._is_secure_field(element) or live_secure:
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: {_SECURE_HANDOFF}",
                    {"element_index": element_index, "secure": True},
                )
            if live_secure is None:
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: could not verify that it is not a secure field; "
                    "ask the user to enter the value themselves",
                    {"element_index": element_index},
                )
            if not ax._is_settable(ref, "AXValue"):
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index} does not accept value writes; it is not editable text",
                    {"element_index": element_index},
                )
            ax._set_value(ref, value)

        await self._action("set_value", dispatch)

    async def select_text(self, element_index: int, text: str, prefix: str | None = None, suffix: str | None = None) -> None:
        """Select one occurrence of text inside the element without writing its content.

        Sets the element's selected text range onto the found occurrence; the
        content is never modified. prefix and suffix constrain the match: the
        occurrence must be immediately preceded and followed by them. Raises
        ELEMENT_STALE when the text is not in the element's current text and
        ACTION_UNSUPPORTED when it occurs more than once or the text cannot be
        read. Secure fields are refused and handed to the user.
        """
        if not isinstance(text, str) or not isinstance(prefix, (str, type(None))) or not isinstance(suffix, (str, type(None))):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                "text, prefix, and suffix must be strings",
                {"text": type(text).__name__},
            )
        if not text:
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                "text must be a non-empty string to select",
                {"text": ""},
            )

        def dispatch() -> None:
            element, ref = self._element(element_index)
            live_secure = ax._live_is_secure(ref)
            if ax._is_secure_field(element) or live_secure:
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: {_SECURE_HANDOFF}",
                    {"element_index": element_index, "secure": True},
                )
            if live_secure is None:
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: could not verify that it is not a secure field; "
                    "ask the user to enter the value themselves",
                    {"element_index": element_index},
                )
            value = ax._current_value(ref)
            if not isinstance(value, str):
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index} has no readable text to search",
                    {"element_index": element_index},
                )
            starts: list[int] = []
            start = value.find(text)
            while start != -1:
                end = start + len(text)
                before = value[max(0, start - len(prefix or "")) : start] if prefix else ""
                after = value[end : end + len(suffix or "")] if suffix else ""
                if (not prefix or before == prefix) and (not suffix or after == suffix):
                    starts.append(start)
                    if len(starts) > 1:
                        break  # ambiguity is all the caller needs to know
                start = value.find(text, start + 1)
            if not starts:
                raise ComputerUseError(
                    "ELEMENT_STALE",
                    f"{text!r} is not in the element's current text; re-observe with get_ax_state()",
                    {"element_index": element_index},
                )
            if len(starts) > 1:
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"{text!r} occurs {len(starts)} times; disambiguate it with prefix and suffix",
                    {"element_index": element_index, "occurrences": len(starts)},
                )
            ax._select_text_range(ref, starts[0], len(text))

        await self._action("select_text", dispatch)

    async def perform_secondary_action(self, element_index: int, action: str) -> None:
        """Perform one named action the element exposes, such as AXShowMenu.

        Arbitrary action names are refused; the element must expose the action.
        """

        def dispatch() -> None:
            element, ref = self._element(element_index)
            actions = element.get("actions") or []
            if action not in actions:
                exposed = ", ".join(actions) or "no actions"
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index} exposes {exposed}, not {action}",
                    {"element_index": element_index, "action": str(action)[:32]},
                )
            ax._perform_action(ref, action)

        await self._action("secondary", dispatch, settle=True)

    async def paste(self, text: str, format: str = "text") -> None:
        """Paste text through the clipboard with cmd+v, restoring the clipboard after.

        format is one of text, md, or html; only html writes rich clipboard
        data, text and md paste plain. Refuses when the focused element is a
        secure field (secrets are the user's to paste). The clipboard is
        restored afterwards, unless it no longer holds the pasted payload —
        a copy made during the paste window is kept, and a failed snapshot
        aborts before anything is written.
        """
        if format not in _PASTE_FORMATS:
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"format must be one of text, md, html, got {format!r}",
                {"format": str(format)[:32]},
            )
        if not isinstance(text, str):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"text must be a string, got {type(text).__name__}",
                {"text": type(text).__name__},
            )

        def dispatch() -> None:
            from . import inject

            with _PASTE_LOCK:
                self._refuse_secure_focus()
                saved = _save_clipboard()
                if saved is None:
                    raise ComputerUseError(
                        "TRANSPORT_ERROR",
                        "could not snapshot the clipboard; refusing to paste and risk the user's clipboard",
                        {},
                    )
                wrote = False
                change_count: int | None = None
                try:
                    try:
                        _write_clipboard(text, format)
                        wrote = True
                        if not _clipboard_still_holds_payload(text):
                            # a concurrent copy displaced the payload: never
                            # paste it, never restore over it
                            raise ComputerUseError(
                                "TRANSPORT_ERROR",
                                "the clipboard changed during the paste; the payload was not pasted",
                                {},
                            )
                        change_count = _clipboard_change_count()
                        # a queued paste rechecks the gates the moment it
                        # holds the lock: the focus and the app state may
                        # have moved while another paste held the lock
                        self._refuse_secure_focus()
                        self._guard()
                        inject._press_key(self._pid, "cmd+v")
                        time.sleep(_PASTE_SETTLE_SECONDS)
                    except ComputerUseError:
                        raise
                    except Exception as error:
                        raise ComputerUseError(
                            "TRANSPORT_ERROR",
                            f"could not write the paste payload: {str(error)[:200]}",
                            {},
                        ) from error
                finally:
                    # A failed write leaves the cleared pasteboard behind:
                    # restore it. A successful write restores only when the
                    # change count has not moved, so a copy made during the
                    # paste window wins over the restore.
                    if wrote and not _clipboard_unchanged(change_count, text):
                        pass
                    else:
                        _restore_clipboard(saved)

        await self._action("paste", dispatch, settle=True)

    async def _refresh(self, diff_on: bool = True) -> str:
        """Observe the app and store the new snapshot, returning its text."""
        # the walk can take up to its deadline on an unresponsive app
        observation = await asyncio.to_thread(ax._observe, self._pid)
        lines = diff._serialize(observation.tree)
        full = self._render_full(observation, lines)
        if diff_on and self._lines is not None:
            text = diff._diff(self._lines, lines) or "(no changes since the previous observation)"
        else:
            text = full
        self._observation = observation
        self._lines = lines
        self._state = text
        return text

    def _render_full(self, observation: ax.Observation, lines: list[str]) -> str:
        """Render the full state text, appending per-app instructions on first use."""
        header = f"{self._name} ({self._bundle_id})"
        count = len(observation.refs)
        if observation.window_title is not None:
            header += f" — window {observation.window_title!r}"
        if count:
            header += f" — {count} elements, indices [0]..[{count - 1}]"
        elif observation.window_title is None:
            header += " — no focused window"
        if observation.truncated:
            header += (
                " — TRUNCATED: the observation stopped at its element/depth/time bounds, "
                "some controls are hidden"
            )
        body = "\n".join(lines)
        instructions = ""
        if count and self._bundle_id not in _instruction_shown:
            _instruction_shown.add(self._bundle_id)
            loaded = ax._load_instructions(self._bundle_id)
            if loaded:
                instructions = "\n" + loaded
        return "\n".join(part for part in (header, body) if part) + instructions

    async def _action(self, action: str, dispatch: Callable[[], None], settle: bool = False) -> None:
        """Run one guarded action, wait for its UI effects, and emit telemetry.

        settle=True waits for the app to process the injected input (a
        bounded fingerprint poll) so the next get_ax_state observes the
        settled state; synchronous AX writes pass settle=False because the
        write has already completed when they return.
        """
        started = time.perf_counter()
        try:
            self._guard()
            # dispatch posts CG events and drives synchronous AX calls, each
            # bounded by its messaging timeout — still too slow for the loop
            await asyncio.to_thread(dispatch)
            if settle:
                await asyncio.to_thread(self._settle)
        except ComputerUseError as error:
            await _emit_action(action, "error", started, error_code=error.code)
            raise
        await _emit_action(action, "ok", started)

    def _settle(self) -> None:
        """Wait for the app to process injected input, bounded by the poll interval and cap.

        Reads the focused window's live fingerprint until two consecutive
        reads agree (or the read fails): a responsive app's tree has stopped
        changing by then, and a churning app is given up on at the cap
        instead of stalling the action.
        """
        deadline = time.monotonic() + _SETTLE_MAX_SECONDS
        previous = ax._window_fingerprint(self._pid, timeout_seconds=_SETTLE_MAX_SECONDS)
        if previous is None:
            return
        while time.monotonic() < deadline:
            time.sleep(_SETTLE_POLL_SECONDS)
            current = ax._window_fingerprint(self._pid, timeout_seconds=max(deadline - time.monotonic(), 0.05))
            if current is None or current == previous:
                return
            previous = current

    def _guard(self) -> None:
        """Re-validate the pid, the allowlist gate, the locked screen, and the grants.

        A reused pid now owned by another process (or nothing at all) fails
        closed: APP_NOT_RUNNING when no app owns it, APP_NOT_ALLOWED when a
        different bundle owns it. A grant revoked mid-session fails with
        PERMISSIONS_NOT_GRANTED so the model is told to stop and re-grant
        instead of chasing INJECTION_FAILED.
        """
        from . import permissions, policy

        running_bundle = apps._running_bundle_id(self._pid)
        if running_bundle is None:
            raise ComputerUseError(
                "APP_NOT_RUNNING",
                f"pid {self._pid} is no longer a running app; call get_app again to re-bind it",
                {"pid": self._pid},
            )
        if running_bundle != self._bundle_id:
            raise ComputerUseError(
                "APP_NOT_ALLOWED",
                f"pid {self._pid} now belongs to {running_bundle}, not the bound {self._bundle_id}; "
                "call get_app again to re-bind the app you want",
                {"pid": self._pid, "running_bundle_id": running_bundle},
            )
        result = policy._gate_app(self._bundle_id)
        if not result.allowed:
            raise ComputerUseError("APP_NOT_ALLOWED", result.reason, {"bundle_id": self._bundle_id})
        if policy._screen_locked():
            raise ComputerUseError(
                "SCREEN_LOCKED",
                "the screen is locked; ask the user to unlock it before driving apps",
            )
        status = permissions._status()
        if status.get("accessibility") != "ok":
            raise ComputerUseError(
                "PERMISSIONS_NOT_GRANTED",
                "the Accessibility grant is missing or was revoked; allow Prime Agent again in "
                "System Settings > Privacy & Security > Accessibility and restart Prime Agent, "
                "then re-bind with get_app",
                {"permission": "accessibility", "reported": str(status.get("accessibility"))[:16]},
            )

    def _element(self, element_index: int) -> tuple[dict[str, Any], Any]:
        """Return the indexed element dict and its AX ref from the current snapshot."""
        if not isinstance(element_index, int) or isinstance(element_index, bool):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"element index must be an integer, got {type(element_index).__name__}",
                {"element_index": type(element_index).__name__},
            )
        observation = self._observation
        refs = observation.refs if observation is not None else []
        if element_index < 0 or element_index >= len(refs):
            raise ComputerUseError(
                "ELEMENT_STALE",
                f"element index {element_index} is stale; re-observe with get_ax_state() and use fresh indices",
                {"element_index": element_index},
            )
        # refs and tree come from the one captured snapshot: a concurrent
        # refresh publishing a new observation mid-read must not mix the two
        element = ax._flatten(observation.tree)[element_index]
        live_role, live_title = ax._live_fingerprint(refs[element_index])
        if live_role != element.get("role") or live_title != element.get("title"):
            raise ComputerUseError(
                "ELEMENT_STALE",
                f"element {element_index} changed since the last observation "
                f"({element.get('role')!r} -> {live_role!r}); re-observe with get_ax_state()",
                {"element_index": element_index},
            )
        return element, refs[element_index]

    def _element_center(self, element_index: int) -> tuple[float, float]:
        """Compute one element's center in screen space from its AX bounds."""
        element, _ref = self._element(element_index)
        position = element.get("position")
        size = element.get("size")
        if not position or not size:
            raise ComputerUseError(
                "ACTION_UNSUPPORTED",
                f"element {element_index} has no on-screen position to click",
                {"element_index": element_index},
            )
        return (
            float(position[0]) + float(size[0]) / 2,
            float(position[1]) + float(size[1]) / 2,
        )

    def _window_point(self, point: tuple[float, float]) -> tuple[float, float]:
        """Translate one window-screenshot (x, y) point into screen space.

        Screenshot pixels are scaled back to the window's logical bounds when
        the captured image is larger (Retina captures are 2x), so a point read
        off the image lands on the on-screen element it shows.
        """
        if (
            not isinstance(point, tuple)
            or len(point) != 2
            or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in point)
        ):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"point must be an (x, y) pair of numbers, got {point!r}",
                {"point": repr(point)[:64]},
            )
        rect = self._observation.window_rect if self._observation is not None else None
        if rect is None:
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                "no focused window observed; call get_ax_state() first",
            )
        shot = self._shot_size
        current_window_id = self._observation.window_id
        if shot is not None and current_window_id is not None and self._shot_window_id is not None:
            if current_window_id != self._shot_window_id:
                raise ComputerUseError(
                    "TRANSPORT_ERROR",
                    "the focused window changed since the screenshot; take a fresh screenshot "
                    "before clicking image coordinates",
                    {},
                )
        if shot is not None and shot != (float(self._shot_rect[2]), float(self._shot_rect[3])):
            # the capture's pixel-to-logical scale is a size property: it
            # survives a moved window (the origin below is the live one), so
            # image points still land on the on-screen element they show
            if not 0 <= float(point[0]) < shot[0] or not 0 <= float(point[1]) < shot[1]:
                raise ComputerUseError(
                    "INVALID_ARGUMENT",
                    f"point {point!r} is outside the captured image "
                    f"({shot[0]:.0f}x{shot[1]:.0f}); use coordinates from its screenshot",
                    {"point": repr(point)[:64]},
                )
            scaled = (
                float(point[0]) * float(self._shot_rect[2]) / shot[0],
                float(point[1]) * float(self._shot_rect[3]) / shot[1],
            )
            if not 0 <= scaled[0] < float(rect[2]) or not 0 <= scaled[1] < float(rect[3]):
                raise ComputerUseError(
                    "INVALID_ARGUMENT",
                    f"point {point!r} lands outside the observed window "
                    f"({float(rect[2]):.0f}x{float(rect[3]):.0f}); the window changed since the "
                    "capture, so take a fresh screenshot",
                    {"point": repr(point)[:64]},
                )
            return (rect[0] + scaled[0], rect[1] + scaled[1])
        if shot is not None and (not 0 <= float(point[0]) < shot[0] or not 0 <= float(point[1]) < shot[1]):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"point {point!r} is outside the captured image "
                f"({shot[0]:.0f}x{shot[1]:.0f}); use coordinates from its screenshot",
                {"point": repr(point)[:64]},
            )
        if not 0 <= float(point[0]) < float(rect[2]) or not 0 <= float(point[1]) < float(rect[3]):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"point {point!r} is outside the observed window "
                f"({float(rect[2]):.0f}x{float(rect[3]):.0f}); use coordinates from its screenshot",
                {"point": repr(point)[:64]},
            )
        return (rect[0] + float(point[0]), rect[1] + float(point[1]))


async def run() -> str:
    """Print a one-shot status summary (the skill's console entry point)."""
    state = await get_state(emit=False)
    permissions = state.get("permissions", {})
    running = [
        app for app in state.get("apps", []) if isinstance(app, dict) and app.get("running")
    ]
    allowlist = state.get("allowlist", {})
    lines = [
        f"platform: {state.get('platform') or 'unavailable'}",
        f"accessibility: {permissions.get('accessibility', 'unknown')}",
        f"screen recording: {permissions.get('screen_recording', 'unknown')}",
        f"running apps: {len(running)}",
        f"allowlist: {len(allowlist.get('allowed', []))} allowed, "
        f"{len(allowlist.get('blocked', []))} blocked",
    ]
    return "\n".join(lines)
