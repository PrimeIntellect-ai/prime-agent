---
name: goal
description: Manage Prime Agent's persistent thread goal from IPython. Use to inspect goal status and budget use, create a goal when the user or higher-priority instructions explicitly request one, pause for a purely external dependency, resume after that dependency clears, or record actual completion.
---

# Goal

A thread goal is a persistent objective that Prime Agent continues across turns
until it is completed, paused, budget-limited, or otherwise ended by the host.
The host stores its status, token budget, and usage accounting. This skill is the
IPython interface to that state.

```python
await goal.get()
await goal.create("ship the release notes", token_budget=200000)
await goal.pause("waiting for release approval")
await goal.resume()
await goal.complete()
```

## API

- `await goal.get()` returns a dict containing `goal`, `remaining_tokens`, and
  `completion_budget_report`. `goal` is `None` when no goal exists. Otherwise it
  contains `objective`, `status`, `token_budget`, `tokens_used`,
  `time_used_seconds`, and timestamps.
- `await goal.create(objective, token_budget=None)` creates a new active goal. It
  fails while a goal remains pending in the active, paused, or budget-limited
  state. A completed or errored goal is replaced by the new goal. Create a
  thread goal only when the user or system or developer instructions explicitly
  request a persistent long-running objective. Do not infer one from an ordinary
  task. Set `token_budget` only when an explicit token budget is requested.
- `await goal.pause(reason)` pauses autonomous continuation when progress depends
  only on an external actor or event and no concrete action remains. State the
  exact dependency.
- `await goal.resume()` reactivates a paused goal after new input or an external
  event makes concrete progress possible.
- `await goal.complete()` records that the objective has been achieved. Call it
  only after every required result exists and no required work remains. When the
  result includes `completion_budget_report`, report that final usage to the
  user.

## Rules

- Use the objective to identify the required work. Verify its assumptions
  against current observations, apply later user constraints, and follow the
  governing instruction and authority boundaries.
- Pause an incomplete goal when only an external dependency remains. Do not emit
  repeated updates that report the same unchanged blocker. Resume only after the
  dependency clears.
- Budget exhaustion and the end of a turn do not establish completion.
- When the objective is complete, call `await goal.complete()`. This call records
  completion in host state and stops goal continuation.
