---
name: agent-observe
description: Inspect read-only status and bounded recent-message previews for the current agent, its parent, siblings, and direct children. Use to monitor delegated work or recover context without mutating another session.
---

# Agent Observe

Inspect the current agent, its parent, siblings, and direct children through the
local daemon. Observation is currently limited to agents in the same worker, so
root siblings in other workers are not observable yet.

This read-only skill lists reachable sessions, inspects one session, and fetches
bounded recent-message previews. Parent-side lifecycle and messaging operations
perform every session mutation.

Call directly from the IPython kernel:

```python
children = await rlm.list_subagents()
child = next(iter(children), None)
if child is not None:
    observed = await agent_observe.get_agent(child.session_name)
    recent = await agent_observe.recent_messages(child.session_name, limit=6)
```

`rlm.list_subagents()` returns direct-child registry entries. Use
`child.session_name` to address one of those entries. Child deletion remains a
separate parent-side `rlm.delete_subagent(target)` operation. The current
`target` contract accepts a string selector or an `RLMSubagent` registry entry.

## API

- `await agent_observe.list_agents()` returns `current` and `agents`. Each agent
  includes active session id, session id, optional name, runtime kind, cwd,
  status, streaming state, message count, pending count, and a latest-message
  preview. The list is restricted to self, parent, siblings, and direct
  children. For direct children, `await rlm.list_subagents()` also exposes the
  parent-scoped lifecycle registry.
- `await agent_observe.get_agent(target)` returns `agent`, containing one agent
  summary. `target` accepts active or retained family-session selectors: active id, session id, session name, or an unambiguous suffix.
- `await agent_observe.recent_messages(target, limit=8, max_chars=800)` returns up
  to `limit` recent bounded message previews for the target session. `limit`
  must be 1 through 50. `max_chars` must be 80 through 2000.

## Boundaries

- Targets outside the current agent, parent, siblings, and direct children are
  rejected. Transcript reads follow the same reach boundary as messaging.
- Message access is bounded by count and by the character limit for each
  preview.
- Observation grants no additional authority. Use observed information only for
  the current task and under the same mutation, communication, privacy, and
  publication rules that already govern the observing agent.
