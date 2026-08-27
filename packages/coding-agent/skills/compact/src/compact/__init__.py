"""Prime Agent compact skill: context compaction control from the kernel.

Compaction runs host-side (the same implementation as /compact); these
functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent Python kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def status() -> dict[str, Any]:
    """Read current context usage.

    Returns a dict with `tokens`, `context_window`, `percent` (None right
    after a compaction until the next model response), and `scheduled`
    (whether a requested compaction is already pending for this turn).
    """
    return await host_request("compact.status")


async def run(instructions: str | None = None) -> dict[str, Any]:
    """Schedule context compaction.

    Compaction never runs mid-cell: it runs when the current turn ends and
    the harness resumes you automatically afterwards. Returns
    `{"scheduled": True}`, or `{"scheduled": False, "reason": ...}` when
    there is nothing to compact. Optional `instructions` focus the summary on
    what matters for the remaining work.
    """
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(f"instructions must be str or None, got {type(instructions).__name__}")
    payload: dict[str, Any] = {}
    if instructions is not None:
        payload["instructions"] = instructions
    return await host_request("compact.run", payload)
