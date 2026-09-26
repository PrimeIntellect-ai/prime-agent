//! Session lifecycle on the worker: shutdown, replacement handoff,
//! resume, compaction triggers, and the wait-for-settled arms.
use super::*;

impl Worker {
/// `update_snapshot` (supervisor plane, update flow spec §8): a
/// read-only capture of this session for the update roster. The worker
/// persists its queue lanes to the recovery journal BEFORE replying, so
/// the reported queue and the durable respawn state agree; the snapshot
/// itself freezes nothing — a busy session keeps running (the supervisor
/// gate already fences new mutations, and the graceful-stop budget owns
/// the exit).
///
/// In-flight granularity: the Rust engine exposes `busy` (a turn in
/// flight) and `compacting` only; provider streaming, tool/bash work,
/// and retries all live inside a busy turn and are reported through it
/// (the roster's `bash_running`/`retrying`/`prompt_in_flight` flags are
/// false on this build for that reason — restore treats `busy` as the
/// continuation signal).
pub(crate) fn handle_update_snapshot(&self) -> DaemonResponse {
    let (core_data, lanes) = {
        let core = self.core.lock().unwrap();
        let store = core.store.as_ref();
        let data = json!({
            "activeSessionId": core.active_session_id,
            "sessionId": store.map(crate::session_store::SessionFile::session_id).unwrap_or_default(),
            "sessionFile": core
                .store
                .as_ref()
                .map(|s| s.path.to_string_lossy().to_string()),
            "cwd": core.cwd,
            "generation": core.generation,
            "runtimeMetadata": {
                "kind": core.runtime_kind,
                "rlmChildId": core.rlm_child_id,
                "parentSessionId": core.parent_session_id,
                "rlmDepth": core.rlm_depth,
            },
            "queue": {
                "actions": serde_json::to_value(session_snapshot(&core)).ok(),
                "steering": core.steering.iter().map(|item| item.message.clone()).collect::<Vec<_>>(),
                "followUps": core.follow_up.iter().map(|item| item.message.clone()).collect::<Vec<_>>(),
            },
            "busy": core.busy,
            "compacting": core.compacting,
        });
        (data, queue_lanes(&core))
    };
    // Journal the lanes after releasing the core lock (record paths take
    // the locks in the opposite order).
    self.persist_queue_snapshot(
        core_data["activeSessionId"].as_str().unwrap_or_default(),
        &lanes,
    );
    response_success(None, "update_snapshot", Some(core_data))
}

/// Graceful stop: the connection loop exits the process after replying.
/// The session's telemetry finalizes first (TS dispose callback:
/// `agent session ended` + one flush), bounded by the sink timeouts.
pub(crate) async fn handle_shutdown(&self) -> DaemonResponse {
    // TS `shutdown` -> `closeSession(state, "shutdown")`: the session is
    // closing, so the continuation mint sites and their settle-hook
    // retries bail (a stopped session never continues) — but unlike a
    // kill the close KEEPS the resume entry: no job cancel, no
    // `archived` state, the scheduled jobs survive for the later wake
    // (TS `closeKeepsResumeEntry("shutdown")`).
    if let Some(agent_engine) = &self.agent_engine {
        agent_engine.mark_session_closed();
    }
    // TS `shutdown` -> `closeSession` aborts the session's side questions
    // per attached client before anything else closes, and each run's
    // `done` chain writes its cancelled event while the client sockets
    // are still open. Without this the restarted daemon never emits a
    // terminal side_question_event, and the reattached client's pane
    // wedges on a running turn no event will ever settle.
    self.side_questions
        .abort_all_and_settle(SIDE_QUESTION_SETTLE_TIMEOUT)
        .await;
    {
        let mut core = self.core.lock().unwrap();
        core.shutdown_requested = true;
        core.abort_requested = true;
    }
    // TS `shutdown` closes through `session.abort()` -> `requestAbort()`:
    // the in-flight turn's fetch cancels now, not at its next event.
    self.engine.abort_in_flight_turn();
    self.work_notify.notify_one();
    // TS `shutdown` closes every session through `closeSession` ->
    // `session.abort()` (which awaits the in-flight turn and compaction)
    // before the runtime dispose. The settle + kernel teardown must
    // happen before the process exit this reply unlocks: `std::process`
    // exit runs no destructors, so an undisposed kernel would be
    // orphaned here (the #235 daemon-worker leak class).
    self.compaction.abort();
    self.tree_navigation.abort();
    self.await_session_work_settled().await;
    // The runtime dispose at shutdown runs the hosted-subagent
    // disposal with it (TS `closeSessionOnce("shutdown")` ->
    // `runtime.dispose` -> `disposeHostedSubagentRuntimes`): the
    // children close before the process exits, so the close's kills
    // never race the exit. Best-effort: an unreachable child must not
    // block the worker's own exit. The children close with the
    // `shutdown` reason too: their resume entries and scheduled jobs
    // survive (a daemon shutdown preserves the wake model).
    if let Err(error) = self
        .close_rlm_children(crate::rlm_children::ChildCloseReason::Shutdown)
        .await
    {
        eprintln!("pa-daemon: RLM child close at shutdown failed: {error:#}");
    }
    if let Some(agent_engine) = &self.agent_engine {
        agent_engine.dispose_kernel().await;
    }
    self.engine.end_telemetry().await;
    let lease = self
        .core
        .lock()
        .unwrap()
        .store
        .as_mut()
        .and_then(|store| store.lease.take());
    drop(lease);
    response_success(None, "shutdown", None)
}

/// Wait until no turn or compaction run is in flight (the awaited
/// `session.abort()` half of the TS close path). The caller requests
/// the aborts first — `abort_requested` stops an in-flight turn's event
/// consumption, `CompactionManager::abort` settles the run — then this
/// parks on the idle notify until the runner parks; the kernel dispose
/// must never race a live run that holds kernel execution state.
pub(crate) async fn await_session_work_settled(&self) {
    loop {
        // Register the permit before the flag check: a run that settles
        // between the check and the await still wakes this waiter
        // (`notify_waiters` only reaches already-registered futures).
        let notified = self.idle_notify.notified();
        {
            let core = self.core.lock().unwrap();
            if !core.busy && !core.compacting {
                return;
            }
        }
        notified.await;
    }
}

/// The TS replacement teardown (`teardownForReplacement`): the
/// whole-runtime replacement flows (`new_session` /
/// `switch_session` / `import_jsonl` / `fork`) retire the live
/// session before swapping onto the replacement file. The settle
/// cancels the queued session actions first (TS dispose rejects every
/// queued action, and the turn runner clears the abort flag when it
/// pops an item, so the cancel must land before the park), aborts the
/// compaction and branch-summary runs, and parks until the turn and
/// compaction settle; then the engine retires the runtime - the
/// kernel disposes (its final namespace snapshot flushes before the
/// process exits) and the built session drops, so the replacement
/// rebuilds a fresh session against the moved file exactly like the
/// TS fresh runtime. The teardown then closes the session's RLM
/// children (TS `teardownCurrent` ->
/// `disposeHostedSubagentRuntimes`): a parent that replaces its
/// runtime disposes its children, and the replacement session's
/// roster starts empty. The tree moves (`navigate_tree`) never run
/// this: TS rebuilds the branch context in place and the kernel
/// stays warm.
pub(crate) async fn teardown_for_replacement(&self) -> anyhow::Result<()> {
    // The retired session is closing: mark it before the children close,
    // exactly like the kill/shutdown closes — each child's settle retry
    // fires while the old runtime is still installed, and the marker
    // keeps those retries from minting continuations into the retiring
    // session (a replaced session never continues either).
    if let Some(agent_engine) = &self.agent_engine {
        agent_engine.mark_session_closed();
    }
    {
        let mut core = self.core.lock().unwrap();
        core.steering.clear();
        core.follow_up.clear();
    }
    self.compaction.abort();
    self.tree_navigation.abort();
    self.await_replacement_settled().await;
    self.engine.teardown_for_replacement().await;
    // TS `teardownCurrent` ends with `disposeHostedSubagentRuntimes`:
    // the session's runtime is disposed first (the kernel retire
    // above), then the hosted RLM subagent runtimes close with it -
    // the daemon host's `disposeRlmSubagentRuntimes` runs
    // `closeChildSessions(parentState, "replaced")`. A close failure
    // rethrows out of the teardown exactly like TS (the replacement
    // fails with the old runtime already retired).
    self.close_rlm_children(crate::rlm_children::ChildCloseReason::Replaced)
        .await
}

/// Close this session's supervisor-backed RLM children (TS
/// `closeChildSessions(parentState, reason)` through
/// `disposeHostedSubagentRuntimes`). Runs at every runtime teardown
/// that ends the session - the replacement retire, `kill`, and the
/// worker `shutdown` - because the TS daemon closes resident children
/// on every session close and at the replacement teardown, cascading
/// to grandchildren through each child worker's own close with the
/// same close reason.
pub(crate) async fn close_rlm_children(
    &self,
    reason: crate::rlm_children::ChildCloseReason,
) -> anyhow::Result<()> {
    let children = self
        .agent_engine
        .as_ref()
        .and_then(|engine| engine.children.clone());
    match children {
        Some(children) => children.close_children(reason).await,
        None => Ok(()),
    }
}

/// Wait until the replacement teardown can retire the runtime: no
/// turn and no compaction in flight. Like the navigation settle, the
/// park rides a timeout backstop - the turn runner notifies the idle
/// notify when a run settles, but a compaction settle does not, so a
/// missed wake must not hang the replacement.
async fn await_replacement_settled(&self) {
    loop {
        let busy = {
            let mut core = self.core.lock().unwrap();
            let busy = core.busy || core.compacting;
            if busy {
                core.abort_requested = true;
            }
            busy
        };
        if !busy {
            return;
        }
        // The parked flag gates the turn's events; the engine abort
        // cancels the in-flight fetch (TS `requestAbort` -> `agent.abort()`)
        // so the settle does not wait out a pending provider response.
        self.engine.abort_in_flight_turn();
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            self.idle_notify.notified(),
        )
        .await;
    }
}

