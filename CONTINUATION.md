# R6 continuation — fix/reliable-force-shutdown (`shutdown --force --json` guarantees)

Status: RESEARCH COMPLETE, NO CODE EDIT YET. This file is the handoff. Worktree
`/Users/kevin/pi/.worktrees/recovery-r6`, branch `fix/reliable-force-shutdown`
at e16196434 (== origin/rust tip). All paths below are relative to `crates/`.

## Findings (verified against this worktree)

1. The literal string `shutdown stalled: forced exit` does NOT exist in the CLI
   shutdown path. Closest hit: `pa-tui/src/exit_guard.rs:264`
   (`Prime Agent: shutdown stalled; forced exit.`) — the TUI double-Ctrl+C
   force-quit watchdog, stderr-only, unrelated to the CLI `shutdown` subcommand.
   The R6 finding should be read as the behavioral contract, not a literal.

2. CLI force path is `pa-cli/src/public_command.rs` `run_shutdown` ->
   `pa-cli/src/daemon_discovery/stop.rs` `run_shutdown_all` /
   `run_shutdown_converging` / `stop_background_service` /
   `shutdown_daemon`, with kill primitives in
   `pa-cli/src/daemon_discovery/kill.rs`. JSON output itself is already
   well-formed on every current path (`shutdown_report_json`); stdout never
   prints plain text under `--json`.

3. Real gaps matching the R6 contract:
   - `kill.rs` `force_kill_daemon(pid)` (used by both stop paths): SIGTERM,
     1s grace, then SIGKILL — but returns `()`. It never waits after SIGKILL
     and never verifies the process actually ended. Both callers then treat
     the kill as success.
   - `stop.rs` `stop_background_service` force branch and the
     `ReapActionKind::Kill` unreachable-listener branch in
     `run_shutdown_converging`: call `force_kill_daemon(pid)`, then
     unconditionally `remove_socket_file(...)` and report a `stopped`/reaped
     entry. A daemon that survives SIGKILL (D-state/unkillable) ends up
     reported as stopped with its socket file deleted — an invisible live
     listener. Contract violated twice: no SIGKILL deadline verification, and
     socket cleanup before confirmed process end.
   - `kill.rs` `terminate_verified_listener`: sends SIGKILL then immediately
     returns `process_start_id(...) != Some(start_id)` — a single check with
     no wait, so a slow-to-die process reads as survived (false failure) or a
     mid-teardown read races. Needs a post-SIGKILL poll until deadline.
   - Worker-side `stop_tracked_process` already implements the correct shape
     (SIGTERM -> 0.5s -> SIGKILL -> 1s verify, returns bool; failure recorded
     as `could not safely stop worker (pid N)` and worker records kept). The
     supervisor-side helpers should match that contract.
   - TS ground truth (`origin/main:packages/coding-agent/src/cli/daemon-ps.ts`,
     saved at /tmp/daemon_ps_ts.rs.txt): `forceKillDaemon` also does not
     verify post-SIGKILL; but TS's own `stopTrackedProcess` returns bool and
     reports failures. The verified-stop supervisor path is a deliberate,
     documentable hardening divergence (record in PORTING-NOTES style comment
     on the changed fns), consistent with the R6 lane spec.

4. `handled_pids` discipline: only insert the pid on confirmed death.
   `handled_pids` feeds the `--force` residual sweep's `already_reported`
   suppression and the "already stopped" dedup; a survived daemon must stay
   out of it so `terminate_verified_residuals` re-reports it as failed.

5. Cross-lane notes (flagged to daemon-recovery-fixes): R4 owns stale-worker
   socket cleanup; keeping the socket file when a daemon survives the force
   kill deliberately leaves a discoverable record for R4's sweep (it re-probes
   before touching). R1/R3/R4 lanes touch pa-daemon; this lane touches only
   pa-cli/src/daemon_discovery/{stop.rs,kill.rs} — no file overlap.

## Next patch plan (implement exactly this)

kill.rs:
- `pub(super) fn force_kill_daemon(pid: u32) -> bool`: keep SIGTERM + 1s
  grace; on SIGKILL add a verify loop (25-50ms poll, 1s deadline) returning
  `!is_alive(pid)`. Doc comment: verified-force-kill contract, TS divergence
  note.
- `terminate_verified_listener`: after `kill_pid(.., Signal::Kill)`, poll
  `process_start_id(pid) != Some(start_id)` until a 1s deadline; return the
  final verdict (true only when the identity changed within the deadline).

stop.rs:
- Add single helper used by both call sites (two users, not single-use):
  `fn verified_force_kill(pid: u32, socket_path: &Path, success_action: String,
  handled_pids: &mut HashSet<u32>) -> StopOutcome` — on confirmed death:
  `handled_pids.insert(pid)`, `remove_socket_file(socket_path)`,
  `StopOutcome::Reaped(success_action)`; otherwise
  `StopOutcome::Skipped(format!("could not safely stop daemon (pid {pid}); it survived SIGKILL"))`
  (wording mirrors the existing worker failure; socket file deliberately kept
  for discovery/R4). Success action strings stay byte-identical to today:
  `force-killed unresponsive background service (pid {pid})` /
  `killed unreachable background service (pid {pid})`.
- Rewire `stop_background_service` force branch and the `ReapActionKind::Kill`
  branch through the helper. No other behavior change; text and JSON shapes
  unchanged elsewhere.

Tests (focused, pa-cli only; keep fast):
- kill.rs: `force_kill_daemon` true path with a spawned `sleep 60` child
  (assert returned true, then `child.wait()` to reap); dead-pid pid returns
  true; `terminate_verified_listener` true path against a spawned child via a
  constructed `DiscoveredDaemonProcess`. CAVEAT: verify
  `pa-types::platform::process::is_process_alive` semantics first — if it
  counts zombies (child of the test) as alive, spawn detached or reap inside
  the poll window; unverified at handoff time.
- stop.rs: reason-string test for the survived failure; JSON shape test pinning
  `shutdown_report_json(&[], &[(socket, reason)])` to
  `{"stopped":[],"failed":[{"socketPath":...,"reason":...}]}` (serde_json
  from_str, camelCase) — the "well-formed JSON on every failure path" pin.

Validation: `cargo test -p pa-cli --lib` (fast, package-local only; NO
workspace gates). Then parity evidence for the PR body: text mode unchanged
(frame-diff vs TS binary if installed, else state skip), JSON mode documents
the hardened divergence. Telemetry: none (no new user-visible feature; failure
wording only). Then append-only commit, push, small PR to base `rust` via
create-pr skill, never comment on GitHub.

## Open acceptance items

- [ ] Zombie-vs-alive semantics of `is_process_alive` for the test approach.
- [ ] Decide final failure wording (proposed above) and keep it consistent
      between text and JSON modes (same string feeds both).
- [ ] PR body parity-diff evidence section (AGENTS.md merge gate) + ownership
      statement (pa-cli daemon_discovery scope).
