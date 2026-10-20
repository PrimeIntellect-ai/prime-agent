"""Platform dispatch and lazy macOS framework loading for computer use."""

from __future__ import annotations

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
    """Report the available backend: "mac" on darwin, otherwise None.

    macOS is the v1 platform; no other backend is advertised until its module
    ships, so get_state never reports a platform this skill cannot drive.
    """
    if sys.platform == "darwin":
        return "mac"
    return None


@cache
def _require_mac() -> MacFrameworks:
    """Import the Cocoa, Quartz, and ApplicationServices frameworks lazily.

    The frameworks load only on darwin and the result is cached per process.
    Raises ComputerUseError TRANSPORT_ERROR off darwin or when a framework is
    missing, naming the missing backend.
    """
    if sys.platform != "darwin":
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"computer use backend unavailable: the macOS frameworks need darwin, this host runs {sys.platform}",
        )
    try:
        cocoa = import_module("Cocoa")
        quartz = import_module("Quartz")
        app_services = import_module("ApplicationServices")
    except ImportError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"computer use backend unavailable: the macOS frameworks are not installed ({error})",
        ) from error
    return MacFrameworks(cocoa=cocoa, quartz=quartz, app_services=app_services)



