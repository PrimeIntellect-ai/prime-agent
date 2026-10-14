"""Best-effort adoption telemetry for Prime Agent computer use.

Events ride the kernel host bridge (the ``telemetry.emit`` host request) into
the versioned event catalog; hosts without the bridge no-op silently, and
telemetry never fails an action. Frozen events:

- ``computer_use_session_started`` with property ``platform``.
- ``computer_use_action`` with properties ``action``, ``outcome``, and
  ``duration_ms``.
"""

from __future__ import annotations

import asyncio
from typing import Any

try:
    from rlm import host_request
except ImportError:
    host_request = None

SESSION_STARTED = "computer_use_session_started"
ACTION = "computer_use_action"

MAX_NAME_CHARS = 64
MAX_PROPERTIES = 12
MAX_VALUE_CHARS = 64
BRIDGE_TIMEOUT_SECONDS = 0.5


async def _emit(name: str, **properties: Any) -> None:
    """Emit one telemetry event through the host bridge, best-effort and never raising.

    Drops the event when the bridge is absent or ``name`` is not a non-empty
    string of at most ``MAX_NAME_CHARS`` characters. Keeps at most the first
    ``MAX_PROPERTIES`` properties in call order, caps string values at
    ``MAX_VALUE_CHARS`` characters, and drops values that are not
    str/int/float/bool. The bridge wait is bounded by
    ``BRIDGE_TIMEOUT_SECONDS`` so a stalled host delays, but never hangs, the
    caller.
    """
    if host_request is None:
        return
    if not isinstance(name, str) or not name or len(name) > MAX_NAME_CHARS:
        return
    capped: dict[str, str | int | float | bool] = {}
    for key, value in properties.items():
        if len(capped) == MAX_PROPERTIES:
            break
        if isinstance(value, bool):
            capped[key] = value
        elif isinstance(value, str):
            capped[key] = value[:MAX_VALUE_CHARS]
        elif isinstance(value, (int, float)):
            capped[key] = value
    try:
        await asyncio.wait_for(
            host_request("telemetry.emit", {"name": name, "properties": capped}),
            timeout=BRIDGE_TIMEOUT_SECONDS,
        )
    except Exception:
        pass
