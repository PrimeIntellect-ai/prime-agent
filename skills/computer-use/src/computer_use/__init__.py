"""Prime Agent computer use: observe and operate native desktop apps.

The module is kernel-resident. get_state reports the platform surface,
get_app binds one app and returns an App whose element-indexed actions
re-observe the accessibility tree. Apps must be on the user-edited allowlist
in the settings file; every binding and every action re-checks the allowlist
gate and the locked screen.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import apps, ax, diff, errors
from ._compat import _backend, _require_mac
from .errors import ComputerUseError

__all__ = ["App", "ComputerUseError", "get_app", "get_state", "list_apps", "permissions_status"]

_PASTE_SETTLE_SECONDS = 0.1
_ACTION_SETTLE_SECONDS = 0.12  # bounded post-action settle: input lands before the next observe
_PASTE_FORMATS = ("text", "md", "html")
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
    state. Raises ComputerUseError TRANSPORT_ERROR without a _backend,
    SCREEN_LOCKED, APP_NOT_ALLOWED, AMBIGUOUS_APP, APP_LAUNCH_FAILED,
    APP_NOT_RUNNING, PERMISSIONS_NOT_GRANTED, or INVALID_ARGUMENT.
    """
    from . import permissions, policy

    if _backend() is None:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use _backend unavailable: no macOS frameworks and no Linux X11 tools on this host",
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
        bound = _launch_and_gate(app)
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
    await instance._refresh(diff_on=False)
    _bound_apps[bound.bundle_id] = instance
    return instance


async def permissions_status() -> dict[str, Any]:
    """Report the macOS accessibility and screen-recording grants with help text."""
    from . import permissions

    return permissions._status()


