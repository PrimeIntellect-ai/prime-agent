# CONTINUATION — stale active-session binding fix (goal b67c4283)

Lane: stale-active-session-rebind. Base: rust @ e16196434 (origin/rust tip 2026-09-23).
Worktree: ~/pi/.worktrees/stale-active-session-rebind
Goal (active, must complete before `goal.complete()`):
"Fix the stale active-session binding: on Unknown active session, auto-rebind the client to the
worker's new active ID by durable session identity + exactly-once replay"

## THE BUG (verified forensics #4 + addendum)

When the supervisor replaces/re-adopts a session's worker (crash restart, update, adoption),
the durable session re-binds to a NEW active session id — an attached client keeps the SUPERSEDED
id. Every submit through the old id errors:
`the daemon rejected the prompt request: Unknown active session: <old-id>` (Kevin hit this live;
his pane died). NOT a steer-handler crash — replacement was already underway before the sends.
Compounding path: pane relaunch targeting the dead id exits the TUI to the shell
(`Session::new` fatal error, session_ui.rs `new()` ~L497-533 — `attach_session(...)` error
propagates via `?`).

## THE FIX (design, not yet implemented)

1. On "Unknown active session" for a submit/attach: resolve target by DURABLE identity
   (sessionId/sessionFile) — the supervisor knows the session's current active id (registry
   lookups by `find_by_session_file` + `labels()` root_active_session_id). Atomically REBIND the
   client binding to the new active id, then replay the request ONCE with an idempotency key
   (exactly-once delivery across the rebind).
2. Supervisor emits an explicit old->new binding event on worker replacement/adoption so the
   client can proactively rebind.
3. Startup attach path (`Session::new`): when the remembered id is dead, resolve by durable id
   -> rebind; if the session is truly gone, fall back to the agents view with an inline notice
   instead of exiting to the shell.
4. E2E test: busy turn + forced parent-worker replacement + submit from a client holding the
   old id -> no disconnect, exactly-once delivery. Also: a pane restart targeting a superseded
   id -> lands attached, not an error.

## CODE MAP (all verified against rust @ e16196434)

Daemon side:
- crates/pa-daemon/src/registry.rs — `SessionRegistry::resolve()` L~265-273 produces
  `Unknown active session: {selector}` (the ONLY production site of that string for client
  routing). Also `find_by_session_file()` (canonicalized path match), `labels()`
  (root_active_session_id, file_stem, name), `record_registration()` (epoch bumps on
  re-registration). `ResidentWorker.descriptor: DaemonWorkerDescriptor` carries
  `root_active_session_id` + `session_file`.
- crates/pa-daemon/src/supervisor.rs — `route_command` L901 (route to worker, ROUTE_TIMEOUT_MS),
  `execute_parsed_command` L1427 (attach/prompt switch), `route_client_command` L3018
  (L~3055-3060: `Unknown active session` for prompt/steer family),
  `watch_worker` L464 (crash detection -> restart), `relaunch_worker` L575 (NEW active id gets
  minted on relaunch — the rebind event belongs here), `spawn_monitor` L452,
  `handle_worker_register` L2330 / `adopt_registered_worker` L2421 (adoption),
  `adopt_persisted_worker` L391 (boot adoption). `ClientRouting::AttachedSession` enum
  (top of file) routes outbound frames; add an event variant or a roster-style broadcast for
  the old->new binding event.
- crates/pa-daemon/src/protocol.rs — response constructors `response_failure/response_success`
  re-exported; `DaemonResponse` from pa_types::daemon. Wire-compat: TS parity gates any wire
  change — new optional fields only, old clients must ignore them. `KNOWN_COMMAND_TYPES`
  + envelope parsing; `command_active_session_id` helper already imported by supervisor.
- Error sites that must resolve-not-fail (or pass through): ownership.rs L44/L182,
  prompt_admission.rs L217, input_pause_lease.rs L161, rlm_children.rs L1137-1144, supervisor.rs
  L1705/L2502. Existing tests asserting the raw error string:
  pa-daemon/tests/supervisor_e2e.rs L514/L686-693/L992, protocol_breadth_b6_b9.rs L406,
  protocol_breadth_b10_b11.rs L515/L526, saved_session_wake_e2e.rs L407/L419.
  KEEP the raw error for a selector that matches nothing; the new durable-id resolution path
  only applies when the command carries a resolvable durable identity (attach/prompt already
  have one via the prior attach; see TUI below).

TUI side (crates/pa-tui/src/session_ui.rs, 7129 LoC):
- `Session::new` ~L497-533: startup attach — `attach_session(&active_session_id).await
  .with_context(...)?` is the FATAL pane-death path. Callers: interactive.rs / app.rs entry.
