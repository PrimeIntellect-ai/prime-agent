# `rlm.decide`: fast decisions for kernel loops (System 1)

`await rlm.decide(state, actions)` asks a fast decision model for one action and
returns it to the calling code. It is one awaited kernel call. It never wakes the
session, adds no transcript row, and bills its cost to the session.

Use it when kernel code needs many quick decisions, for example a control loop
for a game or a simulator. The agent itself (System 2) stays in charge on a
slower cadence: it writes the goal that the loop reads and reviews the loop.

## Setup

`rlm.decide` serves structured-decision models only (`api: "systemone"`, Prime
Inference's `/systemone` endpoint). Declare the model in `~/.prime/agent/models.json`:

```json
{
  "providers": {
    "prime-inference": {
      "models": [
        {
          "id": "cloudflare/clef",
          "api": "systemone",
          "cost": { "input": 0.042, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then point the `decisionModel` setting at it in `~/.prime/agent/settings.json`:

```json
{ "decisionModel": "prime-inference/cloudflare/clef" }
```

Requests carry the Prime Inference key and team (`X-Prime-Team-ID`) like every
other Prime Inference call. The `allowedModels` setting applies. The model is
resolved on the first successful call and reused for the rest of the session.

## API

```python
decision = await rlm.decide(
    {"goal": "catch the ball", "ball_x": 3, "paddle_x": 5},
    {"left": "the ball is left of the paddle", "right": "the ball is right of the paddle",
     "wait": "the ball is above the paddle"},
)
decision.choice         # "left"
decision.confidence     # 0.91, or None
decision.probabilities  # {"left": 0.91, "right": 0.05, "wait": 0.04}
decision.model          # "prime-inference/cloudflare/clef"
```

- `state`: any JSON value. Put the goal in it.
- `actions`: action name -> when it applies.
- `instructions`: replaces the default question ("Choose the next action that
  best advances the goal given the observation.").
- `images`: up to 4 `data:image/...;base64,` URLs, for models that accept images.

Errors raise `RuntimeError`: setting unset, not a `systemone` model, outside
`allowedModels`, bad request, HTTP error, or no reply within 30 s.

## Cost

Each served call appends one `decision` entry with its usage to the session file
(not part of the model context). Its cost is computed from the model price and
counts in the session's own totals, like compaction usage. At clef's price a
177-token decision costs about $0.0000074.

## Pattern: a control loop with System 2 on a heartbeat

Run the loop as a background asyncio task in the kernel. It keeps running between
turns. Keep the goal in a kernel variable that the loop puts into `state`, and let
the agent review the loop on a heartbeat:

```python
import asyncio

goal = "catch the falling ball"
status = {"steps": 0, "last": None, "error": None}

async def control_loop():
    try:
        while (obs := env.observe()) is not None:
            d = await rlm.decide({"goal": goal, "observation": obs}, ACTIONS)
            env.act(d.choice)
            status.update(steps=status["steps"] + 1, last=d.choice)
    except Exception as error:
        status["error"] = repr(error)

loop_task = asyncio.get_running_loop().create_task(control_loop())
await rlm_heartbeat.create(
    "Check `status` of the control loop; change `goal` if the plan should change.",
    interval="every 2 minutes",
)
```

In a later turn the agent changes `goal = "..."`; the next decision uses it. The
heartbeat also keeps the kernel alive: without one, a settled child session
releases its kernel and an idle root session can be evicted, which ends the loop.
`loop_task.cancel()` stops the loop.

Cancelling an awaiting call (a cell interrupt, or `task.cancel()`) raises
`CancelledError` in the kernel at once. The host lets the in-flight request finish
or time out (at most 30 s) and drops the late reply; a request that completes is
still billed.
