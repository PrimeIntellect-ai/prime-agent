---
name: factory
description: Author and run state-machine workflows of spawned child agents. Store a validated machine or dag spec as a continual-harness factory entry (rlm.harness.create_factory), then run, watch, stop, and resume it through rlm.factory. Use for fan-out, bounded review/fix loops, joins, and per-item sweeps that outgrow flat rlm.spawn calls.
---

# Factory

The factory runs state-machine workflows of spawned child agents. A stored
factory entry declares the machine — states, each backed by a subagent
spec, plus guarded transitions between them. `await rlm.factory.run('<spec_id>')`
spawns each state's subagent as an ordinary child, feeds captured outputs
into the successors' prompts, and drives the run to quiescence in a
background kernel task; the call returns immediately and the run continues
after the model turn ends. Use it when a workflow needs shape: fan-out,
bounded loops (review/fix until a verdict approves), joins, or one child
per list item.

## Store the spec

A factory spec is a continual-harness entry of kind `factory`.
`rlm.harness.create_factory(...)` validates at write time; an invalid spec
is never stored (generic `create`/`update` funnel through the same check).
The spec rides `machine=` (the native form) or `dag=` (sugar that compiles
to machine form) — pass exactly one. This review/fix loop is the shipped
pr-manager shape:

```python
rlm.harness.create_factory(
    "pr-manager",
    "Drive a PR through review/fix cycles, then keep a resident watcher on it.",
    id="pr-manager",
    machine={
        "run": {"budget_ms": 1_800_000, "max_parallel": 8, "max_transitions": 24},
        "states": [
            {
                "id": "entry", "entry": True,
                "subagent": {"prompt": (
                    "Identify the pull request for the current branch with "
                    "`gh pr view --json url`. Return a fenced json block of the form "
                    '{"pr_url": "https://github.com/owner/repo/pull/N"}. '
                    "Output only the json block.")},
                "outputs": [{"name": "pr_url", "type": "json"}],
            },
            {
                "id": "reviewing",
                "subagent": {"prompt": (
                    "Review the pull request at {pr_url} for merge-blocking "
                    "defects with `gh pr diff`. When a fix report is bound below, "
                    "verify the described fixes landed. Return a fenced json block "
                    'of the form {"verdict": {"approved": <true|false>, '
                    '"findings": ["one sentence per finding"]}}. '
                    "Output only the json block.")},
                "inputs": [
                    {"name": "pr_url", "type": "json", "from": "entry.pr_url"},
                    {"name": "fix_report", "type": "json", "from": "fixing.fix_report", "optional": True},
                ],
                "outputs": [{"name": "verdict", "type": "json"}],
                "max_entries": 4,
            },
            {
                "id": "fixing",
                "subagent": {"prompt": (
                    "Address the review findings in the verdict below. Make the "
                    "smallest targeted fixes, run the relevant tests, and return a "
                    "fenced json block of the form "
                    '{"fix_report": {"fixed": ["finding that was addressed"], '
                    '"skipped": ["finding left alone and why"]}}. '
                    "Output only the json block.\n\n{verdict}")},
                "inputs": [{"name": "verdict", "type": "json", "from": "reviewing.verdict"}],
                "outputs": [{"name": "fix_report", "type": "json"}],
                "max_entries": 3,
            },
            {
                "id": "monitoring",
                "subagent": {"prompt": "Stay resident as the watcher for {pr_url}: "
                    "report the `gh pr checks` state once, then remain available for "
                    "follow-up questions."},
                "inputs": [{"name": "pr_url", "type": "json", "from": "entry.pr_url"}],
                "lifecycle": "resident",
            },
        ],
        "transitions": [
            {"from": "entry", "to": "reviewing"},
            {"from": "reviewing", "to": "fixing",
             "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False}},
            {"from": "reviewing", "to": "monitoring",
             "when": {"output": "verdict", "path": "approved", "op": "eq", "value": True}},
            {"from": "fixing", "to": "reviewing"},
        ],
    },
)
```

The example exercises the core forms: `entry` is an entry state; the two
guards select the next state from the reviewer's `verdict`; `fix_report` is
optional, so the reviewer's first entry binds a null sentinel before the
fixer ever runs and its re-entry re-binds the real report; `max_entries`
bounds the loop; `monitoring` is a `resident` that stays alive under the
parent session after the run ends.

## Authoring reference

