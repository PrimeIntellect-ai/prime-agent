//! The `SessionEngine` trait impl for [`AgentSessionEngine`]: the
//! worker-facing engine contract - model and goal config surfaces,
//! the turn state machine, and the export/telemetry reads - as one
//! impl block (a trait impl is one block per type; it moved whole).

use super::*;

impl SessionEngine for AgentSessionEngine {
    /// TS `_clearQueuedGoalContexts`: the worker-installed purge withdraws
    /// the queued minted goal-context turns (pause/clear/start must not
    /// leave a stale continuation to run after the state change).
    fn purge_queued_goal_contexts(&self) {
        let purge = self
            .goal_queue_purge
            .lock()
            .expect("goal queue purge lock")
            .clone();
        if let Some(purge) = purge {
            purge();
        }
    }

    /// TS #2483's `_passivateSettledRlmChildRuntime` inline arm,
    /// worker-side: the turn runner's park arm proved the parent-owned,
    /// unattached, unqueued idle state; the remaining
    /// `canPassivateSettledSession` gates run here. A settled child
    /// releases its kernel with a final snapshot flush (the revivable
    /// stop: the next kernel use boots fresh from the flushed snapshot)
    /// while staying listable, inspectable, collectable, and deletable
    /// — the roster and collect surfaces are untouched by design.
    fn release_settled_child_kernel(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            // `hasNonPassiveDescendants`: a busy descendant keeps the
            // child's kernel resident (the TS policy).
            if self.has_unsettled_rlm_work().await {
                return;
            }
            // `hasRegisteredCronJob`: an active or paused scheduled job
            // keeps the kernel resident (its next run needs it); an
            // unwired probe stays open (a store-less embedding).
            let probe = self
                .registered_jobs_probe
                .lock()
                .expect("registered jobs probe lock")
                .clone();
            if let Some(probe) = probe {
                if probe() {
                    return;
                }
            }
            // The release itself: best-effort (a failed stop leaves
            // the kernel resident); a retired or never-built runtime
            // releases nothing (the TS `?.` arm). The probe lock
            // drops before the await so the future stays `Send`.
            let release = self
                .kernel_release_probe
                .lock()
                .expect("kernel release probe lock")
                .clone();
            if let Some(release) = release {
                release().await;
            }
        })
    }

    fn goal_state_value(&self) -> Value {
        if let Some(goal) = self.current_goal_state() {
            return serde_json::to_value(&goal).unwrap_or(Value::Null);
        }
        // The driver is mid-mutation or the session is not built yet (goal
        // rehydration surfaces with the first prompt/command): fall back to
        // the last published state, then the empty state.
        let published = self.published_goal.lock().expect("published goal lock");
        published
            .as_ref()
            .and_then(|goal| serde_json::to_value(goal).ok())
            .or_else(|| serde_json::to_value(pa_core::goals::empty_goal_state()).ok())
            .unwrap_or(Value::Null)
    }

    fn mint_post_compaction_goal_continuation(&self) -> Option<crate::engine::GoalContinuation> {
        // The mirrored goal runtime holds the driver and the session's
        // persistence handle (the core session's own lock stays held
        // across a turn's admission); the driver and session locks are
        // async, so the mint runs on the engine runtime like every other
        // engine call that touches the session.
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let continuation = self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            // TS `resumeQueuedWork()`'s quiescence arm: unsettled RLM
            // descendant work or a live background bash handle defers the
            // mint (the continuation is owed, not consumed; the settle
            // sites deliver it).
            if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
                driver.mark_continuation_owed();
                return None;
            }
            let mut session = handles.session.lock().await;
            // TS `compact()`'s didCompact branch is the OWED delivery, not
            // a fresh mint:
            //   `this._goalContinuationAwaitsRlmWork ||= !this.agent.hasQueuedMessages();
            //    this.resumeQueuedWork();`
            // Arming then taking keeps exactly one continuation per owed
            // boundary — the pre-fix fresh mint left an already-armed flag
            // behind (the mint consumed a slot TS never charges) and the
            // settle/resume sites delivered a second continuation for the
            // same boundary. The mint persists the `thread_goal_state`
            // entry (TS `_setGoalState`) and consumes one slot; an inactive
            // or objective-less goal drops the deferral without minting. A
            // failed persist ends the boundary without a continuation (TS
            // `_maybeResumeGoalContinuationAfterRlmWork`'s catch: the hook
            // must not reject; the unchanged count retries).
            driver.mark_continuation_owed();
            let message = match driver.take_owed_continuation(&mut session) {
                Ok(message) => message,
                Err(error) => {
                    eprintln!("pa-daemon: goal continuation mint persist failed: {error:#}");
                    None
                }
            }?;
            let goal_update = self.publish_goal_state(&driver.state_with_creation_elapsed());
            Some((
                crate::engine::PromptRequest {
                    batch: Vec::new(),
                    message: message.content.text(),
                    images: Vec::new(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: Some(crate::session_commands::custom_message_value(&message)),
                },
                goal_update,
            ))
        })?;
        let (request, goal_update) = continuation;
        Some(crate::engine::GoalContinuation {
            request,
            goal_update,
        })
    }

    fn clear_pending_goal_continuation(&self) {
        AgentSessionEngine::clear_pending_goal_continuation(self)
    }

    fn autonomous_status(
        &self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<pa_core::autonomous::AgentAutonomousStatus>>
                + Send
                + '_,
        >,
    > {
        // The turn loop's accounting holds the state lock across awaits
        // (gate evaluation), so the snapshot takes the async lock; the
        // caller waits for the session to settle first
        // (wait_for_headless_completion waits for idle).
        let autonomous = std::sync::Arc::clone(&self.autonomous);
        Box::pin(async move {
            let state = autonomous.lock().await;
            Some(pa_core::autonomous::autonomous_status(&state))
        })
    }

    /// Finalize telemetry on the live core session: `agent session ended`
    /// plus one flush (TS dispose callback). Best-effort by contract: a
    /// failed end never blocks or fails shutdown.
    fn end_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let session = self.session.lock().await;
            let Some(engine) = session.as_deref() else {
                return;
            };
            let Some(telemetry) = &engine.telemetry else {
                return;
            };
            let _ = telemetry.end().await;
        })
    }

    /// The TS replacement teardown (see
    /// [`Self::retire_session_runtime`]): the replacement flows retire the
    /// live runtime - kernel dispose plus the built session's drop - so
    /// the moved-to session rebuilds cold against its new file.
    fn teardown_for_replacement(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.retire_session_runtime().await;
        })
    }

    /// The daemon `kill` path: report `session archived` (lifetime in ms),
    /// then finalize with `agent session ended` + flush. Best-effort like
    /// all telemetry; `SessionTelemetry::end` is idempotent, so a later
    /// worker shutdown stays a no-op for a killed session.
    fn archive_session_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let session = self.session.lock().await;
            let Some(engine) = session.as_deref() else {
                return;
            };
            let Some(telemetry) = &engine.telemetry else {
                return;
            };
            telemetry.note_archived();
            let _ = telemetry.end().await;
        })
    }

    fn acp_mcp_manager(
        &self,
    ) -> Option<std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>> {
        Some(std::sync::Arc::clone(&self.mcp))
    }

    fn model_context_window(&self) -> Option<u64> {
        self.resolve_model().ok().map(|model| model.context_window)
    }

    fn creation_model(&self) -> Option<(String, String)> {
        let model = self.resolve_registry_model().ok()?;
        Some((model.provider.clone(), model.id))
    }

    fn set_session_file(&self, path: std::path::PathBuf) {
        *self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
    }

    /// TS `createAgentSession`'s restored-from-session step (sdk.ts): a
    /// session that already ran on a model restores it before the startup
    /// chain — the saved model context from the session file, through the
    /// bounded readiness wait (a revived worker races the daemon boot's
    /// catalog fetch; without the wait a private model is missing from
    /// the cold registry and the session silently lands on the featured
    /// default instead of the model it was running on). The worker calls
    /// this at create, before the create-config selection is adopted: a
    /// successful restore pins the model into the selection (the TS
    /// session holds its restored model), an explicit create flag still
    /// wins, and a failed restore is never silent —
    /// [`Self::model_fallback_message`] publishes the fallback.
    fn restore_session_model(
        &self,
        session_path: &std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let path = session_path.to_path_buf();
        Box::pin(async move {
            self.restore_session_model_at(&path).await;
        })
    }

    /// TS `modelFallbackMessage`: the non-silent record of a revived
    /// session's model falling back to the startup chain after the
    /// readiness window missed. Published on the session summary while
    /// the engine owns the file the decision was computed for.
    fn model_fallback_message(&self) -> Option<String> {
        let decision = self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let current = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        if decision.session_file != current {
            return None;
        }
        decision.fallback_message
    }

    /// The `compact` command path (TS `compact()`'s background
    /// `_scheduleAutoRefine("compact")` on an idle session): the round
    /// runs right after the compaction answered, through the same gated
    /// body the turn boundaries use (`compact_autorefine.rs`).
    fn consume_compact_auto_refine(
        &self,
    ) -> anyhow::Result<Option<pa_core::refinement::RefinementResult>> {
        self.consume_compact_auto_refine_round()
    }

    /// The worker's live session summary (the TS
    /// `createAgentSessionMessageSender` source): rendered into the
    /// sender identity block of direct worker-to-worker deliveries.
    fn set_session_summary(&self, summary: Value) {
        *self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(summary);
    }

    fn configure_service_tier(&self, tier: Option<pa_types::ai::ServiceTier>) {
        *self.service_tier.write().expect("service tier lock") = tier;
        if let Some(target) = self
            .provider_target
            .write()
            .expect("provider target lock")
            .as_mut()
        {
            target.service_tier = tier;
        }
    }

    fn configure_model(&self, selection: EngineModelSelection) {
        // Merge like the TS runtime config: explicit wire flags replace the
        // current selection; absent fields keep it.
        {
            let mut current = self.selection.write().expect("model selection lock");
            if selection.provider.is_some() {
                current.provider = selection.provider;
            }
            if selection.model.is_some() {
                current.model = selection.model;
            }
            if selection.api_key.is_some() {
                current.api_key = selection.api_key;
            }
            if selection.thinking.is_some() {
                current.thinking = selection.thinking;
            }
        }
        // Resolve the effective thinking level now (create time, before any
        // turn): the merge above may have changed the selection, so drop the
        // cached value and recompute. `effective_thinking` caches it, so
        // later summary/state calls stay side-effect-free while turns run.
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        let _ = self.effective_thinking();
        // The first prompt after create builds the session against this
        // selection, so no invalidation is needed here: configure runs at
        // create time, before any turn.
    }

    fn configure_create_model(&self, selection: EngineModelSelection) {
        // The create command's explicit flags fold into the session
        // runtime config (TS `mergeAgentSessionRuntimeConfig`): TS hands
        // the merged `sessionConfig` down through every replacement, so
        // the flags must survive the runtime-config reset a session
        // restore performs — a later `switch_session`/`fork`/`import`
        // keeps honoring the create's selection (it wins over the
        // moved-to file's pin, exactly like `options.model` in
        // `createAgentSession`).
        {
            let mut initial = self
                .initial_selection
                .write()
                .expect("initial selection lock");
            if selection.provider.is_some() {
                initial.provider.clone_from(&selection.provider);
            }
            if selection.model.is_some() {
                initial.model.clone_from(&selection.model);
            }
            if selection.api_key.is_some() {
                initial.api_key.clone_from(&selection.api_key);
            }
            if selection.thinking.is_some() {
                initial.thinking = selection.thinking;
            }
        }
        self.configure_model(selection);
    }

    fn switch_model(&self, selection: EngineModelSelection) -> bool {
        // The allowlist gate on the switch candidate, before the selection
        // slot mutates: a refused model must not poison the live selection
        // (every later resolution would fail at the same gate). The wire
        // seams (`set_model`, `cycle_model`) check first and own the user
        // message and refusal event; this is the engine's total guard for
        // any other caller.
        if let (Some(provider), Some(model)) =
            (selection.provider.as_deref(), selection.model.as_deref())
        {
            let selector = format!("{provider}/{model}");
            let allowlist = crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir);
            if crate::model_allowlist::assert_allowed(&allowlist, &selector).is_err() {
                return false;
            }
        }
        self.configure_model(selection);
        let Ok(model) = self.resolve_model() else {
            return false;
        };
        // The built session follows the new model without a rebuild: the
        // agent's model (loop context) and the provider stream's target
        // swap in place (TS `agent.state.model = model`).
        {
            let (api_key, headers) = self.resolve_request_key_and_headers(&model);
            let mut target = self.provider_target.write().expect("provider target lock");
            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key,
                model: model.clone(),
                headers,
            });
        }
        let session = self.session.blocking_lock();
        if let Some(core) = session.as_deref() {
            let provider = model.provider.clone();
            let model_id = model.id.clone();
            let _ = self
                .runtime
                .block_on(core.session.set_model(&model, &provider, &model_id));
        }
        // The children registry's inherited parent model follows the
        // switch (the build-time stamp alone would go stale): an inherited
        // `rlm.spawn` resolves the model the session NOW runs, so the
        // allowlist gate never refuses a stale selector the parent left
        // behind.
        if let Some(children) = &self.children {
            children.set_model(format!("{}/{}", model.provider, model.id));
        }
        true
    }

    fn supported_thinking_levels(&self) -> Option<Vec<String>> {
        let model = self.resolve_model().ok()?;
        Some(
            pa_ai::models::get_supported_thinking_levels(&model)
                .into_iter()
                .map(|level| level.wire_name().to_string())
                .collect(),
        )
    }

    fn switch_thinking_level(&self, level: pa_types::ai::ModelThinkingLevel) -> bool {
        self.configure_model(EngineModelSelection {
            thinking: Some(level),
            ..Default::default()
        });
        // The effective level is the request clamped to the model's
        // supported levels (TS `setThinkingLevel`); a built session's
        // agent follows it on the next turn.
        let effective = self.effective_thinking();
        let session = self.session.blocking_lock();
        if let Some(core) = session.as_deref() {
            let _ = self.runtime.block_on(
                core.session
                    .set_thinking_level(map_thinking_level(effective)),
            );
        }
        true
    }

    fn effective_thinking_level(&self) -> Option<String> {
        Some(self.effective_thinking().wire_name().to_string())
    }

    /// The built core session's assembled prompt (the export embeds it).
    /// Best-effort: the caller's `export_tools` read (which builds an
    /// absent session, the TS create-time state) runs first; a still
    /// unbuilt or busy session omits the section.
    fn export_system_prompt(&self) -> Option<String> {
        let session = self.session.try_lock().ok()?;
        session.as_deref().map(|core| core.system_prompt.clone())
    }

    /// The built session's live tool registry mapped to the export's tools
    /// section (TS `state.tools`). An export that precedes the first turn
    /// builds the session now (the TS state exists from create); a
    /// mid-turn engine reports `None` and the export omits the section.
    fn export_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + '_>> {
        Box::pin(async move {
            let model = self.resolve_model().ok()?;
            self.ensure_core_session_async(&model).await.ok()?;
            let session = self.session.try_lock().ok()?;
            let state = session.as_deref()?.session.agent().state().await;
            Some(pa_core::export_html::tools_section(&state.tools))
        })
    }

    /// The export's custom-tool pre-render: walk the entries through the
    /// registry-backed renderer (TS `preRenderCustomTools`), against the
    /// same built-session registry as [`Self::export_tools`].
    fn export_rendered_tools(
        &self,
        entries: &[Value],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        let entries = entries.to_vec();
        Box::pin(async move {
            let model = self.resolve_model().ok()?;
            self.ensure_core_session_async(&model).await.ok()?;
            let session = self.session.try_lock().ok()?;
            let state = session.as_deref()?.session.agent().state().await;
            let renderer = crate::session_export::ExportToolRenderer {
                tools: &state.tools,
            };
            pa_core::export_html::pre_render_custom_tools(&entries, &renderer)
        })
    }

    fn model_metadata(&self) -> Option<Value> {
        let model = self.resolve_model().ok()?;
        Some(json!({
            "id": model.id,
            "name": model.name,
            "api": model.api,
            "provider": model.provider,
            "reasoning": model.reasoning,
        }))
    }

    /// True while the session is parked waiting out a provider-reported
    /// usage reset (TS `session.isQuotaParked`).
    fn is_quota_parked(&self) -> bool {
        AgentSessionEngine::is_quota_parked(self)
    }

    /// `compact` over the hosted pa-core session: the session summarizes
    /// its own branch, persists the entry on its in-memory store, and
    /// rebuilds the loop context; the worker persists the durable entry.
    /// The abort races the run: the summarizer call is cancelled by
    /// dropping the future (the entry write happens inside it).
    fn abort_auto_compaction(&self) {
        // TS `abortCompaction` aborts the auto controller in flight and is a
        // silent no-op otherwise; the run itself clears its slot when it
        // settles (only its own controller clears, so a stale abort cannot
        // clear a newer run's slot).
        let controller = self
            .auto_compaction_abort
            .lock()
            .expect("auto compaction abort lock")
            .clone();
        if let Some(controller) = controller {
            controller.abort();
        }
    }

    fn run_compaction(
        &self,
        request: CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        // The session's live model (the provider target the turn stream
        // reads), never a fresh startup-chain resolution (R8: a
        // re-resolution landed the summarizer on an unconfigured provider).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return CompactionOutcome::Failed {
                    error: error.to_string(),
                }
            }
        };
        if let Err(error) = self.session_agent(&model) {
            return CompactionOutcome::Failed {
                error: error.to_string(),
            };
        }
        let custom_instructions = request.custom_instructions;
        // The live target's key, the same chain every other summarizer
        // arm reads: the config key is the startup snapshot and goes
        // stale with the session's provider switches (the R8 seam's
        // key arm — a summarizer with the old provider's key, or none).
        let api_key = self.resolve_request_api_key(&model);
        let run = async {
            // The lock covers the clone only (see `run_turn_once`): the
            // compaction below runs a summarizer model call, and holding
            // the mutex across it serialized every client read seam
            // behind the compaction.
            let session = self.session.lock().await.clone();
            let Some(engine) = session else {
                anyhow::bail!("session not built");
            };
            engine
                .session
                .compact(
                    custom_instructions.as_deref(),
                    &model,
                    api_key,
                    // The run's own signal: a summarizer that resolved while
                    // the abort raced still lands the pre-commit check (TS
                    // `_performCompaction`'s `if (signal.aborted) throw`).
                    Some(signal),
                )
                .await
        };
        let result = self
            .runtime
            .block_on(pa_agent::abort::race_with_abort(run, signal));
        let compaction = match result {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                // Abort-marked errors and a lost abort race both surface as
                // the TS "Compaction cancelled" outcome.
                if pa_agent::abort::is_abort_error(&error) {
                    return CompactionOutcome::Aborted;
                }
                return CompactionOutcome::Failed {
                    error: format!("{error:#}"),
                };
            }
            Err(_) => return CompactionOutcome::Aborted,
        };
        match compaction {
            pa_core::session_engine::compact_session::CompactOutcome::Skipped(message) => {
                CompactionOutcome::Skipped {
                    message: message.to_string(),
                }
            }
            pa_core::session_engine::compact_session::CompactOutcome::Ran(run) => {
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run; the
                // manual wire run counts like the `/compact` command).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction();
                    }
                }
                // TS `compact()` schedules the compact-trigger auto-refine
                // review after every successful compaction (the manual path
                // included); the `compact` command consumes the round once
                // the run settled.
                self.mark_compact_auto_refine_pending();
                CompactionOutcome::Compacted {
                    run: Box::new(CompactionRun {
                        // The wire result is the TS `CompactionResult` shape
                        // (`_performCompaction`'s return): summary,
                        // firstKeptEntryId, tokensBefore, and the file-op
                        // `details` verbatim from the durable entry. Usage and
                        // the harnessDigest snapshot live on the persisted
                        // entry, handed over verbatim, never on the wire
                        // result.
                        result: crate::compaction::compaction_result_value(&run.result, &run.entry),
                        usage: run
                            .result
                            .usage
                            .and_then(|usage| serde_json::to_value(usage).ok()),
                        entry: serde_json::to_value(&run.entry).unwrap_or(Value::Null),
                        // The post-compaction kernel notice in its wire
                        // message form (`role: "custom"`), when the session's
                        // kernel was running.
                        ipython_state: run
                            .ipython_state
                            .as_ref()
                            .map(crate::session_commands::custom_message_value),
                    }),
                }
            }
        }
    }

    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        // The session's live model (the provider target the turn stream
        // reads): the branch summarizer runs on the session model like the
        // compaction summarizer (R8).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return BranchSummaryOutcome::Failed {
                    error: error.to_string(),
                }
            }
        };
        let api_key = self.resolve_request_api_key(&model);
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        let reserve_tokens = settings
            .settings()
            .branch_summary
            .as_ref()
            .and_then(|branch_summary| branch_summary.reserve_tokens)
            .unwrap_or(
                pa_core::session_engine::branch_summarization::DEFAULT_BRANCH_RESERVE_TOKENS,
            );
        let entries = request.entries;
        let custom_instructions = request.custom_instructions;
        let replace_instructions = request.replace_instructions;
        // TS #2411: the branch summary resolves its model through the
        // `auxiliaryModel` setting (the session model above is the
        // fallback), so its one-off prompt stays off the session's
        // prompt-cache prefix.
        let auxiliary = pa_core::session_engine::auxiliary_model::AuxiliaryModelContext {
            cwd: self.cwd(),
            agent_dir: self.config.agent_dir.clone(),
        };
        let run = async {
            pa_core::session_engine::branch_summarization::generate_branch_summary(
                &entries,
                pa_core::session_engine::branch_summarization::GenerateBranchSummaryOptions {
                    model: &model,
                    api_key,
                    custom_instructions: custom_instructions.as_deref(),
                    replace_instructions,
                    reserve_tokens,
                    auxiliary: Some(&auxiliary),
                },
            )
            .await
        };
        match self
            .runtime
            .block_on(pa_agent::abort::race_with_abort(run, signal))
        {
            Ok(result) => {
                if result.aborted {
                    return BranchSummaryOutcome::Aborted;
                }
                if let Some(error) = result.error {
                    return BranchSummaryOutcome::Failed { error };
                }
                let summary = result
                    .summary
                    .unwrap_or_else(|| "No summary generated".to_string());
                BranchSummaryOutcome::Complete {
                    run: BranchSummaryRun {
                        summary,
                        usage: result
                            .usage
                            .and_then(|usage| serde_json::to_value(usage).ok()),
                        details: Some(json!({
                            "readFiles": result.read_files,
                            "modifiedFiles": result.modified_files,
                        })),
                        model: result.model,
                    },
                }
            }
            Err(_) => BranchSummaryOutcome::Aborted,
        }
    }

    fn rebuild_session_context(
        &self,
        branch_entries: Vec<pa_types::session::FileEntry>,
        goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        // The caller parks this synchronous engine call on a blocking
        // thread (see `branch_navigation`), so `blocking_lock` is legal
        // here; the async session move below then rides the engine
        // runtime, the same pattern as `run_compaction`.
        let built = self.session.blocking_lock().is_some();
        if !built {
            // The session builds lazily on the first turn; park the branch
            // so the build consumes it (see `session_agent`). The goal
            // state seed rides the build (`adopt_built_session`: the TS
            // constructor's `_loadPersistedGoalState`), so the reload
            // rule has nothing to run here.
            *self
                .pending_branch
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(branch_entries);
            return Ok(());
        }
        self.runtime.block_on(async move {
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return Ok(());
            };
            // TS `_invalidatePendingAutoRefineForBranchChange`: the moved
            // branch invalidates the conversation an armed compact-trigger
            // review would read, so the trigger drops.
            engine.session.discard_compact_auto_refine();
            engine
                .session
                .rebuild_branch_context(branch_entries)
                .await?;
            // TS `_reloadGoalStateFromBranch({ monotonicTokens })` at the
            // `_navigateTree` tail: the rebuilt context reads the moved
            // branch's own latest persisted goal entry (the session manager
            // adopted the entries above, so the same scan the TS
            // `sessionManager.getBranch()` read applies), with the
            // same-timeline rule clamping the same goal's accounting. The
            // reload's announcement publishes here — while the driver lock
            // is held, so a racing goal mutation can neither interleave
            // nor make the payload read fail — and the caller takes it.
            let mut driver = engine.goal_driver.lock().await;
            let session = engine.session.shared_persistence();
            let manager = session.lock().await;
            driver.reload_from_branch(&manager, goal_reload);
            let announcement = self.publish_goal_state(&driver.state_with_creation_elapsed());
            *self
                .reloaded_goal_update
                .lock()
                .expect("reloaded goal update lock") = announcement;
            Ok(())
        })
    }

    fn goal_update_after_rebuild(&self) -> Option<Value> {
        // The on-change announcement the TS `_emitGoalUpdate` at the
        // reload emits: the reload already published it through the
        // shared dedupe (an unchanged state stashes nothing, and a later
        // turn-boundary check never re-announces it); the announcing
        // caller takes it exactly once.
        self.reloaded_goal_update
            .lock()
            .expect("reloaded goal update lock")
            .take()
    }

    /// Rebind the engine's session cwd (see [`SessionEngine::set_cwd`]):
    /// the core session rebuild (a replacement flow just retired the old
    /// session) reads the slot, so the rebuilt session's kernel-resident
    /// tools run in the moved-to session's cwd — the TS
    /// `createRuntime({ cwd: sessionManager.getCwd() })` rebind. The
    /// product-default shell-gate driver follows the cwd (it runs shell
    /// gates there); a harness-injected driver stays.
    fn set_cwd(&self, cwd: std::path::PathBuf) {
        {
            let mut slot = self.cwd.write().expect("engine cwd lock");
            if *slot == cwd {
                return;
            }
            (*slot).clone_from(&cwd);
        }
        if self
            .autonomous_driver_default
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            *self
                .autonomous_driver
                .write()
                .expect("autonomous driver lock") =
                std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(cwd))
                    as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>;
        }
    }

    fn configure_rlm_identity(
        &self,
        identity: crate::engine::RlmSessionIdentity,
    ) -> anyhow::Result<()> {
        // This session's own depth gates the kernel `refine.*` host requests
        // (TS `_autoRefineAllowedForSession`: depth-0 sessions only).
        self.rlm_depth
            .store(identity.rlm_depth, std::sync::atomic::Ordering::Relaxed);
        // The inherited default the children registry seeds from (validated;
        // the children create command carries it onward). This session's own
        // effective level resolves through the shared path instead: the
        // worker routes the same create-config `thinking` flag through
        // `configure_model`, so it lands in `effective_thinking` already
        // validated and clamped to the model (the TS `resolveRuntimeSessionOptions`
        // -> sdk.ts `createAgentSession` order).
        if let Some(thinking) = &identity.thinking {
            pa_ai::models::thinking_level_from_str(thinking)
                .ok_or_else(|| anyhow::anyhow!("unknown thinking level \"{thinking}\""))?;
        }
        // The depth bound's TS precedence (agent-session
        // `_resolveRlmMaxDepth`): a persisted chat override wins, then the
        // create-carried bound (inherited), the global setting, the
        // `RLM_MAX_DEPTH` env, and finally the shared default.
        let (max_depth, source) = persisted_rlm_max_depth(identity.session_file.as_deref())
            .map(|depth| (depth, "chat"))
            .or_else(|| {
                identity
                    .rlm_max_depth
                    .map(|depth| (u64::from(depth), "inherited"))
            })
            .or_else(|| {
                let settings =
                    pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
                settings.get_rlm_max_depth().map(|depth| (depth, "global"))
            })
            .or_else(|| {
                std::env::var("RLM_MAX_DEPTH")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|value| *value >= 1)
                    .map(|depth| (depth, "env"))
            })
            .unwrap_or((u64::from(DEFAULT_RLM_MAX_DEPTH), "default"));
        *self.rlm_max_depth_source.lock().expect("depth source lock") = source;
        if let Some(children) = &self.children {
            let parent = ParentIdentity {
                rlm_depth: identity.rlm_depth,
                rlm_max_depth: max_depth.min(u64::from(u32::MAX)) as u32,
                model: None,
                cwd: identity.cwd.clone(),
                session_id: identity.session_id.clone(),
                session_file: identity.session_file.clone(),
                thinking: identity.thinking.clone(),
                child_script: identity.child_script,
            };
            children.set_identity(parent);
        }
        Ok(())
    }

    /// An agent message from one of this session's children arrived: the
    /// children registry records it so the child's no-reply terminal
    /// notice is withheld (TS `_parentReplyCount` on the child run).
    fn mark_child_reply(&self, child_active_session_id: &str) {
        if let Some(children) = &self.children {
            let children = Arc::clone(children);
            let child = child_active_session_id.to_string();
            // The delivery handler is sync; the registry lock is async, so
            // the mark parks on this engine's own runtime.
            self.runtime.spawn(async move {
                children.mark_replied(&child).await;
            });
        }
    }

    /// The worker's turn completed: release child prompt tasks waiting on
    /// the turn boundary (see `SupervisorChildSessions::wait_turn_done`).
    fn on_turn_done(&self) {
        if let Some(children) = &self.children {
            children.notify_turn_done();
        }
    }

    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        // The session's live model (the provider target the turn stream
        // reads): the side question runs on the session model like the
        // compaction summarizer (R8).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return SideQuestionOutcome::Failed {
                    answer: String::new(),
                    error: error.to_string(),
                }
            }
        };
        let agent = match self.session_agent(&model) {
            Ok(agent) => agent,
            Err(error) => {
                return SideQuestionOutcome::Failed {
                    answer: String::new(),
                    error: error.to_string(),
                }
            }
        };
        let question = request.question.clone();
        let previous_turns = request.previous_turns;
        let retry_policy = pa_core::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY;
        let result =
            self.runtime
                .block_on(pa_core::session_engine::side_question::run_side_question(
                    &agent,
                    &question,
                    &previous_turns,
                    &retry_policy,
                    signal,
                    sink,
                ));
        match result.status {
            pa_core::session_engine::side_question::SideQuestionStatus::Complete => {
                SideQuestionOutcome::Complete {
                    answer: result.answer,
                }
            }
            pa_core::session_engine::side_question::SideQuestionStatus::Cancelled => {
                SideQuestionOutcome::Aborted {
                    answer: result.answer,
                }
            }
            pa_core::session_engine::side_question::SideQuestionStatus::Error => {
                SideQuestionOutcome::Failed {
                    answer: result.answer,
                    error: result
                        .error_message
                        .unwrap_or_else(|| "Side question failed".to_string()),
                }
            }
        }
    }

    fn rlm_child_snapshots(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        let children = self.children.clone();
        Box::pin(async move {
            let Some(children) = children else {
                return Vec::new();
            };
            children.child_snapshots().await
        })
    }

    fn connection_commands(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async move {
            // The TS session (and its resource loader) exists from create, so
            // `get_commands` always sees the skill list. This port builds
            // the core session lazily, so a read before any turn builds it
            // now (the async build path, like `system_prompt`; the create
            // prewarm usually already finished it).
            if let Ok(model) = self.resolve_model() {
                if let Err(error) = self.ensure_core_session_async(&model).await {
                    eprintln!("get_commands session build failed: {error:#}");
                    return Vec::new();
                }
            }
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return Vec::new();
            };
            // TS `createAgentConnectionCommands` order: extension
            // commands, then prompt templates, then skills. The Rust
            // extension registry does not track per-command source info,
            // so extension entries carry the TS fields minus
            // `sourceInfo`.
            let mut commands = Vec::new();
            if let Some(runner) = &engine.extension_runner {
                let registry = runner.registry().await;
                for command in registry.commands() {
                    let mut entry = json!({
                        "name": command.invocation_name,
                        "registeredName": command.name,
                        "source": "extension",
                    });
                    if let Some(description) = &command.description {
                        entry["description"] = json!(description);
                    }
                    commands.push(entry);
                }
            }
            for template in &engine.prompt_templates {
                let mut entry = json!({
                    "name": template.name,
                    "source": "prompt",
                    "sourceInfo": template.source_info,
                });
                if let Some(hint) = &template.argument_hint {
                    entry["argumentHint"] = json!(hint);
                }
                if !template.description.is_empty() {
                    entry["description"] = json!(template.description);
                }
                commands.push(entry);
            }
            for skill in &engine.skills {
                let mut entry = json!({
                    "name": format!("skill:{}", skill.name),
                    "source": "skill",
                    "sourceInfo": skill.source_info,
                });
                if !skill.description.is_empty() {
                    entry["description"] = json!(skill.description);
                }
                commands.push(entry);
            }
            commands
        })
    }

    fn resource_snapshot(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async move {
            let session_id = {
                let guard = self.session.lock().await;
                match guard.as_deref() {
                    Some(engine) => engine.session.session_id().await,
                    None => {
                        // The session builds lazily (first prompt); the
                        // resource surface reads the session's own loader
                        // results, so an unbuilt session answers the
                        // empty snapshot.
                        return crate::engine::empty_resource_snapshot();
                    }
                }
            };
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return crate::engine::empty_resource_snapshot();
            };
            let cwd = self.cwd().display().to_string();
            let mut skills = Vec::new();
            for skill in &engine.skills {
                let mut entry = json!({
                    "name": skill.name,
                    "filePath": skill.file_path.display().to_string(),
                    "sourceInfo": skill.source_info,
                });
                if !skill.description.is_empty() {
                    entry["description"] = json!(skill.description);
                }
                if let Some(artifact) = artifact_reference(
                    &session_id,
                    &cwd,
                    "skill",
                    &skill.file_path.display().to_string(),
                ) {
                    entry["artifact"] = artifact;
                }
                skills.push(entry);
            }
            let mut prompts = Vec::new();
            for template in &engine.prompt_templates {
                let mut entry = json!({
                    "name": template.name,
                    "filePath": template.file_path,
                    "sourceInfo": template.source_info,
                });
                if !template.description.is_empty() {
                    entry["description"] = json!(template.description);
                }
                if let Some(hint) = &template.argument_hint {
                    entry["argumentHint"] = json!(hint);
                }
                if let Some(artifact) =
                    artifact_reference(&session_id, &cwd, "prompt", &template.file_path)
                {
                    entry["artifact"] = artifact;
                }
                prompts.push(entry);
            }
            let mut context_files = Vec::new();
            for file in &engine.agents_files {
                let mut entry = json!({ "path": file.path.display().to_string() });
                if let Some(artifact) = artifact_reference(
                    &session_id,
                    &cwd,
                    "context_file",
                    &file.path.display().to_string(),
                ) {
                    entry["artifact"] = artifact;
                }
                context_files.push(entry);
            }
            json!({
                "contextFiles": context_files,
                "skills": skills,
                "prompts": prompts,
                "extensions": [],
                "themes": [],
                "diagnostics": {
                    "skills": engine.skill_diagnostics,
                    "prompts": [],
                    "extensions": engine
                        .extension_diagnostics
                        .iter()
                        .map(|error| json!({ "type": "error", "message": error }))
                        .collect::<Vec<_>>(),
                    "themes": [],
                },
            })
        })
    }

    fn system_prompt(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send + '_>>
    {
        Box::pin(async move {
            // The TS session exists from create; this port builds the
            // core session lazily on the first turn, so a prompt read
            // before any turn builds it now (the async build path, never
            // the blocking `ensure_core_session`: this future runs on the
            // caller's runtime).
            let model = self.resolve_model()?;
            self.ensure_core_session_async(&model).await?;
            let guard = self.session.lock().await;
            let engine = guard.as_deref().expect("session built above");
            Ok(engine.system_prompt.clone())
        })
    }

    fn tool_definition(
        &self,
        name: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        let name = name.to_string();
        Box::pin(async move {
            let guard = self.session.lock().await;
            let engine = guard.as_deref()?;
            let state = engine.session.agent().state().await;
            let tool = state.tools.iter().find(|tool| tool.name() == name)?;
            Some(json!({
                "name": tool.name(),
                "label": tool.label(),
                "description": tool.description(),
                "parameters": tool.parameters(),
            }))
        })
    }

    fn run_refinement(
        &self,
        options: pa_core::session_engine::refine::RefineOptions,
    ) -> anyhow::Result<Value> {
        let model = self.resolve_model()?;
        self.ensure_core_session(&model)?;
        let api_key = self.resolve_request_api_key(&model);
        let global_harness_dir = self.config.agent_dir.clone();
        // The lock covers the clone only (see `run_turn_once`): the
        // refinement below runs a model call, and holding the mutex
        // across it serialized every client read seam behind it.
        let core = self
            .session
            .blocking_lock()
            .clone()
            .expect("session built by ensure_core_session");
        let result = self.runtime.block_on(async {
            core.session
                .refine(
                    &options,
                    pa_core::session_engine::refine::RefinementSource::User,
                    &model,
                    api_key,
                    global_harness_dir,
                )
                .await
        })?;
        serde_json::to_value(&result)
            .map_err(|error| anyhow::anyhow!("refinement result conversion failed: {error}"))
    }

    fn rlm_max_depth_status(&self) -> Value {
        let source = *self.rlm_max_depth_source.lock().expect("depth source lock");
        let max_depth = match &self.children {
            // The live bound the registry enforces (the chat override and
            // the inherited/seeded bound both land there).
            Some(children) => children.rlm_max_depth(),
            None => DEFAULT_RLM_MAX_DEPTH,
        };
        json!({ "maxDepth": max_depth, "source": source })
    }

    fn cancel_rlm_child<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            match &self.children {
                Some(children) => children.cancel_child_run(child_id).await,
                None => false,
            }
        })
    }

    fn delete_rlm_subagent<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<&'static str>> + Send + 'a>,
    > {
        Box::pin(async move {
            match &self.children {
                Some(children) => children.delete_inactive_subagent(child_id).await,
                None => Ok("not_found"),
            }
        })
    }

    fn set_rlm_max_depth(&self, max_depth: u64, global: bool) -> anyhow::Result<Value> {
        // The live bound every spawn checks (TS updates `_rlmMaxDepth`
        // and rebuilds the system prompt; the bound itself lives in the
        // registry here).
        if let Some(children) = &self.children {
            children.set_rlm_max_depth(max_depth.min(u64::from(u32::MAX)) as u32);
        }
        *self.rlm_max_depth_source.lock().expect("depth source lock") = "chat";
        // The durable `rlm_max_depth_state` custom entry (TS
        // `appendCustomEntryWithRollback`): a resumed session re-seeds
        // its bound from it. The session that is not built yet parks the
        // entry for its build (the `pending_branch` pattern).
        self.persist_max_depth_state(max_depth);
        // The global settings write (TS `settingsManager.setRlmMaxDepth`
        // + flush + drain): errors join the TS `globalError` field, they
        // do not fail the command.
        let mut result = json!({
            "maxDepth": max_depth,
            "source": "chat",
            "globalSaved": false,
        });
        if global {
            if let Some(error) = self.write_global_rlm_max_depth(max_depth) {
                result["globalError"] = json!(error);
            } else {
                result["globalSaved"] = json!(true);
            }
        }
        Ok(result)
    }

    fn run_prompt(
        &self,
        _prompt_index: usize,
        mut request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        // Goal-state changes surface as `goal_update` at the moment they
        // happen (kernel host requests and session-command mutations), so
        // every emit of this prompt runs through the tracking wrapper.
        let mut emit = self.goal_tracking_emit(emit);
        // The accepted-turn row carries the skill-expanded text (TS
        // `_normalizeSubmission` persists the expanded submission as the
        // user message): a `/skill:<name>` command expands against the
        // session's skill inventory before the row persists and
        // broadcasts, so the transcript renders the skill card instead
        // of the raw command. Everything else skips the expansion (and
        // its on-demand session build) entirely.
        if request.message.starts_with("/skill:") {
            request.message = self.expand_skill_submission(&request.message);
        }
        // Session commands (compact/refine/goal/autonomous) never admit a
        // model turn and never record a user-message row: the durable echo
        // row replaces it. Execute before admission so the idle-wait loop
        // below stays reachable only for real turns.
        if let Some(command) =
            crate::session_commands::parse_prompt_session_command(&request.message)
        {
            let Some(execution) =
                crate::session_commands::run_session_command(self, command, &mut emit)
            else {
                return;
            };
            if let Some(error) = &execution.error {
                emit(EngineEvent::Done(Err(error.clone())));
                return;
            }
            // A goal start/resume schedules its continuation context as
            // the turn (an injected custom row): the durable row's
            // message pair precedes the turn it drives (TS's prepared-turn
            // primary record emits at admission), and the loop admission
            // carries the row itself — one representation of the turn.
            // An unchanged `/goal` state stays silent (TS emits
            // goal_update only on state change; the interactive surface
            // dedupes announcements).
            if let Some(message) = execution.continuation_message {
                if !emit(EngineEvent::CustomMessage(
                    crate::session_commands::custom_message_value(&message),
                )) {
                    return;
                }
                self.run_turns(TurnPrompt::Injected(message), aborted, &mut emit);
            } else {
                emit(EngineEvent::Done(Ok(())));
            }
            return;
        }
        // The injected custom row (wire `role: "custom"`) parses to its
        // session shape first: an unparseable row fails the turn instead
        // of double-representing it (the loop would admit a user row with
        // the same text while the row already persists and renders).
        let injected = match &request.custom_message {
            Some(custom) => {
                match serde_json::from_value::<pa_types::session::AgentMessage>(custom.clone()) {
                    Ok(pa_types::session::AgentMessage::Custom(parsed)) => Some(parsed),
                    Ok(_) => {
                        emit(EngineEvent::Done(Err(
                            "injected custom message must carry role \"custom\"".to_string(),
                        )));
                        return;
                    }
                    Err(error) => {
                        emit(EngineEvent::Done(Err(format!(
                            "injected custom message parse failed: {error}"
                        ))));
                        return;
                    }
                }
            }
            None => None,
        };
        // The accepted turn row: an injected custom row replaces the user
        // message — the row persists and renders as itself while the model
        // turn runs on the row itself (TS injected-prompt turns: RLM child
        // terminal notices). The plain turn records the accepted user
        // message; images ride as multimodal content blocks after the text
        // (TS prompt admission: the text part first, then the image parts).
        let accepted = if let Some(custom) = &request.custom_message {
            EngineEvent::CustomMessage(custom.clone())
        } else {
            let mut content = vec![json!({ "type": "text", "text": request.message })];
            for image in &request.images {
                let mut block = match serde_json::to_value(image) {
                    Ok(Value::Object(block)) => Value::Object(block),
                    _ => continue,
                };
                if let Some(object) = block.as_object_mut() {
                    object.insert("type".to_string(), json!("image"));
                }
                content.push(block);
            }
            EngineEvent::UserMessage(json!({
                "role": "user",
                "content": content,
                "timestamp": now_millis(),
            }))
        };
        if !emit(accepted) {
            return;
        }
        // The batched co-delivery rows (TS `_startPreparedTurnActions`: each
        // batched action's primary record emits before the run): one accepted
        // user row per batched message, in delivery order, persisted and
        // rendered like the primary. The batch only ever rides a plain user
        // turn (the injected-custom turns deliver solo — the queue never
        // batches a row that replaces the user row). Each row expands a
        // leading `/skill:` the same way the primary does, so the accepted
        // row persists and renders the expanded submission (TS normalizes
        // every submission at queue time).
        for row in &request.batch {
            let text = if row.text.starts_with("/skill:") {
                self.expand_skill_submission(&row.text)
            } else {
                row.text.clone()
            };
            let mut content = vec![json!({ "type": "text", "text": text })];
            for image in &row.images {
                let mut block = match serde_json::to_value(image) {
                    Ok(Value::Object(block)) => Value::Object(block),
                    _ => continue,
                };
                if let Some(object) = block.as_object_mut() {
                    object.insert("type".to_string(), json!("image"));
                }
                content.push(block);
            }
            if !emit(EngineEvent::UserMessage(json!({
                "role": "user",
                "content": content,
                "timestamp": now_millis(),
            }))) {
                return;
            }
        }
        let turn_prompt = match injected {
            Some(custom) => TurnPrompt::Injected(custom),
            None => TurnPrompt::User {
                text: request.message.clone(),
                images: request.images.clone(),
                batch: request.batch,
            },
        };
        self.run_turns(turn_prompt, aborted, &mut emit);
    }

    fn abort_in_flight_turn(&self) {
        // TS `requestAbort` ends with `this.agent.abort()`: the agent's
        // active-run controller aborts, every loop await rejects, and the
        // in-flight provider fetch cancels. No run in flight (or a
        // not-yet-built session) aborts nothing, like the TS optional
        // chain.
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            agent.abort();
        }
    }

    /// `set_steering_mode` / `set_follow_up_mode` (TS
    /// `session.setSteeringMode`/`setFollowUpMode`): the queue delivery
    /// mode switches live — the slot feeds any later session build, and
    /// the built session's agent drains by the new mode from the next
    /// boundary (`this.agent.steeringMode = mode`).
    fn set_queue_modes(&self, steering: Option<&str>, follow_up: Option<&str>) {
        {
            let mut modes = self.queue_modes.lock().expect("queue modes");
            if let Some(mode) = steering {
                modes.0 = Some(mode.to_string());
            }
            if let Some(mode) = follow_up {
                modes.1 = Some(mode.to_string());
            }
        }
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            if let Some(mode) = steering.and_then(Self::queue_mode) {
                agent.set_steering_mode(mode);
            }
            if let Some(mode) = follow_up.and_then(Self::queue_mode) {
                agent.set_follow_up_mode(mode);
            }
        }
    }
}
