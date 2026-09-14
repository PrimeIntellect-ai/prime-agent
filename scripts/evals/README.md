# Prime Agent capability evals

These harnesses measure end-to-end agent capability with a real model:
find a bug, edit code, run the tests, iterate to green. They complement
the repo's unit tests (which never call a model) and the PR performance
benchmarks (which measure startup, not capability).

## swe-fix-loop

Measures the inner software-engineering loop on seeded-bug fixtures:

1. **Fixtures** (`swe_fix/fixtures/`) are small self-contained repos
   (TypeScript via `node --test`, Python via `unittest`, both stdlib-only,
   nothing to install) with three pre-existing passing tests, one seeded
   failing test, a golden patch, and a symptom-only task prompt. The
   prompt names the failing behavior, never the location.
2. **Runner** (`swe_fix/runner.py`) copies a fixture to a temp dir, runs
   the agent headless (`--mode json`, `--cwd` at the fixture, task prompt
   from the fixture), then records the post-state. The post-run suites
   run against pristine fixture files plus the agent's edits inside
   `allowed_files`, so out-of-scope edits (tests, runners) cannot mask
   a failed fix.
3. **Scorer** (`swe_fix/scorer.py`) applies the rubric: target test
   passes; pre-existing tests still pass (no regressions); diff stays
   within the golden patch's file list (30% collateral tolerance); the
   transcript shows the agent running the test command (a bash tool call
   or an ipython bash() cell, as a whole shell command, not a substring
   or comment); plus token/turn efficiency from the transcript, counted
   once per assistant message.

A fixture counts as resolved only when every rubric element passes.

### Running a real-model eval

The eval needs a model selector and provider credentials in the
environment (the agent's normal auth):

```
cd scripts/evals/swe_fix
uv run --locked python runner.py --fixture fixtures/ts-date-utils --model anthropic/claude-sonnet-4-5
uv run --locked python runner.py --fixture fixtures/py-budget --model anthropic/claude-sonnet-4-5
```

The runner prints the scored outcome as JSON and exits 0 only when the
fixture is resolved. `--timeout` (default 1200s) bounds the agent run.

### Self-tests

Validate the harness with the model-free self-tests (fixture integrity,
golden patches, scorer rubric) - never a model call:

```
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python -m unittest discover -s tests -v
```

### Adding a fixture

Copy an existing fixture directory, keep the shape: sources + tests
(3 passing, 1 seeded failing), `task.txt` (symptom only), `golden.patch`
(diff from the buggy tree, generated with `git diff`), and
`fixture.json` (test command, target test command, allowed files).