- **States**: 1 to 1024, unique ids matching `^[a-z0-9][a-z0-9-]{0,63}$`; at
  least one state carries `"entry": true`, and entry states declare no
  inputs. A state's `subagent` is a harness subagent entry id or title (its
  content is the prompt template; `metadata.model`/`metadata.thinking` are
  spawn settings) or an inline `{"prompt": ...}` object with optional
  `name`/`model`/`thinking`.
- **Ports**: inputs and outputs of type `text` or `json`. An input binds
  `"from": "<state_id>.<output_name>"`; types must match, duplicates are
  rejected, and nothing can read from a resident. Bound values render into
  `{input_name}` placeholders (one pass; inputs without a placeholder are
  appended in a trailing `## Inputs` section). A required input whose source
  has not settled yet keeps the entry pending; `"optional": true` binds a
  null sentinel instead. A required self-input is rejected at validation —
  `state X input 'name' cannot require itself: mark the self-input optional
  - a required one can never bind on the state's first entry` — while an
  optional self-input is the designed self-loop form (first entry binds
  null, re-entries bind the previous settle).
- **Transitions**: `{"from": ..., "to": ..., "on": "settled", "when": ...}`.
  Each settle is evaluated exactly once and every guard that passes fires
  (fan-out is legal); a fire onto a state at `max_entries` is recorded as a
  blocked transition. `from` may be a list of states: a join that fires
  once every source settled — once per source-settle combination — and may
  not carry a guard. Guards are `{"output": ..., "path": ..., "op": ...,
  "value": ...}` over the from-state's latest settle: `op` is one of `eq`,
  `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`; `path` drills a
  dotted path into a `json` output; `eq`/`ne` compare JSON-strictly (a
  boolean never equals a number), comparison ops need a numeric value,
  `contains` a non-empty list, `exists` no value, and a missing or
  unparseable port fails every op except `exists`. A failed settle still
  fires guard-less transitions, so dependents under `continue` run; their
  required input over the failed source then fails the dependent entry.
- **Cycles are legal**: there is no acyclicity requirement — self-loops and
  back edges validate. The one rule is an entry state somewhere; a dag
  whose every node depends on another compiles to no entry states and is
  rejected.
- **foreach**: `{"over": "<input>", "max": 1..256}` expands one entry into
  one child per item of the named `json` input (clamped at `max`), each
  child rendered with its item bound as that input; an empty list settles
  the entry with no children.
- **Residents**: `"lifecycle": "resident"` states declare no outputs, no
  foreach, and no outgoing transitions, nothing reads from them, and their
  instance stays alive under the parent session after the run completes
  (stop the run to retire it).
- **Bounds and policies**: `run.max_parallel` (1..64, default 8) is the
  run's global budget of simultaneously running instances — not a
  per-node limit. `run.max_transitions` (default 10 per state, capped at
  10,000) pauses the run once at the boundary, mid-settle; `resume`
  continues after the transitions that already fired without re-firing
  them. `run.budget_ms` pauses the run once when exceeded (in-flight
  children keep running). Per state: `max_entries` (default 1), `retries`
  (0..10, same rendered prompt), `budget_ms` (admission to settlement;
  exceeding it fails the attempt without a retry), and `failure_policy` —
  `fail_fast` (cancel every child, run failed), `continue` (entry stays
  errored; the run finishes and reports failed if any state errored), or
  `escalate` (the default: pause the run; resuming is the operator's
  decision).
- **Dead configurations fail loudly, never wedge**: a pending entry whose
  input source never settled, a `max_parallel` cap held entirely by
  never-settling residents with work queued, or nothing in flight and
  nothing pending each end the run as failed with the reason in the
  ledger. `wait` blocks on states are rejected at validation (not
  supported yet).

## Dag form

Sugar, not a second semantics: each node becomes a state entered once, a
node with no effective dependencies becomes an entry state, and the full
dependency set — `depends_on` plus every `inputs[].from` source — compiles
to ONE join transition, so a fan-in node waits for every parent. The
shipped review-sweep shape:

