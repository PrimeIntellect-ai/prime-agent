//! The Decision API child engine (`rlm.spawn kind="decision"`): a spawned
//! session whose every message is one decision request, answered by a
//! single decision model call — the registry-resolved
//! `decisionModel` model (resolved once at engine start)
//! over the shared decision path (`pa_core::session_engine::decision_api`).
//! Each answer returns to the parent as a tagged
//! `decision_api.decision` message (the parent's goal rides the
//! request's `state`, the only guidance channel the model reads).

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::anyhow;
use serde_json::{json, Value};

use crate::agent_messaging::{FamilyIdentity, LinkAgentMessageController};
use crate::async_safe_runtime::AsyncSafeRuntime;
use crate::engine::{
    AssistantSnapshot, BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome,
    CompactionRequest, EngineEvent, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};
use pa_core::session_engine::agent_messaging::{
    AgentFamilyRelationship, AgentMessageSendInput, SPAWN_KICKOFF_ID_PREFIX,
};
use pa_core::session_engine::decision_api::{
    RefusedDecisionReply, ResolvedDecisionModel, ServedDecision,
};
use pa_core::session_engine::side_question::SideQuestionSink;
use tokio_util::sync::CancellationToken;

/// The decision child's engine.
pub struct DecisionEngine {
    /// The decision model resolved once at engine start, or the actionable
    /// refusal every decision answers with.
    model: Result<ResolvedDecisionModel, String>,
    /// The tagged-reply sender over the supervisor link.
    sender: Arc<LinkAgentMessageController>,
    /// The sender's identity source: the worker's session summary.
    own_summary: Arc<Mutex<Option<Value>>>,
    /// The engine's own runtime: the decision call and the reply send are
    /// async, `run_prompt` is not — a current-thread runtime serves every
    /// `block_on` (the engine spawns nothing).
    runtime: AsyncSafeRuntime,
    /// The running turn's cancellation: replaced at the start of every
    /// `run_prompt`, cancelled by `abort_in_flight_turn`.
    turn_cancel: Mutex<CancellationToken>,
}

impl DecisionEngine {
    /// Build the engine over the worker's supervisor link; the worker's
    /// session summary (pushed through `set_session_summary`) becomes the
    /// sender identity.
    ///
    /// # Panics
    ///
    /// Panics when the engine runtime cannot start.
    #[must_use]
    pub fn new(
        cwd: &Path,
        agent_dir: &Path,
        link: Arc<crate::supervisor_link::SupervisorLink>,
        active_session_id: String,
        worker_token: String,
    ) -> Self {
        let own_summary: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let sender = Arc::new(LinkAgentMessageController::new(
            link,
            active_session_id,
            worker_token,
            Arc::clone(&own_summary),
            None,
        ));
        // The decision model selection resolves once here, at engine
        // start; every decision re-resolves its request credential
        // (the expiry check, the OAuth refresh) through the resolved
        // model's per-request seam. A failed resolution keeps its
        // actionable refusal for every decision.
        let model = pa_core::session_engine::decision_api::resolve_decision_model(cwd, agent_dir);
        Self {
            model,
            own_summary,
            sender,
            runtime: AsyncSafeRuntime::new_current_thread().expect("decision engine runtime"),
            turn_cancel: Mutex::new(CancellationToken::new()),
        }
    }

    /// The raw delivered body: the agent-message row carries it in
    /// `details.message`; a plain prompt is its own body.
    fn raw_message(request: &PromptRequest) -> &str {
        request
            .custom_message
            .as_ref()
            .and_then(|row| row.get("details"))
            .and_then(|details| details.get("message"))
            .and_then(Value::as_str)
            .unwrap_or(&request.message)
    }

    /// Send one tagged reply to the parent through the supervisor link:
    /// the target is the parent id the worker already knows — the durable
    /// parent edge in its pushed session summary — so a reply never
    /// fetches the family roster just to find it. The reply rides the
    /// follow-up lane: its arrival queues behind the parent's running turn
    /// instead of steering (interrupting) it.
    /// Delivery is cancellation-aware: a cancel that lands after the
    /// turn's last check still stops the send before either delivery leg,
    /// including the supervisor fallback after a refused direct ticket.
    fn send_reply(&self, message: &Value, aborted: &dyn Fn() -> bool) -> anyhow::Result<()> {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        // Only the parent edge names the target; the identity's own id is
        // unused here. The target prefers the parent's live active id and
        // falls back to its durable session id: a woken (passivated)
        // child's summary carries no live id, and the durable id resolves
        // the same parent — a live worker directly, a passivated one
        // through its wake.
        let identity = FamilyIdentity::from_summary(summary.as_ref(), "");
        let target = identity
            .parent_active_session_id
            .or(identity.parent_session_id)
            .ok_or_else(|| {
                anyhow!("the decision child has no parent edge in its session summary")
            })?;
        let sender = Arc::clone(&self.sender);
        let message = message.to_string();
        self.runtime.block_on(async move {
            sender
                .send_agent_message_cancellable(
                    AgentMessageSendInput {
                        target,
                        message,
                        receiver_role: Some(AgentFamilyRelationship::Parent),
                        delivery_mode: Some("follow_up"),
                    },
                    aborted,
                )
                .await
                .map(|_| ())
        })
    }

