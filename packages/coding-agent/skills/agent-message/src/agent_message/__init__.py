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
    *,
    receiver_role: ReceiverRole | str | None = None,
    receiver_name: str | None = None,
) -> dict[str, Any]:
    """Send one direct role-addressed message to a family member."""
    if receiver_role not in ("parent", "sibling", "child"):
        raise ValueError('receiver_role must be "parent", "sibling", or "child"')
    if not isinstance(message, str):
        raise TypeError(f"message must be str, got {type(message).__name__}")
    if receiver_role == "parent":
        if receiver_name is not None:
            raise ValueError("receiver_name must be omitted for parent messages")
    elif not isinstance(receiver_name, str) or not receiver_name.strip():
        raise ValueError("receiver_name is required for sibling and child messages")
    receipt = await host_request(
        "agent_message.send",
        {
            "message": message,
            "receiver_role": receiver_role,
            "receiver_name": receiver_name,
        },
    )
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
