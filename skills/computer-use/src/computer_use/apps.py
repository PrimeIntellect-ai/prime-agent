"""App discovery, binding, and _launch for macOS apps."""

from __future__ import annotations

import plistlib
import subprocess
import time
from pathlib import Path
from typing import Any, NamedTuple

from ._compat import _backend, _require_mac
from .errors import ComputerUseError

_OPEN_TIMEOUT_SECONDS = 10.0
_APPEAR_TIMEOUT_SECONDS = 15.0
_APPEAR_POLL_SECONDS = 0.25
_MDFIND_TIMEOUT_SECONDS = 5.0
_MDFIND_RESULT_CAP = 5
_ERROR_LIMIT = 200


class RunningApp(NamedTuple):
    """One running app process addressable by computer use."""

    bundle_id: str
    name: str
    pid: int
    path: str | None


def _list_apps() -> list[dict[str, Any]]:
    """List the running regular apps as {"id", "name", "running"} dicts."""
    return [
        {"id": app.bundle_id, "name": app.name, "running": True}
        for app in _running_apps()
    ]


def _running_apps() -> list[RunningApp]:
    """Read the running regular apps through NSWorkspace."""
    if _backend() != "mac":
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use _backend unavailable: listing apps needs the macOS workspace",
        )
    cocoa = _require_mac().cocoa
    apps: list[RunningApp] = []
    for application in cocoa.NSWorkspace.sharedWorkspace().runningApplications():
        if application.activationPolicy() != cocoa.NSApplicationActivationPolicyRegular:
            continue
        bundle_id = application.bundleIdentifier() or ""
        if not bundle_id:
            continue
        apps.append(
            RunningApp(
                bundle_id=bundle_id,
                name=application.localizedName() or bundle_id,
                pid=application.processIdentifier(),
                path=_bundle_path(application),
            )
        )
    return apps


def _frontmost_pid() -> int | None:
    """The frontmost regular app's pid, or None when unknown."""
    from computer_use import _compat

    cocoa = _compat._require_mac().cocoa
    frontmost = cocoa.NSWorkspace.sharedWorkspace().frontmostApplication()
    return int(frontmost.processIdentifier()) if frontmost is not None else None


def _activate(pid: int) -> None:
    """Make one running app key (its frontmost window takes the foreground)."""
    from computer_use import _compat

    cocoa = _compat._require_mac().cocoa
    for application in cocoa.NSWorkspace.sharedWorkspace().runningApplications():
        if application.processIdentifier() == pid:
            application.activateWithOptions_(cocoa.NSApplicationActivateIgnoringOtherApps)
            return
    raise ComputerUseError(
        "APP_NOT_RUNNING",
        "the app is no longer running; bind it again with get_app()",
        {"pid": pid},
    )


def _running_bundle_id(pid: int) -> str | None:
    """Report the bundle id currently owning one pid, or None when it is not a running app.

    Guards against pid reuse: a bound app's pid may now belong to a different
    process or nothing at all.
    """
    for app in _running_apps():
        if app.pid == pid:
            return app.bundle_id
    return None


