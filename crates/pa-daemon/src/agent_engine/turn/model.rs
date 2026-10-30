//! The model-turn runner: the streaming run over the built session agent,
//! the retry/failover policy application, and the quota-park mid-run arm.
use super::{
    aborted_message, drop_trailing_assistant, json_round_trip, map_thinking_level,
    model_thinking_level, retry_event_to_engine_event, AgentSessionEngine, EngineEvent,
    ProviderTarget, StopReason, TurnAdmission, TurnOnce, TurnPrompt, TurnResult,
    EMPTY_REPLY_RETRY_INSTRUCTION, EMPTY_REPLY_TURN_ERROR,
};
use pa_core::session_engine::empty_reply::{is_empty_of_substance, thinking_step_lower};

impl AgentSessionEngine {
    /// Drive one admitted prompt through the retry-driver model loop and
    /// emit the turn outcome (provider-failure retries + final-row
    /// surfacing). The trailing `Done` is owned by the caller.
    ///
    /// The empty-of-substance contract rides on top: a clean-stopped reply
    /// whose entire visible content is missing — or a degenerate stub with
    /// thinking present — ends the turn silently (the silent-stop bug class:
    /// a reasoning model that burns its output budget on thinking ends its
    /// reply clean with no visible text); the user sees nothing, nothing
    /// retries, nothing errors. One bounded retry re-issues the turn with an
    /// explicit instruction to emit the answer as text and, where the model
    /// supports the step, the thinking level one rung lower (a lower effort
    /// level burns less of the output budget on thinking, leaving the text
    /// room the starvation ate). A second empty reply surfaces a visible
    /// error — never silence.
    pub(super) fn run_model_turn(
        &self,
        admission: TurnAdmission,
        prompt: &TurnPrompt,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> TurnResult {
        let result = self.run_model_turn_episode(admission, prompt, boundary_passed, aborted, emit);
        let is_empty = match &result {
            TurnResult::Message(message) => is_empty_of_substance(message),
            _ => false,
        };
        if !is_empty || aborted() {
            return result;
        }
        // The retry's prompt: an explicit instruction to emit the answer as
        // text, admitted fresh over the settled context (the original prompt
        // and the empty reply stay as context rows).
        let retry_prompt = TurnPrompt::User {
            text: EMPTY_REPLY_RETRY_INSTRUCTION.to_string(),
            images: Vec::new(),
            batch: Vec::new(),
        };
        // Where the model supports the step, the retry runs one thinking
        // rung lower — a lower effort level burns less of the output budget
        // on thinking, leaving the text room the starvation ate. The
        // step-down is retry-scoped: a routed episode serves the armed
        // image route's model and level (the agent override wins the loop
        // config, so the step-down lowers the override), an ordinary one
        // the session model and its level. The restore re-reads the
        // session's own level, so a /thinking change made while the retry
        // ran wins over the pre-retry capture.
        let current_thinking = self.effective_thinking();
        let step_down = match self.armed_image_route() {
            Some(route) => {
                let level = model_thinking_level(route.agent_override.thinking_level);
                let model = route.target.model.clone();
                self.session_agent(&model)
                    .ok()
                    .map(|agent| (agent, Some(route), model, level))
            }
            None => self.resolve_model().ok().and_then(|model| {
                self.session_agent(&model)
                    .ok()
                    .map(|agent| (agent, None, model, current_thinking))
            }),
        };
        if step_down.is_none() {
            // No resolvable serving model at the retry boundary: the
            // reasoning relief is lost (the retry episode surfaces the same
            // resolution failure itself) — never silently in the daemon
            // log.
            eprintln!(
                "pa-daemon: empty-reply retry could not resolve the serving model for the thinking step-down"
            );
        }
        let retried = match step_down {
            Some((agent, route, model, level)) if thinking_step_lower(&model, level) != level => {
                let lowered_thinking = thinking_step_lower(&model, level);
                if let Some(route) = route {
                    // A routed episode serves the armed image route: the
                    // agent override wins the loop config, so the step-down
                    // lowers the override and restores it after.
                    agent.set_model_override(Some(pa_agent::agent::AgentModelOverride {
                        thinking_level: map_thinking_level(lowered_thinking),
                        ..route.agent_override.clone()
                    }));
                    let retried = self.run_model_turn_episode(
                        TurnAdmission::FreshPrompt,
                        &retry_prompt,
                        boundary_passed,
                        aborted,
                        emit,
                    );
                    agent.set_model_override(Some(route.agent_override));
                    retried
                } else {
                    self.runtime
                        .block_on(agent.set_thinking_level(map_thinking_level(lowered_thinking)));
                    let retried = self.run_model_turn_episode(
                        TurnAdmission::FreshPrompt,
                        &retry_prompt,
                        boundary_passed,
                        aborted,
                        emit,
                    );
                    // The restore re-reads the session's level: a
                    // /thinking change made during the retry survives.
                    let restored = self.effective_thinking();
                    self.runtime
                        .block_on(agent.set_thinking_level(map_thinking_level(restored)));
                    retried
                }
            }
            // No supported step, or no resolvable serving model: the
            // instruction-only retry still fires.
            _ => self.run_model_turn_episode(
                TurnAdmission::FreshPrompt,
                &retry_prompt,
                boundary_passed,
                aborted,
                emit,
            ),
        };
        match retried {
            TurnResult::Message(retried) if is_empty_of_substance(&retried) => TurnResult::Error {
                error: EMPTY_REPLY_TURN_ERROR.to_string(),
                assistant: Some(retried),
            },
            other => other,
        }
    }

    /// One failover-driven episode of the model turn: the provider-retry
    /// loop over the attempt/emit/wait/switch callbacks, the final-row
    /// surfacing, and the primary-restore cleanup. [`Self::run_model_turn`]
    /// drives the empty-of-substance retry over whole episodes of this.
    fn run_model_turn_episode(
        &self,
        admission: TurnAdmission,
        prompt: &TurnPrompt,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> TurnResult {
        #[derive(Clone)]
        struct FailoverPrimary {
            model: pa_types::ai::Model,
            thinking_level: pa_agent::types::ThinkingLevel,
            api_key: Option<String>,
            headers: Option<std::collections::BTreeMap<String, String>>,
            session_restored: bool,
        }
        let model = match self.resolve_model() {
            Ok(model) => model,
            Err(error) => {
                return TurnResult::Error {
                    error: error.to_string(),
                    assistant: None,
                };
            }
        };
        // The preflight validates the model SERVING the run: a model whose
        // provider has no configured credential fails the run before the
        // provider request, with the login-guidance message — a routed
        // image-model episode authenticates its own image model.
        let preflight_model = self
            .armed_image_route()
            .map_or_else(|| model.clone(), |route| route.target.model);
        if self.config.faux_script.is_none() && self.current_selection().api_key.is_none() {
            let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
            let mut registry = pa_core::models::ModelRegistry::create(
                auth,
                self.config.agent_dir.join("models.json"),
            );
            registry.load_private_authorization_from_cache();
            if !registry.has_configured_auth(&preflight_model) {
                let uses_oauth = registry
                    .auth
                    .get_all()
                    .credential(&preflight_model.provider)
                    .is_some_and(|credential| {
                        matches!(credential, pa_core::auth::AuthCredential::Oauth { .. })
                    });
                let message = if uses_oauth {
                    format!(
                        "Authentication failed for \"{}\". Credentials may have expired or network is unavailable.\n\nRun /login to update credentials.",
                        preflight_model.provider
                    )
                } else {
                    let docs = pa_core::packages::docs_path();
                    format!(
                        "No API key found for {}.\n\nUse /login to log into a provider via OAuth or API key. See:\n  {}\n  {}",
                        preflight_model.provider,
                        docs.join("providers.md").display(),
                        docs.join("models.md").display()
                    )
                };
                return TurnResult::Error {
                    error: message,
                    assistant: None,
                };
            }
        }
        let agent = match self.session_agent(&model) {
            Ok(agent) => agent,
            Err(error) => {
                return TurnResult::Error {
                    error: format!("{error:#}"),
                    assistant: None,
                };
            }
        };
        // The delivery's cancel flag is consulted at the admission, before
        // the agent run registers: an abort landing in the [pickup,
        // registration] window is otherwise lost. Delivery-scoped by
        // construction.
        if aborted() {
            return TurnResult::Aborted;
        }
        // A routed image-model episode applies its override BEFORE the
        // first provider call: the serving target swaps to the image
        // model (the agent state itself never swaps — per-run, like TS).
        self.apply_armed_image_route(&agent);
        let policy = self.retry_policy();
        let failover_policy = self.failover_policy();
        // A routed episode serves (and fails over within) the ROUTED
        // model: the candidate chain derives from the serving model.
        let candidates = match self.armed_image_route() {
            Some(route) => self.failover_candidates(&route.target.model),
            None => self.failover_candidates(&model),
        };
        // The pa-core retry driver owns the attempt loop; this engine
        // owns one turn. The single `emit` reference is handed through
        // a RefCell slot to whichever closure is currently running.
        let emit_cell = std::cell::RefCell::new(emit);
        // The overflow compact-and-retry re-issues the loop without a new
        // user message, so its turn starts as a continuation (TS
        // `agent.continue()`); ordinary turns start fresh.
        let first_attempt = std::cell::Cell::new(matches!(admission, TurnAdmission::FreshPrompt));
        // Failover switch/restore re-bind the live agent's model, append
        // the model-change row, and re-bind the turn-boundary model facts
        // (`model.info` follows the session model). The first successful
        // backup response restores session state before tools, like TS; the
        // captured run still serves backup traffic until it settles.
        let core = {
            let guard = self.session.blocking_lock();
            guard.as_ref().cloned()
        };
        let persistence = core.as_ref().map(|core| core.session.shared_persistence());
        // Retry/failover adoption telemetry (TS `auto_retry_start` counting):
        // retries increment `retry_count`, provider switches `failover_count`.
        // The semantic-edge recorder rides the same snapshot (TS
        // `prepareTurnRetry` / `clearTurnRetry` ride the retry events: the
        // parked id makes the retried call reuse the failed attempt's
        // idempotency key).
        let (telemetry, semantic_edges) = {
            let guard = self.session.blocking_lock();
            (
                guard.as_deref().and_then(|engine| engine.telemetry.clone()),
                guard
                    .as_deref()
                    .and_then(|engine| engine.session.semantic_edges()),
            )
        };
        // The failover-captured primary target state (TS `_backupModel`):
        // Session state restores at successful message_end; request auth
        // stays on the backup until the active run settles.
        let primary_state = std::sync::Arc::new(std::sync::Mutex::new(None::<FailoverPrimary>));
        let pending_model_changes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<
            pa_types::session::ModelChangeEntry,
        >::new()));
        // The quota-park seam (TS #2375): the retry chain consults the
        // engine at its give-up; a quota failure whose reset exceeds
        // the wait cap parks the session. The weak self keeps the
        // callback `'static`.
        let quota_parked_flag = std::sync::Arc::clone(&self.quota_parked_this_run);
        let engine_weak = self
            .self_weak
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let park: Option<pa_core::session_engine::provider_park::ParkDecisionCallback> =
            Some(&mut move |message, abort| {
                let engine_weak = engine_weak.clone();
                let abort = abort.to_string();
                let quota_parked_flag = std::sync::Arc::clone(&quota_parked_flag);
                Box::pin(async move {
                    let engine = engine_weak.as_ref().and_then(std::sync::Weak::upgrade)?;
                    let outcome = engine.park_for_quota_reset(&message, &abort).await;
                    if outcome.is_some() {
                        quota_parked_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    outcome
                })
            });
        let overflow_window = match self.armed_image_route() {
            Some(route) => route.target.model.context_window,
            None => model.context_window,
        };
        let restore_subscription = self.runtime.block_on(async {
            // Awaited before tool execution. The agent loop has already
            // captured its serving model, so restoring session state here
            // does not redirect the remaining backup provider requests.
            let primary_state = primary_state.clone();
            let pending_model_changes = pending_model_changes.clone();
            let agent_weak = std::sync::Arc::downgrade(&agent);
            let core = core.clone();
            let persistence = persistence.clone();
            agent
                .subscribe(move |event, _signal| {
                    let primary_state = primary_state.clone();
                    let pending_model_changes = pending_model_changes.clone();
                    let agent_weak = agent_weak.clone();
                    let core = core.clone();
                    let persistence = persistence.clone();
                    Box::pin(async move {
                        let pa_agent::types::AgentEvent::MessageEnd {
                            message:
                                pa_agent::types::AgentMessage::Standard(
                                    pa_agent::types::Message::Assistant(assistant),
                                ),
                        } = event
                        else {
                            return Ok(());
                        };
                        if matches!(
                            assistant.stop_reason,
                            StopReason::Error | StopReason::Aborted
                        ) {
                            return Ok(());
                        }
                        let primary = primary_state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        let Some(primary) = primary.filter(|primary| !primary.session_restored)
                        else {
                            return Ok(());
                        };
                        let Some(agent) = agent_weak.upgrade() else {
                            return Ok(());
                        };
                        let model = json_round_trip(&primary.model)
                            .ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
                        agent
                            .set_model_and_thinking_level(model, primary.thinking_level)
                            .await;
                        if let Some(core) = core {
                            core.update_model_facts(&primary.model);
                        }
                        if let Some(persistence) = persistence {
                            persistence
                                .lock()
                                .await
                                .append_model_change(&primary.model.provider, &primary.model.id)?;
                        }
                        // The later run_once subscriber forwards this after the
                        // assistant row and before tool execution, matching TS.
                        pending_model_changes
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(pa_types::session::ModelChangeEntry {
                                provider: primary.model.provider.clone(),
                                model_id: primary.model.id.clone(),
                            });
                        if let Some(primary) = primary_state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .as_mut()
                        {
                            primary.session_restored = true;
                        }
                        Ok(())
                    })
                })
                .await
        });
        let restore_primary = || {
            let emit_cell = &emit_cell;
            let primary_state = primary_state.clone();
            let agent = agent.clone();
            let persistence = persistence.clone();
            let core = core.clone();
            let primary = primary_state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            async move {
                let Some(FailoverPrimary {
                    model: primary_model,
                    thinking_level,
                    api_key: primary_api_key,
                    headers: primary_headers,
                    session_restored,
                }) = primary
                else {
                    return Ok(None);
                };
                let agent_model = json_round_trip(&primary_model)
                    .ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
                {
                    // The restore serializes with `/reload`'s
                    // live-input refresh: without this fence a
                    // reload landing between the restore's
                    // resolution and its slot write is clobbered
                    // by the restore's older pair — the lock
                    // makes whichever runs last leave the newest
                    // store standing. The whole turn (this
                    // closure included) runs on the blocking
                    // pool — the worker parks the turn there
                    // (`worker/turn.rs`) — so the synchronous
                    // credential resolution below, OAuth refresh
                    // and all, never touches an async executor
                    // worker; only a concurrently reloading
                    // session waits on this span.
                    let _reload_serialized = self
                        .reload_lock
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    // The armed-route install goes through the
                    // fenced helper (no provider-slot lock held
                    // across the route read).
                    if !self.install_armed_route_target() {
                        // The primary's request auth re-resolves at
                        // restore: a credential rotated (and
                        // reloaded) during the failover serves from
                        // the store, never the pre-failover
                        // capture.
                        let target = self.restored_primary_target(
                            &primary_model,
                            primary_api_key,
                            primary_headers,
                        );
                        *self.provider_target.write().expect("provider target lock") = Some(target);
                    }
                }
                agent.set_model(agent_model).await;
                agent.set_thinking_level(thinking_level).await;
                if let Some(core) = &core {
                    core.update_model_facts(&primary_model);
                }
                if let Some(persistence) = persistence.filter(|_| !session_restored) {
                    persistence
                        .lock()
                        .await
                        .append_model_change(&primary_model.provider, &primary_model.id)?;
                }
                if !session_restored
                    && !(emit_cell.borrow_mut())(EngineEvent::ModelChange(
                        pa_types::session::ModelChangeEntry {
                            provider: primary_model.provider.clone(),
                            model_id: primary_model.id.clone(),
                        },
                    ))
                {
                    anyhow::bail!("Model restoration persistence was cancelled");
                }
                if let Some(primary) = primary_state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_mut()
                {
                    primary.session_restored = true;
                }
                Ok(Some(format!(
                    "{}/{}",
                    primary_model.provider, primary_model.id
                )))
            }
        };
        let result = self.runtime.block_on(
            pa_core::session_engine::provider_failover::run_turn_with_provider_failover(
                &policy,
                &failover_policy,
                &candidates,
                overflow_window,
                None,
                || {
                    let mut emit = emit_cell.borrow_mut();
                    let first = first_attempt.get();
                    first_attempt.set(false);
                    let agent = agent.clone();
                    let prompt = prompt.clone();
                    let model = model.clone();
                    let pending_model_changes = pending_model_changes.clone();
                    async move {
                        // A retry re-issues the failed turn: the failed
                        // assistant message leaves the loop context first
                        // (TS `messages.slice(0, -1)`), then `continue`.
                        if !first {
                            drop_trailing_assistant(&agent).await;
                        }
                        let mut admit_prompt = first;
                        loop {
                            let assistant = match self
                                .run_turn_once(
                                    &agent,
                                    &prompt,
                                    admit_prompt,
                                    boundary_passed,
                                    &pending_model_changes,
                                    aborted,
                                    &mut **emit,
                                )
                                .await
                            {
                                Ok(TurnOnce::Message { assistant }) => *assistant,
                                Ok(TurnOnce::None) => {
                                    return Err(anyhow::anyhow!("No response produced."));
                                }
                                Ok(TurnOnce::Aborted) => return Ok(aborted_message(&model)),
                                Err(error) => return Err(error),
                            };
                            if !self
                                .threshold_yielded
                                .swap(false, std::sync::atomic::Ordering::SeqCst)
                            {
                                return Ok(assistant);
                            }
                            // Requested boundaries stay owned by run_turns; consuming one here
                            // would lose its explicit stop and goal-continuation semantics.
                            let core = self.session.lock().await.clone();
                            let pending = match core {
                                Some(core) => {
                                    core.turn_boundary.compaction_scheduled().await
                                        || core.turn_boundary.refine_pending().await
                                }
                                None => false,
                            };
                            if aborted() {
                                return Ok(aborted_message(&model));
                            }
                            if pending
                                || self
                                    .config
                                    .queued_steering_probe
                                    .as_ref()
                                    .is_some_and(|probe| probe())
                            {
                                return Ok(assistant);
                            }
                            if aborted() {
                                return Ok(aborted_message(&model));
                            }
                            // Keep the retry/failover episode alive across this artificial
                            // yield. The engine owns a multi-thread runtime; the synchronous
                            // compaction boundary may re-enter it without holding async locks.
                            let outcome = tokio::task::block_in_place(|| {
                                self.run_auto_compaction(&mut **emit)
                            });
                            self.threshold_checks_enabled.store(
                                outcome.continues_threshold_checks(),
                                std::sync::atomic::Ordering::SeqCst,
                            );
                            if outcome == crate::auto_compaction::AutoCompactionRun::Cancelled
                                || aborted()
                            {
                                return Ok(aborted_message(&model));
                            }
                            if self
                                .config
                                .queued_steering_probe
                                .as_ref()
                                .is_some_and(|probe| probe())
                            {
                                return Ok(assistant);
                            }
                            // Continue the tool run without dropping its successful assistant
                            // or inserting another copy of the admitted user prompt.
                            admit_prompt = false;
                        }
                    }
                },
                |event| {
                    let mut emit = emit_cell.borrow_mut();
                    let telemetry = telemetry.clone();
                    let semantic_edges = semantic_edges.clone();
                    async move {
                        // TS parks the id at `auto_retry_start` and clears
                        // it at the settle (`_resolveRetry`), so a
                        // body-identical retry reuses the failed
                        // attempt's id; the parked id lives until the
                        // next turn mints over it otherwise.
                        if let Some(recorder) = &semantic_edges {
                            match &event {
                                pa_core::session_engine::auto_retry::AutoRetryEvent::Start {
                                    ..
                                } => recorder.prepare_turn_retry(),
                                pa_core::session_engine::auto_retry::AutoRetryEvent::End {
                                    ..
                                } => {
                                    recorder.clear_turn_retry();
                                }
                            }
                        }
                        if let Some(telemetry) = &telemetry {
                            // One retry event in, one telemetry seam out.
                            telemetry.note_auto_retry_event(&event);
                        }
                        let engine_event = retry_event_to_engine_event(event);
                        if !emit(engine_event) {
                            anyhow::bail!("emit cancelled");
                        }
                        Ok(())
                    }
                },
                |delay| {
                    async move {
                        // Abort-aware wait: the cancel flag stops the retry sleep early (TS
                        // `_retryAbortController`).
                        let deadline = tokio::time::Instant::now() + delay;
                        loop {
                            if aborted() {
                                return false;
                            }
                            if tokio::time::Instant::now() >= deadline {
                                return true;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                },
                |next: &pa_types::ai::Model| {
                    let emit_cell = &emit_cell;
                    let agent = agent.clone();
                    let persistence = persistence.clone();
                    let core = core.clone();
                    let primary_state = primary_state.clone();
                    {
                        let mut primary = primary_state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        // Capture the primary state once (TS `_backupModel`), restored when the
                        // successful backup response arrives.
                        if primary.is_none() {
                            let (api_key, headers) = self.resolve_request_key_and_headers(&model);
                            *primary = Some(FailoverPrimary {
                                model: model.clone(),
                                thinking_level: map_thinking_level(self.effective_thinking()),
                                api_key,
                                headers,
                                session_restored: false,
                            });
                        } else if let Some(primary) = primary.as_mut() {
                            primary.session_restored = false;
                        }
                    }
                    let next = next.clone();
                    async move {
                        let agent_model = json_round_trip(&next)
                            .ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
                        // Clamp the AGENT'S LIVE level to the switched-to
                        // model (TS `clampThinkingLevel`), not the session's
                        // cached one: a mid-episode level change (the
                        // empty-reply retry's step-down, or a /thinking that
                        // landed mid-turn) survives the failover chain, and
                        // the captured primary below follows it, so the
                        // restore returns to the live level too.
                        let live_level = agent.state().await.thinking_level;
                        let clamped = pa_ai::models::clamp_thinking_level(
                            &next,
                            model_thinking_level(live_level),
                        );
                        if let Some(primary) = primary_state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .as_mut()
                        {
                            primary.thinking_level = live_level;
                        }
                        // The stream's provider target follows the switch (the same slot
                        // `set_model` swaps).
                        {
                            // The switch's resolve-and-install serializes
                            // with `/reload`'s live-input refresh — the
                            // restore path in the sibling callback takes
                            // the same lock: a reload landing between
                            // this resolution and its slot write must not
                            // be clobbered by the switch's older pair. The
                            // turn runs on the blocking pool, so the
                            // synchronous resolution never touches an
                            // async executor worker.
                            let _reload_serialized = self
                                .reload_lock
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            // A routed episode keeps serving the route's
                            // target across the failover switch — through
                            // the fenced install (the route lock covers
                            // the clone and the slot write together).
                            if !self.install_armed_route_target() {
                                let (api_key, headers) =
                                    self.resolve_request_key_and_headers(&next);
                                let mut target =
                                    self.provider_target.write().expect("provider target lock");
                                *target = Some(ProviderTarget {
                                    service_tier: *self
                                        .service_tier
                                        .read()
                                        .expect("service tier lock"),
                                    api_key,
                                    model: next.clone(),
                                    headers,
                                });
                            }
                        }
                        agent.set_model(agent_model).await;
                        agent.set_thinking_level(map_thinking_level(clamped)).await;
                        if let Some(core) = &core {
                            core.update_model_facts(&next);
                        }
                        if let Some(persistence) = persistence {
                            let mut session = persistence.lock().await;
                            session.append_model_change(&next.provider, &next.id)?;
                        }
                        if !(emit_cell.borrow_mut())(EngineEvent::ModelChange(
                            pa_types::session::ModelChangeEntry {
                                provider: next.provider.clone(),
                                model_id: next.id.clone(),
                            },
                        )) {
                            anyhow::bail!("Model switch persistence was cancelled");
                        }
                        Ok(())
                    }
                },
                &restore_primary,
                park,
            ),
        );
        self.runtime.block_on(restore_subscription.unsubscribe());
        // A failing awaited listener (including a failed model-change
        // append) exits the retry driver before its normal restore callback.
        // Always restore the transport as well, while preserving both errors.
        let result = match result {
            Err(error) => match self.runtime.block_on(restore_primary()) {
                Ok(_) => Err(error),
                Err(cleanup) => Err(anyhow::anyhow!(
                    "{error:#}; primary restoration also failed: {cleanup:#}"
                )),
            },
            Ok(message) => Ok(message),
        };
        match result {
            Ok(message) => match message.stop_reason {
                // The failure already reached the transcript as the final
                // assistant message; the turn error still travels to
                // headless callers through the turn result.
                StopReason::Error => TurnResult::Error {
                    error: message
                        .error_message
                        .clone()
                        .filter(|error| !error.is_empty())
                        .unwrap_or_else(|| "Assistant response failed".to_string()),
                    assistant: Some(Box::new(message)),
                },
                StopReason::Aborted => TurnResult::Aborted,
                _ => TurnResult::Message(Box::new(message)),
            },
            Err(error) => TurnResult::Error {
                error: error.to_string(),
                assistant: None,
            },
        }
    }
}
