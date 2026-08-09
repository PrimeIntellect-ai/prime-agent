---
name: refine
description: Schedule a local or global Continual Harness refinement from IPython. Use after concrete trajectory evidence shows that a prompt note, memory, saved Python-call description, or subagent specification should be created, corrected, consolidated, or removed. Refinement runs after the current turn.
---

# Refine

Refinement reviews the current trajectory and applies small create, update, or
delete edits to Continual Harness state. Continual Harness is Prime Agent's
persisted editable set of prompt notes, memories, saved descriptions of Python
calls, subagent specifications, and refinement history. A saved skill entry
describes a callable that already exists in an installed Python package.

The host implements the same operation as the user's `/refine` command. This
skill schedules it from the IPython kernel:

```python
await refine.status()
await refine.run()
await refine.run("record the repeated repository-status failure as a local memory")
await refine.run("promote the verified error-handling rule to global state", global_=True)
```

## API

- `await refine.status()` returns `pending`, which reports whether a refinement
  is queued for this turn, and `in_flight`, which reports whether refinement is
  currently being planned or applied.
- `await refine.run(instructions=None, global_=False)` schedules refinement. It
  returns `{"scheduled": True}` immediately, or
  `{"scheduled": False, "reason": ...}` when refinement cannot start. Optional
  `instructions` identify the observation or entry to review. The default
  target is the current session's local store. `global_=True` targets the
  cross-session global store.

## Rules

- A scheduled refinement runs after the current turn, applies accepted edits,
  rebuilds the prompt, and resumes the agent. Continue the current work after
  scheduling it.
- One request per turn is enough. A later `run` call in the same turn only
  replaces the optional instructions.
- Create or update state only when concrete trajectory evidence shows that it
  can change a future decision or action. Preserve the source, uncertainty,
  failed checks, and conflicting evidence that limit the entry.
- An explicit user request or correction may justify a narrow entry. An
  autonomously created reusable procedure should have at least two concrete
  uses that expose the same missing capability and should not duplicate a
  simpler existing mechanism.
- Prefer correcting, consolidating, or deleting stale entries to adding another
  overlapping layer. Change the smallest component that carries the reusable
  fact or behavior.
- Use local refinement for current-session progress, temporary blockers, and
  project facts that should not affect unrelated sessions. Use global
  refinement only for stable cross-session state, durable user preferences,
  reusable call descriptions or delegation roles, and explicitly
  project-qualified facts likely to recur.
