//! `AgentSession`: the turn admission layer over the pa-agent loop
//! (prompt normalization, busy-admission rules, `SessionManager`
//! persistence); the Agent owns the loop, this layer decides admission.

pub mod agent_messaging;
pub mod auto_refine_trigger;
pub mod auto_retry;
pub mod auxiliary_model;
pub mod branch_summarization;
pub mod compact_session;
pub mod compaction;
pub mod compaction_exec;
pub mod compaction_trace;
pub mod compaction_utils;
pub mod engine;
pub mod error_classify;
pub mod factory_host;
pub mod goal_boundary;
pub mod goal_driver;
pub mod harness_digest;
pub mod headless;
pub mod host_requests;
pub mod image_model_routing;
pub mod ipython_state;
pub mod messages;
pub mod provider_adapter;
pub mod provider_failover;
pub mod provider_park;
pub mod provider_retry;
pub mod refine;
pub mod request_timing;
pub mod rlm_host;
pub mod rlm_notices;
pub mod rlm_usage;
pub mod runtime;
pub mod runtime_wiring;
pub mod semantic_edges;
pub mod session_commands;
pub mod session_events;
pub mod side_question;
pub mod skills_unavailable_notice;
pub mod slash_commands;
pub mod state_restore_notice;
pub mod telemetry;
pub mod tool_bridge;
pub mod turn_boundary;

mod admission;
mod compaction_arms;
mod wiring;

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::{AgentEvent, AgentMessage, ThinkingLevel};
use pa_types::session::AgentMessage as SessionAgentMessage;
use pa_types::session::FileEntry;

use crate::session::manager::{capture_git_context, SessionManager};
use crate::skills::PromptTemplate;
use slash_commands::{SessionSlashCommand, SlashCommandRegistry};

/// How a prompt submitted while the agent streams is scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

/// What `prompt` did with the input.
#[derive(Debug, PartialEq)]
pub enum PromptOutcome {
    Prompt,
    /// Input recognized as a session command; execution is the session
    /// engine's job.
    SessionCommand(SessionSlashCommand),
}

/// Options for `AgentSession::prompt`.
#[derive(Debug, Default)]
pub struct PromptOptions {
    pub streaming_behavior: Option<StreamingBehavior>,
    pub expand_prompt_templates: Option<bool>,
    /// Queue instead of erroring when the session is busy (agent messages).
    pub queue_if_busy: bool,
    /// Co-delivered user rows of a batched turn, riding after the
    /// primary.
    pub batch: Vec<PromptBatchRow>,
    /// TS `returnAfterAccepted: true`: the turn runs detached, admission
    /// returns once its run registers.
    pub return_after_accepted: bool,
}

/// One co-delivered user row of a batched prompt admission.
#[derive(Debug, Clone)]
pub struct PromptBatchRow {
    pub text: String,
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// Which trailing assistant messages [`AgentSession::drop_trailing_assistant`]
/// removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrailingAssistantFilter {
    /// The TS overflow arm's pre-compaction drop.
    Any,
    /// The TS will-retry branch's post-rebuild drop.
    ErrorOnly,
}

fn standard_message(message: &pa_agent::types::AgentMessage) -> Option<&pa_agent::types::Message> {
    let pa_agent::types::AgentMessage::Standard(message) = message else {
        return None;
    };
    Some(message)
}

