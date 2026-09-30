//! The detached child run task and the host's roster/collect/delete
//! surface. The run task subscribes the child agent's events (live
//! activity, tool counts, answer previews, per-origin usage batches — the
//! introspection the daemon host gets from worker summaries), prompts the
//! child behind the parent's turn boundary, waits for the task run to
//! settle, and delivers the parent's terminal notice when the child never
//! replied.

use std::sync::Arc;
use std::time::Duration;

use pa_agent::types::{AgentEvent, StopReason};
use pa_types::session::{ChildUsageOrigin, FileEntry};

use super::registry::{compact_rlm_text, record_matches, InProcessChildRecord, NoticeKind};
use super::{now_ms, InProcessRlmHost};
use crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE;
use crate::session_engine::rlm_host::{
    RlmChildResult, RlmDeleteSubagentResult, RlmHostFuture, RlmSubagentEntry,
};
/// Settle-poll slice while the child still runs (the daemon watcher's
/// cadence).
const SETTLE_POLL_SLICE_MS: u64 = 250;
/// Grace between the first idle observation and the settle decision (the
/// daemon watcher's stability re-check).
const SETTLE_GRACE_MS: u64 = 250;

/// The detached child run task (TS `_startRlmChildRun`'s detached arm):
/// starts the child immediately — TS runs the detached runtime at once,
/// and no parent turn boundary gates child execution (the daemon host's
/// boundary wait exists for cross-process prompt routing, which an
/// in-process prompt admission does not have). Errors never propagate:
/// every terminal state lands on the record.
pub(super) async fn run_child_task(
    host: InProcessRlmHost,
    record: Arc<InProcessChildRecord>,
    prompt: String,
) {
    if !subscribe_child_events(&record).await {
        // Closed before the subscription landed (a delete or close won
        // the race): the run arm owns nothing and exits.
        return;
    }
    record.state().await.prompt_admitted = true;
    // The daemon prompt shape: the raw task text as the child's first
    // user row (the in-process host matches the established Rust child
    // surface; the TS custom-row spawn label is a documented divergence).
    // The prompt is raced against the record's closed watch AND parent
    // teardown: a delete or close (which can land between the listener
    // install and the prompt registration, where its abort finds an idle
    // agent and would otherwise leave a closed record running a turn) and
    // a dropped parent engine both tear the task down within one slice.
    let admission = tokio::select! {
        result = record.engine.session.prompt(
            &prompt,
            crate::session_engine::PromptOptions::default(),
        ) => Some(result),
        () = closed_or_parent_gone(&host, &record) => None,
    };
    match admission {
        None => {
            // Which teardown: a closed record (delete or close) leaves the
            // terminal verdict's error to the closer — the delete's
            // tombstone reads its own fallback reason either way — while
            // a dropped parent engine owns its own end text.
            if record.is_closed().await {
                teardown_closed(&host, &record).await;
            } else {
                teardown_parent_gone(&host, &record).await;
            }
        }
        Some(Err(error)) => {
            // The terminal sequence keeps its order: accounting, notice
            // admission, THEN the settled state and its wake signal — the
            // run state never exposes `settled` before the parent's
            // notice is admitted.
            finish_run(&host, &record, &TaskVerdict::Error(error.to_string())).await;
        }
        Some(Ok(_)) => match wait_for_task_settle(&host, &record).await {
            TaskSettle::Done => {
                finish_run(&host, &record, &TaskVerdict::Done).await;
            }
            TaskSettle::Closed => teardown_closed(&host, &record).await,
            TaskSettle::ParentGone => teardown_parent_gone(&host, &record).await,
        },
    }
}

/// Resolve once the record is closed (delete or close) or the parent
/// engine is gone (the binding weak died). Bounded ticks wake on the
/// closed watch's own signal; teardown latency is one settle slice.
async fn closed_or_parent_gone(host: &InProcessRlmHost, record: &Arc<InProcessChildRecord>) {
    let mut closed = record.task_cancel_tx.subscribe();
    loop {
        if host.parent_engine().is_none() {
            return;
        }
        if *closed.borrow_and_update() {
            return;
        }
        tokio::select! {
            changed = closed.changed() => {
                if changed.is_ok() && *closed.borrow_and_update() {
                    return;
                }
            }
            () = tokio::time::sleep(Duration::from_millis(SETTLE_POLL_SLICE_MS)) => {}
        }
    }
}

