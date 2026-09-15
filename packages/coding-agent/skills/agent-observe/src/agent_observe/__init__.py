"""Read-only Prime Agent session observation skill.

All session lookup and data access live in the TypeScript daemon. These
functions only call the host bridge exposed inside the Prime Agent Python
kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def list_agents(recursive: bool = False) -> dict[str, Any]:
    """List the family roster: parent, siblings, children, active or not.

    With ``recursive=True`` the roster also includes every descendant below
    direct children as read-only ``descendant`` rows, breadth-first by name.
    Discovery only: a descendant grants no extra reach, and messaging still
    relays through its parent.
    """
    if not isinstance(recursive, bool):
        raise TypeError(f"recursive must be bool, got {type(recursive).__name__}")
    return await host_request("agent_observe.list", {"recursive": recursive})


async def get_agent(target: str) -> dict[str, Any]:
    """Read one live session summary by active id, session id/name, or suffix."""
    if not isinstance(target, str):
        raise TypeError(f"target must be str, got {type(target).__name__}")
    return await host_request("agent_observe.get", {"target": target})


async def recent_messages(
    target: str,
    limit: int = 8,
    max_chars: int = 800,
) -> dict[str, Any]:
    """Read bounded recent message previews from an active session.

    Args:
        target: Active session id, session id/name, or unambiguous suffix.
        limit: Number of recent messages to return. Host validates 1-50.
        max_chars: Per-message preview size. Host validates 80-2000.
    """
    if not isinstance(target, str):
        raise TypeError(f"target must be str, got {type(target).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    if not isinstance(max_chars, int):
        raise TypeError(f"max_chars must be int, got {type(max_chars).__name__}")
    return await host_request(
        "agent_observe.recent",
        {
            "target": target,
            "limit": limit,
            "max_chars": max_chars,
        },
    )
