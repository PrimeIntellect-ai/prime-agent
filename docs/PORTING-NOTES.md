## Compaction arms coverage matrix — print/ACP/daemon reconciliation (lane print-arms-audit, 2026-09-20)

### The #229 flag, reconciled

#229's close-out said: *"Print mode shares the headless engine and also
lacks arms — out of this lane's scope, flagged for a follow-up lane."*

**Verdict: the wording was stale, but the flag pointed at a real gap.**
Print mode did NOT lack arms at the time #229 merged — #211 (overflow
compact-and-retry), #223 (pre-turn abort/requested/threshold), and #224
(compact-trigger auto-refine + requested refinement) had landed
`pa-cli/src/print_boundary.rs`, the print runtime's OWN `TurnBoundary`,
hours earlier the same day (08:15/14:35/16:25 vs #229's 20:19 UTC). What
print mode DID lack: one seam bypassed the boundary — the headless
autonomous continuation loop (`HeadlessAutonomous::drive`) admitted its
follow-up turns straight through `engine.session.prompt`, so continuation
turns crossed no arm. In TS the arms live inside the session's turn loop
(`agent-session.ts`), and an owed continuation is admitted through
`_createPreparedTurnAction("followUp", ...)` → `_prepareForCommit` →
`_runPreTurnCompaction` before the prompt, with the `agent_end` checks
after it — so every continuation turn ran the arms.

**Fixed in this lane**: `TurnBoundary::admit_continuation` (pre-turn check
→ followUp prompt → settled-turn checks); `drive()` routes every
continuation through it. Unit test:
`autonomous_continuation_turns_cross_the_boundary_arms`
(a continuation turn that overflows gets its compact-and-retry at the
settled boundary; without the fix the overflow error was the run's final
turn and no recovery ran).

**Superseded (the autonomous-ordering lane, 2026-09-21)**: the admission
shape above was applied to EVERY autonomous continuation, but the TS
ground truth (probed against the binary over the shared faux harness,
`--mode json`, prompts `["work", "/autonomous on --max-continuations 2",
"task"]`) runs the NATURAL continuation inside the agent loop — the
autonomous arm of `_getContinuationMessages`: `turn_end` → `turn_start`
with the continuation user row's message pair between them, NO
`agent_start`/`agent_end` between continuation turns, one `agent_end`
per prompt wait. A separate admission (a fresh `session.prompt` run)
shows run boundaries TS never emits. The queued `followUp` admission
(`_createPreparedTurnAction("followUp", ...)`) exists in TS only for the
THRESHOLD-HELD continuation (`_queueAutonomousContinuationForThresholdCompaction`:
mint ahead of the loop stop, compact at the boundary, run post-compaction)
and the goal's own held turns. The natural loop now rides the agent's
continuation hook on every surface (print: the composed
`print_autonomous.rs` hook; daemon: the engine's
`autonomous_continuation.rs` hook), and `admit_continuation` serves only
the held turns.

The loop's end was also re-probed: a passing gate, an exhausted limit,
`/autonomous off`, or an error/abort turn ends the loop with NO row and
NO stream frame (the print stream ends at the run's `agent_end`; the
headless stderr exit contract and the daemon's status request carry the
stop). The `autonomous_status` durable stop row the port had invented
(#98, never probed) is gone from every surface.

### Coverage matrix (arm × surface)

TS `agent-session.ts` hosts the arms in the session loop, so every
transport gets them; the Rust port hosts them per transport. Surfaces:

- **daemon worker** — the daemon session turn loop
  (`pa-daemon/src/agent_engine.rs` + `auto_compaction.rs` +
  `overflow_compaction.rs`): interactive TUI, daemon-attached ACP, every
  daemon-owned session.
- **ACP** — the in-process ACP transport fallback
  (`pa-daemon/src/acp/compaction_arms.rs`, #229;
  `PRIME_AGENT_FAUX_SCRIPT` forces this transport).
- **print** — the in-process print/json runtime
  (`pa-cli/src/print_boundary.rs`, #211/#223/#224 + this lane).

| Arm (TS `_checkCompaction` family) | daemon worker | ACP in-process | print |
|---|---|---|---|
| Case 1 overflow compact-and-retry (settled turn) | ✓ `overflow_compaction.rs` | ✓ #229 | ✓ #211 |
| Case 1 stale-overflow recovery (pre-turn) | ✓ `run_pre_turn_overflow_compaction` | ✓ #229 | ✓ #211/#223 |
| Abort arm: aborted trailing turn drops pending compact/refine (TS `skipAbortedCheck=false` pass) | ✓ `drop_turn_boundary_requests` on aborted turns | ✓ #229 | ✓ #223 |
| Model-requested compaction (`compact.run`), settled turn | ✓ `run_turn_boundary` | ✓ #229 | ✓ #223 |
| Model-requested compaction, pre-turn | — (settled only; TS `compact.run` refuses to schedule on an idle session, so a pending never survives to a pre-turn check — reachable-state note from #229) | ✓ #229 | ✓ #223 |
| Case 3 threshold compaction, settled turn | ✓ `run_auto_compaction` | ✓ #229 | ✓ #223 |
| Case 3 threshold compaction, pre-turn | ✓ (loop head, every admitted prompt) | ✓ #229 | ✓ #223 |
| Requested-refinement consumption (`_consumePendingRequestedRefine`) | ✓ `run_turn_boundary` | ✓ #229 | ✓ #224 |
| Compact-trigger auto-refine review (`_scheduleAutoRefineAfterCompaction` + checkpoint/`dispose` drain) | ✓ **this lane** (`compact_autorefine.rs`: every arm + the manual command arm the trigger, the quiescent boundaries consume the gated review — the interactive background `_maybeAutoRefine` mapping) | ✓ **this lane** (`acp/autorefine.rs`: serialized checkpoint consumption after the requested refine.run + the session-close drain) | ✓ #224 (serialized checkpoint + disposal drain) |
| In-flight compaction abort (`abortCompaction`) | ✓ abort slot (cancel/interrupt) | ✓ #229 abort slot | n/a (TS print mode has no abort trigger; signal handlers exit) |
| Overflow recovery reset points (agent-run start + settled non-error turn) | ✓ | ✓ #229 | ✓ #211/#223 |
| Autonomous continuation turns cross the arms | ✓ (continuations hosted inside the armed `run_turns` loop) | ✓ #229 (`run_pre_turn_compaction` before each injected continuation) | ✓ **this lane** (`admit_continuation`; was the gap) |

### Gaps flagged for follow-up lanes (pa-daemon owned)

1. **Compact-trigger auto-refine (daemon worker + ACP) — CLOSED by the
   daemon-acp-autorefine lane.** The machine lives in pa-core
   (`session_engine::auto_refine_trigger`: the arm/discard/increment
   accessors and one `consume_compact_auto_refine` with the
   gate/review/stamp sequence; every attempt — decline, success, or
   failure — stamps the cooldown, the surface parameter carrying the
   checkpoint-vs-disposal behavioral difference). The worker arms plus
   the manual `compact` command arm the trigger and the quiescent
   boundaries / the command path consume it (TS's interactive
   background `_maybeAutoRefine("compact")`, mapped onto the worker's
   synchronous turn loop); ACP consumes it at the serialized checkpoint
   after the requested `refine.run` and drains what no turn serviced at
   session close (`session/close` + stdin teardown). Differential:
   `scripts/daemon_autorefine_parity.py` (both sides schedule exactly
   one review after the `compact` command, identical trigger line,
   review-gate system prompt, and harness-state block; the seam fix in
   the same lane made the Rust review request carry the review-gate
   system prompt instead of the `/refine` subsystem prompt). Known
   constraint carried over (not introduced here): the worker hosts its
   pa-core session in memory, so an APPROVED round's apply step fails
   the local-refinement persisted-session gate exactly like the merged
   wire `refine` command and the kernel-requested refinement — the
   review fires and the cooldown stamps either way; the apply path
   waits on the worker-session persistence follow-up.
2. Pre-existing, noted, not an arms gap: the daemon worker reaches the
   requested-compaction arm only post-turn (#229's reachable-state
   note), and print prompts are not classified against session commands
   (a `/compact`-looking print prompt goes to the model as text; TS
   print executes the command) — the print command surface is a separate
   parity lane.

## compaction_count telemetry for all arms (lane compaction-telemetry)

Reference: TS `core/telemetry.ts` (`compaction_end` handling:
`activeRun.compactionCount++` when the event carries a result and was not
aborted) — every arm's completed compaction counts into the open run and
the session totals, whichever arm fired it.

- The Rust seam is `SessionTelemetry::note_compaction` (pa-core); the arms
  feed it per call site: manual `/compact` (pa-core session_commands) and
  the daemon wire `compact` command (pa-daemon `run_compaction`), the
  model-requested boundary arm (pa-daemon `run_turn_boundary` +
  pa-cli `requested_and_threshold_arms`), the threshold arm (pa-daemon
  `run_auto_compaction` + the same pa-cli helper), and the overflow
  compact-and-retry (already fed since #208/#211). A compaction outside an
  open run never counts, matching the TS activeRun guard.
- Verifiers: per-arm counter tests read the recorded `agent run completed`
  `compaction_count` — pa-cli injects a MockSink-backed telemetry client;
  pa-daemon ends the session telemetry and reads the local transparency
  mirror (`<agentDir>/telemetry.jsonl`, the product's own observability
  surface). The multi-compaction scenario asserts the session total equals
  the number of arms that fired (requested + threshold = 2).

### Merge with #207 (durable compaction_outcome seam)

- #207's typed `CompactionOutcomeReason`/`CompactionOutcomeKind` + the
  `record_compaction_outcome` seam supersede this lane's string-constant
  row factory; the overflow arm now records through it (durable append +
  live-context push + broadcast), like the threshold/requested arms.
- `emit_unsuccessful_compaction` gained a `custom_instructions` parameter:
  TS `_endCompactionUnsuccessfully` threads the consumed pending
  compaction's instructions onto the `compaction_end` event, which the
  overflow arm honors.
- Severity reconciliation (TS-exact, kept from this lane): automatic-arm
  failures carry NO `errorSeverity` on the wire (TS passes none); #207's
  e2e expectation encoded the pre-fix divergence and was updated.
- `AgentSession::last_assistant_message` skips trailing non-assistant rows
  (a compaction outcome disclosure) instead of matching them — without the
  fix, #207's live-context row push hid the stale overflow error from the
  pre-turn recovery arm.

## Overflow compact-and-retry arm (lane overflow-compact)

Reference: TS `core/agent-session.ts` (`_checkCompaction` Case 1,
`_runAutoCompaction` overflow/will-retry branches, `_endCompactionUnsuccessfully`,
`_overflowRecovery` resets) + `packages/ai/src/utils/overflow.ts` (the
classifier, already ported in pa-ai).

- The overflow arm fires at both TS boundaries: the settled-turn error path
  (`agent_end`) and before the next admitted prompt
  (`_runPreTurnCompaction`, whose Case 1 covers a stale overflow error from
  the previous run). The Rust turn loop (pa-daemon `run_turns`) wires the
  same two points around the #204 threshold arm.
- One recovery attempt per overflow (`_overflowRecovery`: idle → attempted
  → reported). Resets: prompt admission and every settled non-error
  assistant turn (TS resets at agent-run message starts and non-error
  assistant message ends). The retry re-issues the loop WITHOUT a new user
  message (TS `agent.continue()`): `run_model_turn` gains a `TurnAdmission`
  (fresh prompt vs continuation).
- Guards in TS order: the message may not predate the latest compaction
  boundary, `settings.enabled` (or a pending model-requested compaction,
  which the run consumes with its instructions), same-model, and the shared
  overflow classifier. The error turn leaves the loop context before the
  compaction and again after the rebuild (the kept tail re-adds it), both
  TS-exact drops.
- Failure surface (shared `_endCompactionUnsuccessfully` port, now also
  used by the threshold and requested arms): the durable `compaction_outcome`
  custom row first, then the `compaction_end` event; automatic-arm failures
  carry NO `errorSeverity` on the wire (TS passes none — the pre-existing
  threshold/requested `error` severity was a wire divergence, fixed here).
  Skip keeps the TS `warning`. The reported-overflow text is TS-verbatim:
  "Context overflow recovery failed after one compact-and-retry attempt.
  Try reducing context or switching to a larger-context model."
- Boundary with the quick-retry/failover loops (TS `_isRetryableError`
  excludes overflow): both pa-core drivers classify context-overflow
  failures as non-retryable and hand them to the compact-and-retry recovery.
- Residues left to other lanes: the pa-cli print path's own threshold loop
  (`print_runtime.rs`) has no overflow arm yet; the threshold/requested
  compaction arms do not feed `note_compaction` (adoption-telemetry seam)
  — the overflow arm does, matching the TS compaction_end counting.
- Verification: faux-driven daemon tests (the compact-and-retry cycle,
  retry recovery, skip warning, pre-turn stale-overflow recovery,
  non-overflow and disabled-settings negatives) and the f7_compaction
  battery rows (B-31: the scripted overflow probe drives both binaries and
  diffs the projected wire surface).

## Print-mode overflow compact-and-retry (lane print-overflow, 2026-09-20)

Reference: TS `core/agent-session.ts` `_checkCompaction` Case 1 (ported for
the interactive daemon path in the overflow-compact lane) driven by
`modes/print-mode.ts`'s `InProcessAgentConnection` — the TS print mode runs
the session's own turn-boundary checks, so the compact-and-retry recovery
applies there unchanged. Ground truth captured with the TS binary against
`scripts/battery/mock_provider.py` (scripted 400 `prompt is too long`
probes, isolated agent dirs, `--mode json`/text):

- Full cycle: `compaction_start` (reason "overflow") -> `compaction_end`
  (`willRetry: true`, result with `details`) -> the retried turn without a
  new user message -> the reported row pair (`message_start`/`message_end`
  custom `compaction_outcome`) then `compaction_end` (`willRetry: false`,
  the TS failure text, NO `errorSeverity`). Text mode: the assistant error
  line then the outcome row on stderr, exit 1. json mode: exit 0 — TS print
  mode never derives the json exit code from the terminal selection (only
  the autonomous gates or a thrown error do).
- Skip (nothing compactable): the dropped error turn leaves no primary —
  TS text mode prints ONLY the warning row and exits 0 (the Rust
  "No response produced." branch was an invented surface, removed here).
- Pre-turn recovery (`_runPreTurnCompaction`): a fresh process resuming a
  session whose context ends with an unresolved overflow (compaction was
  disabled in the earlier run) compacts BEFORE the admitted prompt, with
  `willRetry: true` on the end event — verified with `--continue`.
- In-process stale state: after a skip/failure the error turn is dropped
  from the loop context, so the next prompt's pre-turn arm no-ops (TS
  verified); a reported double-overflow leaves state `reported`, which
  no-ops the pre-turn arm without a second row.
- TS multi-prompt + retry race (not ported): TS `promptAndWait` can submit
  the next message while the retry's re-issued turn still streams
  (`Agent is already processing` error, exit 1). The Rust print loop awaits
  the retry to quiescence at the boundary, so the sequential print loop has
  no equivalent race; deliberately not replicated.

Port shape: `crates/pa-cli/src/print_boundary.rs` (`TurnBoundary`) owns the
print loop's boundary checks — the overflow arm (same guards as the daemon
arm: not-predating, enabled-or-pending-request, same-model, the shared
classifier; one attempt; the `continue_run` re-issue; the durable
`compaction_outcome` surface; json-mode events), the requested
compaction/refinement consumption, and the threshold arm. pa-core's
`consume_turn_boundary_requests` split into
`consume_pending_compaction`/`consume_pending_refinement` so the print
loop mirrors the TS `_checkCompaction` ordering exactly (the overflow arm
consumes a pending requested compaction when it runs; a reported arm
leaves it pending for the next boundary — TS-exact).

Known residues left to other lanes (verified against the TS binary, out of
this lane's scope): the print json stream has no `compaction_start`/
`compaction_end` events for the THRESHOLD and REQUESTED arms (only the
overflow arm emits them now); the threshold arm's skip/failure surface in
print mode still logs to stderr without the durable
`compaction_outcome` row the daemon records; TS print mode also emits
`refine_failed` (auto-refine after settled turns) which the Rust print
loop does not run.

## PR/git context (roadmap item 5, 2026-09-19)

Reference: TS `packages/coding-agent/src/utils/git.ts` (`captureGitContext`,
`runGit`) + `core/session-manager.ts` (`recordGitStateIfChanged`) +
`core/agent-session.ts` (`_emitExtensionEvent` recording git state on
`agent_start`/`agent_end`).

- Scope correction (audited against TS 0.9.5, installed binary and all repo
  branches): the TS product has NO PR-number extraction, NO review status,
  and never shells out to `gh`. Its git context is exactly three
  repo-identity fields (repoUrl, commit, branch). Porting a PR/review
  surface would violate the parity rule ("if Rust shows something TS does
  not, that is also a parity bug"), so this lane implements the TS strategy
  only. A future PR/review surface needs a TS release that carries it (or
  an explicit product decision against TS).
- `capture_git_context` (pa-core session/manager.rs) now matches TS
  byte-for-byte in behavior: `git --no-optional-locks` probes with
  ignore/pipe/ignore stdio; `branch --show-current` (detached HEAD yields no
  branch, not "HEAD"); every field independently optional with the context
  present when ANY probe succeeds (a fresh repo without commits still
  reports its branch); the remote URL normalized through the shared
  `packages::parse_git_url` port (same primitive TS `parseGitUrl` provides)
  and kept verbatim when it does not parse (scp-like ssh remotes).
- Git state recording is wired where the TS has it: the session engine's
  persistence listener records a `git_state` entry on `agent_start` and
  `agent_end` (the TS `_emitExtensionEvent` calls
  `recordGitStateIfChanged` on both), so a commit or branch switch made
  during a run (e.g. via bash) lands in the session file. The unchanged
  context dedupes via the leaf-to-root walk, exactly like TS.
- The TS `FooterDataProvider` (git-branch watching for extension custom
  footers) is intentionally NOT ported: the Rust TUI has no extension UI
  API yet, the TS `FooterComponent` renders nothing by default (footer is
  intentionally empty in the prime brand), so the port would be dead code
  with no consumer. It ports with the extension UI surface when that lane
  lands.
- User-visible surface audit (why there is no pane-capture evidence): the
  TS TUI shows no git/PR information anywhere by default (top bar = chat
  name + spend, tray = goal/heartbeat/model/context %, footer = empty);
  git context is data-only (session header `git` field, `git_state`
  entries, trace upload headers). The Rust port matches: same data, no
  new visible UI.
- Verifiers: `crates/pa-core/tests/git_context.rs` (fixture-repo capture:
  branch+commit+normalized URL, detached HEAD, no origin, scp-like ssh
  verbatim, non-git dir, fresh repo, dirty tree; session lifecycle:
  header capture, no-change dedupe, commit-change entry, branch-path
  re-record, git_state stays out of the LLM context; byte-parity pin of a
  real TS-binary session header) + `session_engine` run-boundary test.
- Parity evidence: `prime-agent -p --session-dir ... "say hi"` in a
  fixture repo (https remote, one commit) writes the header git context
  `{"repoUrl":"https://github.com/acme/widgets.git","commit":"5a0875...",
  "branch":"main"}` and zero git_state entries (unchanged context); the
  pinned test replays that exact header line through the Rust parser.

## Update boot sweep + roster restore + re-arm (slice 5, 2026-09-19)

Reference: `docs/update-flow-state-machine.md` (§6/§8/§10) over the TS
`restoreDaemonUpdateRestart` (package-manager-cli.ts) and the TS
supervisor's scheduled-wake machinery (daemon-supervisor.ts).

- The supervisor owns the boot side (spec §3/§6): the sweep, the
  roster-via-env restore, and the scheduled-work re-arm. TS drove restore
  from the coordinator over the client wire (`create` replay + a
  `restore_actions` RPC + a continuation `prompt`); the Rust design keeps
  the durable truth in the workers' recovery journals and session files, so
  restore is create-or-adopt in place: kept descriptors relaunch (the
  slice-3 adoption pass) and the supervisor's restore pass covers the rest
  from the roster row's captured create command.
- Divergences (spec, recorded):
  - The TS `restore_actions`/`resume_queue` RPCs are not transcribed: the
    worker's create replay rehydrates the session store and the persisted
    queue snapshot from the recovery journal, which IS the restore for
    both the relaunch and the roster-row create path.
  - The boot sweep (§6 step 1) is unconditional - it deletes a live
    coordinator's `status.json` scratch file too. The pa-cli status writer
    recreates the parent dir on every persist and the CLI tail graces a
    mid-tail missing file (`TAIL_SWEEP_GRACE_MS`); the coordinator's epoch
    keeps rising so late writes cannot regress state.
  - The scheduled-work re-arm is a boot pass (and a post-restore pass):
    due active jobs of sessions with no live worker are woken once
    (create-by-session-file, client id `scheduled-wake`, TS literal).
    Live sessions need no wake - their in-process scheduler claims due
    jobs itself. TS's permanent recompute-on-change wake timer
    (`recomputeScheduledSessionWake` on job mutations) is not transcribed
    in this slice: it is a general (non-update) daemon feature.
  - The continuation treatment sends the TS
    `UPDATE_RESTART_CONTINUATION_PROMPT` verbatim to a restored row that
    was mid-turn (`in_flight.streaming`); a queued-work row counts as
    resumed via its journal replay. The TS update-complete
    `append_custom_message` notice (origin-session marker) is slice 6's
    UX surface.
  - `hello.update_resume` (§10.3) is a Rust-only extension over the TS
    hello (the TS close frame carries no resume contract); TS clients
    ignore unknown hello fields.
  - The `update_restore_status` RPC (the coordinator's `Restoring` report
    input) is Rust-owned wire, like the slice-2/3 prepare/commit RPCs.
- Ownership: pa-daemon `update_restore.rs` (sweep, RestoreProgress, restore
  pass, re-arm, queued-attach + status surfaces); pa-cli `update_flow`
  (status-writer sweep survival, tail grace, restore report poll);
  pa-types (the `update_restore_status` command, the hello
  `update_resume` contract type).

## Update staged activation + coordinator (slice 4, 2026-09-19)

Reference: `docs/update-flow-state-machine.md` (§3/§4/§7/§9) over the TS
`daemon-update-restart.ts`, `native-update.ts`, `version-check.ts`,
`native-installation.ts`.

- The TS coordinator was a daemon-restart-only helper: TS's `pi update` ran
  the npm/install.sh self-update first and the coordinator then stopped and
  restored the daemon (phases starting/preparing/stopping/starting_daemon/
  restoring/complete, `proper-lockfile` registry). The spec redesign moves
  the whole flow into one coordinator FSM (`Acquire..Complete`) and makes
  the binary swap a coordinator phase (`Activating`) instead of an
  installer side effect. The Rust port keeps the TS surfaces that ARE the
  contract - the status-file schema (camelCase, plus `updateId`/`state`/
  `epoch`), the 5 s heartbeat, the Join relay, the `--internal-update-
  restart-*` flags, the probe messages - and replaces the phase machine.
- Divergences (spec, recorded):
  - `intent.json` is the lock (spec §4) - not TS's separate
    `update-restart-coordinators/` registry with `proper-lockfile`; the
    joining process reads the holder's `status_path` from the intent
    record's `status_path` field.
  - Rust release payloads (installer-ci-design.md §5) do not ship TS's
    `package.json`/`install.sh`; staging writes `.archive-sha256` and
    `.install-source` itself and validates the Rust payload list. The
    coordinator owns the symlink swap; the TS install.sh recovery marker
    check is not transcribed.
  - `Restoring` first shipped as adoption-based counts measured from the
    live successor; slice 5 replaced the phase body with the supervisor's
    restore pass reported over the `update_restore_status` RPC (see the
    slice-5 section). Counts are measured, never faked.
  - `update --rollback` runs the same FSM with the previous release as the
    candidate (the launcher swap repoints `bin/prime-agent` at
    `bin/previous`'s target; `bin/previous` then names the rolled-back-from
    release): the spec's `Rollback` state stays reachable only from the
    after-stop failure paths (`Stopped`/`Activating`/`Booting`), which is
    exactly the state table pa-types carries.
  - Telemetry: the `update completed` adoption event is emitted by the
    invoking CLI at the terminal status (coordinator mode never emits);
    spec §13.6 wires the remaining update-flow UX events.
- Ownership: pa-core `update` module (version policy, install-root layout,
  manifest fetch, staging) is daemon-free client support; pa-cli
  `update_flow` owns the coordinator FSM, the status/intent writers, and
  the activation swap; pa-daemon is untouched by this slice (the prepare/
  commit/stop drivers are slices 2-3).


## Update graceful stop + roster (slice 3, 2026-09-19)

The TS-era worker prepare/commit/cancel frames (`worker_prepare_update`/
`worker_commit_update`/`worker_cancel_update`, `daemon-mode.ts`'s
`createUpdateRestartSession`) are NOT transcribed. The Rust update flow
(spec `docs/update-flow-state-machine.md` §5/§8, replacing the TS manifest
flow) splits them into: a read-only `update_snapshot` worker command (the
worker reports its queue lanes, in-flight flags, and durable session id,
and flushes its recovery journal before replying - no freeze, no cancel
round-trip; a busy session keeps running and the graceful-stop budget owns
the exit), and the existing acked `shutdown` worker command as the
graceful-stop frame (its handler is already the flush barrier: journal
record + telemetry finalize before the reply, then the process exits).
Key divergences from TS, deliberate:
- The roster's per-session `next_turn` is empty on this build: the Rust
  engine has no separate next-turn custom-message lane (pending prompts
  ride the steering/follow-up lanes, persisted to the worker recovery
  journal and restored on respawn); `queue.actions` carries the lane
  snapshot.
- The roster's `in_flight` granularity is the honest superset: provider
  streaming, bash work, and retries all live inside a busy turn, so
  `streaming` = busy and `bash_running`/`retrying`/`prompt_in_flight` are
  false (restore treats `busy` as the continuation signal). `rlm_children`
  comes from the spawn ledger (supervisor-side).
- TS `UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS` (90 s) bounds the
  supervisor->worker snapshot RPC, always within the remaining prepare
  deadline.
- The stop budget maps to the spec §9 table: the acked request gets
  `worker_stop_ms` (30 s) and the exit wait gets `worker_stop_extension_ms`
  (30 s); a miss on either ABANDONS the update (the supervisor resumes
  Serving, refused sessions untouched, stopped workers relaunched) - no
  SIGKILL of a session, ever.
- The all-stopped exit keeps worker descriptors on disk (the new
  supervisor's create-or-adopt restore), unlike `begin_shutdown` which
  deletes them for a terminal stop.


## Update-prepare transaction (spec redesign over the TS prepare RPC, 2026-09-18)

`pa-daemon/src/update_prepare.rs` is a deliberate divergence from the TS
`daemon-supervisor.ts` `prepareUpdateRestart` path (documented in
`docs/update-flow-state-machine.md` §2/§5, not a transcription): TS runs the whole
prepare as one blocking in-process RPC (drain -> fence -> worker prepare -> manifest
persist -> commit -> stop) with a single 90 s deadline and no recovery state, so a
coordinator death between persisting and clearing its fence wedges the next boot.
The Rust side keeps the TS vocabulary and wire compat but restructures it:

- `prepare_update_restart` is idempotent on `updateId` (a repeat reports the current
  state; a different id is a typed refusal — TS refused concurrent prepares with the
  plain `"Daemon is already preparing an update restart"` string, which is kept as the
  message and now carries `DaemonErrorInfo::UpdatePrepareRefused`).
- The admission gate, mutation-drain latch (`MutationDrainLatch`, TS
  `mutation-drain-latch.ts`), gate refusal string, and the TS `UPDATE_RESTART_DRAIN_COMMANDS`
  pass-through during `Draining` are ports; the drain commands table and
  `READ_ONLY_DAEMON_COMMANDS` classification live in `pa-types::daemon::plane`
  (TS `daemon-protocol.ts`).
- Watchdog states (`Fenced`/`Snapshotted` TS never had) carry a durable
  `prepared/<update-id>/marker.json` self-expiry (45 s) in addition to the hard
  90 s prepare deadline, re-checked on a timer and on any later command, with
  `Aborted -> Serving` as the failure default — the structural fix for the wedged
  prepare.

## Daemon discovery containment (operator directive, 2026-09-17)

The OS-level daemon discovery (`pa-cli` `daemon_discovery`) was killing this box's live
mission daemon: a test process that inherits the ambient `HOME`/`TMPDIR` resolves
`current_state_root()` onto the mission daemon's real socket dirs (`/tmp/prime-agent-1000`,
`/tmp/mission-tmp/prime-agent-1000`), so a scan or `--force` residual sweep found, probed,
and SIGTERM'd the mission supervisor's workers. Two structural fixes, both deliberate
divergences from the TS `cli/daemon-ps.ts` shape:

- Every scan, probe, unlink, and kill is scoped to an explicit `DaemonStateRoot` handed in
  by the caller (the CLI passes the env-resolved current root; tests pass only fixture
  directories they created). The root filter runs inside the OS census, before any probe or
  signal, so a daemon outside the given root is never even a candidate.
- `NEVER_TOUCH_SOCKET_DIRS` is a hard exclusion list checked unconditionally in the scan,
  probe, socket-dir sweep, and unlink paths, even when a state root deliberately points at
  them. It lists this sandbox's mission paths, including `/tmp/prime-agent-1000` — which is
  also the product-default socket dir for a uid-1000 Linux user with `TMPDIR=/tmp`. That
  product-parity trade-off is accepted for this mission sandbox per the operator directive;
  revisit before any release cut of the binary.


## Child-session stream hang (observed in production, 2026-09-16)

Three child sessions hung mid-turn: `isStreaming=true` with zero progress for 20+ minutes,
provider endpoint healthy (parent session streamed fine concurrently), steer-mode messages
ignored. Daemon restart was required. Relevance to the pa-daemon redesign:
- The supervisor must own per-worker stream deadlines: a worker whose provider stream makes no
  progress for N minutes must be aborted and the turn restarted with a bounded context, not left
  streaming forever. The TS daemon's quiescence wait "cancels" but does not kill the stream.
- A steer/interrupt arriving while a stream is hung must hard-abort the underlying provider request;
  queued nudges are not enough.
- Worktree/branch state survived every hang and restart; per-unit commits by workers are the
  mitigation while this bug exists in the TS daemon we operate under.


## Hang recurrence + supervisor adoption failures (2026-09-16, post-bounce)

- Child streams hung again ~15 min after a clean daemon bounce (same signature: streaming=true,
  zero message-count progress, endpoint healthy for parent). Steers queued but ignored.
- Supervisor log: after bounce, 5 of the old workers failed adoption ("Session worker process is no
  longer running"); workers are NOT idempotently recoverable across supervisor restarts.
- Design implications for pa-daemon: (1) adopt/recovery journal must cover in-flight provider
  streams, not only tool ops ("recovered without replaying uncertain operations" loses stream state);
  (2) hung child streams need a supervisor-side progress watchdog with hard abort; (3) supervisor
  restart must be able to re-spawn workers from durable descriptors rather than fail adoption.


## Attach event stream: deferred model-surface diffs (2026-09-17)

The f6 attach cross-side fingerprint (battery `run_battery.py`) locks the projected
event sequence: agent_start/turn_start, the user message_start+message_end pair,
assistant start/updates/end ordering, turn_end/agent_end presence, session_status.
Two TS wire behaviors are deliberately out of that row's scope and still open:

- The per-turn harness digest rides TS turns as a `custom` message pair
  (`message_start`/`message_end` with `customType: harness_digest`); the Rust
  session engine composes the digest into the request only and never projects it
  on the wire. Fixing this couples to custom-message session-entry parity
  (f3/f8 resume surfaces) — model-surface lane.
- TS `turn_end` carries the final assistant message (and `agent_end` the message
  list); the Rust worker emits both bare. Same coupling: the payload is the
  durable turn record, owned by the session engine. The `turn_end` half landed
  (lane turn-end-frame, 2026-09-21): the engine forwards the loop's
  `TurnEnd`/inner `TurnStart` boundary events and the worker frames them in
  the TS shapes — the terminal assistant message plus the turn's
  `toolResults` on every settled turn (aborts and provider errors included,
  probe-verified cross-side on
  settled/abort/abort_and_send_queued/compact/kill/abort_and_clear_queue
  in `scripts/battery/aborted_row_probe.py`). The `agent_end` `messages`
  payload is still open. The worker's Done-synthesized frames are now a
  fallback for runs that ended without a model turn (session commands,
  pre-model failures) and stay silent once the engine's own `turn_end` passed.

Both are wire-projection only (no request/cache-prefix effect). The battery
filter that excludes them is annotated in `run_battery.py` and must be removed
when the model-surface lane lands custom-message wire parity.

## Lock convention: proper-lockfile directory locks (2026-09-17)

TS ground truth (`proper-lockfile` 4.1.2, used by auth.json / settings.json /
cron state): a lock is an EMPTY DIRECTORY at `<file>.lock`, mtime probed to
"next second + 5ms", judged stale from mtime alone (10s default, 30s cron),
reclaimed by rmdir + retry (one fresh attempt; a reappearing rival is
ELOCKED). Release rmdirs it. A regular FILE at the lock path is fatal to the
TS release path (ENOTDIR): pre-compat Rust flock files wedged real installs
by making `AuthStorage.reload()` fail, silently losing auth. `pa-core
platform::lock_dir` implements the convention; the Rust binary additionally
heals stale or unheld legacy lock FILES (a held legacy flock reads as
contention), which the TS binary cannot do.

Deliberate divergences (candidates for the lock-audit follow-up unit):
Rust does not refresh the held lock's mtime (TS updates every stale/2) and
does not detect compromise (TS `onCompromised`); Rust lock holds are short
read-modify-write cycles, so staleness takeover only sees genuinely crashed
holders. The cron `with_state_locks` still runs its action unlocked when
acquisition fails (pre-existing shape; now logged at warn) because the store
API has no failure channel; TS throws there.


## System prompt: layered redesign supersedes TS-prompt parity (roadmap item 3, 2026-09-18)

The Rust product ships the redesigned layered system prompt as its native prompt
(adopting Sebastian's draft text), not the TS product's base prompt. TS-prompt
parity is explicitly superseded for the system prompt only; every other
model-surface row still compares against the TS binary:

- The prompt is assembled from human-editable layer files (`pa-core`
  `prompts/layers/`): `core.md` (harness description + the full programmatic-tool
  API), `usage.md` (mandatory rules), `opinionated.md` (overridable guidelines),
  `per_model.md` (per-model instruction map, shipped empty). These form the
  cache-stable prefix.
- Every session-specific value (packages, project context, skills inventory,
  MCP servers, environment, session role) is appended strictly after the prefix
  as the dynamic tail, so providers can cache the prefix across sessions.
- `prime-agent prompt [--model] [--cwd] [--json]` dumps the fully-assembled
  effective prompt with the per-layer breakdown (cached prefix vs dynamic tail).
- The golden system-prompt test now pins the Rust prompt itself
  (`PA_UPDATE_GOLDEN=1` regenerates) instead of the TS text; the battery f2 row
  checks the layered shape (static layers, then the dynamic tail) and keeps the
  raw TS prompt in `protocol-request-diff.txt` as reference evidence. The
  `prompt` CLI command is Rust-only until the TS product adopts one; the
  differential CLI corpus normalizes it out of the help comparisons.

## Kernel packaging lane notes

- Sandbox cargo gates for kernel-dependent tests: a sandbox build bakes the
  build machine's source-checkout path into runtime resolution, and a bare
  sandbox has no `uv` and no packaged sidecar — every kernel ipython cell
  fails at startup (`kernel startup failed … uv is required …`). Gate runs
  whose tests execute ipython cells (the pa-daemon goal-loop worker test,
  the f18 battery flow) must install uv
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`) and export
  `PI_PACKAGE_DIR=<repo checkout>` so the vendored `prime-agent-runtime/`
  resolves (docs/parity-battery.md, "Sandbox-built rust binary + kernel
  runtime"). Without it the goal-loop worker test fails with a misleading
  continuation-count mismatch: `goal.complete()` never runs, the goal stays
  active, and the loop (TS parity: goal continuations are unbounded while
  the goal is active) mints until the faux script runs dry.
- Packaged layout (TS install.sh native path + copy-binary-assets.mjs): the
  release artifact is the binary plus exe-adjacent `package.json` (the
  version manifest: `{"version", "piConfig"}`), `prime-agent-runtime/` (the
  vendored sidecar), `skills/`, `docs/`, `README.md`, and `LICENSE`. Runtime
  resolution (`pa-core/src/kernel/bootstrap/venv.rs` `packaged_runtime_dir`,
  moved with #118's bootstrap split) is
  `PI_PACKAGE_DIR` -> binary directory -> `dist/` -> source-checkout root
  (TS `runtimeCandidateDirs` module-relative candidates; the compile-time
  workspace root replaces them and never resolves on a user machine).
- Relation to the installer-ci lane's `scripts/release/assemble_artifacts.py`
  (merged in #114): that script assembles the CI distribution tarball +
  `manifest.json` (release-pipeline contract, staged at `ci/workflows/`),
  while `scripts/package_release.py` is the TS-installer-packaging dry run
  (exe-adjacent layout, dev-cache exclusions, version pin, `SHA256SUMS` +
  `binaries.json`); `make release-dry-run` runs the former, `make package`
  the latter.
- `scripts/package_release.py` ports `assemble-release-archives.mjs` +
  `copy-binary-assets.mjs`: staging walk rejects symlinks and the TS
  exclusion set (`node_modules`, `.venv`, `__pycache__`, `*.pyc`,
  `*.egg-info`, caches, `.git`, `.DS_Store`), `validateBinaryAssets`-style
  required-asset checks, version pinning (the binary's compiled `--version`
  must equal the release version - cargo embeds it, where TS stamps
  `package.json` post-build via `setBinaryVersion`), `SHA256SUMS` +
  `binaries.json` (`{platform, file, sha256, executableSha256}`), and a
  flat tarball `prime-agent-<version>-<platform>.tar.gz`. `make package` is
  the entry point; `--root` re-anchors assets for the e2e's synthetic tree.
- `--version` reads the packaged `package.json` at runtime (TS `VERSION`
  is `getPackageJsonPath()`-based) with the compiled-in version as the
  fallback (dev checkouts). `--prime-agent-bootstrap` is the TS
  `runtime-bootstrap.ts` installer handoff: `ensureKernelPython` + prints
  `kernel python: <path>`; the TS fd/rg preloads (`ensureTool`) are not
  ported (no tools-manager in this build yet).
- Missing-sidecar failure UX: bootstrap failures keep the TS
  `formatBootstrapFailure` text and append a hint naming the executable
  directory when the packaged sidecar is absent (the registry fallback the
  TS keeps would otherwise surface a bare pip error; the runtime is not on
  a registry).
- Verifier: `crates/pa-cli/tests/packaged_layout_e2e.rs` - a staged layout
  boots a kernel session with `PI_PACKAGE_DIR` removed (the ipython cell
  runs with a live `rlm`, the staged marker skill reaches the skill
  inventory, the staged manifest reports the pinned version), the
  missing-sidecar and bad-override failure UX, and the packaging dry-run
  (staging, exclusions, version pin, `SHA256SUMS`/`binaries.json`, tarball
  integrity). The ignored test bootstraps a fresh venv from the packaged
  sidecar over uv + network.
- Print-mode faux scripts accept content-block entries (tool calls) through
  the shared `pa_ai::faux::script::parse_faux_script` (the daemon worker
  seam already used it), so binary-level e2e can script full kernel turns.

## Compaction outcome rows (2026-09-20)

Reference: TS `core/messages.ts` (`createCompactionOutcomeMessage`,
`convertToLlm`), `core/agent-session.ts` (`_endCompactionUnsuccessfully`,
`_persistCompactionOutcome`, `_mergeUnpersistedOutcomes`, `compact`), and the
TS suite pin `agent-session-compaction.test.ts`
("emits a warning and persists the outcome outside model context").

- The durable `compaction_outcome` row is a user-facing disclosure, NEVER
  model context: TS `convertToLlm` filters it (the TS test asserts
  `convertToLlm([outcome]) === []`), so the KV-cacheable provider prefix is
  unaffected. The Rust `convert_to_llm` had the exclusion already; the seam
  (`AgentSession::record_compaction_outcome`) pins it in tests. The live
  push mirrors TS `agent.state.messages.push` (the loop's default converter
  filters custom rows out of the provider request).
- Manual `/compact` records NO outcome row (TS `compact()` emits
  `compaction_end` and throws to the caller; only `_runAutoCompaction` ->
  `_endCompactionUnsuccessfully` persists). The Rust manual paths
  (compaction.rs, the `/compact` session command) stay event-only by design.
- The TS `_unpersistedOutcomes` fallback (a failed session-file append keeps
  the row in memory, timestamp-merged into rebuilt contexts) is held
  structurally in Rust: `SessionManager` keeps fire-and-forthing persistence
  (a failed disk write cannot remove the in-memory entry), and every
  in-process rebuild reads that entry chain. The failed-write test pins the
  guarantee.
- Parity fix found by this lane: TS throws `Summarization failed: <error>`
  when the compaction summarizer returns an error-stop assistant message
  (compaction.ts); the Rust `execute_compaction` ignored `stop_reason` and
  "succeeded" with an empty summary. The check is now ported (the failure
  arm of every auto-compaction path).
- The overflow arm stays unported (no Rust overflow recovery path yet); the
  reason vocabulary (`threshold`/`overflow`/`requested`,
  `skipped`/`cancelled`/`failed`) rides the row details exactly like TS.

## Recovered-session compaction walk (2026-09-20)

Reference: TS `cli/owned-session-worker.ts` (`createRpcRecoveryArgs` +
the crash-recovery relaunch), `core/agent-session.ts` (`_performCompaction`
walks `this.sessionManager.getBranch()`), `core/session-manager.ts` (the
one store: resume opens the session file into the branch).

- TS's owned-session worker recovers a crashed session by relaunching with
  `--resume <sessionFile>`: the fresh AgentSession's SessionManager opens
  the durable store, so the branch — and the compaction walk over it —
  sees the full pre-crash history. One store: the walk and the loop
  context cannot diverge from the file.
- The Rust daemon worker splits the store by design: the worker owns the
  session file (emit-closure persistence), the engine's core session keeps
  an in-memory manager, so the recovered engine's branch started empty —
  a post-recovery compact walked a fresh branch and skipped with
  "Session is too short to compact" even when the durable file was long.
- Fix (mechanism parity, not transcription): `adopt_built_session` (the
  engine's build-adoption seam) rebuilds the branch from the worker
  session file whenever no replacement branch was parked — the same
  `rebuild_branch_context` path tree navigation and the replacement flows
  use, fed by the worker's own `SessionFile` reader
  (`branch_file_entries`, the branch the store would walk). Every build
  re-syncs: fresh creates adopt their prefix rows (no messages yet, so no
  prompt change), recovery builds adopt the full durable history, and a
  moved replacement branch still wins (the parked `pending_branch` keeps
  priority; the durable seed never runs after it).
- Id notes: the engine's in-memory branch and the durable file keep their
  own entry ids (pre-existing split — the worker re-pins a compaction
  row's `firstKeptEntryId` to the durable cut at the emit site). After a
  recovery the branch IS the durable rows, so a later walk's boundary
  lookup resolves durable ids exactly like TS's one store; the walk's
  keep/summarize math is unchanged (`prepare_compaction` +
  `find_cut_point` over `FileEntry`s).
- Verifiers: `recovered_engine_compaction_walk_sees_the_durable_history`
  (pa-daemon unit — a durable two-turn file, a fresh engine build, one
  recovery turn, a manual compact that runs instead of skipping) and the
  `killed_mid_goal_worker_rehydrates_the_goal_with_counts` e2e's
  post-recovery compact (the second compaction entry lands durably and
  the mint continues the rehydrated count to `continuationsUsed` 2).

## Aborted-turn row broadcast + persist (2026-09-20, the #245 flagged gap)

Reference: TS `agent-loop.ts` (`createAbortedAssistantMessage` +
`finishAbortedMessage`: the abort racing the turn pushes the aborted
assistant row — the partial's content/usage when one streamed, otherwise
empty text and `EMPTY_USAGE` — onto the context and emits its
message_start/message_end pair), `agent-session.ts` (`_processAgentEvent`:
every assistant `message_end` reaches the listeners AND
`sessionManager.appendMessage`, stopReason included; the goal accounting's
`_accountGoalUsageForAssistantMessage` skips `error`/`aborted` rows while
the autonomous accounting counts everything non-error).

- The Rust engine already produced the row (the agent loop port's
  `create_aborted_assistant_message`); #245's eager fetch abort made the
  settle land mid-provider-wait. The gap was the worker gate: the turn
  emit closure's `abort_requested` check returned false for every event
  of a cancelled turn, so the aborted row — which TS broadcasts and
  persists — was dropped from the wire and the store, and a turn whose
  cancel landed mid-stream never surfaced its final row at all.
- Fix: the gate forwards the row's own events (an
  `EngineEvent::AssistantMessage`/`AssistantUpdate` whose message carries
  `stopReason: "aborted"`) through the persist+broadcast path — the row's
  start frame rides the wire, the settled row persists as a `message`
  entry exactly like any other assistant row, and the turn still unwinds
  (the gate keeps returning false for every other post-abort event).
  `run_turn_once` drains the settled run's tail through the same gate, so
  the row emitted after the cancel reaches the wire in both cancel
  orders (mid-wait and mid-stream).
- Accounting unchanged (the #245 ruling): the row persists but the goal
  accounting skips it (the subscription's aborted guard sees the row's
  EMPTY usage and never touches the goal state); the autonomous
  accounting counts it like TS's non-error guard.
- Surface matrix (probe-verified against the TS binary,
  `scripts/battery/aborted_row_probe.py` — a daemon wire/store probe over
  a held mid-provider-wait turn): `abort`, `abort_and_send_queued` (the
  interrupt that also delivers the parked steering at the boundary, schema
  29), and `abort_and_clear_queue`
  broadcast + persist the row (TS `requestAbort` keeps the session
  subscribed), and so does the close family (`kill`; shutdown rides the
  same TS close path) — the gate forwards the row on all of them. The
  `compact` path does NOT: TS `compact()` detaches from agent events
  (`_disconnectFromAgent()`) before `abort()`, so the row vanishes there —
  the interrupt-and-settle helpers (compaction + branch navigation) set
  `SessionCore::suppress_aborted_row`, closing the gate's exception for
  that turn exactly like the detach. The branch-navigation interrupt
  keeps the same suppression (TS's navigation waits out the in-flight
  turn — `agent.waitForIdle()` — and never surfaces a row).
- Verifiers: `active_goal_aborted_turn_row_broadcasts_and_goal_accounting_skips_it`
  (pa-daemon unit — the goal-start turn accounted, the held turn aborted
  mid-provider-wait, the row broadcasts as the start+end pair with the
  aborted shape, and the goal state is unchanged),
  `aborted_turn_row_broadcasts_and_persists_through_the_worker_gate`
  (pa-daemon worker unit — the real faux engine through the worker gate:
  the attached client sees the row's pair, the session file holds the
  same row, and the goal state is unchanged),
  `compact_interrupt_swallows_the_aborted_row` (pa-daemon worker unit —
  the compact interrupt's row stays off the wire and out of the store),
  and the probe run (all four abort surfaces compared against the TS
  binary, wire + session file).
- Flagged residue (probe evidence, `runs/` style, not this lane): the
  Rust `kill` on a busy session BLOCKS on the core session mutex inside
  `archive_session_telemetry` — the mutex a running turn holds across
  its admission — so the abort lands only after the turn settles
  naturally (the probe shows the held turn streaming its full reply 15s
  after the kill). TS `closeSessionOnce("killed")` awaits
  `session.abort()` before the dispose, killing the fetch mid-wait. The
  flagged turn_end residue landed (lane turn-end-frame): the frame now
  carries the terminal/aborted message payload and survives aborted turns.
- Flagged residue (pre-existing, proven on the MAIN binary — run
  `20260921T061150Z` in `scripts/battery/runs/`): the f7 goal-continue
  projection's completion rows — TS emits the completion turn's
  `message_end` before the `goal_update` (complete), the Rust engine's
  drain can lag the agent loop (the unbounded channel lets the tool
  execution and the kernel's `goal.complete()` host request land before
  the loop forwards the streamed rows), so the announcement can precede
  the row (3/3 lane-binary runs and the main baseline both show it).
  Owner: the #244 goal-continuation surface. The same baseline run also
  reproduces the split-turn summarizer request-order flip (the battery's
  own nondeterministic-arrival note) and the suspension compact's
  too-short/compacted flip — run-to-run flakes, not this lane.

## Wire JSON key order: insertion order, not BTreeMap order (2026-09-21, the #255 flagged residue)

The #255 flagged product bug: the durable compaction row's `details`
key order diverged from the TS bytes (`{"modifiedFiles":[],
"readFiles":[]}` vs TS `{"readFiles":[],"modifiedFiles":[]}`), and the
daemon `compact` response data plus the session header line carried the
same divergence. Root cause: every wire/durable surface serializes
`serde_json::Value` maps, and serde_json's default `Map` is a `BTreeMap`
— insertion order is thrown away and every object re-sorts its keys
alphabetically at serialization time. The TS side byte-emits JS
insertion order everywhere, so every Value-built frame diverged, not
just the flagged row. (Mechanism note for the #255 flag itself: the
order was deterministic-but-wrong across the evidence runs, not a
run-to-run HashMap flip; the PR #255 wording over-attributed the
mechanism. The byte-parity consequence is the same.)

The fix is a workspace-wide semantic, not a per-site patch: serde_json
now runs with `preserve_order` (the workspace dep plus pa-tui), so
`Value` maps keep insertion order — the JS object model the TS daemon
and session files byte-emit. Serde struct field order then IS the wire
byte order, so the lane re-pinned the order-critical construction sites
to the TS declaration order:

- `response_line` (`{id?, type, command, success, data|error|errorInfo}`),
  `session_header_line` (`{type, version, id, timestamp, cwd, ...}`),
  `SessionHeader` field order, `compaction_summary_message`
  (`{role, summary, tokensBefore, retainedMessageCount,
  customInstructions?, harnessDigest?, timestamp}`), the worker's
  `handle_attach` result and snapshot (TS `createAttachResult` /
  `createSessionSnapshot` order), and the scripted-engine compaction
  fallback's `firstKeptEntryId` position. The compaction seams were
  already in TS order (the `CompactionEntry`/`CompactionDetails`/`Usage`
  struct fields and every `json!` literal).
- Audit of unordered std maps that would leak HashMap iteration order
  into bytes once maps preserve insertion order (all switched to
  `BTreeMap`, none reached wire JSON before): bedrock
  `request_metadata` (provider request body), `Model.headers` and
  `ThinkingLevelMap` (model catalog wire), `ProviderResponse.headers`
  (on_response hook payload, collected ordered at the 9 provider call
  sites), the models.json config maps, the request-auth header merge
  chain, and the harness state file's `entries`. Two latent unordered
  reads were fixed by the same switch: bedrock picked an arbitrary
  model header (`iter().next()`), and the harness state file wrote
  random key order straight from a `HashMap`.
- Enum variants carrying the now-wider insertion-ordered `Value` maps
  trip clippy `large_enum_variant` and are boxed:
  `CompactionOutcome::Compacted`, `GoalFollowUp::Turn`,
  `PeerDeliveryOutcome::Answered`, and the pa-agent
  `TaskOrOutcome::Outcome`.
- Cache-prefix note (MISSION.md first-class rule): request bodies are
  built from `json!` literals and typed structs, so preserve_order
  changes the provider request byte order from alphabetical to the
  construction order — deterministic per code path, stable across
  runs, so prefix stability holds; the request bytes never matched the
  TS SDK's own serialization either way.

Verifiers: unit tests byte-assert the TS-captured key sequences
(`durable_compaction_row_serializes_in_the_ts_key_order`,
`response_line_serializes_in_the_ts_key_order`,
`session_header_line_leads_with_the_type_tag`, the details and compact
response byte assertions in `compaction.rs`/`compaction_exec.rs`), the
session-header/attach/stats golden asserts in supervisor_e2e now encode
the TS order their comments always claimed, and five f7_compaction
battery runs (`scripts/battery/runs/20260921T162*.Z`-`165*.Z`) show the
durable `details` block byte-identical to TS in every run (before:
`{"modifiedFiles":[],"readFiles":[]}` in all prior runs, e.g.
`20260921T140248Z`). The f7 residual gaps in those runs are the two
known flakes: the split-turn summarizer request-order flip (proven on
the MAIN binary, run `20260921T061150Z`, PORTING-NOTES above) and the
ipython-prewarm 15s settle window (box at load 13-17 with ~94 leaked
lane daemons; passes in the runs it lands in). Residue NOT fixed here:
the `DaemonOutbound::Response` tagged-enum arm is never serialized
(tag-first vs TS id-first would diverge if it ever goes on the wire).

## SetModel resolver + status-bar refresh — the dogfood model bugs (2026-09-21)

Root cause (both live dogfood symptoms, Kevin's repro): the daemon fed the
model resolver the auth-scoped `available` list where TS resolves against the
full catalog.

- `resolveCliModel` (TS) uses `modelRegistry.getAll()` — "use *all* models
  here, not just models with pre-configured auth. This allows --api-key to be
  used for first-time setup". The daemon's `resolve_registry_model` passed
  `registry.get_available()` instead, so a session whose worker had no visible
  provider credential (the dogfood daemon: no PRIME_API_KEY in its env chain,
  empty auth.json, no models.json) failed every flagged-model resolution with
  "No models available. Check your installation or add models to
  models.json." (resolver.rs's all_models-empty branch) — including the turn
  after a `/model` pick.
- The run-start credential check (`_validateCanStartAgentRun`) was not
  ported: TS fails such a turn BEFORE the provider request with the
  login-guidance message ("No API key found for <provider>..." / the OAuth
  stale variant); the Rust turn had no equivalent gate.
- `refresh_model_label` adopted the label only from `get_state`'s `model.id`;
  TS `applyModelSwitchUiState` falls back to the picked model
  (`state.model ?? fallbackModel`), so a worker summary that cannot
  re-resolve the model left the footer label stale.

Fixes: `resolve_registry_model` passes `registry.get_all()`; `run_model_turn`
ports the TS preflight (create-config apiKey covers the TS runtime-key
candidate; the scripted faux seam has no credentials); `refresh_model_label`
falls back to the picked model.

A pick against a credential-less worker still fails with "Model not found"
(TS parity — the Sep-16 dogfood log shows the TS daemon failing the private
pick "Model not found: prime-inference/internal/glm-5.3-fast" identically);
the label stays because nothing switched, on both products.

Known follow-up (out of lane): the TUI's error row wraps daemon rejections
("the daemon rejected the set_model request: ...") where TS `showError`
renders the bare message; the `request_ok` wrapper text is a wider
client-parity surface.

Verifiers: `tui_flagged_model_turn_reports_the_ts_preflight_error_without_credentials`
(the dogfood env: hermetic worker, no credentials — pick fails with the TS
row, the flagged model resolves, the turn fails with the TS preflight
message, no "No models available", the label holds) and
`tui_model_pick_refreshes_the_label_and_the_next_turn_resolves` (a models.json
pick refreshes the footer label and the post-switch turn reaches the
provider); `protocol_breadth_parity.py` (incl. the set_model close-out) ALL
MATCH; battery f17_slash_model + f22_provider_failover: 0 gaps, 12 checks,
frames identical. Sandbox gates: fmt, clippy -D warnings, cargo test
--workspace (86 suites) green. The `--all-targets` compile break in
pa-daemon's test engines (#251's second `rebuild_session_context` impl) is
fixed in-lane so the lib tests run at all.

## Clipboard/auth/update client commands (PR: `pa-tui: clipboard/import/auth/update commands (TS parity)`)

TS reference: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` —
`handleCopyCommand`, `handleImportCommand`, `handleTracesCommand`,
`handleUpdateCommand`, the `login`/`logout` dispatch arms, `auth-flows.ts`,
`utils/clipboard.ts`, `oauth-selector.ts`, `extension-selector.ts`,
`session-cwd.ts`, `agent-traces.ts`, `prime-inference-auth.ts`,
`package-manager-cli.ts`.

- `/copy`: the full TS clipboard chain (platform tools first — pbcopy/clip/
  termux/wl-copy/xclip/xsel gated on their session envs — with the OSC 52
  fallback for remote sessions or when nothing copied, `100_000`-byte
  encoded cap, TS wording on failure). The OSC 52 emitter is its own
  module (`osc52.rs`) so the mouse-selection drag-copy lane can reuse the
  same bytes. Text comes from the daemon `get_last_assistant_text` (the TS
  connection call), trimmed-empty answering the TS error row. Verifier:
  raw-pty byte capture of both binaries on the same scripted turn —
  `scripts/clipboard_parity.py` PASSes (identical `]52;c;<b64>`
  sequences, same payload); headless e2e asserts the emitted sequence and
  the status/error rows.
- `/import`: TS path argument parse (shared with `/export`), the TS confirm
  ("Import session" / "Replace current session with <path>?"), the daemon
  `import_jsonl` call, and the typed error surfaces. The daemon now
  attaches the TS errorInfo codes to the import failures
  (`session_import_file_not_found` with `filePath`, `missing_session_cwd`
  with the issue — `session_navigation.rs`), so the TUI renders the TS
  missing-cwd confirm ("Session cwd not found" with the issue text) and
  retries with the fallback cwd as `cwdOverride` — the TS
  `promptForMissingSessionCwd` contract. Divergences: the confirm panel is
  the `showExtensionSelector` surface this build has (the same Yes/No
  pane TS mounts), and the transcript rebuild after the import is the
  `rebuild_transcript` refetch (TS `renderCurrentSessionState` re-renders
  the same state through its own path).
- `/login` + `/logout`: the TS providers selector (`OAuthSelectorComponent`
  inline: the "Providers"/"MCP Connections" tab bar, the search field, the
  `name · subscription|api key` rows with the TS status indicators —
  configured/unconfigured/env-key/expired — the scroll counter, the TS
  empty messages). The API-key login prompts in the panel (TS
  `LoginDialogComponent.showPrompt`), stores through the composition
  root, and shows the TS status ("Saved API key for <name>. Credentials
  saved to <authPath>"). Documented divergences: (1) `/login` opens the
  providers selector directly — the full `ConfigurationMenuComponent`
  (the tabbed settings menu around it) is not ported, so post-login model
  selection refresh happens on the next `/model` open; (2) the provider
  subscription OAuth flows (Anthropic/Copilot/Codex/xAI) and the Prime
  browser logins are not ported — their rows render (TS names, TS order,
  prime-inference first) and their flows report the unavailability; the
  MCP device flow runs like `/mcp login` (terminal suspended); (3) the
  post-logout `/reload` for removed `mcp:` credentials stays unported
  (the TS rule), reported with the removal status instead.
- `/traces`: the TS status block verbatim ("Trace Sharing", automatic
  uploads/credential/endpoint/session-file rows, the commands line —
  plain text, not markdown, so env-key labels survive byte-for-byte),
  on/off through the settings hook (TS `setAgentTracesEnabled`+flush),
  the credential resolution order (traces env key, stored
  `prime-agent-traces`, `PRIME_API_KEY`, stored prime-inference), the
  endpoint resolution (`PRIME_AGENT_TRACES_BASE_URL` normalized, the
  `api.primeintellect.ai` default). The upload subsystem (TS
  `core/agent-traces.ts` — outbox, session upload, browser login) is not
  ported: its arms keep the TS state shapes (the missing-credential
  errors, the no-session-file enable status) and report the unported
  upload/login honestly.
- `/update`: the TS busy guard (package targets wait for the running turn;
  the binary update tears down anyway), the TS target parse
  (`--self`/`--extensions`/`--extension <src>`/positionals — "all"
  default), and the child runs with inherited stdio under a suspended
  terminal. Divergences from TS (the split CLI): the TS single
  `prime-agent update <targets>` child is two Rust children —
  `prime-agent package update [--extensions|<source>]` first, then
  `prime-agent update [--force|--rollback|--nightly|--stable]` (packages
  before the binary because the binary run ends this process); the
  post-update reload for package-only runs and the `--daemon-socket`
  preservation are unported (`/reload` missing; the Rust `update` command
  targets the default socket). A successful self-update replaces this
  process with the updated launcher from the managed install root
  (TS `tryExecUpdateRelaunch` semantics: exec, child fallback, exit-code
  relay), relaunching with this run's args plus `--resume <sessionFile>`
  unless the invocation already selected a session.

## The stop/delete lifecycle — kill cancels goals and heartbeats (lane deletion-lifecycle, 2026-09-23)

Reference: the TS daemon-mode `closeSessionOnce(reason)` arms
(daemon-mode.ts) and the supervisor's stop machinery
(daemon-supervisor.ts). The bug class (the 2026-09-23 zombie saga): a
killed session's scheduled jobs stayed `active`, so every supervisor boot
`rearm_scheduled_wake` pass resurrected the dead session on its own
lane-liveness heartbeat, and the resurrected worker's goal continuation
kept it working (billed model turns for a session nobody wanted alive).

- TS `closeSessionOnce("killed")` cancels the session's whole job set
  (`cancelScheduledJobsForSession`, the queued heartbeat follow-ups
  purged, the scheduler re-armed); `shutdown`/`update` keep the resume
  entry (the jobs survive for the later wake — TS
  `closeKeepsResumeEntry`); `replaced`/`completed` keep plain cron jobs
  but cancel a subagent's RLM heartbeats
  (`cancelSubagentRlmHeartbeats`). The Rust port now threads the close
  reason through the worker's `kill` (`rlmCloseReason` rest marker) and
  the parent's child-close cascade (TS `closeChildSessions(parent,
  reason)`), so a daemon shutdown no longer cancels the children's
  heartbeats (the previous port collapsed every child close into a
  kill, which this lane would otherwise have made load-bearing).
- TS `persistWorkerStopTombstone` + `finalizeArchivedWorkerStop`: a root
  kill tombstones BEFORE the worker is told and finalizes after it is
  gone — the session tree's scheduled jobs cancel
  (`cancelScheduledJobsForSessionTree`, a live worker covering any tree
  member owns its stores again) and the root file carries the
  `archived` state (the catalog `archive` belt). The port adds both to
  the supervisor's plain-kill route, plus the interrupted-stop recovery:
  the adoption scan finishes a tombstoned dead worker's stop instead of
  relaunching it (TS `scheduleWorkerStopFinalization`).
- TS `isPersistedCronJobRunnable` (the delivery-side gate): a fire whose
  persisted target is gone (file deleted) or killed (`state !==
  "active"`) cancels the session's jobs and skips. Ported into the
  worker's `run_job`.
- TS `collectPassiveScheduledJobs` (the wake-scan gates): the boot
  re-arm only wakes a due job whose session file still exists, is still
  the job's session, still carries the `active` state, and whose file no
  live worker covers. Ported into `rearm_scheduled_wake` (the passive
  catalog merge in `scheduling_catalog.rs` already had the state gate).
- The continuation gates: the engine carries the session's closed marker
  (TS `_disposed || _disposing`) set by the kill/shutdown closes; the
  goal and autonomous mints and their settle-hook retries bail on it,
  and the loop-level continuation hook honors the abort signal (TS
  `signal?.aborted`). A stopped session mints no continuation.
- TS `deleteRlmSubagentArtifacts`: a ledger-tombstoned child delete
  sweeps the child's artifact partition; `delete_saved_session`'s
  `afterFileRemoved` hook cancels the deleted file's jobs between the
  file removal and the artifact sweep.
- Verifiers: `crates/pa-daemon/tests/session_stop_lifecycle_e2e.rs`
  (kill a goal+heartbeat session → the job cancels durably, the file
  archives, the tombstoned-stop adoption finishes, and NOTHING revives
  it across a supervisor restart — while the hard-crashed sibling comes
  back, proving the wake model itself still works) +
  `scripts/session_stop_lifecycle_parity.py` (the same flow over the
  wire on both products).
- Deliberate scope cuts (the TS sites, not ported here): the supervisor's
  continuous `recomputeScheduledSessionWake` timer (still a boot/restore
  pass only, as slice 5 recorded); the parent-walk half of the passive
  scan's `uncoveredRootFor` (the tree cancel at kill covers the zombie
  class; the job's own file coverage is checked); the "completed"
  hydration-error child close (the Rust child worker dies with its own
  process on spawn failure — no in-worker close to hook).
- Ownership: pa-daemon `stop_cleanup.rs` (the finalize belt, the tree
  cancel, the wake-scan gate), `worker.rs`/`rlm_children.rs` (the close
  reason taxonomy), `scheduled_jobs.rs` (the delivery gate + the cancel
  helpers), `supervisor.rs`/`ownership.rs`/`update_restore.rs` (the
  routes), `goal_continuation.rs`/`autonomous_continuation.rs` (the
  continuation gates).
# Multi-steer batch delivery + the streaming follow-up hint (PR: `pa-daemon/pa-tui: multi-steer batch delivery (steeringMode "all" + the forced batch) + the streaming opt+enter hint`)

TS reference: `packages/coding-agent/src/core/agent-session.ts` —
`_pumpSessionInputs`'s mode-gated batch gathering (the
`turnExecutionPoliciesEqual` + `steeringMode`/`followUpMode`/"all" gates),
`abortAndSendQueued` + `_forcedAllSteeringBatch` (the one-shot armed
batch), `sdk.ts`'s settings-seeded `Agent` queue modes,
`setSteeringMode`/`setFollowUpMode`'s live agent write,
`restoreSessionActions`'s persisted execution policy; and
`interactive-mode.ts`'s `getTrayOverrideLabel` (the streaming
`<followUp> to queue message` tray hint).

- **The pump's batch gathering** (`crates/pa-daemon/src/worker.rs`,
  `gather_delivery_batch`): the lane's front item anchors the delivery;
  under queue mode "all" — or the forced steering batch — the same-class
  prefix behind it co-delivers as ONE turn. Joining gates, exactly TS's:
  the same turn-execution class (`QueuedItem::policy`, the port of
  `TurnExecutionPolicy` — client rows ("queued"), injected rows
  (heartbeats, agent-message deliveries, goal/autonomous continuations),
  the idle prompt's direct hand-off), a plain user row (an injected
  custom row delivers solo — it replaces its turn's user row), not a
  queued session command, and armed-set membership while the forced batch
  governs. The front item anchors regardless, exactly like TS's `first`.
- **The forced batch** (`SessionCore::forced_all_steering` +
  `QueuedItem::forced_batch`, armed by
  `Worker::arm_forced_all_steering`): the visible plain-user steering
  items — queue-visible rows whose delivery record is a user message,
  not an accepted agent message or an injected custom row — co-deliver
  as one batched turn even under "one-at-a-time". Transient worker
  state, never journaled (the TS armed set is equally in-memory). The
  caller is the `abort_and_send_queued` handler (schema 29): the
  command + its Ctrl+C trigger are the abort-parity lane's surface per
  the fleet split; this branch precedes its head, so the seam is
  lint-silenced until the rebase wires the call.
- **One turn for the whole batch** (`run_turn` over `Vec<QueuedItem>`):
  the first item anchors the prompt; the rest ride as co-delivered rows
  (`PromptRequest::batch` → the engine's `AgentPromptInput::Messages`
  list, TS `_startPreparedTurnActions`'s `turns.flatMap(records)` → one
  `agent.prompt`). Each batched row emits its accepted `message` frames
  in order; the batch's queue-visible anchor projects the TS
  active-action phases (`visibleSessionActionProjection()[0]`); one
  waiter per queued `prompt_and_wait` item resolves at the settle.
- **The queue modes, wired** (TS `sdk.ts` seeds the Agent from settings):
  the engine's `SessionEngineConfig` carries `steering_mode`/
  `follow_up_mode` into the `AgentOptions`; the worker create seeds them
  through the new `SessionEngine::set_queue_modes` (the settings read
  the create already had), and `set_steering_mode`/`set_follow_up_mode`
  apply live (TS `setSteeringMode` writes the live agent — the trait
  method updates both the built agent and any later build). The print
  runtime reads the settings the same way its telemetry does.
- **Recovery**: the worker journal's queue snapshot records carry the
  policy class ("queued"/"injected"/"direct", the dominant "queued"
  default for pre-field records); `restore_actions` maps the wire
  `executionPolicy` back to the class (`nextTurnContextTiming`
  "commit" → queued, "preparation" + preserved → injected, else direct).
- **The streaming hint** (`crates/pa-tui/src/session_ui.rs`,
  `streaming_tray_hint`): while a turn runs and a non-empty draft sits
  in the editor, the tray's location label is replaced by
  `<followUp> to queue message` (the effective `app.message.followUp`
  key; the Ctrl+C exit hint outranks it while armed, TS
  `isCtrlCExitHintVisible()`'s early return). `focus_subagents_summary`
  consults the same override (TS `focusSubagentSummary`), so the
  subagent-summary hand-off is blocked while the hint is up.
- **Adoption telemetry**: `tui input queued` carries `steering_mode`
  (the connection-state cached value, refreshed at every state read and
  after the settings switch) — exposure under batched delivery is the
  feature's adoption signal.
- Verifiers: `scripts/steer_queue_parity.py`'s new `batch-delivery` flow
  (both binaries over the daemon wire, `steeringMode: "all"` seeded via
  `<agentDir>/settings.json`, three steers parked behind a wedge turn —
  the normalized traces byte-compare; the side assertions pin ONE
  delivery `agent_start` + three user rows + one reply) and
  `scripts/queue_parity.py`'s new `h_streaming_hint` state (tmux
  ANSI-byte-exact tray-row compare + the hint's departure with the
  cleared draft); worker unit tests cover mode "all"/"one-at-a-time",
  the forced batch (armed prefix batched, a post-arm steer excluded),
  the policy-class split under "all", the follow-up lane's own mode,
  and the arming classification; pa-tui unit tests cover the hint text
  (default + rebound key) and its idle/empty-draft gates.

# Multi-steer batch delivery at the tool boundary — the batched default (lane steer-tool-boundary-batch, 2026-09-23)

Kevin's bug report (2026-09-23, his words): "multi steer works correctly
where if I abort, all steer queued messages get sent [...]. But the
actual multi steer part doesn't work: if I have multiple messages in the
steer queue and then a tool call finishes, we send only the first steer
message, then wait for the next tool call to finish, then send the next
steer message [...]. Correct behaviour: if we have many messages in the
steer queue, then ALL of them should be sent after the next tool call."

- **Root cause**: the mid-turn steer path was correct end-to-end (the
  `steer` wire command parks on the worker's steering lane; TS
  `_steeringStopPending`'s stop hook ends the running turn at the next
  tool-call boundary; `gather_delivery_batch` delivers the parked prefix
  as the next turn) — but the delivery batched ONLY under queue mode
  `"all"` or the `abort_and_send_queued` forced arm. The default
  `steeringMode` was the TS default `"one-at-a-time"` (settings-manager
  `getSteeringMode()`'s `|| "one-at-a-time"`), so N parked steers
  drip-fed one per boundary: each delivered steer's own turn hit the
  still-queued stop hook at ITS next boundary and delivered the next —
  exactly the reported shape. The abort path already co-delivered (the
  one-shot armed batch), which is why aborting looked correct.
- **The fix — the deliberate divergence** (Kevin's explicit product
  decision): the steering queue's DEFAULT is now `"all"`. The settings
  default (`SettingsManager::get_steering_mode()`), the worker
  `SessionCore` placeholders, and the TUI's pre-state placeholder flip
  to `"all"`; the follow-up default keeps the TS `"one-at-a-time"`
  (follow-ups drain when the session goes idle, one per turn — the
  follow-up lane never merges into the steering batch). The TS default
  `"one-at-a-time"` stays selectable through the same setting surface
  (`steeringMode` in settings / the `set_steering_mode` wire command /
  the TUI settings menu); `pa-agent`'s library-level
  `PendingMessageQueue` default stays TS-faithful — the divergence
  lives only at the product default, where the decision was made.
- **Unchanged invariants**: `abort_and_send_queued`'s forced batch and
  its arming classification; the follow-up lane's when-idle delivery
  behind the steering batch (its own mode, never merged); injected
  custom rows (agent-message deliveries, heartbeat steers, minted goal
  contexts) still deliver solo — `gather_delivery_batch`'s
  same-turn-execution-class + plain-user-row + non-session-command
  gates are untouched; a queued session command still delivers solo;
  the pick-up projection (the queue strip drops the delivered rows
  before their turn starts) applies to the batch as one update.
- Verifiers: `steer_boundary_batch_e2e.rs` — the reproducer over the
  real worker stack (live kernel, a scripted sleep cell parks three
  steers + a follow-up mid-tool) pins the spec: ONE delivery
  `agent_start` for the whole batch, the three steer rows chained, ONE
  assistant reply, the follow-up behind as its own turn. Worker unit
  tests pin the default-mode batch (`the_default_mode_co_delivers...`),
  the one-at-a-time mode's one-per-turn shape (pinned explicitly), the
  forced arm over the pinned one-at-a-time mode, and the abort battery's
  new default assertion; the settings unit test pins the default flip +
  the explicit-selection survival. `steer_queue_parity.py` grows the
  unseeded `default-multi-steer` flow — the recorded per-side evidence
  of the divergence (the TS binary's default drips one steer per
  boundary; the rust port's default batches) — plus the seeded
  `one-at-a-time-multi-steer` flow, which byte-compares on both
  binaries and keeps the mode surface parity-exact.

## Daemon model allowlist — `allowedModels` (lane metered-model-guardrail, 2026-09-23)

### The settings key

Rust-only settings key `allowedModels` (JSON): a list of model patterns
restricting what the **daemon** may resolve a model to. No TS equivalent —
this is a deliberate daemon guardrail motivated by two production
incidents: a silent fallback that burned metered-route spend (a requested
model unavailable on a client landed on an unintended paid route), and a
session pinned to `prime-inference/internal/glm-5.3-fast` silently falling
back to `z-ai/glm-5.3` on a catalog flap (the 400 `enable_thinking`
fleet kill at 2026-09-23 05:57 UTC). Unset (or a list that trims to empty)
keeps the TS behavior byte-for-byte; parity when unset is the contract.

```json
{ "allowedModels": ["prime-inference/internal/*", "prime-inference/z-ai/glm-5.3"] }
```

Semantics:

- **Global scope only** (`~/.prime/agent/settings.json`), like
  `idleEvictionMinutes`: a daemon policy a project scope cannot weaken.
- **Fails closed**: a settings document that cannot be loaded (lock
  contention, read, or parse failure) is an UNKNOWN policy, never an
  unrestricted one — every seam refuses loudly while unreadable
  (`DaemonAllowlist::Unreadable`), and the failover chain yields no
  candidates. A syntactically valid NON-OBJECT root (`[]`, `"bad"`) is a
  corrupted document and fails closed the same way; the refusal
  telemetry rides the typed pattern refusal only, never a fail-closed
  error.
- **Pattern grammar** = the `--models` CLI scope vocabulary, matched
  case-insensitively against the full selector `provider/model-id` and the
  bare id: a pattern with wildcards (`*`, `?`, `[`) globs; a plain pattern
  must match exactly. No `:level` suffixes (an allowlist entry is a
  pattern, not a cycling scope entry).
- **Enforced at every daemon model resolution**, with a loud typed error
  (`ModelAllowlistRefusal`), never a fallback and never a silently
  different model:
  1. the `set_model` wire command (the `/model` switch): the response
     carries the refusal before any switch side effect;
  2. RLM child-model resolution (`rlm.spawn` and `rlm.create_session`,
     both `SupervisorChildSessions` paths) — an inherited parent model is
     a resolution too, so an off-list parent fails the spawn loudly; the
     registry's parent-model identity follows every live `switch_model`,
     so the inherited selector is the model the session runs NOW;
  3. the worker's startup model chain (`AgentSessionEngine::
     resolve_registry_model`): the TS chain's fallbacks (settings default
     → featured default `z-ai/glm-5.3` → first available) can no longer
     land a session on an off-list model — the chain resolves, then the
     gate refuses, so a broken pin surfaces as an error instead of a
     session on the wrong model.
- **Adoption telemetry**: a refusal emits `model refused` (schema v1;
  `docs/telemetry-events.md`) once per distinct `(surface, selector)` per
  worker — surface + provider/model categories only, never the refused
  selector or the configured patterns. Surfaces: `set_model`,
  `cycle_model`, `spawn`, `create_session`, `session_start`.

### Parity stance

TS has no `allowedModels` key and no daemon-level allowlist; the Rust key
is additive (TS ignores unknown settings keys, so a TS client reading the
same `settings.json` is unaffected). With the key unset, all three seams
behave exactly as the TS daemon does (verified by the seam tests passing
`None`). The typed refusal is Rust-only vocabulary on the wire error
surface: the daemon never sends it unless an operator opts into the
allowlist.

### Where the code lives

- `pa-core`: `models::allowlist` (pattern matching + the typed refusal),
  `settings` (the `allowedModels` key, `get_allowed_models`), and the
  `track_model_refused` telemetry seam.
- `pa-daemon`: `model_allowlist` (the enforcement helpers + the worker's
  lazy refusal-telemetry client), with the three seams above.