/// The replacement rebuild (TS `buildAndApplyReplacement` ->
/// `createRuntime`, which prewarms the new session's kernel): the
/// fresh session builds in the background like the create-time build,
/// so the replacement session's kernel prewarm fires at the
/// replacement, not at the first turn. The build gate deduplicates it
/// against any racing demand seam, and a build failure surfaces on
/// the first demand seam. Scripted harness engines have no session
/// to build.
pub(crate) fn prewarm_replacement_session(&self) {
    if let Some(agent_engine) = &self.agent_engine {
        let engine = std::sync::Arc::clone(agent_engine);
        tokio::spawn(async move {
            let Ok(model) = engine.resolve_model() else {
                return;
            };
            let _ = engine.ensure_core_session_async(&model).await;
        });
    }
}

/// Rebind the worker onto the replacement session's cwd (TS
/// `createRuntime({ cwd: sessionManager.getCwd() })` in
/// `switchSession` / `importFromJsonl`): the core's cwd (the wire
/// summary, the settings reads, the user-bash guard, the schedule
/// catalog's binding) and the engine's cwd slot (the rebuilt session's
/// kernel-resident tools, its settings and MCP discovery) move onto
/// the target session's recorded working directory. The teardown has
/// already retired the live session, so nothing old observes the move;
/// the rebuild that follows builds cold in the new cwd.
pub(crate) fn rebind_worker_cwd(&self, cwd: &str) {
    {
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        core.cwd = cwd.to_string();
    }
    self.engine.set_cwd(std::path::PathBuf::from(cwd));
}

