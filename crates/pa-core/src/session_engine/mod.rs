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
pub mod provider_retry;
pub mod refine;
pub mod rlm_host;
pub mod rlm_notices;
pub mod rlm_usage;
pub mod runtime;
pub mod runtime_wiring;
pub mod session_commands;
pub mod side_question;
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
    compaction: compaction::CompactionSettings,
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
            compaction: compaction::CompactionSettings::default(),
            auxiliary_model: None,
            auto_refine_allowed: false,
            auto_refine: refine::AutoRefineGates::default(),
            compact_auto_refine: std::sync::Mutex::default(),
            kernel_state: None,
            pending_next_turn_rows: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            skills: Vec::new(),
            skill_telemetry: None,
        };
        this.ensure_harness_digest_context().await?;
        Ok(this)
    }

    /// Override the compaction settings from the session's resolved
    /// settings (TS `getCompactionSettings`); the engine wiring calls this
    /// so `/compact` honors `compaction.keepRecentTokens`/`reserveTokens`
    /// like the TS product instead of the defaults.
    pub fn set_compaction_settings(&mut self, settings: compaction::CompactionSettings) {
        self.compaction = settings;
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
        self.compaction.enabled
    }

    /// The resolved compaction settings (TS `getCompactionSettings`): the
    /// in-run continuation consult reads the threshold headroom without
    /// owning the session (a compaction in flight owns it across its
    /// model turn).
    pub fn compaction_settings(&self) -> &compaction::CompactionSettings {
        &self.compaction
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
            &self.compaction,
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
        let digest_inputs = self.harness_digest_inputs().await;
        let mut outcome = {
            let mut session = self.session.lock().await;
            crate::session_engine::compact_session::execute_compaction(
                &mut session,
                crate::session_engine::compact_session::CompactOptions {
                    model: model.clone(),
                    api_key,
                    custom_instructions,
                    settings: self.compaction,
                    abort,
                    harness_digest: digest_inputs,
                    auxiliary: self.auxiliary_model.as_ref(),
                },
            )
            .await?
        };
        if matches!(outcome, CompactOutcome::Skipped(_)) {
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
        self.agent.set_messages(loop_messages).await;
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
        if let CompactOutcome::Ran(run) = &mut outcome {
            run.ipython_state = kernel_state;
        }
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
    /// busy under its admission rule, or the agent rejects the turn.
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
            self.agent
                .prompt(pa_agent::agent::AgentPromptInput::Messages(prompt_messages))
                .await?;
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
mod tests {
    use super::*;
    use pa_agent::agent::{AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;

    fn test_model() -> pa_agent::types::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    async fn scripted_session() -> AgentSession {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("hello from the model");
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        let tmp = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(tmp.path());
        AgentSession::new(Arc::new(agent), session, vec![])
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn prompt_persists_user_and_assistant() {
        let session = scripted_session().await;
        session
            .prompt("hi there", PromptOptions::default())
            .await
            .unwrap();
        session.agent().wait_for_idle().await;
        let entries = session.entries().await;
        let roles: Vec<String> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(format!("user:{}", user.content.text())),
                FileEntry::Message {
                    message: SessionAgentMessage::Assistant(assistant),
                    ..
                } => Some(format!("assistant:{}", assistant.model)),
                _ => None,
            })
            .collect();
        assert_eq!(
            roles,
            vec!["user:hi there".to_string(), "assistant:m".to_string()]
        );
    }

    #[tokio::test]
    async fn a_skill_command_prompt_expands_into_the_skill_block() {
        // TS `_expandSkillCommand`: a `/skill:<name> [args]` submission
        // persists as the `<skill>` block plus the argument text; the
        // renderer parses that block back out (TS `parseSkillBlock`).
        let mut session = scripted_session().await;
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("SKILL.md");
        std::fs::write(&file_path, "---\nname: web-search\n---\nRun a web search.").unwrap();
        session.set_skills(vec![crate::skills::Skill {
            name: "web-search".to_string(),
            description: "search the web".to_string(),
            file_path: file_path.clone(),
            base_dir: dir.path().to_path_buf(),
            source_info: crate::skills::create_synthetic_source_info(
                &file_path.display().to_string(),
                "user",
                crate::skills::SourceScope::User,
                None,
            ),
            disable_model_invocation: false,
            kind: crate::skills::SkillKind::Markdown,
            python: None,
        }]);
        session
            .prompt("/skill:web-search find rust tuis", PromptOptions::default())
            .await
            .unwrap();
        session.agent().wait_for_idle().await;
        let entries = session.entries().await;
        let user_text = entries
            .iter()
            .find_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(user.content.text()),
                _ => None,
            })
            .expect("user message persisted");
        let parsed = pa_types::skill_blocks::parse_skill_block(&user_text)
            .expect("the persisted user message is a skill block");
        assert_eq!(parsed.name, "web-search");
        assert_eq!(
            parsed.user_message.as_deref(),
            Some("find rust tuis"),
            "args persist as the trailing user message"
        );
        assert!(parsed.content.contains("Run a web search."));
    }

    #[tokio::test]
    async fn an_unknown_skill_command_passes_through() {
        let session = scripted_session().await;
        session
            .prompt("/skill:missing do a thing", PromptOptions::default())
            .await
            .unwrap();
        session.agent().wait_for_idle().await;
        let entries = session.entries().await;
        let user_text = entries
            .iter()
            .find_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(user.content.text()),
                _ => None,
            })
            .expect("user message persisted");
        assert_eq!(user_text, "/skill:missing do a thing");
    }

    /// A scripted session wired like the engine wires production sessions:
    /// the engine-level `convert_to_llm` plus a harness-digest context, so
    /// the deferred first-turn digest rides the first prompt.
    async fn digest_session(provider: Arc<ScriptedProvider>) -> (AgentSession, tempfile::TempDir) {
        let agent = Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            convert_to_llm: Some(crate::session_engine::messages::engine_convert_to_llm()),
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        });
        let tmp = tempfile::tempdir().unwrap();
        let harness = crate::session_engine::harness_digest::HarnessDigestContext {
            global_dir: tmp.path().join("harness"),
            local_dir: None,
            include_ipython: false,
            include_shell_examples: false,
            include_refine: false,
        };
        let session = AgentSession::from_session_arc(
            Arc::new(agent),
            Arc::new(tokio::sync::Mutex::new(SessionManager::in_memory(
                tmp.path(),
            ))),
            vec![],
            Some(harness),
        )
        .await
        .unwrap();
        (session, tmp)
    }

    fn user_text(message: &pa_agent::types::Message) -> String {
        let pa_agent::types::Message::User(user) = message else {
            panic!("expected user message");
        };
        match &user.content {
            pa_agent::types::UserContent::Text(text) => text.clone(),
            pa_agent::types::UserContent::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    pa_agent::types::UserPart::Text(text) => Some(text.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    #[tokio::test]
    async fn prompt_rides_digest_row_into_the_run() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("hello from the model");
        provider.push_text_turn("second answer");
        let (session, _tmp) = digest_session(Arc::clone(&provider)).await;
        let events: Arc<std::sync::Mutex<Vec<AgentEvent>>> = Arc::default();
        let sink = Arc::clone(&events);
        session
            .agent()
            .subscribe(move |event, _signal| {
                let sink = Arc::clone(&sink);
                Box::pin(async move {
                    sink.lock().unwrap().push(event);
                    Ok(())
                })
            })
            .await;
        session
            .prompt("hi there", PromptOptions::default())
            .await
            .unwrap();
        session.agent().wait_for_idle().await;

        // The run's agent_end carries the digest custom row with the turn's
        // prompt messages (TS parity: the digest rides `agent_end.messages`).
        // The lock snapshots the captured events and never crosses an await.
        let (end_messages, kinds) = {
            let captured = events.lock().unwrap();
            let Some(AgentEvent::AgentEnd { messages }) = captured
                .iter()
                .rev()
                .find(|event| matches!(event, AgentEvent::AgentEnd { .. }))
            else {
                panic!("no agent_end event");
            };
            let kinds: Vec<String> = captured
                .iter()
                .filter_map(|event| match event {
                    AgentEvent::TurnStart => Some("turn_start".to_string()),
                    AgentEvent::MessageStart { message } | AgentEvent::MessageEnd { message } => {
                        Some(message.role().to_string())
                    }
                    _ => None,
                })
                .collect();
            (messages.clone(), kinds)
        };
        let roles: Vec<&str> = end_messages
            .iter()
            .map(pa_agent::types::AgentMessage::role)
            .collect();
        assert_eq!(roles, vec!["custom", "user", "assistant"]);
        let AgentMessage::Custom(custom) = &end_messages[0] else {
            panic!("expected digest custom row");
        };
        assert_eq!(
            custom
                .payload
                .get("customType")
                .and_then(serde_json::Value::as_str),
            Some(crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        );
        // The message pair streamed ahead of the user prompt's pair.
        assert_eq!(
            kinds,
            vec![
                "turn_start",
                "custom",
                "custom",
                "user",
                "user",
                "assistant",
                "assistant"
            ]
        );

        // The provider request carries the digest as a user turn ahead of
        // the prompt (the engine-level conversion at the LLM boundary).
        let calls = provider.calls();
        assert_eq!(calls.len(), 1);
        assert!(user_text(&calls[0].messages[0]).contains("[harness-digest]"));
        assert_eq!(user_text(&calls[0].messages[1]), "hi there");

        // The digest persisted exactly once (the loop's message_end), ahead
        // of the user row.
        let entries = session.entries().await;
        let digest_rows = entries
            .iter()
            .filter(|entry| {
                matches!(entry, FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type
                        == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
            })
            .count();
        assert_eq!(digest_rows, 1);

        // The second prompt does not re-deliver: the flag is consumed and the
        // delivered row is the newest in-context digest.
        session
            .prompt("again", PromptOptions::default())
            .await
            .unwrap();
        session.agent().wait_for_idle().await;
        let calls = provider.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(user_text(calls[1].messages.last().unwrap()), "again");
        // The second run's agent_end carries no digest row.
        let second_end_roles: Vec<String> = {
            let captured = events.lock().unwrap();
            captured
                .iter()
                .rev()
                .find_map(|event| match event {
                    AgentEvent::AgentEnd { messages } => Some(
                        messages
                            .iter()
                            .map(|message| message.role().to_string())
                            .collect::<Vec<String>>(),
                    ),
                    _ => None,
                })
                .expect("no second agent_end event")
        };
        assert_eq!(second_end_roles, vec!["user", "assistant"]);
        let entries = session.entries().await;
        let digest_rows = entries
            .iter()
            .filter(|entry| {
                matches!(entry, FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type
                        == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
            })
            .count();
        assert_eq!(digest_rows, 1);
    }

    /// An injected custom message admits as the turn's prompt (TS
    /// `_promptInjectedMessage` -> `agent.prompt([customMessage])`): the
    /// transcript and the loop context hold ONE representation of the
    /// turn — the custom row, appended once by the loop's `message_end`
    /// — and the provider request carries the row's user-role view (the
    /// loop-boundary conversion), never a duplicate user message.
    #[tokio::test]
    async fn prompt_injected_message_persists_one_custom_row() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("notice acknowledged");
        let (session, _tmp) = digest_session(Arc::clone(&provider)).await;
        let notice_text = "[child-exited: no-reply child:lane]";
        let notice = pa_types::session::CustomMessage {
            custom_type: "rlm_child_terminal_notice".to_string(),
            content: pa_types::ai::UserContent::Text(notice_text.to_string()),
            display: true,
            details: Some(serde_json::json!({
                "kind": "completed_without_reply",
                "childId": "sub-1",
                "sessionName": "lane",
            })),
            timestamp: 0,
            rest: Default::default(),
        };
        session.prompt_injected_message(&notice).await.unwrap();
        session.agent().wait_for_idle().await;

        // The provider request carries the notice text as its user-role
        // view — once, with no duplicate user message (TS `convertToLlm`
        // at the loop boundary). The first-turn harness digest rides
        // ahead of it (TS commit-time injection), exactly like a plain
        // prompt's request.
        let calls = provider.calls();
        assert_eq!(calls.len(), 1);
        let user_texts: Vec<String> = calls[0]
            .messages
            .iter()
            .filter(|message| matches!(message, pa_agent::types::Message::User(_)))
            .map(user_text)
            .collect();
        assert_eq!(user_texts.len(), 2, "digest plus notice: {calls:?}");
        assert_eq!(user_texts[1], notice_text);
        assert_eq!(
            user_texts
                .iter()
                .filter(|text| *text == notice_text)
                .count(),
            1,
            "no duplicate user message: {calls:?}"
        );

        // One representation in the transcript: the custom row, exactly
        // once, and no user row with the same text.
        let entries = session.entries().await;
        let notice_rows = entries
            .iter()
            .filter(|entry| match entry {
                FileEntry::CustomMessage { payload, .. } => {
                    payload.custom_type == "rlm_child_terminal_notice"
                }
                _ => false,
            })
            .count();
        assert_eq!(notice_rows, 1);
        let user_rows = entries
            .iter()
            .filter(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => user.content.text().contains(notice_text),
                _ => false,
            })
            .count();
        assert_eq!(
            user_rows, 0,
            "the injected turn must not persist a user row"
        );
    }

    /// A delivered agent message's custom row produces the byte-identical
    /// provider context to the plain-prompt delivery (TS
    /// `acceptAgentMessagePrompt`: the custom message replaces the turn's
    /// user row while its prompt content still runs the model). The
    /// comparison covers the whole request - system prompt, tools, and
    /// every message row - with only the per-run timestamps normalized.
    #[tokio::test]
    async fn an_agent_message_custom_row_matches_the_plain_prompt_context() {
        let prompt = "[agent-message from child:research-lane]\n\nthe research is done";

        // The plain delivery: the prompt text as the accepted user row.
        let plain_provider = Arc::new(ScriptedProvider::new(test_model()));
        plain_provider.push_text_turn("ack");
        let (plain_session, _plain_tmp) = digest_session(Arc::clone(&plain_provider)).await;
        plain_session
            .prompt(prompt, PromptOptions::default())
            .await
            .unwrap();
        plain_session.agent().wait_for_idle().await;

        // The delivered shape: the `agent_message` custom row whose content
        // is the same prompt (TS `createAgentSessionMessage`).
        let row_provider = Arc::new(ScriptedProvider::new(test_model()));
        row_provider.push_text_turn("ack");
        let (row_session, _row_tmp) = digest_session(Arc::clone(&row_provider)).await;
        let row = pa_types::session::CustomMessage {
            custom_type: crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE
                .to_string(),
            content: pa_types::ai::UserContent::Text(prompt.to_string()),
            display: true,
            details: Some(serde_json::json!({
                "id": "agentmsg_golden",
                "message": "the research is done",
                "from": {
                    "activeSessionId": "child-1",
                    "sessionName": "research-lane",
                },
                "fromRelationship": "child",
                "target": { "activeSessionId": "parent-1" },
            })),
            timestamp: 0,
            rest: Default::default(),
        };
        row_session.prompt_injected_message(&row).await.unwrap();
        row_session.agent().wait_for_idle().await;

        let plain_calls = plain_provider.calls();
        let row_calls = row_provider.calls();
        assert_eq!(plain_calls.len(), 1);
        assert_eq!(row_calls.len(), 1);
        assert_eq!(
            normalized_context(&plain_calls[0]),
            normalized_context(&row_calls[0]),
            "the agent_message row must not change the provider request"
        );
    }

    /// The provider request with the per-run message timestamps zeroed
    /// (each delivery mints its own runtime stamp; every other byte is
    /// compared).
    fn normalized_context(context: &pa_agent::stream::LlmContext) -> serde_json::Value {
        let mut value = serde_json::to_value(context).unwrap();
        for message in value["messages"].as_array_mut().unwrap() {
            if let Some(timestamp) = message.get_mut("timestamp") {
                *timestamp = serde_json::json!(0);
            }
        }
        value
    }

    #[tokio::test]
    async fn prompt_persists_tool_results() {
        struct EchoTool;
        impl pa_agent::types::AgentTool for EchoTool {
            fn name(&self) -> &str {
                "echo"
            }
            fn description(&self) -> &str {
                "echo the call"
            }
            fn parameters(&self) -> &serde_json::Value {
                static PARAMETERS: std::sync::OnceLock<serde_json::Value> =
                    std::sync::OnceLock::new();
                PARAMETERS.get_or_init(|| serde_json::json!({ "type": "object" }))
            }
            fn execute(
                self: Arc<Self>,
                _tool_call_id: String,
                _params: serde_json::Value,
                _signal: pa_agent::abort::AbortSignal,
                _on_update: pa_agent::types::AgentToolUpdateCallback,
            ) -> pa_agent::BoxFut<'static, anyhow::Result<pa_agent::types::AgentToolResult>>
            {
                Box::pin(async { Ok(pa_agent::types::AgentToolResult::text("tool output")) })
            }
        }
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_tool_call_turn(
            Some("calling"),
            vec![("call-1", "echo", serde_json::json!({}))],
        );
        provider.push_text_turn("done");
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        agent.set_tools(vec![Arc::new(EchoTool)]).await;
        let tmp = tempfile::tempdir().unwrap();
        let session = SessionManager::persisted(std::path::Path::new("/w"), tmp.path());
        let engine = AgentSession::new(Arc::new(agent), session, vec![])
            .await
            .unwrap();
        engine.prompt("hi", PromptOptions::default()).await.unwrap();
        engine.agent().wait_for_idle().await;
        let entries = engine.entries().await;
        let roles: Vec<&str> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message { message, .. } => Some(match message {
                    SessionAgentMessage::User(_) => "user",
                    SessionAgentMessage::Assistant(_) => "assistant",
                    SessionAgentMessage::ToolResult(_) => "toolResult",
                    _ => "other",
                }),
                _ => None,
            })
            .collect();
        assert_eq!(
            roles,
            vec!["user", "assistant", "toolResult", "assistant"],
            "entries: {entries:?}"
        );
        let tool_result = entries
            .iter()
            .find_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::ToolResult(result),
                    ..
                } => Some(result.clone()),
                _ => None,
            })
            .expect("toolResult entry persisted");
        // Whole-object compare through the TS wire shape (timestamp is
        // turn-dependent and asserted only by type).
        let value = serde_json::to_value(SessionAgentMessage::ToolResult(tool_result)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "echo",
                "content": [{ "type": "text", "text": "tool output" }],
                "isError": false,
                "timestamp": value["timestamp"],
            })
        );
        // The persisted file line carries the live-TS entry envelope: the
        // message under `message`, chained to its assistant parent.
        let file = tmp
            .path()
            .join(format!("{}.jsonl", engine.session_id().await))
            .to_string_lossy()
            .to_string();
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(file)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let entry = lines
            .iter()
            .find(|entry| {
                entry.get("message").and_then(|m| m.get("role"))
                    == Some(&serde_json::json!("toolResult"))
            })
            .expect("toolResult entry on disk");
        assert_eq!(entry["type"], "message");
        assert_eq!(entry["message"]["toolCallId"], "call-1");
        assert_eq!(entry["message"]["content"][0]["text"], "tool output");
        assert_eq!(entry["message"]["isError"], false);
        assert!(entry["id"].as_str().is_some_and(|id| id.len() == 8));
        assert!(entry["parentId"].as_str().is_some());
        assert!(entry["timestamp"].as_str().is_some());
    }

    /// A `toolResult` entry captured from a live TS session (read-only, from
    /// the installed product's own session store) parses into the Rust
    /// session types and re-serializes to the identical wire shape.
    #[test]
    fn ts_toolresult_entry_round_trips() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/golden/corpus/toolresult-entry-live-ts.json"
        ))
        .unwrap();
        let entry: FileEntry = serde_json::from_value(golden.clone()).unwrap();
        let FileEntry::Message {
            message: SessionAgentMessage::ToolResult(tool_result),
            base,
        } = &entry
        else {
            panic!("golden entry is not a toolResult message: {entry:?}");
        };
        assert_eq!(tool_result.tool_name, "ipython");
        assert_eq!(
            tool_result.tool_call_id,
            "c2425715-419e-4d06-a101-a78da1969b96"
        );
        assert!(!tool_result.is_error);
        assert_eq!(base.id.clone().unwrap_or_default().len(), 8);
        assert_eq!(base.parent_id.as_deref(), Some("8902561b"));
        // The ipython `details` block survives the round trip intact.
        assert_eq!(
            tool_result.details,
            Some(serde_json::json!({
                "durationMs": 10,
                "status": "ok",
                "stdout": "/root/prime-agent-rs\n['.git', 'MISSION.md', 'README.md', 'WATCHDOG.md']\nTrue\n",
                "stderr": "",
                "kernelRestarted": false
            }))
        );
        // Re-serialization is byte-identical (stable wire shape).
        let serialized = serde_json::to_value(&entry).unwrap();
        assert_eq!(serialized, golden);
    }

    #[tokio::test]
    async fn template_expansion_applies() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("ok");
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        let tmp = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(tmp.path());
        let template = PromptTemplate {
            name: "fix".to_string(),
            description: "fix".to_string(),
            argument_hint: None,
            content: "Fix $1 please".to_string(),
            source_info: crate::skills::create_synthetic_source_info(
                "/p",
                "local",
                crate::skills::SourceScope::User,
                None,
            ),
            file_path: "/p/fix.md".to_string(),
        };
        let engine = AgentSession::new(Arc::new(agent), session, vec![template])
            .await
            .unwrap();
        engine
            .prompt("/fix lint", PromptOptions::default())
            .await
            .unwrap();
        engine.agent().wait_for_idle().await;
        let entries = engine.entries().await;
        let user_text = entries
            .iter()
            .find_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(user.content.text()),
                _ => None,
            })
            .unwrap();
        assert_eq!(user_text, "Fix lint please");
    }

    /// Git state is captured at both run boundaries (TS `_emitExtensionEvent`
    /// calls `recordGitStateIfChanged` on `agent_start`/`agent_end`): a commit
    /// made between session creation and the run lands as a `git_state`
    /// entry, and an unchanged context at `agent_end` adds nothing.
    #[tokio::test]
    async fn run_boundaries_record_git_state() {
        fn git(cwd: &std::path::Path, args: &[&str]) {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git is available in the test environment");
            assert!(output.status.success(), "git {args:?} failed");
        }
        fn commit(dir: &std::path::Path, message: &str) -> String {
            std::fs::write(dir.join("file.txt"), format!("{message}\n")).unwrap();
            git(dir, &["add", "-A"]);
            git(dir, &["commit", "-q", "-m", message]);
            let output = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(dir)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        let repo = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q", "-b", "main"]);
        git(repo.path(), &["config", "user.email", "t@t.co"]);
        git(repo.path(), &["config", "user.name", "t"]);
        commit(repo.path(), "init");

        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("ok");
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        let session = SessionManager::persisted(repo.path(), sessions.path());
        let engine = AgentSession::new(Arc::new(agent), session, vec![])
            .await
            .unwrap();

        // The run starts on a newer commit than the header captured.
        let second_sha = commit(repo.path(), "second");
        engine.prompt("hi", PromptOptions::default()).await.unwrap();
        engine.agent().wait_for_idle().await;

        let entries = engine.entries().await;
        let git_states: Vec<_> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::GitState { payload, .. } => Some(payload.git.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(git_states.len(), 1, "one git_state per changed context");
        assert_eq!(git_states[0].commit.as_deref(), Some(second_sha.as_str()));
        assert_eq!(git_states[0].branch.as_deref(), Some("main"));
    }
}

#[cfg(test)]
mod slash_session_tests {
    use super::*;
    use pa_agent::agent::{AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;

    fn test_model() -> pa_agent::types::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn session_commands_never_reach_the_model() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("unused");
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        let tmp = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(tmp.path());
        let engine = AgentSession::new(Arc::new(agent), session, vec![])
            .await
            .unwrap();
        let outcome = engine
            .prompt("/compact focus on tests", PromptOptions::default())
            .await
            .unwrap();
        match &outcome {
            PromptOutcome::SessionCommand(command) => {
                assert_eq!(command.name, "compact");
                assert_eq!(command.args, "focus on tests");
            }
            _ => panic!("expected a session command"),
        }
        // No model call and no persisted user message.
        assert!(provider.calls().is_empty());
        assert!(engine.entries().await.is_empty());
    }
}

#[cfg(test)]
mod compaction_outcome_tests {
    use super::*;
    use crate::session_engine::messages::{
        convert_to_llm, create_compaction_outcome_message, CompactionOutcomeKind,
        CompactionOutcomeReason,
    };
    use pa_agent::agent::{AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;
    use pa_types::ai::AssistantMessage;

    fn test_model() -> pa_agent::types::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    async fn scripted_session_over(session: SessionManager) -> AgentSession {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        let options = AgentOptions {
            initial_state: AgentInitialState {
                model: Some(test_model()),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = Agent::new(options);
        AgentSession::new(Arc::new(agent), session, vec![])
            .await
            .unwrap()
    }

    fn seeded_assistant() -> SessionAgentMessage {
        SessionAgentMessage::Assistant(AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Default::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        })
    }

    /// The disclosure row's shape (TS `createCompactionOutcomeMessage`):
    /// customType `compaction_outcome`, the outcome message as text content,
    /// displayed, `{reason, outcome}` details.
    #[test]
    fn outcome_row_shape_matches_ts() {
        let row = create_compaction_outcome_message(
            "Auto-compaction skipped: Session is too short to compact — try again once it grows",
            CompactionOutcomeReason::Threshold,
            CompactionOutcomeKind::Skipped,
        );
        assert_eq!(row.custom_type, "compaction_outcome");
        assert_eq!(
            row.content.text(),
            "Auto-compaction skipped: Session is too short to compact — try again once it grows"
        );
        assert!(row.display);
        assert_eq!(
            row.details,
            Some(serde_json::json!({ "reason": "threshold", "outcome": "skipped" }))
        );
        assert!(row.timestamp > 0);
        let wire = serde_json::to_value(SessionAgentMessage::Custom(row)).unwrap();
        assert_eq!(wire["role"], "custom");
        assert_eq!(wire["customType"], "compaction_outcome");
    }

    /// The seam (TS `_persistCompactionOutcome`): the row lands in the
    /// session entry chain and on the live loop context, a context rebuild
    /// over the entries keeps it, and the LLM conversion drops it — the
    /// model never sees the disclosure, so the KV-cacheable prefix is
    /// unaffected (TS `agent-session-compaction.test.ts` pins the same
    /// exclusion).
    #[tokio::test]
    async fn record_appends_row_to_entries_and_live_context_but_not_llm_input() {
        let tmp = tempfile::tempdir().unwrap();
        let session = scripted_session_over(SessionManager::in_memory(tmp.path())).await;
        let row = session
            .record_compaction_outcome(
                CompactionOutcomeReason::Requested,
                CompactionOutcomeKind::Failed,
                "Requested compaction failed: Summarization failed",
            )
            .await
            .unwrap();
        // The entry chain owns the row (context rebuilds read it).
        let entries = session.entries().await;
        let outcome_entries: Vec<_> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == "compaction_outcome" =>
                {
                    Some(payload.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(outcome_entries.len(), 1, "one durable outcome row");
        assert_eq!(
            outcome_entries[0].content.text(),
            "Requested compaction failed: Summarization failed"
        );
        assert_eq!(
            outcome_entries[0].details,
            Some(serde_json::json!({ "reason": "requested", "outcome": "failed" }))
        );
        assert!(outcome_entries[0].display);
        // The live loop context owns the disclosure (TS
        // `agent.state.messages.push`).
        let state = session.agent().state().await;
        assert!(
            matches!(
                state.messages.last(),
                Some(AgentMessage::Custom(custom)) if custom.role == "custom"
            ),
            "the live context carries the outcome row"
        );
        // A rebuild over the session entries keeps the disclosure (the TS
        // `_unpersistedOutcomes` invariant: a rebuild cannot drop it).
        let guard = session.session.lock().await;
        let context =
            crate::session::build_session_context(guard.get_all_entries(), guard.get_leaf_id());
        drop(guard);
        assert!(
            context
                .messages
                .iter()
                .any(|message| matches!(message, SessionAgentMessage::Custom(custom) if custom.custom_type == "compaction_outcome")),
            "the rebuilt context keeps the outcome row"
        );
        // Model context exclusion: the LLM conversion drops the row.
        assert!(convert_to_llm(std::slice::from_ref(&SessionAgentMessage::Custom(row))).is_empty());
    }

    /// The disclosure survives a failed disk write (the TS
    /// `_unpersistedOutcomes` fallback's guarantee): the entry chain keeps
    /// the row in memory, so a context rebuild never drops it even when the
    /// session file could not be written.
    #[tokio::test]
    async fn record_survives_a_failed_disk_write() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let mut manager = SessionManager::persisted(tmp.path(), &sessions);
        manager.append_message(seeded_assistant()).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        assert!(file.exists(), "the session file materialized");
        // Replace the session file with a directory at the same path: every
        // disk write path fails (the append line and the atomic rename),
        // even for root (permission bits would not stop root).
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let session = scripted_session_over(manager).await;
        session
            .record_compaction_outcome(
                CompactionOutcomeReason::Threshold,
                CompactionOutcomeKind::Skipped,
                "Auto-compaction skipped: Already compacted",
            )
            .await
            .unwrap();
        // The write failed (the file path is a directory) — but the entry
        // chain and a context rebuild keep the disclosure.
        let entries = session.entries().await;
        assert!(
            entries.iter().any(
                |entry| matches!(entry, FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == "compaction_outcome")
            ),
            "the outcome row stays in the entry chain after the failed write"
        );
        let guard = session.session.lock().await;
        let context =
            crate::session::build_session_context(guard.get_all_entries(), guard.get_leaf_id());
        drop(guard);
        assert!(
            context
                .messages
                .iter()
                .any(|message| matches!(message, SessionAgentMessage::Custom(custom) if custom.custom_type == "compaction_outcome")),
            "a rebuild cannot drop the disclosure"
        );
    }

    /// The subscriber arm (TS `_processAgentEvent` on `_agentEventQueue`
    /// whose `.catch(() => {})` swallows persistence failures) never fails
    /// the run for a write error: the loop already owns the row in live
    /// state, so the session retains it and the error only logs — no error
    /// assistant row lands in either store.
    #[tokio::test]
    async fn message_end_persist_failure_retains_the_row_and_swallows() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let mut manager = SessionManager::persisted(tmp.path(), &sessions);
        manager.append_message(seeded_assistant()).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let session = scripted_session_over(manager).await;
        let before = session
            .session
            .lock()
            .await
            .get_all_entries()
            .to_vec()
            .len();
        persist_event(
            &session.session,
            AgentEvent::MessageEnd {
                message: AgentMessage::user("retained after the failed write"),
            },
        )
        .await
        .expect("a failed disk write must not fail the event queue");
        let guard = session.session.lock().await;
        let entries = guard.get_all_entries().to_vec();
        drop(guard);
        assert_eq!(entries.len(), before + 1, "the row stays live-indexed");
        assert!(
            !entries
                .iter()
                .any(|entry| matches!(entry, FileEntry::Message {
                    message: SessionAgentMessage::Assistant(assistant),
                    ..
                } if assistant.error_message.is_some())),
            "no phantom error row for a persistence failure"
        );
        let context = crate::session::build_session_context(
            &entries,
            entries
                .last()
                .and_then(|entry| entry.id().map(str::to_owned))
                .as_deref(),
        );
        assert!(
            serde_json::to_string(&context.messages)
                .unwrap()
                .contains("retained after the failed write"),
            "a context rebuild keeps the retained row"
        );
    }
}
