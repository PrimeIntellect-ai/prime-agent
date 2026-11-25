//! The refinement child engine (the daemon's refine spawn): a spawned
//! session whose one prompt is one refinement request — the planning
//! request the parent built with the shared planner. The child sends it
//! with the refinement system prompt and answers with the model reply as
//! its message to the parent, which parses and commits it on the wake.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

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

/// The child's reply when its own planning pass failed: the parent's
/// wake-side consumption surfaces the error (a failed refinement is never
/// silent).
pub const REFINEMENT_ERROR_REPLY_TYPE: &str = "refinement.error";

/// The resolved model plus its request auth (the API key and the provider
/// headers).
type ResolvedModel = (
    pa_types::ai::Model,
    Option<String>,
    Option<std::collections::HashMap<String, String>>,
);

/// The refinement child's engine.
pub struct RefineEngine {
    agent_dir: PathBuf,
    /// The create command's model selection (provider/model/thinking); the
    /// spawn admission resolved and validated it.
    selection: Mutex<crate::engine::EngineModelSelection>,
    /// The tagged-reply sender over the supervisor link.
    sender: Arc<LinkAgentMessageController>,
    /// The sender's identity source: the worker's session summary.
    own_summary: Arc<Mutex<Option<Value>>>,
    /// The child's semantic-edge ledger: opened at the RLM identity, so
    /// the refinement child's registration line carries its kind.
    semantic_edges:
        Mutex<Option<Arc<pa_core::session_engine::semantic_edges::SemanticEdgeRecorder>>>,
    /// The engine's own runtime: the planning completion and the reply
    /// send are async, `run_prompt` is not.
    runtime: AsyncSafeRuntime,
}

impl RefineEngine {
    /// Build the engine over the worker's supervisor link; the worker's
    /// session summary (pushed through `set_session_summary`) becomes the
    /// sender identity.
    ///
    /// # Panics
    ///
    /// Panics when the engine runtime cannot start.
    #[must_use]
    pub fn new(
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
            agent_dir,
            selection: Mutex::new(crate::engine::EngineModelSelection::default()),
            own_summary,
            sender,
            semantic_edges: Mutex::new(None),
            runtime: AsyncSafeRuntime::new_multi_thread().expect("refine engine runtime"),
        }
    }

    /// Open the refinement child's semantic-edge ledger: the registration
    /// line carries its parent provenance (the spawn's `refineChild` kind
    /// survives durably in the durable create's runtimeMetadata). The one
    /// planning pass is the refinement protocol, not an agent turn, so it
    /// records no request rows.
    fn open_semantic_edges(&self, identity: &crate::engine::RlmSessionIdentity) {
        let Some(session_file) = identity.session_file.as_deref().map(Path::new) else {
            return;
        };
        let origin = identity.semantic_spawn.as_ref();
        let recorder = pa_core::session_engine::semantic_edges::SemanticEdgeRecorder::open(
            pa_core::session_engine::semantic_edges::SemanticEdgeIdentity {
                session_id: identity.session_id.clone().unwrap_or_default(),
                ledger_path: pa_core::session_engine::semantic_edges::semantic_edge_ledger_path(
                    session_file.parent(),
                    None,
                ),
                parent_session_id: origin.and_then(|spawn| spawn.parent_session_id.clone()),
                spawned_by_request_id: origin.and_then(|spawn| spawn.spawned_by_request_id.clone()),
            },
        );
        *self
            .semantic_edges
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(recorder));
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

    /// Send one reply to the parent through the supervisor link: the
    /// refinement proposal on success, the tagged error envelope on
    /// failure.
    fn send_reply(&self, message: String) -> anyhow::Result<()> {
        let sender = Arc::clone(&self.sender);
        self.runtime.block_on(async move {
            let family = sender.family().await?;
            let parent = family
                .into_iter()
                .find(|member| member.relationship == AgentFamilyRelationship::Parent)
                .ok_or_else(|| {
                    anyhow::anyhow!("the refinement child has no parent in its family roster")
                })?;
            sender
                .send_agent_message(AgentMessageSendInput {
                    target: parent.id,
                    message,
                    receiver_role: Some(AgentFamilyRelationship::Parent),
                    delivery_mode: None,
                })
                .await
                .map(|_| ())
        })
    }

    /// Serve the one refinement request: send the parent's planning request
    /// with the refinement system prompt through the shared refiner call,
    /// and answer with the model reply itself — the parent reads its stop
    /// reason and proposal exactly as the in-process pass does.
    fn serve(&self, request: &Value) -> anyhow::Result<pa_types::ai::AssistantMessage> {
        let prompt = request
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("the refinement request carries no prompt"))?
            .to_string();
        let max_tokens = request
            .get("maxTokens")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow::anyhow!("the refinement request carries no maxTokens"))?;
        let session_id = request
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let (mut model, api_key, headers) = self.resolve_model()?;
        model.max_tokens = max_tokens;
        let refiner = pa_core::session_engine::refine::default_refiner_call(
            api_key,
            headers.map(|headers| headers.into_iter().collect()),
            session_id,
        );
        self.runtime.block_on(refiner(
            model,
            pa_core::refinement::planner::REFINEMENT_SYSTEM_PROMPT,
            prompt,
        ))
    }

    /// Resolve the spawn's model through the registry (the create command's
    /// provider/model, resolved and validated at the admission) plus the
    /// request auth.
    fn resolve_model(&self) -> anyhow::Result<ResolvedModel> {
        let selection = self
            .selection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let auth = pa_core::auth::AuthStorage::create(&self.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.agent_dir.join("models.json"));
        let all: Vec<pa_types::ai::Model> = registry.get_all().to_vec();
        let resolved = pa_core::models::resolve_cli_model(
            selection.provider.as_deref(),
            selection
                .model
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("the refinement child has no model selected"))?,
            &all,
        );
        if let Some(error) = resolved.error {
            anyhow::bail!("{error}");
        }
        let model = resolved
            .model
            .ok_or_else(|| anyhow::anyhow!("the refinement child's model did not resolve"))?;
        let auth_headers = registry.get_api_key_and_headers(&model, None);
        anyhow::ensure!(
            auth_headers.ok,
            "the refinement child's model {} has no configured credentials",
            model.id
        );
        Ok((
            model,
            auth_headers.api_key,
            auth_headers
                .headers
                .map(|headers| headers.into_iter().collect()),
        ))
    }

    /// The transcript row pair for the child's answer: the assistant update
    /// and the final message. The final row carries the planning reply's
    /// usage and stop reason, the same shape as an ordinary assistant
    /// completion, so the child-usage walk bills the planning pass.
    fn answer_rows(
        provider: &str,
        model: &str,
        text: &str,
        usage: Option<pa_types::ai::Usage>,
        stop_reason: Option<pa_types::ai::StopReason>,
    ) -> (EngineEvent, EngineEvent) {
        let now = crate::util::now_ms();
        let mut message = json!({
            "role": "assistant", "content": text,
            "provider": provider, "model": model,
            "timestamp": now,
        });
        if let Some(stop_reason) = stop_reason {
            message["stopReason"] = serde_json::to_value(stop_reason).unwrap_or_default();
        }
        if let Some(usage) = usage {
            message["usage"] = serde_json::to_value(usage).unwrap_or_default();
        }
        (
            EngineEvent::AssistantUpdate {
                message: AssistantSnapshot::Wire(json!({
                    "role": "assistant", "content": "",
                    "provider": provider, "model": model,
                    "timestamp": now,
                })),
                stream_event: None,
            },
            EngineEvent::AssistantMessage(message),
        )
    }
}

