# Model-facing surface contract

Ground truth for the RLM-1 post-training surface. Derived from the live TS product instance.

## System prompt structure

The system prompt is layered (roadmap item 3; TS-prompt parity is superseded):
a cache-stable static prefix of human-editable layer files, followed by one
dynamic tail that carries every session-specific value.

Static prefix (byte-identical across sessions; provider-cacheable):

1. `prompts/layers/core.md` — the harness description and the full
   programmatic-tool API surface (one tool: `ipython`; everything else is a
   programmatic tool in the REPL: `bash`/`edit`/`websearch`/`attach_image`,
   `rlm.*` subagent management, `agent_message`/`agent_observe`, the
   continual-harness CRUD, `compact`/`goal`/`rlm_heartbeat`/`refine`,
   generic `mcp`), plus the skill contract.
2. `prompts/layers/usage.md` — mandatory usage rules (bash backgrounding,
   edit usage, delegation, refinement policy, root-agent progress rules).
3. `prompts/layers/opinionated.md` — style and engineering guidelines the
   user may override with clear intent.
4. `prompts/layers/per_model.md` — per-model instruction blocks keyed by
   model selector patterns (shipped empty; the mechanism is live).

Dynamic tail, appended in order: pre-installed packages, project context
(AGENTS.md), skills inventory (`<available_skills>`), generic MCP servers,
environment (date, cwd, conversation log, image-input capability), session
role (recursive depth, parent, spawning availability), additional guidance,
appended prompt.

The harness digest (`[harness-digest]` message) stays a separate user
message at cold-context boundaries, after the system prompt.

Observability: `prime-agent prompt [--model <selector>] [--cwd <dir>]
[--json]` prints the per-layer breakdown (cached static layers, then the
dynamic tail) followed by the fully-assembled prompt. Guard tests pin the
cache boundary (`prompt_guards.rs`) and the documented tool surface against
the real registered surface (bootstrap bindings, host requests, bundled
skills).

## Tool names exposed to the model

`bash`, `edit`, `ipython` (+ internal: `rename`, `stdout`).

## RLM kernel API (in the persistent Python REPL)

- `rlm.spawn(task, name)` -> child handle; `rlm.create_session('task', name=...)` (depth-0 only)
- `rlm.find_models(pattern)`; `rlm.list_subagents()`; `rlm.collect(targets, timeout_ms=0)`
- `rlm.delete_subagent(handle)`; `rlm.progress_note(...)`
- `rlm.harness`: create/update/delete for memory, skill, subagent, prompt_note;
  `record_refinement()`, `overview()`; `global_=` flag for cross-session entries
- `rlm.get_harness_state()`
- `agent_message.send(message, receiver_role=..., receiver_name=...)`
- `agent_observe.list_agents()` + bounded observation
- `goal` module: active goal read/complete
- `compact` module: context compaction
- `refine.run()`: turns patterns into harness entries (runs at turn end, returns immediately)
- `attach_image(path)`: loads an image into model context
- `bash(cmd)` background handles; `edit(path, old_str, new_str)` targeted edits

## Skill contract

Each skill has a SKILL.md with API docs; Python skills are pre-imported into the kernel
namespace; CLI fallback exists per skill. Skills listed in the system prompt with name, type,
python_import, description, location. Relative paths in SKILL.md resolve against the skill dir.

## Conversation log layout

`~/.prime/agent/sessions/<session-id>.jsonl` — append-only; one JSON object per line.
Session artifacts under `~/.prime/agent/session-artifacts/<session-id>/`.
