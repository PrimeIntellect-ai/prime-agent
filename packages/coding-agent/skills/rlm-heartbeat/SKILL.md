---
name: rlm-heartbeat
description: Manage recurring prompts owned by the current Prime Agent session from IPython. Use when the user asks this agent to start, inspect, pause, resume, update, or delete an internal heartbeat, unless the user explicitly refers to the separate visible `/heartbeat` feature.
---

# RLM Heartbeat

An RLM heartbeat is a recurring prompt delivered to the current agent session.
It is internal to that session. It is separate from the user's visible
`/heartbeat`, and this skill cannot read, replace, pause, resume, or clear that
user-level heartbeat.

Call directly from the IPython kernel:

```python
await rlm_heartbeat.create("check test progress", interval="5m", label="tests")
await rlm_heartbeat.create("watch build", delivery_mode="follow_up")
await rlm_heartbeat.list()
await rlm_heartbeat.update("job-id", status="pause")
await rlm_heartbeat.delete("job-id")
```

## API

- `await rlm_heartbeat.list(include_inactive=False)` lists heartbeats for this
  session. By default it includes active and paused entries.
- `await rlm_heartbeat.create(instruction, interval=None, label=None, delivery_mode=None)` creates a recurring heartbeat for this session. The
  default interval is 5 minutes. Several heartbeats may run at once; labels
  distinguish them. `delivery_mode` is `"steer"` by default or `"follow_up"`.
- `await rlm_heartbeat.update(id, instruction=None, interval=None, label=None, status=None, delivery_mode=None)` updates one heartbeat. `status` is
  `"pause"` or `"resume"`. `delivery_mode` is `"steer"` or `"follow_up"`.
- `await rlm_heartbeat.delete(id)` cancels one heartbeat.

## Delivery Mode

- `steer` interrupts the current turn so the heartbeat prompt can run promptly.
- `follow_up` waits for the current turn to finish before delivering the prompt.

## Rules

- Use this skill for recurring checks and continuation prompts owned by the
  current agent session.
- An explicit request to configure `/heartbeat` refers to the separate
  user-level feature and is outside this skill's authority.
- Give each heartbeat a concrete instruction that identifies what to inspect,
  what change matters, and what action to take when that condition occurs.
