"""Prime Agent system-router skill: System 1 action loops from the kernel.

The step loop runs host-side (environment adapter, decision model calls with
thinking disabled, confidence gating, trace); this module is a thin typed
wrapper over the generic host bridge (`rlm.host_request`). It only works
inside the Prime Agent Python kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def run(spec: dict[str, Any]) -> dict[str, Any]:
    """Run one bounded System 1 segment and return the full trace.

    ``spec`` declares the goal, the environment (a stdio adapter command plus
    an optional init payload), optionally the finite action space (the
    adapter's defaults are used when omitted), and optionally the action
    model selector, step/time budgets, and confidence gates. The returned
    dict carries ``status``, ``reason``, ``trace``, ``summary``, and
    ``usage`` for System 2 review.
    """
    if not isinstance(spec, dict):
        raise TypeError(f"spec must be dict, got {type(spec).__name__}")
    return await host_request("system_router.run", spec)
