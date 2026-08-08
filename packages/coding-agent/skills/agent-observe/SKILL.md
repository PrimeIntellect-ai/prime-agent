---
name: agent-observe
description: Read-only observation of an agent's parent, siblings, and direct children. Use to inspect family status and bounded recent-message previews without mutating sessions.
---

# Agent Observe

Observe the current agent's nuclear family through the local daemon: parent,
siblings, direct children, and self. Observation is currently limited to family
members in the same worker; root siblings in other workers are not observable yet.
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

## Import

```python
import agent_observe
```

## API Reference

```python
async def list_agents() -> dict
```
Returns `current` and `agents`. Each agent includes active session id, session id,
optional name, runtime kind, cwd, status, streaming state, message count, pending
count, and a latest message preview. Restricted to self, parent, siblings, and direct
children. For direct children, `await rlm.list_subagents()` also exposes parent-owned
lifecycle handles.

---

```python
async def get_agent(target: str) -> dict
```
Returns `agent` — one session summary. `target` is resolved as: active session id,
session id/name, or unambiguous suffix.

---

```python
async def recent_messages(
    target: str,
    limit: int = 8,
    max_chars: int = 800,
) -> dict
```
Returns up to `limit` recent bounded message previews for `target`.
- `limit`: 1–50 (host-validated).
- `max_chars`: 80–2000 per message (host-validated).

**Functions that do NOT exist (common mistakes):**
- `agent_observe.observe()` — does not exist; use `list_agents()` or `get_agent()`.
- `agent_observe.list_messages()` — does not exist; use `recent_messages()`.

## Safety

- This skill is read-only and exposes no mutation commands.
- Targets outside the nuclear family are rejected; transcript reads follow the
  same family rule as messaging.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
