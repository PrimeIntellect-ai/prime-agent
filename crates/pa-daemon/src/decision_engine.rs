//! The Decision API child engine (`rlm.spawn kind="decision"`): a spawned
//! session whose every message is one decision request, answered by a
//! single decision model call — the registry-resolved
//! `decisionApi.systemOneModel` model (resolved once at engine start)
//! over the shared decision path (`pa_core::session_engine::decision_api`).
//! The parent's tagged goal messages route into the engine's goal input
//! (the newest seq wins; an older goal never overwrites a newer one), and
//! each answer returns to the parent as a tagged `decision_api.decision`
//! message.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::anyhow;
use serde_json::{json, Value};

use crate::agent_messaging::LinkAgentMessageController;
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

/// One stored goal: the seq contract lives in the routing seam — a goal with
/// an older seq than the stored one loses.
#[derive(Debug, Clone)]
struct StoredGoal {
    seq: i64,
    goal: Option<String>,
}

impl Default for StoredGoal {
    fn default() -> Self {
        Self {
            seq: i64::MIN,
            goal: None,
        }
    }
}

/// The decision child's engine.
pub struct DecisionEngine {
    /// The decision model resolved once at engine start, or the actionable
    /// refusal every decision answers with.
    model: Result<ResolvedDecisionModel, String>,
    /// The latest goal message; shared with the worker's routing seam.
    goals: Arc<Mutex<StoredGoal>>,
    /// The spawn's protocol prompt (the child's decision instructions).
    protocol: Mutex<Option<String>>,
    /// The tagged-reply sender over the supervisor link.
    sender: Arc<LinkAgentMessageController>,
    /// The sender's identity source: the worker's session summary.
    own_summary: Arc<Mutex<Option<Value>>>,
    /// The engine's own runtime: the decision call and the reply send are
    /// async, `run_prompt` is not.
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
            goals: Arc::new(Mutex::new(StoredGoal::default())),
            protocol: Mutex::new(None),
            sender,
            runtime: AsyncSafeRuntime::new_multi_thread().expect("decision engine runtime"),
        }
    }

    /// The routing seam's goal contract: a `decision_api.goal` message is
    /// consumed without a turn, and a goal with an older-or-equal seq than
    /// the stored one loses — only a newer goal updates the input.
    fn accept_goal(&self, message: &str) -> bool {
        let Ok(goal) = serde_json::from_str::<Value>(message) else {
            return false;
        };
        if goal["type"] != "decision_api.goal" {
            return false;
        }
        let Some(seq) = goal["seq"].as_i64() else {
            // A malformed goal still carries the tag: consume, never a turn.
            return true;
        };
        let goal = goal.get("goal").and_then(Value::as_str).map(str::to_string);
        let mut stored = self.goals.lock().unwrap_or_else(PoisonError::into_inner);
        if seq > stored.seq {
            *stored = StoredGoal { seq, goal };
        }
        true
    }

    /// The latest goal text (the decision call reads it into the state).
    fn latest_goal(&self) -> Option<String> {
        let stored = self.goals.lock().unwrap_or_else(PoisonError::into_inner);
        stored.goal.clone().filter(|goal| !goal.is_empty())
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

    /// Send one tagged reply to the parent through the supervisor link.
    fn send_reply(&self, message: &Value) -> anyhow::Result<()> {
        let sender = Arc::clone(&self.sender);
        let message = message.to_string();
        self.runtime.block_on(async move {
            let family = sender.family().await?;
            let parent = family
                .into_iter()
                .find(|member| member.relationship == AgentFamilyRelationship::Parent)
                .ok_or_else(|| anyhow!("the decision child has no parent in its family roster"))?;
            sender
                .send_agent_message(AgentMessageSendInput {
                    target: parent.id,
                    message,
                    receiver_role: Some(AgentFamilyRelationship::Parent),
                })
                .await
                .map(|_| ())
        })
    }

    /// Inject the parent's goal into the request's state: the state is the
    /// only goal channel the model sees, so every valid state shape must
    /// carry it. A non-object state (any JSON the request's `"state"` field
    /// holds — the shared path accepts it verbatim) is wrapped under an
    /// `"observation"` key, the shape a decision state is documented in;
    /// an object state keeps its shape and only gains a `goal` key.
    fn inject_goal(request: &mut Value, goal: &str) {
        if let Some(state) = request.get_mut("state") {
            if !state.is_object() {
                *state = json!({ "observation": state.clone() });
            }
            if let Some(map) = state.as_object_mut() {
                map.insert("goal".to_string(), json!(goal));
            }
        }
    }

    /// Serve one decision request message: inject the latest goal into the
    /// state, then run the shared decision path (one provider completion)
    /// with the engine-start resolution.
    fn serve(&self, mut request: Value) -> anyhow::Result<Value> {
        if let Some(goal) = self.latest_goal() {
            Self::inject_goal(&mut request, &goal);
        }
        let resolved = match self.model.as_ref() {
            Ok(resolved) => resolved,
            Err(refusal) => return Err(anyhow!(refusal.clone())),
        };
        self.runtime.block_on(
            pa_core::session_engine::decision_api::serve_decision_request(request, resolved),
        )
    }

    /// The transcript row pair for an answer: the assistant update and the
    /// final message.
    fn answer_rows(provider: &str, model: &str, text: &str) -> (EngineEvent, EngineEvent) {
        let now = crate::util::now_ms();
        (
            EngineEvent::AssistantUpdate {
                message: AssistantSnapshot::Wire(json!({
                    "role": "assistant", "content": "",
                    "provider": provider, "model": model,
                    "timestamp": now,
                })),
                stream_event: None,
            },
            EngineEvent::AssistantMessage(json!({
                "role": "assistant", "content": text,
                "provider": provider, "model": model,
                "timestamp": now,
            })),
        )
    }
}

