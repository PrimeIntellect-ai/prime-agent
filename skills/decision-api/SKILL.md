---
name: decision-api
description: Experimental System 1 / System 2 loop for real-time, low-latency tasks. System 1 is the model named by the decisionApi.systemOneModel setting, served by a spawned decision child that picks every action from observations; System 2 is you, the parent, routing goals to it as messages. You design, measure, and optimize the whole loop. Requires the decisionApi.systemOneModel setting.
---

# Decision API (System 1 / System 2)

Use this for real-time control tasks where every step is one choice from an
action set (a game, a device, a UI) and a full agent turn per step is too slow.

- **System 1** is the decision model the user configured: the
  `decisionApi.systemOneModel` setting names it. The canonical target is
  Prime Inference's hosted structured-decision clef
  (`prime-inference/cloudflare/clef`, served at
  https://api.pinference.ai/api/v1 with the stored login's team header);
  any registry model reference that resolves can serve the role, and a
  resolvable reference turns the feature on. `Loop` spawns it as a decision child (`rlm.spawn(kind="decision")`)
  whose every message is one decision request: each observation becomes one
  model call that returns the chosen action and its confidence. The child
  lives exactly as long as the loop. `loop.status()["system1_model"]`
  reports the model that served each decision.
- **System 2** is you, the parent running the loop. `loop.set_goal("...")`
  routes updated goals to the child as tagged agent messages, and every
  decision the child serves reads the latest goal. Goals are one or two
  sentences of strategy, never an action name or a step-by-step command.

## Your role: optimize the whole loop

You own the loop's design and performance:
- what System 1 sees (`state`, and `images` with a vision-capable model);
- how its question reads (`instructions` and the action descriptions);
- its `history_size`, `tick`, and `decide_timeout`;
- the goals you route with `set_goal` and the `objective` they refine.

Writing the task's strategy into System 1's instructions and action
descriptions is loop design, not goal routing.

Diagnose from the outcome before changing anything. The task's own result
(score, success rate) is the measure; `loop.history` confidences and
`loop.goal_updates` explain it.
- **System 1 problems:** low confidence, actions flipping between options,
  or failures while the goal stays the same. Give `state` the information
  the decision needs, sharpen `instructions`, or make the action descriptions
  easier to tell apart.
- **Goal problems:** goals that are wrong, churn, or lag the situation.
  Update the goal only when the situation genuinely needs a new direction;
  `loop.goal` starts as the `objective`.
- **No goals needed:** for pure reflexes or one fixed strategy, never call
  `set_goal`; the objective alone is enough.

Change one thing at a time and compare runs under the same conditions (same
seed or scenario, same duration), keeping what measurably helps. Make changes
through the loop's settings or the task's own code, never by editing this
skill's package. Do the analysis yourself rather than delegating it to extra
subagents.

You never steer the live loop by hand:
- Do not choose actions from observations yourself.
- Do not message the decision child directly; `set_goal` is the route.
- `loop.goal` is yours (it starts as the `objective`): `set_goal` updates
  it live.

## Setup

The Decision API is off until configured: the user sets
`decisionApi.systemOneModel` in settings.json to a registry model reference
(`"provider/model-id"` or a bare id) and restarts the session or kernel. The
host resolves the model and its credentials through the model registry — the
same path any other model call takes — and makes every provider call. If a
call reports the setting is unset or unresolvable, ask the user to fix the
setting. Do not ask for keys yourself.

## Usage

Write `observe` and `act` for the environment (sync or async), start the loop
in the background, then watch and adjust it from later cells:

```python
actions = {
    "left": "Move left when the target is to the left",
    "right": "Move right when the target is to the right",
    "wait": "Do nothing when already aligned",
}
loop = decision_api.Loop(observe, act, actions, objective="Keep the paddle under the ball", tick=0.3)
loop.start()

status = await loop.wait(timeout=20)   # returns early if the loop ends
print(status, loop.history[-5:], loop.goal_updates[-3:], loop.errors[-3:])
```

Every attribute is read again each step, so assignments take effect live:

```python
loop.actions["fire"] = "Fire when an enemy is straight ahead"   # or a function (observation) -> dict
loop.instructions = "..."; loop.tick = 0.2
loop.state = lambda observation, goal, history: {...}           # exactly what System 1 sees
loop.images = lambda observation: [png_data_url]                # vision models: up to 4 images per step
loop.on_error = "skip"            # "stop" (default), "skip", or (error, observation) -> action
loop.on_step = lambda record, observation: ...                  # log or render; return "stop" to end the loop
loop.set_goal("Prioritize catching the ball over waiting")      # System 2: route a new goal to the child
loop.objective = "..."           # the goal's fallback; set_goal overrides it
loop.decide_timeout = 30.0       # bound one decision round trip
loop.pause(); loop.resume()
final = await loop.stop()        # also removes the decision child
```

Construction accepts the same settings as keywords (`decide_timeout=10`,
`max_steps=500`, `history_size=10`, ...); `help(decision_api.Loop)` lists all
of them. `await loop.run()` runs to completion in one cell instead.

Each step sends one decision request to the child and awaits its tagged
reply. Spawn and delivery failures appear in `loop.errors` (spawn retries in
the background); a decision that overruns `decide_timeout` fails the step and
follows `on_error`. Stopping removes the child. Python 3.11 or newer is
required.

Stay in your turn while a loop runs: poll with `loop.wait(timeout=...)`, read
`history`, `goal_updates`, and `errors`, adjust, and stop it when done. The
loop keeps running between cells, but nothing wakes you once your turn ends.

For a single System 1 decision without a loop, `await
decision_api.decide(observation, actions, goal="...", images=None)` returns
`action`, `confidence`, `probabilities`, `latency_ms`, and `model` — the
same host call the child serves.

Images (vision-capable models only): at most 4 per decision, each a data URL
string such as `f"data:image/png;base64,{base64.b64encode(png_bytes).decode()}"`
(not bytes, paths, or dicts); PNG, JPEG, or WebP, up to 4 MiB and 16
megapixels each and 8 MiB in total. Small, cropped images keep latency low; degenerate ones (a 1x1 pixel)
fail with a server error.
