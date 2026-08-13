# Dynamic Workflows

Dynamic Workflows let Prime Agent generate and launch a small Python coordinator that delegates work to multiple native Prime Agent sessions. The coordinator handles fan-out, staging, and result consolidation; child agents retain the normal model and tool machinery.

## Start a workflow

Use one of these human-origin entry points:

```text
ultracode: review the authentication and billing changes in parallel
use a workflow to audit every package and consolidate the findings
/workflow security-review {"scope":"src"}
```

Set `disableWorkflows: true` in project or user settings, or `PRIME_AGENT_DISABLE_WORKFLOWS=1`, to remove the built-in workflow surface entirely.

`ultracode:` applies to one prompt. `/effort ultracode` enables xhigh reasoning and automatic workflow admission for the current interactive session. Leaving ultracode effort or starting another session clears it. The equivalent startup option is:

```bash
prime-agent --effort ultracode
```

Literal `ultracode:` is honored only at interactive human ingress. RPC, scheduled, extension-generated, and headless input cannot self-authorize it. `--effort ultracode` is the explicit opt-in for print/headless use.

Prime Agent shows the generated source and declared phases for approval on direct interactive launches. Session ultracode launches skip this extra approval; one-shot ultracode still requires it. Children inherit only the parent's enabled `ipython` built-in in this release; workflows fail closed for unsupported isolation and named-agent modes.

The Workflow tool always returns a launch acknowledgement immediately. `taskId` controls the active workflow within the originating session, while `runId` identifies durable state and resume history. A validation error still has `status: "async_launched"` and an `error` field, but no coordinator runs. Final output arrives in a later `workflow-complete` message.

## Python coordinator format

A workflow is a `.py` file whose first statement assigns literal metadata:

```python
meta = {
    "name": "review-changes",
    "description": "Review changed areas in parallel and consolidate findings",
    "phases": [
        {"title": "Review"},
        {"title": "Synthesis"},
    ],
}

phase("Review")
reviews = await parallel([
    lambda: agent(
        "Review authentication changes. Return concrete findings.",
        label="Authentication",
        schema={
            "type": "object",
            "properties": {"findings": {"type": "array", "items": {"type": "string"}}},
            "required": ["findings"],
        },
    ),
    lambda: agent("Review billing changes.", label="Billing"),
])

phase("Synthesis")
return await agent(
    "Consolidate these reviews and remove duplicates:\n" + str(reviews),
    label="Synthesis",
)
```

Metadata requires non-empty `name` and `description`. Optional `title`, `whenToUse`, and `phases` control discovery and progress display. A phase's optional `model` field is display metadata; routing comes from the `agent(model=...)` option. Metadata is data, not executable Python: calls, computed values, and reserved dictionary keys are rejected.

The workflow body has these names:

| Name | Behavior |
|------|----------|
| `await agent(prompt, ...)` | Runs one native Prime Agent child and returns text, structured JSON, or `None` after a terminal child failure. |
| `await parallel(thunks)` | Starts callable slots concurrently, waits for all, preserves input order, and converts a failed slot to `None`. |
| `await pipeline(items, *stages)` | Runs every item through all stages without a cross-item barrier. Each stage receives `(previous, original, index)`. |
| `phase(title)` | Groups subsequent child agents under a progress phase. Prefer an explicit agent `phase=` inside concurrent code. |
| `log(message)` | Adds a bounded progress line. |
| `args` | The JSON argument supplied at launch; omitted arguments are Python `None`. |
| `cwd` | The logical session working directory as a string. It is not a filesystem capability. |
| `budget` | Exposes `total`, `spent()`, and `remaining()` for a configured token target. |

Agent options are `label`, `phase`, `schema`, `model`, `effort`, `isolation`, `agent_type`, and `timeout_ms`. Model selectors use `provider/model` with an optional `:thinking` suffix. Explicit `effort` supports `low`, `medium`, `high`, `xhigh`, and `max`. `schema` installs a terminating, schema-validated `workflow_output` tool in the child session.

Worktree/remote isolation and named agent types are declared for forward compatibility but currently fail closed with a visible agent error; Prime Agent does not silently pretend to apply them.

## Saved workflows

Project workflows live in:

