# System Router (System 1 / System 2)

The system router lets a cheap, fast **action model (System 1)** do step work that
a full agent turn is too slow or too expensive for, while the session model
(**System 2**) keeps the strategy. System 2 declares an environment (a finite
action space, an observation provider, and optional memory reads) plus an action
model; the router then runs the step loop until a terminal state and returns the
complete trace. System 2 reviews the trace and steers the next segment.

The loop mirrors the [SystemOneHarness](https://github.com/HarnessRouter/SystemOneHarness)
controller design: one model call per step, the action space compiled into a
single typed choice, every decision gated by confidence, no free-form generated
actions, and a probability attached to every transition.

```
goal --> observe --> decide (ONE call, thinking off) --> gate --> execute --> trace
           ^                single choice + confidence        |
           +-------------- environment <-----------------------+
```

## Where things live

- `crates/pa-core/src/system_router/` holds the pure, host-agnostic loop:
  `loop.rs`, `decide.rs`, `action_space.rs`, `stdio_environment.rs`,
  `segment.rs`, and `types.rs`.
- `crates/pa-core/src/session_engine/system_router_host.rs` registers the
  `system_router.run` kernel host-request handler.
- `skills/system-router` is the kernel-side wrapper, `system_router.run` from
  the Python REPL.

## The step loop

1. **Observe.** The environment reports legible text plus structured fields (and
   an optional screenshot). It states the goal's own predicates outright, including
   the ones that are false.
2. **Decide.** The action model gets the goal, the observation, bounded history,
   and the declared actions with their finite parameter values. It replies with
   exactly one JSON object, `{"action", "params", "confidence"}`, and nothing
   else. Thinking is disabled (the model's thinking level is clamped to off);
   anything not in the action space is refused and recorded.
3. **Gate.** The chosen action's risk level selects a confidence threshold
   (defaults mirror SystemOneHarness: read 0.5, write 0.6, destructive 0.8, finish
   0.5). Below the gate the step is recorded as refused; three consecutive
   refusals end the segment as `stuck`.
4. **Execute.** The environment applies the action and reports what happened.
5. **Record.** Every step lands in the trace with the observation digest, action,
   parameters, confidence, gate verdict, result, latency, and token usage.

`finish` and `escalate` are actions the space always appends: `finish` declares the
goal reached, `escalate` hands control back to System 2. The same action with the
same parameters on the same observation twice, adjacent or interleaved with other
repeats, ends the segment as `stuck`. A step dispatched when the timeout fires is
recorded with an unknown outcome, so a retried segment can see what may have run.

## Running a segment

From the Python kernel:

```python
result = await system_router.run({
    "goal": "Talk to Mom, then leave the house.",
    "model": "internal/glm-5.3-fast",   # optional action model; any chat model works
    "maxSteps": 25,
    "timeoutMs": 120000,
    "actions": {                        # optional; adapter defaults are used when omitted
        "press_a": {"description": "Press A to confirm or talk."},
        "press_up": {"description": "Hold Up for a few frames."},
    },
    "environment": {
        "stdio": {
            "command": ["node", "gba-adapter.mjs"],
            "init": {"romPath": "/path/to/pokemon-emerald.gba"},
        },
    },
})
```

The action model selector is optional. When it is omitted the router uses the
configured subagent default model, and then the session model.

The returned result carries:

- `status` (`done`, `incomplete`, `stuck`, `failed`, `escalated`).
- `reason`, a machine-readable terminal code (for example `goal_reached`,
  `environment_terminal`, `max_steps`, `no_confident_decision`, `repeated_state`,
  `escalation_requested`, `timeout`, `environment_error`, `decision_model_error`).
- `steps`, `executed`, and `refused` counters.
- the full `trace`.
- a harness-rendered `summary`.
- the resolved `model` (`provider`, `id`, `thinkingLevel`).
- summed token `usage`.

## System 2 steering

One `run` is one bounded segment; steering happens between segments:

- Set or update the goal before each segment.
- Review the trace: progress through the observation digests, confidence dips,
  and repeated states.
- Re-invoke with a new goal, a different action model, adjusted gates, or tighter
  budgets; `stuck` and `escalated` are doors for steering, not failures.

There is no mid-step steering and no mid-segment cancel in v1: a step is one
model call of a few hundred milliseconds, and `timeoutMs` bounds every segment.

## Environment adapters

An adapter is a program speaking newline-delimited JSON over stdin/stdout. Each
request is one line; each reply is one line:

```json
{"id": 1, "type": "init", "init": {"romPath": "/roms/game.gba"}}
{"id": 1, "ok": true, "environment": {"actions": {"press_a": {"description": "Press A."}}}}
{"id": 2, "type": "reset", "goal": "..."}
{"id": 2, "ok": true}
{"id": 3, "type": "observe"}
{"id": 3, "ok": true, "observation": {"text": "Title screen. New Game is selected.", "fields": {"frame": 180}, "terminal": false}}
{"id": 4, "type": "execute", "action": "press_a", "params": {}}
{"id": 4, "ok": true, "text": "A pressed for 8 frames; screen advanced.", "terminal": false}
```

- `init` (once): receives the spec's `init` payload (e.g. a ROM path); may return
  `environment.actions` when the adapter provides a default action space.
- `reset` (once, before the first observe): restore the environment to the start
  of the segment.
- `observe`: reply with `observation.text` (required), optional `fields`, optional
  base64 PNG `image`, and `terminal`.
- `execute`: reply with `text` and optional `terminal`. A soft failure is an
  honest `text` result; an `ok: false` error fails the run.
- The adapter runs in `environment.stdio.cwd` when given, and in the session's
  working directory otherwise (a relative `command` or path resolves against the
  session, not the host process).
- Requests time out after `environment.stdio.requestTimeoutMs` (default 30s). At
  segment end the adapter is asked to close, then sent SIGTERM, then killed with the
  platform tree kill (SIGKILL to the process group on POSIX, `taskkill /T` on
  Windows), all within the segment's remaining budget, so a wedged adapter cannot
  extend a timed-out segment and a launcher's descendants go down with it.

Adapters can be written in any language. Because the adapter is a subprocess, it
also crosses machine boundaries: the same `command` can wrap a container.

## Budgets and gates

Every budget has a default and a maximum; the spec value must be a whole number in
`[1, max]`.

| Field | Default | Max |
| --- | --- | --- |
| `maxSteps` | `25` | `200` |
| `timeoutMs` | `120000` | `600000` |
| `historySteps` | `8` | `32` |
| `observationChars` | `6000` | `32000` |
| `environment.stdio.requestTimeoutMs` | `30000` | `120000` |

Confidence gates (`gate`) default to `read: 0.5`, `write: 0.6`,
`destructive: 0.8`, `finish: 0.5`, and each supplied value must be in `[0, 1]`.

## Honest limits

- A chat model's `confidence` is a self-reported number, not the calibrated
  per-option probability a native System-1 model emits; the gate still bounds
  thrash, but the value is cadence plus constraint, not calibration.
- Steering is per segment; there is no mid-step pause.
- The loop never edits the action space at runtime; the environment grows by
  its own means between segments.
