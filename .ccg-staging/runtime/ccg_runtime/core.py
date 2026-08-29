"""Framework-neutral staged admission and selection for task governance."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping

SUPPORTED_REQUESTS = frozenset(("goal-task", "goal-dispatch", "goal-execute"))
DEFAULT_SELECTOR = "default"
ROLLBACK_SELECTOR = "rollback"


class ConfigurationError(ValueError):
    """Raised when a selector configuration is not safe to use."""


def initial_config() -> dict[str, Any]:
    return {
        "version": 1,
        "enabled": False,
        "selectors": {
            DEFAULT_SELECTOR: "ccg",
            ROLLBACK_SELECTOR: "legacy",
        },
    }


def _write_atomic(path: Path, document: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(document, sort_keys=True, indent=2) + "\n").encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def load_config(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"cannot load CCG configuration: {error}") from error
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ConfigurationError("unsupported CCG configuration")
    if not isinstance(document.get("enabled"), bool):
        raise ConfigurationError("CCG enabled must be boolean")
    selectors = document.get("selectors")
    expected = {DEFAULT_SELECTOR: "ccg", ROLLBACK_SELECTOR: "legacy"}
    if selectors != expected:
        raise ConfigurationError("configuration must contain exactly default=ccg and rollback=legacy selectors")
    return document


class CcgRouter:
    """The sole core entrypoint for supported task-governance requests.

    The core stages a request; adapters may execute their framework-specific
    behavior only after this route has accepted it.
    """

    def __init__(self, config_path: str | Path):
        self.config_path = Path(config_path)

    @classmethod
    def initialise(cls, config_path: str | Path) -> "CcgRouter":
        path = Path(config_path)
        _write_atomic(path, initial_config())
        return cls(path)

    def set_enabled(self, enabled: bool) -> dict[str, Any]:
        configuration = load_config(self.config_path)
        updated = dict(configuration)
        updated["enabled"] = enabled
        _write_atomic(self.config_path, updated)
        return updated

    def route(self, request: str, selector: str = DEFAULT_SELECTOR) -> dict[str, Any]:
        if request.startswith("legacy:"):
            return _rejected("RAW_LEGACY_BYPASS_REJECTED", request, selector)
        if request not in SUPPORTED_REQUESTS:
            return _rejected("UNSUPPORTED_REQUEST", request, selector)
        if selector not in (DEFAULT_SELECTOR, ROLLBACK_SELECTOR):
            return _rejected("UNKNOWN_SELECTOR", request, selector)
        try:
            configuration = load_config(self.config_path)
        except ConfigurationError as error:
            return _rejected("INVALID_CONFIGURATION", request, selector, detail=str(error))
        if selector == ROLLBACK_SELECTOR:
            return {
                "accepted": True,
                "adapter": configuration["selectors"][ROLLBACK_SELECTOR],
                "request": request,
                "route": ROLLBACK_SELECTOR,
                "selector": ROLLBACK_SELECTOR,
                "stages": [{"name": "admission", "status": "explicit_rollback"}],
            }
        if not configuration["enabled"]:
            return _rejected("CCG_DISABLED", request, selector)
        return {
            "accepted": True,
            "request": request,
            "route": "ccg",
            "selector": DEFAULT_SELECTOR,
            "stages": [
                {"name": "admission", "status": "accepted_staged"},
                {"name": "dispatch", "status": "staged"},
                {"name": "runtime", "status": "staged"},
                {"name": "terminal", "status": "pending"},
            ],
        }


def _rejected(code: str, request: str, selector: str, detail: str | None = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "accepted": False,
        "code": code,
        "request": request,
        "selector": selector,
    }
    if detail:
        response["detail"] = detail
    return response
