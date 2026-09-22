---
name: compact
description: Check context usage and compact the conversation from the Python REPL. Use when context is filling up and substantial work remains, so the session is summarized and you keep working instead of stopping early.
---

# Compact

Compaction replaces older conversation history with a dense summary, freeing
context so long-running work can continue. The implementation lives in the
host (the same one behind the user's `/compact` command); this skill is the
kernel-side interface to it. Call it directly from the Python REPL:

```python
await compact.status()
await compact.run()
await compact.run("keep the failing test names and the migration checklist")
```

## API

- `await compact.status()` — current context usage as a dict: `tokens`,
  `context_window`, and `percent` (`None` right after a compaction until the
  next model response), plus `scheduled` (whether a requested compaction is
  already pending).
- `await compact.run(instructions=None)` — schedule compaction. Returns
  `{"scheduled": True}`, or `{"scheduled": False, "reason": ...}` when there
  is nothing to compact yet. Optional `instructions` focus the summary on
  what matters for the remaining work.

## Rules

- Compaction never runs mid-cell. A scheduled compaction runs when the
  current turn ends; the harness then resumes you automatically with the
  summary plus recent messages, and you continue the task.
- The Python kernel persists through compaction — variables, imports, and
  helpers you defined all remain available.
- Compact at a natural boundary when context usage is high and substantial
  work remains, instead of becoming terse or returning to the user early.
  Check `await compact.status()` when unsure.
- One request per turn is enough; calling `run` again before the turn ends
  only updates the instructions.
