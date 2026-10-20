"""Error codes and the ComputerUseError exception for Prime Agent computer use."""

from __future__ import annotations

from typing import Any

CODES: dict[str, str] = {
    "APP_NOT_ALLOWED": "App not allowed",
    "PERMISSIONS_NOT_GRANTED": "Permissions not granted",
    "PERMISSIONS_PENDING": "Permissions pending",
    "SCREEN_LOCKED": "Screen locked",
    "USER_STOPPED": "User stopped",
    "ELEMENT_STALE": "Element stale",
    "AMBIGUOUS_APP": "Ambiguous app",
    "APP_NOT_RUNNING": "App not running",
    "APP_LAUNCH_FAILED": "App launch failed",
    "ACTION_UNSUPPORTED": "Action unsupported",
    "INJECTION_FAILED": "Injection failed",
    "TRANSPORT_ERROR": "Transport error",
    "INVALID_ARGUMENT": "Invalid argument",
}


class ComputerUseError(Exception):
    """One failed computer-use operation with a stable machine code.

    code is one of the frozen codes in CODES, name is the code's display name,
    message is the detailed human-readable text, and details optionally carries
    machine-readable context.
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        """Build the error for one frozen code, rejecting unknown codes."""
        if code not in CODES:
            raise ValueError(f"unknown computer-use error code: {code!r}")
        self.code = code
        self.name = CODES[code]
        self.message = message
        self.details = details
        super().__init__(code, message)

    def __str__(self) -> str:
        """Render as 'Name (CODE): message'."""
        return f"{self.name} ({self.code}): {self.message}"
