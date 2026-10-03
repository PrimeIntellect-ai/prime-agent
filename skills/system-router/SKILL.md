---
name: system-router
description: Run a System 1 / System 2 harness router loop from the Python REPL. The session model (System 2) declares a finite action space, an environment adapter command, and an action-only sub-model that answers ONE single-choice decision per step with thinking off. Use for games, emulators, devices, or workflows where every step is one choice from a known set and full LLM turns are too slow or too expensive.
---

# System Router

`system_router` runs the System 1 action loop: the sub-model sees the goal, the
latest observation, bounded history, and the declared finite action space; it
answers with exactly one action, its parameter values, and a confidence. The loop
gates that confidence per action risk, executes on the environment, and records
the complete trace. You (the session model) are System 2: you set the goal,
review the trace between segments, and steer.

```python
result = await system_router.run({
    "goal": "Get the player through the intro and into the overworld.",
    "model": "internal/glm-5.3-fast",     # optional; defaults to the configured subagent default model, then the session model
    "maxSteps": 25,                        # decision budget for this segment
    "timeoutMs": 120000,                   # wall-clock budget for this segment
    "actions": {                           # optional; omit to use the adapter's defaults
        "press_a": {"description": "Press the A button to confirm or talk."},
        "press_up": {"description": "Hold Up for a few frames."},
    },
    "environment": {
        "stdio": {
            "command": ["node", "adapter.mjs"],
            "init": {"romPath": "/path/to/rom.gba"},
        },
    },
})
```

## The returned result

- `status` - `done` (goal reached or environment terminal), `incomplete` (step
  or time budget), `stuck` (no confident decision, or a repeated state),
  `failed` (environment or model error), `escalated` (the action model asked for
  help).
- `reason` - a machine-readable terminal code such as `environment_terminal`,
  `max_steps`, or `no_confident_decision`.
- `steps`, `executed`, `refused` - how many trace entries were recorded, how
  many actions ran on the environment, and how many were refused.
- `trace` - every decision: observation digest, action, params, confidence, gate
  verdict, result, latency, tokens.
- `summary` - the harness-rendered terminal sentence.
- `model` - the resolved action model (`provider`, `id`, `thinkingLevel`).
- `usage` - summed input and output tokens for the segment.

## System 2 steering

The loop runs one bounded segment per call. After a call, read `status`, `trace`,
and `usage`, then either stop, adjust, or run the next segment with an updated
goal. An `escalated` or `stuck` status is a door, not a failure: the action model
was unsure, so review the trace and steer with a new goal, a different model,
adjusted gates, or more context. Confidence below an action's gate pauses
execution and counts toward `stuck`, so the sub-model cannot thrash.

## Environment adapters

Adapters are programs speaking newline-delimited JSON: requests
`{"id", "type": "init"|"reset"|"observe"|"execute", ...}` and replies
`{"id", "ok": true, ...}` or `{"id", "ok": false, "error"}`. Any language works,
and an adapter can wrap a container. An adapter supplies its own default action
space by returning `environment.actions` from `init`. The full contract lives in
`docs/system-router.md`.
