# RLM Programming Model

Prime Agent is built around a recursive language model (RLM) runtime: the model works inside a persistent Python control environment and composes capabilities as code. Provider calls, session persistence, child lifecycles, scheduling, and safety policy remain in the TypeScript host; IPython is the model-facing programming surface.

## RLM Loop

```mermaid
flowchart LR
    task["Task + working context"]
    parent["Parent model"]
    kernel["Persistent IPython kernel"]
    data["Files · data · shell commands"]
    skills["Python-backed skills"]
    children["rlm(...) child agents"]
    answer["Answer or next turn"]

    task --> parent
    parent -->|"IPython call"| kernel
    kernel <-->|"inspect · search · transform"| data
    kernel <-->|"call functions"| skills
    kernel -->|"spawn focused work"| children
    children -->|"agent messages · files"| parent
    kernel -->|"admission handle"| parent
    parent --> answer
```

The parent keeps its own context focused while Python holds working state and child agents receive only the context needed for their subtasks.

## Core Invariants

### 1. Execution is programmatic

The default RLM runtime exposes one built-in model tool: `ipython`. Reading and editing files, running project commands, transforming results, invoking skills, and delegating work all begin from that persistent kernel instead of separate built-in tool calls.

Python state survives across tool calls and compaction. Variables, imports, functions, parsed results, and task handles remain available on later turns:

```python
from pathlib import Path

config_files = list(Path(".").rglob("*.toml"))
large_files = [path for path in config_files if path.stat().st_size > 10_000]
```

Use provider turns for judgment rather than for each already-known operation. Once the source scope and sequence are known, combine adjacent deterministic reads, searches, transformations, and focused checks in one cell, retain complete results in named variables, and display compact evidence. When the location is unknown, run one bounded discovery step and inspect it before batching confirmed reads. Fewer turns never replace source verification.

Run a project's normal commands through its own environment from an IPython cell:

```bash
%%bash
npm run check
```

Each `%%bash` cell is a temporary subshell, while Python state and `%cd` changes persist in the kernel. Prime Agent extensions may intentionally add custom tools, but the built-in RLM design does not require a separate model tool for every capability.

### 2. Subagents are native RLM calls

The callable `rlm` object is preloaded in the kernel. Spawn a child with a direct call:

```python
handle = await rlm(
    "Review the authentication flow for security issues",
    name="auth-reviewer",
    service_tier="default",
)
print(handle.rlm_child_id, handle.name, handle.session_dir, handle.model)
```

The call returns immediately after task admission with a child handle; it never waits for or returns the child's answer. The TypeScript host creates a normal child `AgentSession` with an independent context and session directory. The child inherits the parent model, thinking level, service tier, provider configuration, skills, tools, retry policy, and resource loader unless the call requests another configured model, thinking level, or service tier. An explicit `thinking` value must be supported by the selected child model and overrides its configured level. Valid service tiers are `auto`, `default`, `flex`, `scale`, `priority`, and `None`; `priority` is clamped to `default` for child models without fast-mode support. Explicit `service_tier` overrides must be listed in the `rlmAllowedServiceTiers` settings array; when that setting is unset, only the configured `defaultServiceTier` is allowed. Omitting `service_tier` preserves parent-tier inheritance.

Spawn independent children in separate calls and end the turn instead of awaiting completion:

```python
api_review = await rlm("Review the public API", name="api-reviewer")
test_review = await rlm("Review the test coverage", name="test-reviewer")
integration_audit = await rlm("Run the slow integration audit", name="integration-audit")
```

Results arrive only through explicit `agent_message` replies or files, never as an `rlm()` return value. Children reply when an answer is needed by executing the call in IPython; writing the call as assistant text does not deliver it:

```python
await agent_message.send(message, receiver_role="parent")
```

The parent can follow up with a retained child:

```python
await agent_message.send(
    "Check the newly added regression test.",
    receiver_role="child",
    receiver_name=api_review.name,
)
```

