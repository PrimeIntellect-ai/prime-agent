"""The auto-backgrounding threshold: blocking usage past N milliseconds
degrades to non-blocking with a handle.

``PRIME_AGENT_AUTOBG_MS`` (default 10000; 0 disables both guards) is read per
call, so a cell can flip it live. Two surfaces share the knob:

- ``bash.py``: awaiting a ``BashHandle`` past the threshold returns early with
  the handle (the process keeps running; its completion notice still arrives).
- ``repl.py``: a cell executing past the threshold returns early with a future
  handle (the execution keeps running; the kernel's execution slot frees).
"""

from __future__ import annotations

import math
import os

ENV = "PRIME_AGENT_AUTOBG_MS"
DEFAULT_MS = 10_000.0


def threshold_seconds() -> float:
    """The auto-bg threshold in seconds; 0.0 turns both guards off.

    An unset, empty, unparsable, negative, or non-finite value falls back to
    the default: a broken knob never breaks a tool call (NaN would otherwise
    compare false everywhere and silently disable both guards).
    """
    raw = os.environ.get(ENV, "").strip()
    ms = DEFAULT_MS
    if raw:
        try:
            ms = float(raw)
        except ValueError:
            ms = DEFAULT_MS
        if not math.isfinite(ms) or ms < 0.0:
            ms = DEFAULT_MS
    return ms / 1000.0
