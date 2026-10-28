//! The Decision API child engine (`rlm.spawn kind="decision"`): a spawned
//! session whose every message is one decision request, answered by a
//! single decision model call — the registry-resolved
//! `decisionModel` model (resolved once at engine start)
//! over the shared decision path (`pa_core::session_engine::decision_api`).
//! The parent's tagged goal messages route into the engine's goal input
//! (the newest seq wins; an older goal never overwrites a newer one), and
//! each answer returns to the parent as a tagged `decision_api.decision`
//! message.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::anyhow;
use serde_json::{json, Value};

use crate::agent_messaging::{FamilyIdentity, LinkAgentMessageController};
use crate::async_safe_runtime::AsyncSafeRuntime;
use crate::engine::{
    AssistantSnapshot, BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome,
    CompactionRequest, EngineEvent, PromptRequest, RlmSessionIdentity, SessionEngine,
    SideQuestionOutcome, SideQuestionRequest,
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

/// The stored goal beside the session file: `None` when no store exists or
/// the read fails (a first boot, a torn write).
fn read_goal_store(path: &std::path::Path) -> Option<StoredGoal> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(StoredGoal {
        seq: value["seq"].as_i64()?,
        goal: value
            .get("goal")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// The decision child's engine.
pub struct DecisionEngine {
    /// The decision model resolved once at engine start, or the actionable
    /// refusal every decision answers with.
    model: Result<ResolvedDecisionModel, String>,
    /// The latest goal message; shared with the worker's routing seam.
    goals: Arc<Mutex<StoredGoal>>,
    /// The tagged-reply sender over the supervisor link.
    sender: Arc<LinkAgentMessageController>,
    /// The sender's identity source: the worker's session summary.
    own_summary: Arc<Mutex<Option<Value>>>,
    /// The goal's durable home beside the session file, set at the create's
    /// identity handoff; `None` before the worker's create arrives.
    goal_store: Mutex<Option<std::path::PathBuf>>,
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
            goals: Arc::new(Mutex::new(StoredGoal::default())),
            sender,
            goal_store: Mutex::new(None),
            runtime: AsyncSafeRuntime::new_current_thread().expect("decision engine runtime"),
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
            let updated = StoredGoal { seq, goal };
            // The passivation contract: a newer goal is durable before it
            // is live, so a revived child serves the parent's latest goal
            // instead of an empty input. The write is best-effort — the
            // in-memory goal stays ahead of a failed one.
            if let Some(store) = self
                .goal_store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
            {
                let _ = std::fs::write(
                    store,
                    json!({ "seq": updated.seq, "goal": updated.goal }).to_string(),
                );
            }
            *stored = updated;
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
    fn serve(&self, mut request: Value, aborted: &dyn Fn() -> bool) -> anyhow::Result<Value> {
        if let Some(goal) = self.latest_goal() {
            Self::inject_goal(&mut request, &goal);
        }
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
    /// final message. The decision's usage rides both rows — the final
    /// message is the row the cost ledger bills, and a row without usage
    /// reads as a free call.
    fn answer_rows(
        provider: &str,
        model: &str,
        text: &str,
        usage: &Value,
    ) -> (EngineEvent, EngineEvent) {
        let now = crate::util::now_ms();
        let row = |content: &str| {
            let mut row = json!({
                "role": "assistant", "content": content,
                "provider": provider, "model": model,
                "timestamp": now,
            });
            if usage.is_object() {
                row["usage"] = usage.clone();
            }
            row
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
    /// The decision engine consumes the parent's tagged messages: the
    /// worker resolves the sender's parent edge for it alone.
    fn routes_decision_events(&self) -> bool {
        true
    }
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

    /// The create's identity handoff: the session file names the goal's
    /// durable home, and a stored goal re-seeds the input (the revived
    /// child of a passivated worker keeps the parent's latest goal under
    /// the same seq contract).
    fn configure_rlm_identity(&self, identity: RlmSessionIdentity) -> anyhow::Result<()> {
        let store = identity
            .session_file
            .as_deref()
            .map(std::path::Path::new)
            .and_then(std::path::Path::parent)
            .map(|dir| dir.join("decision-goal.json"));
        if let Some(store) = store {
            if let Some(stored) = read_goal_store(&store) {
                let mut goals = self.goals.lock().unwrap_or_else(PoisonError::into_inner);
                if stored.seq > goals.seq {
                    *goals = stored;
                }
            }
            *self
                .goal_store
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(store);
        }
        Ok(())
    }

    /// The whole-worker gate passes: the engine holds no kernel, no cron,
    /// and no RLM children of its own, and its one memory-only input — the
    /// goal — is durable beside the session file. The worker-side idle
    /// fences (attachment, queued lanes, live bash) stay the whole gate,
    /// so an idle decision child passivates instead of staying resident.
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
            let (update, message) = Self::answer_rows(
                "decision",
                "system-1",
                "Decision child ready.",
                &Value::Null,
            );
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
                let (update, final_message) =
                    Self::answer_rows(provider, model, &text, &envelope["usage"]);
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

    /// The passivation contract, pinned: the whole-worker gate passes on
    /// the current-thread runtime `block_on` needs, and the parent's goal
    /// is durable — a fresh engine over the same session file (the revived
    /// child of a passivated worker) re-seeds the latest goal under the
    /// same seq contract.
    #[test]
    fn a_decision_child_passivates_and_its_goal_survives_the_revival() {
        let dir = tempfile::tempdir().unwrap();
        let child = engine(dir.path());
        let goal = |seq: i64, text: &str| {
            json!({"type":"decision_api.goal","seq":seq,"goal":text}).to_string()
        };
        // The whole-worker gate: an idle decision child passivates instead
        // of staying resident, on the single worker thread `block_on`
        // needs (the engine spawns nothing).
        assert!(child
            .runtime
            .block_on(crate::engine::SessionEngine::can_passivate_worker(&child)));
        assert_eq!(child.runtime.metrics().num_workers(), 1);
        // The create's identity handoff names the goal's durable home.
        let identity = RlmSessionIdentity {
            rlm_depth: 1,
            rlm_max_depth: None,
            cwd: None,
            session_id: None,
            session_file: Some(
                dir.path()
                    .join("session.jsonl")
                    .to_string_lossy()
                    .into_owned(),
            ),
            thinking: None,
            child_script: None,
            semantic_spawn: None,
        };
        child.configure_rlm_identity(identity.clone()).unwrap();
        assert!(child.accept_goal(&goal(3, "follow the target")));
        // The revival: a fresh engine replays the create over the same
        // session file and re-seeds the parent's latest goal.
        let revived = engine(dir.path());
        revived.configure_rlm_identity(identity).unwrap();
        assert_eq!(revived.latest_goal().as_deref(), Some("follow the target"));
        // The seq contract survives the revival: an older goal still loses.
        assert!(revived.accept_goal(&goal(1, "stale")));
        assert_eq!(revived.latest_goal().as_deref(), Some("follow the target"));
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
        let commands = stub_supervisor(&socket);
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
        // The ready answer is the only assistant content on the turn.
        let answered: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AssistantMessage(row) => row["content"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(answered, ["Decision child ready."]);
    }

    /// A stub supervisor over `socket`: it answers each command on its own
    /// connection — the direct-transport probe fails, the
    /// supervisor-routed send delivers — and records every command it
    /// answers.
    #[cfg(unix)]
    fn stub_supervisor(socket: &std::path::Path) -> Arc<Mutex<Vec<Value>>> {
        let commands: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let stub_commands = Arc::clone(&commands);
        // Bind before returning so the engine's first connect cannot race
        // the listener setup (a lost race fails the connect with ENOENT).
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            for _ in 0..2 {
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
        let commands = stub_supervisor(&socket);
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
        assert_eq!(
            captured
                .iter()
                .map(|command| command["type"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["get_worker_peer_transport", "send_message"],
            "the reply must route straight to the known parent id, never a roster fetch"
        );
        for command in &captured {
            assert_eq!(
                command["targetActiveSessionId"], "parent-live-1",
                "every leg of the reply must target the worker's known parent id"
            );
        }
        assert_eq!(
            captured[1]["deliveryMode"], "follow_up",
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
        let _commands = stub_supervisor(&socket);
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
        let usage = &answer["usage"];
        assert!(
            usage["input"].as_u64().is_some_and(|input| input > 0),
            "the answer row must carry the completion's usage: {answer}"
        );
        assert!(
            usage["output"].as_u64().is_some_and(|output| output > 0),
            "the answer row must carry the completion's usage: {answer}"
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
                json!({ "decisionModel": reference }).to_string(),
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
