# Extension Runner Host Design

> **DESCOPED - operator decision 2026-09-17.** Stages 3-6 of this design are
> cut and will not be built. Stages 0-2 landed and stay as harmless machinery:
> stage 0 discovery is the product-path resource resolution, and the sidecar
> host stages 1-2 ship but no product surface depends on them. Rationale:
> skills + the Python kernel packages are the product extensibility story;
> models.json covers custom providers; only one builtin extension exists
> (herdr-agent-state); the pi-ecosystem plugin surface is not a product
> requirement. See `docs/completion-matrix.md` family 13. This document stays
> as the design record for the landed stages 1-2.

Status: design; stages 1-2 landed (pa-core `extensions/` + `pa-types::extension_rpc`;
verifiers in `crates/pa-core/tests/extension_host.rs` and
`crates/pa-core/tests/extension_runner.rs`). Lane `lane/ext-design`.
TS ground truth: `~/prime-agent` (read-only). All `packages/...` paths below are
under that root. Rust paths are under `crates/`.

Scope: how the Rust product hosts user-authored TS/JS extensions. Parity
checklist entry: `docs/parity-checklist.md` §2 "Extensions / package-manager"
(the package-manager CLI half is already done in `crates/pa-core/src/packages/`;
this doc covers the remaining extension-runner gap and depends on the
resource-resolution follow-up in the same checklist entry).

Related docs: `MISSION.md` (surface contract, mechanism-rethink license),
`ARCHITECTURE.md` (crate ownership), `docs/MODEL-SURFACE.md` (the model-facing
surface that extensions may not silently break).

---

## 1. The TS extension surface that must be preserved

This section is the contract. Everything here is derived from reading the TS
sources in full; citations are per claim.

### 1.1 Discovery conventions

Sources of extension paths, in the order `resource-loader.ts` merges them
(`packages/coding-agent/src/core/resource-loader.ts` `reload()` L336-420):

1. **CLI `--extension` paths** (`-e`, repeatable), resolved through
   `packageManager.resolveExtensionSources(..., { temporary: true })`
   (`packages/coding-agent/src/core/package-manager.ts` L906). These are
   "temporary" scope and auto-refresh for unpinned git sources. `--no-extensions`
   (`-ne`) disables everything except CLI paths
   (`resource-loader.ts` L411: `extensionPaths = this.noExtensions ?
   cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)`).
2. **Configured packages + settings arrays** — the output of
   `packageManager.resolve()` (packages, settings top-level `extensions` arrays,
   auto-discovered `<base>/extensions` dirs; first-wins precedence per the
   resource-resolution spec in `docs/parity-checklist.md` §2).
3. **Auto-discovery** inside `discoverAndLoadExtensions`
   (`packages/coding-agent/src/core/extensions/loader.ts` L552-593):
   - local dir `<cwd>/{CONFIG_DIR_NAME}/extensions` first, then
     `<agentDir>/extensions` (global). `CONFIG_DIR_NAME` is
     `pkg.piConfig?.configDir || ".prime/agent"`
     (`packages/coding-agent/src/config.ts` L497).
   - Dedupe by resolved path (`addPaths` inside `discoverAndLoadExtensions`, loader.ts L552-591).
   - `discoverExtensionsInDir` (loader.ts L517-551), one level deep only:
     - direct `*.ts` / `*.js` files (symlinks included) are loaded;
     - a subdirectory with `index.ts` or `index.js` is loaded via that index;
     - a subdirectory with a `package.json` containing a `pi` object and a
       `pi.extensions: string[]` array loads the declared entries that exist
       (`readPiManifest` L451 + `resolveExtensionEntries` L477, loader.ts).
       Complex packages must use the manifest; there is no deeper recursion.
   - A configured path that is a file loads directly; a directory goes through
     the same entry resolution (loader.ts L572-591, inside `discoverAndLoadExtensions`).

The Rust port must keep the discovery order, the one-level depth rule, the
`pi.extensions` manifest shape, and the first-wins dedupe. Discovery itself is
pure path/JSON logic and ports into Rust directly (no JS needed).

### 1.2 Loading and the module surface

- Modules are loaded with **jiti** (`jiti/static`, loader.ts
  `loadExtensionModule` L328-372) so both TS and JS, ESM and CJS entry points
  work. `moduleCache: false` — extensions are re-evaluated on every reload.
- A module must export a **default factory function** `(pi: ExtensionAPI) =>
  void | Promise<void>`; anything else is the load error
  `Extension does not export a valid factory function: <path>` (loader.ts
  `loadExtension` L374-415). Any thrown error during load becomes
  `Failed to load extension: <message>` and is reported per-path, never fatal
  (`loadExtensions` L418-449: the result carries `errors: Array<{path, error}>`).