def _bundle_for_name(name: str) -> str | None:
    """Resolve an installed app's bundle id by display name through Spotlight.

    Queries mdfind without launching anything, caps the results, and reads the
    bundle id from the first result's Info.plist. Returns None when the name
    cannot be resolved to an installed bundle.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    query = (
        'kMDItemContentTypeTree == "com.apple.application" '
        f'&& kMDItemDisplayName == "{name}"'
    )
    try:
        finished = subprocess.run(
            ["mdfind", query], capture_output=True, text=True, timeout=_MDFIND_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if finished.returncode != 0:
        return None
    for path in finished.stdout.splitlines()[:_MDFIND_RESULT_CAP]:
        bundle_id = _bundle_id_for_bundle_dir(path.strip())
        if bundle_id:
            return bundle_id
    return None


def _resolve(spec: str | dict[str, str]) -> list[RunningApp]:
    """Match one app spec against the running apps.

    A string matches a bundle id exactly or an app name case-insensitively; a
    dict matches the one key it carries among bundle_id, name, and path.
    Raises ComputerUseError INVALID_ARGUMENT for a bad spec and TRANSPORT_ERROR
    off darwin.
    """
    if isinstance(spec, str):
        if not spec.strip():
            raise ComputerUseError("INVALID_ARGUMENT", "the app spec must not be empty", {"spec": ""})
        wanted = spec.casefold()
        return [
            app
            for app in _running_apps()
            if app.bundle_id == spec or app.name.casefold() == wanted
        ]
    kind, value = _spec_value(spec)
    if kind == "bundle_id":
        return [app for app in _running_apps() if app.bundle_id == value]
    if kind == "name":
        return [app for app in _running_apps() if app.name.casefold() == value.casefold()]
    return [app for app in _running_apps() if _same_path(app.path, value)]


def _launch(spec: str | dict[str, str]) -> RunningApp:
    """Open the app the spec names and wait for it to start running.

    A string spec containing a dot launches by bundle id with open -b, any
    other string launches by name with open -a, and a dict launches through
    its one key. Raises ComputerUseError APP_LAUNCH_FAILED when the open
    command fails and APP_NOT_RUNNING when the app does not appear in time.
    """
    command = _open_command(spec)
    try:
        finished = subprocess.run(command, capture_output=True, text=True, timeout=_OPEN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise ComputerUseError(
            "APP_LAUNCH_FAILED",
            f"open timed out after {int(_OPEN_TIMEOUT_SECONDS)} seconds for {command[-1]}",
        ) from error
    except OSError as error:
        raise ComputerUseError(
            "APP_LAUNCH_FAILED",
            f"open is not available: {str(error)[:_ERROR_LIMIT]}",
        ) from error
    if finished.returncode != 0:
        reason = (finished.stderr or finished.stdout).strip()
        raise ComputerUseError(
            "APP_LAUNCH_FAILED",
            f"open failed for {command[-1]}: {reason[:_ERROR_LIMIT]}",
            {"command": " ".join(command)[:_ERROR_LIMIT]},
        )
    return _await_running(spec)


def _open_command(spec: str | dict[str, str]) -> list[str]:
    """Build the open command for one app spec."""
    if isinstance(spec, str):
        value = spec
        kind = "bundle_id" if "." in spec else "name"
    else:
        kind, value = _spec_value(spec)
    # -g launches the app in the background: the agent binds and observes
    # without stealing the user's screen; only an explicit App.activate()
    # brings it forward, and keyboard flows announce that takeover.
    if kind == "bundle_id":
        return ["open", "-g", "-b", value]
    if kind == "name":
        return ["open", "-g", "-a", value]
    return ["open", "-g", value]


def _await_running(spec: str | dict[str, str]) -> RunningApp:
    """Poll the running apps until the launched one appears, or raise APP_NOT_RUNNING."""
    key, value = _launch_target(spec)
    deadline = time.monotonic() + _APPEAR_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        for app in _running_apps():
            if _launch_match(key, value, app):
                return app
        time.sleep(_APPEAR_POLL_SECONDS)
    raise ComputerUseError(
        "APP_NOT_RUNNING",
        f"{value} did not start within {int(_APPEAR_TIMEOUT_SECONDS)} seconds; call get_app again once it is running",
        {"spec": str(spec)[:_ERROR_LIMIT]},
    )


def _launch_target(spec: str | dict[str, str]) -> tuple[str, str]:
    """Normalize one spec into its _launch-match kind and value."""
    if isinstance(spec, str):
        return ("bundle_id", spec) if "." in spec else ("name", spec)
    return _spec_value(spec)


def _launch_match(key: str, value: str, app: RunningApp) -> bool:
    """Report whether one running app is the one the spec launched."""
    if key == "bundle_id":
        return app.bundle_id == value
    if key == "name":
        return app.name.casefold() == value.casefold()
    return _same_path(app.path, value)


def _spec_value(spec: str | dict[str, str]) -> tuple[str, str]:
    """Validate one dict app spec into a (kind, value) pair."""
    if not isinstance(spec, dict):
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"the app spec must be a string or a dict, got {type(spec).__name__}",
            {"spec": type(spec).__name__},
        )
    kinds = [key for key in ("bundle_id", "name", "path") if key in spec]
    if len(kinds) != 1:
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            "a dict app spec must carry exactly one of bundle_id, name, or path",
            {"keys": sorted(spec)},
        )
    kind = kinds[0]
    value = spec[kind]
    if not isinstance(value, str) or not value.strip():
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"{kind} must be a non-empty string",
            {"kind": kind},
        )
    return kind, value


def _bundle_id_for_bundle_dir(path: str) -> str | None:
    """Read an app bundle directory's identifier from its Info.plist."""
    info = Path(path).expanduser() / "Contents" / "Info.plist"
    try:
        with info.open("rb") as handle:
            plist = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException):
        return None
    bundle_id = plist.get("CFBundleIdentifier") if isinstance(plist, dict) else None
    return bundle_id if isinstance(bundle_id, str) and bundle_id else None


def _same_path(running_path: str | None, spec_path: str) -> bool:
    """Compare two filesystem paths canonically."""
    if not running_path:
        return False
    try:
        return Path(running_path).resolve() == Path(spec_path).expanduser().resolve()
    except OSError:
        return False


def _bundle_path(application: Any) -> str | None:
    """Read one running app's bundle path."""
    url = application.bundleURL()
    if url is None:
        return None
    path = url.path()
    return str(path) if path else None
