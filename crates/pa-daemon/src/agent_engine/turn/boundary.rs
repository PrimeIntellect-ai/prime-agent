//! The turn boundary: the boundary run (compaction + overflow arms +
//! goal continuation), the stale boundary-request drop, and the
//! auto-compaction abort clear.
use super::{AbortController, AgentSessionEngine, BoundaryRun, EngineEvent, Value};

impl AgentSessionEngine {
    /// Clear the automatic-compaction abort slot when `controller`'s run
    /// settles: only the run that assigned the controller clears it.
    pub(crate) fn clear_auto_compaction_abort(&self, controller: &std::sync::Arc<AbortController>) {
        let mut slot = self
            .auto_compaction_abort
            .lock()
            .expect("auto compaction abort lock");
        if slot
            .as_ref()
            .is_some_and(|live| std::sync::Arc::ptr_eq(live, controller))
        {
            *slot = None;
        }
    }

    /// Drop pending turn-boundary requests (aborted turns clear both).
    pub(super) fn drop_turn_boundary_requests(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime.block_on(engine.turn_boundary.clear_pending());
        }
    }

    /// Consume pending `compact.run`/`refine.run` requests at the settled
    /// turn boundary, compaction first, then refinement. A consumed
    /// compaction stops the run on purpose; the model resumes on the next
    /// prompt.
    pub(super) fn run_turn_boundary(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> BoundaryRun {
        // Fast path: nothing scheduled (the common turn).
        let has_pending = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self.runtime.block_on(async {
                    engine.turn_boundary.compaction_scheduled().await
                        || engine.turn_boundary.refine_pending().await
                }),
                None => false,
            }
        };
        if !has_pending {
            return BoundaryRun::Proceed;
        }
        // The session's live model, never a fresh startup-chain resolution
        // (a re-resolution landed the summarizer on an unconfigured
        // provider).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                eprintln!("pa-daemon: boundary request could not resolve a model: {error:#}");
                return BoundaryRun::Proceed;
            }
        };
        let (model, api_key) = self.resolve_request_target(model);
        // The start event goes out before the summarizer runs, carrying the
        // pending instructions.
        let scheduled = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.turn_boundary.scheduled_compaction().await }),
                None => None,
            }
        };
        if let Some(pending) = scheduled {
            if !emit(EngineEvent::CompactionStart {
                event: crate::compaction::compaction_start_event(
                    "requested",
                    pending.instructions.as_deref(),
                ),
            }) {
                return BoundaryRun::Cancelled;
            }
        }
        // The requested run owns the abort slot for its duration: an
        // `abort_compaction` lands in the slot and cancels the in-flight
        // summarizer.
        let controller = std::sync::Arc::new(AbortController::new());
        let signal = controller.signal();
        {
            *self
                .auto_compaction_abort
                .lock()
                .expect("auto compaction abort lock") = Some(std::sync::Arc::clone(&controller));
        }
        let consumption = {
            let engine = self.session.blocking_lock().clone();
            let Some(engine) = engine else {
                self.clear_auto_compaction_abort(&controller);
                return BoundaryRun::Proceed;
            };
            let consumed = self.runtime.block_on(async {
                let compaction = engine
                    .consume_pending_compaction(&model, api_key.clone(), Some(&signal))
                    .await;
                if let Some(pending) = engine.start_pending_refinement(&model, api_key).await {
                    self.report_background_refinement(pending);
                }
                compaction
            });
            self.clear_auto_compaction_abort(&controller);
            consumed
        };
        let mut stopped_for_compaction = false;
        let mut compacted = false;
        match consumption {
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Ran(run))) => {
                // The post-compaction kernel notice goes out before the settled end;
                // its pair precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return BoundaryRun::Cancelled;
                    }
                }
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction(Some(run.duration_ms));
                    }
                }
                // The run stops on purpose; the worker services the armed review off
                // the settle (never before the `Done`).
                self.mark_compact_auto_refine_pending();
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                // The wire result is the `CompactionResult` shape; the event reason
                // is `requested`.
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let event =
                    crate::compaction::compaction_end_success("requested", &result, false, None);
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
                compacted = true;
            }
            // A skip consumed the request: the disclosure row goes out
            // with its pair, then the end event carries the TS warning.
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Skipped(
                message,
            ))) => {
                eprintln!("pa-daemon: requested compaction skipped: {message}");
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    pa_core::session_engine::messages::CompactionOutcomeKind::Skipped,
                    &format!("Requested compaction skipped: {message}"),
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            Some(Err(error)) => {
                // An aborted run is user-initiated, not a failure: the request is
                // consumed either way, so the run stops.
                let cancelled = pa_agent::abort::is_abort_error(&error);
                let message = if cancelled {
                    "Requested compaction cancelled".to_string()
                } else {
                    eprintln!("pa-daemon: requested compaction failed: {error:#}");
                    format!("Requested compaction failed: {error:#}")
                };
                let outcome = if cancelled {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Cancelled
                } else {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Failed
                };
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    outcome,
                    &message,
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            None => {}
        }

        if stopped_for_compaction {
            BoundaryRun::StoppedForCompaction { compacted }
        } else {
            BoundaryRun::Proceed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_engine::tests::{admit, write_compaction_settings};
    use crate::agent_engine::FAUX_TEST_LOCK;
    use crate::agent_engine::{AgentEngineConfig, AgentSessionEngine};
    use pa_core::session_engine::refine::CommittedRefinement;
    use pa_core::session_engine::turn_boundary::PendingRefine;
    use serde_json::json;

    /// One faux-driven engine over its own tempdir: the shared helper pins
    /// `session_dir` to `None`, so the config is written here — the sessions
    /// root, the durable conversation log under it (the engine session is
    /// non-persisted, so its artifact tree and local harness store are the
    /// ones the log path implies), and the agent dir the global store
    /// resolves under. `responses` drive the seed turn and each refinement's
    /// planning call.
    fn refinement_engine(
        dir: &tempfile::TempDir,
        responses: &[serde_json::Value],
    ) -> std::sync::Arc<AgentSessionEngine> {
        write_compaction_settings(dir.path(), 1);
        let engine = std::sync::Arc::new(
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: Some(dir.path().join("sessions")),
                session_file: Some(dir.path().join("sessions").join("engine-session.jsonl")),
                faux_script: Some(json!({ "responses": responses.to_vec() }).to_string()),
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap(),
        );
        // The worker registers the engine's own arc: the live-auth
        // resolver upgrades it per provider call.
        engine.register_arc();
        engine
    }

    /// Schedule one refinement (local or global), run the turn boundary,
    /// and return the committed refinement the background sink handed off.
    fn run_refinement(
        engine: &std::sync::Arc<AgentSessionEngine>,
        instructions: &str,
        global: bool,
    ) -> CommittedRefinement {
        {
            let guard = engine.session.blocking_lock();
            let session = guard.as_ref().expect("built session");
            engine
                .runtime
                .block_on(session.turn_boundary.schedule_refine(PendingRefine {
                    instructions: Some(instructions.to_string()),
                    global,
                }));
        }
        let (send, receive) = std::sync::mpsc::channel();
        *engine.refinement_completion_sink.lock().unwrap() =
            Some(std::sync::Arc::new(move |pending| {
                send.send(pending).unwrap();
            }));
        let boundary = engine.run_turn_boundary(&mut |_| true);
        assert!(matches!(boundary, BoundaryRun::Proceed));
        let pending = receive
            .try_recv()
            .expect("completion handed to background sink");
        engine.runtime.block_on(pending).unwrap().unwrap()
    }

    #[test]
    fn requested_refinement_commits_its_durable_outcome_row() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = refinement_engine(
            &dir,
            &[
                json!("seed reply"),
                json!({"text": json!({
                    "summary": "No durable change justified",
                    "rationale": "Fixture only",
                    "expectedOutcome": "No change",
                    "edits": []
                }).to_string()}),
            ],
        );
        admit(&engine, "seed turn".to_string(), &mut Vec::new());
        let committed = run_refinement(&engine, "Verify the completed outcome", false);
        let outcomes = committed
            .rows
            .iter()
            .filter(|row| row.custom_type == "refinement_outcome")
            .count();
        assert_eq!(
            outcomes, 1,
            "one durable outcome, including a no-op refinement"
        );
    }

    /// The daemon's refinements write the store pair the session's digest
    /// reads: the local refinement lands in the artifact store the
    /// conversation log implies, and the global refinement lands in the
    /// agent dir's harness store.
    #[test]
    fn the_daemons_refinements_write_the_digests_store_pair() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = refinement_engine(
            &dir,
            &[
                json!("seed reply"),
                json!({"text": json!({
                    "summary": "Record the local seam",
                    "rationale": "Fixture only",
                    "edits": [{
                        "action": "create",
                        "kind": "memory",
                        "id": "l1",
                        "title": "Local tactic",
                        "content": "Prefer the artifact store"
                    }]
                }).to_string()}),
                json!({"text": json!({
                    "summary": "Record the shared seam",
                    "rationale": "Fixture only",
                    "edits": [{
                        "action": "create",
                        "kind": "memory",
                        "id": "g1",
                        "title": "Global tactic",
                        "content": "Prefer the shared seam"
                    }]
                }).to_string()}),
            ],
        );
        admit(&engine, "seed turn".to_string(), &mut Vec::new());
        let conversation_log = dir.path().join("sessions").join("engine-session.jsonl");
        // The local half: the session's own artifact store, the one the
        // conversation log implies.
        let committed = run_refinement(&engine, "Record the local seam", false);
        let local_store =
            pa_core::session_engine::harness_digest::local_harness_dir_for_log(&conversation_log)
                .expect("the conversation log implies the artifact store");
        assert_eq!(
            std::path::Path::new(&committed.result.harness_state_path),
            pa_core::refinement::get_harness_state_path(&local_store),
            "the daemon's local refinement wrote the session's own artifact store"
        );
        let local_state = pa_core::refinement::load_harness_state(
            &local_store,
            pa_core::refinement::HarnessScope::Local,
        );
        assert!(
            local_state.entries[&pa_core::refinement::RefinementKind::Memory].contains_key("l1"),
            "the local edit lands in the session's own harness store"
        );
        // The global half: the agent dir's harness store, the one the
        // session's digest context carries.
        let global_committed = run_refinement(&engine, "Record a durable global tactic", true);
        let agent_dir = dir.path().join("agent");
        let global_dir = pa_core::refinement::get_global_harness_state_dir(&agent_dir);
        let global_state = pa_core::refinement::load_harness_state(
            &global_dir,
            pa_core::refinement::HarnessScope::Global,
        );
        assert!(
            global_state.entries[&pa_core::refinement::RefinementKind::Memory].contains_key("g1"),
            "the global edit lands in the agent dir's harness store"
        );
        assert_eq!(
            std::path::Path::new(&global_committed.result.harness_state_path),
            pa_core::refinement::get_harness_state_path(&global_dir),
            "the daemon's global refinement wrote the agent dir's harness store"
        );
        // The digest half of the pair is pinned at the pa-core seam
        // (`daemon_shaped_local_refinement_writes_the_sessions_own_harness_store`):
        // the digest renders the session's own digest context, and the
        // refinement `harness_state_path` asserts above pin that same
        // context's store pair through the daemon's wiring. Rebuilding
        // the context here by hand would re-derive the paths this test
        // just asserted and could not fail.
    }
}
