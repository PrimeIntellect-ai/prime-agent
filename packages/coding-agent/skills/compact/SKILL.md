---
name: compact
description: Inspect context-window use and schedule conversation compaction from IPython. Use when context is filling and substantial work remains, so older history becomes a continuation summary while the task and kernel state continue.
---

# Compact

Compaction replaces older conversation history with a concise continuation
summary. It frees context-window space while preserving the information needed
to continue the task. The host implements the same operation as the user's
`/compact` command; this skill is its IPython interface.

```python
await compact.status()
await compact.run()
await compact.run("keep the failing test names and the migration checklist")
```

## API

- `await compact.status()` returns current context use as a dict with `tokens`,
  `context_window`, `percent`, and `scheduled`. `percent` is `None` immediately
  after compaction until the next model response. `scheduled` reports whether a
  compaction request is already pending.
- `await compact.run(instructions=None)` schedules compaction. It returns
  `{"scheduled": True}`, or `{"scheduled": False, "reason": ...}` when there
  is nothing to compact. Optional `instructions` identify information that the
  continuation summary should preserve.

## Rules

- A scheduled compaction starts after the current turn. The host then resumes
  the agent with the summary and the retained recent messages.
- The IPython kernel survives compaction. Existing variables, imports, helper
  functions, and running kernel state remain available. Record the names of
  reusable bindings in the summary because the cells that created them may no
  longer appear in the retained conversation.
- Compact at a natural boundary when context use is high and substantial work
  remains. Check `await compact.status()` when the need is uncertain.
- The summary must keep active user requests, completed and pending work,
  observed or tool-verified results, source claims, computations, inferences,
  assumptions, conflicting evidence, failed checks, uncertainty, exact
  identifiers, and authority blockers distinct where those distinctions affect
  continuation.
- One request per turn is enough. Another `run` call before the turn ends only
  replaces the optional instructions.