```python
rlm.harness.create_factory(
    "review-sweep",
    "Sweep the branch's changed files for findings, then merge them into one list.",
    id="review-sweep",
    dag={
        "run": {"budget_ms": 900_000, "max_parallel": 8},
        "nodes": [
            {
                "id": "files",
                "subagent": {"prompt": (
                    "List every file the current branch changes relative to the "
                    "base branch. Return a fenced json block of the form "
                    '{"files": ["path/to/file", ...]}. Output only the json block.')},
                "outputs": [{"name": "files", "type": "json"}],
            },
            {
                "id": "review",
                "subagent": {"prompt": (
                    "Review the changed file {files} for merge-blocking defects: "
                    "correctness bugs, regressions, unhandled error paths, missing "
                    "tests. Reply one short line: `<path>: <the most serious "
                    "problem, or 'clean'>`.")},
                "inputs": [{"name": "files", "type": "json", "from": "files.files"}],
                "outputs": [{"name": "found", "type": "text"}],
                "foreach": {"over": "files", "max": 8},
            },
            {
                "id": "report",
                "subagent": {"prompt": (
                    "Merge the review lines below into one fenced json block of "
                    'the form {"issues": [{"file": "path", "finding": "..."}]} '
                    "listing every file that is not clean. Output only the json "
                    "block.\n\n{found}")},
                "inputs": [{"name": "found", "type": "text", "from": "review.found"}],
            },
        ],
    },
)
```

## Run, watch, steer

```python
result = await rlm.factory.run("pr-manager")
# {"run_id": "...", "spec_id": "pr-manager", "nodes": 4, "max_parallel": 8,
#  "started": ["entry"], "pending": []}  — returns immediately.

status = await rlm.factory.status(result["run_id"])
status["state"]    # running | stopping | paused | done | failed | stopped
status["nodes"]    # per state: status, entries_used/max_entries, instances,
                   # latest answer_preview, error
status["events"]   # trailing ledger: spawned, settled, answer_captured,
                   # transition_fired, node_error, milestone, ...
status["usage"]    # spawns, settled, tool_uses, running, transitions_fired

snapshot = await rlm.factory.watch(result["run_id"], 30)
# Blocks until the run's state/instance shape changes or the timeout
# elapses (capped at 60s), then returns the same fused snapshot as graph()
# plus "changed": whether a change or the deadline ended the wait.

runs = await rlm.factory.graph()                   # every live run, oldest first
live = await rlm.factory.graph(result["run_id"])   # one run: structure + live state
spec = await rlm.factory.graph("pr-manager")       # a spec id: static structure
```

- `run` re-validates the spec and resolves every subagent reference first,
  reporting all failures in one `ValueError` and starting nothing on any
  failure; `name=` labels the run in status and the TUI.
- Pause and failure notices (escalate, budget, max_transitions, failed,
  finished) arrive as quiet notices in the conversation once per kind per
  run, the pause notices with the resume call spelled out — a paused run
  does not need polling to be noticed.
- `stop(run_id)` cancels every running child of the run (idempotent);
  `resume(run_id)` continues a paused run and raises on a non-paused one.
- The activity lane the daemon and TUI speak is camelCase on the wire
  (`runId`, `specId`, `timeoutMs`); the kernel API here
  (`rlm.factory.*`) is snake_case.

## Discovering machines

- The machine library (arriving on the stacked machine-library PR):
  machines are `MACHINE.md` files, one directory per machine under the
  repository's `machines/` and a personal `machines/` library under the
  agent dir; `prime-agent factory list | import | export` manages them. The
  seeds are `builder`, `pr-manager`, and `review-sweep`; the worked
  examples above derive from their shapes.
- The TUI factory page: the activity dock's `⚙ N factory` group (Enter or
  click) opens one live diagram per run, newest run first. `j`/`k` move the
  selection, `s` stops the selected run, `r` resumes it, `m` copies it as
  Mermaid source, Esc closes.

## Safety

- Every state spawns real children that spend budget. Bound loops with
  `max_entries` and `max_transitions`; the default `escalate` policy pauses
  instead of failing, so read `status` (or the notice) before resuming.
- Captured answers are capped previews (about 160 characters) and outputs
  bind from them: keep declared outputs compact — a small fenced json
  block or one short line — and let the full answer live in the child's
  session.
- Run registries live in kernel memory: a kernel restart loses `status`
  and `graph` for old runs, but the children keep running under the
  supervisor (`rlm.list_subagents` sees them). Stop runs before
  restarting, or delete the children by hand afterwards.
- Residents outlive their run; stop the run (or tear down the session) to
  retire them. Prefer `rlm.factory.stop(run_id)` over deleting a factory
  child by hand — the executor claims and cancels children itself, and a
  hand deletion surfaces as a child failure through the state's policy.