/// Refresh the replacement session's derived state (TS
/// `refreshReplacedSessionState` on the `sessionReplaced` event): the
/// moved-to session's depth re-seeds the worker core and the engine's
/// RLM identity (a resumed subagent keeps its persisted depth). The schedule
/// catalog rebind runs separately (`bind_scheduled_jobs`), like the
/// TS dispatch handlers that call `rebindCronJobsToState` after the
/// runtime call.
pub(crate) fn refresh_replaced_session_state(&self) {
    let (rlm_depth, summary, child_script) = {
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The moved-to file's persisted depth wins (TS
        // `config.rlmDepth ?? header.rlmDepth`; the replacement carries
        // no create-config depth).
        let rlm_depth = core
            .store
            .as_ref()
            .and_then(SessionFile::rlm_depth)
            .unwrap_or(0);
        core.rlm_depth = rlm_depth;
        let child_script = core.child_script.clone();
        (rlm_depth, self.summary_locked(&core), child_script)
    };
    // No thinking flag rides the rebind (the create command's level is
    // already resolved on the engine), and the TS replacement runtime
    // carries no inherited max-depth: the moved-to session's persisted
    // chat override, the global setting, the env, or the default
    // resolve it (`_resolveRlmMaxDepth` precedence). The harness's
    // child engine file rides along: TS children inherit the
    // replacement runtime's `sessionConfig`, which the runtime keeps
    // across its swaps.
    if let Err(error) = self
        .engine
        .configure_rlm_identity(crate::engine::RlmSessionIdentity {
            rlm_depth,
            rlm_max_depth: None,
            cwd: Some(summary.cwd.clone()),
            session_id: Some(summary.session_id.clone()),
            session_file: summary.session_file.clone(),
            thinking: None,
            child_script,
        })
    {
        eprintln!("pa-daemon: replacement identity rebind failed: {error:#}");
    }
    if let Ok(summary_value) = serde_json::to_value(&summary) {
        self.engine.set_session_summary(summary_value);
    }
}

