# Catch

Catch is a small Gym-style environment for the Decision API skill. Install
[uv](https://docs.astral.sh/uv/) and use Python 3.11 or newer. `uv run` installs
the game's declared pygame dependency. Install ffmpeg on PATH to record MP4;
use `record=False` when recording is unnecessary. `headless=True` runs without
a display. Each run writes into its own `examples/catch/runs/catch-*` directory.

In Prime Agent, set `decisionApi.systemOneModel` in settings.json to a
registry model reference (vision-capable for image-based observations) and
restart the session or kernel; the `decision-api` skill appears once the
setting resolves. Run this in the persistent Python REPL with the skill
enabled, substituting the repository path:

```python
import sys
sys.path.insert(0, "<repo>/examples/catch")
import env

catch = await env.CatchEnv.make(seconds=60, seed=1, record=False, headless=True)
loop = None
try:
    observation, info = await catch.reset()

    async def observe():
        return None if observation.get("done") or observation.get("truncated") else observation

    async def act(action):
        global observation
        observation, reward, terminated, truncated, info = await catch.step(action)
        if terminated or truncated:
            observation = {**observation, "done": True}

    loop = decision_api.Loop(observe, act, catch.actions, objective="Catch the falling circles", tick=0.1)
    # A vision-capable System 1 reads the compact text state and sees the
    # rendered frame; drop these two lines for a text-only model.
    loop.state = env.observation_state
    loop.images = env.observation_images
    loop.start()
    while (await loop.wait(timeout=10))["running"]:
        print(loop.status(), loop.errors[-3:])
    print(await catch.close())
finally:
    if loop is not None:
        await loop.stop()
    await catch.close()
```

The first `reset()` starts the episode clock. `step(action)` returns
`(observation, reward, terminated, truncated, info)`; reward is catches minus
drops since the previous step. `close()` returns the final score and optional
recording path and is safe to call again. The session agent designs the loop;
the environment supplies observations and applies actions.

Each observation is the text state (`picture`, `bowl`, `caught`, `missed`,
`done`) plus the rendered frame as a 360x360 PNG data URL (`image`). For a
vision-capable System 1, wire the split into the loop: `loop.state =
env.observation_state` keeps the data URL out of the text, and `loop.images =
env.observation_images` rides the frame as the decision request's image
block. Both helpers accept the observation as the loop passes it.

Run startup/artifact regression tests with
`python3 -m unittest discover -s examples/catch -p 'test_*.py' -v`.
