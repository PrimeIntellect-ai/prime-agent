# Prime Agent capability evals

These harnesses measure end-to-end agent capability with a real model.
They complement the repo's unit tests (which never call a model) and the
PR performance benchmarks (which measure startup, not capability). Every
harness has model-free self-tests. Real-model runs are manual unless a harness
documents a narrow release gate, such as the label-gated Short SWE check.


## short_swe

The Short SWE release check compares the exact base and head of a pull request on
fixed 15/8/5 slices of SWE-bench Verified, SWE-bench Pro, and ScaleSWE. It runs
only when a maintainer applies the exact `pre-release` label. See
[`short_swe/README.md`](short_swe/README.md) for its trust boundary and commands.

## swarm-fanout

Measures multi-agent orchestration under one prompt: decompose a job
into per-shard child tasks, fan out one RLM subagent per shard, fan the
answers back in, and account for child failures. Everything is scored
from on-disk artifacts - the RLM spawn ledger, sub-* child session
dirs, the parent session transcript, and the combined answer artifact -
never from the agent's own claims.

1. **Fixtures** (`swarm_fanout/fixtures/`) are two self-contained sets
   (JSONL event logs, CSV host metrics) of eight stdlib-only data shards
   each, with a machine-checkable question and expected answer per shard.
   `task.txt` is the orchestration prompt; `fixture.json` is the
   scoring manifest and stays out of the agent's repo copy.
2. **Runner** (`swarm_fanout/runner.py`) copies a fixture to a temp git
   repo, runs the parent agent headless (`--mode json`, `--daemon-socket`,
   `--session-dir`, isolated agent home), then records the post-state.
   The ledger path is computed exactly as the product does:
   `<agentHome>/rlm-ledger/<sha256(canonical sessions dir)[:16]>.jsonl`.
3. **Scorer** (`swarm_fanout/scorer.py`) applies the rubric:
   - **coverage**: every shard's answer in `combined-index.md` matches
     the machine-computed expected value;
   - **delegation evidence**: a live depth-1 ledger edge for every
     shard's worker name, each edge backed by its real child session dir
     (the edge's recorded child file must exist in the collected sub-*
     dirs) - helper-named spawns do not substitute, and a parent that
     answers everything itself fails here;
   - **dedup**: no shard's worker name is spawned twice while another
     child for that shard is live, and total depth-1 spawns stay within
     one retry per shard (2x the shard count);
   - **receipts**: every depth-1 child has a parent-visible reply or an
     explicit failure/terminal notice in the parent transcript;
   - **efficiency**: tokens, turns, and wall time (informational until a
     single-agent baseline datapoint exists).

A run counts as resolved only when coverage, delegation, dedup, and
receipts all pass.

### Running a real-model eval

The eval needs a model selector and provider credentials in the
environment (the agent's normal auth):

```
cd scripts/evals/swarm_fanout
uv run --locked python runner.py --fixture fixtures/json-events --model anthropic/claude-sonnet-4-5
uv run --locked python runner.py --fixture fixtures/csv-metrics --model anthropic/claude-sonnet-4-5
```

The runner prints the scored outcome as JSON and exits 0 only when the
run is resolved. `--timeout` (default 1800s) bounds the agent run.

Real-model runs should be planned against one constraint: a one-shot
`--mode json` session is client-owned, and when the CLI process exits
the daemon stops its worker (after a 30s grace), taking still-running
children with it. The task prompt therefore requires the parent to keep
its run active until every child has replied. If a real-model datapoint
shows models reliably ending their turn before the fan-in completes,
drive the parent as a resident session over the daemon protocol
(`create` + `prompt` + `wait_for_headless_completion` with
`waitForRlmQuiescence: true`) instead and re-check; the scorer needs no
changes either way, since it reads only the artifacts.

### Self-tests

Validate the harness with the model-free self-tests (fixture integrity
with independently recomputed answers, every scorer rule plus the
no-spawn, double-spawn, fabricated-answer, and silent-drop cheats,
ledger-path computation, and a stub-agent end-to-end run) - never a
model call:

```
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python -m unittest discover -s tests -v
```

### Adding a fixture

Copy an existing fixture directory, keep the shape: `shards/` (data
files with machine-checkable answers), `fixture.json` (name, artifact,
shards with file/worker/question/expected), and `task.txt` (orchestration
prompt naming every shard and its question). Extend the fixture
integrity tests with an independent recompute for the new questions.

## swe-fix-loop

Measures the inner software-engineering loop on seeded-bug fixtures:

1. **Fixtures** (`swe_fix/fixtures/`) are small self-contained repos
   (TypeScript via `node --test`, Python via `unittest`, both stdlib-only,
   nothing to install) with three pre-existing passing tests, one seeded
   failing test, a golden patch, and a symptom-only task prompt. The
   prompt names the failing behavior, never the location.
2. **Runner** (`swe_fix/runner.py`) copies a fixture to a temp dir, runs
   the agent headless (`--mode json`, `--cwd` at the fixture, task prompt
   from the fixture), then records the post-state. Fixture tests are
   restored to pristine before the post-run suites, so an agent that
   edits tests cannot mask a failed fix.
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
`fixture.json` (test command, target test command, test files,
allowed files).
