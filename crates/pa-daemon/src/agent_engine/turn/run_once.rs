//! The once-runner (moved with its concern): one model-turn attempt
//! with its retry/failover selection and the wire-shape
//! serializers for stream events, tool results, and agent messages.
use crate::engine::{session_wire_value, AssistantSnapshot};

use super::{
    json, json_round_trip, AgentSessionEngine, DaemonAllowlist, EngineEvent, TurnOnce, TurnPrompt,
    Value,
};

impl AgentSessionEngine {
    /// The provider retry policy from settings (TS `providerRetryPolicy`).
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
    /// filtered by the daemon model allowlist — a failover must never land
    /// a turn on a provider the operator pinned out (the same
    /// `allowedModels` gate as every other resolution). Faux-script
    /// sessions never fail over (their failures are deterministic test
    /// fixtures, and a second provider would only reroute the scripted
    /// queue).
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
            // Fail closed on an unreadable policy: no failover candidate
            // may bypass the configured allowlist.
            DaemonAllowlist::Unreadable(_) => Vec::new(),
        }
    }

    /// Run one turn, streaming assistant updates through `emit` as they
    /// arrive. The first attempt prompts the session; retries continue the
    /// parked turn. Returns the turn outcome: the final assistant message
    /// (provider failures included), `None` when no assistant message was
    /// produced, or `Aborted` when the emit callback cancelled the run or
    /// the delivery's cancel flag raced the admission (the abort-and-send
    /// idle race: an abort landing between the runner's pickup and the
    /// agent run's registration was lost to a run that registered fresh
    /// after it — see [`Self::run_model_turn`]'s admission consult).
    pub(super) async fn run_turn_once(
        &self,
        agent: &std::sync::Arc<pa_agent::agent::Agent>,
        prompt: &TurnPrompt,
        first_attempt: bool,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> anyhow::Result<TurnOnce> {
        // Stream assistant events while the turn runs.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
        // Goal usage accounting (TS `_accountGoalUsageForAssistantMessage`
        // at the message_end hook) shares the same per-message hook: while a
        // goal is active, each settled non-error assistant message records
        // its token delta; a budget crossing moves the goal to
        // `budget_limited` and the next emitted event publishes the
        // `goal_update`. The handles come from the engine mirror: the core
        // session's own mutex is held across the turn's admission.
        let goal_runtime = self.goal_runtime.lock().expect("goal runtime lock").clone();
        let goal_budget_crossed = std::sync::Arc::clone(&self.goal_budget_crossed);
        // The run-opening boundary frames (TS `agent_start` / `turn_start`)
        // are carried by the worker's own run-opening frames for the
        // item's first run, so this subscription forwards them only once a
        // boundary frame already passed in the item: an inner turn of the
        // same run (after the first `turn_end`) or a later run of the same
        // item (after an `agent_end` — a retry or a compact-and-retry
        // re-issue, exactly the runs TS restarts with their own frames).
        let boundary_passed = std::sync::Arc::clone(boundary_passed);
        let subscription = {
            let tx = tx.clone();
            let boundary_passed = std::sync::Arc::clone(&boundary_passed);
            // Per-message usage accounting runs on every settled assistant
            // message (whatever the stop reason except errors), matching the
            // TS message_end hook. The driver owns the policy; this loop
            // only forwards the message to it.
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
                    let boundary_passed = std::sync::Arc::clone(&boundary_passed);
                    let autonomous_state = std::sync::Arc::clone(&autonomous_state);
                    let autonomous_driver = std::sync::Arc::clone(&autonomous_driver);
                    let goal_runtime = goal_runtime.clone();
                    let goal_budget_crossed = goal_budget_crossed.clone();
                    Box::pin(async move {
                        use pa_agent::types::AgentEvent;
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
                                // Goal accounting mirrors the TS guard: only
                                // turns that were neither errors nor aborted
                                // spend the goal's budget, and only while
                                // the goal is active.
                                if let Some(handles) = goal_runtime.as_ref() {
                                    if !matches!(
                                        message.stop_reason,
                                        pa_types::ai::StopReason::Error
                                            | pa_types::ai::StopReason::Aborted
                                    ) {
                                        let mut driver = handles.driver.lock().await;
                                        let mut session = handles.session.lock().await;
                                        // The loop does not assign message
                                        // ids in-process; the timestamp is
                                        // the double-counting guard identity.
                                        let message_id = format!("a-{}", message.timestamp);
                                        // TS `_accountGoalUsageForAssistantMessage`
                                        // returning true: the budget crossing
                                        // moves the goal to `budget_limited`
                                        // (the tracking wrapper publishes the
                                        // `goal_update` with the next emit),
                                        // and the natural boundary mints the
                                        // budget-limit wrap-up steer.
                                        // TS `_shouldStopAfterTurn`'s catch:
                                        // goal accounting must not interrupt
                                        // the core agent loop; a failed
                                        // persist only warns.
                                        match driver
                                            .record_assistant_usage(&mut session, &message_id, &message.usage)
                                        {
                                            Ok(
                                                pa_core::session_engine::goal_driver::UsageOutcome::BudgetReached,
                                            ) => {
                                                // TS `_shouldStopAfterTurn`'s budget
                                                // arm arms the wrap-up steer: the
                                                // natural boundary reads it.
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
                                // Settled messages persist as session entries
                                // and reach clients: every assistant message
                                // (the TS `message_end` hook appends each
                                // one, mid-run tool-call turns included) and
                                // every tool-result message (framed as a
                                // message pair).
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
                                        }
                                    }
                                    // An in-run continuation's user row
                                    // (the autonomous hook's mint): the
                                    // loop drains it between turns, so the
                                    // `boundary_passed` gate separates it
                                    // from the admitted prompt's row — the
                                    // turn loop already emitted that one at
                                    // admission. Forwarded as the accepted
                                    // user-message frame (persist + the
                                    // message pair).
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
                            // The loop-boundary frames (TS `turn_start` /
                            // `turn_end` / `agent_start` / `agent_end`): the
                            // run-opening `turn_start` and `agent_start`
                            // stay with the worker's run-opening frames for
                            // the item's first run (the `boundary_passed`
                            // gate above — a later run of the same item
                            // forwards its own), `turn_end` carries the
                            // terminal assistant message plus the turn's
                            // tool-result messages, and `agent_end` the
                            // run's whole message set (the rows themselves
                            // persist and broadcast through their own
                            // events; these frames carry only the
                            // accumulated payloads, in the session wire
                            // shapes).
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
        // Admit the turn on the engine runtime without blocking the
        // forwarding loop below: the admission future settles only when the
        // whole turn settles (the TS daemon fires `prompt` with `void` and
        // streams events from the session listeners while it runs), while
        // the loop hands each streamed event to `emit` the moment it
        // arrives. Buffering events until the future resolves is what made
        // clients render a turn as one final batch.
        let prompt = prompt.clone();
        // The same admission consult as [`Self::run_model_turn`]'s, at the
        // admission future's head — the last stop before the agent run
        // registers: an abort landing in the driver's or the subscription's
        // prefix (after the model-turn consult, before the registration)
        // is honoured here the same way, so the whole [pickup,
        // registration] window honours the delivery's cancel flag.
        let abort_raced_admission = std::sync::atomic::AtomicBool::new(false);
        let mut admitted = std::pin::pin!(async {
            if aborted() {
                abort_raced_admission.store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(());
            }
            if first_attempt {
                // The session lock covers the clone only: the turn below
                // runs for the whole provider stream, and holding the
                // mutex across it serialized every client read seam
                // (`get_system_prompt` and its family waited for the turn
                // to settle and hit the client's 10s bound — the
                // 2026-09-22 dogfood failure). The Arc clone keeps the
                // turn on the same built session while the mutex stays
                // free for reads (the TS event loop interleaves both).
                let session = self.session.lock().await.clone();
                let engine = session.expect("session built");
                match &prompt {
                    // A plain turn admits a user prompt (text plus
                    // images); an injected turn admits the custom row
                    // itself (TS `_promptInjectedMessage`: the loop
                    // context holds ONE representation of the turn —
                    // the custom row — and the provider request carries
                    // its user-role view at the loop boundary).
                    TurnPrompt::User {
                        text,
                        images,
                        batch,
                    } => {
                        // The batched co-delivery rows ride the same
                        // admission (TS `_startPreparedTurnActions`'s one
                        // `agent.prompt(preparedMessages)`): one run over
                        // the primary plus every batched user row.
                        let options = pa_core::session_engine::PromptOptions {
                            batch: batch
                                .iter()
                                .map(|row| pa_core::session_engine::PromptBatchRow {
                                    text: row.text.clone(),
                                    images: row.images.clone(),
                                })
                                .collect(),
                            ..Default::default()
                        };
                        engine
                            .session
                            .prompt_with_images(text, images.clone(), options)
                            .await
                            .map(|_| ())
                    }
                    TurnPrompt::Injected(message) => engine
                        .session
                        .prompt_injected_message(message)
                        .await
                        .map(|_| ()),
                }
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
                    // The turn settled: drain the events that raced the
                    // resolution, then stop the loop.
                    while let Ok(event) = rx.try_recv() {
                        if !emit(event) {
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
            // admission and wait out its abort path before returning, so no
            // run outlives this attempt. A turn whose admission already
            // settled (the abort gate dropped only the settled run's tail
            // events in the drain) must not re-poll the completed future -
            // `std::pin::pin!` futures panic when resumed after
            // completion - so only an in-flight admission is awaited out.
            agent.abort();
            let _ = (&mut admitted).await;
        }
        // The settled run's tail still holds the aborted assistant row: the
        // abort finalize emits the row after the cancel (TS
        // `createAbortedAssistantMessage`), so every queued event drains
        // through the emit gate — the row's frames pass (broadcast +
        // persist), the post-abort stragglers drop.
        while let Ok(event) = rx.try_recv() {
            let _ = emit(event);
        }
        let () = subscription.unsubscribe().await;
        if aborted {
            return Ok(TurnOnce::Aborted);
        }
        // The admission consult fired: the turn never started (no run
        // registered, no provider call) — the aborted outcome, never an
        // admission error the retry driver would classify as a provider
        // failure and re-issue.
        if abort_raced_admission.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(TurnOnce::Aborted);
        }
        if let Some(error) = admission_error {
            return Err(anyhow::anyhow!("{error:#}"));
        }
        // The final assistant message decides the outcome (provider
        // failures included: the retry driver classifies them).
        let state = agent.state().await;
        for message in state.messages.iter().rev() {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = message
            {
                // The message must carry the session wire shape (the
                // transcript already received it through message_end); a
                // round-trip failure means no usable turn outcome.
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

/// Wire form of one provider stream event (TS `assistantMessageEvent`):
/// the event `type` plus the `delta` when the event carries one.
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
