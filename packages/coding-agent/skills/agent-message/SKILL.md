---
name: agent-message
description: Message an agent's parent, siblings, or direct children through the daemon. Use the family roster to discover reachable agents and send direct text without spoofing sender identity.
---

# Agent Message

Send direct messages within the current agent's nuclear family through the
local daemon: parent, siblings, and direct children only. Roots are siblings.
The daemon derives your sender identity from the current session; do not try
to include a `from` field.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until this follow-up finishes so its result remains observable.
```

## Import

```python
import agent_message
```

## API Reference

```python
async def list_agents() -> dict
```
Returns `current` (`name`, `id`, `depth`) and family-scoped `entries` (each with
`relationship`, `name`, `id`, `depth`, `status`) for parent, siblings, and direct
children. Includes inactive family members. Does not expose a global daemon session
list.

---

```python
async def send(
    message: str,
    broadcast_message: str | None = None,
    *,
    receiver_role: "parent" | "sibling" | "child" | None = None,
    receiver_name: str | None = None,
) -> dict
```

**Direct message** (most common):
```python
receipt = await agent_message.send(
    "Please inspect the latest result.",
    receiver_role="child",
    receiver_name=child.session_name,
)
```
- `receiver_role`: required — `"parent"`, `"sibling"`, or `"child"`.
- `receiver_name`: required for `"sibling"` and `"child"`; must be omitted for `"parent"`.
- Returns a receipt dict with `deliveryStatus` (`"delivered"` or `"queued"`), plus
  `deliveredAt` or `queuedAt` depending on status. Messages always use steering
  delivery so a busy target sees them at the next tool boundary.

**Broadcast to all family members:**
```python
receipt = await agent_message.send("all", broadcast_message="Status check — please reply.")
```
- First arg must be the literal string `"all"`.
- `broadcast_message` carries the text to send.
- `receiver_role` and `receiver_name` must be omitted for broadcasts.
- Returns `{receipts: [...]}` in roster order; failed entries contain `id` and `error`.
  One failed delivery does not cancel successful ones.

**Functions that do NOT exist (common mistakes):**
- `agent_message.list_messages()` — does not exist; use `agent_observe.recent_messages()`.
- `agent_message.observe()` — does not exist; use the `agent-observe` skill.

## Safety

- Do not delete a child immediately after `send`: delivered follow-ups may still
  be running and queued receipts have not run yet. Wait until observation shows
  the child is idle and its context is no longer needed before calling
  `await rlm.delete_subagent(child)`.
- Reach is limited to parent, siblings, and direct children; relay through an
  intermediate child instead of messaging grandchildren or cousins directly.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message size, rate, and pending-queue limits before
  accepting delivery.
