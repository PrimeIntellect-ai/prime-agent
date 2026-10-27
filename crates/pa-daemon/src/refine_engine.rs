//! The refinement child engine (`rlm.spawn kind="refine"`): a spawned
//! session whose one prompt is one refinement request — the planning model
//! pass over the parent's conversation. The request envelope carries the
//! resolvable harness paths, never a snapshot: the child reads the harness
//! state and the refinement history from disk itself, runs one completion
//! with the refinement system prompt, and answers with the refinement
//! proposal JSON as its reply to the parent. The parent applies the
//! proposal on the child-reply wake.

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
use pa_core::refinement::executor::{refinement_user_prompt, RefineOptions};
use pa_core::refinement::{
    load_global_refinement_history, load_harness_state, merge_harness_states,
    merge_refinement_history, HarnessScope,
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
    /// line carries the kind (`refine_child: true`), so the spawn kind
    /// survives durably. The one planning pass is the refinement protocol,
    /// not an agent turn, so it records no request rows.
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
                refine_child: true,
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
                })
                .await
                .map(|_| ())
        })
    }

    /// The parent session file's in-session refinement history (the audit
    /// rows), parsed straight off the JSONL.
    fn session_refinement_history(
        session_file: &Path,
    ) -> Vec<pa_core::refinement::RefinementResult> {
        let Ok(content) = std::fs::read_to_string(session_file) else {
            return Vec::new();
        };
        content
            .lines()
            .filter_map(|line| {
                let entry = serde_json::from_str::<pa_types::session::FileEntry>(line).ok()?;
                match entry {
                    pa_types::session::FileEntry::Custom { payload, .. } => Some(payload),
                    _ => None,
                }
            })
            .filter(|payload| {
                payload.custom_type == pa_core::session_engine::refine::REFINEMENT_AUDIT_CUSTOM_TYPE
            })
            .filter_map(|payload| {
                payload.data.as_ref().and_then(|data| {
                    serde_json::from_value::<pa_core::refinement::RefinementResult>(data.clone())
                        .ok()
                })
            })
            .collect()
    }

    /// Serve the one refinement request: read the harness state and the
    /// refinement history from the envelope's paths, run one completion
    /// with the refinement system prompt, and answer with the proposal
    /// JSON text.
    fn serve(&self, request: &Value) -> anyhow::Result<String> {
        let global_dir = request
            .get("globalHarnessDir")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("the refinement request carries no globalHarnessDir"))?;
        let global_dir = Path::new(global_dir);
        let global = request.get("scope").and_then(Value::as_str) == Some("global");
        let options = RefineOptions {
            global,
            instructions: request
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_string),
            rollback_id: None,
        };
        let conversation = request
            .get("conversation")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // The harness state read from disk: the global store, plus the
        // parent's local store for local-scope planning.
        let global_state = load_harness_state(global_dir, HarnessScope::Global);
        let planning_state = match request.get("localHarnessDir").and_then(Value::as_str) {
            Some(local_dir) => {
                let local_state = load_harness_state(Path::new(local_dir), HarnessScope::Local);
                merge_harness_states(&global_state, Some(&local_state))
            }
            None => global_state,
        };
        // The refinement history: the global refinements file plus the
        // parent session's audit rows.
        let global_history = load_global_refinement_history(global_dir);
        let session_history = request
            .get("parentSessionFile")
            .and_then(Value::as_str)
            .map(|file| Self::session_refinement_history(Path::new(file)))
            .unwrap_or_default();
        let history = merge_refinement_history(&global_history, &session_history);
        let user_prompt = refinement_user_prompt(&planning_state, &history, conversation, &options);
        let (model, api_key, headers) = self.resolve_model()?;
        let context = pa_types::ai::Context {
            system_prompt: Some(pa_core::refinement::planner::REFINEMENT_SYSTEM_PROMPT.to_string()),
            messages: vec![pa_types::ai::Message::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(user_prompt),
                timestamp: 0,
                rest: serde_json::Map::default(),
            })],
            tools: None,
        };
        // The request carries no output clamp: the child's turn derives
        // its budget from the model exactly like any other spawned turn.
        let mut stream_options =
            pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
                api_key,
                headers,
                ..Default::default()
            });
        stream_options.reasoning = self.requested_reasoning(&model);
        let reply = self
            .runtime
            .block_on(async move {
                pa_ai::complete_simple(&model, &context, Some(stream_options)).await
            })
            .map_err(|error| anyhow::anyhow!("the refinement model request failed: {error:?}"))?;
        match reply.stop_reason {
            pa_types::ai::StopReason::Error => anyhow::bail!(
                "the refinement model call failed: {}",
                reply
                    .error_message
                    .unwrap_or_else(|| "unknown provider error".to_string())
            ),
            pa_types::ai::StopReason::Aborted => {
                anyhow::bail!("the refinement model call was aborted")
            }
            _ => {}
        }
        let text = reply
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        anyhow::ensure!(
            !text.trim().is_empty(),
            "the refinement model returned no proposal text"
        );
        Ok(text)
    }

    /// The create selection's thinking level, defaulting to the model's
    /// minimum reasoning level (the refiner's standard posture).
    fn requested_reasoning(
        &self,
        model: &pa_types::ai::Model,
    ) -> Option<pa_types::ai::ModelThinkingLevel> {
        self.selection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .thinking
            .or_else(|| pa_types::ai::minimum_reasoning(model))
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
        registry.load_private_authorization_from_cache();
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
    /// and the final message.
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
        let (reply, text) = match serde_json::from_str::<Value>(&raw) {
            Ok(parsed)
                if parsed.get("type").and_then(Value::as_str)
                    == Some(pa_core::refinement::executor::REFINEMENT_REQUEST_TYPE) =>
            {
                match self.serve(&parsed) {
                    Ok(proposal) => (proposal, "The refinement proposal was sent to the parent."),
                    Err(error) => (
                        json!({
                            "type": REFINEMENT_ERROR_REPLY_TYPE,
                            "error": format!("{error:#}"),
                        })
                        .to_string(),
                        "The refinement request failed; the error was sent to the parent.",
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
            ),
        };
        if let Err(error) = self.send_reply(reply) {
            emit(EngineEvent::Done(Err(format!(
                "the refinement child could not send its reply to the parent: {error:#}"
            ))));
            return;
        }
        let (update, message) = Self::answer_rows(&provider, &model, text);
        for event in [update, message] {
            if !emit(event) {
                emit(cancelled());
                return;
            }
        }
        emit(EngineEvent::Done(Ok(())));
    }
}