/// Bind the live session's schedule catalog (TS `rebindCronJobsToState`):
/// register the session's artifact partition, rebind the stored jobs onto
/// the live ids, and start (or wake) the scheduler. Runs at create and
/// after every replacement swap (`new_session` / `switch_session` /
/// `import_jsonl` / fork) - the jobs follow the live session onto the
/// moved-to file, exactly like the TS rebind on the runtime swap.
pub(crate) async fn bind_scheduled_jobs(&self) {
    let binding = {
        let core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::scheduled_jobs::live_binding(&core)
    };
    if let Some((binding, artifact_dir)) = binding {
        self.scheduled.bind_session(binding, artifact_dir).await;
    }
}

/// Clear the queued-input suspension (TS `_resumeSessionInputAdmission`,
/// reached through `resumeQueuedWork()` and the resume sites) and wake
/// the turn runner so parked lanes drain. Every resume site also runs
/// the goal arm of TS `resumeQueuedWork()`: a continuation owed behind
/// the suspension or descendant work re-evaluates here.
pub(crate) fn resume_queued_input(&self) {
    {
        let mut core = self.core.lock().unwrap();
        if core.queued_input_suspended {
            core.queued_input_suspended = false;
        }
    }
    self.work_notify.notify_one();
    if let Some(engine) = self.agent_engine.as_ref() {
        engine.retry_owed_goal_continuation();
    }
}

