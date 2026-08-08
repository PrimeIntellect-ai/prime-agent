# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` in the repo root is the authoritative contribution guide (git rules for parallel agents, changelog format, provider-addition checklist, release process). Read it before committing. This file covers commands and architecture.

## Commands

```bash
npm run check        # biome (format+lint, --error-on-warnings) + tsgo --noEmit + installer/browser smoke checks
```

Run `npm run check` from the repo root after every code change and fix all errors, warnings, and infos. It does **not** run tests. It also runs as a pre-commit hook (`.husky/pre-commit`), which restages formatter-modified files.

Do not run `npm run dev`, `npm run build`, or `npm test` unless the user asks. Run only focused tests, from the *package* root:

> This repo rule overrides any global "run the full test suite before claiming done" default. Here, `npm run check` is the standard post-change gate; the full suite is opt-in and the user asks for it. If you create or modify a test file you must still run *that file* and iterate until it passes.

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Package test entrypoints (what CI runs, all from the package dir):

| Package | Command | Runner |
|---|---|---|
| `packages/agent`, `packages/ai`, `packages/coding-agent` | `npm test` | vitest |
| `packages/tui` | `npm test` | `node --test --import tsx` |
| `packages/coding-agent` (CI shards) | `npm run test:ci -- --shard=1/3` | bootstraps the kernel, excludes the process suite |
| `packages/coding-agent` | `npm run test:process` / `npm run test:kernel` | isolated daemon-process and kernel-heavy suites |

`./test.sh` runs the whole suite with `auth.json` moved aside and every provider env var unset — that is the only sanctioned full-suite path, and it touches `~/.prime/agent/auth.json`.

### Running from source

```bash
./prime-agent.sh              # tsx against packages/coding-agent/src/cli.ts; preserves the caller's cwd
./prime-agent.sh --dist       # the bundled build (~3x faster startup); requires npm run build first
./prime-agent.sh --no-env     # unset all provider API keys first
PRIME_AGENT_CODING_AGENT_DIR=/tmp/pa-dev ./prime-agent.sh   # isolated config dir; use when exercising daemon behavior
```

Requires Node >= 22.8.0, plus `ripgrep`, `fd`, and `uv` (for the Python kernel venv) on PATH.

## Architecture

Four npm workspaces, layered bottom-up. Root `tsconfig.json` maps the package names to `src/`, so cross-package imports resolve to sources, not `dist/`.

- **`packages/tui`** — terminal UI primitives: differential renderer, editor component, keybindings, autocomplete. No agent knowledge.
- **`packages/ai`** — unified LLM API. `stream.ts` + `providers/*.ts` normalize every provider into one `AssistantMessageEventStream` (`text` / `tool_call` / `thinking` / `usage` / `stop`). Providers are lazily registered in `providers/register-builtins.ts`; credentials are detected in `env-api-keys.ts`. `providers/faux.ts` is the deterministic test provider.
- **`packages/agent`** — provider-agnostic agent loop (`agent-loop.ts`, `agent.ts`): tool execution, queueing, state, transport abstraction.
- **`packages/coding-agent`** — the Prime Agent product: CLI, daemon, session persistence, IPython kernel, TUI modes, skills, extensions, MCP.
- **`prime-agent-runtime/`** — the Python side (`rlm` package) copied into `dist/` at build time and installed into the managed kernel venv.

### Process topology (packages/coding-agent)

Execution never lives in the client. `docs/architecture.md`, `docs/daemon.md`, `docs/agent-connection.md`, and `docs/rlm-runtime.md` are the reference; the shape is:

```
client (interactive TUI / print / JSON / RPC)
  └─ AgentConnection            src/modes/agent-connection/   client-side execution boundary
      └─ daemon supervisor      src/modes/daemon/             sockets, routing, attachments, health, agent-message delivery
          ├─ catalog subprocess                               saved-session scans (failures don't touch live workers)
          └─ session worker     one root session tree per process
              └─ AgentSessionRuntime → AgentSession → IPython kernel + RLM child sessions
```