```text
.prime/agent/workflows/<name>.py
```

Prime Agent loads existing workflow directories from the working directory up to the repository root. The closest project definition wins, followed by the personal definition:

```text
~/.prime/agent/workflows/<name>.py
```

Use:

```text
/workflow <name> [JSON args]
/workflow ./path/inside/project/workflow.py [JSON args]
/workflows save <run-id> <name> [project|user]
```

Direct `scriptPath` files must remain inside the session working directory, use `.py`, and contain no symlink traversal. Saving also refuses symlinked workflow directories and targets.

## Progress and control

Bare `/workflows` opens the interactive workflow inspector. Select a run to see its planned phases and agents side by side, then open an agent for its model, effort, prompt, duration, token/cost usage, result, or error. The inspector retains the transport-compatible selector fallback when the connected client does not advertise the workflow panel capability.

Natural model requests such as `4.1 GPT` are resolved only against models available from configured providers and subscriptions. When one matching subscription model is available, workflow agents use it instead of silently inheriting the session model; use `provider/model` when multiple matches remain ambiguous.

```text
/workflows list
/workflows status <run-id>
/workflows stop <task-id-or-run-id>
/workflows resume <run-id>
/workflows save <run-id> <name> [project|user]
```

Run records persist the source, arguments, status, phases, bounded logs, per-agent prompt/result previews, usage, and final result under the configured agent directory. Source is stored as `script.py`, metadata as atomic `run.json`, and agent lifecycle events in append-only `journal.jsonl`.

Resume is deliberately same-session and stop-first. Stop the active task, wait until its status is `stopped`, then resume the run. Replay follows agent start order: only the longest completed prefix is reused. If A, B, C, and D started and B was unfinished, only A replays; B, C, and D run again even if C or D completed before the stop. Script, prompt/options, repository state, model, effort, and tool-policy identity participate in replay safety.

## Coordinator security boundary

Generated coordinators do **not** run in Prime Agent's persistent IPython kernel. They run in a dedicated `@pydantic/monty/node` native worker with a narrow async host-capability surface. Prime Agent does not fall back to CPython, IPython, or a WASM runtime when Monty's native worker is unavailable.

The coordinator receives no file mount, environment, network, subprocess, generic host request, or native AgentSession handle. Imports, private/dunder access, `open`, dynamic evaluation, and API-name redefinition are rejected before execution. Host-side code independently limits concurrency, total agents, prompts, schemas, arguments, logs, results, wall time, coordinator CPU, memory accounting, recursion, and token targets. Cancellation aborts active child sessions and kills the checked-out Monty worker.

This is a capability sandbox, not a kernel or virtual-machine boundary. Monty is experimental native software. Its allocator memory limit is not an OS RSS/cgroup guarantee, and a vulnerability in the native interpreter could execute with the Prime Agent user's OS identity. Do not use Dynamic Workflows as a hostile multi-tenant boundary without an additional process/container sandbox.

Current coordinator limits include 16 concurrent agents, 1,000 total agents, a 1,000,000 live-agent token budget, 256 KiB source, 1 MiB arguments, 128 KiB per prompt, 256 KiB per schema, 4 MiB per result, 64 MiB aggregate agent results, 1 MiB total logs, a 30-minute wall limit, 15 coordinator CPU seconds, 64 MiB allocator-accounted memory, and recursion depth 200. Some values are Prime-specific safety policy rather than Claude compatibility promises.

## Compatibility scope

Prime Agent follows the documented Claude Dynamic Workflows launch, background-task, human-origin, progress, and ordered-resume semantics where they map to Prime's harness. The coordinator language and saved paths are intentionally Prime-native:

- Python instead of JavaScript.
- Monty instead of a JavaScript isolate.
- `.prime/agent/workflows` instead of `.claude/workflows`.
- Python `None` instead of JavaScript `undefined` for omitted `args`.

Prime does not claim parity with undocumented Claude Code internals.

## Native backend availability

Dynamic Workflows require Monty 0.0.19's native addon and worker executable. Prime fails closed rather than using WASI, CPython, IPython, or QuickJS. Supported packaged targets are macOS arm64/x64, glibc Linux arm64/x64, and Windows x64; other platforms remain usable when workflows are disabled.