    /// Serve one decision request message: run the shared decision path
    /// (one provider completion) with the engine-resolved model. The
    /// request's `state` carries the parent's guidance verbatim — the
    /// engine keeps no channel of its own. The call races the turn's
    /// cancellation, so an abort lands mid-call instead of after the
    /// whole decision bound.
    fn serve(
        &self,
        request: Value,
        cancel: &CancellationToken,
    ) -> anyhow::Result<(&ResolvedDecisionModel, ServedDecision)> {
        let resolved = match self.model.as_ref() {
            Ok(resolved) => resolved,
            Err(refusal) => return Err(anyhow!(refusal.clone())),
        };
        let served = self.runtime.block_on(async {
            tokio::select! {
                result = pa_core::session_engine::decision_api::serve_decision_request(
                    request,
                    resolved,
                ) => result,
                () = cancel.cancelled() => Err(anyhow!("the decision call was aborted")),
            }
        })?;
        Ok((resolved, served))
    }

    /// The event pair for an answer: the streaming update and the final
    /// message. Both carry a typed assistant message — one text block, the
    /// resolved model's `api`, a real usage, `StopReason::Stop` — because
    /// `turn.rs` persists the final message verbatim and every later reader
    /// deserializes it: the reopened or revived child's context builder and
    /// the exit capture's `last_assistant_text_from_file` skip a row that
    /// does not parse. The update is a wire frame only and never persists,
    /// so the final message is the one row the cost ledger bills; a row
    /// without usage reads as a free call.
    fn answer_rows(
        api: &str,
        provider: &str,
        model: &str,
        text: &str,
        usage: pa_types::ai::Usage,
    ) -> (EngineEvent, EngineEvent) {
        let now = crate::util::now_ms();
        let row = |text: &str| {
            let message = pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: text.to_string(),
                        text_signature: None,
                        rest: serde_json::Map::default(),
                    },
                )],
                api: api.to_string(),
                provider: provider.to_string(),
                model: model.to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage,
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: now,
                rest: serde_json::Map::default(),
            };
            // The role-tagged session shape: the row persists and reads
            // back as an assistant message (the store's `AgentMessage`
            // tag), so the answer stays reachable for every later reader.
            serde_json::to_value(pa_types::session::AgentMessage::Assistant(message))
                .expect("the typed assistant row serializes")
        };
        (
            EngineEvent::AssistantUpdate {
                message: AssistantSnapshot::Wire(row("")),
                stream_event: None,
            },
            EngineEvent::AssistantMessage(row(text)),
        )
    }
}

impl SessionEngine for DecisionEngine {
    /// The worker's live session summary: the sender identity block of the
    /// tagged replies.
    fn set_session_summary(&self, summary: Value) {
        *self
            .own_summary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(summary);
    }

    /// The whole-worker gate passes: the engine holds no kernel, no cron,
    /// no RLM children of its own, and no memory-only input — the
    /// worker-side idle fences (attachment, queued lanes, live bash) are
    /// the whole gate, so an idle decision child passivates instead of
    /// staying resident.
    fn can_passivate_worker(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(std::future::ready(true))
    }

