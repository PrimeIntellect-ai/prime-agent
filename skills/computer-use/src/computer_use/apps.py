"""App discovery, binding, and launch for macOS apps."""

from __future__ import annotations

import plistlib
import subprocess
from xml.parsers import expat
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
            "computer use backend unavailable: listing apps needs the macOS workspace",
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

    Queries mdfind without launching anything and reads the bundle id from
    the results' Info.plist. Returns None when the name cannot be resolved;
    raises ComputerUseError AMBIGUOUS_APP when several distinct installed
    bundles share the display name (bind by bundle id instead).
    """
    if not isinstance(name, str) or not name.strip():
        return None
    escaped = _escape_spotlight(name)
    query = (
        'kMDItemContentTypeTree == "com.apple.application" '
        f'&& kMDItemDisplayName == "{escaped}"'
    )
    try:
        finished = subprocess.run(
            ["mdfind", query], capture_output=True, text=True, timeout=_MDFIND_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if finished.returncode != 0:
        return None
    bundle_ids: list[str] = []
    for path in finished.stdout.splitlines()[:_MDFIND_RESULT_CAP]:
        bundle_id = _bundle_id_for_bundle_dir(path.strip())
        if bundle_id and bundle_id not in bundle_ids:
            bundle_ids.append(bundle_id)
            if len(bundle_ids) > 1:
                raise ComputerUseError(
                    "AMBIGUOUS_APP",
                    f"the name {name!r} matches several installed apps ("
                    + ", ".join(bundle_ids)
                    + "); call get_app with the bundle_id of the one you want",
                    {"bundle_ids": bundle_ids},
                )
    return bundle_ids[0] if bundle_ids else None


def _escape_spotlight(value: str) -> str:
    """Escape one Spotlight query metacharacter from a literal display name.

    `*`, `?`, backslashes, and quotes are predicate syntax in the query
    language; a literal name must not carry them through unescaped.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("*", "\\*").replace("?", "\\?")


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
    """Open the app the resolved spec names and wait for it to start running.

    The spec is the one-key dict the gate resolved — binding always launches
    the already-gated bundle id, never a raw name or path. Raises
    ComputerUseError APP_LAUNCH_FAILED when the open command fails and
    APP_NOT_RUNNING when the app does not appear in time.
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
    """Build the open command for one resolved app spec (a one-key dict).

    Binding always launches the already-resolved bundle id, so no string
    heuristic runs here: a display name with a period ("Acme 1.0") can never
    be mistaken for a bundle id at launch time.
    """
    kind, value = _spec_value(spec)
    if kind == "bundle_id":
        return ["open", "-b", value]
    if kind == "name":
        return ["open", "-a", value]
    return ["open", value]


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
    """Normalize one resolved spec into its launch-match kind and value."""
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
            {"keys": sorted(spec, key=str)},
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
    except (OSError, plistlib.InvalidFileException, expat.ExpatError):
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
