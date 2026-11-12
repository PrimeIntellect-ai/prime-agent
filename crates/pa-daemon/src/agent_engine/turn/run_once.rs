//! The once-runner: one model-turn attempt with its retry/failover
//! selection and the wire-shape serializers for stream events, tool
//! results, and agent messages.
use crate::engine::{session_wire_value, AssistantSnapshot};

use super::{
    json, json_round_trip, AgentSessionEngine, DaemonAllowlist, EngineEvent, TurnOnce, TurnPrompt,
    Value,
};

impl AgentSessionEngine {
    pub(super) fn retry_policy(
        &self,
    ) -> pa_core::session_engine::provider_retry::ProviderRetryPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_retry_policy()
    }

    /// The provider-failover policy from settings (`retry.failover`).
    pub(super) fn failover_policy(
        &self,
    ) -> pa_core::session_engine::provider_failover::ProviderFailoverPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_failover_policy()
    }

    /// The failover chain for `model`: the other auth-configured providers
    /// serving the same model id, in catalog order after the current one,
    /// filtered by the daemon model allowlist. Faux-script sessions never
    /// fail over.
    pub(super) fn failover_candidates(
        &self,
        model: &pa_types::ai::Model,
    ) -> Vec<pa_types::ai::Model> {
        if self.config.faux_script.is_some() {
            return Vec::new();
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry.load_private_authorization_from_cache();
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let candidates = pa_core::models::failover_candidates(model, &available);
        match crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir) {
            DaemonAllowlist::Unrestricted => candidates,
            DaemonAllowlist::Allowed(patterns) => candidates
                .into_iter()
                .filter(|candidate| {
                    pa_core::models::model_allowed(
                        &format!("{}/{}", candidate.provider, candidate.id),
                        &patterns,
                    )
                })
                .collect(),
            // Fail closed on an unreadable policy.
            DaemonAllowlist::Unreadable(_) => Vec::new(),
        }
    }

    /// Run one turn, streaming assistant updates through `emit` as they
    /// arrive. The first attempt prompts the session; retries continue the
    /// parked turn. Returns the final assistant message, `None` when none
    /// was produced, or `Aborted` when the emit cancelled or the cancel flag
    /// raced the admission.
    // The model-change queue preserves the separate engine and worker stores
    // at this run boundary; keep it alongside the existing delivery arguments.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_turn_once(
        &self,
        agent: &std::sync::Arc<pa_agent::agent::Agent>,
        prompt: &TurnPrompt,
        first_attempt: bool,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        pending_model_changes: &std::sync::Arc<
            std::sync::Mutex<Vec<pa_types::session::ModelChangeEntry>>,
        >,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> anyhow::Result<TurnOnce> {
        // This seat is live from here through the final harvest below: a
        // queued drain waits until it is the only live seat, so an earlier
        // seat's subscription can never forward/account the next run's
        // events nor harvest its assistant.
        self.turn_seats
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _seat = TurnSeatGuard(std::sync::Arc::clone(&self.turn_seats));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
        // Goal usage accounting at the message_end hook: each settled non-error
        // assistant message records its token delta, from the engine mirror.
        let goal_runtime = self.goal_runtime.lock().expect("goal runtime lock").clone();
        let goal_budget_crossed = std::sync::Arc::clone(&self.goal_budget_crossed);
        // The run-opening boundary frames are the worker's own for the
        // item's first run; this subscription forwards them only once a
        // boundary frame already passed.
        let boundary_passed = std::sync::Arc::clone(boundary_passed);
        // The parked gate: while the delivery waits on another run's
        // lane, that run's events belong to its own seat — this
        // subscription forwards and accounts nothing until the drain
        // actually starts the parked rows (the gate re-opens then).
        let parked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let subscription_parked = std::sync::Arc::clone(&parked);
        let subscription = {
            let tx = tx.clone();
            let pending_model_changes = pending_model_changes.clone();
            let boundary_passed = std::sync::Arc::clone(&boundary_passed);
            let autonomous_state = std::sync::Arc::clone(&self.autonomous);
            let autonomous_driver = std::sync::Arc::clone(
                &*self
                    .autonomous_driver
                    .read()
                    .expect("autonomous driver lock"),
            );
            agent
                .subscribe(move |event, _signal| {
                    let tx = tx.clone();
                    let pending_model_changes = pending_model_changes.clone();
                    let boundary_passed = std::sync::Arc::clone(&boundary_passed);
                    let autonomous_state = std::sync::Arc::clone(&autonomous_state);
                    let autonomous_driver = std::sync::Arc::clone(&autonomous_driver);
                    let goal_runtime = goal_runtime.clone();
                    let goal_budget_crossed = goal_budget_crossed.clone();
                    let parked = std::sync::Arc::clone(&subscription_parked);
                    Box::pin(async move {
                        use pa_agent::types::AgentEvent;
                        if parked.load(std::sync::atomic::Ordering::SeqCst) {
                            // The delivery parked on the running turn's
                            // lane: its stream belongs to that turn's own
                            // seat (this seat would duplicate rows and
                            // double the usage accounting).
                            return Ok(());
                        }
                        if let AgentEvent::MessageEnd {
                            message:
                                pa_agent::types::AgentMessage::Standard(
                                    pa_agent::types::Message::Assistant(assistant),
                                ),
                        } = &event
                        {
                            if let Some(message) =
                                json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant)
                            {
                                let mut state = autonomous_state.lock().await;
                                autonomous_driver.account_message(&mut state, &message);
                                // Goal accounting: only turns neither errors
                                // nor aborted spend the budget, only while
                                // active.
                                if let Some(handles) = goal_runtime.as_ref() {
                                    if !matches!(
                                        message.stop_reason,
                                        pa_types::ai::StopReason::Error
                                            | pa_types::ai::StopReason::Aborted
                                    ) {
                                        let mut driver = handles.driver.lock().await;
                                        let mut session = handles.session.lock().await;
                                // The timestamp is the double-counting guard identity (no
                                // in-process ids).
                                        let message_id = format!("a-{}", message.timestamp);
                                        // A budget crossing moves the goal to
                                        // `budget_limited` (the wrapper publishes
                                        // the `goal_update`; the boundary mints
                                        // the wrap-up steer); a failed persist
                                        // only warns.
                                        match driver
                                            .record_assistant_usage(&mut session, &message_id, &message.usage)
                                        {
                                            Ok(
                                                pa_core::session_engine::goal_driver::UsageOutcome::BudgetReached,
                                            ) => {
                                                goal_budget_crossed
                                                    .store(true, std::sync::atomic::Ordering::SeqCst);
                                            }
                                            Ok(_) => {}
                                            Err(error) => {
                                                eprintln!(
                                                    "pa-daemon: goal usage accounting persist failed: {error:#}"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        match &event {
                            AgentEvent::MessageStart {
                                message: agent_message,
                            } => {
                                if matches!(
                                    agent_message,
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                    )
                                ) {
                                    if let Some(value) = session_wire_value(agent_message) {
                                        let _ = tx.send(EngineEvent::AssistantUpdate {
                                            message: AssistantSnapshot::Wire(value),
                                            stream_event: Some(json!({ "type": "start" })),
                                        });
                                    }
                                }
                            }
                            AgentEvent::MessageUpdate {
                                message: agent_message,
                                assistant_message_event: stream_event,
                            } => {
                                if matches!(
                                    agent_message.as_ref(),
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                    )
                                ) {
                                    let _ = tx.send(EngineEvent::AssistantUpdate {
                                        message: AssistantSnapshot::Loop(std::sync::Arc::clone(
                                            agent_message,
                                        )),
                                        stream_event: stream_event_value(stream_event),
                                    });
                                }
                            }
                            AgentEvent::MessageEnd {
                                message: agent_message,
                            } => {
                                // Settled messages persist as entries and reach
                                // clients: every assistant and tool-result
                                // message.
                                match agent_message {
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                            | pa_agent::types::Message::ToolResult(_),
                                    ) => {
                                        if let Some(value) = session_wire_value(agent_message) {
                                            let event = if matches!(
                                                agent_message,
                                                pa_agent::types::AgentMessage::Standard(
                                                    pa_agent::types::Message::ToolResult(_)
                                                )
                                            ) {
                                                EngineEvent::ToolResultMessage(value)
                                            } else {
                                                EngineEvent::AssistantMessage(value)
                                            };
                                            let _ = tx.send(event);
                                            for change in pending_model_changes.lock()
                                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                                .drain(..) {
                                                let _ = tx.send(EngineEvent::ModelChange(change));
                                            }
                                        }
                                    }
                                    // An in-run continuation's user row: the
                                    // `boundary_passed` gate separates it from
                                    // the admitted prompt's row, which the loop
                                    // already emitted.
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::User(_),
                                    ) if boundary_passed
                                        .load(std::sync::atomic::Ordering::SeqCst) =>
                                    {
                                        if let Some(value) = session_wire_value(agent_message) {
                                            let _ = tx.send(EngineEvent::UserMessage(value));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            // The loop-boundary frames: the run-opening frames stay with the
                            // worker's first run (the `boundary_passed` gate); `turn_end` carries
                            // the terminal message plus tool results, `agent_end` the whole set.
                            AgentEvent::TurnStart => {
                                if boundary_passed.load(std::sync::atomic::Ordering::SeqCst) {
                                    let _ = tx.send(EngineEvent::TurnStart);
                                }
                            }
                            AgentEvent::AgentStart => {
                                if boundary_passed.load(std::sync::atomic::Ordering::SeqCst) {
                                    let _ = tx.send(EngineEvent::AgentStart);
                                }
                            }
                            AgentEvent::AgentEnd { messages } => {
                                let messages = messages
                                    .iter()
                                    .filter_map(session_wire_value)
                                    .collect::<Vec<Value>>();
                                boundary_passed.store(true, std::sync::atomic::Ordering::SeqCst);
                                let _ = tx.send(EngineEvent::AgentEnd { messages });
                            }
                            AgentEvent::TurnEnd {
                                message,
                                tool_results,
                            } => {
                                if let Some(message) = session_wire_value(message) {
                                    let tool_results = tool_results
                                        .iter()
                                        .filter_map(|result| {
                                            session_wire_value(&pa_agent::types::AgentMessage::from(
                                                result.clone(),
                                            ))
                                        })
                                        .collect::<Vec<Value>>();
                                    boundary_passed
                                        .store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = tx.send(EngineEvent::TurnEnd {
                                        message,
                                        tool_results,
                                    });
                                }
                            }
                            AgentEvent::ToolExecutionStart {
                                tool_call_id,
                                tool_name,
                                args,
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionStart {
                                    tool_call_id: tool_call_id.clone(),
                                    tool_name: tool_name.clone(),
                                    args: args.clone(),
                                });
                            }
                            AgentEvent::ToolExecutionProgress { .. } => {}
                            AgentEvent::ToolExecutionUpdate {
                                tool_call_id,
                                partial_result,
                                ..
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionUpdate {
                                    tool_call_id: tool_call_id.clone(),
                                    partial_result: tool_result_wire_value(partial_result),
                                });
                            }
                            AgentEvent::ToolExecutionEnd {
                                tool_call_id,
                                result,
                                is_error,
                                ..
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionEnd {
                                    tool_call_id: tool_call_id.clone(),
                                    result: tool_result_wire_value(result),
                                    is_error: *is_error,
                                });
                            }
                        }
                        Ok(())
                    })
                })
                .await
        };
        // Admit the turn without blocking the forwarding loop: the admission
        // future settles only when the whole turn settles, while the loop
        // hands each streamed event to `emit` the moment it arrives (buffering
        // made clients render a turn as one final batch).
        let prompt = prompt.clone();
        // The same admission consult as [`Self::run_model_turn`]'s, at the
        // admission future's head: the whole [pickup, registration] window
        // honours the delivery's cancel flag.
        let abort_raced_admission = std::sync::atomic::AtomicBool::new(false);
        // A parked delivery whose wait unwound on the cancel flag: the row
        // stays queued for the next run, and this attempt settles aborted.
        let queued_aborted = std::sync::atomic::AtomicBool::new(false);
        // A parked delivery the streaming run consumed on its own lane: the
        // seat settles the acceptance, never the running turn's reply.
        let queued_consumed = std::sync::atomic::AtomicBool::new(false);
        // The emit-driven cancellation (the delivery's own gate): the drain
        // consults it beside the delivery's cancel flag, so a cancelled
        // turn never starts fresh model/tool work.
        let emit_cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut admitted = std::pin::pin!(async {
            if aborted() {
                abort_raced_admission.store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(());
            }
            if first_attempt {
                // The session lock covers the clone only: holding it across
                // the turn serialized every client read seam (the 2026-09-22
                // dogfood failure); the Arc clone keeps reads free.
                let session = self.session.lock().await.clone();
                let engine = session.expect("session built");
                if std::env::var_os("PA_COMPACTION_TRACE").is_some() {
                    let state = engine.session.agent().state().await;
                    pa_core::session_engine::compaction_trace::trace(
                        "daemon.before_prompt_admission",
                        &json!({
                            "liveUserRows": state.messages.iter().filter(|message|
                                matches!(message, pa_agent::types::AgentMessage::Standard(
                                    pa_agent::types::Message::User(_)))).count(),
                        }),
                    );
                }
                let outcome = match &prompt {
                    // A plain turn admits a user prompt; an injected turn admits the
                    // custom row itself — ONE representation.
                    TurnPrompt::User {
                        text,
                        images,
                        batch,
                    } => {
                        // The batched co-delivery rows ride the same admission: one run over
                        // the primary plus every batched row.
                        let options = pa_core::session_engine::PromptOptions {
                            batch: batch
                                .iter()
                                .map(|row| pa_core::session_engine::PromptBatchRow {
                                    text: row.text.clone(),
                                    images: row.images.clone(),
                                })
                                .collect(),
                            // A user message is the steer class: when the
                            // agent is busy at admission it interrupts the
                            // running turn (the operator ruling), never
                            // rejects.
                            streaming_behavior: Some(
                                pa_core::session_engine::StreamingBehavior::Steer,
                            ),
                            ..Default::default()
                        };
                        engine
                            .session
                            .prompt_with_images(text, images.clone(), options)
                            .await?
                    }
                    // The injected row carries its delivery's lane behavior:
                    // a busy session queues the row (steer or follow-up),
                    // never fails the turn with the admission rejection.
                    TurnPrompt::Injected { message, behavior } => {
                        engine
                            .session
                            .prompt_injected_message_with_behavior(message, *behavior)
                            .await?
                    }
                };
                // A busy session parked the delivery on the agent's lanes.
                // Report nothing from a parked row: wait for the streaming
                // run to settle and drain the lanes (the delivery actually
                // runs), so the stale-assistant harvest below never speaks
                // for this seat and the row never waits past the run it
                // rode (the AgentEnd window included).
                if outcome == pa_core::session_engine::PromptOutcome::Queued {
                    let drain_aborted = {
                        let emit_cancelled = std::sync::Arc::clone(&emit_cancelled);
                        move || {
                            aborted() || emit_cancelled.load(std::sync::atomic::Ordering::SeqCst)
                        }
                    };
                    match drain_queued_delivery(agent, &drain_aborted, &parked, &self.turn_seats)
                        .await?
                    {
                        QueuedDrain::Drained => {}
                        QueuedDrain::Consumed => {
                            queued_consumed.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                        QueuedDrain::Aborted => {
                            queued_aborted.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                Ok(())
            } else {
                agent.continue_run().await
            }
        });
        let mut aborted = false;
        let mut admission_error: Option<anyhow::Error> = None;
        let mut settled = false;
        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Some(event) => {
                            if !emit(event) {
                                emit_cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                                aborted = true;
                            }
                        }
                        None => break,
                    }
                }
                outcome = &mut admitted => {
                    settled = true;
                    match outcome {
                        Ok(()) => {}
                        Err(error) => admission_error = Some(error),
                    }
                    while let Ok(event) = rx.try_recv() {
                        if !emit(event) {
                            emit_cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                            aborted = true;
                            break;
                        }
                    }
                }
            }
            if aborted || settled {
                break;
            }
        }
        if aborted && !settled {
            // The emit callback cancelled the turn: stop the still-running
            // admission and wait out its abort path. A settled admission
            // must not be re-polled (pinned futures panic after completion).
            agent.abort();
            let _ = (&mut admitted).await;
        }
        // The settled run's tail still holds the aborted assistant row: drain
        // every queued event.
        while let Ok(event) = rx.try_recv() {
            let _ = emit(event);
        }
        let () = subscription.unsubscribe().await;
        if aborted {
            return Ok(TurnOnce::Aborted);
        }
        // The admission consult fired: the turn never started — the aborted
        // outcome, never an admission error the retry driver would re-issue.
        if abort_raced_admission.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(TurnOnce::Aborted);
        }
        // The parked delivery's wait unwound on the cancel flag: the row
        // stays queued for the next run, and this attempt is the aborted
        // settle — never a stale harvest of another run's reply.
        if queued_aborted.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(TurnOnce::Aborted);
        }
        // The running turn consumed the parked row on its own lane: this
        // seat carries the acceptance settle only — the harvest below would
        // report that turn's assistant as this seat's reply (its own seat
        // owns the stream and the settled-turn accounting).
        if queued_consumed.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(TurnOnce::Queued);
        }
        if let Some(error) = admission_error {
            return Err(anyhow::anyhow!("{error:#}"));
        }
        let state = agent.state().await;
        for message in state.messages.iter().rev() {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = message
            {
                // A round-trip failure means no usable outcome.
                if json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant).is_none() {
                    return Ok(TurnOnce::None);
                }
                return Ok(TurnOnce::Message {
                    assistant: Box::new(assistant.clone()),
                });
            }
        }
        Ok(TurnOnce::None)
    }
}

