---
name: rlm-heartbeat
description: Manage agent-owned RLM heartbeats from the Python REPL. Use when the user asks the agent to start, create, schedule, or manage a heartbeat, unless they explicitly request the user's /heartbeat.
---

# RLM Heartbeat

RLM heartbeats are internal recurring prompts for the current agent session.
They are separate from the user's visible `/heartbeat`: this skill cannot read,
replace, pause, resume, or clear that user-level heartbeat.

Call directly from the Python REPL:

```python
await rlm_heartbeat.create("check test progress", interval="5m", label="tests")
await rlm_heartbeat.create("watch build", delivery_mode="follow_up")
await rlm_heartbeat.list()
await rlm_heartbeat.update("job-id", status="pause")
await rlm_heartbeat.delete("job-id")
```

## API

- `await rlm_heartbeat.list(include_inactive=False)` — list this session's
  internal RLM heartbeats. By default this includes active and paused entries.
- `await rlm_heartbeat.create(instruction, interval=None, label=None,
  delivery_mode=None)` — create a recurring heartbeat for this session. The
  default interval is every 5 minutes. Multiple RLM heartbeats may run at once;
  use labels to distinguish them. `delivery_mode` is `"steer"` (default) or
  `"follow_up"`.
- `await rlm_heartbeat.update(id, instruction=None, interval=None, label=None,
  status=None, delivery_mode=None)` — update one RLM heartbeat by id. `status`
  may be `"pause"` or `"resume"`; `delivery_mode` may be `"steer"` or
  `"follow_up"`.
- `await rlm_heartbeat.delete(id)` — cancel one RLM heartbeat by id.

## Delivery mode

Each heartbeat has a delivery mode controlling how the scheduled prompt reaches
the session when it is busy:

- `steer` (default): interrupt the current turn so the heartbeat runs promptly.
- `follow_up`: wait for the current turn to finish before running the heartbeat.

## Rules

- Use this when the user asks you to start, create, schedule, or manage your own
  heartbeat without explicitly referring to `/heartbeat`.
- Use this only for agent-internal recurring checks and long-running task
  coordination.
- Do not use this skill to satisfy a user's request to configure `/heartbeat`;
  that is a separate user-level surface.
- Keep heartbeat instructions specific and actionable so each recurring turn
  knows exactly what to inspect or continue.
