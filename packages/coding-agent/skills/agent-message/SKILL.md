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

## API

- `await agent_message.list_agents()` — returns `current` (`name`, `id`, `depth`)
  and family-scoped `entries` (`relationship`, `name`, `id`, `depth`, `status`)
  for the current agent's parent, siblings, and children. It includes inactive
  family members and sorts parent, siblings by name, then children by name; it
  does not expose a global daemon session list. Child entries additionally carry
  `repliedSinceTask` (see below).
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None)` — sends one direct
  text message to an active session. Sending to an idle completed subagent
  starts an ordinary follow-up turn in that same child session and context.
  The child remains available only until its parent session closes. The daemon
  resolves `receiver_role` within the current agent family; `receiver_name` is
  required for siblings and children and omitted for the unique parent.
  `send("all", message)` broadcasts only to the family roster and returns
  `{receipts: [...]}` in roster order; successful entries are ordinary receipts
  and failed entries contain the target id and a short `error`. One failed delivery
  does not reject successful deliveries. Messages always use steering delivery so
  a busy target sees them during its active run. Returns a receipt with a
  `deliveryStatus` field: `"delivered"` means the message reached an idle target's
  context; `"queued"` means a steering message was accepted and will deliver when
  the target's current work allows (`send` does not block waiting for that).
  Delivered receipts carry `deliveredAt`, queued receipts carry `queuedAt`.

## Reading `repliedSinceTask`

Child rows in `list_agents()` report `repliedSinceTask`, and it has three states,
not two:

| Value | Meaning |
|---|---|
| `True` | The child has sent a message addressed to you since your last message to it. |
| `False` | The child has not replied since your last message to it. |
| `None` (key absent) | Unknown — the daemon cannot read that child's live session right now. |

Unknown is reported by omitting the key, so `entry.get("repliedSinceTask")`
returns `None`. It is not a synonym for "has not replied": a child that is not
resident (passive, evicted, or resumed in a new process whose reply history
predates it) reports unknown even if it did reply. Code that treats a falsy value
as "still working" will wait forever on a child that already answered, which is
why the same child can look like `True` on one poll and "not replied" on the
next — the child was evicted between the two, not reset.

```python
roster = await agent_message.list_agents()
for entry in roster["entries"]:
    if entry["relationship"] != "child":
        continue
    replied = entry.get("repliedSinceTask")
    if replied is None:
        pass          # unknown: fall back to agent_observe or the child's output
    elif replied:
        pass          # answered since your last message
    else:
        pass          # genuinely still owes you a reply
```

This flag answers "has it replied since I last wrote to it", not "is it done".
A child that writes an output file without messaging you reports `False`
forever; pair it with `agent_observe.get_agent(name)` (`status`, and the
in-flight tool-call fields) or an agreed output artifact when you need
completion rather than acknowledgement.

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