impl SessionEngine for DecisionEngine {
    /// Consume the parent's tagged goal messages: no turn, newest seq
    /// wins. The goal input is parent-authoritative: a sibling's, a
    /// child's, or an unaffiliated sender's goal tags never reach it —
    /// they route as ordinary messages instead.
    fn route_decision_api_event(
        &self,
        relationship: Option<AgentFamilyRelationship>,
        _sender_name: &str,
        message: &str,
    ) -> bool {
        if relationship != Some(AgentFamilyRelationship::Parent) {
            return false;
        }
        self.accept_goal(message)
    }

    /// The worker's live session summary: the sender identity block of the
    /// tagged replies.
    fn set_session_summary(&self, summary: Value) {
        *self
            .own_summary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(summary);
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
        let raw = Self::raw_message(&request).to_string();
        // A decision request carries "questions"; anything else is the
        // spawn's protocol prompt (the child's decision instructions).
        let parsed: Option<Value> = serde_json::from_str(&raw).ok();
        let is_request = parsed
            .as_ref()
            .is_some_and(|value| value.get("questions").is_some());
        if !is_request {
            *self.protocol.lock().unwrap_or_else(PoisonError::into_inner) = Some(raw);
            let (update, message) =
                Self::answer_rows("decision", "system-1", "Decision child ready.");
            for event in [update, message] {
                if !emit(event) {
                    emit(cancelled());
                    return;
                }
            }
            emit(EngineEvent::Done(Ok(())));
            return;
        }
        let mut body = parsed.expect("checked above");
        let Some(seq) = body.get("seq").and_then(Value::as_i64) else {
            emit(EngineEvent::Done(Err(
                "a decision request must carry an integer \"seq\" for its reply".to_string(),
            )));
            return;
        };
        if let Some(body) = body.as_object_mut() {
            body.remove("seq");
        }
        let result = self.serve(body);
        // Cancellation can arrive while the bounded decision call runs:
        // either reply - the decision or its failure - must not reach the
        // parent once the turn is cancelled.
        if aborted() {
            emit(cancelled());
            return;
        }
        match result {
            Ok(envelope) => {
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
                let text = envelope["answers"].to_string();
                // A served decision implies the engine-start resolution;
                // its halves label the transcript rows.
                let Some(resolved) = self.model.as_ref().ok() else {
                    unreachable!("a served decision implies the engine resolved its model");
                };
                let (provider, model) = resolved.provider_and_id();
                let (update, final_message) = Self::answer_rows(provider, model, &text);
                for event in [update, final_message.clone()] {
                    if !emit(event) {
                        emit(cancelled());
                        return;
                    }
                }
                let EngineEvent::AssistantMessage(turn_message) = final_message else {
                    unreachable!("answer_rows returns an AssistantMessage");
                };
                if !emit(EngineEvent::TurnEnd {
                    message: turn_message,
                    tool_results: Vec::new(),
                }) {
                    emit(cancelled());
                    return;
                }
                if !emit(EngineEvent::AgentEnd {
                    messages: vec![accepted_row],
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

    /// The seq contract, pinned: an old goal arriving after a newer one
    /// loses — the routing seam keeps the newest seq.
    #[test]
    fn an_older_goal_never_overwrites_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let goal = |seq: i64, text: &str| {
            json!({"type":"decision_api.goal","seq":seq,"goal":text}).to_string()
        };
        assert!(engine.accept_goal(&goal(3, "first")));
        assert_eq!(engine.latest_goal().as_deref(), Some("first"));
        // An older goal arrives late: it loses, and it still starts no turn.
        assert!(engine.accept_goal(&goal(1, "stale")));
        assert_eq!(engine.latest_goal().as_deref(), Some("first"));
        // A newer goal wins.
        assert!(engine.accept_goal(&goal(4, "second")));
        assert_eq!(engine.latest_goal().as_deref(), Some("second"));
        // A goal without a goal field clears the guidance but consumes the message.
        assert!(engine.accept_goal(&json!({"type":"decision_api.goal","seq":5}).to_string()));
        assert_eq!(engine.latest_goal(), None);
        // Untagged messages are not consumed; neither are the reply tags.
        assert!(!engine.accept_goal("ordinary message"));
        assert!(!engine.accept_goal(&json!({"type":"decision_api.decision","seq":9}).to_string()));
    }

    /// The goal channel, pinned: a non-object state is wrapped so the goal
    /// still reaches the model; a request without a state passes through
    /// with nothing to carry the goal.
    #[test]
    fn a_non_object_state_is_wrapped_so_the_goal_reaches_the_model() {
        let mut request = json!({ "state": "the target moved left" });
        DecisionEngine::inject_goal(&mut request, "follow the target");
        assert_eq!(
            request["state"],
            json!({ "observation": "the target moved left", "goal": "follow the target" })
        );
        // An object state keeps its shape and only gains the goal key.
        let mut request = json!({ "state": { "observation": 1, "note": "hot" } });
        DecisionEngine::inject_goal(&mut request, "follow the target");
        assert_eq!(
            request["state"],
            json!({ "observation": 1, "note": "hot", "goal": "follow the target" })
        );
        // A request without a state is left alone: nothing to carry the goal.
        let mut request = json!({ "questions": { "action": {} } });
        DecisionEngine::inject_goal(&mut request, "follow the target");
        assert_eq!(request, json!({ "questions": { "action": {} } }));
    }

    /// The goal-sender authorization, pinned: only the parent's goal
    /// messages reach the goal input — a sibling's ceiling goal can never
    /// poison the seq against the parent's later goals.
    #[test]
    fn only_the_parent_updates_the_goal_input() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let goal = |seq: i64, text: &str| {
            json!({"type":"decision_api.goal","seq":seq,"goal":text}).to_string()
        };
        // The parent's goal is consumed into the input.
        assert!(engine.route_decision_api_event(
            Some(AgentFamilyRelationship::Parent),
            "parent",
            &goal(2, "follow the target")
        ));
        assert_eq!(engine.latest_goal().as_deref(), Some("follow the target"));
        // Every other sender's goal is rejected — not consumed, so it
        // routes as an ordinary message and starts a visible turn instead.
        for (relationship, sender) in [
            (Some(AgentFamilyRelationship::Sibling), "sibling"),
            (Some(AgentFamilyRelationship::Child), "child"),
            (None, "stranger"),
        ] {
            assert!(
                !engine.route_decision_api_event(
                    relationship,
                    sender,
                    &goal(i64::MAX, "steal the decision")
                ),
                "{sender}'s goal must be rejected"
            );
        }
        assert_eq!(
            engine.latest_goal().as_deref(),
            Some("follow the target"),
            "no rejected sender moved the goal"
        );
        // The parent's later goal still lands after the ceiling attempt.
        assert!(engine.route_decision_api_event(
            Some(AgentFamilyRelationship::Parent),
            "parent",
            &goal(3, "turn left")
        ));
        assert_eq!(engine.latest_goal().as_deref(), Some("turn left"));
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

    /// The engine-start resolution, pinned: the decision model resolves
    /// once when the engine starts, so a settings rewrite mid-session
    /// never re-resolves — later decisions keep serving the start-time
    /// model.
    #[test]
    fn the_decision_model_resolves_once_at_engine_start() {
        // A private api name: the faux provider registry is global, so a
        // shared name would race the other tests' response queues.
        let served: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let served_writer = std::sync::Arc::clone(&served);
        let recording: pa_ai::faux::FauxResponseFactory = std::sync::Arc::new(
            move |_context: &pa_ai::types::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  model: &pa_types::ai::Model| {
                served_writer.lock().unwrap().push(model.id.clone());
                Ok(pa_ai::faux::faux_assistant_text_message(
                    r#"{"action": {"choice": "left"}}"#,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        );
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision-engine".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![
                    pa_ai::faux::FauxModelDefinition {
                        id: "first-model".to_string(),
                        input: Some(vec![pa_types::ai::ModelInput::Text]),
                        ..Default::default()
                    },
                    pa_ai::faux::FauxModelDefinition {
                        id: "second-model".to_string(),
                        input: Some(vec![pa_types::ai::ModelInput::Text]),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            });
        registration.set_responses(vec![
            pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::clone(&recording)),
            pa_ai::faux::FauxResponseStep::Factory(recording),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let write_settings = |reference: &str| {
            std::fs::write(
                dir.path().join("settings.json"),
                json!({ "decisionApi": { "systemOneModel": reference } }).to_string(),
            )
            .unwrap();
        };
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                "api": "faux-decision-engine", "models": [
                    { "id": "first-model", "input": ["text"] },
                    { "id": "second-model", "input": ["text"] }
                ]
            } } }"#,
        )
        .unwrap();
        write_settings("fixture-decisions/first-model");
        let engine = engine(dir.path());
        let decide = |engine: &DecisionEngine| {
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
            events
        };
        let first = decide(&engine);
        // The settings now name the other model; a per-decision
        // resolution would pick it up, the engine-start one never does.
        write_settings("fixture-decisions/second-model");
        let second = decide(&engine);
        assert_eq!(
            *served.lock().unwrap(),
            ["first-model", "first-model"],
            "the engine must keep its start-time model across a settings rewrite"
        );
        // Both decisions served end to end; the stub link cannot deliver
        // the reply, which is each turn's deterministic settle.
        for events in [first, second] {
            let Some(EngineEvent::Done(Err(error))) = events.last() else {
                panic!("each decision turn must settle: {events:?}");
            };
            assert!(
                error.starts_with("the decision reply could not reach the parent"),
                "{events:?}"
            );
        }
    }
}
