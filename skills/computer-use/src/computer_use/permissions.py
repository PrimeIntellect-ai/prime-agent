"""Accessibility and screen-recording permission probes with user guidance.

macOS TCC grants are user-only: this module checks both grants without ever
prompting and reports the exact System Settings paths when they are missing.
Probe callables are injectable so the mapping logic is testable without
touching the live TCC state.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Literal, TypedDict

PermissionState = Literal["ok", "missing", "unknown"]
Probe = Callable[[], bool | None]


class Status(TypedDict):
    """The permissions snapshot surfaced by the computer-use API."""

    accessibility: PermissionState
    screen_recording: PermissionState
    help: list[str]


HELP_LINES: tuple[str, ...] = (
    "System Settings > Privacy & Security > Accessibility: add Prime Agent "
    "(app control and input).",
    "System Settings > Privacy & Security > Screen Recording: add Prime Agent (window capture).",
    "Prime Agent needs both grants.",
    "Call get_state() to re-check; restart Prime Agent if a fresh Screen "
    "Recording grant does not take effect.",
)


def _ax_probe() -> bool | None:
    """Read the accessibility trust state with prompting disabled; ``None`` when unknown."""
    if sys.platform != "darwin":
        return None
    try:
        import ApplicationServices

        options = {ApplicationServices.kAXTrustedCheckOptionPrompt: False}
        return bool(ApplicationServices.AXIsProcessTrustedWithOptions(options))
    except Exception:
        return None


def _screen_probe() -> bool | None:
    """Read the screen-recording preflight state; ``None`` when unknown.

    The preflight call never prompts; ``CGRequestScreenCaptureAccess`` is
    deliberately never used because it prompts the user.
    """
    if sys.platform != "darwin":
        return None
    try:
        import Quartz

        return bool(Quartz.CGPreflightScreenCaptureAccess())
    except Exception:
        return None


def _state_from_probe(result: bool | None) -> PermissionState:
    """Map one probe result to its permission state."""
    if result is None:
        return "unknown"
    return "ok" if result else "missing"


def _status(ax_probe: Probe = _ax_probe, screen_probe: Probe = _screen_probe) -> Status:
    """Report both TCC grants plus the guidance lines, with injectable probes."""
    return Status(
        accessibility=_state_from_probe(ax_probe()),
        screen_recording=_state_from_probe(screen_probe()),
        help=list(HELP_LINES),
    )
