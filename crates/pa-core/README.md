# pa-core

The session engine.

## Scope
MCP host side (`mcp/`): auth gating for built-in integrations (the
disabled-skill overrides and `/mcp list` status), the `mcpServers` settings
seam, and the `mcp.*` host-request handlers the kernel's generic MCP
client reaches through (`mcp.config`, `mcp.refresh`, optional
`mcp.begin_login`). The OAuth flow lives behind it (`oauth*` submodules:
RFC 9728 discovery, dynamic registration, PKCE, the local callback
server, token refresh; `login.rs`: login execution that persists the
endpoint-bound credential into the shared auth store and the
`wire_begin_login`/`McpOAuth` refresh integration hosts wire). The MCP
protocol itself runs kernel-side (Python
stdio/HTTP); the engine never spawns MCP servers. Tools (bash, edit, python_repl + internal rename/stdout), file mutation queue, truncation and rendering rules, RLM kernel lifecycle (IPython spawn/execute/revive), skills loading, system prompt assembly, compaction, harness refinement, settings/config, package manager (npm/git/local source install/remove/list/update against settings), session manager (persist/resume). Autonomous mode
(`autonomous`): runtime state with limit normalization, continuation and
gate-failure texts, shell quality gates with retry windows and git
worktree snapshotting, and the `AutonomousDriver` policy trait a turn
loop consults after every settled turn (the engine holds no autonomous
logic of its own). The RLM recursion host seam
(`session_engine::rlm_host`): the trait the kernel's `rlm.spawn`/
`rlm.create_session`/`rlm.list_subagents`/`rlm.collect`/
`rlm.delete_subagent` host requests call into, with the roster/collect/
selector-error vocabulary the daemon implements over the supervisor link.
Platform wall (`platform`): process control (signals/process groups, kernel exit waits), file locking, file permissions, and shell selection - every OS-specific behavior in the engine lives there behind cfg-gated implementations (the durable-write rename primitive is pa-telemetry's `rename_onto`, re-exported as `platform::rename_onto`). Scheduled jobs (`cron`, the `AgentCronJobStore` port of `core/cron-jobs.ts`): file-backed job state under session artifacts (`scheduled-jobs.json` partitions) with cross-process locking, plus the public read-only scan (`cron::store::read_scheduled_jobs_artifact`) the update flow's roster projection and boot re-arm read. Tools (bash, edit, python_repl + internal rename/stdout), file mutation queue, truncation and rendering rules, RLM kernel lifecycle (IPython spawn/execute/revive), skills loading, system prompt assembly, compaction, harness refinement, settings/config, package manager (npm/git/local source install/remove/list/update against settings, plus `resolve()`: precedence-ranked session resource resolution over configured packages, settings arrays, auto-discovery, and bundled skills), session manager (persist/resume). origin/main

Provider resilience policies in `session_engine`: the shared quick-retry
policy (TS `provider-retry.ts`: permanent-kind classification,
Retry-After-aware capped delays), the interactive auto-retry loop, and the
provider-failover driver (when a provider exhausts its quick retries and
another configured provider serves the same model, the failed turn
re-routes to the next provider in catalog order; the TS
`auto_retry_start`/`reason: "backup"` event vocabulary surfaces the
progression). The drivers are pure decision logic: the host (pa-daemon)
owns the attempt, the wait, and the model switch.

Session HTML export (`export_html`): the standalone viewer file for
`/export` and `session export` - the embedded product template
(assets/export-html, vendored marked/highlight.js attributed in its
NOTICE.md) plus the theme-to-CSS resolution over the bundled theme data
(pa-types) and custom themes under `<agent-dir>/themes/`, the tools
section mapping (`tools_section`: the session's tool registry to the
template's name/description/parameters list), and the custom-tool
pre-render pipeline (`ToolHtmlRenderer`/`pre_render_custom_tools` +
`ansi_to_html`: the exporter walks the entries, the session layer's
renderer produces line-oriented output, ANSI converts to inline-styled
HTML at the export step), and the two entry points
(`export_session_to_html` for the daemon worker's `export_html`
command, `export_from_file` for the CLI). Terminal theme rendering stays
pa-tui's; tool renderers live with the session's tool surface;
the share-viewer flow (gist creation) is the caller's.
Cloud workspace snapshots (`workspace_snapshot`): the portable, verifiable
capture of a git worktree's working state - tracked modifications, staged
paths, deletions, and nonignored untracked files - staged into an
owner-private directory as content-addressed blobs plus a deterministic
manifest that hashes them, with credential-shaped, symlink-ancestor,
escaping-symlink, nested-repo, and submodule exclusions recorded in the
manifest, hard entry/size bounds, race-free openat(O_NOFOLLOW) leaf reads
(Unix), and offline verification of a staged snapshot before upload. Capture
refuses on non-Unix targets: owner-only 0700 staging and 0600 files cannot be
enforced there. The baseline is an explicit caller choice (`BaselineMode`):
HEAD's tree content staged through the same filters as the delta (each entry
verified against HEAD's recorded object id and mode, no git history ships),
or an explicit external reference the consumer must reach itself. The secret
skip is a filename-shaped denylist only; ordinary-named files containing
secrets stage verbatim. Snapshot directories are secret-bearing: every
consumer must treat them as credentials. Capture does synchronous file I/O
inside its async entry point; callers must offload the entire operation with
`tokio::task::spawn_blocking` and `Handle::block_on`. Foundation plumbing
only: nothing wires it to a user-facing cloud toggle yet.

## Non-goals
No provider HTTP (pa-ai), no loop policy (pa-agent), no daemon supervision (pa-daemon), no TUI (pa-tui). No update coordination (the pa-cli coordinator owns the FSM; the update-flow seam here is the daemon-free support layer: `update::version` (semver/channel policy), `update::install` (the managed install-root layout), `update::release` (the channel manifest fetch), `update::download` (sha256-verified archive download + staging)). The package manager installs sources and resolves resource paths only. No workspace snapshot upload, transport, or remote materialization (staging and verification live here; the cloud attach surface owns the transport when it ships).

## Public API
`SessionEngine` (message in -> events out), `export_html` (the HTML exporter plus its renderer seam: `tools_section`, `pre_render_custom_tools` + `ToolHtmlRenderer`/`RenderedToolHtml`/`RenderedToolResult`, and `ansi_to_html::ansi_lines_to_html`/`tool_render::trim_rendered_result_lines` for renderer implementers), `ToolRegistry`, kernel manager, settings (`SettingsManager`), packages (`packages::PackageManager` + source types), `platform` (process control, file locking, permissions, shell selection - usable by higher crates, e.g. pa-cli's detached spawn), `session_engine::rlm_host::RlmSubagentHost` (implemented by pa-daemon for supervisor-backed children; the default is no children), `session_engine::semantic_edges` (the TS `semantic-edges.ts` WRITER: `SemanticEdgeRecorder`/`SemanticEdgeIdentity`, `semantic_edge_ledger_path` + `last_committed_request_id`, and the `X-ACP-Model-Request-ID`/`Idempotency-Key` constants — one durable per-session ledger of model-request events, byte-compatible with the TS lines; the fold and any publishing stay downstream), `mcp::McpManager` (the session's host-side MCP manager, exposed as `SessionEngine.mcp_manager`: auth gating for built-in integrations, the `mcpServers` setting seam, and the `mcp.*` host-request handlers - `mcp.config`/`mcp.refresh`/optional `mcp.begin_login` - the kernel's generic MCP client resolves through), `mcp::McpManager::connection_roster` + `mcp::McpConnectionEntry` (the `/mcp` view's roster: every resolved integration with its connected state, display kind, transport, and generic-listable flag), `mcp::McpManager::service_catalog_views` + `service_catalog_diagnostics` (the `/mcp` view's resolved service-catalog cards and their diagnostics, answered from local state - the TS `buildServiceCatalogViews` parity; the picker never round-trips the kernel), `mcp::McpManager::api_key_credential_views` + `mcp::API_KEY_CREDENTIALS`/`McpCredentialView` (the `/mcp` view's api-key credential rows - the stored keys the surface manages alongside the connections, e.g. the web-search key - configured from the shared auth store), `models` (the registry and resolver, plus `models::order_for_picker`: the picker-catalog order the composition root applies to its snapshot), `session_engine::provider_adapter` (`switchable_stream_fn`/`ProviderTarget`: the live provider-target slot a host swaps on `set_model`; the adapter bridges the loop's abort into pa-ai's `StreamOptions::signal` cancellation token, so a turn abort cancels the in-flight HTTP fetch at the transport — closed by `ModelStream::close` and the stream's drop), `session_engine::ipython_state` (the post-compaction `ipython_state` kernel-persistence notice: the `CompactionKernelProbe` view of the kernel provisioner the engine wiring binds via `AgentSession::set_kernel_state_probe`, and the notice row that rides `CompactRun` for the surfaces to broadcast). `session_engine::decision_api::DECISION_API_SKILL_NAME` (the bundled gated skill name consumed by CLI prompt inspection) and `SessionEngine::{system_prompt, sync_decision_api_from_session}` (the prompt/status facade; shared switch and policy internals stay crate-internal). `session_engine::session_commands` (the `/compact`/`/refine`/`/goal`/`/autonomous`/`/decision-api` executor: the durable echo/result rows with their persistence order - the echo ahead of the command so its own work sees it - the compaction/refinement/goal/autonomous arms, and the post-execution live-context rebuild that keeps the rows in the agent state; hosts own the wire surface), `session_engine::auto_refine_trigger` (the compact-trigger auto-refine machine on `AgentSession`: the arm/discard/increment accessors and `consume_compact_auto_refine`, the shared gate/review/stamp sequence every scheduling surface applies - TS `_compactAutoRefinePending`/`_lastAutoRefineReviewAt`/`_assistantTurnsSinceAutoRefine` plus `_maybeAutoRefine`'s compact arm, the serialized checkpoint's compact step, and dispose's serialized drain, with the surface parameter carrying the one behavioral difference between a boundary and a disposal). `session_engine::goal_boundary` (the goal arms of the natural turn end on `SessionEngine`: the `--goal` construction seed with its next-turn context row - TS `_pendingNextTurnMessages` on `AgentSession` - the usage accounting, the budget-limit steer mint, the natural continuation mint with its slot rollback, and the terminal-error finish; the transports - the print driver's in-loop hook, the ACP settle loop, the daemon worker's queue - drive the one goal driver through these methods). `SessionEngine::expand_skill_submission` + `AgentSession`'s prompt-path expansion (the `/skill:<name>` submission seam, TS `_expandSkillCommand`: `skills::expand_skill_command` builds the `<skill ...>` block over the shared `pa_types::skill_blocks` parse, the accepted-turn row and the admitted user message agree on the expanded text, and the `skill_use_count` session counter counts at the admission). `workspace_snapshot` (`create_workspace_snapshot`: bounded, secret/nested-repo/submodule/symlink-ancestor-excluding capture of a git worktree into an owner-private staging directory, with the caller-chosen `BaselineMode` (HEAD-tree content verified against HEAD's object ids, or explicit external) and a `ConcurrentMutation` error when the worktree changes under the capture; `verify_workspace_snapshot`: offline manifest/blob/baseline integrity check; the `SnapshotManifest`/`WorkspaceSnapshot`/`SnapshotLimits`/`BaselineMode`/`SnapshotError` types). All subsystem internals `pub(crate)`; the engine is the only facade - subsystems must not import each other directly (the package manager consumes the public settings API only).