- **Import aliasing**: extensions import from `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai[...]`,
  `typebox[...]`, and the legacy `@mariozechner/*` spellings
  (`packages/coding-agent/src/core/extensions/bundled-modules.ts` — the full
  alias map; in dev mode they resolve to the workspace dist via
  `getAliases()`, loader.ts L37-110). In the compiled binary these are served as
  virtual modules so extensions share the host's module instances. Type-only
  imports erase; value imports get the host's real objects.
- The runtime is created once per load cycle (`createExtensionRuntime`,
  loader.ts L115-165): registration methods throw
  `Extension runtime not initialized...` until the runner binds real actions;
  provider registrations made during load are **queued** and flushed at bind
  time (`pendingProviderRegistrations`).

### 1.3 The `ExtensionAPI` registration surface

`createExtensionAPI` (loader.ts L168-325) and `ExtensionAPI`
(`extensions/types.ts` L1004-1197). Registration state lands on the
`Extension` object (`types.ts` L1422-1439: `handlers`, `tools`,
`messageRenderers`, `commands`, `flags`, `shortcuts`):

| API | Behavior to preserve |
|---|---|
| `on(event, handler)` | appends to `extension.handlers[event]`; no-op after ctx invalidation (assertActive) |
| `registerTool(tool)` | `tools.set(name, {definition, sourceInfo})` + `runtime.refreshTools()` |
| `registerCommand(name, opts)` | `commands.set(name, {name, sourceInfo, ...opts})` |
| `registerShortcut(key, opts)` | `shortcuts.set(key, ...)` |
| `registerFlag(name, opts)` / `getFlag(name)` | flag registry with defaults; CLI values override at runtime (`runner.setFlagValue`) |
| `registerMessageRenderer(customType, renderer)` | renderer for custom session messages |
| `registerProvider` / `unregisterProvider` | queued pre-bind, immediate post-bind; replaces/overrides models in the registry (types.ts `ProviderConfig` docs L1199-1290) |
| `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel`, `exec`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel`, `get/setThinkingLevel` | action methods; throwing stubs until `bindCore` replaces them (runner.ts `bindCore` L283-352) |
| `events` | shared cross-extension `EventBus` (`core/event-bus.ts`): `emit(channel, data)` / `on(channel, handler)` with swallowed handler errors |

`registerTool`'s `ToolDefinition` (types.ts L423-482): `name`, `label`,
`description`, optional `promptSnippet` + `promptGuidelines` (injected into the
system prompt when the tool is active), TypeBox `parameters` schema, optional
`prepareArguments` compat shim, `executionMode` (`"sequential" | "parallel"`),
`execute(toolCallId, params, signal, onUpdate, ctx)`, and optional
`renderCall`/`renderResult` TUI components.

### 1.4 Event surface

`ExtensionEvent` union (types.ts L889-902 + per-event interfaces
L489-1152). The runner has dedicated emit paths with exact semantics
(runner.ts L786-1172):

| Event | Payload (TS) | Handler result semantics | Emit site (TS) |
|---|---|---|---|
| `session_start` | `reason: startup\|reload\|new\|resume\|fork`, `previousSessionFile?` | none | `agent-session.ts` L9913 |
| `session_before_switch` / `_fork` / `_tree` / `_compact` / `_refine` | per-type prep data | `cancel?: boolean` short-circuits (and `skip` for refine) | L8418, L9345, L13297, plus fork/switch sites |
| `session_compact`, `session_tree`, `session_shutdown` | results of the action | none | L8526, L13414, `runner.emitSessionShutdownEvent` |
| `agent_start` / `agent_end` | `agent_end` carries final `messages` | none | L4486, L4490 |
| `turn_start` / `turn_end` | `turnIndex`, `message`, `toolResults` | none | L4497-4557 |
| `message_start` / `message_update` / `message_end` | `AgentMessage` (+ per-token `assistantMessageEvent`) | `message_end` may return a **replacement message, role-preserving**, chained across extensions | L4508-4528 (`emitMessageEnd`) |
| `tool_execution_start/update/end` | toolCallId, name, args/result | none | L4515-4522 |
| `tool_call` | typed per tool (`bash`/`edit`/`ipython`/custom) | `block?: boolean` short-circuits execution; `event.input` mutated **in place**, later handlers see earlier mutations, no re-validation | `emitToolCall` runner.ts L912-933 |
| `tool_result` | content blocks, `details`, `isError` | returned `{content?, details?, isError?}` patches chain onto the event | `emitToolResult` runner.ts L862-910 |
| `context` | `messages: AgentMessage[]` (deep-cloned first: `structuredClone`) | handler result `{messages}` replaces wholesale, chained | `emitContext` runner.ts L963-1027; consumed via `Agent.transformContext` (sdk.ts L327) |
| `before_provider_request` | `payload` (the wire request body) | non-undefined return replaces the payload, chained | sdk.ts `onPayload` L308-314 |
| `after_provider_response` | `status`, `headers` | none | sdk.ts `onResponse` L315-320 |
| `before_agent_start` | `prompt`, `images?`, `systemPrompt`, `systemPromptOptions` | `{message?, systemPrompt?}`; systemPrompt chains, messages accumulate; `ctx.getSystemPrompt()` reflects the chain so far | `emitBeforeAgentStart` runner.ts L1029-1093, called from agent-session.ts L6842 |
| `model_select` / `thinking_level_select` | model/level, previous, source | none | L7915-7925, L8113 |
| `user_bash` | `command`, `excludeFromContext`, `cwd` | first non-undefined result wins: `{operations?}` or `{result?}` replacement | agent-session.ts L12976 |
| `input` | `text`, `images?`, `source: interactive\|rpc\|extension` | `transform` chains; `handled` short-circuits input entirely | L5208 |
| `resources_discover` | `cwd`, `reason: startup\|reload` | `{skillPaths?, promptPaths?, themePaths?}` appended to resource resolution | L9918-9928 |
| `refine_complete` | refinement id/summary/scope | none | L9511 |

Emission order is deterministic: extensions in load order, handlers in
registration order, `await`ed sequentially, every handler wrapped in an error
boundary that reports `{extensionPath, event, error, stack?}` to
`emitError` and continues (runner.ts `emit` L786-819).

### 1.5 Runner semantics worth porting exactly

From `runner.ts`:

- **Tools**: `getAllRegisteredTools` — first registration per name wins across
  extensions (runner.ts L385-397). The session's tool registry builds builtin +
  custom tools, wraps them so `execute` receives the runner context
  (`wrapRegisteredTool` L23, `extensions/wrapper.ts`; agent-session.ts
  `_refreshToolRegistry` L10125-10195). `--tools` allow-lists filter custom
  tools too (`isAllowedTool`).
- **Commands**: name collisions get `name:2`, `name:3`... invocation names
  (`resolveRegisteredCommands` runner.ts L616-650). Slash dispatch looks up by
  `invocationName` and runs the handler with an `ExtensionCommandContext`
  (agent-session.ts L5854-5862).
- **Keybindings**: extension shortcuts lose against reserved built-ins
  (list in runner.ts L63-83), win over non-reserved built-ins with a
  diagnostic, last extension wins with a diagnostic; all normalized to
  lowercase key ids (`getShortcuts` runner.ts L428-484).
- **Stale contexts**: after reload / new / fork / switchSession the old runner
  is retired — captured `pi`/`ctx` throw the fixed stale-message
  (`invalidate` L477/`retire` L498, runner.ts; exact message in types.ts
  `ExtensionRuntimeState.invalidate`, types.ts L1326). This is user-visible (extensions print
  it); keep it byte-identical.
- **Host-owned timers**: `ctx.setTimeout/setInterval/clearTimeout/clearInterval`
  run callbacks through the same error boundary and are cancelled at unload
  (runner.ts L528-590).
- **Provider registration**: `bindCore` (runner.ts L283-352) flushes queued registrations and
  rebinds `registerProvider` to the live registry; errors in registration are
  reported through the error boundary (runner.ts L283-352).
- **Error surfacing**: modes subscribe via `onError` and, in daemon mode,
  broadcast `extension_error` messages to attached clients
  (`modes/daemon/daemon-extension-binding.ts` L84-96).

### 1.6 Contexts and UI

- `ExtensionContext` (types.ts L282-327): `ui`, `hasUI`, `cwd`, readonly
  `sessionManager`, `modelRegistry`, `model`, `isIdle()`, `signal`, `abort()`,
  `hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`,
  `getSystemPrompt()`, timer bindings.
- `ExtensionCommandContext` adds `waitForIdle`, `newSession`, `fork`,
  `navigateTree`, `switchSession`, `reload` (types.ts L329-375) — bound only
  where commands are invokable (`bindCommandContext` runner.ts L349-366).
- `ExtensionUIContext` (types.ts L113-260): dialogs (`select`, `confirm`,
  `input`), `notify`, `setStatus`, widgets/footer/header, editor overrides,
  themes, `custom<T>` overlays. Each mode supplies its own implementation;
  headless modes use `noOpUIContext` (runner.ts L201-240) and daemon mode
  routes dialogs to attached clients over the wire
  (`daemon-extension-binding.ts` `createExtensionUIContext`).
- `exec` runs on the host with a call-time session env overlay
  (`getExecEnv` in loader.ts `createExtensionRuntime`, types.ts
  `ExtensionRuntimeState.getExecEnv`; daemon usage in
  `daemon-extension-binding.ts` L81-82).

---

## 2. Recommended host design

### 2.1 Options considered

| Option | Verdict | Why |
|---|---|---|
| **A. In-process JS runtime (wasm QuickJS, deno_core, rquickjs)** | rejected | Extensions are TS/JS modules using node APIs, npm deps, and pi-tui/pi-ai value imports (§1.2). A JS engine without node's module/OS surface breaks every existing extension except trivial ones. TS type stripping + jiti + `node_modules` resolution cannot be reproduced in wasm faithfully; every divergence is a parity bug we'd discover one extension at a time. |
| **B. Wasm/plugin ABI (extensions compiled to a Rust-facing contract)** | rejected | Same parity argument: it abandons "load the TS/JS extension file the user already has" — the entire installed-extension ecosystem and the examples corpus (`packages/coding-agent/examples/extensions/`) would be incompatible. The MISSION contract is behavioral parity; the extension *authoring* surface is user-visible. |
| **C. Sidecar JS runtime subprocess (node) with a typed RPC surface** | **recommended** | Keeps the TS module surface byte-compatible (same loader semantics, same import graph), gives *better* failure isolation than TS (today a crashing extension can kill the agent process; a sidecar crash only degrades extensions), and keeps API keys/wire payloads inside the Rust process. |

### 2.2 Recommendation: one node sidecar per session process, typed RPC over stdio

- **Runtime: node.** The box (and the TS product's users) have node available
  (`/usr/bin/node`, v24 at the time of writing); bun is only embedded inside
  the TS binary and cannot be assumed as a standalone CLI. Node ≥ 22.6 strips
  TS types natively (stable in 23.6+), which covers most extension sources
  without a transpiler; for full CJS/TS interop parity with jiti (the TS
  loader's semantics, §1.2), the host script vendors **jiti/static** and uses
  it as the primary loader — identical to the TS behavior, no node-version
  roulette. Node ≥ 18 is the floor; the host detects and errors clearly
  otherwise.
- **Host script**: a single self-contained `.mjs` bundle (the "extension
  host") implementing the loader half: receives the resolved extension paths,
  loads each module (jiti with the alias/virtual-module strategy from
  `loader.ts`), builds the `pi` API object as an RPC proxy, runs handlers,
  and bridges ctx/UI calls back to Rust. Shipped inside the Rust binary
  (`include_str!`), materialized under `<agentDir>/extension-host/` at first
  use (content-addressed so upgrades replace it atomically). No `npm install`
  at startup; the bundle includes jiti/static and the API shim.
- **Process model**: one sidecar per agent session process. In daemon mode the
  session worker already owns one session per process
  (`crates/pa-daemon/src/worker.rs`), so "per session" is already the process
  boundary — the sidecar is a child of the worker and dies with it. In
  interactive/`print` mode the sidecar is a child of the CLI process.
- **Lazy start**: discovery (§1.1) runs in Rust always (it also feeds startup
  notices). The sidecar spawns only when at least one extension path resolved.
  A session with zero extensions pays zero child-process cost — this preserves
  current fast-path startup parity.
- **Wire**: newline-delimited JSON over the child's stdio (both directions),
  with correlation ids. JSON is debuggable, and the payloads are already
  JSON-shaped (wire provider payloads, session entries, tool args). Framing
  parity with the daemon protocol (`crates/pa-daemon/src/framing.rs`) is not
  required — this is a private, versioned protocol (`protocol: 1` in the
  handshake) internal to pa-core + the host script, both shipped in the same
  release, so they always match.

### 2.3 The typed RPC surface

Rust owns the schema; the host script implements the other end. Types live in
`pa-types` (pure data; the daemon protocol also needs some of them — see §3).

**Rust → sidecar (requests):**

| Message | Purpose | TS source shape |
|---|---|---|
| `hello {protocol, cwd, agentDir, extensionPaths[], flagValues}` | startup; the host loads modules and registers | loader.ts `loadExtensions` |
| `event {eventId, type, payload}` | emit one extension event; sidecar replies with the accumulated result | runner.ts emit* semantics table §1.4 |
| `tool_execute {toolCallId, toolName, args}` (streaming `tool_update` back, then `tool_result`) | call an extension tool | ToolDefinition.execute |
| `command_execute {invocationName, args}` | slash command handler | RegisteredCommand.handler |
| `shortcut_execute {keyId}` | keybinding handler | ExtensionShortcut.handler |
| `shutdown {reason}` | orderly unload; host emits `session_shutdown` then exits | emitSessionShutdownEvent |

**Sidecar → Rust (requests during a handler, correlated by `ctxToken`):**

ctx/UI actions mirror §1.6 one-to-one: `sendMessage`, `sendUserMessage`,
`appendEntry`, `setSessionName`/`getSessionName`, `setLabel`, `exec`,
`getActiveTools`/`getAllTools`/`setActiveTools`, `getCommands`,
`setModel`/`getThinkingLevel`/`setThinkingLevel`, `registerProvider`/
`unregisterProvider`, `getContextUsage`, `getSystemPrompt`, `isIdle`, `abort`,
`hasPendingMessages`, `compact`, `shutdown`, command-context actions
(`waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`,
`reload`), UI dialogs (`ui_select`/`ui_confirm`/`ui_input`/`ui_notify`/
`set_status`/...), and timer callbacks (`timer_fired`). `exec` executes on the
**Rust side** and streams back — this preserves the session-env overlay
semantics (§1.6 `getExecEnv`) without shipping env/keys to the sidecar.

**Registration payloads (sidecar → Rust at load and at runtime):**
tool definitions (`name`, `label`, `description`, JSON Schema for
`parameters`, `executionMode`, `promptSnippet`, `promptGuidelines`), commands,
shortcuts, flags, message-renderer custom types, handler subscriptions (the
event names actually registered — Rust only emits events with handlers,
matching `hasHandlers` gating), and queued provider registrations. TypeBox
schemas are converted to JSON Schema in the host shim (TypeBox is JSON-Schema
compatible; `parameters` becomes the tool wire schema exactly as the TS
agent-registry does when serializing tools for the provider).

**Serialization rules (the deliberate deviations, kept minimal):**
- `signal: AbortSignal` in before-events does not cross the wire; the sidecar
  gets a cancellation token id and Rust sends a `cancel {tokenId}` message
  (cancel parity: TS handlers observe abort via the same signal).
- `Component`-returning callbacks (`renderCall`, `renderResult`, message
  renderers, `setWidget`/`setFooter`/`setHeader` factories, `custom<T>`,
  editor factories) cannot cross a process boundary. v1 supports the
  **line-oriented subset**: the host shim accepts either the TS signature
  (ignored beyond detection) or the v1 structured-render contract — arrays of
  styled text lines with expand/collapse hints. Extensions using rich pi-tui
  components degrade to default rendering with a diagnostic. See §5 risk R3.
- `event_bus` (§1.3 `events`) stays entirely inside the sidecar — it is
  extension-to-extension communication and never needs Rust.

### 2.4 Startup cost, restart, and failure policy

- **Startup cost**: one `node` spawn (~50-100ms cold) plus module evaluation,
  once per session start / reload. This is comparable to the TS cost of the
  same jiti loads (the TS product does it in-process; the Rust product adds
  process spawn). Mitigation for the common case: discovery in Rust is pure
  path/JSON work; sessions without extensions pay nothing.
- **Timeouts**: `hello` handshake and per-event dispatch get configurable
  timeouts (settings-owned; defaults generous for load, short for hot-path
  events). A timed-out `before_*` event is treated as the handler returning
  `undefined` — parity with a hung in-process extension is impossible to
  match exactly, so we choose liveness and report the timeout through the
  error boundary (`extension_error`).
- **Crash isolation**: if the sidecar dies, the Rust process keeps running.
  Registered tools/commands become unavailable; every emit is a no-op;
  extension errors surface as `extension_error` diagnostics. This is strictly
  *better* than TS, where an extension's uncaught throw during a synchronous
  path or an `process` crash takes the agent down. `anyhow`-style degradation,
  never swallowed silently: each dropped emit is counted and visible in
  `/context`-style status surface.
- **Restart policy**: exponential backoff (1s, 2s, 4s... cap 30s), restart
  re-runs discovery-to-`hello` and re-registers tools (tool registry refresh
  seam, §3.3). Give up permanently after N consecutive failures (default 3)
  with a user-visible diagnostic; `/reload` always clears the failure state
  (TS `/reload` parity: reload re-evaluates modules, `resource-loader.ts`
  `reload()` L336+).
- **Orderly shutdown**: Rust sends `shutdown`, waits briefly, then kills. The
  sidecar's `session_shutdown` emit happens on the sidecar side (handlers run
  there) with the reason string.

### 2.5 Security

- The sidecar is a normal user process — same trust level as TS extensions
  (they run `pi.exec`, read the repo, etc.). No sandboxing claims.
- **Secrets never cross to the sidecar**: provider API keys, auth headers,
  and OAuth credentials stay in the Rust process. Extension tool/UI/ctx RPCs
  never carry them. `registerProvider` configs can name an env var for the key
  (`apiKey: "MY_ENV_VAR"` semantics, types.ts `ProviderConfig`) — the Rust
  registry resolves it; the sidecar only sees the name.
- **Wire payloads do cross** (`before_provider_request` receives the full
  request body, which may contain session content — that is the point of the
  hook, TS parity; provider-payload.ts example logs exactly this). Stdio is
  private to the parent-child pipe; no socket is opened.
- Extension flags and paths never enable the sidecar implicitly: same
  discovery rules as TS — nothing new executes that TS wouldn't.

### 2.6 Explicit v1 non-goals

- Rich TUI components (R3): unsupported, degrade with diagnostics.
- `streamSimple` custom providers (types.ts `ProviderConfig.streamSimple`) and
  `oauth` login flows: both are in-process callbacks in TS; over RPC they need
  a streaming request/response sub-protocol. Deferred; `registerProvider`
  with `models`/`baseUrl`/`headers`/`apiKey` is in v1, `streamSimple`/`oauth`
  are reported as unsupported with the same error-boundary path.
- `user_bash` `operations` replacement and `interactive-shell`-style full-TTY
  delegation: v1 supports the `result` replacement and plain `operations`
  exec semantics; full TTY pass-through deferred.

---

## 3. Integration seams in the Rust crates

Ownership: **pa-core owns the extension host** (spawn, RPC client, registry,
emit logic) — it is session-engine machinery. `pa-types` holds the shared wire
types. Nothing lands in `pa-tui` except consuming existing pa-types events;
`pa-agent` needs one minimal hook addition; `pa-ai` needs none.

### 3.1 pa-types: extension RPC wire types

New pure-data types (`extension_rpc.rs`): handshake, event envelope + all
event payloads (the §1.4 table as serde structs mirroring pa-types session
entries), tool/command/shortcut/flag/provider registration payloads, ctx-call
messages, `extension_error` (already has a daemon-protocol analogue), and the
UI dialog request/response pair. Rationale: daemon workers forward extension
UI dialogs to attached clients — those messages are daemon protocol, hence
pa-types. `ExtensionError` (types.ts L1441-1446) becomes a pa-types struct.

### 3.2 pa-core: the extensions area

New module tree `crates/pa-core/src/extensions/` (each file < 500 LoC):

- `discovery.rs` — port of §1.1 (manifest parse, entry resolution, one-level
  scan, dedupe). Consumes resolved paths from the resource-resolution lane
  (`crates/pa-core/src/resources/` once it lands; CLI paths from
  `pa-cli`'s already-parsed `--extension` values,
  `crates/pa-cli/src/args.rs` L166/L379).
- `host.rs` — sidecar process lifecycle: spawn (locate node), handshake,
  timeouts, backoff restart, shutdown; materialize the host script.
- `client.rs` — RPC client: dispatch events with the §1.4 semantics
  (chaining, first-wins, error boundary), handle nested ctx calls.
- `registry.rs` — the in-Rust mirror of registered tools/commands/flags/
  shortcuts/providers; first-wins rules; invocation-name collision handling;
  shortcut conflict diagnostics (port runner.ts §1.5).
- `runner.rs` — the `ExtensionRunner` equivalent the session engine sees:
  `has_handlers`, `emit_*` entry points, stale-ctx invalidation on reload and
  session replacement, host-timer bookkeeping (Rust-side timers that call
  `timer_fired` and are cancelled at unload/retire — the §1.5 semantics).

`crates/pa-core/src/session_engine/` call sites (mirroring the TS citations in
§1.4): `runtime.rs` (session start/shutdown, model/thinking select, input,
user_bash), `engine.rs` (assembly: bind registrations into the engine config),
`compact_session.rs`/`compaction.rs` (before_compact/compact events),
`refine.rs` (before_refine/refine_complete), `branch_summarization.rs`/
tree navigation sites (session_before_tree/session_tree). Each call goes
through `runner.rs` only — no pa-core module talks to the RPC client directly.

### 3.3 Tool registry seam

`session_engine/tool_bridge.rs` already bridges `ToolDefinition`s into the
loop's `AgentTool`. An `ExtensionTool` (pa-core) implements the same bridge:
`execute` dispatches `tool_execute` over RPC; `on_update` streams
`tool_update`. Name allow-list filtering (TS `_refreshToolRegistry`
`isAllowedTool`) applies at the same seam. Prompt snippets/guidelines from
extension tools flow into system-prompt assembly exactly like TS
(`_normalizePromptSnippet`/`_normalizePromptGuidelines`, agent-session.ts
L10144-10170).

### 3.4 Provider seam (pa-agent + pa-ai)

TS hooks `before_provider_request`/`after_provider_response`/`context` at the
`Agent` construction (sdk.ts `onPayload` L308 / `onResponse` L315 / `transformContext` L327). The Rust loop needs one addition: an optional payload/response
hook pair on the loop's stream seam (pa-agent owned, minimal public API — a
`PayloadHooks` struct passed via `AgentOptions`). pa-ai itself is untouched:
the hook wraps the request before `stream_fn` sends it and observes the
response after.

Cache-prefix caution (MISSION.md, first-class): `transform_context`/`onPayload`
run per request in TS too, and the runner's `hasHandlers` gate means sessions
without relevant handlers take the identity path — Rust must be identical
(no clone, no reserialize) so the KV-cacheable prefix is byte-stable when no
extension touches it.

### 3.5 Slash-command seam

`crates/pa-core/src/session_engine/slash_commands.rs` gains extension commands
alongside `SESSION_SLASH_COMMAND_NAMES`: resolution by `invocationName`
(collision suffixing per §1.5), dispatch to `command_execute`, and listing for
autocomplete consumers. pa-tui already renders command lists from pa-types;
extension commands flow through the same listing.

### 3.6 Keybinding seam

pa-tui (`crates/pa-tui/src/keybindings.rs`) receives the post-conflict-check
shortcut map (computed in pa-core §1.5 rules — reserved built-ins win, then
extension last-wins) as data: key id + description + a callback token the
session engine routes to `shortcut_execute`.

### 3.7 Daemon seam

`crates/pa-daemon/src/worker.rs` hosts the session engine per session; the
sidecar is therefore per-worker automatically. Daemon outbound additions:
`extension_error` (parity: TS broadcasts it,
`daemon-extension-binding.ts` L84-96) and the UI-dialog request/response pair
routed to the attached TUI client (the client answers; timeouts produce the
dialog-dismissal default, matching `ExtensionUIDialogOptions.timeout`
semantics, types.ts L78-83).

---

## 4. Staged implementation plan with per-stage verifiers

Each stage ships on its own branch and PR; the extension host lives behind a
settings gate (`extensions.host: "sidecar" | "off"`) only if needed mid-lane —
end state has no gate, TS has none.

### Stage 0 — Discovery + settings (Rust only, no JS)

Port §1.1 into `extensions/discovery.rs`; wire `--extension`/`--no-extensions`
from `pa-cli` (`crates/pa-cli/src/args.rs` already parses them) into engine
assembly; surface load errors in startup notices.

**Verifier (no TS runtime needed):** fixture-tree unit tests (manifest,
index, one-level scan, dedupe, `.ts`/`.js`/symlink cases) assert the exact
path lists and TS error strings ("Extension does not export a valid factory
function" is Stage 2; here: no-`package.json`-manifest subtrees produce
identical discovered sets). Differential: build fixture dirs, run the TS
binary with `--extension`-style discovery into a session that logs
`loadedExtensionPaths` (via a fixture extension that appends
`pi` registration to a file — or simply compare the daemon's
`extension_error`/startup diagnostics output for a broken fixture across both
binaries).

### Stage 1 — Host script + process lifecycle

Ship the host bundle; `extensions/host.rs` spawns node, handshakes, health
checks, backoff restart, orderly shutdown. A fixture extension that
registers nothing proves the pipe; one that throws proves the error path.

**Verifier:** Rust integration test (real `node`, no TS product): handshake
completes < timeout; `kill -9` the sidecar mid-session, assert the session
survives, diagnostics appear, restart recovers within backoff; shutdown is
orderly. Differential smoke: same fixture dir loaded by the TS binary produces
the same "registered/loaded" observables where the surfaces overlap.

### Stage 2 — Registration + tool execution

Registration payloads (tools/commands/flags/shortcuts/providers) land in the
registry; `ExtensionTool` bridge executes tools over RPC; system-prompt
snippet/guideline injection; slash command dispatch.

**Verifier:** scripted-engine session (`crates/pa-daemon/src/engine.rs`
`ScriptedEngine` pattern) where the loop calls a fixture extension tool
(`hello.ts` from `packages/coding-agent/examples/extensions/` — run the *same
file* under both binaries): assert identical tool JSON schema on the wire,
identical tool result text, identical `--tools` filtering. Unit-test the
runner collision rules against runner.ts behavior (first-wins tools,
`name:2` commands, reserved keybindings) with golden expectations copied from
the TS semantics.

### Stage 3 — Event surface at the seams

Emit points in the session engine + the pa-agent payload hook; `before_*`
cancel/skip semantics; `context`/`before_provider_request` chaining;
`message_end` role-preserving replacement.

**Verifier (the fixture corpus):** a logging fixture extension subscribes to
every event and appends a normalized JSON line per event. Run the identical
session script (print mode, same prompt, same settings, scripted provider on
the Rust side) under the TS binary and the Rust binary; diff the two logs
after normalization (timestamps/ids). Additionally: with **no** extension
loaded, byte-compare provider request payloads before/after the hook seam to
prove the identity path (cache-prefix stability).

### Stage 4 — Commands, keybindings, UI dialogs, daemon routing

Slash command invocation + autocomplete; shortcuts into pa-tui; select/
confirm/input/notify over the daemon to an attached TUI; `extension_error`
broadcast.

**Verifier:** tmux-driven (per AGENTS.md protocol): session with a
`/hello`-command fixture extension — keybinding visible in `/hotkeys`,
command visible in autocomplete, invocation renders the extension's notify;
differential against the TS binary in a second tmux pane. Daemon e2e:
`crates/pa-daemon/tests/` harness asserts the `extension_error` and dialog
wire shapes against captured TS goldens.

### Stage 5 — Reload, session replacement, stale-ctx, timers

`/reload` parity: re-discovery, module re-evaluation, runner invalidation with
the byte-identical stale message, host timers cancelled at retire
(`adoptHostTimers` semantics on the Rust side).

**Verifier:** fixture extension that captures its ctx and uses it after
`/reload` must surface the exact TS stale-message text (it's user-visible
copy — byte-compare). Timer fixture: pending `ctx.setTimeout` callbacks are
cancelled after reload, fire through the error boundary when they throw.
Differential: run the same flow under the TS binary; identical visible
diagnostics.

### Stage 6 — Failure policy hardening + docs

Restart-give-up diagnostics, `/context`-visible degrade state, extension
corpus sweep (run the examples corpus that is in-scope — lifecycle, tools,
commands — under both binaries; triage each diff as bug or documented v1
non-goal §2.6).

**Verifier:** the corpus sweep report attached to the final PR: every example
extension marked `works | degraded (documented) | unsupported (v1 non-goal)`
with evidence. Degraded ones must degrade with a diagnostic, never silently.

---

## 5. Risks and unknowns

- **R1 — Node availability/version.** Node is not guaranteed on every user
  machine at a TS-capable version. Mitigation: clear error when absent
  (same class of dependency as the npm CLI the package manager already
  shells out to), jiti does the TS lifting so only node's *JS* runtime is
  needed, floor node ≥ 18. Unknown: product decision whether to bundle a
  runtime (bun compile embeds one; we could ship the host script to run under
  the *user's* node only, or vendor a minimal node build later).
- **R2 — Import-surface breadth.** Type-only imports erase cleanly; value
  imports (`CustomEditor`, pi-tui components, pi-ai functions) need the shim
  module to exist with compatible exports. The examples corpus sweep (Stage
  6) measures how many value-import surfaces are actually used. Unknown
  until measured; expectation: most extensions are type-only + `pi` object
  usage.
- **R3 — Rich UI components cannot cross the boundary.** Structured line
  rendering covers status lines, footers, widgets, dialogs; it does not cover
  games/overlays/custom editors (`doom-overlay/`, `snake.ts`, `modal-editor.ts`).
  These are v1-unsupported with diagnostics. Long-term options (not decided
  here): a richer declarative component protocol, or a passthrough pane
  (sidecar renders directly to the terminal like the TS TUI would).
- **R4 — Hot-path latency.** `message_update` fires per token in TS
  (in-process). Over IPC this is only emitted when a handler exists
  (`hasHandlers` gating) — but a subscriber turns streaming into round-trips.
  Mitigation: batch events with sequence numbers, and document that
  `message_update` subscribers add latency (TS handlers get them synchronously
  mid-stream). Verifier hook: Stage 3 latency assertion with a streaming
  fixture.
- **R5 — Cancellation across the process boundary.** `AbortSignal` in
  `session_before_compact` and tool `execute(signal)` become RPC cancellation
  tokens; a sidecar that ignores cancellation delays but cannot block Rust
  (Rust proceeds on its own timeout/abort). Slight semantic divergence from
  in-process signals; documented.
- **R6 — Payload mutation after the hash point.** TS forfeits idempotency-key
  reuse when payload hooks run (`agent-session.ts` L12610-12614 — the comment
  says payload hooks mutate the wire body *after* the hash point). The Rust
  retry logic must reproduce this interaction exactly: if any
  `before_provider_request` handler is registered, skip the same
  semantic-edge preparation TS skips.
- **R7 — `structuredClone` parity for the `context` event.** TS deep-clones
  before chaining (runner.ts `emitContext`); Rust must clone its message list
  (or send a copy) before dispatch so handler mutations don't leak into
  session state except through the returned replacement — and the returned
  list must be validated back into session entries. Edge cases (non-serializable
  fields in custom entries) are unknown until the corpus runs.
- **R8 — `input` event `images` identity.** TS compares `currentImages !== images`
  (reference identity, runner.ts L1169) to decide "transform" vs "continue";
  over RPC this becomes structural comparison. Behaviorally equivalent for
  JSON-representable images; noted for the verifier.
- **R9 — Host script distribution.** Vendored jiti inside an `include_str!`
  bundle is the plan; jiti is MIT (fine to vendor, attribute). The
  content-addressed materialization must not fight read-only `$HOME` edge
  cases (materialize under the existing agent dir, which already must be
  writable).
- **R10 — Protocol drift.** The RPC protocol is private but shipped on both
  ends; a stale host script on disk (older agent dir) must be detected and
  replaced on version mismatch (hash in the handshake).

---

## Appendix: where each seam touches which crate (review checklist)

| Concern | Crate | File (new/existing) |
|---|---|---|
| discovery + manifest rules | pa-core | `src/extensions/discovery.rs` |
| host process lifecycle | pa-core | `src/extensions/host.rs` |
| RPC client + emit semantics | pa-core | `src/extensions/client.rs` |
| registry + conflict rules | pa-core | `src/extensions/registry.rs` |
| runner facade for session engine | pa-core | `src/extensions/runner.rs` |
| wire types (shared with daemon) | pa-types | `src/extension_rpc.rs` |
| payload/response/context hooks | pa-agent | `AgentOptions` payload-hook addition (minimal public API) |
| tool bridging | pa-core | `src/session_engine/tool_bridge.rs` (existing pattern) |
| slash commands | pa-core | `src/session_engine/slash_commands.rs` |
| keybindings data | pa-tui | `src/keybindings.rs` (data consumer only) |
| daemon routing + worker hosting | pa-daemon | `src/worker.rs`, protocol outbound |
| CLI flags | pa-cli | already parses `--extension`/`--no-extensions`/unknown flags |
