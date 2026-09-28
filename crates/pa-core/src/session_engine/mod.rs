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
pub mod goal_boundary;
pub mod goal_driver;
pub mod harness_digest;
pub mod headless;
pub mod host_requests;
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

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::{AgentEvent, AgentMessage, ThinkingLevel};
use pa_types::session::AgentMessage as SessionAgentMessage;
use pa_types::session::FileEntry;

use crate::session::manager::SessionManager;
use crate::session_engine::compact_session::CompactOutcome;
use crate::skills::PromptTemplate;
use slash_commands::{parse_session_command, SessionSlashCommand, SlashCommandRegistry};

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
            compaction_summary_sink: std::sync::Mutex::new(None),
        };
        this.ensure_harness_digest_context().await?;
        Ok(this)
    }

    /// Override the compaction settings from the session's resolved
    /// settings (TS `getCompactionSettings`); the engine wiring calls this
    /// so `/compact` honors `compaction.keepRecentTokens`/`reserveTokens`
    /// like the TS product instead of the defaults.
    pub fn set_compaction_settings(&self, settings: compaction::CompactionSettings) {
        *self
            .compaction
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
    }

    /// Toggle automatic compaction for this session (TS
    /// `setAutoCompactionEnabled`): the live settings the auto-compaction
    /// arms and `/compact` read.
    pub fn set_auto_compaction_enabled(&self, enabled: bool) {
        let mut settings = self
            .compaction
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        settings.enabled = enabled;
    }

    /// Install the auxiliary-model routing context (TS #2411's
    /// `_resolveAuxiliaryModel` settings/registry access); the engine
    /// wiring calls this so compaction summaries resolve through the
    /// `auxiliaryModel` setting. Without it every summarizer stays on the
    /// session model.
    pub fn set_auxiliary_model_context(&mut self, context: auxiliary_model::AuxiliaryModelContext) {
        self.auxiliary_model = Some(context);
    }

    /// Install the skill inventory `/skill:<name>` submissions expand
    /// against (TS reads the resource loader at expansion time; the Rust
    /// session snapshots the engine's loaded list here).
    pub fn set_skills(&mut self, skills: Vec<crate::skills::Skill>) {
        self.skills = skills;
    }

    /// Bind the telemetry handle the `skill used` adoption event reports
    /// through (the engine wiring owns the telemetry lifetime and
    /// installs it once the session telemetry is assembled).
    pub fn set_skill_telemetry(&mut self, telemetry: std::sync::Arc<telemetry::SessionTelemetry>) {
        self.skill_telemetry = Some(telemetry);
    }

    /// Bind the auto-refine surface for this session (the engine wiring
    /// resolves both once the session is assembled): whether the session
    /// may auto-refine (TS `_autoRefineAllowedForSession`: depth 0 with a
    /// local harness state dir) and the resolved gates (TS
    /// `getAutoRefineSettings`).
    pub fn set_auto_refine(&mut self, allowed: bool, gates: refine::AutoRefineGates) {
        self.auto_refine_allowed = allowed;
        self.auto_refine = gates;
    }

    /// Bind the kernel-state probe behind the post-compaction
    /// `ipython_state` notice (the engine wiring hands over the session's
    /// kernel provisioner, TS `AgentSession._ipythonKernelProvisioner`).
    /// Without a probe no notice lands: sessions without a kernel keep
    /// the pre-notice compaction flow.
    pub fn set_kernel_state_probe(
        &mut self,
        probe: Option<std::sync::Arc<dyn ipython_state::CompactionKernelProbe>>,
    ) {
        self.kernel_state = probe;
    }

    /// Install the live compaction summary-delta sink (the daemon's
    /// `compaction_summary_delta` broadcast seam): every summarizer text
    /// delta the session's compactions stream reaches the sink while the
    /// summary generates, in arrival order. The daemon wires this onto
    /// the assembled session (the worker's event pump); every other
    /// embedding leaves it unset — the one-shot summarizer completion,
    /// byte-identical to the pre-seam behavior.
    ///
    /// # Panics
    ///
    /// Panics when the sink slot's mutex is poisoned.
    pub fn set_compaction_summary_sink(&self, sink: compaction_exec::SummaryDeltaSink) {
        *self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock") = Some(sink);
    }

    /// Whether the session may run auto-refinement (TS
    /// `_autoRefineAllowedForSession`).
    pub fn auto_refine_allowed(&self) -> bool {
        self.auto_refine_allowed
    }

    /// The resolved auto-refine gates (TS `getAutoRefineSettings`).
    pub fn auto_refine_gates(&self) -> refine::AutoRefineGates {
        self.auto_refine
    }

    /// Whether automatic compaction is enabled for this session (the TS
    /// `getCompactionSettings().enabled` gate the automatic arms check
    /// before any trigger).
    pub fn auto_compaction_enabled(&self) -> bool {
        self.compaction
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .enabled
    }

    /// The resolved compaction settings (TS `getCompactionSettings`): the
    /// in-run continuation consult reads the threshold headroom without
    /// owning the session (a compaction in flight owns it across its
    /// model turn).
    pub fn compaction_settings(&self) -> compaction::CompactionSettings {
        *self
            .compaction
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The latest compaction boundary in the live loop context, if any
    /// (the TS `getLatestCompactionEntry` guard source): the timestamp of
    /// the newest compaction summary in the agent state.
    pub async fn latest_compaction_timestamp(&self) -> Option<u64> {
        let state = self.agent.state().await;
        state
            .messages
            .iter()
            .filter_map(|message| serde_json::to_value(message).ok())
            .filter_map(|value| serde_json::from_value::<SessionAgentMessage>(value).ok())
            .filter_map(|message| match message {
                SessionAgentMessage::CompactionSummary(summary) => Some(summary.timestamp),
                _ => None,
            })
            .max()
    }

    /// Whether an automatic threshold compaction is due at a turn boundary
    /// (the TS `_checkCompaction` threshold arm, fired at `agent_end` and
    /// before the next admitted prompt): the live loop context over the
    /// model's context window against the effective threshold
    /// (`compaction::compaction_threshold`: the percentage ceiling or the
    /// combined input+output ceiling, whichever comes first). Usage
    /// from before the latest compaction never re-triggers.
    pub async fn auto_compaction_due(&self, model: &pa_types::ai::Model) -> bool {
        let state = self.agent.state().await;
        // The live loop context is the agent's message list (the same JSON
        // round-trip `compact` uses for its rebuilt context).
        let messages: Vec<SessionAgentMessage> = state
            .messages
            .iter()
            .filter_map(|message| serde_json::to_value(message).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        compaction::threshold_compaction_due(
            &messages,
            model.context_window,
            // The live thinking level decides whether the request folds a
            // thinking budget on top of the base output budget.
            compaction::request_output_budget(
                model,
                provider_adapter::model_thinking_level(state.thinking_level),
            ),
            &self.compaction_settings(),
        )
    }

    /// Remove the trailing assistant message from the loop context (TS retry:
    /// `messages.slice(0, -1)`), so a re-issued request does not re-send the
    /// failed turn's error message. The session history keeps it (it already
    /// persisted through the message-end hook).
    ///
    /// [`TrailingAssistantFilter::ErrorOnly`] matches the TS
    /// compact-and-retry will-retry branch: only an error assistant message
    /// drops (a compaction rebuild may leave any other trailing assistant
    /// in place).
    pub async fn drop_trailing_assistant(&self, filter: TrailingAssistantFilter) {
        let state = self.agent.state().await;
        let mut messages = state.messages;
        let matches_filter = |message: &pa_agent::types::AgentMessage| {
            let Some(pa_agent::types::Message::Assistant(assistant)) = standard_message(message)
            else {
                return false;
            };
            match filter {
                TrailingAssistantFilter::Any => true,
                TrailingAssistantFilter::ErrorOnly => {
                    assistant.stop_reason == pa_agent::types::StopReason::Error
                }
            }
        };
        if messages.last().is_some_and(&matches_filter) {
            messages.pop();
            self.agent.set_messages(messages).await;
        }
    }

    /// The last assistant message in the live loop context (TS
    /// `_findLastAssistantMessage`), in the session wire shape: trailing
    /// non-assistant rows (a compaction outcome disclosure, a compaction
    /// summary) are skipped, not matched.
    pub async fn last_assistant_message(&self) -> Option<SessionAgentMessage> {
        let state = self.agent.state().await;
        state.messages.iter().rev().find_map(|message| {
            let value = serde_json::to_value(message).ok()?;
            let message: SessionAgentMessage = serde_json::from_value(value).ok()?;
            matches!(message, SessionAgentMessage::Assistant(_)).then_some(message)
        })
    }

    /// Execute `/compact`: summarize the pre-cut prefix, persist the
    /// compaction entry, and rebuild the loop context summary-first. A skip
    /// (already compacted, or nothing to summarize) leaves the session
    /// untouched, matching the TS `CompactionSkippedError` flow. `abort`
    /// is the run's abort signal (TS `_performCompaction`'s `signal`):
    /// an aborted run returns the abort error and never commits.
    ///
    /// # Errors
    ///
    /// Returns the abort error when the run was aborted, or the compaction
    /// failure when the summarizer call or the compaction entry's persist
    /// fails. A skip is a normal `Ok` outcome carrying the skip message.
    ///
    /// # Panics
    ///
    /// Panics when the compaction summary sink slot's mutex is poisoned.
    pub async fn compact(
        &self,
        custom_instructions: Option<&str>,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> anyhow::Result<CompactOutcome> {
        // TS `_performCompaction` captures `this._harnessDigest()` at the
        // commit: relevance terms from the live (pre-compaction) context,
        // harness state read fresh from disk when the snapshot renders.
        compaction_trace::trace(
            "compact.enter",
            serde_json::json!({
                "customInstructions": custom_instructions.is_some(),
            }),
        );
        let digest_inputs = self.harness_digest_inputs().await;
        compaction_trace::trace("compact.digest_captured", serde_json::Value::Null);
        let mut outcome = {
            let mut session = self.session.lock().await;
            let summary_delta = self
                .compaction_summary_sink
                .lock()
                .expect("compaction summary sink lock")
                .clone();
            crate::session_engine::compact_session::execute_compaction(
                &mut session,
                crate::session_engine::compact_session::CompactOptions {
                    model: model.clone(),
                    api_key,
                    custom_instructions,
                    settings: self.compaction_settings(),
                    abort,
                    harness_digest: digest_inputs,
                    auxiliary: self.auxiliary_model.as_ref(),
                    summary_delta,
                },
            )
            .await?
        };
        if matches!(outcome, CompactOutcome::Skipped(_)) {
            compaction_trace::trace("compact.skipped", serde_json::Value::Null);
            return Ok(outcome);
        }
        // Rebuild the loop context from the post-compaction session.
        let rebuilt = {
            let session = self.session.lock().await;
            crate::session_engine::compact_session::rebuilt_context_after_compaction(&session)
        };
        let loop_messages: Vec<AgentMessage> = rebuilt
            .into_iter()
            .filter_map(|message| {
                let value = serde_json::to_value(&message).ok()?;
                serde_json::from_value::<AgentMessage>(value).ok()
            })
            .collect();
        let rebuilt_message_count = loop_messages.len();
        self.agent.set_messages(loop_messages).await;
        compaction_trace::trace(
            "compact.rebuilt_context",
            serde_json::json!({ "messages": rebuilt_message_count }),
        );
        // TS `_performCompaction` ends with
        // `_syncKernelStateAfterCompaction()`: a kernel that survived the
        // compaction gets its persistence notice — a durable
        // `ipython_state` row that is also model context, and the row that
        // keeps a back-to-back second `/compact` preparing (update mode)
        // instead of skipping as already compacted. The row rides the run
        // so each surface broadcasts it as a `message_start` /
        // `message_end` pair.
        let kernel_state = match self.kernel_state.as_ref() {
            Some(probe) => {
                ipython_state::sync_after_compaction(probe.as_ref(), &self.session, &self.agent)
                    .await?
            }
            None => None,
        };
        let notice_landed = kernel_state.is_some();
        if let CompactOutcome::Ran(run) = &mut outcome {
            run.ipython_state = kernel_state;
        }
        compaction_trace::trace(
            "compact.returned",
            serde_json::json!({
                "notice": notice_landed,
            }),
        );
        Ok(outcome)
    }

    /// Record an unsuccessful compaction outcome (TS
    /// `_persistCompactionOutcome`): append the durable `compaction_outcome`
    /// row to the session entries and push it onto the live loop context,
    /// returning it for the caller to broadcast as a `message_start` /
    /// `message_end` pair. The row is a user-facing disclosure, never model
    /// context: `convert_to_llm` drops it, so the KV-cacheable prefix is
    /// unaffected (the TS contract — `agent-session-compaction.test.ts`
    /// asserts the outcome "stays out of model context"). The append is
    /// retained in the in-memory entry chain even when the disk write
    /// fails, so every in-process context rebuild (compaction, tree
    /// navigation) keeps the disclosure — the TS `_unpersistedOutcomes`
    /// guarantee, held structurally.
    ///
    /// # Errors
    ///
    /// Returns an error when the disclosure row cannot be appended or
    /// surfaced to the live loop; the row is retained in memory either way.
    pub async fn record_compaction_outcome(
        &self,
        reason: crate::session_engine::messages::CompactionOutcomeReason,
        outcome: crate::session_engine::messages::CompactionOutcomeKind,
        content: &str,
    ) -> anyhow::Result<pa_types::session::CustomMessage> {
        let row = crate::session_engine::messages::create_compaction_outcome_message(
            content, reason, outcome,
        );
        {
            let mut session = self.session.lock().await;
            let (_, write_error) = session.append_custom_message_retained(
                &row.custom_type,
                row.content.clone(),
                row.display,
                row.details.clone(),
            );
            if let Some(error) = write_error {
                eprintln!("pa-core: compaction outcome row not persisted: {error}");
            }
        }
        // TS pushes the row onto `agent.state.messages` after the append:
        // the live context owns the disclosure; the loop's converter filters
        // custom rows out of the provider request.
        if let Some(loop_message) =
            session_message_to_loop(&SessionAgentMessage::Custom(row.clone()))
        {
            let state = self.agent.state().await;
            let mut messages = state.messages;
            messages.push(loop_message);
            self.agent.set_messages(messages).await;
        }
        Ok(row)
    }

    /// Rebuild the live loop context from a durable branch (TS
    /// `navigateTree`'s context rebuild: `sessionManager.branch(newLeafId)`
    /// then `agent.state.messages = buildSessionContext().messages`). The
    /// session adopts the branch entries and the agent's message list is
    /// rebuilt from the post-navigation session state.
    ///
    /// # Errors
    ///
    /// Returns an error when the post-navigation history cannot be read.
    pub async fn rebuild_branch_context(
        &self,
        branch_entries: Vec<FileEntry>,
    ) -> anyhow::Result<()> {
        let rebuilt = {
            let mut session = self.session.lock().await;
            session.adopt_entries(branch_entries);
            crate::session_engine::compact_session::rebuilt_context_after_compaction(&session)
        };
        let loop_messages: Vec<AgentMessage> = rebuilt
            .into_iter()
            .filter_map(|message| {
                let value = serde_json::to_value(&message).ok()?;
                serde_json::from_value::<AgentMessage>(value).ok()
            })
            .collect();
        self.agent.set_messages(loop_messages).await;
        Ok(())
    }

    /// Execute `/refine`: plan, re-read, apply, and persist the continual
    /// harness state for this session. The conversation snapshot comes from
    /// the session entries (what the model would see on a rebuild).
    ///
    /// # Errors
    ///
    /// Returns an error when the conversation history cannot be read, or
    /// when the refinement plan, apply, or persist fails.
    pub async fn refine(
        &self,
        options: &refine::RefineOptions,
        source: refine::RefinementSource,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
    ) -> anyhow::Result<crate::refinement::RefinementResult> {
        let snapshot = self.session.lock().await.history_snapshot();
        let entries = snapshot.await?;
        let messages: Vec<SessionAgentMessage> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect();
        let result = {
            let mut session = self.session.lock().await;
            refine::execute_refinement(
                &mut session,
                refine::RefinementTranscript {
                    messages: &messages,
                    historical_entries: &entries,
                },
                &global_harness_dir,
                model,
                options,
                source,
                refine::default_refiner_call(api_key),
            )
            .await?
        };
        // The notice entry must also enter the live loop context.
        let session = self.session.lock().await;
        let loop_messages: Vec<AgentMessage> =
            crate::session_engine::compact_session::rebuilt_context_after_compaction(&session)
                .into_iter()
                .filter_map(|message| {
                    let value = serde_json::to_value(&message).ok()?;
                    serde_json::from_value::<AgentMessage>(value).ok()
                })
                .collect();
        drop(session);
        self.agent.set_messages(loop_messages).await;
        Ok(result)
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

    /// Submit a prompt. Session commands (compact/refine/goal/autonomous)
    /// are recognized before admission and never reach the model.
    ///
    /// # Errors
    ///
    /// Returns the underlying prompt admission error (see
    /// [`AgentSession::prompt_with_images`]).
    pub async fn prompt(
        &self,
        text: &str,
        options: PromptOptions,
    ) -> anyhow::Result<PromptOutcome> {
        self.prompt_with_images(text, Vec::new(), options).await
    }

    /// Admit an injected custom message as the turn's prompt (TS
    /// `_promptInjectedMessage` -> `_createPreparedTurnAction(..., {
    /// message })` -> `agent.prompt([customMessage])`): the loop context
    /// and the transcript hold ONE representation of the turn — the
    /// custom row itself, appended by the loop's `message_end` — while
    /// the provider request carries its user-role view (the loop-boundary
    /// `convert_to_llm` conversion, TS `convertToLlm`). The injected
    /// content is never template-expanded or command-parsed (TS injected
    /// turns skip `_normalizeSubmission`).
    ///
    /// # Errors
    ///
    /// Returns an error when the session is already busy, when the pending
    /// digest row cannot be captured, or when the agent rejects the
    /// injected prompt.
    pub async fn prompt_injected_message(
        &self,
        message: &pa_types::session::CustomMessage,
    ) -> anyhow::Result<PromptOutcome> {
        let state = self.agent.state().await;
        let busy = state.is_streaming;
        if busy {
            anyhow::bail!(
                "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            );
        }
        let mut prompt_messages = Vec::new();
        if let Some(digest_row) = self.pending_digest_prompt_row().await? {
            prompt_messages.push(digest_row);
        }
        prompt_messages.extend(self.take_next_turn_rows().await);
        let custom_row = session_message_to_loop(&SessionAgentMessage::Custom(message.clone()))
            .ok_or_else(|| anyhow::anyhow!("injected custom message conversion failed"))?;
        prompt_messages.push(custom_row);
        self.agent
            .prompt(pa_agent::agent::AgentPromptInput::Messages(prompt_messages))
            .await?;
        Ok(PromptOutcome::Prompt)
    }

    /// Classify a prompt as a session command without admitting it: the
    /// same expansion-plus-grammar parse `prompt` applies. Host turn loops
    /// use this to keep their pre-turn compaction arms off the
    /// session-command path (TS session commands never reach
    /// `_prepareForCommit`, so `_runPreTurnCompaction` never fires for
    /// them).
    pub fn classify_session_command(&self, text: &str) -> Option<SessionSlashCommand> {
        let normalized = crate::skills::expand_prompt_template(text, &self.prompt_templates);
        parse_session_command(&self.slash_commands, &normalized)
    }

    /// Prompt with images attached (the ACP prompt-capability path). Busy
    /// sessions queue the text and images together as one follow-up batch,
    /// so an admitted prompt never loses its images to a queue race.
    ///
    /// # Errors
    ///
    /// Returns an error when the prompt fails validation, the session is
    /// busy under its admission rule, or the agent rejects the turn (with
    /// [`PromptOptions::return_after_accepted`], a rejection after the run
    /// registers rides the events instead of this result).
    pub async fn prompt_with_images(
        &self,
        text: &str,
        images: Vec<pa_agent::types::ImageContent>,
        options: PromptOptions,
    ) -> anyhow::Result<PromptOutcome> {
        let expand = options.expand_prompt_templates.unwrap_or(true);
        // TS `_finishSubmissionNormalization` order: skill commands expand
        // first (`/skill:<name>` into its `<skill>` block), prompt templates
        // second; both are gated by the same policy flag.
        let (normalized, used_skill) = if expand {
            let (skill_expanded, used_skill) =
                crate::skills::expand_skill_command(text, &self.skills);
            let normalized =
                crate::skills::expand_prompt_template(&skill_expanded, &self.prompt_templates);
            (normalized, used_skill)
        } else {
            (text.to_string(), None)
        };

        if let Some(command) = parse_session_command(&self.slash_commands, &normalized) {
            return Ok(PromptOutcome::SessionCommand(command));
        }

        let state = self.agent.state().await;
        let busy = state.is_streaming;
        // The `skill used` adoption event reports from the admission seam:
        // an admitted user turn whose text IS a skill block reports once,
        // with how the invocation arrived (a fresh admission, or a queued
        // steering/follow-up submission). A pre-expanded block (the daemon
        // emits the accepted row before admission) reports here too — the
        // block parse carries the skill identity.
        if let Some(skill) = used_skill.or_else(|| {
            pa_types::skill_blocks::parse_skill_block(&normalized)
                .and_then(|block| self.skills.iter().find(|skill| skill.name == block.name))
        }) {
            if let Some(telemetry) = &self.skill_telemetry {
                let source = if busy {
                    match options.streaming_behavior {
                        Some(StreamingBehavior::Steer) => "steer",
                        // The busy-without-behavior case errors below; the
                        // queued label is the honest fallback.
                        Some(StreamingBehavior::FollowUp) | None => "follow_up",
                    }
                } else {
                    "prompt"
                };
                telemetry.note_skill_used(&skill.name, skill.kind_label(), source);
            }
        }
        if busy && options.streaming_behavior.is_none() {
            anyhow::bail!(
                "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            );
        }
        // User messages persist through the loop's `message_end` event (the
        // persistence subscription in `from_session_arc`), matching the TS
        // reference: `_processAgentEvent` is the only appendMessage path for
        // user prompts. Appending here as well would double-persist.

        if busy {
            let message = user_prompt_message(&normalized, &images);
            match options.streaming_behavior {
                Some(StreamingBehavior::Steer) => self.agent.steer(message),
                Some(StreamingBehavior::FollowUp) => self.agent.follow_up(message),
                None => unreachable!("busy without a streaming behavior errors above"),
            }
        } else {
            // The turn's prompt messages (TS preparedMessages): the deferred
            // first-turn harness digest rides first when one is due, so the
            // loop streams its message pair ahead of the user prompt and
            // carries it on `agent_end` (TS commit-time injection).
            let mut prompt_messages = Vec::new();
            if let Some(digest_row) = self.pending_digest_prompt_row().await? {
                prompt_messages.push(digest_row);
            }
            prompt_messages.extend(self.take_next_turn_rows().await);
            prompt_messages.push(user_prompt_message(&normalized, &images));
            // The batched co-delivery rows (TS `_startPreparedTurnActions`'s
            // `turns.flatMap(records)`): each batched action contributes its
            // user row after the primary, through the same admission
            // normalization (TS normalizes each submission at queue time;
            // this engine normalizes every row at the shared admission).
            for row in &options.batch {
                let row_text = if expand {
                    let (skill_expanded, _) =
                        crate::skills::expand_skill_command(&row.text, &self.skills);
                    crate::skills::expand_prompt_template(&skill_expanded, &self.prompt_templates)
                } else {
                    row.text.clone()
                };
                prompt_messages.push(user_prompt_message(&row_text, &row.images));
            }
            if options.return_after_accepted {
                // TS `returnAfterAccepted: true` — the connection's prompt
                // returns once the admitted turn delivers.
                self.agent
                    .prompt_until_accepted(pa_agent::agent::AgentPromptInput::Messages(
                        prompt_messages,
                    ))
                    .await?;
            } else {
                self.agent
                    .prompt(pa_agent::agent::AgentPromptInput::Messages(prompt_messages))
                    .await?;
            }
        }
        Ok(PromptOutcome::Prompt)
    }

    /// Queue one custom row for the next admitted turn (TS
    /// `_pendingNextTurnMessages.push`): the row rides the turn's prompt
    /// messages ahead of the prompt's own user row.
    pub async fn queue_next_turn_row(&self, message: pa_types::session::CustomMessage) {
        self.pending_next_turn_rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(message);
    }

    /// Adopt a shared next-turn mailbox (the engine's restore-notice
    /// seam): rows a kernel boot already parked before the session existed
    /// merge in, and later pushes land in the same queue the next admitted
    /// turn drains. The kernel provisioner outlives the construction order
    /// (its restore fires from a background boot), so the notice needs a
    /// mailbox shared across the build boundary rather than a callback
    /// bound to a session that does not exist yet.
    pub fn adopt_next_turn_rows(
        &mut self,
        shared: std::sync::Arc<std::sync::Mutex<Vec<pa_types::session::CustomMessage>>>,
    ) {
        let own_rows: Vec<_> = {
            let mut own = self
                .pending_next_turn_rows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            own.drain(..).collect()
        };
        {
            let mut next = shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // The shared mailbox is authoritative: rows parked pre-build
            // (a restore that finished during construction) come first,
            // then anything this session queued before adoption.
            next.extend(own_rows);
        }
        self.pending_next_turn_rows = shared;
    }

    /// Drain the queued next-turn rows (TS `_takePendingNextTurnMessages`):
    /// the admitting turn owns them; an empty take leaves nothing for later
    /// turns.
    pub async fn take_next_turn_rows(&self) -> Vec<pa_agent::types::AgentMessage> {
        self.pending_next_turn_rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain(..)
            .filter_map(|row| session_message_to_loop(&SessionAgentMessage::Custom(row)))
            .collect()
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
        // Git state is captured at both run boundaries, exactly like the TS
        // extension-event path: a commit or branch switch made during the run
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
