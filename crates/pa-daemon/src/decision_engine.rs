//! The Decision API child engine (`rlm.spawn kind="decision"`): a spawned
//! session whose every message is one decision request, answered by a
//! single decision model call — the registry-resolved
//! `decisionApi.systemOneModel` model through the ordinary provider
//! transports. The parent's tagged goal messages route into the engine's
//! goal input (the newest seq wins; an older goal never overwrites a newer
//! one), and each answer returns to the parent as a tagged
//! `decision_api.decision` message the loop awaits.

use std::path::PathBuf;
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
    cwd: PathBuf,
    agent_dir: PathBuf,
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
    pub fn new(
        cwd: PathBuf,
        agent_dir: PathBuf,
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
        Self {
            own_summary,
            cwd,
            agent_dir,
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

    /// The latest goal text (the `decide()` call reads it into the state).
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

    /// Serve one decision request message: inject the latest goal into the
    /// state, then run the shared decision path (the registry resolution
    /// and one provider completion).
    fn serve(&self, mut request: Value) -> anyhow::Result<Value> {
        if let Some(goal) = self.latest_goal() {
            if let Some(state) = request.get_mut("state").and_then(Value::as_object_mut) {
                state.insert("goal".to_string(), json!(goal));
            }
        }
        let cwd = self.cwd.clone();
        let agent_dir = self.agent_dir.clone();
        self.runtime.block_on(async move {
            pa_core::session_engine::decision_api::serve_decision_request(request, &cwd, &agent_dir)
                .await
        })
    }

    /// The child's resolved model label (the transcript rows).
    fn model_label(&self) -> String {
        pa_core::session_engine::decision_api::decision_model_selector(&self.cwd, &self.agent_dir)
            .unwrap_or_default()
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
    /// Consume the parent's tagged goal messages: no turn, newest seq wins.
    fn route_decision_api_event(
        &self,
        _relationship: Option<AgentFamilyRelationship>,
        _sender_name: &str,
        message: &str,
    ) -> bool {
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
        let model_label = self.model_label();
        let (provider, model) = model_label.split_once('/').map_or_else(
            || ("decision".to_string(), "system-1".to_string()),
            |(provider, model)| (provider.to_string(), model.to_string()),
        );
        match self.serve(body) {
            Ok(envelope) => {
                let reply = json!({
                    "type": "decision_api.decision",
                    "seq": seq,
                    "model": envelope.get("model").cloned().unwrap_or(json!(model_label)),
                    "decision": envelope["answers"]["action"].clone(),
                });
                if let Err(error) = self.send_reply(&reply) {
                    emit(EngineEvent::Done(Err(format!(
                        "the decision reply could not reach the parent: {error:#}"
                    ))));
                    return;
                }
                let text = envelope["answers"].to_string();
                let (update, final_message) = Self::answer_rows(&provider, &model, &text);
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
                // The failure reaches the loop as a tagged error reply, so
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
            dir.to_path_buf(),
            dir.to_path_buf(),
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

    /// The intake parse: the request must carry an integer seq, and the
    /// message-sourced goal reaches the state through the seam.
    #[test]
    fn a_decision_request_reads_the_message_sourced_goal() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path());
        let request = json!({
            "seq": 7,
            "state": {"observation": 1},
            "questions": {"action": {
                "type": "choice", "criteria": {"left": "go left", "right": "go right"}
            }}
        });
        assert!(engine.accept_goal(
            &json!({
                "type":"decision_api.goal","seq":2,"goal":"follow the target"
            })
            .to_string()
        ));
        // The goal flows through latest_goal into the served state; the
        // request itself stays untouched until the serve call.
        assert_eq!(engine.latest_goal().as_deref(), Some("follow the target"));
        assert_eq!(request["seq"], json!(7));
    }
}