- `AgentSession` (`src/core/agent-session.ts`) owns provider calls, queues, tools, compaction, goals, child lifecycles, and transcript writes. It is the center of gravity of the codebase.
- `AgentConnection` is a TypeScript intent interface, **not** the wire protocol. `DaemonAgentConnection` is the normal local adapter; `InProcessAgentConnection` is the SDK/fallback path. Both must satisfy the same interface.
- Workers and kernels are separate processes for lifecycle and failure containment — **not** a security sandbox. Model-generated Python runs with the user's permissions.
- Sessions are leased by canonical JSONL path so two writers can never share a transcript.

### RLM (recursive subagents)

`await rlm("prompt", name=..., model=...)` in the model's IPython cell travels over a Jupyter comm target (`host.request`) → `KernelManager` (`src/core/kernel/index.ts`) → typed dispatch in `src/core/rlm-runtime.ts` → `AgentSession.runRlmChild()`. The call returns a spawn handle at *admission*; it never returns the child's answer — results come back as explicit `agent_message` replies or files. Host-request responses go on the Jupyter **control** channel; using shell would deadlock the awaiting cell.

State ownership: the TypeScript host owns models, credentials, depth limits, the child registry, and usage attribution. The Python `rlm` shim is a thin bridge with no agent loop. Bundled Python skills (`goal`, `agent_message`, harness) are likewise host-bridge clients.

### Local models

There is no built-in Ollama / LM Studio / vLLM provider and nothing auto-detects a local server. Local models are custom providers in `~/.prime/agent/models.json`, loaded by `ModelRegistry` (`src/core/model-registry.ts`) and pointed at the local OpenAI-compatible endpoint:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`id` is the only required model field — `ModelDefinitionSchema` defaults the rest specifically for local models. Any `api` the repo supports works (`openai-completions`, `openai-responses`, `anthropic-messages`, Google Generative AI); anything needing a custom API implementation or OAuth belongs in an extension (`docs/custom-provider.md`).

Two things to preserve when touching this path:

- **`compat` flags.** Many OpenAI-compatible servers reject the `developer` role and `reasoning_effort`; `compat.supportsDeveloperRole` / `compat.supportsReasoningEffort` (provider- or model-level) fall back to a `system` message and drop the effort param.
- **Overflow matchers.** `packages/ai/src/utils/overflow.ts` carries per-server context-overflow regexes (llama.cpp, LM Studio, Ollama). Adding a backend usually means adding a matcher; Ollama truncates silently in some setups and cannot be detected at all.

Test caveat: `packages/ai/test/stream.test.ts` and `test/context-overflow.test.ts` shell out to a real local `ollama` binary — including `ollama pull gpt-oss:20b` — when one is on PATH. Set `PI_NO_LOCAL_LLM=1` to skip those blocks (`./test.sh` already does).

#### Ollama setup notes

Two non-obvious things decide whether a local model works here at all.

**The model must support tool calling.** Prime Agent drives everything through the IPython tool, so a completion-only or vision-only model cannot function as the agent no matter how it is configured. Check with `ollama show <model>` and look for `tools` under Capabilities before adding it to `models.json`.

**The declared `contextWindow` must match what the server actually serves.** Ollama's default is 4096 regardless of the model's maximum, and it truncates silently rather than returning an overflow error — so a config claiming 32768 against a 4096 server degrades output with no diagnostic. 4096 is too small for the system prompt alone. Verify the real number by loading a model and reading the `CONTEXT` column:

```bash
ollama ps
```

Raise the server side with `OLLAMA_CONTEXT_LENGTH`. Under a Homebrew launchd install, add it to the existing `EnvironmentVariables` dict and reload with `launchctl`, not `brew services restart` — the latter regenerates the plist from the formula and silently drops every custom variable (including `OLLAMA_FLASH_ATTENTION` and `OLLAMA_KV_CACHE_TYPE`), dropping you back to 4096:

```bash
P=~/Library/LaunchAgents/homebrew.mxcl.ollama.plist
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_CONTEXT_LENGTH string 32768" "$P"
launchctl unload "$P" && launchctl load "$P"
```

`OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves KV-cache memory, which is what makes a long context affordable on a laptop. The setting is global to the Ollama server, so every model loads at that context.

End-to-end check once configured:

```bash
prime-agent model list ollama                                    # provider and models resolve
prime-agent --provider ollama --model <id> --no-session -p "hi"  # round-trip through the agent
```

#### MLX on Apple Silicon

`mlx_lm.server` exposes an OpenAI-compatible endpoint and works as a provider with no special handling — same `openai-completions` api and same `compat` flags as Ollama. Tool calling is supported: it returns a well-formed `tool_calls` array with `finish_reason: tool_calls`, and the full agent loop drives IPython through it.

```json
"mlx": {
  "baseUrl": "http://127.0.0.1:8080/v1",
  "api": "openai-completions",
  "apiKey": "mlx",
  "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
  "models": [{ "id": "mlx-community/Qwen3-14B-4bit", "contextWindow": 32768 }]
}
```

Unlike Ollama, MLX applies no artificial context cap — it serves the model's own `max_position_embeddings`, so read that from the model's `config.json` in the HuggingFace cache rather than probing the server, which does not advertise a window over `/v1/models`.

On throughput, do not assume MLX wins. Measured on an M4 / 24 GB, `Qwen3-14B-4bit` on MLX ran at 11.5 tok/s against 12.9 tok/s for the 9.7B `qwen3.5:9b` on Ollama — MLX was slower in absolute terms while carrying 44% more parameters. Benchmark the specific model pair before switching; published 2x figures compare Ollama's own Metal and MLX backends on identical models, which is a different measurement.

Ollama's built-in MLX backend (0.19 preview, 0.30 stable) is a separate thing from `mlx_lm.server` and requires more than 32 GB of unified memory, so it is unavailable on smaller machines regardless of Ollama version.

### Config and asset resolution

User config: `~/.prime/agent/` (sessions, session-artifacts, auth.json, kernel-venv, logs). Project config: `.prime/agent/`. Overrides: `PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_SESSION_DIR`.

Always resolve packaged assets through `src/config.ts` helpers (`getPackageDir`, `getThemeDir`) — the same code runs from source, from `dist/`, and from a bundled release artifact, so `__dirname` is wrong.

### Naming

"Prime Agent" is the product and repo; the workspaces keep inherited `@earendil-works/pi-*` names, a `pi` bin entry, a `pi` manifest key, and some `PI_*` env vars. `scripts/pack-prime-agent-release.mjs` rewrites those for the public release tarball. Never document the npm workspace package as the install path.

## Conventions that bite

- **No inline imports.** No `await import("./foo.js")`, no `import("pkg").Type` in type positions. Top-level imports only.
- **Never edit `packages/ai/src/models.generated.ts`** — change `packages/ai/scripts/generate-models.ts` instead. It is fine to include the generated file in an otherwise unrelated commit.
- **Never hardcode key checks** (e.g. `matchesKey(keyData, "ctrl+x")`). Add a default to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`; all bindings are configurable.
- **No empty `catch {}`** without an explanatory comment — `test/no-silent-catch.test.ts` scans every `packages/*/src` for it.
- **Daemon wire changes** (`src/modes/daemon/daemon-protocol.ts`): classify as backward-compatible, capability-gated, or incompatible. Bump `DAEMON_PROTOCOL_VERSION` for incompatible changes, update `DAEMON_SCHEMA_REVISION` and the command/event compatibility maps for every wire change, and update both new-client/old-daemon and old-client/new-daemon tests. New commands may never become part of startup without a protocol or capability gate.
- **Tests under `packages/coding-agent/test/suite/`** must use `test/suite/harness.ts` plus the faux provider — no real provider APIs, keys, or network. Issue regressions go in `test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- **Changelogs** live per package (`packages/*/CHANGELOG.md`). New entries always go under `## [Unreleased]` as flat one-line bullets starting with a past-tense verb; released sections are immutable. All packages are versioned in lockstep.
- **Dependencies** carry a 7-day minimum release age (`.npmrc` `min-release-age=7`, enforced only by npm >= 11.10). Do not bypass it for routine updates.