/// The session-bound agent: admission rules + persistence over the loop.
pub struct AgentSession {
    agent: Arc<Agent>,
    session: Arc<tokio::sync::Mutex<SessionManager>>,
    prompt_templates: Vec<PromptTemplate>,
    slash_commands: SlashCommandRegistry,
    /// Harness digest inputs; `None` without harness state.
    harness_digest: Option<harness_digest::HarnessDigestContext>,
    /// Fresh sessions defer the first-turn digest so untouched sessions
    /// stay empty.
    digest_pending: std::sync::atomic::AtomicBool,
    /// Compaction settings; defaults until the engine wiring resolves
    /// them.
    compaction: std::sync::RwLock<compaction::CompactionSettings>,
    /// Auxiliary-model routing for compaction summaries; `None` keeps
    /// every summarizer on the session model.
    auxiliary_model: Option<auxiliary_model::AuxiliaryModelContext>,
    /// Whether this session may auto-refine; defaults off until the
    /// engine wiring resolves it.
    auto_refine_allowed: bool,
    /// The resolved auto-refine gates; the compact trigger reads them.
    auto_refine: refine::AutoRefineGates,
    /// Session-side auto-refine state the transport surfaces arm and
    /// consume.
    compact_auto_refine: std::sync::Mutex<auto_refine_trigger::CompactAutoRefineState>,
    /// The kernel-state probe behind the post-compaction
    /// `ipython_state` notice; `None` without a kernel.
    kernel_state: Option<std::sync::Arc<dyn ipython_state::CompactionKernelProbe>>,
    /// TS `_pendingNextTurnMessages`: custom rows the NEXT admitted
    /// turn carries ahead of its own prompt row.
    pending_next_turn_rows: std::sync::Arc<std::sync::Mutex<Vec<pa_types::session::CustomMessage>>>,
    /// The skill inventory `/skill:<name>` submissions expand against.
    skills: Vec<crate::skills::Skill>,
    /// The telemetry handle for the `skill_use_count` counter the prompt
    /// path owns (`None` in sessions without telemetry).
    skill_telemetry: Option<std::sync::Arc<telemetry::SessionTelemetry>>,
    /// The image-model routing host seam; `None` keeps the session
    /// model on image turns.
    image_model_router: Option<image_model_routing::ImageModelRouter>,
    /// The live compaction summary-delta sink. Interior-mutable so the
    /// daemon can install it after the build; `None` (the default)
    /// keeps the one-shot summarizer completion.
    compaction_summary_sink: std::sync::Mutex<Option<compaction_exec::SummaryDeltaSink>>,
    /// One compaction at a time: a second `compact` waits for the
    /// in-flight run and prepares against its result; reads and writes
    /// keep using the session lock meanwhile; its slot holds the
    /// background summarize.
    compaction_flight: tokio::sync::Mutex<
        Option<
            tokio_util::task::AbortOnDropHandle<anyhow::Result<compact_session::BackgroundSummary>>,
        >,
    >,
    /// The session's semantic-edge recorder (TS
    /// `AgentSession._semanticEdges`): `None` in sessions the engine
    /// built without a semantic identity (verification harnesses
    /// building the loop directly).
    semantic_edges: std::sync::Mutex<Option<std::sync::Arc<semantic_edges::SemanticEdgeRecorder>>>,
    /// TS `unwrapSemanticEdgeStreamFn(streamFn)`: the timing-instrumented,
    /// pre-semantic stream fn calls outside session history run on (a side
    /// question carries no request id). `None` until the engine wires it;
    /// a side question on an unwired session fails with the model-selection
    /// error (no fallback to the agent's id-carrying fn).
    side_question_stream_fn: std::sync::Mutex<Option<pa_agent::stream::StreamFn>>,
    /// The session's agent dir (the settings root): the refine flow
    /// resolves the `factory.enabled` opt-in from its settings.json on
    /// every run, immediately before the plan applies, mirroring the
    /// kernel-side factory gate that reads the same file through
    /// `PRIME_AGENT_CODING_AGENT_DIR`. `None` until the engine wiring
    /// resolves it (verification harnesses building the session directly
    /// keep `None`, which reads as the fail-closed disabled default).
    agent_dir: Option<std::path::PathBuf>,
}

impl AgentSession {
    /// Build a session around a running agent loop.
    ///
    /// # Errors
    ///
    /// Returns the underlying session-assembly error (see [`AgentSession::from_session_arc`]).
    pub async fn new(
        agent: Arc<Agent>,
        session: SessionManager,
        prompt_templates: Vec<PromptTemplate>,
    ) -> anyhow::Result<Self> {
        Self::from_session_arc(
            agent,
            Arc::new(tokio::sync::Mutex::new(session)),
            prompt_templates,
            None,
        )
        .await
    }