/// Teardown of a run closed by its parent (delete or close). Single
/// ownership of the cancelled verdict: the CLOSER owns the claim, the
/// notice, and the settle — the delete settles only after its notice is
/// admitted or durably scheduled, so this task never writes the verdict
/// and a concurrent collect cannot observe a settle ahead of the notice
/// scheduling. The task still owns what only it can do: abort its run,
/// flush its pending usage accounting, close its own descendant subtree
/// (grandchildren cascade through their own tasks), and release its
/// event listener so the engine tears down with this task's exit.
async fn teardown_closed(host: &InProcessRlmHost, record: &Arc<InProcessChildRecord>) {
    record.engine.session.agent().abort();
    record.child_host.close_children().await;
    flush_pending_usage(host, record).await;
    record.unsubscribe_listener().await;
}

/// The parent-engine teardown variant (the binding weak died).
async fn teardown_parent_gone(host: &InProcessRlmHost, record: &Arc<InProcessChildRecord>) {
    #[cfg(not(test))]
    let _ = host;
    record.engine.session.agent().abort();
    record.child_host.close_children().await;
    if record.claim_notice(NoticeKind::ParentGone).await {
        #[cfg(test)]
        host.pause_child_gate(super::ChildGatePoint::Claimed {
            child_id: record.rlm_child_id.clone(),
        })
        .await;
        #[cfg(test)]
        host.pause_child_gate(super::ChildGatePoint::BeforePublish {
            child_id: record.rlm_child_id.clone(),
        })
        .await;
        record
            .publish_verdict(
                NoticeKind::ParentGone,
                Some("Parent session ended".to_string()),
            )
            .await;
    }
    record.unsubscribe_listener().await;
}

/// The run's would-be terminal verdict, decided before the settled state
/// lands (the state itself stays `running` until the notice is admitted).
enum TaskVerdict {
    Done,
    Error(String),
}

