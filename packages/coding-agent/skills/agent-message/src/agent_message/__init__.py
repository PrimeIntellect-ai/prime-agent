"""Prime Agent session-to-session messaging skill.

All routing and sender identity live in the TypeScript daemon. These functions
only call the host bridge exposed inside the Prime Agent kernel.
"""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

ReceiverRole = Literal["parent", "sibling", "child"]
_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json"


async def list_agents() -> dict[str, Any]:
    """List this agent's parent, siblings, and children, including inactive family."""
    return await host_request("agent_message.list_agents")


async def send(
    message: str,
    broadcast_message: str | None = None,
    *,
    receiver_role: ReceiverRole | str | None = None,
    receiver_name: str | None = None,
) -> dict[str, Any]:
    """Send one direct role-addressed message or broadcast to ``"all"``."""
    roles = ("parent", "sibling", "child")
    if broadcast_message is not None:
        if message != "all":
            raise TypeError(
                "positional agent_message.send targets are not supported; "
                "use receiver_role and receiver_name"
            )
        if receiver_role is not None or receiver_name is not None:
            raise TypeError("broadcast cannot be combined with receiver_role/receiver_name")
        payload: dict[str, Any] = {
            "target": "all",
            "message": broadcast_message,
        }
    else:
        if receiver_role not in roles:
            raise ValueError('receiver_role must be "parent", "sibling", or "child"')
        if not isinstance(message, str):
            raise TypeError(f"message must be str, got {type(message).__name__}")
        if receiver_role == "parent":
            if receiver_name is not None:
                raise ValueError("receiver_name must be omitted for parent messages")
        elif not isinstance(receiver_name, str) or not receiver_name.strip():
            raise ValueError("receiver_name is required for sibling and child messages")
        payload = {
            "message": message,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
        }
    receipt = await host_request("agent_message.send", payload)
    receipts = receipt.get("receipts") if isinstance(receipt, dict) else None
    if isinstance(receipts, list):
        for item in receipts:
            if isinstance(item, dict) and "deliveryStatus" in item:
                _emit_sent_message(item)
    else:
        _emit_sent_message(receipt, receiver_role)
    return receipt


def _emit_sent_message(receipt: dict[str, Any], receiver_role: str | None = None) -> None:
    try:
        from rlm import emit

        label = (
            "Agent message queued"
            if receipt.get("deliveryStatus") == "queued"
            else "Agent message sent"
        )
        display_receipt = dict(receipt)
        if receiver_role in ("parent", "sibling", "child"):
            display_receipt["receiverRole"] = receiver_role
        emit(
            {
                _MESSAGE_DISPLAY_MIME: display_receipt,
                "text/plain": label,
            }
        )
    except Exception:
        pass
