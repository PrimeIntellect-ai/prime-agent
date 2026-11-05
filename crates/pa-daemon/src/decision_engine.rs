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
    AgentFamilyRelationship, AgentMessageController, AgentMessageSendInput,
};
use pa_core::session_engine::decision_api::ResolvedDecisionModel;
use pa_core::session_engine::side_question::SideQuestionSink;

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
        // The decision model resolves once here, at engine start: the
        // hot path of the control loop never re-reads settings or
        // rebuilds the registry; a failed resolution keeps its
        // actionable refusal for every decision.
        let model = pa_core::session_engine::decision_api::resolve_decision_model(cwd, agent_dir);
        Self {
            model,
            own_summary,
            sender,
            runtime: AsyncSafeRuntime::new_current_thread().expect("decision engine runtime"),
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
    /// follow-up lane: it lands as a queued row the parent reads at its
    /// next wake instead of steering (interrupting) its running turn.
    fn send_reply(&self, message: &Value) -> anyhow::Result<()> {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        // Only the parent edge names the target; the identity's own id is
        // unused here.
        let target = FamilyIdentity::from_summary(summary.as_ref(), "")
            .parent_active_session_id
            .ok_or_else(|| anyhow!("the decision child has no parent id in its session summary"))?;
        let sender = Arc::clone(&self.sender);
        let message = message.to_string();
        self.runtime.block_on(async move {
            sender
                .send_agent_message(AgentMessageSendInput {
                    target,
                    message,
                    receiver_role: Some(AgentFamilyRelationship::Parent),
                    delivery_mode: Some("follow_up"),
                })
                .await
                .map(|_| ())
        })
    }

    /// Serve one decision request message: run the shared decision path
    /// (one provider completion) with the engine-start resolution. The
    /// request's `state` carries the parent's guidance verbatim — the
    /// engine keeps no channel of its own.
    fn serve(&self, request: Value, aborted: &dyn Fn() -> bool) -> anyhow::Result<Value> {
        let resolved = match self.model.as_ref() {
            Ok(resolved) => resolved,
            Err(refusal) => return Err(anyhow!(refusal.clone())),
        };
        self.runtime.block_on(async {
            // The worker's cancel flag is a plain sync probe with no async
            // wake, so the bounded decision call races a short-interval
            // poll of it: an abort lands mid-call instead of after the
            // whole 30 s (the retry sleep's abort-aware wait).
            tokio::select! {
                result = pa_core::session_engine::decision_api::serve_decision_request(
                    request,
                    resolved,
                ) => result,
                () = async {
                    while !aborted() {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                } => Err(anyhow!("the decision call was aborted")),
            }
        })
    }

    /// The transcript row pair for an answer: the assistant update and the
    /// final message. Both rows are typed assistant messages — one text
    /// block, the resolved model's `api`, a real usage, `StopReason::Stop`
    /// — because `turn.rs` persists them verbatim and every later reader
    /// deserializes: the reopened or revived child's context builder and
    /// the exit capture's `last_assistant_text_from_file` skip a row that
    /// does not parse. The decision's usage rides both rows — the final
    /// message is the row the cost ledger bills, and a row without usage
    /// reads as a free call.
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
        // A decision request carries "questions"; anything else is the
        // spawn prompt — the engine keeps no prompt state, so it settles
        // with the ready answer below.
        let parsed: Option<Value> = serde_json::from_str(Self::raw_message(&request)).ok();
        let is_request = parsed
            .as_ref()
            .is_some_and(|value| value.get("questions").is_some());
        if !is_request {
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
            let _ = self.send_reply(&json!({
                "type": "decision_api.decision",
                "seq": Value::Null,
                "note": "Decision child ready.",
            }));
            emit(EngineEvent::Done(Ok(())));
            return;
        }
        let mut body = parsed.expect("checked above");
        // The reply echoes whatever `seq` the request carried — including
        // none: a request without a `seq` still answers (a silent Done(Err)
        // here would leave the parent waiting on a turn that already
        // ended), so the branch that refused it is gone.
        let seq = body
            .as_object_mut()
            .and_then(|body| body.remove("seq"))
            .unwrap_or(Value::Null);
        let result = self.serve(body, aborted);
        // Cancellation can arrive while the bounded decision call runs:
        // either reply - the decision or its failure - must not reach the
        // parent once the turn is cancelled.
        if aborted() {
            emit(cancelled());
            return;
        }
        match result {
            Ok(envelope) => {
                // The answer rows persist first: the completed decision and
                // its usage reach the transcript and the cost ledger even
                // when the reply delivery below fails, and the rows exist
                // before the run's closing frames either way.
                let text = envelope["answers"].to_string();
                let usage =
                    serde_json::from_value::<pa_types::ai::Usage>(envelope["usage"].clone())
                        .unwrap_or_default();
                // A served decision implies the engine-start resolution;
                // its identity labels the transcript rows.
                let Some(resolved) = self.model.as_ref().ok() else {
                    unreachable!("a served decision implies the engine resolved its model");
                };
                let (provider, model) = resolved.provider_and_id();
                let (update, final_message) =
                    Self::answer_rows(resolved.api(), provider, model, &text, usage);
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
                    "model": envelope["model"].clone(),
                    "decision": envelope["answers"]["action"].clone(),
                });
                if let Err(error) = self.send_reply(&reply) {
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
                if !emit(EngineEvent::AgentEnd {
                    messages: vec![accepted_row, turn_message],
                }) {
                    emit(cancelled());
                    return;
                }
                emit(EngineEvent::Done(Ok(())));
            }
            Err(error) => {
                // The failure reaches the parent as a tagged error reply, so
                // its await fails fast instead of timing out.
                let reply = json!({
                    "type": "decision_api.decision",
                    "seq": seq,
                    "error": format!("{error:#}"),
                });
                let _ = self.send_reply(&reply);
                emit(EngineEvent::Done(Err(format!(
                    "the decision failed: {error:#}"
                ))));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// The abort interrupt, pinned: the bounded decision call races the
    /// worker's cancel flag, so an abort landing mid-call frees the turn
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
        let engine = DecisionEngine::new(
            dir.path(),
            dir.path(),
            Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            "decision-child".to_string(),
            "token".to_string(),
        );
        engine.set_session_summary(json!({ "parentActiveSessionId": "parent-live-1" }));
        // The abort flips from inside the provider request: the factory
        // runs once the call has begun — past the pre-call check — while
        // the pacing holds the answer past every bound.
        let flip = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let captured = Arc::new(std::sync::Mutex::new(
            Option::<tokio_util::sync::CancellationToken>::None,
        ));
        let flip_writer = Arc::clone(&flip);
        let capture_writer = Arc::clone(&captured);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |_context: &pa_ai::types::Context,
                      options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    *capture_writer.lock().unwrap() =
                        options.and_then(|options| options.signal.clone());
                    flip_writer.store(true, std::sync::atomic::Ordering::SeqCst);
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

    /// The spawn prompt's path, pinned: a message that is not a decision
    /// request never reaches the decision call — the turn settles with
    /// the ready answer alone, and the engine keeps no prompt state to
    /// store it in.
    #[test]
    fn a_spawn_prompt_settles_with_the_ready_answer() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let request = PromptRequest {
            message: "You are the decision child: answer requests with the action tag.".to_string(),
            images: Vec::new(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
            batch: Vec::new(),
        };
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
        // The kickoff's ready reply and the request's decision reply: one
        // transport probe leg and one send leg each.
        let commands = stub_supervisor(&socket, 4);
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
        // The kickoff (a non-request message) readies the child and sends
        // the ready answer as its first tagged reply.
        let kickoff = run("You are System 1, the decision child.".to_string());
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
        let error = engine
            .send_reply(&json!({"type": "decision_api.decision", "seq": 1}))
            .unwrap_err();
        assert!(
            error.to_string().contains("no parent id"),
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
            .send_reply(&json!({"type": "decision_api.decision", "seq": 2}))
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
                EngineEvent::AgentEnd { messages } => Some(messages.clone()),
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
}