/// The run's terminal sequence, in the order TS resolves settlement
/// (`_startRlmChildRun`'s `finally`), with single notice ownership: flush
/// the child's usage accounting, claim the terminal notice (the claim
/// fixes the verdict this arm settles with), retain the notice on the
/// parent (a live admitted turn on an idle parent, a durable session-file
/// row on a busy one) BEFORE recording the settled state, publish the wake
/// signal only then, and release the event listener so the record —
/// engine and kernel included — drops with the registry entry instead of
/// leaking through the agent's listener list. The run state never
/// exposes `settled` before the notice is retained, and the settled
/// verdict always agrees with the claimed notice.
async fn finish_run(
    host: &InProcessRlmHost,
    record: &Arc<InProcessChildRecord>,
    verdict: &TaskVerdict,
) {
    // Keep the original parent alive across the claim and admission. A
    // rebind cannot redirect the row to a different session generation.
    let parent = record.parent_engine.upgrade();
    let claim = if parent.is_none() {
        record.claim_notice(NoticeKind::ParentGone).await
    } else {
        match verdict {
            TaskVerdict::Error(_) => record.claim_notice(NoticeKind::Error).await,
            TaskVerdict::Done => record.claim_done().await,
        }
    };
    if !claim {
        // Delete/close already owns the first-wins transaction. This arm
        // writes nothing and does not publish a competing verdict.
        record.await_settled_or_parked().await;
        record.unsubscribe_listener().await;
        return;
    }
    #[cfg(test)]
    host.pause_child_gate(super::ChildGatePoint::Claimed {
        child_id: record.rlm_child_id.clone(),
    })
    .await;
    flush_pending_usage(host, record).await;
    let kind = record.claimed_kind().await.expect("winning claim");
    let error = match verdict {
        TaskVerdict::Error(error) if kind == NoticeKind::Error => Some(error.clone()),
        _ => None,
    };
    if kind == NoticeKind::DoneReplied {
        let mut first_parent = parent;
        loop {
            let pending = record.state().await.pending_replies.first().cloned();
            if let Some(row) = pending {
                let Some(parent) = first_parent
                    .take()
                    .or_else(|| record.parent_engine.upgrade())
                else {
                    record
                        .admission_failed(&anyhow::anyhow!(
                            "original parent engine was released before reply admission"
                        ))
                        .await;
                    record.mark_parked().await;
                    record.unsubscribe_listener().await;
                    return;
                };
                let id = row
                    .details
                    .as_ref()
                    .and_then(|details| details.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !super::notices::admit_claimed_row(
                    record,
                    parent,
                    super::notices::AdmissionRow::Reply(row),
                    super::notices::RetryPolicy::SparseWhileOpen,
                )
                .await
                {
                    record.unsubscribe_listener().await;
                    return;
                }
                record.reply_admitted(&id).await;
                continue;
            }
            #[cfg(test)]
            host.pause_child_gate(super::ChildGatePoint::BeforePublish {
                child_id: record.rlm_child_id.clone(),
            })
            .await;
            if record.publish_verdict(kind, None).await {
                record.unsubscribe_listener().await;
                return;
            }
        }
    }
    let preview = record.state().await.answer_preview.clone();
    if let Some(row) = super::notices::terminal_row(record, kind, error.as_deref(), preview) {
        if !super::notices::admit_claimed_row(
            record,
            parent.expect("notice has parent"),
            super::notices::AdmissionRow::Terminal(row),
            super::notices::RetryPolicy::SparseWhileOpen,
        )
        .await
        {
            record.unsubscribe_listener().await;
            return;
        }
    }
    let error = if kind == NoticeKind::ParentGone {
        Some("Parent session ended".to_string())
    } else {
        error
    };
    #[cfg(test)]
    host.pause_child_gate(super::ChildGatePoint::BeforePublish {
        child_id: record.rlm_child_id.clone(),
    })
    .await;
    record.publish_verdict(kind, error).await;
    record.unsubscribe_listener().await;
}

/// Subscribe the child agent's events into the record: activity, tool
/// counts, answer previews, last-activity clock, and the per-origin usage
/// batches that flush at run ends.
///
/// Closed-aware: a
/// delete/close racing this subscription cannot strand a second listener
/// on the agent — the store and the `closed_by_parent` re-check share one
/// critical section on the record state, and a close that loses the race
/// (it took the listener slot before this store) is still observed here,
/// the fresh subscription is unsubscribed, and the run arm exits. Both
/// interleavings end with no live listener on a closed record.
async fn subscribe_child_events(record: &Arc<InProcessChildRecord>) -> bool {
    if record.state().await.closed_by_parent {
        return false;
    }
    let agent = record.engine.session.agent().clone();
    let run_record = Arc::clone(record);
    let subscription = agent
        .subscribe(move |event, _signal| {
            let run_record = Arc::clone(&run_record);
            Box::pin(async move {
                observe_child_event(&run_record, event).await;
                Ok(())
            })
        })
        .await;
    let mut state = record.state().await;
    if state.closed_by_parent {
        drop(state);
        subscription.unsubscribe().await;
        return false;
    }
    state.listener = Some(subscription);
    true
}

/// One child event's record updates (TS `_startRlmChildRun`'s child
/// subscription).
async fn observe_child_event(record: &Arc<InProcessChildRecord>, event: AgentEvent) {
    let now = now_ms();
    let engine = Arc::clone(&record.engine);
    let mut state = record.state().await;
    match event {
        AgentEvent::AgentStart => {
            state.activity = Some(super::registry::ChildActivity {
                kind: "waiting",
                tool_name: None,
            });
            state.last_activity_at_ms = now;
        }
        AgentEvent::MessageStart { message } => {
            observe_streaming_assistant(&mut state, &message, now);
        }
        AgentEvent::MessageUpdate { message, .. } => {
            observe_streaming_assistant(&mut state, &message, now);
        }
        AgentEvent::MessageEnd { message } => {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = &message
            {
                if !matches!(
                    assistant.stop_reason,
                    StopReason::Error | StopReason::Aborted
                ) {
                    let origin = child_usage_origin(&engine).await;
                    // The producer folds the shared wire-shape usage: the
                    // agent-loop event's usage crosses through the same
                    // JSON round trip every session boundary uses.
                    if let Some(wire_usage) = super::super::provider_adapter::json_round_trip::<
                        _,
                        pa_types::ai::AssistantMessage,
                    >(assistant)
                    .map(|wire| wire.usage)
                    {
                        match state
                            .pending_usage
                            .iter_mut()
                            .find(|(bucket_origin, _)| *bucket_origin == origin)
                        {
                            Some((_, usage)) => {
                                crate::session_engine::rlm_usage::add_assistant_usage(
                                    usage,
                                    &wire_usage,
                                );
                            }
                            None => state.pending_usage.push((origin, wire_usage)),
                        }
                    }
                }
                let text = compact_rlm_text(&assistant_text(assistant));
                if !text.is_empty() {
                    state.answer_preview = Some(text);
                }
                state.last_activity_at_ms = now;
            }
        }
        AgentEvent::ToolExecutionStart { tool_name, .. } => {
            state.tool_use_count += 1;
            state.running_tools += 1;
            state.activity = Some(super::registry::ChildActivity {
                kind: "executing",
                tool_name: Some(tool_name),
            });
            state.last_activity_at_ms = now;
        }
        AgentEvent::ToolExecutionEnd { .. } => {
            state.running_tools = state.running_tools.saturating_sub(1);
            if state.running_tools == 0 {
                state.activity = Some(super::registry::ChildActivity {
                    kind: "waiting",
                    tool_name: None,
                });
            }
            state.last_activity_at_ms = now;
        }
        AgentEvent::AgentEnd { .. } => {
            state.activity = None;
            state.last_activity_at_ms = now;
        }
        AgentEvent::TurnStart
        | AgentEvent::TurnEnd { .. }
        | AgentEvent::ToolExecutionUpdate { .. } => {}
    }
}

/// A streaming assistant message's preview update (TS updates
/// `answerPreview` and the `writing` activity on message start/update).
fn observe_streaming_assistant(
    state: &mut super::registry::ChildRunState,
    message: &pa_agent::types::AgentMessage,
    now: u64,
) {
    let Some(assistant) = streaming_assistant(message) else {
        return;
    };
    let text = compact_rlm_text(&assistant_text(assistant));
    if !text.is_empty() {
        state.answer_preview = Some(text);
    }
    state.activity = Some(super::registry::ChildActivity {
        kind: "writing",
        tool_name: None,
    });
    state.last_activity_at_ms = now;
}

/// The assistant message behind a streaming event, when it is one.
fn streaming_assistant(
    message: &pa_agent::types::AgentMessage,
) -> Option<&pa_agent::types::AssistantMessage> {
    match message {
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant)) => {
            Some(assistant)
        }
        _ => None,
    }
}