#### Child handles and lifecycle

An admission handle contains `rlm_child_id`, `name`, `session_dir`, and `model`. Child usage is attributed to the parent session while remaining distinguishable in context-tree reporting.

The parent-scoped child registry survives compaction, kernel restart, and parent restoration:

```python
children = await rlm.list_subagents()
for child in children:
    print(child.session_name, child.status, child.active_session_id)
```

Successfully completed daemon-backed children remain addressable while their parent session is open. Delete a child only when its context is no longer needed:

```python
await rlm.delete_subagent(children[0])
```

The default recursion depth allows a root agent to create children. Raising the configured depth allows descendants to recurse further.

### 3. Act transfers one serial task into the root world

Use Act for one inspectable action expected to take roughly 30 seconds to 5 minutes, with shorter actions preferred. The directing model keeps architecture, synthesis, decomposition, and acceptance. It inspects decisive source, diff, or test evidence after each result before choosing another action.

Bad—this incorrectly hands Act an entire multi-phase plan:

```python
await rlm.act("Implement every phase of the migration, verify everything, and ship it")
```

Good—this assigns one inspectable step:

```python
result = await rlm.act("Inspect the parser, fix the delimiter advance, run parser.test.ts, and return the diff and raw test result")
```

Set up the retained lane once with its stable working directory, editing or verification authority, return contract, and expectation of a bounded sequence. Later prompts can be terse deltas because the lane keeps its transcript:

```python
await rlm.act("In /repo, you may edit parser files and run focused tests. Return the inspected diff and raw test result. First inspect the parser.")
await rlm.act("Now run the StarPC baseline")
await rlm.act("Now fix the failing delimiter case and rerun its focused test")
await rlm.act("Now verify only; do not edit. Work from /repo/wt/review and return raw test output")
```

A delta restates any changed or ambiguous directory, authority, safety, or result-shape constraint. The directing model inspects every returned result.

One bounded Act action may use several mechanical cells to answer one inspectable question. When a predictable inspection chain would otherwise require repeated directing-model turns, choose the cheapest suitable route from the live routing policy and give it a bounded source scope: named paths, symbols, live variables, or an explicit search root and exclusions. Exact-source routes receive exact inputs; broader discovery routes receive a bounded search area. Require compact source-backed evidence and retain every branching, design, and acceptance decision in the directing model.

```python
inspection_route = "<selector chosen from the live routing policy>"
source_paths = ["src/parser.ts", "test/parser.test.ts"]
caller_census = await rlm.act(
    "Using source_paths, trace the parser definition and callers, leave the structured census in caller_census, and return compact source-backed evidence.",
    model=inspection_route,
)
```

The Act peer confirms that scope before inspection. It combines already-known operations, keeps complete intermediate objects in named variables, emits bounded counts or decisive excerpts, verifies every reported path and symbol, and returns uncertainty instead of inventing evidence.

Use the live IPython namespace as the handoff between both models. The directing model can bind clients, datasets, parsed structures, helpers, and intermediate results to clear names before calling Act. Act reuses those objects and can leave useful state in named variables for the directing model to inspect or continue after return. This preserves exact Python identity and avoids describing or reconstructing live state in prompt text.

`model` accepts the same named-role and concrete native selectors as ordinary RLM model selection. `rlmActMaxDepth` defaults to `1`, with Sol at depth 0. A scalar `rlmActDefaultModel` supplies only depth 1; an array supplies defaults in depth order. A missing entry requires an explicit selector, and an explicit selector overrides that depth's default. Invalid, unavailable, missing, and over-depth admissions fail before provider or shared-cell work.

