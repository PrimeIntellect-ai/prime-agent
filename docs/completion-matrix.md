# Completion matrix: user-facing product surface vs status

Audit of the Rust rewrite against the TS product (`~/prime-agent`, ground truth),
taken from code on `main` at `7d67021` (through PR #93). Status vocabulary:

- **complete** - the surface works end to end with a verifier against the TS
  product or live wire goldens.
- **partial** - the surface exists and users reach it, but named behavior is
  missing or unverified.
- **in-flight** - a lane branch carries the work; `main` does not have it yet.
- **missing** - not implemented in the product path.
- **descoped** - an operator decision cut the remaining scope; landed work stays,
  the cut stages will not be built.

**Battery greenness is not product parity.** The live A/B battery
(`scripts/battery/`, `docs/parity-battery.md`) last ran `20260917T062810Z`
with "0 gaps, 35 parity checks passed". That means only its scripted flows
(f1-f11 over a deterministic mock provider) agree between the binaries. It
does not cover the families marked partial/missing below; today's interactive
`--thinking` blocker (see "Thinking control") was invisible to it. Every row
below is evidence-based, not battery-based.

| # | Family | Status | One-line remaining scope |
|---|--------|--------|--------------------------|
| 1 | Interactive session TUI | partial | verified core states only; missing all-expanded detail mode, OSC 133, ambient skill commands, broad markdown breadth |
| 2 | Thinking control (`--thinking`, `/effort`) | missing (interactive) | flag parsed but never reaches the worker; interactive unusable until the fix lane lands |
| 3 | Slash commands | partial | registry/menu/autocomplete/session forwarding landed; almost all client command UIs report "not available" |
| 4 | Agents view | in-flight | roster protocol + TUI mode + entry points on `lane/agents-view`, unmerged |
| 5 | Daemon supervision & protocol | partial | 32 of ~106 TS command types; read commands, reconnect missing (saved-session wake done) |
| 6 | Compaction | complete (daemon wire) | kernel `compact.run` host handler lands with the family-10 lane (`lane/harness-handlers`): registered, registry-tested, and round-tripped through a real kernel |
| 7 | Side questions | complete | - |
| 8 | Agent-to-agent messaging | partial | peer transport done; saved-session wake done; `custom` persistence, family-graph relations missing |
| 9 | RLM recursion (`rlm.spawn`/`collect`/subagents) | partial | `rlm.*` handlers + supervisor-backed child sessions land with the `lane/rlm` PR; kernel-side dogfood (row 11) still untested |
| 10 | Kernel host-request surface & continual harness | in-flight | `lane/harness-handlers` registers `model.info`/`compact.*`/`refine.*` (+ pending state, turn-boundary consumption in daemon worker and print mode, registry round-trip tests, real-kernel wire-contract test via `create_session`); remaining: daemon-level dogfood e2e (a daemon session's settled boundary consuming a kernel-scheduled refinement end to end) |
| 11 | RLM dogfood (this harness, run by the Rust binary) | missing | mission-host dogfood untested; depends on rows 9-10 |
| 12 | MCP | partial | CLI config/catalog/gating only; product-path wiring, OAuth/login UI, generic connector execution unproven |
| 13 | Extensions | descoped (operator decision 2026-09-17) - stages 3-6 cut, stages 1-2 remain (harmless) | sidecar runner stages 3-6 will not be built |
| 14 | Skills | partial | loading + prompt inventory done; skills-as-commands and attach-image product backing missing |
| 15 | CLI command surface | partial | list/attach/stop/rename/send/schedule wired; model-list catalog + config UI landed; status/doctor/shutdown unavailable, self-update missing |
| 16 | Headless modes | partial | print/json done; RPC and ACP modes missing |
| 17 | Session persistence | partial | entry-set parity + `toolResult` entries landed; per-entry gaps remain elsewhere |
| 18 | First-run onboarding | complete | - |
| 19 | Trace sharing | partial | opt-in setting persists; `/traces` UI ported (status block, on/off writes, credential/endpoint rows; the upload subsystem and its login/preview/upload arms stay unported and report it) |
| 20 | Eval / verifiers Prime flow | partial | headless verifier gates (print/json) landed; `prime eval` hosted platform CLI is out of coding-agent scope; daemon RPC driving pending |
| 21 | Native release / installer / CI | missing | binary does not ship the kernel runtime sidecar; `PI_PACKAGE_DIR` workaround |
| 22 | Platform readiness (Windows) | in-flight | traits audited (`docs/windows-readiness.md`); no shipping support yet |

Details and evidence per family follow.

## 1. Interactive session TUI - partial

Done, frame-diff verified at 120x36/220x50 against the TS binary
(`scripts/visual_parity.py`, checklist §9, PR #80): fresh start, idle
post-turn with tool-call card, thinking visible, spinner/working state.
Provider-failure surfacing (#90) and the splash/onboarding (#93) are battery
verified (`runs/20260917T062810Z`). Attach through the daemon (#69), direct
transport (#82/#92).

Remaining:

- **Ctrl+O detail mode**: Rust has two levels only. `pa-tui/src/chat.rs` L18
  (`Detail` enum: `Overview`/`Details`), toggled in
  `pa-tui/src/session_ui.rs` L583-584. TS has three -
  `interactive-mode.ts` L7726 `setChatDetail(detail: "overview" | "details" |
  "all")`. The all-expanded (tool output rows) mode is missing.
- **OSC 133 markers**: TS emits shell-integration markers
  (`\x1b]133` sequences in `modes/interactive/components/user-message.ts` and
  `assistant-message.ts`); no Rust crate emits them (repo-wide grep finds none).
- **Markdown breadth**: only the scripted content block types are
  frame-verified (checklist §9 deviations).
- **Ambient skill/template commands**: the TS daemon lists skills and
  templates as slash commands; the Rust registry is builtins-only
  (`pa-types/src/slash_commands.rs`; battery B-9 note).

## 2. Thinking control (`--thinking`, `/effort`) - missing on the interactive path

- The CLI parses `--thinking` (`pa-cli/src/args.rs` L15, L339-346), but the
  interactive create payload carries no thinking field
  (`pa-tui/src/session.rs` L40 carries provider/model only - the B-1 fix
  propagated those, not thinking).
- The daemon worker hardcodes thinking off: `pa-daemon/src/agent_engine.rs`
  L264 (`thinking_level: None` in `build_session`) and the session file
  records `thinking_level_change: "off"` (`pa-daemon/src/worker.rs` L1881-1904:
  "The daemon engine runs with thinking off").
- `/effort` therefore cannot take effect interactively, and a
  local trial hit this as a live blocker (fix lane `lane/thinking-parity`
  in flight, no commits yet).
- Print mode DOES resolve thinking (`pa-cli/src/print_runtime.rs` L111,
  `resolve_thinking_level` L241).

Status: interactive thinking is NOT usable until the fix lane lands.

## 3. Slash commands - partial

Done (#91): shared registry in `pa-types/src/slash_commands.rs` (38 builtin
commands, TS name/description/alias parity), the `/` menu with fuzzy filter,
argument-hint column, directional scroll, suggestions ("Unknown command: /x.
Did you mean /y?"), and session-command forwarding to the worker.

Remaining:

- Client command UIs: `pa-tui/src/session_ui.rs` implements `help`, `list`,
  `switch`, `exit`, `new`, `quit`, `model`, `effort`, `tree`, `fork`,
  `clone`, `mcp login/logout`, `export`, `share`, `hotkeys`, `copy`,
  `import`, `login`, `logout`, `traces`, and `update`; the remaining client
  commands (settings/theme/name/session/system-prompt/context/...) print
  "/x is not available in this client yet".
- `/effort` is additionally blocked by family 2.
- Dynamic `/effort` argument hint and model-eligibility filtering of `/fast`
  (battery B-9 note) remain.

## 4. Agents view - in-flight

`prime-agent agents` is routed (`pa-cli/src/public_command.rs` L148 sets
`explicit_agents_view`; `pa-cli/src/mode.rs` L134 carries it into
`RunOptions`) but nothing on `main` consumes it. The lane branch
`lane/agents-view` (commits `2ec737d`..`2efec39`, unmerged) adds the roster
protocol, the TUI mode (unified roster/catalog rows, sections, search,
open/attach), and entry points (`agents`, bare `-r`, `/resume` return).
Battery flow f9 only captures frames on both sides; frame diffing belongs to
the lane.

## 5. Daemon supervision & protocol - partial

Done: thin supervisor + per-session worker processes (stages 1-3, #79/#82/#89),
session self-registration/adoption, chunked snapshot streaming (#74),
compaction (#85), side questions (#70), status-line recap (#81/#83),
queue/retry/restart/kill, `send_message` arm, worker robustness (#88),
32 of ~106 TS command types (`pa-daemon/src/protocol.rs` L25-58
`KNOWN_COMMAND_TYPES` vs `daemon-supervisor.ts` L244 `DAEMON_COMMAND_TYPES`).

Remaining (checklist §7/§8 stay authoritative):

- Read commands `get_context_tree`, `get_commands`, `get_resource_snapshot`
  (blocked on RLM children / per-worker resource loading).
- `DaemonRoutedClient` reconnect semantics: the TS client
  (`modes/daemon/daemon-routed-client.ts`) reconnects and replays; the Rust
  CLI client (`pa-cli/src/daemon_client.rs`) is single-shot, no reconnect.
- Daemon command vocabulary breadth (32 vs ~106 types; per-command work in
  pa-daemon only - `pa-types` already models the variants).

## 6. Compaction - complete on the daemon wire

`compact`/`abort_compaction`/`set_auto_compaction` are worker commands
(`pa-daemon/src/protocol.rs` L51-53; `pa-daemon/src/worker.rs` L843,
L1498-1500), differential-tested by battery flow f7
(`runs/20260917T062810Z`: both sides succeed; shape delta: TS includes
`details{readFiles, modifiedFiles}`, Rust omits the details block).

Remaining nuance: the kernel `compact.run`/`compact.status` host handler (TS
`agent-session.ts` L3703-3731) is not registered in the Rust product path, so
the model cannot compact its own session (see family 10).

## 7. Side questions - complete

Protocol + worker + engine + retry policy + differential goldens (checklist
§3, #70; battery f5).

## 8. Agent-to-agent messaging - partial

Done (#84, #89): supervisor `send_message` arm, worker delivery with the TS
prompt rendering, kernel `agent_message.send`/`agent_observe.*` controllers,
worker-to-worker peer transport with peer tickets, restart-survival e2e
(`pa-daemon/tests/peer_messaging_e2e.rs`).

Remaining (checklist §10 "deferred gaps" stands):
`customType: "agent_message"` persistence, family-graph-derived sender
relations. Saved-session wake for non-resident `send_message` targets is
done (session-wake lane: `session_catalog.rs` + the messaging wake block,
`saved_session_wake_e2e.rs`).

## 9. RLM recursion - partial (in review)

The `lane/rlm` PR registers every `rlm.*` host handler in the product path
(`pa-core/src/session_engine/rlm_host.rs` via `runtime_wiring.rs`:
`rlm.run`, `rlm.create_session`, `rlm.find_models`, `rlm.list_subagents`,
`rlm.collect`, `rlm.progress_note`, `rlm.delete_subagent`) and lands the
child machinery: supervisor-backed child sessions
(`pa-daemon/src/rlm_children.rs` over the shared supervisor link), the
parent-side roster/collect/delete surface with TS-verbatim selector
errors, and the e2e verifier (`pa-daemon/tests/rlm_children_e2e.rs`).
Remaining: end-to-end dogfood under a live provider (row 11) and live
tool-activity introspection in roster rows.

## 10. Kernel host-request surface & continual harness - partial

Registered in the product path (evidence above): `goal.*`, `rlm_heartbeat.*`,
`agent_message.send`, `agent_observe.*`. The harness digest is delivered at
cold-context boundaries (#83).

Missing product-path handlers (all advertised by the system prompt,
`pa-core/src/prompts/mod.rs` L33 - "Continual harness state is available as
`rlm.harness`..." and L217 - "`await refine.run()`"):

- `refine.status`/`refine.run` (TS `agent-session.ts` L3754-3770).
- `harness.*` CRUD / `record_refinement` / `overview` (the continual-harness
  entries this session's own harness digest advertises).
- `model.info` (TS L10416) - which also blocks the bundled `attach_image`
  skill (`skills/attach-image/src/attach_image/attach_image.py` L237).
- `rlm.*` (family 9).
- `mcp.*` (family 12): the handlers exist in `pa-core/src/mcp.rs` L383
  (`mcp.refresh`, `mcp.config`, `mcp.begin_login`) but no product path calls
  `McpManager::register_host_handlers` (only in-crate tests, L677/L704).

## 11. RLM dogfood - missing

The mission's own success criterion - running Prime Agent sessions on the
Rust binary as the harness (this very session's control loop) - is untested:
it needs families 9 and 10 first (child spawn/collect, harness CRUD, refine).
The child spawn/collect machinery lands with the `lane/rlm` PR; the
continual-harness handler family (10) is still open.

## 12. MCP - partial

Done: the CLI management command (`pa-cli/src/mcp_command.rs`, 475 LoC:
`mcpServers` settings store, name/env validation, builtin catalog gating
`linear`/`notion`), and the core manager (`pa-core/src/mcp.rs`: catalog,
integrations, ACP server slots, auth-gated skill overrides).

Missing: product-path wiring (the daemon worker passes
`generic_mcp_servers: vec![]`, `pa-daemon/src/agent_engine.rs` L271, and
registers no `mcp.*` handlers), OAuth/login UI (`mcp.begin_login` only
registers when an interactive login callback is provided, `pa-core/src/mcp.rs`
L445-447), and generic connector execution (no MCP client protocol
implementation). No end-to-end proof that a configured server's tools reach a
session.

## 13. Extensions - descoped (operator decision 2026-09-17)

Done (#66, #75): package install/remove/list/update (npm/git/local with the
TS quirks) and full resource resolution (packages, settings arrays,
auto-discovery, ignore rules, bundled skills, precedence) - checklist §2.

Landed and staying, harmless (no product-path surface depends on it): the
sidecar extension runner stages 1-2 per `docs/extensions-runner-design.md`
- stage 0 discovery rides #75's resolution, stage 1 is the host process
lifecycle (spawn/handshake/backoff restart/orderly shutdown, NDJSON RPC),
stage 2 is module loading with vendored jiti plus the registration mirror,
tool execution, and prompt-guideline injection (`crates/pa-core/src/extensions/`
+ `pa-types::extension_rpc`; verifiers in
`crates/pa-core/tests/extension_host.rs` and `extension_runner.rs`).

Descoped: stages 3-6 of the runner (event surface at the session-engine seams,
commands/keybindings/UI dialogs, reload/stale-ctx, failure-policy hardening)
will not be built.

Rationale (operator, 2026-09-17): skills + the Python kernel packages are
the product extensibility story; models.json covers custom providers; only
one builtin extension exists (herdr-agent-state); the pi-ecosystem plugin
surface is not a product requirement.

## 14. Skills - partial

Done: markdown + Python skill loading, resource resolution (packages/settings/
auto/bundled), the skill list in the system prompt, and kernel pre-imports
(`pa-core/src/skills/`, `pa-core/src/session_engine/runtime_wiring.rs`).

Remaining:

- Skills-as-commands: the TS daemon surfaces skills/templates as slash
  commands; the Rust registry is builtins-only (family 1/3 overlap).
- `attach_image` (bundled skill) cannot work: its `model.info` host request is
  unregistered (family 10).

## 15. CLI command surface - partial

Wired through the daemon client (#67, `pa-cli/src/daemon_command.rs`):
`list [--all]`, `attach`, `stop` (kill), `rename`, `send`, `schedule`/cron.
`package` (#66) and `mcp` (family 12) run to completion; flag/error parity
rows are differential-tested (`pa-cli/tests/differential_cli.rs`).

Missing:

- `model list`: DONE - the runtime renders the TS catalog table
  (`pa-cli/src/list_models.rs`, registry availability now gates unauthorized
  private models like TS `getAvailable`); differential corpus rows compare
  the table and search/no-match paths against the TS binary.
- `config`: DONE - the interactive resource-configuration view
  (`pa-cli/src/config_command.rs` + `pa-tui/src/config_selector.rs`),
  frame-identical to the TS view at 100 columns and producing the same
  settings writes (`+`/`-` patterns) for the same key sequence
  (tmux-verified).
- `status`/`doctor`/`shutdown`: typed "daemon discovery ... is not available
  in this build yet" (`pa-cli/src/public_command.rs` L375-398; drivers exist on
  the unmerged `lane/cli-discovery-2` `c4c285c`).
- Self-update: `update` reports "self-update is not available in this build
  yet" (checklist §2, native release plan + update-restart coordinator).
- `session export` (HTML): `MissingSubsystem::SessionExport`
  (`pa-cli/src/lib.rs` L107-111).

## 16. Headless modes - partial

Done: print/text and json single-shot modes over the pa-core engine with real
providers, thinking resolution, resume/-c guard (#81/#87), faux-script seam;
the daemon `--mode daemon` supervisor.

Missing: `--mode rpc` and `--mode acp` exit with the typed
`MissingSubsystem::SessionEngine` error (`pa-cli/src/print_runtime.rs` L61) -
neither the RPC line protocol nor the ACP (Agent Client Protocol) server is
implemented (TS `modes/rpc/`, `modes/acp/`).

## 17. Session persistence - partial

Done: append-only JSONL session files with TS-parity entry sets (#88: session,
session_state, message, model_change, service_tier_change,
thinking_level_change, custom_message, compaction, agent_status),
checkpoint/restart recovery journal, status-line request parity (#81/#83).

Remaining: none for `toolResult` entries - the pa-core persisted-session
listener writes them (hermetic scripted-tool test), the daemon worker
persists them plus every mid-run assistant message (TS `message_end`
append semantics, `supervisor_e2e.rs` verifier), a live-TS golden entry
round-trips through the Rust session types
(`tests/golden/corpus/toolresult-entry-live-ts.json`), and the TUI attach
replay folds tool-result messages onto their pending tool cards
(`pa-tui/src/snapshot.rs`).

## 18. First-run onboarding - complete

Splash + "Share agent traces with Prime Intellect?" notice, answerable,
persisted completion flag (`pa-tui/src/onboarding.rs`;
`pa-tui/src/interactive.rs` L186-207). Battery-verified
(`runs/20260917T062810Z` f1: "first-run splash + trace-sharing notice
rendered and answerable on both sides").

## 19. Trace sharing - partial

The opt-in setting persists (`set_agent_traces_enabled`,
`pa-tui/src/interactive.rs` L62) and `/traces` (the command the onboarding
note advertises) is ported (`pa-tui/src/traces.rs` + the composition-root
hook `pa-cli/src/client_traces.rs`): the TS status block, the on/off
settings writes, and the credential/endpoint rows. The trace upload
subsystem (TS `core/agent-traces.ts`: outbox, credential flow, session
upload) does not exist in Rust; the upload/preview/login arms keep the TS
state shapes (missing-credential errors, the no-session-file status) and
report the unported backend.

## 20. Eval / verifiers Prime flow - partial

Diagnosis (lane `eval-composition`): the TS coding-agent has no eval command.
Verifier flows ride existing product seams - CLI autonomous flags
(`--autonomous`, `--autonomous-gate <command>`, ...) driving a session
headlessly, the configured gate command being the verifier (run in the
session cwd with retries/timeouts, `pa-core/autonomous`, #98), completion
observed through the json event stream (the in-run continuation turns, the
autonomous-ordering lane), the headless stderr exit contract, or
ACP `_meta.autonomous`.

Landed with this lane: the headless print/json composition (pa-cli
`headless_autonomous` module; no eval code in pa-core) - CLI flags build the
autonomous run state, the gate loop runs after every settled turn,
continuations are durable user rows, the stop surfaces as a durable
`autonomous_status` row plus its `message_end` events, and the process exit
code follows the TS print-mode contract (gate still failing after retries ->
exit 1 with the stderr line; autonomous run without gates stopped by a limit
-> exit 1 "stopped before terminal evidence"). Binary-level verifier:
`crates/pa-cli/tests/eval_composition_e2e.rs` (fixture verifier scripts,
faux provider, isolated HOME; no daemon sockets touched).

Product boundary: `prime eval run/list/get/...` on this box is the Prime
Intellect platform CLI (hosted evals over verifiers environments) - a separate
product from `prime-agent`, not part of the TS coding-agent CLI and therefore
outside this repo's parity surface. The coding agent's role is being the
harness those environments drive headlessly.

Remaining: verifier flows over the daemon RPC mode (unwired, family 16), and
ACP autonomous-meta observation exercised by a live verifier harness.

## 21. Native release / installer / CI - partial (kernel packaging done)

Kernel packaging (the kernel-packaging lane) is done: the exe-adjacent release
layout is ported (binary + `package.json` version manifest +
`prime-agent-runtime/` sidecar + `skills/` + `docs/` + `LICENSE`, resolved at
runtime via
`PI_PACKAGE_DIR` or the binary directory, with a source-checkout fallback),
`scripts/package_release.py` is the packaging dry-run (TS
`assemble-release-archives.mjs` + `copy-binary-assets.mjs` parity: staging,
required-asset validation, symlink/dev-cache rejection (`.venv`,
`__pycache__`, `*.pyc`), version pinning against the binary, `SHA256SUMS` +
`binaries.json` integrity manifests, tarball; `make package`), and the hidden
`--prime-agent-bootstrap` flag is the installer handoff (TS
`runtime-bootstrap.ts`). `--version` reports the packaged manifest version
(TS reads `getPackageJsonPath()` at runtime). Verifier:
`crates/pa-cli/tests/packaged_layout_e2e.rs` - a packaged session boots the
kernel with no `PI_PACKAGE_DIR` (staged skills and version manifest resolve
exe-adjacent), missing-sidecar and bad-override failure UX, and the packaging
dry-run artifact integrity. The heavy sidecar-venv bootstrap
(`--ignored`) exercises the fresh-venv path.

Remaining: the installer (`install.sh`) itself, R2/native update manifests,
and release CI (a reference sketch exists at `docs/ci.yml.reference`; merge
gates run locally via `make check`).

## 22. Platform readiness - in-flight

Windows-readiness audit and daemon-critical platform traits landed as docs +
trait seams (#72/#76, `docs/windows-readiness.md`); no shipping platform
support.

---

Cross-references: per-candidate detail and live-wire golden evidence live in
`docs/parity-checklist.md`; battery flow definitions in
`docs/parity-battery.md`; model-facing contract in `docs/MODEL-SURFACE.md`.
