# LANE-STATE — stale active-session rebind (forensics #4)

Worktree: ~/lane-worktrees/session-rebind-fix (branch stale-active-session-rebind, rebased on org/rust @ 94d4edcef).
Goal: fix stale active-session rebind; PR base rust; merge after gates + bot threads resolved.

## STATUS: IMPLEMENTED + LOCAL E2E GREEN — next: VM gates, then PR

Implemented (all uncommitted work now in the tree; commit pending):
1. `crates/pa-daemon/src/session_bindings.rs` — SessionBindingTable (by_active_id + by_session_file,
   supersede repoints old id at the NEW binding; record() returns (old_id, NEW binding) for the event).
   Unit tests inline.
2. supervisor.rs — `session_bindings` field; `record_session_binding` (logs + emits
   `session_binding` event routed AttachedSession{old} + `session_rebound` daemon telemetry event);
   `binding_target(selector)` = binding_for -> find_by_session_file. Record sites: launch_worker
   create-success, route_client_command attach-success, handle_worker_register.
   Rebind seam in route_client_command resolve-failure arm: binding_target -> swap connection
   attached vec (only if previously attached) -> rewrite payload activeSessionId -> route ONCE.
3. prompt_admission.rs — same rebind seam in route_prompt_with_admission (admission id stays the
   client idempotency key; payload activeSessionId rewritten after the admission-id rewrite).
4. pa-types outbound.rs — DaemonOutbound::SessionBinding (Rust-only extension; old clients ignore).
5. pa-tui — daemon_client parses `session_binding` -> DaemonClientEvent::SessionBinding;
   session_ui `pending_rebind` field set by apply_client_event; interactive loop drives silent
   `attach_session(new_id)` + rebuild_view. send_prompt: one-rebind-per-submit loop (on
   "Unknown active session": attach by durable session_id, replay ONCE; exactly-once is structural
   — the refusal precedes any routing). NOTE: TS TUI sends NO admissionId on prompts, so the TUI
   prompt stays admission-free (wire parity); the brief's "same admission id" replay is covered by
   the supervisor-side admission seam + e2e (admissionId prompt over stale id).
6. Startup fallback — interactive.rs SessionUi::open Err arm: "Unknown active session" +
   SessionSelection::Attach -> InteractiveOutcome{return_to_agents_view, agents_view_notice}
   (new field); pa-cli interactive_mode.rs threads the notice into run_agents_view_flow
   status_message; anchor skipped when session_id empty.
7. docs/telemetry-events.md — `session_rebound` kind documented.
8. e2e: crates/pa-daemon/tests/session_rebind_e2e.rs — GREEN locally: kill + re-create same file,
   session_binding event asserted, prompt via stale id (WITH admissionId -> admission seam) streams
   turn back (attached-vec retarget proven), exactly-once via scripted-response ordering, attach by
   stale id lands on current worker, unmatched selector keeps raw error.

## INCIDENT LOG
- Box disk hit 100% ~02:30Z: session_rebind_e2e.rs was truncated to 0 bytes; rewritten. All other
  edits verified intact (marker grep, all present).
- My own worker was killed+respawned (~03:00Z): session rebound 0d3928dfa113 -> ad0b6ea03d61,
  roster relationship lost (agent_message to parent fails "No parent matches"; parent reachable via
  sibling send to durable id 01a0cbdc-d1d3-7228-a934-1e64c059f2a0). A prior incarnation of THIS
  session (turns outside current context) fixed session_bindings record() to return the NEW binding
  and finished the e2e test — verified correct, adopted.
- Parent evidence for PR body: 4 fleet incidents tonight in the rebind/adoption family, incl. a lane
  session displaced onto a private battery daemon (artifacts 01a0cc02-4698-76ab-a767-b80cd6f887c4).

## NEXT STEP (exact)
1. cargo fmt --all; commit; push org stale-active-session-rebind (existing branch; normal push OK).
2. Prime VM sandbox: prime sandbox --plain create --vm -y --name build-session-rebind --cpu-cores 4
   --memory-gb 16; copy branch; rustup component add rustfmt clippy; apt-get install -y iproute2
   lsof; cargo fmt --check + clippy -D warnings + cargo test -j4 --no-fail-fast --workspace
   (kernel tests need uv + PI_PACKAGE_DIR; search global memory 'sandbox gate'); DESTROY after.
   Pre-existing red to tolerate: pa-cli continue_guard_e2e @ 83fadc69; benchmark checks always red.
3. gh pr create --repo PrimeIntellect-ai/prime-agent --base rust. Body: parity-diff evidence
   (TS resolves attach by rootSessionId + createOrReuseWorker reuses the worker for a same-file
   create so TS never mints a stale id — Rust launch_worker always mints, hence the binding table;
   session_binding = Rust-only wire extension, old clients ignore unknown frame types; raw
   "Unknown active session" error preserved for unmatched selectors — existing tests untouched),
   ownership compliance (pa-daemon owns table+seams, pa-types wire type only, pa-tui client
   reaction, pa-cli notice plumbing; dependency direction unchanged), adoption telemetry
   (`session_rebound` in daemon event kinds, doc updated same PR). Delete CONTINUATION.md in the PR
   commit. NO Co-authored-by.
4. Bugbot/Macroscope threads; merge --squash --admin at the bar; goal.complete() only when MERGED.