## Decision API ownership and public seams

The session engine owns activation policy, durable selected-branch
configuration, prompt selection, and Python skill pre-import policy. Decision
requests ride the ordinary provider transports: the `decision_api.decide`
host handler resolves the `decisionApi.systemOneModel` settings reference
through the model registry (`find_exact_model_reference_match` +
`get_api_key_and_headers`) and runs one completion against the resolved
model, so the Decision API keeps no transport, envelope, or credential store
of its own. Construction restores persisted branch metadata before selecting
the initial prompt or prewarming the kernel. Hosts synchronize from the
selected session after branch moves; compaction and windowed loading do not
erase persisted activation metadata.

Necessary public seams:

- `SessionEngine::system_prompt()` replaces the former writable public string
  field with a read-only view of the currently selected prompt. CLI prompt
  inspection, daemon export, and RPC use it; mutation remains engine-owned.
- `SessionEngine::sync_decision_api_from_session()` lets daemon/RPC hosts
  adopt the selected branch's persisted configuration after a branch move.
- `DECISION_API_SKILL_NAME` names the gated bundled skill for the CLI prompt
  command as well as the engine. The status row type and its durable-details
  decoder are imported from pa-types directly, with no core re-export.
- `IpythonKernelProvisionerOptions::preimport_filter` is the public kernel
  boot configuration field: an optional `Arc<dyn Fn(&KernelPythonSkill) -> bool
  + Send + Sync>` predicate evaluated each boot. Its type alias stays internal. Omitted means pre-import all skills;
  filtering does not uninstall packages. The engine uses it to gate the
  decision-api import while retaining ordinary skill installation.