impl SessionEngine for RefineEngine {
    /// The worker's live session summary: the sender identity block of the
    /// tagged replies.
    fn set_session_summary(&self, summary: Value) {
        *self
            .own_summary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(summary);
    }

    /// Adopt the RLM identity (the spawn's parent ids and kind): opens the
    /// child's semantic-edge ledger, whose registration line carries the
    /// refinement kind.
    fn configure_rlm_identity(
        &self,
        identity: crate::engine::RlmSessionIdentity,
    ) -> anyhow::Result<()> {
        self.open_semantic_edges(&identity);
        Ok(())
    }

    /// Adopt the create command's model selection: the spawn admission
    /// resolved the model and thinking level.
    fn configure_create_model(&self, selection: crate::engine::EngineModelSelection) {
        *self
            .selection
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = selection;
    }

    /// The resolved model's context window, for the session stats.
    fn model_context_window(&self) -> Option<u64> {
        self.resolve_model()
            .ok()
            .map(|(model, _, _)| model.context_window)
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "a refinement child answers one refinement request only".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Failed {
            error: "a refinement child has no conversation to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        BranchSummaryOutcome::Failed {
            error: "a refinement child has no branches to summarize".to_string(),
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
        // The accepted row: the injected agent-message row (the spawn
        // kickoff), or the plain prompt.
        let accepted = match &request.custom_message {
            Some(custom) => EngineEvent::CustomMessage(custom.clone()),
            None => EngineEvent::UserMessage(json!({
                "role": "user",
                "content": request.message.clone(),
                "timestamp": crate::util::now_ms(),
            })),
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
        let (provider, model) = {
            let selection = self
                .selection
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let provider = selection
                .provider
                .clone()
                .unwrap_or_else(|| "unresolved".to_string());
            let model = selection
                .model
                .clone()
                .unwrap_or_else(|| "unresolved".to_string());
            (provider, model)
        };
        // Serve the one refinement request; every failure answers the
        // parent with the tagged error envelope before the turn ends, so
        // the wake-side consumption surfaces it.
        // The answer row's usage rides the success path only: a failed
        // planning pass bills nothing (the usage walk folds non-error,
        // non-aborted completions), and the failure rows name their own
        // error instead.
        let (reply, text, usage, stop_reason) = match serde_json::from_str::<Value>(&raw) {
            Ok(parsed)
                if parsed.get("type").and_then(Value::as_str)
                    == Some(pa_core::session_engine::refine::REFINEMENT_REQUEST_TYPE) =>
            {
                match self.serve(&parsed) {
                    Ok(reply) => (
                        serde_json::to_string(&reply).unwrap_or_default(),
                        "The refinement reply was sent to the parent.",
                        Some(reply.usage),
                        Some(reply.stop_reason),
                    ),
                    Err(error) => (
                        json!({
                            "type": REFINEMENT_ERROR_REPLY_TYPE,
                            "error": format!("{error:#}"),
                        })
                        .to_string(),
                        "The refinement request failed; the error was sent to the parent.",
                        None,
                        None,
                    ),
                }
            }
            _ => (
                json!({
                    "type": REFINEMENT_ERROR_REPLY_TYPE,
                    "error": "the refinement child serves one refinement.request prompt",
                })
                .to_string(),
                "The refinement child refuses a non-request prompt.",
                None,
                None,
            ),
        };
        if let Err(error) = self.send_reply(reply) {
            emit(EngineEvent::Done(Err(format!(
                "the refinement child could not send its reply to the parent: {error:#}"
            ))));
            return;
        }
        let (update, message) = Self::answer_rows(&provider, &model, text, usage, stop_reason);
        for event in [update, message] {
            if !emit(event) {
                emit(cancelled());
                return;
            }
        }
        emit(EngineEvent::Done(Ok(())));
    }
}