def _launch_and_gate(spec: str | dict[str, str]) -> apps.RunningApp:
    """Launch the app the spec names, gating its bundle id before any launch.

    An unresolvable spec fails closed: Prime Agent never opens an app whose
    bundle id it could not determine beforehand, so a denied app cannot start
    as a side effect of a rejected bind.
    """
    from . import policy

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
    launched = apps._launch(spec)
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
    images, file lists, and other formats survive the paste round-trip.
    """
    try:
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        saved: dict[str, Any] = {}
        for type_name in pasteboard.types() or ():
            data = pasteboard.dataForType_(type_name)
            if data is not None:
                saved[str(type_name)] = bytes(data)
        return saved or None
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
    """Restore every saved pasteboard type, best-effort."""
    try:
        cocoa = _require_mac().cocoa
        pasteboard = cocoa.NSPasteboard.generalPasteboard()
        pasteboard.clearContents()
        for type_name, data in (saved or {}).items():
            payload = cocoa.NSData.dataWithBytes_length_(data, len(data))
            pasteboard.setData_forType_(payload, type_name)
    except Exception:
        return


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
        rect = self._observation.window_rect if self._observation is not None else None
        if rect is None:
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                "no focused window observed; call get_ax_state() first",
            )
        result = capture._screenshot_window(
            (int(round(rect[0])), int(round(rect[1]))),
            (int(round(rect[2])), int(round(rect[3]))),
            window_id=self._observation.window_id,
        )
        if attach:
            await capture._attach_image_if_available(str(result["path"]))
        return result

    async def get_text_regions(self, attach: bool = False) -> dict[str, Any]:
        """Read the focused window with OCR and return its text regions.

        The non-vision screen-reading path: regions carry text, confidence,
        and window-screenshot-relative pixel coordinates, so click targets
        can be derived directly. attach=True also attaches the screenshot
        for vision-capable models. Same guards as get_screenshot.
        """
        self._guard()
        from . import capture, ocr, permissions

        status = permissions._status()
        if status.get("screen_recording") != "ok":
            raise ComputerUseError(
                "PERMISSIONS_NOT_GRANTED",
                "the Screen Recording grant is missing or unknown; allow Prime Agent in System Settings > Privacy & Security > Screen Recording, then retry",
                {"permission": "screen_recording", "reported": str(status.get("screen_recording"))[:16]},
            )
        rect = self._observation.window_rect if self._observation is not None else None
        if rect is None:
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                "no focused window observed; call get_ax_state() first",
            )
        result = capture._screenshot_window(
            (int(round(rect[0])), int(round(rect[1]))),
            (int(round(rect[2])), int(round(rect[3]))),
            window_id=self._observation.window_id,
        )
        regions = await ocr._get_text_regions(str(result["path"]))
        scaled = [
            {
                "text": region["text"],
                "confidence": region["confidence"],
                "x": region["x"] * result["width"],
                "y": region["y"] * result["height"],
                "width": region["width"] * result["width"],
                "height": region["height"] * result["height"],
            }
            for region in regions
        ]
        if attach:
            await capture._attach_image_if_available(str(result["path"]))
        return {"regions": scaled, "width": result["width"], "height": result["height"]}

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

        await self._action("click", dispatch)

    async def drag(self, from_: tuple[float, float], to: tuple[float, float]) -> None:
        """Drag between two window-screenshot (x, y) points."""
        from . import inject

        def dispatch() -> None:
            inject._drag(self._pid, self._window_point(from_), self._window_point(to))

        await self._action("drag", dispatch)

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

        await self._action("scroll", dispatch)

    async def press_key(self, key: str) -> None:
        """Post one key chord such as "cmd+shift+f" or "Return" to the app.

        Refuses when the focused element is a secure field (secrets are the
        user's to type).
        """
        self._refuse_secure_focus()
        from . import inject

        def dispatch() -> None:
            inject._press_key(self._pid, key)

        await self._action("press_key", dispatch)

    async def type_text(self, text: str) -> None:
        """Type literal text into the app.

        Refuses with ACTION_UNSUPPORTED when the focused element is a secure
        field: passwords are the user's to type, not the agent's.
        """
        self._refuse_secure_focus()
        from . import inject

        def dispatch() -> None:
            inject._type_text(self._pid, text)

        await self._action("type_text", dispatch)

    def _refuse_secure_focus(self) -> None:
        """Refuse keyboard entry into a focused secure field (hand-off to the user).

        The live focus wins: a post-snapshot focus change onto a secure field
        is still refused. When the live focus cannot be read, the last
        snapshot's focused index decides.
        """
        focused_secure = ax._focused_is_secure(self._pid)
        if focused_secure is None:
            observation = self._observation
            if observation is None or observation.focused_index is None:
                return
            element = ax._flatten(observation.tree)[observation.focused_index]
            focused_secure = ax._is_secure_field(element)
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
            if ax._is_secure_field(element):
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: {_SECURE_HANDOFF}",
                    {"element_index": element_index, "secure": True},
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
            if ax._is_secure_field(element):
                raise ComputerUseError(
                    "ACTION_UNSUPPORTED",
                    f"element {element_index}: {_SECURE_HANDOFF}",
                    {"element_index": element_index, "secure": True},
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

        await self._action("secondary", dispatch)

    async def paste(self, text: str, format: str = "text") -> None:
        """Paste text through the clipboard with cmd+v, restoring the clipboard after.

        format is one of text, md, or html. Refuses when the focused
        element is a secure field (secrets are the user's to paste).
        """
        self._refuse_secure_focus()
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

            saved = _save_clipboard()
            try:
                _write_clipboard(text, format)
                inject._press_key(self._pid, "cmd+v")
                time.sleep(_PASTE_SETTLE_SECONDS)
            finally:
                _restore_clipboard(saved)

        await self._action("paste", dispatch)

    async def activate(self) -> None:
        """Bring the app's frontmost window to the foreground.

        App-scoped keyboard shortcuts (menus, quick switchers) only fire
        while the app is key, so call this before shortcut-driven flows;
        it replaces the `open -a`/osascript detours the model would
        otherwise improvise from bash.
        """
        await self._action("activate", lambda: apps._activate(self._pid))

    def is_frontmost(self) -> bool:
        """Report whether the app is the frontmost (key) application."""
        return apps._frontmost_pid() == self._pid

    async def _refresh(self, diff_on: bool = True) -> str:
        """Observe the app and store the new snapshot, returning its text."""
        observation = ax._observe(self._pid)
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
        body = "\n".join(lines)
        instructions = ""
        if count and self._bundle_id not in _instruction_shown:
            _instruction_shown.add(self._bundle_id)
            loaded = ax._load_instructions(self._bundle_id)
            if loaded:
                instructions = "\n" + loaded
        return "\n".join(part for part in (header, body) if part) + instructions

    async def _action(self, action: str, dispatch: Callable[[], None]) -> None:
        """Run one guarded action, settle briefly, and emit its outcome telemetry."""
        started = time.perf_counter()
        try:
            self._guard()
            dispatch()
        except ComputerUseError as error:
            await _emit_action(action, "error", started, error_code=error.code)
            raise
        time.sleep(_ACTION_SETTLE_SECONDS)
        await _emit_action(action, "ok", started)

    def _guard(self) -> None:
        """Re-validate the pid, the allowlist gate, and the locked screen before one action.

        A reused pid now owned by another process (or nothing at all) fails
        closed: APP_NOT_RUNNING when no app owns it, APP_NOT_ALLOWED when a
        different bundle owns it.
        """
        from . import policy

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

    def _element(self, element_index: int) -> tuple[dict[str, Any], Any]:
        """Return the indexed element dict and its AX ref from the current snapshot."""
        if not isinstance(element_index, int) or isinstance(element_index, bool):
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"element index must be an integer, got {type(element_index).__name__}",
                {"element_index": type(element_index).__name__},
            )
        refs = self._observation.refs if self._observation is not None else []
        if element_index < 0 or element_index >= len(refs):
            raise ComputerUseError(
                "ELEMENT_STALE",
                f"element index {element_index} is stale; re-observe with get_ax_state() and use fresh indices",
                {"element_index": element_index},
            )
        element = ax._flatten(self._observation.tree)[element_index]
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
                f"element {element_index} has no on-screen position (web views often omit "
                "element geometry); use keyboard navigation, or window-screenshot "
                "coordinates from get_screenshot()",
                {"element_index": element_index},
            )
        return (
            float(position[0]) + float(size[0]) / 2,
            float(position[1]) + float(size[1]) / 2,
        )

    def _window_point(self, point: tuple[float, float]) -> tuple[float, float]:
        """Translate one window-screenshot (x, y) point into screen space."""
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