/// The assistant message's text blocks joined (TS `readAssistantText`).
fn assistant_text(assistant: &pa_agent::types::AssistantMessage) -> String {
    assistant
        .content
        .iter()
        .filter_map(|block| match block {
            pa_agent::types::AssistantContent::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

/// The completion's usage origin (TS `rlmChildUsageOrigin`): the nearest
/// preceding user or agent-message row labels it — the task prompt (the
/// child file's first user row) labels `spawn_task`, agent-message rows
/// label `agent_message`, any other custom row and later user rows
/// `direct_user`. Completions with an error or aborted stop reason fold
/// nowhere (the caller filters them first).
async fn child_usage_origin(
    engine: &Arc<crate::session_engine::engine::SessionEngine>,
) -> ChildUsageOrigin {
    let persistence = engine.session.shared_persistence();
    let entries = {
        let session = persistence.lock().await;
        session.get_entries()
    };
    let first_user_row = entries.iter().position(|entry| {
        matches!(
            entry,
            FileEntry::Message {
                message: pa_types::session::AgentMessage::User(_),
                ..
            }
        )
    });
    // Walk back from the row before the just-appended assistant row; the
    // nearest user or custom row labels this completion. Any other row is
    // not a label row and the walk keeps going.
    for (index, entry) in entries.iter().enumerate().rev().skip(1) {
        if let FileEntry::Message {
            message: pa_types::session::AgentMessage::User(_),
            ..
        } = entry
        {
            return if Some(index) == first_user_row {
                ChildUsageOrigin::SpawnTask
            } else {
                ChildUsageOrigin::DirectUser
            };
        }
        if let FileEntry::CustomMessage { payload, .. } = entry {
            let message_id = payload
                .details
                .as_ref()
                .and_then(|details| details.get("id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            return if payload.custom_type == AGENT_MESSAGE_CUSTOM_TYPE {
                if message_id.starts_with("spawn:") {
                    ChildUsageOrigin::SpawnTask
                } else {
                    ChildUsageOrigin::AgentMessage
                }
            } else {
                ChildUsageOrigin::DirectUser
            };
        }
    }
    ChildUsageOrigin::DirectUser
}

/// How the task run ended: drained on its own, closed by its parent
/// (delete or close), or its parent tore down.
enum TaskSettle {
    Done,
    Closed,
    ParentGone,
}

/// Wait until the child's task run settles: the agent is idle, its queues
/// are empty, and its own children (grandchildren of the spawning parent)
/// settled too (TS `waitForRlmQuiescence`). Follow-up turns a delivered
/// agent message starts keep the task unsettled until they drain. The
/// wait is ticked (`wait_for_idle` raced against the poll slice) so a
/// parent teardown is noticed within one slice even while the child's
/// own run streams: when the parent engine is gone the caller closes the
/// whole descendant subtree.
async fn wait_for_task_settle(
    host: &InProcessRlmHost,
    record: &Arc<InProcessChildRecord>,
) -> TaskSettle {
    loop {
        if host.parent_engine().is_none() {
            return TaskSettle::ParentGone;
        }
        if record.is_closed().await {
            return TaskSettle::Closed;
        }
        let agent = record.engine.session.agent();
        // Every iteration waits a bounded slice — an idle agent's
        // `wait_for_idle` resolves immediately (no run slot), so racing
        // it bare would spin; a busy run gets the slice as its tick so a
        // parent teardown or a mid-run delete is still noticed promptly.
        if agent.state().await.is_streaming {
            tokio::select! {
                () = agent.wait_for_idle() => {}
                () = tokio::time::sleep(Duration::from_millis(SETTLE_POLL_SLICE_MS)) => {}
            }
        } else {
            tokio::time::sleep(Duration::from_millis(SETTLE_POLL_SLICE_MS)).await;
        }
        if host.parent_engine().is_none() {
            return TaskSettle::ParentGone;
        }
        if record.is_closed().await {
            return TaskSettle::Closed;
        }
        let child_host = record.child_host.clone();
        let stable = !agent.has_queued_messages() && !child_host.any_running().await;
        if stable {
            tokio::time::sleep(Duration::from_millis(SETTLE_GRACE_MS)).await;
            if host.parent_engine().is_none() {
                return TaskSettle::ParentGone;
            }
            let still_idle = !agent.state().await.is_streaming;
            let still_empty = !agent.has_queued_messages() && !child_host.any_running().await;
            if still_idle && still_empty {
                return TaskSettle::Done;
            }
        }
    }
}

/// Flush the child's per-origin usage batches into the parent's
/// attribution producer (TS `flushPendingChildUsageAttribution` at the
/// settle boundary; one durable row per origin batch). A released parent
/// has no durable target and the batches drop, exactly like TS folding
/// into a session that is already gone.
async fn flush_pending_usage(host: &InProcessRlmHost, record: &Arc<InProcessChildRecord>) {
    let batches = std::mem::take(&mut record.state().await.pending_usage);
    if batches.is_empty() {
        return;
    }
    let Some(parent) = host.parent_engine() else {
        return;
    };
    parent
        .rlm_usage
        .record_child_usage(crate::session_engine::rlm_usage::RlmChildUsageReport {
            rlm_child_id: record.rlm_child_id.clone(),
            batches,
        })
        .await;
}

/// The roster: every live child's row (the tombstones answer `collect`
/// selectors only).
pub(super) fn list_subagents(host: InProcessRlmHost) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
    Box::pin(async move {
        let children = host.children().await;
        let now = now_ms();
        let mut entries = Vec::with_capacity(children.len());
        for record in children {
            entries.push(record.entry(now).await);
        }
        Ok(entries)
    })
}

/// Resolve one target against the live registry with the TS selector
/// errors.
async fn resolve_record(
    host: &InProcessRlmHost,
    target: &str,
    kind: &str,
) -> anyhow::Result<Arc<InProcessChildRecord>> {
    let children = host.children().await;
    let matches: Vec<Arc<InProcessChildRecord>> = children
        .into_iter()
        .filter(|record| record_matches(record, target))
        .collect();
    match matches.len() {
        0 => {
            anyhow::bail!("No direct RLM {kind} matches \"{target}\" in the current parent session")
        }
        1 => Ok(matches.into_iter().next().expect("one match")),
        _ => anyhow::bail!(
            "RLM {kind} selector \"{target}\" is ambiguous in the current parent session"
        ),
    }
}

/// `rlm.collect`: typed snapshots of the selected children (default:
/// every child), bounded by the timeout — a timeout returns snapshots,
/// never errors. A target whose delete receipt already returned resolves
/// to its settled cancelled envelope (TS #2388).
pub(super) fn collect(
    host: InProcessRlmHost,
    targets: Vec<String>,
    timeout_ms: u64,
) -> RlmHostFuture<Vec<RlmChildResult>> {
    Box::pin(async move {
        let mut records: Vec<Arc<InProcessChildRecord>> = if targets.is_empty() {
            host.children().await
        } else {
            Vec::with_capacity(targets.len())
        };
        let mut deleted_results = Vec::new();
        for target in &targets {
            match resolve_record(&host, target, "child").await {
                Ok(record) => records.push(record),
                Err(miss) => {
                    let matches = host.deleted_children_matching(target);
                    match matches.len() {
                        0 => return Err(miss),
                        1 => {
                            deleted_results.push(matches[0].collect_result());
                        }
                        _ => anyhow::bail!(
                            "RLM child selector \"{target}\" is ambiguous in the current parent session"
                        ),
                    }
                }
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut results = Vec::with_capacity(records.len());
        for record in &records {
            if record.is_running().await {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                let mut settled = record.settled_tx.subscribe();
                let _ = tokio::time::timeout(remaining, settled.wait_for(|settled| *settled)).await;
            }
            results.push(record.collect_result(now_ms()).await);
        }
        // Live entries first, the deleted generations' envelopes after
        // (TS `collectRlmChildren` result order).
        results.extend(deleted_results);
        Ok(results)
    })
}

/// `rlm.delete_subagent`: cancel a running child (abort + cancelled
/// verdict + the cancelled terminal notice), tear a settled one down, and
/// leave the tombstone behind so a just-deleted selector still collects
/// (TS #2388). The receipt's outcome is `deleted`.
pub(super) fn delete_subagent(
    host: InProcessRlmHost,
    target: String,
) -> RlmHostFuture<RlmDeleteSubagentResult> {
    Box::pin(async move {
        let record = resolve_record(&host, &target, "subagent").await?;
        let was_running = record.is_running().await;
        let parent = record.parent_engine.upgrade();
        let won = was_running && record.claim_notice(NoticeKind::Cancelled).await;
        if won {
            #[cfg(test)]
            host.pause_child_gate(super::ChildGatePoint::Claimed {
                child_id: record.rlm_child_id.clone(),
            })
            .await;
            record.request_task_cancel().await;
            record.engine.session.agent().abort();
            record.child_host.close_children().await;
            flush_pending_usage(&host, &record).await;
            let admitted = if let Some(parent) = parent {
                let row = super::notices::terminal_row(&record, NoticeKind::Cancelled, None, None)
                    .expect("cancelled notice");
                super::notices::admit_claimed_row(
                    &record,
                    parent,
                    super::notices::AdmissionRow::Terminal(row),
                    super::notices::RetryPolicy::ParkAfterBurst,
                )
                .await
            } else {
                record
                    .admission_failed(&anyhow::anyhow!(
                        "original parent session ended before cancellation admission"
                    ))
                    .await;
                record.mark_parked().await;
                false
            };
            // Task cancellation is separate from the terminal admission's
            // close signal: the winner gets its full retry burst first.
            record.mark_closed().await;
            if !admitted {
                anyhow::bail!(record
                    .parked_error()
                    .await
                    .unwrap_or_else(|| "terminal notice admission is pending".to_string()));
            }
            #[cfg(test)]
            host.pause_child_gate(super::ChildGatePoint::BeforePublish {
                child_id: record.rlm_child_id.clone(),
            })
            .await;
            record.publish_verdict(NoticeKind::Cancelled, None).await;
        } else if was_running {
            if !record.await_settled_or_parked().await {
                // A retry of the same delete may complete its own parked
                // Cancelled claim, but never changes a different winner.
                if record.claimed_kind().await == Some(NoticeKind::Cancelled) {
                    if let Some(parent) = parent {
                        let row = super::notices::terminal_row(
                            &record,
                            NoticeKind::Cancelled,
                            None,
                            None,
                        )
                        .expect("cancelled notice");
                        if super::notices::admit_claimed_row(
                            &record,
                            parent,
                            super::notices::AdmissionRow::Terminal(row),
                            super::notices::RetryPolicy::ParkAfterBurst,
                        )
                        .await
                        {
                            record.publish_verdict(NoticeKind::Cancelled, None).await;
                        }
                    }
                }
                if record.is_running().await {
                    anyhow::bail!(record
                        .parked_error()
                        .await
                        .unwrap_or_else(|| "terminal notice admission is pending".to_string()));
                }
            }
            record.mark_closed().await;
        } else {
            record.mark_closed().await;
        }
        record.child_host.close_children().await;
        record.engine.session.agent().abort();
        let entry = record.entry(now_ms()).await;
        host.remember_deleted_child(&record).await;
        host.remove_child(&record).await;
        record.unsubscribe_listener().await;
        Ok(RlmDeleteSubagentResult {
            subagent: entry,
            outcome: Some("deleted"),
        })
    })
}
