"""Prime Agent session-to-session messaging skill.

All routing and sender identity live in the TypeScript daemon. These functions
only call the host bridge exposed inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from IPython.display import display
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
    message_id: str | None = None,
    reply_to: str | None = None,
) -> dict[str, Any]:
    """Send one direct role-addressed message or broadcast to ``"all"``."""
    roles = ("parent", "sibling", "child")
    if message_id is not None and (not isinstance(message_id, str) or not message_id.strip()):
        raise ValueError("message_id must be a non-empty string")
    if reply_to is not None and (not isinstance(reply_to, str) or not reply_to.strip()):
        raise ValueError("reply_to must be a non-empty string")
    stable_id = message_id.strip() if message_id is not None else f"agentmsg_{uuid4()}"
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
            "id": stable_id,
            "reply_to": reply_to,
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
            "id": stable_id,
            "reply_to": reply_to,
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


def _optional_filter(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


async def inbox(
    *,
    limit: int = 20,
    consume: bool = False,
    sender: str | None = None,
    reply_to: str | None = None,
) -> dict[str, Any]:
    """Peek at or consume the oldest matching retained family messages."""
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer between 1 and 100")
    if not isinstance(consume, bool):
        raise TypeError("consume must be bool")
    return await host_request(
        "agent_message.inbox",
        {
            "limit": limit,
            "consume": consume,
            "sender": _optional_filter(sender, "sender"),
            "reply_to": _optional_filter(reply_to, "reply_to"),
        },
    )


async def wait(
    *,
    timeout: float = 30.0,
    sender: str | None = None,
    reply_to: str | None = None,
) -> dict[str, Any]:
    """Consume the oldest matching message, waiting event-first up to ``timeout`` seconds."""
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0 or timeout > 300:
        raise ValueError("timeout must be greater than 0 and at most 300 seconds")
    return await host_request(
        "agent_message.wait",
        {
            "timeout_ms": max(1, round(timeout * 1000)),
            "sender": _optional_filter(sender, "sender"),
            "reply_to": _optional_filter(reply_to, "reply_to"),
        },
    )


def _emit_sent_message(receipt: dict[str, Any], receiver_role: str | None = None) -> None:
    try:
        label = (
            "Agent message queued"
            if receipt.get("deliveryStatus") == "queued"
            else "Agent message sent"
        )
        display_receipt = dict(receipt)
        if receiver_role in ("parent", "sibling", "child"):
            display_receipt["receiverRole"] = receiver_role
        display(
            {
                _MESSAGE_DISPLAY_MIME: display_receipt,
                "text/plain": label,
            },
            raw=True,
        )
    except Exception:
        pass
