# LANE-STATE — stale active-session rebind (forensics #4)

Worktree: ~/lane-worktrees/session-rebind-fix (branch stale-active-session-rebind, off org/rust @ e16196434 + CONTINUATION.md handoff e197d0f1e).
Goal: fix stale active-session rebind; PR base rust; merge after gates + bot threads resolved.

## Verified findings (code-map, daemon side)

- Registry: `crates/pa-daemon/src/registry.rs` — key = worker_id (12-hex display id, `util::new_display_id`). `root_active_session_id` = worker_id, STABLE across `relaunch_worker`/crash-restart (same resident, same descriptor, same `WORKER_ACTIVE_SESSION_ID_ENV`). `resolve()` matches: exact worker_id, suffix of root id, suffix of session-file STEM (= durable UUID), or name. `find_by_session_file()` = durable path lookup.
- Worker active id = `core.active_session_id` = env from `descriptor.root_active_session_id` (worker.rs handle_attach returns it in activeSessionId).
- **Where a NEW active id gets minted while old clients hold the old id**: `launch_worker` (supervisor.rs ~936) ALWAYS mints a fresh `worker_id` per create — NO reuse of an existing worker for the same session file (TS has `createOrReuseWorker`+`reuseWorkerForCreate` which reclaims the SAME rootActiveSessionId). Rust give-up path (`watch_worker` MAX_CONSECUTIVE_FAILURES): persists Failed descriptor, `registry.remove`+`forget`, `remove_roster_worker`, re-seeds ledger — descriptor FILE stays on disk but registry entry gone. So: give-up -> session re-opened (pane/agents-view create with session file) -> NEW worker, NEW active id -> attached clients holding old id get `Unknown active session: <old>` on every submit. Same after `stop_worker` (kill: descriptor file REMOVED there).
- `route_client_command` (supervisor.rs ~3018): resolve -> `await_restore_target` (queued attach for restore pass, already exists) -> retry resolve -> failure `restore_failure_for(...).unwrap_or("Unknown active session: {selector}")`. THIS is the resolve-not-fail seam.
- Prompt admission (exactly-once): `crates/pa-daemon/src/prompt_admission.rs` — dispatch-time registration by admissionId; worker admission table dedups. Prompt command carries admission_id/queue_key already (PromptInput). REUSE for idempotency.
- Ownership gate: owned workers (owner_client_id) invisible to foreign clients -> keep: rebind only applies when the binding's gate passes.
- TS parity facts: no TS binding event on wire. TS: (1) rewrites routed command activeSessionId to the worker's current id (`resolvedCommand`), (2) startup Unknown falls back to saved-session path (create/open recovery), (3) send_message catches Unknown -> catalog resolve -> createOrReuseWorker wake, (4) `DaemonSessionRecoveringError` for known-but-recovering (retryable, errorInfo.code=session_recovering), failed workers stay unknown so clients take create fallback which reclaims.
- ClientRouting::AttachedSession{active_session_id} filters events by the connection's `attached` vec (per-connection, populated at attach from response activeSessionId). After any rebind, supervisor must swap old->new in `attached` AND tell the client (binding event) so events keep flowing.

## DESIGN (per CONTINUATION.md + goal, refined)

1. Supervisor `SessionBindingTable` (new module `crates/pa-daemon/src/session_bindings.rs`): old-active-id -> {current active id, durable session_id, session_file}; survives worker removal (give-up/stop). Updated at attach success + launch_worker create success (old file -> new id = binding change event).
2. `route_client_command` resolve-failure seam: if selector unknown -> binding-table lookup by old id -> `find_by_session_file` -> if current resident exists + ownership gate passes -> REBIND: rewrite command's active id, swap connection `attached` old->new, route ONCE (first route never reached a worker, so exactly-once; admission_id stays the client's idempotency key for any client retry). Emit binding event to clients attached to old id.
3. Binding event (wire, NEW optional outbound type): `{"type":"session_binding","previousActiveSessionId":..,"activeSessionId":..,"sessionId":..,"sessionFile":..}` routed via ClientRouting::AttachedSession{old}. TUI: silent `self.active_session_id` update.
4. TUI send_prompt/submit paths: on Unknown-active-session error -> one rebind attempt per submit (attach by durable id via file stem resolve -> attach_session -> replay Prompt ONCE with same admission id).
5. Startup `Session::new` (session_ui.rs ~L497-533): attach failure on remembered id -> resolve durable (attach by durable id) -> rebind; session truly gone -> fall back to agents view with inline notice, do NOT `?`-exit.
6. E2E test in pa-daemon/tests: busy turn + forced replacement (kill recipe from supervisor_e2e.rs churn test ~L3609) + submit-on-old-id -> no disconnect, exactly-once (single admission); pane-restart on superseded id -> lands attached.

## BASE FACTS / HAZARDS

- Base clippy red from #2562 (clippy::match_result_ok, pa-types/process.rs) — heal PR #2565 driven by sibling lane; WAIT for it before gates, rebase, do NOT fix myself.
- transport.rs import OK at this tip (f8e628880 restored anyhow::Context).
- Benchmark check red on every rust PR = known tolerated state; never chase.
- Known pre-existing main red: pa-cli continue_guard_e2e @ 83fadc69.
- Gates in Prime VM sandbox only. New remote branches can't be pushed (no workflow scope) — push to EXISTING branch stale-active-session-rebind works normally (git push org stale-active-session-rebind).

## NEXT STEP (exact)

Read prompt_admission.rs fully (exactly-once seam) + protocol.rs response constructors + DaemonCommand::Prompt/Attach wire types in pa-types, then TUI session_ui.rs attach_session/send_prompt/Session::new regions. Then implement the binding table + supervisor seam. Sibling lanes daemon-recovery-fixes (supervisor.rs) and interrupt-paths (session_ui.rs) — message both BEFORE editing shared files.