    /// Build a session from an already-shared session manager handle, so the
    /// kernel host-request handlers can reach the same persistence.
    ///
    /// # Errors
    ///
    /// Returns an error when subscribing the persistence listener fails or
    /// the initial session context cannot be read.
    #[allow(clippy::too_many_arguments)]
    pub async fn from_session_arc(
        agent: Arc<Agent>,
        session: Arc<tokio::sync::Mutex<SessionManager>>,
        prompt_templates: Vec<PromptTemplate>,
        harness_digest: Option<harness_digest::HarnessDigestContext>,
    ) -> anyhow::Result<Self> {
        let persistence = session.clone();
        agent
            .subscribe(move |event, _signal| {
                let persistence = persistence.clone();
                Box::pin(async move {
                    persist_event(&persistence, event).await?;
                    Ok(())
                })
            })
            .await;
        let this = Self {
            agent,
            session,
            prompt_templates,
            slash_commands: SlashCommandRegistry::builtin(),
            harness_digest,
            digest_pending: std::sync::atomic::AtomicBool::new(false),
            compaction: std::sync::RwLock::new(compaction::CompactionSettings::default()),
            auxiliary_model: None,
            auto_refine_allowed: false,
            auto_refine: refine::AutoRefineGates::default(),
            compact_auto_refine: std::sync::Mutex::default(),
            kernel_state: None,
            pending_next_turn_rows: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            skills: Vec::new(),
            skill_telemetry: None,
            image_model_router: None,
            compaction_summary_sink: std::sync::Mutex::new(None),
            semantic_edges: std::sync::Mutex::new(None),
            side_question_stream_fn: std::sync::Mutex::new(None),
            agent_dir: None,
            compaction_flight: tokio::sync::Mutex::new(None),
        };
        this.ensure_harness_digest_context().await?;
        Ok(this)
    }

    /// The underlying agent loop (steering, state, subscriptions).
    pub fn agent(&self) -> &Arc<Agent> {
        &self.agent
    }

    /// The kernel host handlers and the command executor reach the same
    /// session state as the loop.
    pub(crate) fn session_handle(&self) -> &Arc<tokio::sync::Mutex<SessionManager>> {
        &self.session
    }

    /// The persistence handle for host runtimes in other crates (the
    /// daemon's ACP transport records goal usage into it).
    pub fn shared_persistence(&self) -> Arc<tokio::sync::Mutex<SessionManager>> {
        self.session.clone()
    }

    /// Session id (persistence identity).
    pub async fn session_id(&self) -> String {
        self.session.lock().await.get_session_id().to_string()
    }

    /// Restore a verified retained context without loading older transcript bodies.
    pub async fn restore_windowed_context(
        &self,
        window: crate::session::window::WindowedSessionStore,
    ) {
        let messages = {
            let mut session = self.session.lock().await;
            session.adopt_window(window);
            session.active_context().messages
        };
        self.agent
            .set_messages(
                messages
                    .iter()
                    .filter_map(session_message_to_loop)
                    .collect(),
            )
            .await;
    }

    /// Persisted entries (for UI resume and inspection).
    pub async fn entries(&self) -> Vec<FileEntry> {
        self.session
            .lock()
            .await
            .retained_entries()
            .iter()
            .filter(|entry| !matches!(entry, FileEntry::Header { .. }))
            .cloned()
            .collect()
    }

