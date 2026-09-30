//! `AgentSession`: the turn admission layer over the pa-agent loop.
//! First slice of core/agent-session.ts: prompt normalization (templates),
//! busy-admission rules (steer/follow-up), and `SessionManager` persistence.
//!
//! Design note: the TS class runs an internal action-store with admission
//! epochs/tickets. The Rust port keeps the observable contract instead: the
//! pa-agent Agent owns the loop and its steer/follow-up queues; this layer
//! decides admission and persists what the loop produces.

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
pub mod session_commands;
pub mod session_events;
pub mod side_question;
pub mod skills_unavailable_notice;
pub mod slash_commands;
pub mod state_restore_notice;
pub mod telemetry;
pub mod tool_bridge;
pub mod turn_boundary;

// The concern children split out of this composition root:

mod admission;
mod compaction_arms;
mod wiring;

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::{AgentEvent, AgentMessage, ThinkingLevel};
use pa_types::session::AgentMessage as SessionAgentMessage;
use pa_types::session::FileEntry;

use crate::session::manager::SessionManager;
use crate::skills::PromptTemplate;
use slash_commands::{SessionSlashCommand, SlashCommandRegistry};

/// How a prompt submitted while the agent streams is scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingBehavior {
    /// Interrupt the current turn and inject the message (queue mode "steer").
    Steer,
    /// Queue the message for after the current turn (queue mode "followUp").
    FollowUp,
}

/// What `prompt` did with the input.
#[derive(Debug, PartialEq)]
pub enum PromptOutcome {
    /// Input admitted to the model loop.
    Prompt,
    /// Input recognized as a session command (compact/refine/goal/autonomous).
    /// Execution is the session engine's job; the caller observes it here.
    SessionCommand(SessionSlashCommand),
}

/// Options for `AgentSession::prompt`. Port of `PromptOptions` (used fields).
#[derive(Debug, Default)]
pub struct PromptOptions {
    pub streaming_behavior: Option<StreamingBehavior>,
    pub expand_prompt_templates: Option<bool>,
    /// Queue instead of erroring when the session is busy (agent messages).
    pub queue_if_busy: bool,
    /// Co-delivered user rows of a batched turn (TS
    /// `_startPreparedTurnActions`: same-lane, same-policy queued
    /// actions delivered as ONE run under queue mode "all" or a forced
    /// steering batch). Each row rides the turn after the primary, with
    /// its own text and images, like the primary.
    pub batch: Vec<PromptBatchRow>,
    /// TS `returnAfterAccepted: true`: the admitted model turn runs
    /// detached and the admission returns once its run registers (the TS
    /// in-process connection's prompt shape: `preflightResult` fires at
    /// the delivered ticket, the run settles on its own and its events
    /// follow on the session stream) instead of awaiting the run's
    /// completion.
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
    /// Any trailing assistant message (the TS overflow arm's pre-compaction
    /// drop).
    Any,
    /// Only an error assistant message (the TS will-retry branch's drop
    /// after the compaction rebuild).
    ErrorOnly,
}

/// The standard message inside an agent message, when it is one.
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
    /// Harness digest inputs; `None` in sessions without harness state
    /// (verification harnesses building the loop directly).
    harness_digest: Option<harness_digest::HarnessDigestContext>,
    /// The first-turn digest rides the turn's admission (fresh sessions defer
    /// delivery so untouched sessions stay empty, TS `_harnessDigestPending`).
    digest_pending: std::sync::atomic::AtomicBool,
    /// Compaction settings from the session's settings.json (TS
    /// `_performCompaction` reads `getCompactionSettings()` on every
    /// compaction path, `/compact` included); defaults until the engine
    /// wiring resolves them.
    compaction: std::sync::RwLock<compaction::CompactionSettings>,
    /// The auxiliary-model routing context (TS `_resolveAuxiliaryModel`'s
    /// settings/registry access): compaction summaries resolve their model
    /// through the `auxiliaryModel` setting, falling back to the session
    /// model. `None` keeps every summarizer on the session model
    /// (verification harnesses building the session directly).
    auxiliary_model: Option<auxiliary_model::AuxiliaryModelContext>,
    /// Whether the session may run auto-refinement at all (TS
    /// `_autoRefineAllowedForSession`: depth 0 with a local harness state
    /// dir — the same gate that registers the `refine.*` host requests).
    /// Defaults off; the engine wiring resolves it once the session is
    /// assembled.
    auto_refine_allowed: bool,
    /// The resolved auto-refine gates (TS `getAutoRefineSettings`); the
    /// turn-boundary compact trigger reads them.
    auto_refine: refine::AutoRefineGates,
    /// The compact-trigger auto-refine machine (TS
    /// `_compactAutoRefinePending` / `_lastAutoRefineReviewAt` /
    /// `_assistantTurnsSinceAutoRefine`): the session-side state the
    /// transport surfaces arm and consume through
    /// [`AgentSession::mark_compact_auto_refine_pending`] and
    /// [`AgentSession::consume_compact_auto_refine`].
    compact_auto_refine: std::sync::Mutex<auto_refine_trigger::CompactAutoRefineState>,
    /// The kernel-state probe behind the post-compaction `ipython_state`
    /// notice (TS `_ipythonKernelProvisioner`): `None` in sessions without
    /// a kernel (verification harnesses) — no notice lands.
    kernel_state: Option<std::sync::Arc<dyn ipython_state::CompactionKernelProbe>>,
    /// TS `_pendingNextTurnMessages`: custom rows the NEXT admitted turn
    /// carries ahead of its own prompt row (the CLI `--goal` seed's
    /// continuation context, pushed at construction; taken by the next
    /// prompt or injected turn, exactly like the TS prepared-messages take).
    pending_next_turn_rows: std::sync::Arc<std::sync::Mutex<Vec<pa_types::session::CustomMessage>>>,
    /// The skill inventory `/skill:<name>` submissions expand against (TS
    /// reads `resourceLoader.getSkills()` at expansion time; the engine
    /// wiring installs the loaded list once the session is assembled).
    skills: Vec<crate::skills::Skill>,
    /// The telemetry handle for the `skill used` adoption event the
    /// prompt path owns (`None` in sessions without telemetry).
    skill_telemetry: Option<std::sync::Arc<telemetry::SessionTelemetry>>,
    /// The image-model routing host seam (`None` keeps the session model on
    /// image turns: verification harnesses, and the daemon worker whose
    /// turn dispatch owns routing itself).
    image_model_router: Option<image_model_routing::ImageModelRouter>,
    /// The live compaction summary-delta sink
    /// ([`compaction_exec::SummaryDeltaSink`]): every summarizer text
    /// delta the session's compactions stream reaches it, in arrival
    /// order — the daemon's `compaction_summary_delta` broadcast seam for
    /// the expanded TUI's live block. Interior-mutable so the embedding
    /// can install it on the assembled session (`&self`, not the
    /// `&mut self` the build-time setters take: the daemon wires it after
    /// the build from the worker's event pump). `None` (the default,
    /// including every non-daemon embedding) keeps the one-shot
    /// summarizer completion — no deltas, no broadcast, no behavior
    /// change.
    compaction_summary_sink: std::sync::Mutex<Option<compaction_exec::SummaryDeltaSink>>,
}

