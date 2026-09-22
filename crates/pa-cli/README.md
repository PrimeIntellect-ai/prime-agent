# pa-cli

The `prime-agent` binary.

## Scope
Argument parsing matching the TS CLI exactly, mode selection (interactive/headless/json/daemon subcommands), binary wiring of crates into processes, exit codes and user-facing errors. Client-side MCP auth flows (`mcp_login.rs`): the `/mcp login`/`/mcp logout` hook the TUI calls — the TS interactive client's placement — resolving a server (settings `mcpServers` + the builtin catalog), running the pa-core OAuth login on the suspended terminal, and persisting through the shared auth store. The same placement serves the TUI's client-command hooks: provider auth (`provider_login.rs` — the `/login`/`/logout` catalog, the API-key store, the MCP device flow, the TS status wording; the subscription OAuth and Prime browser flows stay unported and report it), trace-sharing state (`client_traces.rs` — the settings flag writes and the credential resolution `/traces` shows; the upload subsystem stays unported), and the update child runner + post-update relaunch (`client_update.rs` — the split-CLI child invocations and the exec of the updated launcher from the managed install root).

## Non-goals
No business logic; it composes pa-daemon, pa-core, pa-tui, pa-ai via their public APIs only.

## Public API
The `prime-agent` executable surface (flags, subcommands, exit codes). Internal lib types `pub(crate)`, plus the daemon wiring (`interactive_mode::{ensure_daemon_running, ensure_daemon_running_with, resolve_socket_path}`) exported for the integration verifier.

## Depends on
pa-types, pa-ai, pa-agent, pa-core, pa-daemon, pa-tui (one-way, composition root).

## Print runtime
The headless print/json modes (`print_runtime.rs`) drive the in-process
session engine directly: prompt admission, the turn-boundary compaction
checks (`print_boundary.rs` — the overflow compact-and-retry arm, the
model-requested compaction/refinement consumption, and the threshold arm,
the TS `_checkCompaction` flow), the json event stream, and the headless
terminal selection (stdout/stderr/exit code) mirroring modes/print-mode.ts.
Autonomous continuation (print_autonomous.rs, the #254 follow-up): the
composed in-run continuation hook (the pa-agent loop's
`getContinuationMessages` seam) runs the natural continuations inside
the one agent run (the TS shape: `turn_end` -> `turn_start` with the
continuation user row between them, no run boundary); the goal arm runs
first (exclusive priority), the boundary gates (queued input, a
requested compaction, the threshold arm) are shared, and a threshold
compaction holds its minted continuation for the boundary's queued
`followUp` admission (`TurnBoundary::admit_continuation`). The stop
surfaces only through the headless exit contract (TS: no row, no frame).
Goal continuation (print_goal.rs, the #252 residue): the `--goal` seed rides
the first turn; the in-loop continuation hook runs an active goal's natural
continuations inside the one agent run; the budget-limit steer and the
threshold-held continuation drain as this invocation's follow-up runs
with the TS session-action phase frames.
Session slash commands (`print_session_command.rs`, the #253 residue): print
prompts that are `/compact`, `/refine`, `/goal`, or `/autonomous` execute
through the pa-core session-command executor (the daemon worker's seam — no
parallel implementation), streaming the TS shapes: the
`session_action_update` phase frames around the durable echo row, the
per-command events (`compaction_start`/`compaction_end` for `/compact`, the
refinement rows plus `refine_complete`/`refine_failed` for `/refine`, the
unconditional `goal_update` publish for `/goal`), the result rows, and the
settled queue frame. A `/goal` start (or resume) drains its scheduled
continuation inside the same prompt wait; a failed command rejects the
prompt wait (the raw error to stderr, exit 1, no later prompts). Client
commands (`/model`, `/tree`, ...) stay model prompts — TS
`_normalizeSubmission` classifies only the four session commands before
admission, so they never cross the turn boundary.
The json stream emits the TS session-event surface byte-for-shape: the
session header row (version 3), the `message_update` streaming deltas with
the slim `assistantMessageEvent` (the daemon wire drops the nested
`partial`), `tool_execution_update`, the harness digest's message pair at
the first-turn boundary, the compaction `compaction_start`/`compaction_end`
pairs with their durable outcome rows, the `goal_update`/`session_action_update`
frames of the goal loop, and the refinement rows with
`refine_complete`/`refine_failed`. Verifier: `scripts/print_json_parity.py`
(the TS binary differential, the goal-budget/goal-natural plus the
session-command scenarios — the harness supports split runs: `--only ts`
on the TS host, `--only rust` against the sandbox build, both against one
`--out`) plus the `print_runtime_e2e` rows.

## Daemon client
The daemon-backed public commands (`list`, `stop`, `rename`, `send`, `schedule`) talk to the
pa-daemon supervisor over its JSONL Unix socket through the crate-private client module
(`daemon_client.rs`). The client never spawns a daemon - the TS CLI only auto-starts one for
the internal `daemon start`/`open` commands, which are not reachable from the public surface.

## Packaged layout / kernel packaging

The release artifact is exe-adjacent (TS install.sh native layout): the binary
plus `package.json` (the version manifest `--version` reads at runtime, with
the compiled-in version as the fallback), `prime-agent-runtime/` (the kernel
sidecar), `skills/`, and `docs/`. `scripts/package_release.py` (`make package`)
assembles, validates, version-pins, hashes, and tars it; the hidden
`--prime-agent-bootstrap` flag is the installer handoff that pre-bootstraps the
kernel venv. Verifier: `tests/packaged_layout_e2e.rs`.

## Daemon discovery
The discovery commands (`status`, `doctor [--fix]`, `shutdown [--force]`, TS
`cli/daemon-ps.ts`) live in the crate-private `daemon_discovery` module: an OS census of
listening unix sockets owned by product processes, a socket-dir sweep, probing/classifying
each discovered daemon, and the reap/shutdown planners and executors. Containment is part of
the contract: every scan, probe, and stop is scoped to an explicit `DaemonStateRoot`
(the env-resolved current root for the CLI), with a hard never-touch exclusion list for this
sandbox's ambient mission daemons - see docs/PORTING-NOTES.md. All e2e daemons live in
test-created fixture directories only.

## Update flow (staged activation)

`prime-agent update` (the `update_flow` module, spec
`docs/update-flow-state-machine.md`): the invoking CLI plans, downloads, and
stages the candidate (`Acquire`..`Staged`), then spawns the detached
coordinator - the new binary running from its release dir - which adopts the
status file and owns the FSM to a terminal state (`Preparing..Complete`,
`Rollback` first-class). `intent.json` is the coordinator lock (Join on a
live holder, dead-holder steal), the status file keeps the TS schema plus
`updateId`/`state`/`epoch`, and the activation owns the bin-symlink swap
(`bin/previous` rollback pointer, `.activation-state` recovery record).
Mechanism support (version/channel policy, install-root layout, manifest
fetch, archive staging) lives in pa-core's `update` module; the daemon-side
prepare/commit/stop drivers and the boot restore pass are pa-daemon
(slices 2-3 and 5): the coordinator's `Restoring` phase polls the
successor's `update_restore_status` RPC for the real per-session counts.