/// `compact` (TS handler): run one compaction and answer with the TS
/// `CompactionResult` wire shape; skips, aborts, and failures answer
/// with the session's error message exactly like the TS daemon catch.
pub(crate) async fn handle_compaction(&self, payload: &Value) -> DaemonResponse {
    if let Err(response) = self.require_created("compact") {
        return response;
    }
    let custom_instructions = payload
        .get("customInstructions")
        .and_then(Value::as_str)
        .map(str::to_string);
    {
        // TS `compact()` aborts first (`await this.abort()` ->
        // `requestAbort()`), which suspends queued-input admission:
        // the suspension outlives skip/failure/abort outcomes and is
        // cleared below only for the TS `didCompact` + active-goal
        // branch.
        let mut core = self.core.lock().unwrap();
        core.queued_input_suspended = true;
    }
    let outcome = self
        .compaction
        .run(custom_instructions, &self.idle_notify)
        .await;
    // The TS `compact()` `didCompact` + active-goal branch
    // (agent-session.ts): with `this._goalState.status === "active"`
    // and the run not aborted,
    //   this._goalContinuationAwaitsRlmWork ||= !this.agent.hasQueuedMessages();
    //   this.resumeQueuedWork();
    //   if (this.agent.hasQueuedMessages()) this._schedulePostCompactionContinue();
    // `resumeQueuedWork()` delivers the owed goal continuation (a
    // queued follow-up) and clears the queued-input suspension; the
    // scheduled continue then drives the queued turn once idle. The
    // worker mirror: mint the continuation only when no queued work
    // parked (`agent.hasQueuedMessages()` spans both lanes — TS's
    // `||=` sets the owed flag exactly there), queue it behind the
    // still-set suspension, and let the resume site below clear the
    // #234 gate and wake the turn runner — the runner IS the
    // scheduled continue, and the queued continuation crosses the
    // suspension gate only through this resume site.
    let mut goal_continue_scheduled = false;
    if let crate::engine::CompactionOutcome::Compacted { .. } = &outcome {
        let goal_active = self
            .engine
            .goal_state_value()
            .get("status")
            .and_then(Value::as_str)
            == Some("active");
        if goal_active {
            let has_queued = {
                let core = self.core.lock().unwrap();
                !core.steering.is_empty() || !core.follow_up.is_empty()
            };
            if !has_queued {
                // The engine call takes the engine session lock and
                // blocks on the engine runtime, so it runs on a
                // blocking thread like every other engine call; a
                // join failure leaves the continuation un-minted
                // (logged, never silent) — the session still resumes.
                let engine = std::sync::Arc::clone(&self.engine);
                let continuation = tokio::task::spawn_blocking(move || {
                    engine.mint_post_compaction_goal_continuation()
                })
                .await
                .unwrap_or_else(|error| {
                    eprintln!(
                        "pa-daemon: post-compaction goal continuation mint failed: {error}"
                    );
                    None
                });
                if let Some(continuation) = continuation {
                    // The mint's `goal_update` surfaces at the moment
                    // the state changes (TS `_setGoalState` ->
                    // `_emitGoalUpdate`), before the continuation turn
                    // is admitted — and the state change is durable
                    // before the announcement (TS `_persistGoalState`
                    // appends + flushes the `thread_goal_state` custom
                    // entry; the mint runs outside a turn, so the
                    // store write rides here, not the turn's emit
                    // closure).
                    if let Some(goal) = continuation.goal_update {
                        {
                            let mut core = self.core.lock().unwrap();
                            if let Some(store) = core.store.as_mut() {
                                let _ = store.persist_entry(
                                    "custom",
                                    json!({
                                        "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                                        "data": goal,
                                    }),
                                );
                            }
                        }
                        self.emit_worker_event(json!({
                            "type": "goal_update",
                            "goal": goal,
                        }));
                    }
                    {
                        let mut core = self.core.lock().unwrap();
                        core.follow_up.push_back(QueuedItem {
                            priority: QueuePriority::Background,
                            preview: None,
                            message: continuation.request.message,
                            custom_message: continuation.request.custom_message,
                            agent_message: None,
                            queue_key: None,
                            admission_id: None,
                            images: continuation.request.images,
                            done: None,
                            queue_visible: false,
                            policy: TurnPolicy::Injected,
                            forced_batch: false,
                        });
                    }
                    // The admission checkpoint (busy=true): the
                    // post-compaction continuation is admitted while
                    // the session is idle, so without this record a
                    // kill before the turn's settle would park it on
                    // a plain boot (the runner records nothing at
                    // pickup).
                    self.checkpoint_queue(QueueCheckpoint::Admitted {
                        operation: "follow_up_queued",
                    });
                }
            }
            // The resume site: clears the suspension and wakes the
            // runner, which drains the queued continuation (or the
            // already-parked queued work) as the post-compaction
            // continue's turn.
            self.resume_queued_input();
            goal_continue_scheduled = true;
        }
    }
    match outcome {
        crate::engine::CompactionOutcome::Compacted { run } => {
            let run = *run;
            // TS `compact()` schedules the compact-trigger auto-refine
            // review after every successful compaction and the
            // background round runs while the session is idle: the
            // command consumed it here (the busy gates keep it armed
            // for the next turn boundary when work is queued), and
            // the outcome surfaces through the same rows the
            // `refine` command emits.
            // The goal-continue branch defers like TS
            // `_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction
            // = true)` -> `_compactAutoRefinePending = true`: a
            // continuation (or parked queued work) is about to run,
            // so the review services at that turn's quiescent boundary
            // instead of interleaving before it — skip the immediate
            // consume and leave the trigger armed.
            let engine = std::sync::Arc::clone(&self.engine);
            let refined = if goal_continue_scheduled {
                Ok(None)
            } else {
                // The engine round runs on a blocking thread like
                // every other engine call (it takes the engine session
                // lock and blocks on the engine runtime).
                tokio::task::spawn_blocking(move || engine.consume_compact_auto_refine())
                    .await
                    .unwrap_or_else(|error| {
                        Err(anyhow::anyhow!("auto-refinement task failed: {error}"))
                    })
            };
            match refined {
                Ok(Some(result)) => {
                    let outcome_row =
                        pa_core::session_engine::refine::create_refinement_outcome_message(
                            &result,
                        );
                    if let Ok(value) = serde_json::to_value(
                        pa_types::session::AgentMessage::Custom(outcome_row),
                    ) {
                        self.emit_custom_row(value);
                    }
                    if result.applied_edits.iter().any(|edit| edit.applied) {
                        let notice =
                            pa_core::session_engine::refine::create_refinement_notice_message(
                                &result,
                                pa_core::session_engine::refine::RefinementSource::Auto,
                            );
                        if let Ok(value) = serde_json::to_value(
                            pa_types::session::AgentMessage::Custom(notice),
                        ) {
                            self.emit_custom_row(value);
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
                }
            }
            response_success(None, "compact", Some(run.result))
        }
        crate::engine::CompactionOutcome::Skipped { message } => {
            response_failure(None, "compact", &message, None)
        }
        crate::engine::CompactionOutcome::Aborted => {
            response_failure(None, "compact", "Compaction cancelled", None)
        }
        crate::engine::CompactionOutcome::Failed { error } => {
            response_failure(None, "compact", &error, None)
        }
    }
}

pub(crate) async fn handle_wait_for_idle(&self) -> DaemonResponse {
    loop {
        {
            let core = self.core.lock().unwrap();
            if !core.busy && core.steering.is_empty() && core.follow_up.is_empty() {
                return response_success(None, "wait_for_idle", None);
            }
        }
        self.idle_notify.notified().await;
    }
}

/// `wait_for_headless_completion` (TS daemon command): settle the
/// headless run first (same idle wait as `wait_for_idle`), then answer
/// the autonomous-run accounting snapshot (`DaemonAutonomousStatus`).
pub(crate) async fn handle_wait_for_headless_completion(&self) -> DaemonResponse {
    if let Err(response) = self.require_created("wait_for_headless_completion") {
        return response;
    }
    loop {
        {
            let core = self.core.lock().unwrap();
            if !core.busy && core.steering.is_empty() && core.follow_up.is_empty() {
                break;
            }
        }
        self.idle_notify.notified().await;
    }
    // The idle wait finished, so no turn holds the accounting state;
    // the snapshot read cannot interleave with a running turn.
    let status = self
        .engine
        .autonomous_status()
        .await
        .unwrap_or_else(pa_core::autonomous::disabled_autonomous_status);
    response_success(
        None,
        "wait_for_headless_completion",
        Some(serde_json::to_value(&status).unwrap_or(Value::Null)),
    )
}

}
/// The session summary for one core (TS `summaryForActiveSession`): the
/// shared shape `get_state`, the roster, and list rows all serve. Free so
/// the turn runner can push roster deltas without the worker handle; the
/// thinking level rides in from the engine (the core has no engine access).
/// TS `activeLifecycleForSession`: lifecycle drives agents-view visibility
/// and is message-based. A resident subagent is a spawned worker, visible
/// before its first message lands; a message-less top-level session is a
/// draft the view hides (config like a renamed model is preserved on disk,
/// it just never surfaces a conversation-less row). A busy turn is live
/// even before the store flushes its user message: TS computes the same
/// summary from the runtime's in-memory messages, which hold the prompt
/// the moment the turn starts, so the busy-flip roster delta a mid-turn
/// view reads must never classify the running session as a draft.
fn active_lifecycle(runtime_kind: &str, messageless: bool, busy: bool) -> &'static str {
    if runtime_kind == "subagent" || !messageless || busy {
        "live"
    } else {
        "draft"
    }
}