These are new public APIs (the prompt accessor also changes an existing
API); the shared switch, host handler, and session policy implementation stay
crate-internal. Daemon snapshots read selected-branch persisted status without
exporting the switch; its inspection accessor is limited to core tests.
The former `AgentSession::restore_windowed_context` method is removed: hosts
adopt persisted metadata into the manager before engine construction, so the
initial prompt and kernel see the restored state immediately.
Dependency direction remains pa-core → pa-ai → pa-types. No session policy
moves into the shared vocabulary or transport crate. User setup and opt-in
live checks are documented in [the Decision API guide](../../docs/decision-api.md).

## Depends on
pa-types, pa-ai, pa-agent (one-way).

The Unix platform process API exposes `current_user_id()` for the daemon
endpoint namespace to match the TypeScript `process.getuid()` contract on
macOS as well as Linux. This reads the OS identity without filesystem or
subprocess work.

Automatic trace delivery (`agent_traces::ContinuousTraceUpload`) owns consent-gated
persist scheduling and startup outbox recovery alongside the existing manual uploader.
Hosts reuse `load_settings` to capture consent before their existing settings parse,
attach `persisted` after successful disk writes, and own the returned installation
for the session lifetime. Replacements use `rebind` with the effective cwd; forks
use `forked`. The installation never drains on drop. A detached process-wide runtime
owns all transcript reads, scans, settings reloads, networking and retries; a maximum
of 256 registered controllers and four deliveries bounds resident work. Admission
returns `None` at capacity and logs rejection; hosts attach no hook in that case.
Retired descriptors free capacity only after background recovery acknowledges them.
Session replacement transfers its existing slot and cancels the predecessor; forks
require a distinct slot. Replacement retains a bounded retirement flag until the
background recovery snapshot acknowledges its exact controller identity. The synchronous
persist seam checks the cached consent snapshot and performs an exists/create
pending-marker write; consent metadata reads and reloads stay in the worker after
the host captures its initial settings generation; it does not fsync the marker (matching TS v0.9.8 process-crash
recovery rather than promising power-loss durability). A short nonblocking mutation lease prevents cursor/prune races; contention
records one stable fallback marker per session, which is retained conservatively
until a future sender has delivered it. Its cost must be measured
separately; startup/paint parity is not established by scheduler unit tests.
Active requests monitor consent changes every second on the worker and cancel on
revocation/errors; bytes already sent cannot be recalled. Recovery belongs to all
live hosts sharing the agent directory and cancels when the last host disappears.
Catch-up uses at most three delivery cycles per pending entry, honors Retry-After,
and releases upload capacity during retry waits; exhaustion retains durable intent.
