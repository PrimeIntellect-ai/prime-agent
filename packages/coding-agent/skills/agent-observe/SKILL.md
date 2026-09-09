---
name: agent-observe
description: Read-only roster and observation of an agent's parent, siblings, and direct children. Use to discover reachable agents and to inspect family status and bounded recent-message previews without mutating sessions.
---

# Agent Observe

Observe the current agent's nuclear family through the local daemon: parent,
siblings, direct children, and self. `list_agents` is the one family roster and
covers every member `agent_message.send` can reach. `get_agent` and
`recent_messages` hydrate an inactive child before reading it, but they cannot
read a root sibling held by another worker.
This skill is read-only: it can list family sessions, inspect one session, and fetch
bounded recent message previews. It cannot prompt, steer, clear, kill, rename, or
otherwise mutate another session.

Call directly from the kernel:

```python
children = await rlm.list_subagents()
child = next((item for item in children if item.active_session_id), None)
if child is not None:
    worker = await agent_observe.get_agent(child.session_name)
    recent = await agent_observe.recent_messages(child.session_name, limit=6)
    # Deletion is a parent-owned RLM operation, not an observe mutation:
    await rlm.delete_subagent(child)
```

## API

- `await agent_observe.list_agents()` returns `current` and `agents`, the full
  nuclear family: parent, siblings, and direct children, active or not. Each
  agent carries `sessionId`, optional `sessionName`, `relationship`
  (`parent`/`sibling`/`child`), `status`, `isSessionActive`, and the counts and
  latest message preview known for it. A member with no live session in this
  worker has no `activeSessionId` and no live detail; use `relationship` and
  `sessionName` to address it with `agent_message.send`. For direct children,
  `await rlm.list_subagents()` also exposes parent-owned lifecycle handles.
- `await agent_observe.get_agent(target)` returns `agent`, where `agent`
  contains one live agent summary. `target` is resolved like other live-session
  selectors: active id, session id/name, or unambiguous suffix.
- `await agent_observe.recent_messages(target, limit=8, max_chars=800)`
  returns up to `limit` recent bounded message previews for the target session.
  `limit` must be 1-50, and `max_chars` must be 80-2000.

## Safety

- This skill is read-only and exposes no mutation commands.
- Targets outside the nuclear family are rejected; transcript reads follow the
  same family rule as messaging.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
