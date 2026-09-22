# pa-types

The single shared vocabulary crate. Nothing else is shared between crates.

## Scope
Wire and domain types + serde only: AI messages/content blocks/tool calls/usage/stream events, session JSONL entry schema, daemon wire protocol messages, worker frames.

Daemon wire mechanics shared by the serving side (pa-daemon) and clients (pa-tui/pa-cli) live here because pa-tui depends on pa-types alone:
- `daemon::framing`: the private-frame codec of the worker socket (direct-attach clients speak it too).
- `daemon::plane`: the session/control command-plane table (worker-side peer gating and client-side socket routing both read it).
- `daemon::{DaemonPeerTransportTicket, DaemonWorkerPeerGrant, DaemonPeerCommand}`: the direct-transport ticket and grant wire shapes.
- `goal`: the thread-goal wire state (`GoalState`/`GoalStatus`) shared by the
  goal engine (pa-core), the daemon wire (`goal_update` session events and
  the attach snapshot's `state.goal`), and the TUI (announcement rows, tray
  label). The goal *engine* (validation, accounting, continuation prompts)
  is pa-core's.
- `slash_commands`: the builtin slash-command table every surface shares
  (the TUI dispatch + autocomplete, the session engine's command admission,
  CLI suggestion help) plus its pure parse/suggestion helpers — the TS
  product keeps the same single table in core and imports it from its TUI.
- `themes`: the bundled theme definition files (`prime`/`dark`/`light`) as
  pure data, shared by the TUI's theme loader (pa-tui renders terminal
  colors from them) and the session HTML exporter (pa-core resolves them
  into CSS variables). Everything built on top of the files — terminal
  color rendering, export CSS generation, custom-theme discovery — belongs
  to the consuming crates.
- `extension_rpc`: the private, versioned NDJSON-over-stdio protocol between the pa-core extension host and the Node sidecar (handshake, RPC envelopes, registration payloads, `ExtensionError`). Both ends ship in the same release, so these types are strict (no catch-alls).

- `daemon::update_flow`: the update-flow state machine's shared vocabulary
  (docs/update-flow-state-machine.md): the coordinator FSM states + legal
  transition table, `UpdateId`, the on-disk artifact schemas (`intent.json`,
  `status.json` — TS status-file shape, `prepared/<id>/{roster,marker}.json`),
  the roster-snapshot projection (sessions/workers/subagents/heartbeats,
  durable session ids, heartbeat re-arm fields only), the timeout-budget
  table with `PRIME_AGENT_UPDATE_*_MS` overrides, and the artifact path
  layout under `<agent-dir>/update-restarts/`. Pure serde + pure data
  helpers; the FSM drivers and watchdogs are owned by pa-daemon/pa-cli. The
  prepare/commit wire commands (`prepare_update_restart`/`
  commit_update_restart`) and the TS mutation classification
  (`is_daemon_mutating_command`, `is_update_drain_command` — the
  update-flow admission gate's read tables) live in `daemon::{command,plane}`.
Platform contracts (`platform`): the cross-crate transport, process-identity, socket-identity, and home-dir helpers, plus the suspend-to-background signal control (`process::{stop_own_process_group, ignore_sigint_for_suspend, restore_default_sigint}`: the TUI's TS-`handleCtrlZ` cycle — SIGTSTP to the own process group, SIGINT ignored for the stopped window and restored on the SIGCONT resume; unsafe lives behind this wall because pa-tui opts into the workspace `unsafe_code` forbid) (`platform::dirs::home_dir`: `HOME`, then on Windows `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH` - Node `os.homedir()` parity, returning `None` so each caller owns its fallback). pa-types is the only crate every transport consumer can depend on (pa-tui depends on pa-types alone), so the shared trait vocabulary and its cfg-gated platform implementations live here: AF_UNIX on Unix, named pipes (`\.\pipe\`, `platform/windows_pipe.rs`) on Windows. Remaining platform areas (process control, perms, ...) are implemented per platform behind the same traits, not re-plumbed in callers.

## Non-goals
No provider logic, no session logic, no UI. Beyond pure data helpers and the platform contracts, no behavior: a domain type that wants a method belongs in the owning crate.

## Public API
Everything in this crate is deliberately `pub` - it is the cross-crate contract. Unknown fields survive round-trips via catch-all maps so schema revisions stay compatible.

## Depends on
serde, serde_json, thiserror, anyhow, tokio. No workspace crates.
