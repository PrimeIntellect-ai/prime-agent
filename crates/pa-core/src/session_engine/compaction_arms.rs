use super::compact_session::CompactOutcome;
use super::{
    compaction, compaction_trace, ipython_state, provider_adapter, rebuilt_loop_messages, refine,
    session_message_to_loop, standard_message, AgentMessage, AgentSession, FileEntry,
    SessionAgentMessage, TrailingAssistantFilter,
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

    /// Whether an automatic threshold compaction is due at a turn boundary:
    /// the live loop context over the model's context window against the
    /// effective threshold; usage before the latest compaction never re-triggers.
    pub async fn auto_compaction_due(&self, model: &pa_types::ai::Model) -> bool {
        let state = self.agent.state().await;
        // The live loop context is the agent's message list (the same
        // JSON round-trip `compact` uses).
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
        // The digest inputs come from the live (pre-compaction) context;
        // harness state reads fresh from disk when the snapshot renders.
        compaction_trace::trace(
            "compact.enter",
            &serde_json::json!({
                "customInstructions": custom_instructions.is_some(),
            }),
        );
        let digest_inputs = self.harness_digest_inputs().await;
        compaction_trace::trace("compact.digest_captured", &serde_json::Value::Null);
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
                    semantic_edges: self.semantic_edges(),
                },
            )
            .await?
        };
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
