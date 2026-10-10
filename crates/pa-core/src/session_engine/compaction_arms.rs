use super::compact_session::CompactOutcome;
use super::{
    compaction, compaction_trace, ipython_state, provider_adapter, rebuilt_loop_messages, refine,
    session_message_to_loop, standard_message, AgentMessage, AgentSession, BackgroundFlight,
    FileEntry, SessionAgentMessage, TrailingAssistantFilter,
};

impl AgentSession {
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

    /// The live loop context's pressure band over the model's window.
    pub async fn context_pressure(
        &self,
        model: &pa_types::ai::Model,
    ) -> compaction::ContextPressure {
        let state = self.agent.state().await;
        // The live loop context is the agent's message list (the same
        // JSON round-trip `compact` uses).
        let messages: Vec<SessionAgentMessage> = state
            .messages
            .iter()
            .filter_map(|message| serde_json::to_value(message).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        compaction::context_pressure(
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

    /// The relief window and request output budget `context_pressure`
    /// measures `model` against — a joined summary must relieve the same
    /// limits the pressure decision used.
    async fn relief_limits(&self, model: &pa_types::ai::Model) -> (u64, u64) {
        let thinking_level =
            provider_adapter::model_thinking_level(self.agent.state().await.thinking_level);
        (
            model.context_window,
            compaction::request_output_budget(model, thinking_level),
        )
    }

    /// Whether a joined background summary may commit: its prepared prefix
    /// is intact and the rebuilt context relieves `relief_model`'s blocking
    /// threshold.
    async fn joined_summary_usable(
        &self,
        summary: &crate::session_engine::compact_session::BackgroundSummary,
        relief_model: &pa_types::ai::Model,
    ) -> bool {
        let (context_window, max_output_tokens) = self.relief_limits(relief_model).await;
        let settings = self.compaction_settings();
        let session = self.session.lock().await;
        crate::session_engine::compact_session::joined_summary_relieves(
            &session,
            &summary.attempt,
            &summary.prepared,
            context_window,
            max_output_tokens,
            &settings,
        )
    }

    /// Whether the threshold compaction must run at this boundary; starts
    /// the background summarize at the watermark.
    pub async fn auto_compaction_now(
        &self,
        run_model: &pa_types::ai::Model,
        summarizer_model: &pa_types::ai::Model,
        api_key: Option<String>,
    ) -> bool {
        match self.context_pressure(run_model).await {
            compaction::ContextPressure::Reserve => true,
            compaction::ContextPressure::Background => {
                // The band never blocks: every consult resolves a finished
                // summarize here (the await is immediate) and re-validates
                // the candidate — fresh or carried over from an earlier
                // consult — against the current transcript and the armed
                // run model. A failed or stale join is discarded, and the
                // restart below retries in the background; only the reserve
                // crossing may block on a fresh summarize.
                let due = match self.compaction_flight.try_lock() {
                    Ok(mut slot) => {
                        let resolved = match slot.take() {
                            Some(BackgroundFlight::Summarizing(handle)) if handle.is_finished() => {
                                handle
                                    .await
                                    .ok()
                                    .and_then(Result::ok)
                                    .map(|summary| BackgroundFlight::Ready(Box::new(summary)))
                            }
                            other => other,
                        };
                        *slot = match resolved {
                            Some(BackgroundFlight::Ready(summary)) => {
                                if self.joined_summary_usable(&summary, run_model).await {
                                    Some(BackgroundFlight::Ready(summary))
                                } else {
                                    None
                                }
                            }
                            other => other,
                        };
                        slot.as_ref()
                            .is_some_and(|flight| matches!(flight, BackgroundFlight::Ready(_)))
                    }
                    // A compact holds the flight: not due.
                    Err(_) => false,
                };
                if due {
                    true
                } else {
                    self.start_background_compaction(summarizer_model, api_key)
                        .await;
                    false
                }
            }
            compaction::ContextPressure::Below => false,
        }
    }

    /// Start the background watermark's summarize; a no-op while the flight or
    /// the slot is held.
    pub(crate) async fn start_background_compaction(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
    ) {
        let Ok(mut slot) = self.compaction_flight.try_lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let settings = self.compaction_settings();
        let semantic_edges = self.semantic_edges();
        let attempt = {
            let session = self.session.lock().await;
            let options = crate::session_engine::compact_session::CompactOptions {
                model: model.clone(),
                api_key: api_key.clone(),
                custom_instructions: None,
                settings,
                abort: None,
                harness_digest: None,
                auxiliary: self.auxiliary_model.as_ref(),
                summary_delta: None,
                semantic_edges: semantic_edges.clone(),
            };
            match crate::session_engine::compact_session::prepare_attempt(&session, &options) {
                Ok(attempt) => attempt,
                Err(_) => return,
            }
        };
        let harness_digest = self.harness_digest_inputs().await;
        let model = model.clone();
        let auxiliary = self.auxiliary_model.clone();
        let started_at = std::time::Instant::now();
        // A failed summarize resolves as the task's own error result — the
        // band's boundary reads it, discards it, and retries here.
        let task = tokio::spawn(async move {
            let options = crate::session_engine::compact_session::CompactOptions {
                model,
                api_key,
                custom_instructions: None,
                settings,
                abort: None,
                harness_digest,
                auxiliary: auxiliary.as_ref(),
                summary_delta: None,
                semantic_edges,
            };
            let prepared =
                crate::session_engine::compact_session::summarize_attempt(&attempt, &options)
                    .await?;
            Ok(crate::session_engine::compact_session::BackgroundSummary {
                attempt,
                prepared,
                summarize_ms: started_at.elapsed().as_millis() as u64,
            })
        });
        *slot = Some(BackgroundFlight::Summarizing(
            tokio_util::task::AbortOnDropHandle::new(task),
        ));
    }

    /// Remove the trailing assistant message from the loop context, so a
    /// re-issued request does not re-send the failed turn's error message;
    /// [`TrailingAssistantFilter::ErrorOnly`] drops only an error assistant.
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

    /// Drop the failed continuation pair from the live loop context: the
    /// trailing no-progress assistant row and the `goal_context` continuation
    /// row that drove it. A USER turn's corpse stays; only the live loop drops
    /// (like [`Self::drop_trailing_assistant`]).
    pub async fn drop_failed_goal_continuation(&self) {
        // The whole drop runs under ONE state lock (the atomic mutate): a
        // concurrent append cannot drop rows between the snapshot and replace.
        self.agent
            .mutate_messages(|messages| {
                // The failed assistant row: the LAST assistant, not the last row —
                // a trailing `provider_retry_outcome` disclosure must not hide
                // the pair from the cleanup.
                let Some(corpse_index) = messages
                    .iter()
                    .rposition(|message| standard_message(message).is_some())
                else {
                    return;
                };
                let Some(pa_agent::types::Message::Assistant(corpse)) =
                    messages.get(corpse_index).and_then(standard_message)
                else {
                    return;
                };
                let no_progress = corpse.stop_reason == pa_agent::types::StopReason::Error
                    || super::goal_driver::turn_produced_no_output(corpse);
                if !no_progress {
                    return;
                }
                // The driving continuation row sits under the corpse: scan backward
                // over Custom rows only — the first goal_context continuation row wins.
                let goal_context_row_at = messages[..corpse_index]
                    .iter()
                    .enumerate()
                    .rev()
                    .take_while(|(_, message)| {
                        matches!(message, pa_agent::types::AgentMessage::Custom(_))
                    })
                    .find(|(_, message)| {
                        let pa_agent::types::AgentMessage::Custom(custom) = message else {
                            return false;
                        };
                        custom
                            .payload
                            .get("customType")
                            .and_then(serde_json::Value::as_str)
                            == Some("goal_context")
                            && custom
                                .payload
                                .get("details")
                                .and_then(|details| details.get("kind"))
                                .and_then(serde_json::Value::as_str)
                                == Some("continuation")
                    })
                    .map(|(index, _)| index);
                let Some(context_index) = goal_context_row_at else {
                    return;
                };
                // Remove the later index first so the earlier one keeps its
                // position.
                messages.remove(corpse_index);
                messages.remove(context_index);
            })
            .await;
    }

    /// The last assistant message in the live loop context, in the session
    /// wire shape: trailing non-assistant rows are skipped.
    pub async fn last_assistant_message(&self) -> Option<SessionAgentMessage> {
        let state = self.agent.state().await;
        state.messages.iter().rev().find_map(|message| {
            let value = serde_json::to_value(message).ok()?;
            let message: SessionAgentMessage = serde_json::from_value(value).ok()?;
            matches!(message, SessionAgentMessage::Assistant(_)).then_some(message)
        })
    }

    /// Execute `/compact`: summarize the pre-cut prefix, persist the entry,
    /// and rebuild the loop context summary-first; a skip leaves the session
    /// untouched, an aborted run never commits.
    ///
    /// # Errors
    ///
    /// Returns the abort error, or the summarizer/persist failure; a skip is a normal `Ok` outcome.
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
        self.compact_with_relief_model(custom_instructions, model, model, api_key, abort)
            .await
    }

    /// [`Self::compact`] with the relief window following `run_model` — the
    /// model the pressure decision measured — while `model` still
    /// summarizes. The pressure-driven arms call this; the manual paths
    /// stay on [`Self::compact`].
    ///
    /// # Errors
    ///
    /// Returns the abort error, or the summarizer/persist failure; a skip is a normal `Ok` outcome.
    pub async fn compact_for_run_model(
        &self,
        custom_instructions: Option<&str>,
        run_model: &pa_types::ai::Model,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> anyhow::Result<CompactOutcome> {
        self.compact_with_relief_model(custom_instructions, run_model, model, api_key, abort)
            .await
    }

    /// The shared compaction body; `relief_model` is the window a joined
    /// background summary must relieve.
    ///
    /// # Errors
    ///
    /// Returns the abort error, or the summarizer/persist failure; a skip is a normal `Ok` outcome.
    ///
    /// # Panics
    ///
    /// Panics when the compaction summary sink slot's mutex is poisoned.
    async fn compact_with_relief_model(
        &self,
        custom_instructions: Option<&str>,
        relief_model: &pa_types::ai::Model,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> anyhow::Result<CompactOutcome> {
        compaction_trace::trace(
            "compact.enter",
            &serde_json::json!({
                "customInstructions": custom_instructions.is_some(),
            }),
        );
        let started_at = std::time::Instant::now();
        let summary_delta = self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock")
            .clone();
        let options = crate::session_engine::compact_session::CompactOptions {
            model: model.clone(),
            api_key,
            custom_instructions,
            settings: self.compaction_settings(),
            abort,
            // Captured per attempt inside `compaction_attempts`: a
            // conflict retry summarizes a new branch, and inputs captured
            // here would rank the abandoned branch's terms.
            harness_digest: None,
            auxiliary: self.auxiliary_model.as_ref(),
            summary_delta,
            semantic_edges: self.semantic_edges(),
        };
        // The flight spans the attempts, the rebuilt-context replace, and
        // the kernel-state notice: every path here REPLACES the live loop
        // context, and the other replacers — `refine_with_refiner`'s
        // outcome push and `record_compaction_outcome`'s failure row —
        // take the same flight. A row pushed onto the context must not
        // interleave with the replace: it would duplicate in the rebuilt
        // view or vanish under it while staying durable either way.
        let mut flight = self.compaction_flight.lock().await;
        let background = flight.take().filter(|_| custom_instructions.is_none());
        let mut outcome = self
            .compaction_attempts(&options, relief_model, started_at, background)
            .await?;
        if matches!(outcome, CompactOutcome::Skipped(_)) {
            compaction_trace::trace("compact.skipped", &serde_json::Value::Null);
            return Ok(outcome);
        }
        let rebuilt = {
            let session = self.session.lock().await;
            crate::session_engine::compact_session::rebuilt_context_after_compaction(&session)
        };
        let loop_messages: Vec<AgentMessage> = rebuilt_loop_messages(rebuilt);
        let rebuilt_message_count = loop_messages.len();
        self.agent.set_messages(loop_messages).await;
        compaction_trace::trace(
            "compact.rebuilt_context",
            &serde_json::json!({ "messages": rebuilt_message_count }),
        );
        // A kernel that survived the compaction gets its persistence notice —
        // a durable `ipython_state` row that also keeps a back-to-back second
        // `/compact` preparing (update mode) instead of skipping.
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
            &serde_json::json!({
                "notice": notice_landed,
            }),
        );
        Ok(outcome)
    }

    /// The PREPARE -> SUMMARIZE -> COMMIT loop: prepare under the session
    /// lock, summarize with no lock held (mid-window appends chain onto
    /// the leaf and ride the retained tail), then commit under the lock —
    /// a structural conflict retries from PREPARE, an aborted run stops.
    async fn compaction_attempts(
        &self,
        options: &crate::session_engine::compact_session::CompactOptions<'_>,
        relief_model: &pa_types::ai::Model,
        started_at: std::time::Instant,
        mut background: Option<BackgroundFlight>,
    ) -> anyhow::Result<CompactOutcome> {
        /// The conflict-retry bound: a branch that keeps changing under
        /// the compaction fails instead of re-summarizing forever.
        const MAX_COMPACTION_ATTEMPTS: usize = 3;
        for _ in 0..MAX_COMPACTION_ATTEMPTS {
            let mut joined = match background.take() {
                // A finished flight's await is immediate; an in-flight one
                // blocks — the reserve crossing's join.
                Some(BackgroundFlight::Summarizing(handle)) => {
                    handle.await.ok().and_then(Result::ok)
                }
                Some(BackgroundFlight::Ready(summary)) => Some(*summary),
                None => None,
            };
            if let Some(summary) = joined.as_ref() {
                if !self.joined_summary_usable(summary, relief_model).await {
                    joined = None;
                }
            }
            let (mut attempt, prepared, duration_ms) = if let Some(summary) = joined {
                (summary.attempt, summary.prepared, summary.summarize_ms)
            } else {
                let attempt = {
                    let session = self.session.lock().await;
                    match crate::session_engine::compact_session::prepare_attempt(&session, options)
                    {
                        Ok(attempt) => attempt,
                        Err(skip) => return Ok(CompactOutcome::Skipped(skip.user_message())),
                    }
                };
                // The digest ranks the branch THIS attempt summarizes: a
                // conflict retry prepares a new tree, and inputs captured
                // once before the loop would rank the abandoned branch's
                // terms. The capture takes the session lock itself, so it
                // runs off the prepare hold.
                let digest_inputs = self.harness_digest_inputs().await;
                compaction_trace::trace("compact.digest_captured", &serde_json::Value::Null);
                let attempt_options = crate::session_engine::compact_session::CompactOptions {
                    model: options.model.clone(),
                    api_key: options.api_key.clone(),
                    custom_instructions: options.custom_instructions,
                    settings: options.settings,
                    abort: options.abort,
                    harness_digest: digest_inputs,
                    auxiliary: options.auxiliary,
                    summary_delta: options.summary_delta.clone(),
                    semantic_edges: options.semantic_edges.clone(),
                };
                let prepared = crate::session_engine::compact_session::summarize_attempt(
                    &attempt,
                    &attempt_options,
                )
                .await?;
                (attempt, prepared, started_at.elapsed().as_millis() as u64)
            };
            let committed = {
                let mut session = self.session.lock().await;
                crate::session_engine::compact_session::commit_attempt(
                    &mut session,
                    &mut attempt,
                    &prepared,
                    options.abort,
                )?
            };
            if committed {
                return Ok(CompactOutcome::Ran(Box::new(
                    crate::session_engine::compact_session::CompactRun {
                        result: prepared.result,
                        entry: prepared.entry,
                        duration_ms,
                        ipython_state: None,
                    },
                )));
            }
            pa_agent::abort::throw_if_aborted_signal(options.abort)?;
        }
        Err(anyhow::anyhow!(
            "compaction retried {MAX_COMPACTION_ATTEMPTS} times while the branch kept changing; try again"
        ))
    }

    /// Record an unsuccessful compaction outcome: append the durable
    /// `compaction_outcome` row and push it onto the live loop context. The
    /// row is a user-facing disclosure, never model context (`convert_to_llm` drops it).
    ///
    /// # Errors
    ///
    /// Returns an error when the row cannot be appended or surfaced;
    /// it is retained in memory either way.
    pub async fn record_compaction_outcome(
        &self,
        reason: crate::session_engine::messages::CompactionOutcomeReason,
        outcome: crate::session_engine::messages::CompactionOutcomeKind,
        content: &str,
    ) -> anyhow::Result<pa_types::session::CustomMessage> {
        // The same flight as the other live-context replacers: the push
        // below read-modify-writes the live context, and a replace
        // interleaving it would roll the pushed row — or the replace —
        // back.
        let _flight = self.compaction_flight.lock().await;
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

    /// Rebuild the live loop context from a durable branch: the session adopts
    /// the branch entries, and the agent's message list rebuilds from the state.
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
        self.agent
            .set_messages(rebuilt_loop_messages(rebuilt))
            .await;
        Ok(())
    }

    /// Execute `/refine`: plan, re-read, apply, and persist the continual
    /// harness state for this session.
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
        self.refine_with_refiner(
            options,
            source,
            model,
            refine::default_refiner_call(api_key),
            global_harness_dir,
        )
        .await
    }

    /// [`Self::refine`] with an injected refiner call: the seam the parity
    /// tests use to drive the refinement without a provider.
    pub(crate) async fn refine_with_refiner(
        &self,
        options: &refine::RefineOptions,
        source: refine::RefinementSource,
        model: &pa_types::ai::Model,
        refine_call: crate::refinement::executor::RefinerFn,
        global_harness_dir: std::path::PathBuf,
    ) -> anyhow::Result<crate::refinement::RefinementResult> {
        // The flight serializes every live-context replacer against a
        // compaction's rebuild: this round's outcome rows persist and then
        // push onto the context the compaction replaces, so the push must
        // not interleave with a replace (duplicating in the rebuilt view
        // or vanishing under it).
        let _flight = self.compaction_flight.lock().await;
        // The transcript's consumed artifacts are extracted under this first
        // lock straight from the retained rows: no second clone of the rows.
        let parts = self.session.lock().await.refine_transcript_parts();
        let crate::session::manager::RefineTranscriptParts {
            messages,
            refinement_history,
        } = parts.await?;
        let (result, context_row_ids) = {
            let mut session = self.session.lock().await;
            // The factory opt-in resolves at apply time, not here: the
            // agent dir (the same settings.json the kernel-side factory
            // gate reads) rides down to the refinement, which re-reads
            // `factory.enabled` immediately before applying the plan, off
            // the async worker (`spawn_blocking`). The arm performs no
            // synchronous settings read while holding this session lock,
            // and the long planning request can no longer leave the gate
            // deciding on a snapshot the request made stale. A session
            // without a wired agent dir keeps the fail-closed disabled
            // default.
            refine::execute_refinement_with_rows(
                &mut session,
                refine::RefinementTranscript {
                    messages: &messages,
                    refinement_history: &refinement_history,
                },
                &global_harness_dir,
                model,
                options,
                source,
                refine_call,
                self.agent_dir.as_deref(),
            )
            .await?
        };
        // The outcome rows (and the notice row when any edit applied) push
        // onto the live context after the durable append, never a full rebuild
        // — a rebuild would resurrect a retried turn's dropped trailing
        // assistant. The pushed rows are THIS run's, under ONE agent-state lock.
        let rows = {
            let session = self.session.lock().await;
            refine::context_rows_by_ids(session.retained_entries(), &context_row_ids)
        };
        let loop_rows: Vec<AgentMessage> =
            rows.iter().filter_map(session_message_to_loop).collect();
        if !loop_rows.is_empty() {
            self.agent.append_messages(loop_rows).await;
        }
        Ok(result)
    }
}
