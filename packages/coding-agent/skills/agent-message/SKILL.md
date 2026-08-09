---
name: agent-message
description: Send direct messages to an agent's parent, siblings, or direct children through the daemon. Use to discover reachable agents, deliver task results or follow-ups, and correlate replies. The daemon supplies sender identity.
---

# Agent Message

Send direct text messages through the local daemon to the current agent's
parent, siblings, or direct children. Root agents are siblings. The daemon
derives the sender identity from the current session, so callers do not supply
a `from` field.

Call directly from the IPython kernel:

```python
children = await rlm.list_subagents()
child = next(iter(children), None)
if child is not None:
    receipt = await agent_message.send(
        "Please inspect the latest result.",
        receiver_role="child",
        receiver_name=child.session_name,
    )
    # Keep the child until the follow-up finishes and its result is collected.
```

`rlm.list_subagents()` returns direct-child registry entries. Use
`child.session_name` when addressing one of those entries. A spawn handle
returned by `await rlm(...)` is a different object and uses `handle.name`.

## API

- `await agent_message.list_agents()` returns `current` (`name`, `id`, `depth`)
  and reachable `entries` (`relationship`, `name`, `id`, `depth`, `status`) for
  the current agent's parent, siblings, and children. It includes inactive
  reachable agents and sorts the parent first, then siblings by name, then
  children by name. It does not expose a global daemon session list.
- `await agent_message.send(message, receiver_role="parent" | "sibling" | "child", receiver_name=None, message_id=None, reply_to=None)` sends one direct
  text message to an active or retained daemon-backed session. `receiver_name` is required for siblings
  and children and omitted for the unique parent. Sending to an idle completed
  daemon-backed child starts an ordinary follow-up turn in the retained child
  session and context. The child remains available until its parent session
  closes.
- `send("all", message)` broadcasts only to the reachable-agent roster and
  returns `{receipts: [...]}` in roster order. Successful entries are ordinary
  receipts. Failed entries contain the target id and a short `error`. A failed
  delivery does not reject successful deliveries.
- Messages use steering delivery. A busy target receives the message when its
  current work permits. `send` does not wait for that delivery. A receipt's
  `deliveryStatus` is `"delivered"` when the message reached an idle target's
  context and `"queued"` when the steering message was accepted for later
  delivery. Delivered receipts carry `deliveredAt`; queued receipts carry
  `queuedAt`.
- Every send creates a stable source ID before routing. Pass `message_id` when
  retrying the same acceptance and `reply_to` when correlating a response.
  Durable receipts add `acceptedAt`, `targetSequence`, and `handoff` without
  changing the status union.
- `await agent_message.inbox(limit=20, consume=False, sender=None, reply_to=None)`
  returns up to 100 retained messages in target-local oldest-first order. The
  default peeks. `consume=True` appends consumption before returning rows.
- `await agent_message.wait(timeout=30, sender=None, reply_to=None)` consumes the
  oldest retained match or waits event-first for a future match. `timeout` is in
  seconds, must be positive, and is capped at 300. Timeout returns no message.
  Interruption, communication close, session passivation, and shutdown cancel
  the wait.

## Boundaries

- Reach is limited to the parent, siblings, and direct children. Communicate
  with a deeper descendant through the intermediate child.
- Sender identity is daemon-derived and cannot be spoofed from Python.
- The daemon enforces message-size, rate, and pending-queue limits before
  accepting delivery.
- Do not delete a child immediately after sending a follow-up. Delivered work
  may still be running, and queued work has not run yet. After observation shows
  the child is idle and its context is no longer needed, pass the recovered
  registry entry to `await rlm.delete_subagent(child)`. The current API accepts
  `RLMSubagent` objects and string selectors, but it does not accept the
  `RLMSpawnHandle` returned by `rlm(...)`; delete from a retained spawn handle
  with `await rlm.delete_subagent(handle.rlm_child_id)`.