    /// Model change bookkeeping (mirrors appendModelChange); the model
    /// forwards to the loop through the shared wire shape.
    ///
    /// # Errors
    ///
    /// Returns an error when the model cannot be converted to the loop wire
    /// shape, or when the model-change row cannot be persisted.
    pub async fn set_model(
        &self,
        model: &pa_types::ai::Model,
        provider: &str,
        model_id: &str,
    ) -> anyhow::Result<()> {
        let wire: pa_agent::types::Model = serde_json::from_value(
            serde_json::to_value(model).map_err(|error| anyhow::anyhow!(error.to_string()))?,
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.agent.set_model(wire).await;
        let mut session = self.session.lock().await;
        session.append_model_change(provider, model_id)?;
        Ok(())
    }

    /// The atomic model-and-level switch: one agent-lock acquisition updates both, so
    /// a concurrently admitted turn never observes the new model with the old level
    /// mid-switch; the thinking level's intent row belongs to the explicit `/thinking` path.
    ///
    /// # Errors
    ///
    /// Returns an error when the model cannot be converted to the loop
    /// wire shape, or when the model-change row cannot be persisted.
    pub async fn set_model_and_thinking_level(
        &self,
        model: &pa_types::ai::Model,
        provider: &str,
        model_id: &str,
        thinking_level: ThinkingLevel,
    ) -> anyhow::Result<()> {
        let wire: pa_agent::types::Model = serde_json::from_value(
            serde_json::to_value(model).map_err(|error| anyhow::anyhow!(error.to_string()))?,
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.agent
            .set_model_and_thinking_level(wire, thinking_level)
            .await;
        let mut session = self.session.lock().await;
        session.append_model_change(provider, model_id)?;
        Ok(())
    }

    /// Thinking level bookkeeping (mirrors appendThinkingLevelChange).
    ///
    /// # Errors
    ///
    /// Returns an error when the thinking-level change row cannot be persisted.
    pub async fn set_thinking_level(&self, level: ThinkingLevel) -> anyhow::Result<()> {
        self.agent.set_thinking_level(level).await;
        let mut session = self.session.lock().await;
        session.append_thinking_level_change(&format!("{level:?}").to_lowercase())?;
        Ok(())
    }
}

async fn persist_event(
    session: &Arc<tokio::sync::Mutex<SessionManager>>,
    event: AgentEvent,
) -> std::io::Result<()> {
    match event {
        AgentEvent::MessageEnd { message, .. } => {
            let Some(session_message) = loop_message_to_session(&message) else {
                return Ok(());
            };
            let mut session = session.lock().await;
            // TS `_processAgentEvent` swallows persistence failures and keeps
            // the row in memory: the loop already reduced the event into live
            // state, so a failed write retains the row too — propagating would
            // fail the run and append an error row in neither store.
            let write_error = match session_message {
                SessionAgentMessage::Custom(custom) => {
                    session
                        .append_custom_message_retained(
                            &custom.custom_type,
                            custom.content.clone(),
                            custom.display,
                            custom.details.clone(),
                        )
                        .1
                }
                other => session.append_message_retained(other).1,
            };
            if let Some(error) = write_error {
                eprintln!("pa-core: message row not persisted: {error}");
            }
        }
        // Git state is captured at both run boundaries, exactly like the
        // TS run-boundary event path: a commit or branch switch made during the run
        // (e.g. via the bash tool) lands in the session file at `agent_end`.
        // The git probes block, so they run on the blocking pool with the
        // session lock released. A session's captures are sequential (the loop
        // awaits every listener), the cwd never changes, and no other lock
        // holder appends `git_state`, so re-taking the lock cannot race.
        AgentEvent::AgentStart | AgentEvent::AgentEnd { .. } => {
            let cwd = {
                let session = session.lock().await;
                session
                    .is_persisted()
                    .then(|| session.get_cwd().to_path_buf())
            };
            let Some(cwd) = cwd else { return Ok(()) };
            let git = tokio::task::spawn_blocking(move || capture_git_context(&cwd)).await?;
            if let Some(git) = git {
                session.lock().await.record_git_state_if_changed(git);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Custom rows persist as session custom messages.
fn loop_message_to_session(message: &AgentMessage) -> Option<SessionAgentMessage> {
    match message {
        AgentMessage::Standard(inner) => {
            serde_json::from_value(serde_json::to_value(inner).ok()?).ok()
        }
        AgentMessage::Custom(_) => serde_json::from_value(serde_json::to_value(message).ok()?).ok(),
    }
}

/// Text first, images after, so a queued message matches a directly
/// admitted one token for token.
fn user_prompt_message(text: &str, images: &[pa_agent::types::ImageContent]) -> AgentMessage {
    let mut parts = vec![pa_agent::types::UserPart::Text(
        pa_agent::types::TextContent {
            text: text.to_string(),
            text_signature: None,
        },
    )];
    for image in images {
        parts.push(pa_agent::types::UserPart::Image(image.clone()));
    }
    AgentMessage::Standard(pa_agent::types::Message::User(
        pa_agent::types::UserMessage {
            content: pa_agent::types::UserContent::Parts(parts),
            timestamp: now_millis() as i64,
        },
    ))
}

/// Custom rows ride the loop's custom variant and are filtered out of
/// the provider request.
pub(crate) fn session_message_to_loop(message: &SessionAgentMessage) -> Option<AgentMessage> {
    serde_json::from_value(serde_json::to_value(message).ok()?).ok()
}

/// Rows that fail the conversion drop.
pub(crate) fn rebuilt_loop_messages(rebuilt: Vec<SessionAgentMessage>) -> Vec<AgentMessage> {
    rebuilt
        .into_iter()
        .filter_map(|message| session_message_to_loop(&message))
        .collect()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod slash_session_tests;

#[cfg(test)]
mod compaction_outcome_tests;

#[cfg(test)]
mod compaction_unblocked_tests;
