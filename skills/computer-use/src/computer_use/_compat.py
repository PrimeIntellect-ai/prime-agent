"""Platform dispatch and lazy macOS framework loading for computer use."""

from __future__ import annotations

import shutil
import sys
from functools import cache
from importlib import import_module
from types import ModuleType
from typing import NamedTuple

from .errors import ComputerUseError


class MacFrameworks(NamedTuple):
    """The three macOS frameworks computer use drives."""

    cocoa: ModuleType
    quartz: ModuleType
    app_services: ModuleType


def _backend() -> str | None:
    """Report the available _backend: "mac" on darwin, "linux" when the xdotool
    tool is on PATH, otherwise None."""
    if sys.platform == "darwin":
        return "mac"
    if shutil.which("xdotool") is not None:
        return "linux"
    return None


@cache
def _require_mac() -> MacFrameworks:
    """Import the Cocoa, Quartz, and ApplicationServices frameworks lazily.

    The frameworks load only on darwin and the result is cached per process.
    Raises ComputerUseError TRANSPORT_ERROR off darwin or when a framework is
    missing, naming the missing _backend.
    """
    if sys.platform != "darwin":
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"computer use _backend unavailable: the macOS frameworks need darwin, this host runs {sys.platform}",
        )
    try:
        cocoa = import_module("Cocoa")
        quartz = import_module("Quartz")
        app_services = import_module("ApplicationServices")
    except ImportError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"computer use _backend unavailable: the macOS frameworks are not installed ({error})",
        ) from error
    return MacFrameworks(cocoa=cocoa, quartz=quartz, app_services=app_services)


def _require_linux() -> ModuleType:
    """Import the Linux X11 _backend module lazily for the Linux lane.

    Raises ComputerUseError TRANSPORT_ERROR when the X11 tools are missing or
    the _backend module has not shipped yet.
    """
    if _backend() != "linux":
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use _backend unavailable: the Linux _backend needs the xdotool tool on PATH",
        )
    try:
        from . import _linux
    except ImportError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "computer use _backend unavailable: the Linux _backend module is not installed yet",
        ) from error
    return _linux