impl AgentSession {
    /// Build a session around a running agent loop.
    ///
    /// # Errors
    ///
    /// Returns the underlying session-assembly error (see
    /// [`AgentSession::from_session_arc`]).
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
        };
        this.ensure_harness_digest_context().await?;
        Ok(this)
    }

    /// The underlying agent loop (steering, state, subscriptions).
    pub fn agent(&self) -> &Arc<Agent> {
        &self.agent
    }

    /// The shared persistence handle: the kernel host handlers and the
    /// session-command executor reach the same session state as the loop.
    pub(crate) fn session_handle(&self) -> &Arc<tokio::sync::Mutex<SessionManager>> {
        &self.session
    }

    /// The shared persistence handle for host runtimes in other crates (the
    /// daemon's ACP transport records goal usage into the same session
    /// state as the loop).
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

    /// Model change bookkeeping (mirrors appendModelChange). The resolved
    /// model is forwarded to the loop; pa-agent and pa-types serialize to the
    /// same camelCase wire shape, so the boundary converts through JSON.
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

    /// The atomic model-and-level switch: one agent-lock acquisition
    /// updates both fields (the loop snapshots them together), so a
    /// concurrently admitted turn never observes the new model with the
    /// old level mid-switch. The durable `model_change` row is the same
    /// bookkeeping as [`AgentSession::set_model`]; the thinking level's
    /// intent row belongs to the explicit `/thinking` path.
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
    /// Returns an error when the thinking-level change row cannot be
    /// persisted.
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
            // TS `_processAgentEvent` runs on `_agentEventQueue`, whose
            // `.catch(() => {})` swallows persistence failures, and its
            // `_appendEntry` keeps the row in the in-memory session when the
            // disk write throws. The loop has already reduced this event into
            // live agent state, so a failed write must retain the row here
            // too: propagating would fail the run, append an error assistant
            // row that exists in neither store, and leave live context that
            // disappears on reopen.
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
        // The persist check lives inside `record_git_state_if_changed`.
        AgentEvent::AgentStart | AgentEvent::AgentEnd { .. } => {
            let mut session = session.lock().await;
            session.record_git_state_if_changed();
        }
        _ => {}
    }
    Ok(())
}

/// Convert a loop message to its persisted form via the shared wire shape.
/// Custom rows persist as session custom messages (TS `_processAgentEvent`:
/// `message_end` of a `custom` row appends the custom-message entry).
fn loop_message_to_session(message: &AgentMessage) -> Option<SessionAgentMessage> {
    match message {
        AgentMessage::Standard(inner) => {
            serde_json::from_value(serde_json::to_value(inner).ok()?).ok()
        }
        AgentMessage::Custom(_) => serde_json::from_value(serde_json::to_value(message).ok()?).ok(),
    }
}

/// The user prompt message in the loop's own normalized shape (text part
/// first, image parts after — identical to the loop's text-prompt input), so
/// a queued message matches a directly admitted one token for token.
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

/// Convert a session message to its loop form via the shared wire shape
/// (custom rows ride the loop's custom variant; its converter filters them
/// out of the provider request).
pub(crate) fn session_message_to_loop(message: &SessionAgentMessage) -> Option<AgentMessage> {
    serde_json::from_value(serde_json::to_value(message).ok()?).ok()
}

/// The live-context rebuild's conversion half: the rebuilt session
/// messages converted to the loop's shape row by row through the shared
/// wire shape (rows that fail the shared-shape conversion drop, exactly
/// like the inline closures this replaced).
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
