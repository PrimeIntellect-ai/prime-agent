---
name: goal
description: Manage the persistent thread goal from IPython. Use to read goal status and budget usage, to start a goal when the user explicitly asks for one, or to mark the active goal complete once its objective is fully achieved.
---

# Goal

The thread goal is a persistent objective the harness keeps re-prompting you to
pursue across turns until it is complete. Goal state (status, token budget,
usage accounting) lives in the host; this skill is the kernel-side interface to
it. Call it directly from IPython:

```python
await goal.get()
await goal.create("ship the release notes", token_budget=200000)
await goal.pause("waiting for release approval")
await goal.resume()
await goal.complete()
```

## API

- `await goal.get()` — current goal as a dict: `goal` (or `None` when no goal
  is set), `remaining_tokens`, and `completion_budget_report`. The `goal` dict
  carries `objective`, `status`, `token_budget`, `tokens_used`,
  `time_used_seconds`, and timestamps.
- `await goal.create(objective, token_budget=None)` — start a new active goal.
  Fails while a goal is still pending (active, paused, or budget-limited); a
  completed or errored goal is replaced by the new one. Only create a goal when
  the user or system/developer instructions explicitly ask for a persistent
  long-running goal; do not infer goals from ordinary tasks. Set `token_budget`
  only when an explicit token budget is requested.
- `await goal.pause(reason)` — pause autonomous continuation when no concrete
  action is possible because progress depends only on an external actor or
  event. Give the exact blocker; do not keep emitting holding updates.
- `await goal.resume()` — reactivate a paused goal after new input resolves the
  blocker.
- `await goal.complete()` — mark the existing goal achieved. Use only when the
  objective has actually been achieved and no required work remains; do not
  call it merely because the budget is nearly exhausted or because you are
  stopping work. When the result includes a `completion_budget_report`, report
  that final usage to the user.

## Rules

- Pause an incomplete goal instead of repeatedly reporting an unchanged
  external blocker. Resume it only after new input makes concrete progress
  possible. Clear and budget-limit transitions remain controlled by the user
  and host.
- When an active goal is actually complete, call `await goal.complete()`; do
  not merely say it is done — the harness keeps continuing the goal until the
  completion call arrives.