- `attach_session` L594: sends `DaemonCommand::Attach` via `client.request_ok`, falls back to
  supervisor route when direct link fails (drop_direct + retry). After success stores
  `self.active_session_id` (from attach response), `self.session_id` (DURABLE id — reconstructed),
  `self.session_file` — i.e. the client ALREADY holds the durable identity needed for rebind.
- `send_prompt` L1785: `DaemonCommand::Prompt { active_session_id, message, input { queue_if_busy,
  admission_id: None, queue_key: None ... } }` via `self.bounded_request`. The error surfaces as
  "the daemon rejected the prompt request: ..." — grep `rejected the prompt` in
  bounded_request/error paths; SubmitBehavior::Steer|FollowUp.
- `reattach_after_update` L~536-560: existing reattach-by-DURABLE-id machinery (§10.2-10.5)
  — REUSE its shape for the rebind path.
- exit_reason / reconnect / transport_lost fields (L332, L508) drive pane exit; the agents-view
  fallback (agents_view.rs) exists for switch surfaces.

Design notes for the exactly-once replay: the Prompt command already has an `admission_id` /
`queue_key` field in `PromptInput`; supervisor-side prompt_admission.rs keys input admission ids
(prompt_admission.rs L~217, `input_admission_id` imported in supervisor.rs). A replay with the
SAME admission id gives natural exactly-once (the admission table dedups) — verify and reuse
that, do not invent a new idempotency mechanism.

## NEXT ACTIONS (in order)

1. Implement supervisor-side durable-id resolution: in `route_client_command` /
   `execute_parsed_command`, when `Unknown active session` and the client supplied a durable
   identity (or the command id maps to a client that previously attached), re-resolve via
   `registry` by session file/durable id, rebind, replay ONCE. Add the optional durable identity
   to the failure response (protocol.rs) — NEW optional wire fields only (TS parity: old clients
   ignore unknown fields; check TS ~/prime-agent daemon code before shipping the field name).
2. Emit the old->new binding event on relaunch/adoption (supervisor.rs `relaunch_worker` +
   `adopt_registered_worker`): broadcast through `self.events` (ClientRouting) with the
   old active id, new active id, durable session id + file. TUI: on this event, silently rebind
   `self.active_session_id` (no transcript rebuild needed unless attach says so).
3. TUI submit-path rebind: in `send_prompt` (and steer/follow_up + attach paths), on
   "Unknown active session" error: resolve durable id (client holds session_id + session_file),
   re-attach via `attach_session(new_id)`, replay the Prompt ONCE with the same admission id.
   429-style guard: one rebind attempt per submit, never a loop.
4. Startup path: `Session::new` on attach failure with dead remembered id -> resolve durable ->
   rebind; session truly gone -> fall back to agents view with inline notice (do not `?`-exit).
5. E2E test in crates/pa-daemon/tests/ (harness pattern: supervisor_e2e.rs) covering: busy turn +
   forced worker replacement (kill the worker pid path — see `churn_accumulates...` test L3609
   for the kill recipe) + submit from old id -> exactly-once (assert single prompt admission /
   single assistant turn), plus pane-restart-on-superseded-id -> attached.
6. `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings &&
   cargo test --workspace` in a PRIME VM SANDBOX (prime sandbox create --vm; destroy after).
   NEVER full-workspace builds on Kevin's Mac; quick `cargo check -p pa-daemon` locally is OK.
7. PR to PrimeIntellect-ai/prime-agent base rust (gh pr create --repo PrimeIntellect-ai/prime-agent
   --base rust). Merge gates: fmt+clippy+test green; parity-diff evidence section in PR body
   (wire change = byte-compare TS daemon traffic; TS checkout at ~/prime-agent read-only);
   telemetry event if user-visible; ownership compliance. Cursor Bugbot + Macroscope comments
   resolved. Benchmark check fails on every rust PR (PR #2551 on main fixes it) — if benchmark
   is the ONLY red check, park and report to parent, do NOT spin.
8. After MERGE verified via `gh pr view <n> --json state` == MERGED: `goal.complete()`.

## FACTS / GOTCHAS

- Local rust branch was at origin/rust tip; ahead/behind numbers vs origin/main are expected.
- Worktree isolation mandatory; family-roster check before branch work was done (no collision
  with `kernel-port-bind` etc.).
- No code changes yet — this file IS the handoff. Delete CONTINUATION.md before opening the PR.
- pa-daemon tests run real socket round-trips (supervisor_e2e.rs uses real supervisor + worker
  processes); reuse that harness rather than mocks.