/// One live delivery seat's scope: `run_turn_once` holds it from entry
/// through the final harvest, so a queued drain (see
/// [`drain_queued_delivery`]) can wait until it is the only live seat —
/// an earlier seat's still-active subscription forwards and accounts
/// events, and its harvest could take the next run's assistant.
struct TurnSeatGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for TurnSeatGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What the busy-session parking seam did with the parked rows.
enum QueuedDrain {
    /// This seat ran the parked rows (`continue_run`): the harvest owns the
    /// drained run's outcome.
    Drained,
    /// The parked row left the lane without this seat running it: a
    /// streaming run's boundary poll consumed it (the steering contract) or
    /// another drainer won the slot. This seat reports acceptance only.
    Consumed,
    /// The delivery's cancel flag ended the wait or the drain: the row
    /// stays parked for the next run and the attempt settles aborted.
    Aborted,
}

/// The busy-session parking seam: a delivery whose admission queued it onto
/// a streaming run must not be reported as a finished prompt (the stale
/// assistant harvest), and its parked row must not wait for an unrelated
/// future run — wait for the streaming run to settle, then drain the parked
/// lanes so the queued delivery actually runs (the `resumeIfIdle` seam, the
/// RPC queue pump's contract on the delivery's own run).
///
/// The wait AND the drain observe the delivery's cancel flag: a set flag
/// (abort, the replacement teardown) ends them as [`QueuedDrain::Aborted`]
/// — the row stays parked for the next run (the bounded poll backstop
/// covers a stream that cannot settle, like the replacement teardown's own
/// settle wait). A `Busy` drain retries after the still-finishing run
/// releases its slot (`is_streaming` clears before the active-run slot
/// does), never leaving the row parked behind a misread slot race.
async fn drain_queued_delivery(
    agent: &std::sync::Arc<pa_agent::agent::Agent>,
    aborted: &dyn Fn() -> bool,
    parked: &std::sync::atomic::AtomicBool,
    seats: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
) -> anyhow::Result<QueuedDrain> {
    // The delivery is parked: the running turn's events belong to its own
    // seat (the gate suppresses this seat's forwarding and accounting).
    parked.store(true, std::sync::atomic::Ordering::SeqCst);
    loop {
        if aborted() {
            return Ok(QueuedDrain::Aborted);
        }
        if !agent.state().await.is_streaming {
            break;
        }
        if wait_for_run_slot(agent, aborted).await {
            return Ok(QueuedDrain::Aborted);
        }
    }
    loop {
        // The drain consults the cancel flag again: an abort (the emit
        // gate's own `agent.abort()` included) must not be answered by
        // starting a fresh run.
        if aborted() {
            return Ok(QueuedDrain::Aborted);
        }
        if !agent.has_queued_messages() {
            return Ok(QueuedDrain::Consumed);
        }
        // Every earlier delivery seat must finish before a new run starts:
        // its still-active subscription would forward and account this
        // run's events, and its harvest could take this run's assistant as
        // its own reply. This seat itself is counted (the wait ends at 1);
        // the wait is cancel-aware.
        while seats.load(std::sync::atomic::Ordering::SeqCst) != 1 {
            if aborted() {
                return Ok(QueuedDrain::Aborted);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // This seat starts the parked rows: the drained run's events are
        // ours to forward and account again.
        parked.store(false, std::sync::atomic::Ordering::SeqCst);
        match agent.continue_run().await {
            Ok(()) => return Ok(QueuedDrain::Drained),
            Err(error) => match error.downcast_ref::<pa_agent::agent::AgentContinueError>() {
                // The active run's slot is still finishing (`is_streaming`
                // already cleared) — or a raced drainer beat this one to
                // it: wait for the slot, re-park (the winner's stream is
                // its own seat's), and retry the drain.
                Some(error) if error.code == pa_agent::agent::AgentContinueErrorCode::Busy => {
                    parked.store(true, std::sync::atomic::Ordering::SeqCst);
                    if wait_for_run_slot(agent, aborted).await {
                        return Ok(QueuedDrain::Aborted);
                    }
                }
                // `NothingToContinue`: another drainer took the rows.
                Some(_) => return Ok(QueuedDrain::Consumed),
                None => return Err(error),
            },
        }
    }
}

/// Wait for the active run to release its slot: the bounded-poll backstop
/// covers a stream that cannot settle, and the cancel flag ends the wait
/// (answers `true`) exactly like the streaming wait above.
async fn wait_for_run_slot(
    agent: &std::sync::Arc<pa_agent::agent::Agent>,
    aborted: &dyn Fn() -> bool,
) -> bool {
    loop {
        if aborted() {
            return true;
        }
        if !agent.has_active_run() {
            return false;
        }
        tokio::select! {
            () = agent.wait_for_idle() => {}
            () = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
    }
}

/// Wire form of one provider stream event: the event `type` plus the
/// `delta` when the event carries one.
fn stream_event_value(event: &pa_agent::stream::AssistantMessageEvent) -> Option<Value> {
    use pa_agent::stream::AssistantMessageEvent;
    let (kind, delta) = match event {
        AssistantMessageEvent::Start { .. } => ("start", None),
        AssistantMessageEvent::TextStart { .. } => ("text_start", None),
        AssistantMessageEvent::TextDelta { delta, .. } => ("text_delta", Some(delta.as_str())),
        AssistantMessageEvent::TextEnd { .. } => ("text_end", None),
        AssistantMessageEvent::ThinkingStart { .. } => ("thinking_start", None),
        AssistantMessageEvent::ThinkingDelta { delta, .. } => {
            ("thinking_delta", Some(delta.as_str()))
        }
        AssistantMessageEvent::ThinkingEnd { .. } => ("thinking_end", None),
        AssistantMessageEvent::ToolCallStart { .. } => ("toolcall_start", None),
        AssistantMessageEvent::ToolCallDelta { delta, .. } => {
            ("toolcall_delta", Some(delta.as_str()))
        }
        AssistantMessageEvent::ToolCallEnd { .. } => ("toolcall_end", None),
        AssistantMessageEvent::Done { .. } | AssistantMessageEvent::Error { .. } => return None,
    };
    match delta {
        Some(delta) => Some(json!({ "type": kind, "delta": delta })),
        None => Some(json!({ "type": kind })),
    }
}

/// Wire form of one tool result (the TS tool-execution event payload).
fn tool_result_wire_value(result: &pa_agent::types::AgentToolResult) -> Value {
    let content: Vec<Value> = result
        .content
        .iter()
        .map(|block| serde_json::to_value(block).unwrap_or(Value::Null))
        .collect();
    json!({ "content": content, "details": result.details })
}