Act retains a private model session for each admitted depth and resolved model, and gives the active session a serialized `shared_ipython` tool. Repeating a selector that resolves to the same model reuses its transcript; changing to another resolved model selects a different retained transcript, so Luna never inherits DeepSeek's conversation or vice versa. Every cell still runs in the root IPython namespace. These private sessions have no family identity, registry entry, or separate kernel. Restart restores completed transcripts and namespace state but never replays interrupted work. The first retained model at depth 1 keeps the shipped `act/session.jsonl` path; other resolved models use stable model-qualified sibling paths, and deeper depths follow the same rule below `act-depth-N`.

An actor finishes with `rlm.done(value)` in a shared cell. The identical Python object returns to its suspended caller without TypeScript serialization. When another configured depth remains, that caller may inspect the value and shared state, continue, and then return a separate exact object upward. Assign each result to avoid accidental display. A normal text response without `done` is an `ActError`; one synchronous nested chain may be active.

Act is a foreground transfer. Root prompts, cells, compaction, and continuations wait until depth 1 ends; an inner return resumes its calling Act without releasing Sol. Ordinary RLM children remain independent. Text submitted during the chain appears immediately in the normal queued-steering section, remains hidden from every Act depth, and does not interrupt it. After the outermost natural completion or failure, queued messages enter the ordinary directing-model steering lifecycle in submission order. Escape and Ctrl-C cancel the active chain deepest-to-outer. Provider and cooperative awaited Python stop on every host, with correlated synchronous-cell and managed-process-group termination on POSIX. Completed effects are not rolled back.

Supported interactive clients frame each Act depth with actor separators, render nested boundaries in chain order, and feed thinking, text, IPython, shell, and tool activity through the same parent transcript renderers. The footer names the deepest active actor. Events, JSON, RPC, ACP, and print carry `depth` plus optional `parentActId`; missing historical depth normalizes to 1. Unsupported peers retain the outer IPython fallback. No projection receives the value passed to `rlm.done()`.

### 4. Skills add programmatic capability

Prime Agent supports the Agent Skills markdown format and extends it with Python-backed skills. Both use `SKILL.md` for discovery, routing, and instructions. A Python-backed skill also contains a Python package that Prime Agent installs into the kernel environment and exposes by import name.

For a skill named `release-audit`, the model can call:

```python
report = await release_audit(repository=".", target_version="0.4.0")
```

This makes Python-backed skills a superset of instruction-only skills: they can provide guidance, scripts, references, dependencies, typed callables, and optional shell commands. They may also call `rlm(...)` themselves when a capability needs recursive delegation.

Only skill metadata is placed in the startup prompt. The agent loads the full `SKILL.md` when the task matches, then inspects and calls the documented Python API. See [Skills](skills.md) for discovery, packaging, and the built-in skill-creation workflow.

### 5. State is designed to outlive one turn

The RLM programming model assumes useful work may take many turns or continue after the terminal UI closes:

- automatic compaction summarizes older context while preserving recent messages and kernel state;
- daemon-backed workers keep active sessions running after clients detach;
- child registries and session artifacts make subagents recoverable;
- heartbeats and scheduled prompts re-enter a session later;
- persistent goals continue until the objective is complete or the user changes their state; and
- autonomous mode adds bounded continuations and optional quality gates.

See [Long-Running and Background Agents](long-running-agents.md) for these lifecycle features.

## Host Bridge

Python skills use typed host requests for capabilities whose authoritative state belongs outside the kernel. For example, the `goal`, `agent_message`, `rlm_heartbeat`, and `compact` skills call `rlm.host_request(...)`; the TypeScript host validates the request and owns the state transition.

This keeps credentials, provider execution, transcript writes, worker routing, and scheduling out of Python while retaining a programmatic model interface.

## Trust Model

The IPython kernel runs model-generated Python and project commands with the worker's operating-system permissions. It is a durable control environment, not a security sandbox. Review third-party Python skills and use an external sandbox or restricted environment for untrusted repositories and instructions.

For implementation details, see [RLM Runtime Architecture](rlm-runtime.md).
