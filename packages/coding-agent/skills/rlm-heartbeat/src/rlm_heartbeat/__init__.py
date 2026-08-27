"""Prime Agent RLM heartbeat skill: internal recurring session checks.

All heartbeat state lives in the TypeScript host; these functions are thin
typed wrappers over the generic host bridge (`rlm.host_request`). They only
work inside the Prime Agent Python kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

StatusUpdate = Literal["pause", "resume"]
DeliveryMode = Literal["steer", "follow_up"]


def _normalize_delivery_mode(delivery_mode: DeliveryMode | None) -> str | None:
    if delivery_mode is None:
        return None
    if not isinstance(delivery_mode, str):
        raise TypeError(f"delivery_mode must be str or None, got {type(delivery_mode).__name__}")
    if delivery_mode not in {"steer", "follow_up"}:
        raise ValueError('delivery_mode must be "steer", "follow_up", or None')
    return delivery_mode


async def list(include_inactive: bool = False) -> dict[str, Any]:
    """List internal RLM heartbeats for the current agent session."""
    if not isinstance(include_inactive, bool):
        raise TypeError(f"include_inactive must be bool, got {type(include_inactive).__name__}")
    return await host_request("rlm_heartbeat.list", {"include_inactive": include_inactive})


async def create(
    instruction: str,
    interval: str | None = None,
    label: str | None = None,
    delivery_mode: DeliveryMode | None = None,
) -> dict[str, Any]:
    """Create an internal recurring heartbeat for the current agent session.

    delivery_mode controls how the scheduled prompt is delivered when the
    session is busy: "steer" (default) interrupts the current turn, "follow_up"
    waits for it to finish.
    """
    if not isinstance(instruction, str):
        raise TypeError(f"instruction must be str, got {type(instruction).__name__}")
    payload: dict[str, Any] = {"instruction": instruction}
    if interval is not None:
        if not isinstance(interval, str):
            raise TypeError(f"interval must be str or None, got {type(interval).__name__}")
        payload["interval"] = interval
    if label is not None:
        if not isinstance(label, str):
            raise TypeError(f"label must be str or None, got {type(label).__name__}")
        payload["label"] = label
    normalized_delivery_mode = _normalize_delivery_mode(delivery_mode)
    if normalized_delivery_mode is not None:
        payload["delivery_mode"] = normalized_delivery_mode
    return await host_request("rlm_heartbeat.create", payload)


async def update(
    id: str,
    instruction: str | None = None,
    interval: str | None = None,
    label: str | None = None,
    status: StatusUpdate | None = None,
    delivery_mode: DeliveryMode | None = None,
) -> dict[str, Any]:
    """Update one internal RLM heartbeat for the current agent session."""
    if not isinstance(id, str):
        raise TypeError(f"id must be str, got {type(id).__name__}")
    payload: dict[str, Any] = {"id": id}
    if instruction is not None:
        if not isinstance(instruction, str):
            raise TypeError(f"instruction must be str or None, got {type(instruction).__name__}")
        payload["instruction"] = instruction
    if interval is not None:
        if not isinstance(interval, str):
            raise TypeError(f"interval must be str or None, got {type(interval).__name__}")
        payload["interval"] = interval
    if label is not None:
        if not isinstance(label, str):
            raise TypeError(f"label must be str or None, got {type(label).__name__}")
        payload["label"] = label
    if status is not None:
        if status not in {"pause", "resume"}:
            raise ValueError('status must be "pause", "resume", or None')
        payload["status"] = status
    normalized_delivery_mode = _normalize_delivery_mode(delivery_mode)
    if normalized_delivery_mode is not None:
        payload["delivery_mode"] = normalized_delivery_mode
    return await host_request("rlm_heartbeat.update", payload)


async def delete(id: str) -> dict[str, Any]:
    """Cancel one internal RLM heartbeat for the current agent session."""
    if not isinstance(id, str):
        raise TypeError(f"id must be str, got {type(id).__name__}")
    return await host_request("rlm_heartbeat.delete", {"id": id})