    /// Every abort path sets the worker's cancel flag before this hook, so
    /// an abort that lands before `run_prompt` replaces the token is still
    /// caught by the run's `aborted()` checks.
    fn abort_in_flight_turn(&self) {
        self.turn_cancel
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cancel();
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "a decision child answers decision requests only".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Failed {
            error: "a decision child has no conversation to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        BranchSummaryOutcome::Failed {
            error: "a decision child has no branches to summarize".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        let cancelled = || EngineEvent::Done(Err("prompt cancelled".to_string()));
        let cancel = CancellationToken::new();
        *self
            .turn_cancel
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = cancel.clone();
        // The accepted row: the injected agent-message row, or the plain prompt.
        let accepted_row = match &request.custom_message {
            Some(custom) => custom.clone(),
            None => json!({
                "role": "user",
                "content": request.message.clone(),
                "timestamp": crate::util::now_ms(),
            }),
        };
        let accepted = match &request.custom_message {
            Some(_) => EngineEvent::CustomMessage(accepted_row.clone()),
            None => EngineEvent::UserMessage(accepted_row.clone()),
        };
        if !emit(accepted) {
            emit(cancelled());
            return;
        }
        if aborted() {
            emit(cancelled());
            return;
        }
        // The spawn kickoff (the task row `rlm.spawn` delivers) readies the
        // child; every other message is a decision request, and one that
        // does not parse answers with an error reply.
        let kickoff = request
            .custom_message
            .as_ref()
            .and_then(|row| row.pointer("/details/id"))
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(SPAWN_KICKOFF_ID_PREFIX));
        if kickoff {
            // The ready row is typed like the answer rows (the exit capture
            // and the revived context read it the same way) but reports no
            // model call: the readiness label, a zero usage, and no api.
            let (update, message) = Self::answer_rows(
                "",
                "decision",
                "system-1",
                "Decision child ready.",
                pa_types::ai::Usage::default(),
            );
            for event in [update, message] {
                if !emit(event) {
                    emit(cancelled());
                    return;
                }
            }
            // The ready answer is also the child's first tagged reply: the
            // parent's registry records it (`replied_since_task`), so the
            // spawn's settle watcher withholds the no-reply exit notice —
            // one less parent run — and the caller learns the child serves.
            // The reply is best-effort: a child whose parent edge is not
            // known yet still readies (the notice is the fallback).
            let reply = self.send_reply(
                &json!({
                    "type": "decision_api.decision",
                    "seq": Value::Null,
                    "note": "Decision child ready.",
                }),
                aborted,
            );
            if aborted() {
                emit(cancelled());
                return;
            }
            let _ = reply;
            emit(EngineEvent::Done(Ok(())));
            return;
        }
        // The reply echoes whatever `seq` the request carried — including
        // none: a request without a `seq` still answers (a silent Done(Err)
        // here would leave the parent waiting on a turn that already
        // ended).
        let (seq, result) = match serde_json::from_str::<Value>(Self::raw_message(&request)) {
            Ok(mut body) => {
                let seq = body
                    .as_object_mut()
                    .and_then(|body| body.remove("seq"))
                    .unwrap_or(Value::Null);
                (seq, self.serve(body, &cancel))
            }
            Err(error) => (
                Value::Null,
                Err(anyhow!(
                    "a decision request must be a JSON object; the message is not JSON ({error})"
                )),
            ),
        };
        // Cancellation can arrive while the bounded decision call runs:
        // either reply - the decision or its failure - must not reach the
        // parent once the turn is cancelled.
        if aborted() {
            emit(cancelled());
            return;
        }
        match result {
            Ok((resolved, served)) => {
                // The answer rows persist first: the completed decision and
                // its usage reach the transcript and the cost ledger even
                // when the reply delivery below fails, and the rows exist
                // before the run's closing frames either way.
                let text = json!({ "action": served.action }).to_string();
                let (provider, model) = resolved.provider_and_id();
                let (update, final_message) =
                    Self::answer_rows(resolved.api(), provider, model, &text, served.usage);
                for event in [update, final_message.clone()] {
                    if !emit(event) {
                        emit(cancelled());
                        return;
                    }
                }
                let EngineEvent::AssistantMessage(turn_message) = final_message else {
                    unreachable!("answer_rows returns an AssistantMessage");
                };
                let reply = json!({
                    "type": "decision_api.decision",
                    "seq": seq,
                    "model": resolved.label(),
                    "decision": served.action,
                });
                if let Err(error) = self.send_reply(&reply, aborted) {
                    if aborted() {
                        emit(cancelled());
                        return;
                    }
                    emit(EngineEvent::Done(Err(format!(
                        "the decision reply could not reach the parent: {error:#}"
                    ))));
                    return;
                }
                if !emit(EngineEvent::TurnEnd {
                    message: turn_message.clone(),
                    tool_results: Vec::new(),
                }) {
                    emit(cancelled());
                    return;
                }
                // Main's aborted marker: the decision engine's own runs
                // complete normally (a cancel emits the cancelled error
                // before this frame, never an aborted agent_end).
                if !emit(EngineEvent::AgentEnd {
                    messages: vec![accepted_row, turn_message],
                    aborted: false,
                }) {
                    emit(cancelled());
                    return;
                }
                emit(EngineEvent::Done(Ok(())));
            }
            Err(error) => {
                // A refused reply is a completed call: its row persists with
                // the call's usage, so the transcript keeps the model's reply
                // and the cost ledger bills the call.
                if let (Some(refused), Ok(resolved)) = (
                    error.downcast_ref::<RefusedDecisionReply>(),
                    self.model.as_ref(),
                ) {
                    let (provider, model) = resolved.provider_and_id();
                    let (update, message) = Self::answer_rows(
                        resolved.api(),
                        provider,
                        model,
                        &refused.reply,
                        refused.usage,
                    );
                    for event in [update, message] {
                        if !emit(event) {
                            emit(cancelled());
                            return;
                        }
                    }
                }
                // The failure reaches the parent as a tagged error reply, so
                // its await fails fast instead of timing out.
                let reply = json!({
                    "type": "decision_api.decision",
                    "seq": seq,
                    "error": format!("{error:#}"),
                });
                let delivery = self.send_reply(&reply, aborted);
                if aborted() {
                    emit(cancelled());
                    return;
                }
                let failure = match delivery {
                    Ok(()) => format!("the decision failed: {error:#}"),
                    Err(delivery) => format!(
                        "the decision failed: {error:#}; its error reply could not reach the \
                         parent: {delivery:#}"
                    ),
                };
                emit(EngineEvent::Done(Err(failure)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `rlm.spawn` task delivery: the agent-message row the spawn
    /// host builds, keyed by the spawn kickoff id.
    fn kickoff_request(task: &str) -> PromptRequest {
        let row = pa_core::session_engine::agent_messaging::create_agent_session_message_row(
            &pa_core::session_engine::agent_messaging::AgentSessionMessageRowPayload {
                id: &format!("{SPAWN_KICKOFF_ID_PREFIX}decision-child"),
                prompt: &format!("[task from parent]\n\n{task}"),
                message: task,
                from: &json!({ "activeSessionId": "parent-live-1" }),
                from_relationship: Some(AgentFamilyRelationship::Parent),
                target: None,
                timestamp: 0,
            },
        );
        PromptRequest {
            message: format!("[task from parent]\n\n{task}"),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: Some(row),
            batch: Vec::new(),
        }
    }

    fn engine(dir: &std::path::Path) -> DecisionEngine {
        let link = Arc::new(crate::supervisor_link::SupervisorLink::new(
            std::path::PathBuf::new(),
        ));
        DecisionEngine::new(
            dir,
            dir,
            link,
            "decision-child".to_string(),
            "token".to_string(),
        )
    }

    /// The cancellation recheck, pinned: the decision call is bounded,
    /// so `run_prompt` regains control when it returns and must recheck
    /// `aborted()` before either reply reaches the parent.
    #[test]
    fn a_cancellation_during_the_decision_call_sends_no_reply() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let body = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        // Cancellation arrives while the decision call runs: the check
        // before the call passes, the flag flips for every later one.
        let checks = std::cell::Cell::new(0u32);
        let aborted = || {
            let seen = checks.get();
            checks.set(seen + 1);
            seen > 0
        };
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(0, request, &aborted, &mut |event| {
            events.push(event);
            true
        });
        // The cancelled turn settles cancelled — not with the decision's
        // failure, which the unconfigured fixture dir makes deterministic.
        assert_eq!(
            events.last(),
            Some(&EngineEvent::Done(Err("prompt cancelled".to_string()))),
            "the cancelled turn must not settle with a decision outcome: {events:?}"
        );
    }

    /// The reply cancellation window, pinned: a cancel that lands after the
    /// last `run_prompt` check — inside the reply's transport lookup — must
    /// stop the send before the supervisor fallback posts it. The stub flips
    /// the worker's abort flag when the ticket probe arrives; the refused
    /// ticket would otherwise route the reply to `send_message`.
    #[cfg(unix)]
    #[test]
    fn a_cancellation_during_the_reply_lookup_sends_no_reply() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other decision tests' response queues.
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-reply-cancel".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "left"}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-reply-cancel", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        let socket = dir.path().join("supervisor.sock");
        let abort = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let commands = stub_supervisor_cancelling_on_ticket(&socket, Arc::clone(&abort));
        let engine = DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        );
        engine.set_session_summary(json!({ "parentActiveSessionId": "parent-live-1" }));
        let body = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            request,
            &|| abort.load(std::sync::atomic::Ordering::SeqCst),
            &mut |event| {
                events.push(event);
                true
            },
        );
        // The decision call itself ran: the cancel lands in the reply's
        // transport lookup, past the last pre-reply check.
        assert_eq!(
            events.last(),
            Some(&EngineEvent::Done(Err("prompt cancelled".to_string()))),
            "a cancel during the reply lookup settles the turn cancelled: {events:?}"
        );
        let commands = commands.lock().unwrap().clone();
        assert!(
            commands
                .iter()
                .any(|command| command["type"].as_str() == Some("get_worker_peer_transport")),
            "the reply must start its transport lookup: {commands:?}"
        );
        assert!(
            commands
                .iter()
                .all(|command| command["type"].as_str() != Some("send_message")),
            "a cancelled decision must not fall back to a reply send: {commands:?}"
        );
    }

    /// The abort interrupt, pinned: the bounded decision call races the
    /// turn's cancellation, so an abort landing mid-call frees the turn
    /// without waiting out the decision bound, cancels the in-flight
    /// provider request, and settles cancelled with no reply to the
    /// parent.
    #[cfg(unix)]
    #[test]
    fn an_abort_mid_call_interrupts_the_bounded_serve() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other decision tests' response queues.
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-abort".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                // The paced answer holds the stream far past the decision
                // bound, the way a slow completion does.
                tokens_per_second: Some(0.1),
                ..Default::default()
            });
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-abort", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        let socket = dir.path().join("supervisor.sock");
        let commands = stub_supervisor(&socket, 2);
        let engine = Arc::new(DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        ));
        engine.set_session_summary(json!({ "parentActiveSessionId": "parent-live-1" }));
        // The abort lands from inside the provider request, the way the
        // worker aborts: the flag first, then the engine hook. The factory
        // runs once the call has begun — past the pre-call check — while
        // the pacing holds the answer past every bound.
        let flip = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let captured = Arc::new(std::sync::Mutex::new(
            Option::<tokio_util::sync::CancellationToken>::None,
        ));
        let flip_writer = Arc::clone(&flip);
        let capture_writer = Arc::clone(&captured);
        let abort_engine = Arc::clone(&engine);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |_context: &pa_ai::types::Context,
                      options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    *capture_writer.lock().unwrap() =
                        options.and_then(|options| options.signal.clone());
                    flip_writer.store(true, std::sync::atomic::Ordering::SeqCst);
                    abort_engine.abort_in_flight_turn();
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        r#"{"action": {"choice": "left"}}"#,
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ),
        )]);
        let body = json!({
            "seq": 7,
            "state": {},
            "questions": {"action": {
                "type": "choice", "criteria": { "left": "go left", "right": "go right" }
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        let started = std::time::Instant::now();
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            request,
            &|| flip.load(std::sync::atomic::Ordering::SeqCst),
            &mut |event| {
                events.push(event);
                true
            },
        );
        let elapsed = started.elapsed();
        // The interrupt beats the 30 s decision bound by orders of
        // magnitude; a check-after-serve alone holds the turn for the
        // whole call.
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "an abort mid-call must interrupt the bounded serve, held {elapsed:?}"
        );
        assert_eq!(
            events.last(),
            Some(&EngineEvent::Done(Err("prompt cancelled".to_string()))),
            "the interrupted turn settles cancelled: {events:?}"
        );
        assert!(
            commands.lock().unwrap().is_empty(),
            "a cancelled decision must not reply to the parent"
        );
        // The interrupted call cancels its provider request instead of
        // running on detached: the token the factory captured flipped.
        let signal = captured
            .lock()
            .unwrap()
            .clone()
            .expect("the decision request carries a cancellation token");
        assert!(
            signal.is_cancelled(),
            "the interrupt must cancel the in-flight provider request"
        );
    }

    /// The spawn prompt's path, pinned: the spawn task never reaches the
    /// decision call — the turn settles with the ready answer alone, and
    /// the engine keeps no prompt state to store it in.
    #[test]
    fn a_spawn_prompt_settles_with_the_ready_answer() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let request =
            kickoff_request("You are the decision child: answer requests with the action tag.");
        let aborted = || false;
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(0, request, &aborted, &mut |event| {
            events.push(event);
            true
        });
        let settled = events.pop();
        assert_eq!(
            settled,
            Some(EngineEvent::Done(Ok(()))),
            "the spawn prompt must settle ready, not with a decision outcome: {events:?}"
        );
        // The ready answer is the only assistant content on the turn, and
        // it rides a typed assistant row: the deserialization is the exit
        // capture's read (a row that does not parse loses the text).
        let answered: Vec<String> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AssistantMessage(row) => {
                    let message: pa_types::ai::AssistantMessage =
                        serde_json::from_value(row.clone()).ok()?;
                    let text = message
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            pa_types::ai::AssistantContentBlock::Text(text) => {
                                Some(text.text.clone())
                            }
                            _ => None,
                        })
                        .collect::<String>();
                    (!text.is_empty()).then_some(text)
                }
                _ => None,
            })
            .collect();
        assert_eq!(answered, ["Decision child ready.".to_string()]);
    }

    /// A stub supervisor for the reply-cancellation test: it flips the
    /// worker's abort flag when the reply's transport probe arrives, then
    /// refuses the ticket. The refusal would route the reply to the
    /// supervisor fallback unless the send rechecks the cancel. Every
    /// later connection is recorded, so a fallback send is visible.
    #[cfg(unix)]
    fn stub_supervisor_cancelling_on_ticket(
        socket: &std::path::Path,
        abort: Arc<std::sync::atomic::AtomicBool>,
    ) -> Arc<Mutex<Vec<Value>>> {
        let commands: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let stub_commands = Arc::clone(&commands);
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    return;
                };
                let Ok(mut writer) = stream.try_clone() else {
                    return;
                };
                let mut reader = std::io::BufReader::new(stream);
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .unwrap();
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    return;
                }
                let envelope: Value = match serde_json::from_str(line.trim()) {
                    Ok(envelope) => envelope,
                    Err(_) => return,
                };
                let id = envelope["id"].as_str().unwrap_or_default().to_string();
                let command = envelope["command"].clone();
                stub_commands.lock().unwrap().push(command.clone());
                let response = match command["type"].as_str().unwrap_or_default() {
                    "get_worker_peer_transport" => {
                        // The cancel lands inside the reply send, after the
                        // decision call and its last pre-reply check.
                        abort.store(true, std::sync::atomic::Ordering::SeqCst);
                        json!({
                            "id": id, "command": "get_worker_peer_transport",
                            "success": false, "error": "no direct transport",
                        })
                    }
                    other => json!({
                        "id": id, "command": other, "success": true,
                        "data": {
                            "id": "m1",
                            "target": { "activeSessionId": command["targetActiveSessionId"] },
                            "deliveryStatus": "delivered",
                        },
                    }),
                };
                writer
                    .write_all(format!("{response}\n").as_bytes())
                    .unwrap();
            }
        });
        commands
    }

    /// A stub supervisor over `socket`: it answers each command on its own
    /// connection — the direct-transport probe fails, the
    /// supervisor-routed send delivers — and records every command it
    /// answers.
    #[cfg(unix)]
    fn stub_supervisor(socket: &std::path::Path, connections: usize) -> Arc<Mutex<Vec<Value>>> {
        let commands: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let stub_commands = Arc::clone(&commands);
        // Bind before returning so the engine's first connect cannot race
        // the listener setup (a lost race fails the connect with ENOENT).
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            for _ in 0..connections {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let Ok(mut writer) = stream.try_clone() else {
                    return;
                };
                let mut reader = std::io::BufReader::new(stream);
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .unwrap();
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    return;
                }
                let envelope: Value = match serde_json::from_str(line.trim()) {
                    Ok(envelope) => envelope,
                    Err(_) => return,
                };
                let id = envelope["id"].as_str().unwrap_or_default().to_string();
                let command = envelope["command"].clone();
                stub_commands.lock().unwrap().push(command.clone());
                // No direct transport: the send falls back to the
                // supervisor route, which answers with a receipt.
                let response = match command["type"].as_str().unwrap_or_default() {
                    "get_worker_peer_transport" => json!({
                        "id": id, "command": "get_worker_peer_transport",
                        "success": false, "error": "no direct transport",
                    }),
                    other => json!({
                        "id": id, "command": other, "success": true,
                        "data": {
                            "id": "m1",
                            "target": { "activeSessionId": command["targetActiveSessionId"] },
                            "deliveryStatus": "delivered",
                        },
                    }),
                };
                writer
                    .write_all(format!("{response}\n").as_bytes())
                    .unwrap();
            }
        });
        commands
    }

    /// The intake's reply contract, pinned: the kickoff's ready answer
    /// reaches the parent as a tagged reply (so `replied_since_task` is
    /// set and the spawn's settle watcher withholds the no-reply exit
    /// notice), and every decision request answers — a body without a
    /// `seq` replies with `seq: null` instead of ending the turn
    /// silently, and whatever `seq` value the request carried echoes
    /// back verbatim.
    #[cfg(unix)]
    #[test]
    fn the_kickoff_replies_ready_and_every_request_answers() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-intake".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "left"}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-intake", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        let socket = dir.path().join("supervisor.sock");
        // The kickoff's ready reply, the request's decision reply, and the
        // malformed request's error reply: one transport probe leg and one
        // send leg each.
        let commands = stub_supervisor(&socket, 6);
        let engine = DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        );
        engine.set_session_summary(json!({ "parentActiveSessionId": "parent-live-1" }));
        let run = |message: String| {
            let request = PromptRequest {
                message,
                images: Vec::new(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
                batch: Vec::new(),
            };
            let mut events: Vec<EngineEvent> = Vec::new();
            engine.run_prompt(0, request, &|| false, &mut |event| {
                events.push(event);
                true
            });
            events
        };
        // The kickoff (the spawn task) readies the child and sends the
        // ready answer as its first tagged reply.
        let mut kickoff = Vec::new();
        engine.run_prompt(
            0,
            kickoff_request("You are System 1, the decision child."),
            &|| false,
            &mut |event| {
                kickoff.push(event);
                true
            },
        );
        assert!(
            matches!(kickoff.last(), Some(EngineEvent::Done(Ok(())))),
            "the kickoff must settle ready: {kickoff:?}"
        );
        let replies = |kind: &str| {
            commands
                .lock()
                .unwrap()
                .iter()
                .filter(|command| {
                    command["type"].as_str() == Some("send_message")
                        && command["message"]
                            .as_str()
                            .is_some_and(|message| message.contains(kind))
                })
                .count()
        };
        assert_eq!(replies("decision_api.decision"), 1);
        assert_eq!(replies("Decision child ready."), 1);
        // A request without a seq still answers: the reply echoes null.
        let seqless = run(json!({
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        })
        .to_string());
        assert!(
            matches!(seqless.last(), Some(EngineEvent::Done(Ok(())))),
            "a request without a seq must still settle its turn: {seqless:?}"
        );
        let sent: Vec<Value> = commands
            .lock()
            .unwrap()
            .iter()
            .filter(|command| command["type"].as_str() == Some("send_message"))
            .filter_map(|command| {
                serde_json::from_str(command["message"].as_str().unwrap_or_default()).ok()
            })
            .collect();
        assert_eq!(sent.len(), 2, "the kickoff and the request both replied");
        assert_eq!(
            sent[0]["seq"],
            Value::Null,
            "the kickoff's reply carries a null seq"
        );
        assert_eq!(
            sent[0]["note"], "Decision child ready.",
            "the kickoff's reply is the ready answer: {sent:?}"
        );
        assert_eq!(
            sent[1]["seq"],
            Value::Null,
            "a request without a seq answers with a null seq: {sent:?}"
        );
        assert_eq!(
            sent[1]["decision"]["choice"], "left",
            "the seqless request's decision still answers: {sent:?}"
        );
        // A request that is not JSON (a Python dict's repr) answers with an
        // error reply instead of readying the child again.
        let malformed = run("{'state': {}, 'questions': {}}".to_string());
        assert!(
            matches!(malformed.last(), Some(EngineEvent::Done(Err(_)))),
            "a malformed request must fail its turn: {malformed:?}"
        );
        let sent: Vec<Value> = commands
            .lock()
            .unwrap()
            .iter()
            .filter(|command| command["type"].as_str() == Some("send_message"))
            .filter_map(|command| {
                serde_json::from_str(command["message"].as_str().unwrap_or_default()).ok()
            })
            .collect();
        assert_eq!(sent.len(), 3, "the malformed request replied: {sent:?}");
        assert!(
            sent[2]["error"]
                .as_str()
                .is_some_and(|error| error.contains("not JSON")),
            "the malformed request's reply names the error: {sent:?}"
        );
    }

    /// The reply route, pinned: a reply routes to the parent id the
    /// worker already knows — the pushed summary's `parentActiveSessionId`
    /// — and never fetches the family roster to find it; a child without
    /// a parent edge fails fast without touching the link. The reply also
    /// rides the follow-up lane: a decision never steers (interrupts) the
    /// parent's running turn.
    #[cfg(unix)]
    #[test]
    fn a_reply_targets_the_known_parent_id_never_the_roster() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("supervisor.sock");
        let commands = stub_supervisor(&socket, 2);
        let engine = DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        );
        // No pushed summary: no known parent id, so the reply fails fast —
        // the roster fetch the old path made would dial the link first.
        let never_aborted = || false;
        let error = engine
            .send_reply(
                &json!({"type": "decision_api.decision", "seq": 1}),
                &never_aborted,
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("no parent edge"),
            "a missing parent edge must fail on the known id: {error:#}"
        );
        assert!(
            commands.lock().unwrap().is_empty(),
            "no command may reach the supervisor before the parent id is known"
        );
        engine.set_session_summary(json!({
            "parentActiveSessionId": "parent-live-1",
            "parentSessionId": "parent-persisted-1",
        }));
        engine
            .send_reply(
                &json!({"type": "decision_api.decision", "seq": 2}),
                &never_aborted,
            )
            .expect("the reply must deliver through the stub supervisor");
        let captured = commands.lock().unwrap().clone();
        for command in &captured {
            assert_eq!(
                command["targetActiveSessionId"], "parent-live-1",
                "every leg of the reply must target the worker's known parent id"
            );
        }
        let sent = captured
            .iter()
            .find(|command| command["type"].as_str() == Some("send_message"))
            .expect("the reply reaches the supervisor-routed send");
        assert_eq!(
            sent["deliveryMode"], "follow_up",
            "a decision reply must queue behind the parent's work, never steer it"
        );
    }

    /// The cost-ledger contract, pinned: a served decision's answer row
    /// carries the completion's usage, so the child-usage ledger bills the
    /// decision — a row without usage reads as a free call in the parent's
    /// totals and /context.
    #[cfg(unix)]
    #[test]
    fn a_served_decision_bills_in_the_cost_ledger() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other tests' response queues.
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-ledger".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "left"}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-ledger", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        let socket = dir.path().join("supervisor.sock");
        let _commands = stub_supervisor(&socket, 2);
        let engine = DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        );
        engine.set_session_summary(json!({ "parentActiveSessionId": "parent-live-1" }));
        let body = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice",
                "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(0, request, &|| false, &mut |event| {
            events.push(event);
            true
        });
        // The reply delivered through the stub supervisor, so the turn
        // settles done and its answer row exists.
        assert!(
            matches!(events.last(), Some(EngineEvent::Done(Ok(())))),
            "the served decision must settle: {events:?}"
        );
        let answer = events
            .iter()
            .rev()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => Some(message),
                _ => None,
            })
            .expect("a served decision emits its answer row");
        // The row is a typed assistant message (one text block, the
        // resolved model's api, a real usage, `StopReason::Stop`): the
        // round trip is the read every later consumer makes — the revived
        // child's context and the exit capture's `last_assistant_text_from_file`.
        let typed: pa_types::ai::AssistantMessage = serde_json::from_value(answer.clone())
            .expect("the answer row must deserialize as a typed assistant message");
        assert_eq!(typed.stop_reason, pa_types::ai::StopReason::Stop);
        assert!(!typed.api.is_empty(), "the row carries the model's api");
        let usage = &answer["usage"];
        assert!(
            usage["input"].as_u64().is_some_and(|input| input > 0),
            "the answer row must carry the completion's usage: {answer}"
        );
        assert!(
            usage["output"].as_u64().is_some_and(|output| output > 0),
            "the answer row must carry the completion's usage: {answer}"
        );
        // The run's closing frame carries the whole message set: the
        // accepted request row and the assistant decision row.
        let agent_end = events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AgentEnd { messages, .. } => Some(messages.clone()),
                _ => None,
            })
            .expect("a served decision emits its agent_end frame");
        assert_eq!(
            agent_end
                .iter()
                .map(|message| message["role"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["user", "assistant"],
            "the agent_end frame must carry the accepted row and the decision row: {agent_end:?}"
        );
        // The row bills: stored the way the turn loop persists message
        // rows, the child-usage ledger attributes the decision's cost
        // instead of skipping the row.
        let entry = crate::session_store::SessionEntry {
            type_: "message".to_string(),
            id: "d1".to_string(),
            parent_id: None,
            timestamp: "2026-10-27T00:00:00.000Z".to_string(),
            fields: json!({ "message": answer }),
        };
        let (batches, _) =
            crate::rlm_child_usage::child_usage_batches(std::slice::from_ref(&entry), 0);
        assert_eq!(batches.len(), 1, "a decision must bill in the cost ledger");
        assert_eq!(
            batches[0].1.input,
            usage["input"].as_u64().unwrap(),
            "the ledger must bill the completion's usage"
        );
    }

    /// The delivery-failure contract, pinned: a completed decision whose
    /// reply cannot reach the parent still persists its answer rows and
    /// usage (the transcript and the cost ledger keep the decision), and
    /// the turn settles with the delivery error instead of dropping it.
    /// The engine without a pushed session summary fails the send fast:
    /// no known parent id.
    #[test]
    fn a_failed_reply_still_persists_the_decision_rows() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other decision tests' response queues.
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-undelivered".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "left"}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-undelivered", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        // No set_session_summary: the reply fails fast on the missing
        // parent edge, the only deterministic delivery failure.
        let engine = engine(dir.path());
        let body = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(0, request, &|| false, &mut |event| {
            events.push(event);
            true
        });
        assert!(
            matches!(events.last(), Some(EngineEvent::Done(Err(error)))
                if error.starts_with("the decision reply could not reach the parent")),
            "the undelivered decision must settle with the delivery error: {events:?}"
        );
        let answer = events
            .iter()
            .rev()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => Some(message),
                _ => None,
            })
            .expect("a failed reply still persists the decision's answer row");
        assert!(
            answer["usage"]["input"]
                .as_u64()
                .is_some_and(|input| input > 0),
            "the failed reply still persists the decision's usage: {answer}"
        );
        let typed: pa_types::ai::AssistantMessage = serde_json::from_value(answer.clone())
            .expect("the persisted row must deserialize as a typed assistant message");
        assert_eq!(typed.stop_reason, pa_types::ai::StopReason::Stop);
    }

    /// The refused-reply bill, pinned: a completed call whose reply the
    /// answer validation refuses still spent its tokens, so its row
    /// persists with the call's usage and the child-usage ledger bills
    /// it, while the turn settles with the refusal.
    #[test]
    fn a_refused_reply_still_bills_the_decision_call() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other decision tests' response queues.
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-refused".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    ..Default::default()
                }]),
                ..Default::default()
            });
        // The reply chooses an action the request does not offer.
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "jump"}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionModel": "decision-model" }).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-refused", "models": [
                    { "id": "decision-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        let engine = engine(dir.path());
        let body = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        let request = PromptRequest {
            message: body.to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(0, request, &|| false, &mut |event| {
            events.push(event);
            true
        });
        // The fixture engine has no parent edge, so the error reply cannot
        // be delivered: the turn's error says so next to the refusal.
        assert!(
            matches!(events.last(), Some(EngineEvent::Done(Err(error)))
                if error.contains("not one of the requested actions")
                    && error.contains("its error reply could not reach the parent")),
            "the refused reply must settle with the refusal: {events:?}"
        );
        let row = events
            .iter()
            .rev()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => Some(message),
                _ => None,
            })
            .expect("a refused reply still persists the call's row");
        let entry = crate::session_store::SessionEntry {
            type_: "message".to_string(),
            id: "d1".to_string(),
            parent_id: None,
            timestamp: "2026-11-19T00:00:00.000Z".to_string(),
            fields: json!({ "message": row }),
        };
        let (batches, _) =
            crate::rlm_child_usage::child_usage_batches(std::slice::from_ref(&entry), 0);
        assert_eq!(
            batches.len(),
            1,
            "a refused call must bill in the cost ledger"
        );
        assert!(
            batches[0].1.input > 0 && batches[0].1.output > 0,
            "the ledger must bill the refused call's usage: {row}"
        );
    }
}
