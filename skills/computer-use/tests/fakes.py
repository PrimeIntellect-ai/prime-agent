"""Fakes and fixtures for the computer-use tests.

Everything here runs without a display, without TCC grants, and without
touching real apps. Element dicts use the frozen contract keys (role,
subrole, title, value, description, placeholder, actions, position, size,
children). Policy fixtures are real TOML files written into a
caller-provided temp directory so no test reads the live settings path.
"""

from __future__ import annotations

import contextlib
import sys
import tempfile
import types
from pathlib import Path
from typing import Any, Callable, Iterator

SKILL_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = SKILL_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))


def element(
    role: str = "AXButton",
    subrole: str | None = None,
    title: str | None = None,
    value: str | None = None,
    description: str | None = None,
    placeholder: str | None = None,
    actions: tuple[str, ...] = (),
    position: tuple[float, float] | None = None,
    size: tuple[float, float] | None = None,
    children: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build one canned AX element dict with the contract keys."""
    return {
        "role": role,
        "subrole": subrole,
        "title": title,
        "value": value,
        "description": description,
        "placeholder": placeholder,
        "actions": list(actions),
        "position": list(position) if position is not None else None,
        "size": list(size) if size is not None else None,
        "children": [dict(child) for child in (children or [])],
    }


def window(
    title: str = "Main",
    children: list[dict[str, Any]] | None = None,
    origin: tuple[float, float] = (100.0, 50.0),
    size: tuple[float, float] = (400.0, 300.0),
) -> dict[str, Any]:
    """Build a root window element holding the given children."""
    return element(
        role="AXWindow",
        subrole="AXStandardWindow",
        title=title,
        actions=("AXRaise",),
        position=origin,
        size=size,
        children=children,
    )


def small_tree() -> dict[str, Any]:
    """Build a small canned app tree covering the interesting element kinds."""
    return window(
        children=[
            element(role="AXStaticText", title="Label", value="Hello", position=(20.0, 60.0), size=(200.0, 20.0)),
            element(
                role="AXTextField",
                title="Search",
                value="query",
                placeholder="Search…",
                actions=("AXSetValue",),
                position=(20.0, 90.0),
                size=(240.0, 24.0),
            ),
            element(role="AXButton", title="Save", actions=("AXPress",), position=(280.0, 88.0), size=(80.0, 28.0)),
            element(role="AXCheckBox", title="Enabled", value="1", actions=("AXPress",), position=(20.0, 130.0), size=(120.0, 20.0)),
            element(
                role="AXTextField",
                subrole="AXSecureTextField",
                title="Password",
                value="hunter2",
                actions=("AXSetValue",),
                position=(20.0, 160.0),
                size=(180.0, 24.0),
            ),
        ]
    )


def large_tree(groups: int = 6, rows: int = 7, leaves: int = 7) -> dict[str, Any]:
    """Build a deterministic tree of several hundred elements."""
    return window(
        children=[
            element(
                role="AXGroup",
                title=f"Group {g}",
                children=[
                    element(
                        role="AXGroup",
                        title=f"Group {g} row {r}",
                        children=[
                            element(role="AXStaticText", title=f"Text {g}-{r}-{i}", value=f"v{g}-{r}-{i}")
                            for i in range(leaves)
                        ],
                    )
                    for r in range(rows)
                ],
            )
            for g in range(groups)
        ]
    )


def deep_copy(node: dict[str, Any]) -> dict[str, Any]:
    """Recursively copy a canned tree so mutations stay isolated."""
    copied = dict(node)
    copied["actions"] = list(node.get("actions", []))
    position = node.get("position")
    copied["position"] = list(position) if position is not None else None
    size = node.get("size")
    copied["size"] = list(size) if size is not None else None
    copied["children"] = [deep_copy(child) for child in node.get("children", [])]
    return copied


def find_by_title(node: dict[str, Any], title: str) -> dict[str, Any] | None:
    """Return the first element whose title matches, depth first."""
    if node.get("title") == title:
        return node
    for child in node.get("children", []):
        found = find_by_title(child, title)
        if found is not None:
            return found
    return None


def with_changed_value(node: dict[str, Any], title: str, value: str) -> dict[str, Any]:
    """Return a deep copy with the titled element's value replaced."""
    tree = deep_copy(node)
    target = find_by_title(tree, title)
    if target is None:
        raise KeyError(title)
    target["value"] = value
    return tree


def with_added_child(node: dict[str, Any], parent_title: str, child: dict[str, Any]) -> dict[str, Any]:
    """Return a deep copy with one child appended under the titled element."""
    tree = deep_copy(node)
    target = find_by_title(tree, parent_title)
    if target is None:
        raise KeyError(parent_title)
    target["children"].append(child)
    return tree


def without_child(node: dict[str, Any], title: str) -> dict[str, Any]:
    """Return a deep copy with the titled element removed from its parent."""
    tree = deep_copy(node)
    for child in tree.get("children", []):
        if child.get("title") == title:
            tree["children"].remove(child)
            return tree
        parent = _parent_of(child, title)
        if parent is not None:
            parent["children"].remove(find_by_title(parent, title))
            return tree
    raise KeyError(title)


def _parent_of(node: dict[str, Any], title: str) -> dict[str, Any] | None:
    for child in node.get("children", []):
        if child.get("title") == title:
            return node
        found = _parent_of(child, title)
        if found is not None:
            return found
    return None


def find_all(node: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten a canned tree into a depth-first element list."""
    elements = [dict(node)]
    for child in node.get("children", []):
        elements.extend(find_all(child))
    return elements


def flatten_all(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten one element list depth-first into ax walk order (self objects, no copies)."""
    flat: list[dict[str, Any]] = []
    for element in elements:
        flat.append(element)
        stack = list(reversed(element.get("children") or []))
        while stack:
            child = stack.pop()
            flat.append(child)
            stack.extend(reversed(child.get("children") or []))
    return flat


def write_settings(
    directory: Path | str,
    *,
    allowed: tuple[str, ...] = (),
    blocked: tuple[str, ...] = (),
    system_deny: tuple[str, ...] = (),
    risk: dict[str, str] | None = None,
) -> Path:
    """Write a computer-use.toml policy fixture and return its path."""
    lines: list[str] = []
    if system_deny:
        lines.append("system_deny = [" + ", ".join(f'"{item}"' for item in system_deny) + "]")
    if allowed or blocked:
        lines.append("[apps]")
        if allowed:
            lines.append("allowed = [" + ", ".join(f'"{item}"' for item in allowed) + "]")
        if blocked:
            lines.append("blocked = [" + ", ".join(f'"{item}"' for item in blocked) + "]")
    if risk:
        lines.append("[risk]")
        for bundle_id, label in risk.items():
            lines.append(f'"{bundle_id}" = "{label}"')
    path = Path(directory) / "computer-use.toml"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def raw_settings(
    *,
    allowed: list[str] | None = None,
    blocked: list[str] | None = None,
    system_deny: list[str] | None = None,
    risk: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a parsed-TOML dict matching the settings file contract shape."""
    return {
        "apps": {
            "allowed": list(allowed or []),
            "blocked": list(blocked or []),
        },
        "system_deny": list(system_deny or []),
        "risk": dict(risk or {}),
    }


class TelemetryRecorder:
    """Async host_request fake capturing telemetry._emit payloads."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.error: BaseException | None = None

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.error is not None:
            raise self.error
        normalized = dict(payload or {})
        self.requests.append((request_type, normalized))
        if request_type == "telemetry._emit":
            self.events.append(
                {"name": normalized.get("name"), "properties": dict(normalized.get("properties") or {})}
            )
        return {}


@contextlib.contextmanager
def telemetry_recorder() -> Iterator[TelemetryRecorder]:
    """Patch computer_use.telemetry.host_request with a capturing fake."""
    import computer_use.telemetry as telemetry_module

    fake = TelemetryRecorder()
    saved = telemetry_module.host_request
    telemetry_module.host_request = fake
    try:
        yield fake
    finally:
        telemetry_module.host_request = saved


def probe(result: bool | None) -> Callable[[], bool | None]:
    """Build a permissions probe returning a fixed result."""

    def call() -> bool | None:
        return result

    return call


LOCKED_SESSION: dict[str, Any] = {"CGSSessionScreenIsLocked": True}
UNLOCKED_SESSION: dict[str, Any] = {"CGSSessionScreenIsLocked": False}


class RecordingBackend:
    """Recording stand-in for the sync inject, capture, and apps surface.

    Method names, signatures, and call style mirror the landed
    computer_use.inject, computer_use.capture, and computer_use.apps modules
    exactly: pid-keyed, CG screen-space coordinates, sync calls the App layer
    wraps, and the async attach hook.
    """

    def __init__(self, screenshot: dict[str, str | int] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.attach_calls: list[str] = []
        self.attach_error: BaseException | None = None
        self.screenshot_error: BaseException | None = None
        self.screenshot = dict(
            screenshot or {"path": "/tmp/computer-use-fake.png", "width": 400, "height": 300}
        )

    def calls_named(self, name: str) -> list[dict[str, Any]]:
        """Return the recorded kwargs of every call with the given name."""
        return [kwargs for recorded, kwargs in self.calls if recorded == name]

    def _paste(self, pid: int, text: str, format: str = "text") -> None:
        """Record a paste without touching the clipboard."""
        self.calls.append(("paste", {"pid": pid, "text": text, "format": format}))

    def _click(self, pid: int, point: tuple[int, int], button: str = "left", count: int = 1) -> None:
        """Record a click without posting events."""
        self.calls.append(("click", {"pid": pid, "point": tuple(point), "button": button, "count": count}))

    def _drag(self, pid: int, start: tuple[int, int], end: tuple[int, int]) -> None:
        """Record a drag without posting events."""
        self.calls.append(("drag", {"pid": pid, "start": tuple(start), "end": tuple(end)}))

    def _scroll(self, pid: int, direction: str, pages: int = 1, point: tuple[int, int] | None = None) -> None:
        """Record a scroll without posting events."""
        self.calls.append(
            (
                "scroll",
                {"pid": pid, "direction": direction, "pages": pages, "point": tuple(point) if point else None},
            )
        )

    def _press_key(self, pid: int, key: str) -> None:
        """Record a key press without posting events."""
        self.calls.append(("press_key", {"pid": pid, "key": key}))

    def _type_text(self, pid: int, text: str) -> None:
        """Record typing without posting events."""
        self.calls.append(("type_text", {"pid": pid, "text": text}))

    def _activate(self, pid: int) -> None:
        """Record an activation dispatch without touching NSWorkspace."""
        self.calls.append(("activate", {"pid": pid}))

    def _screenshot_window(
        self, origin: tuple[int, int], size: tuple[int, int], window_id: int | None = None
    ) -> dict[str, str | int]:
        """Record the capture region and return the canned screenshot dict."""
        recorded: dict[str, Any] = {"origin": tuple(origin), "size": tuple(size)}
        if window_id is not None:
            recorded["window_id"] = window_id
        self.calls.append(("screenshot_window", recorded))
        if self.screenshot_error is not None:
            raise self.screenshot_error
        return dict(self.screenshot)

    async def _attach_image_if_available(self, path: str) -> None:
        """Record the attach path, or raise the injected attach error."""
        self.attach_calls.append(path)
        if self.attach_error is not None:
            raise self.attach_error

    _attach = _attach_image_if_available


INJECT_SEAMS = ("_click", "_drag", "_scroll", "_press_key", "_type_text")
CAPTURE_SEAMS = ("_screenshot_window", "_attach_image_if_available", "_attach")
APPS_SEAMS = ("_activate",)


@contextlib.contextmanager
def recording_backend(_backend: RecordingBackend | None = None) -> Iterator[RecordingBackend]:
    """Patch the inject, capture, and apps module seams with one RecordingBackend."""
    from computer_use import apps, capture, inject

    _backend = _backend or RecordingBackend()
    modules = {"apps": apps, "inject": inject, "capture": capture}
    seams: list[tuple[str, str]] = [("inject", name) for name in INJECT_SEAMS]
    seams.extend(("capture", name) for name in CAPTURE_SEAMS)
    seams.extend(("apps", name) for name in APPS_SEAMS)
    saved: dict[tuple[str, str], Any] = {}
    patched: list[tuple[str, str]] = []
    for module_name, attr in seams:
        if not hasattr(modules[module_name], attr):
            raise AssertionError(f"test seam {module_name}.{attr} is missing from the package")
        if not hasattr(_backend, attr):
            raise AssertionError(f"RecordingBackend is missing the {attr} seam")
        saved[(module_name, attr)] = getattr(modules[module_name], attr)
        setattr(modules[module_name], attr, getattr(_backend, attr))
        patched.append((module_name, attr))
    try:
        yield _backend
    finally:
        for module_name, attr in patched:
            setattr(modules[module_name], attr, saved[(module_name, attr)])

def observation(
    tree: dict[str, Any] | list[dict[str, Any]],
    window_title: str | None = "Main",
    window_rect: tuple[float, float, float, float] | None = (100.0, 50.0, 400.0, 300.0),
    focused_index: int | None = None,
    window_id: int | None = None,
) -> Any:
    """Build a canned ax._observe result; refs follow the same walk order as ax._flatten."""
    from computer_use import ax

    elements = tree if isinstance(tree, list) else tree["children"]
    return ax.Observation(
        window_title=window_title,
        tree=elements,
        refs=flatten_all(elements),
        window_rect=window_rect,
        focused_index=focused_index,
        window_id=window_id,
    )


def _never_require_mac() -> Any:
    """Fail loudly when a faked test path reaches a real macOS framework."""
    raise AssertionError("_require_mac must not run under the faked environment")


class FakeAttach:
    """Fake attach_image.run recording paths, optionally raising like a non-vision host."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.error: BaseException | None = None

    async def run(self, path: str) -> None:
        self.paths.append(path)
        if self.error is not None:
            raise self.error


class AppEnvironment:
    """One fully faked computer-use environment for App-level tests.

    Patches every _backend seam: platform dispatch, app listing, launch,
    activation, and frontmost focus, AX observation and element actions, the
    allowlist gate and lock probe, TCC status, inject/capture, telemetry, the
    clipboard helpers, and the kernel-resident module state. No display, TCC
    grant, real app, or live framework is ever touched.
    """

    def __init__(
        self,
        tree: dict[str, Any] | None = None,
        *,
        bundle: str = "com.example.app",
        name: str = "Example",
        pid: int = 4242,
        allowed: tuple[str, ...] | None = None,
        permissions: dict[str, Any] | None = None,
    ) -> None:
        self.bundle = bundle
        self.name = name
        self.pid = pid
        self.permissions = permissions
        self.current = small_tree() if tree is None else tree
        self.window_title: str | None = "Main"
        self.window_rect: tuple[float, float, float, float] | None = (100.0, 50.0, 400.0, 300.0)
        self.locked = False
        self.settable = True
        self.focused_index: int | None = None
        self.secure_focus: bool | None = None  # live focused_is_secure verdict; None = live read unavailable
        self.window_id: int | None = None
        self.drift = False  # when True, live fingerprints mismatch the snapshot (stale refs)
        self.running: list[Any] = []
        self.running_error: BaseException | None = None
        self.launch_result: Any = None
        self.launch_calls: list[Any] = []
        self.frontmost: int | None = None  # the pid _frontmost_pid reports; None = unknown
        self.recorder = RecordingBackend()
        self.telemetry_recorder = TelemetryRecorder()
        self.attach = FakeAttach()
        self.ax_calls: list[tuple[str, Any, ...]] = []
        self.clipboard_calls: list[tuple[str, Any]] = []
        self.settings_tmp = tempfile.TemporaryDirectory()
        if allowed is None:
            allowed = (bundle,)
        self.settings_file = write_settings(self.settings_tmp.name, allowed=allowed)
        self._saved: list[tuple[Any, str, Any]] = []
        self._state_saved: dict[str, Any] = {}

    def set_tree(self, tree: dict[str, Any]) -> None:
        """Swap the UI tree served to the next observation."""
        self.current = tree

    async def get_app(self, spec: Any | None = None) -> Any:
        """Bind the canned app through the public get_app."""
        import computer_use

        return await computer_use.get_app(self.bundle if spec is None else spec)

    def _live_fingerprint(self, ref: Any) -> tuple[Any, Any]:
        if self.drift:
            return ("AXGhost", "changed since the snapshot")
        return (ref.get("role") if isinstance(ref, dict) else None,
                ref.get("title") if isinstance(ref, dict) else None)

    def _running_apps(self) -> list[Any]:
        if self.running_error is not None:
            raise self.running_error
        return list(self.running)

    def _launch(self, spec: Any) -> Any:
        self.launch_calls.append(spec)
        return self.launch_result

    def _activate(self, pid: int) -> None:
        """Fake apps._activate: record through the recorder, fail like the real seam for an absent pid."""
        from computer_use.errors import ComputerUseError

        if not any(app.pid == pid for app in self._running_apps()):
            raise ComputerUseError(
                "APP_NOT_RUNNING",
                "the app is no longer running; bind it again with get_app()",
                {"pid": pid},
            )
        self.recorder._activate(pid)

    def _frontmost_pid(self) -> int | None:
        """Fake apps._frontmost_pid: the configured pid, or None when unknown."""
        return self.frontmost

    def _save_clipboard(self) -> dict[str, Any]:
        self.clipboard_calls.append(("save", None))
        return {"string": "saved"}

    def _write_clipboard(self, text: str, format: str) -> None:
        self.clipboard_calls.append(("write", (format, text)))

    def _restore_clipboard(self, saved: dict[str, Any] | None) -> None:
        self.clipboard_calls.append(("restore", saved))

    def __enter__(self) -> AppEnvironment:
        import computer_use
        from computer_use import apps, ax, capture, inject, permissions, policy, telemetry
        from computer_use.apps import RunningApp

        def patch(module: Any, name: str, value: Any) -> None:
            self._saved.append((module, name, getattr(module, name)))
            setattr(module, name, value)

        if not self.running:
            self.running = [RunningApp(bundle_id=self.bundle, name=self.name, pid=self.pid, path=None)]
        if self.launch_result is None:
            self.launch_result = RunningApp(bundle_id=self.bundle, name=self.name, pid=self.pid, path=None)
        status = (
            {"accessibility": "ok", "screen_recording": "ok", "help": []}
            if self.permissions is None
            else self.permissions
        )
        patch(computer_use, "_backend", lambda: "mac")
        patch(computer_use, "_require_mac", _never_require_mac)
        patch(apps, "_running_apps", self._running_apps)
        patch(apps, "_launch", self._launch)
        patch(apps, "_activate", self._activate)
        patch(apps, "_frontmost_pid", self._frontmost_pid)
        patch(policy, "SETTINGS_PATH", self.settings_file)
        patch(policy, "_screen_locked", lambda: self.locked)
        patch(permissions, "_status", lambda: dict(status))
        patch(ax, "_observe", lambda pid: observation(self.current, self.window_title, self.window_rect, self.focused_index, self.window_id))
        patch(ax, "_live_fingerprint", self._live_fingerprint)
        patch(ax, "_focused_is_secure", lambda pid: self.secure_focus)
        patch(ax, "_perform_action", lambda ref, action: self.ax_calls.append(("perform_action", ref, action)))
        patch(ax, "_is_settable", lambda ref, attribute: self.settable)
        patch(ax, "_current_value", lambda ref: (ref.get("value") if isinstance(ref, dict) else None))
        patch(ax, "_set_value", lambda ref, value: self.ax_calls.append(("set_value", ref, value)))
        patch(ax, "_select_text_range", lambda ref, location, length: self.ax_calls.append(("select_text_range", ref, location, length)))
        patch(telemetry, "host_request", self.telemetry_recorder)
        patch(computer_use, "_save_clipboard", self._save_clipboard)
        patch(computer_use, "_write_clipboard", self._write_clipboard)
        patch(computer_use, "_restore_clipboard", self._restore_clipboard)
        modules = {"inject": inject, "capture": capture}
        seams = [("inject", seam) for seam in INJECT_SEAMS] + [("capture", "_screenshot_window")]
        for module_name, attr in seams:
            module = modules[module_name]
            if not hasattr(module, attr):
                raise AssertionError(f"test seam {module_name}.{attr} is missing from the package")
            if not hasattr(self.recorder, attr):
                raise AssertionError(f"RecordingBackend is missing the {attr} seam")
            patch(module, attr, getattr(self.recorder, attr))
        self.saved_attach_module = sys.modules.get("attach_image")
        attach_module = types.ModuleType("attach_image")
        attach_module.run = self.attach.run
        sys.modules["attach_image"] = attach_module
        for state_name in ("_session_started", "_bound_apps", "_instruction_shown"):
            self._state_saved[state_name] = getattr(computer_use, state_name)
        computer_use._session_started = False
        computer_use._bound_apps = {}
        computer_use._instruction_shown = set()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        import computer_use

        for module, name, value in reversed(self._saved):
            setattr(module, name, value)
        for state_name, value in self._state_saved.items():
            setattr(computer_use, state_name, value)
        if self.saved_attach_module is None:
            sys.modules.pop("attach_image", None)
        else:
            sys.modules["attach_image"] = self.saved_attach_module
        self.settings_tmp.cleanup()
