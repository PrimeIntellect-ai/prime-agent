//! The dispatch surface: command routing, the command handlers,
//! and the abort family.
use super::{
    json, persist_custom_row, response_failure, response_success, KillCloseReason, Lane,
    QueueCheckpoint, QueuedItem, Result, SessionFile, TurnSettle, VecDeque, Worker,
    PROMPT_ABORTED_BEFORE_DELIVERY, SIDE_QUESTION_SETTLE_TIMEOUT,
};

use serde_json::Value;

use crate::protocol::DaemonResponse;

impl Worker {
    pub(crate) async fn dispatch(&self, command_type: &str, payload: &Value) -> DaemonResponse {
        if self.recovery_quarantined() {
            return response_failure(
                None,
                command_type,
                crate::cloud_family::CLOUD_COMMIT_UNCERTAIN,
                None,
            );
        }
        // Only operations that inspect or change historical branches need hydration.
        // Cancellation is deliberately excluded: it must reach the live turn immediately.
        if matches!(
            command_type,
            "get_session_tree"
                | "get_context_tree"
                | "get_user_messages_for_forking"
                | "set_session_entry_label"
                | "navigate_tree"
                | "fork"
                | "export_html"
                | "export_jsonl"
        ) && self
            .core
            .lock()
            .unwrap()
            .store
            .as_ref()
            .is_some_and(|store| store.window.is_some())
        {
            let path = self
                .core
                .lock()
                .unwrap()
                .store
                .as_ref()
                .unwrap()
                .path
                .clone();
            let load_path = path.clone();
            let hydrated = tokio::task::spawn_blocking(move || SessionFile::open(&load_path))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result);
            match hydrated {
                Ok(full) => {
                    let mut core = self.core.lock().unwrap();
                    if let Some(store) = core.store.as_mut().filter(|store| store.path == path) {
                        store.install_full_history(full);
                    }
                }
                Err(error) => {
                    return response_failure(None, command_type, &error.to_string(), None);
                }
            }
            // The hydrated full file was a transient whole-file copy on
            // top of the installed history: release its freed heap.
            pa_types::memory_release::trim_freed_heap();
        }
        let response = match command_type {
            "create" => self.handle_create(payload).await,
            "attach" => self.handle_attach(payload),
            "detach" => self.handle_detach(payload),
            "prompt" => self.handle_prompt(payload, false).await,
            "prompt_and_wait" => self.handle_prompt(payload, true).await,
            "steer" => self.handle_queue(payload, Lane::Steering),
            "follow_up" => self.handle_queue(payload, Lane::FollowUp),
            "abort" => self.handle_abort(),
            "abort_and_send_queued" => self.handle_abort_and_send_queued(),
            "start_side_question" => {
                if let Err(response) = self.require_created("start_side_question") {
                    return response;
                }
                self.side_questions.start(payload)
            }
            "abort_side_question" => {
                if let Err(response) = self.require_created("abort_side_question") {
                    return response;
                }
                self.side_questions.abort(payload)
            }
            "compact" => self.handle_compaction(payload).await,
            "abort_compaction" => {
                self.compaction.abort();
                response_success(None, "abort_compaction", None)
            }
            "set_auto_compaction" => self.handle_set_auto_compaction(payload),
            "wait_for_idle" => self.handle_wait_for_idle(payload).await,
            "wait_for_headless_completion" => {
                self.handle_wait_for_headless_completion(payload).await
            }
            "get_state" => self.handle_get_state(),
            "get_messages" => self.handle_get_messages(),
            "get_session_header" => self.handle_get_session_header(),
            "get_session_stats" => self.handle_get_session_stats(),
            "get_model_catalog" => self.handle_get_model_catalog(),
            "get_queue" => self.handle_get_queue(),
            "clear_queue" => self.handle_clear_queue(),
            "abort_and_clear_queue" => self.handle_abort_and_clear_queue(),
            "get_last_assistant_text" => self.handle_get_last_assistant_text(),
            "get_connection_state" => self.handle_get_connection_state(),
            "get_mcp_connections" => self.handle_get_mcp_connections().await,
            "set_mcp_static_token" => self.handle_set_mcp_static_token(payload).await,
            "remove_mcp_connection" => self.handle_remove_mcp_connection(payload).await,
            "get_rlm_children" => self.handle_get_rlm_children().await,
            "get_context_tree" => self.handle_get_context_tree().await,
            "get_commands" => self.handle_get_commands().await,
            "get_resource_snapshot" => self.handle_get_resource_snapshot().await,
            "get_session_context" => self.handle_get_session_context(),
            "get_system_prompt" => self.handle_get_system_prompt().await,
            "get_tool_definition" => self.handle_get_tool_definition(payload).await,
            "get_rlm_max_depth_status" => self.handle_get_rlm_max_depth_status(),
            "get_available_models" => self.handle_get_available_models(),
            "worker_deliver_message" => self.handle_worker_deliver_message(payload),
            "update_snapshot" => self.handle_update_snapshot(),
            "kill" => self.handle_kill(payload).await,
            "shutdown" => self.handle_shutdown().await,
            "rename" => self.handle_rename("rename", payload),
            "set_session_name" => self.handle_rename("set_session_name", payload),
            "mark_anthropic_warning_shown" => self.handle_mark_anthropic_warning_shown(),
            "rename_saved_session" => self.handle_rename_saved_session(payload),
            "delete_saved_session" => self.handle_delete_saved_session(payload).await,
            "replace_acp_mcp_servers" => self.handle_replace_acp_mcp_servers(payload),
            "set_model" => self.handle_set_model(payload).await,
            "set_thinking_level" => self.handle_set_thinking_level(payload).await,
            "cycle_model" => self.handle_cycle_model(payload).await,
            "set_scoped_models" => self.handle_set_scoped_models(payload),
            "cycle_thinking_level" => self.handle_cycle_thinking_level().await,
            "set_service_tier" => self.handle_set_service_tier(payload).await,
            "set_transport" => self.handle_set_transport(payload),
            "set_steering_mode" => self.handle_set_queue_mode("set_steering_mode", payload),
            "set_follow_up_mode" => self.handle_set_queue_mode("set_follow_up_mode", payload),
            "set_auto_retry" => self.handle_set_auto_retry(payload),
            "abort_retry" => self.handle_abort_retry(),
            "get_session_tree" => self.tree_navigation.get_session_tree(),
            "get_user_messages_for_forking" => self.tree_navigation.get_user_messages_for_forking(),
            "set_session_entry_label" => self.tree_navigation.set_session_entry_label(payload),
            "navigate_tree" => self.handle_navigate_tree(payload).await,
            "fork" => self.handle_fork(payload).await,
            "abort_branch_summary" => {
                self.tree_navigation.abort();
                response_success(None, "abort_branch_summary", None)
            }
            "export_html" => self.exports.export_html(payload).await,
            "export_jsonl" => self.exports.export_jsonl(payload),
            "mutate_queued_message" => self.handle_mutate_queued_message(payload),
            "resume_queue" => self.handle_resume_queue(),
            "factory_activity" => self.handle_factory_activity(payload).await,
            "execute_bash" => self.handle_execute_bash(payload),
            "execute_bash_and_wait" => self.handle_execute_bash_and_wait(payload).await,
            "abort_bash" => self.handle_abort_bash().await,
            "list_kernel_bash" | "tail_kernel_bash" | "kill_kernel_bash" => {
                self.handle_kernel_bash_activity(command_type, payload)
                    .await
            }
            "append_custom_message" => self.handle_append_custom_message(payload),
            "restore_next_turn" => self.handle_restore_next_turn(payload),
            "restore_actions" => self.handle_restore_actions(payload),
            "refine" => self.handle_refine(payload).await,
            "reload" => self.handle_reload(),
            "cancel_rlm_child" => self.handle_cancel_rlm_child(payload).await,
            "delete_rlm_subagent" => self.handle_delete_rlm_subagent(payload).await,
            // The engine call blocks on the engine runtime, so it
            // runs on a blocking thread like every other engine call.
            "set_rlm_max_depth" => self.handle_set_rlm_max_depth(payload).await,
            "acquire_session_input_pause" => self.handle_acquire_session_input_pause(payload),
            "release_session_input_pause" => self.handle_release_session_input_pause(payload),
            "cancel_prompt_admission" => self.handle_cancel_prompt_admission(payload),
            "new_session" => self.handle_new_session(payload).await,
            "switch_session" => self.handle_switch_session(payload).await,
            "import_jsonl" => self.handle_import_jsonl(payload).await,
            "agent_messages_status" => self.handle_agent_messages_status(),
            "agent_messages_pause" => self.handle_agent_messages_pause(),
            "agent_messages_resume" => self.handle_agent_messages_resume(),
            "agent_messages_clear" => self.handle_agent_messages_clear(),
            "cron_list" => self.handle_cron_list(payload),
            "heartbeats_list" => self.handle_heartbeats_list(),
            "heartbeat_manage" => self.handle_heartbeat_manage(payload).await,
            "cron_add" => self.handle_cron_add(payload).await,
            "cron_cancel" => self.handle_cron_cancel(payload).await,
            "heartbeat_get" => self.handle_heartbeat_get(payload),
            "heartbeat_set" => self.handle_heartbeat_set(payload).await,
            "heartbeat_update" => self.handle_heartbeat_update(payload).await,
            other => response_failure(
                None,
                command_type,
                &format!("Unknown worker command: {other}"),
                None,
            ),
        };
        // A command admitted just before the fsync failure must not send a
        // success after the keyed delivery quarantined the worker. The
        // journal itself also rejects every later checkpoint under its lock.
        if response.success && self.recovery_quarantined() {
            return response_failure(
                None,
                command_type,
                crate::cloud_family::CLOUD_COMMIT_UNCERTAIN,
                None,
            );
        }
        response
    }

    fn recovery_quarantined(&self) -> bool {
        self.recovery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(crate::journal::WorkerRecoveryJournal::is_quarantined)
    }

    // DaemonResponse is the wire response struct and is deliberately wide; the
    // error channel here carries the whole response, so allow the large-err lint.
    #[allow(clippy::result_large_err)]
    pub(crate) fn require_created(&self, command_type: &str) -> Result<(), DaemonResponse> {
        let core = self.core.lock().unwrap();
        if !core.created {
            return Err(response_failure(
                None,
                command_type,
                "Session is still initializing",
                None,
            ));
        }
        // The shutdown admission gate: a command dispatched while the graceful stop
        // is closing must not start new work the exit would orphan (an execute_bash
        // racing the shutdown would spawn a child the exit leaves running).
        if core.shutdown_requested {
            return Err(response_failure(
                None,
                command_type,
                "Session is shutting down",
                None,
            ));
        }
        Ok(())
    }

    /// `navigate_tree` with the reload's announcement: announced before the
    /// response reaches the client, so surfaces never show the pre-navigation goal.
    async fn handle_navigate_tree(&self, payload: &Value) -> DaemonResponse {
        let response = self.tree_navigation.navigate_tree(payload).await;
        if response.success {
            if let Some(goal) = self.engine.goal_update_after_rebuild() {
                self.emit_worker_event(json!({
                    "type": "goal_update",
                    "goal": goal,
                }));
            }
        }
        response
    }

    /// The session's owner-fenced ACP MCP store: the ACP transport resolves and
    /// validates the servers before sending them; the worker fences ownership,
    /// guards the busy turn, and rolls back a failed replacement.
    fn handle_replace_acp_mcp_servers(&self, payload: &Value) -> DaemonResponse {
        let owner_id = payload
            .get("ownerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if owner_id.is_empty() {
            return response_failure(
                None,
                "replace_acp_mcp_servers",
                "ACP MCP owner id is required",
                None,
            );
        }
        let servers: Vec<pa_core::mcp::AcpMcpServerConfig> = payload
            .get("servers")
            .cloned()
            .map(|servers| serde_json::from_value(servers).unwrap_or_default())
            .unwrap_or_default();
        // The agent cannot adopt a different MCP tool list mid-turn (TS
        // `session.isStreaming` guard).
        if !servers.is_empty() && self.core.lock().unwrap().busy {
            return response_failure(
                None,
                "replace_acp_mcp_servers",
                "Cannot replace ACP MCP servers while the agent is running",
                None,
            );
        }
        // The real agent engine owns the session's MCP store (one store for admission
        // and prompt gating); scripted harness engines fall back to the worker-level store.
        let manager = self
            .engine
            .acp_mcp_manager()
            .unwrap_or_else(|| std::sync::Arc::clone(&self.acp_mcp));
        let manager = manager.lock().unwrap();
        match manager.replace_acp_servers(&servers, owner_id) {
            // An unchanged list (same owner, identical servers) is a
            // no-op success.
            Ok(_) => response_success(None, "replace_acp_mcp_servers", None),
            Err(error) => {
                // Roll back any partially applied configuration with
                // the owner-scoped clear before surfacing the failure.
                if manager.can_release_acp_servers(owner_id) {
                    let _ = manager.replace_acp_servers(&[], owner_id);
                }
                response_failure(None, "replace_acp_mcp_servers", &error.to_string(), None)
            }
        }
    }

    /// Arm the one-shot forced steering batch: the visible plain-user steering
    /// items deliver as ONE batched turn at the next boundary, even under queue
    /// mode "one-at-a-time". Returns whether anything armed.
    pub(crate) fn arm_forced_all_steering(&self) -> bool {
        let mut core = self.core.lock().unwrap();
        let armable = |item: &QueuedItem| {
            item.queue_visible && item.agent_message.is_none() && item.custom_message.is_none()
        };
        if !core.steering.iter().any(armable) {
            return false;
        }
        core.forced_all_steering = true;
        for item in &mut core.steering {
            if armable(item) {
                item.forced_batch = true;
            }
        }
        true
    }

    /// `abort_and_send_queued` (schema 29): abort the active run, keep the queue
    /// flowing — the armed steering rows co-deliver, then the follow-up drains.
    ///
    /// SANCTIONED DIVERGENCE (operator ruling 2026-09-25): TS parks the queue
    /// whenever nothing is armable; here the abort resumes. Returns whether
    /// the queue was resumed.
    pub(crate) fn abort_and_send_queued(&self) -> bool {
        // TS `canResume`: no admission pause held — the arm only
        // fires in the send arm.
        let can_resume =
            !self.input_pauses.paused() && !self.core.lock().unwrap().shutdown_requested;
        if !can_resume {
            self.request_abort();
            return false;
        }
        self.arm_forced_all_steering();
        // The cancel sweep keeps only the queue-visible rows, so the emptiness
        // read below measures exactly the work the abort leaves behind.
        self.request_abort();
        // The resumed pump — not this funnel — owns the delivery at
        // the settled turn's boundary.
        let queued_work = {
            let core = self.core.lock().unwrap();
            !core.steering.is_empty() || !core.follow_up.is_empty()
        };
        if !queued_work {
            return false;
        }
        self.resume_queued_input();
        true
    }

    /// The abort funnel behind both abort commands: suspend queued-input
    /// admission, cancel the queue-invisible turn actions, abort the in-flight
    /// compaction, and cancel the running turn.
    fn request_abort(&self) {
        {
            let mut core = self.core.lock().unwrap();
            core.abort_requested = true;
            // The queue parks and a plain prompt is rejected until a
            // resume site fires.
            core.queued_input_suspended = true;
        }
        // Queue-INVISIBLE turn actions cancel: a direct prompt admitted on an idle
        // session never became a queue row, so the abort must resolve its waiting
        // response, not park it behind the suspension forever. Queue-visible lanes
        // survive parked — the suspension defers the pump, it never drops the queue.
        {
            let mut core = self.core.lock().unwrap();
            let cancel = |lane: &mut VecDeque<QueuedItem>| {
                let mut kept = VecDeque::new();
                while let Some(item) = lane.pop_front() {
                    if item.queue_visible {
                        kept.push_back(item);
                    } else {
                        if let Some(id) = &item.admission_id {
                            // A withdrawn prompt clears its admission (TS clearAdmission).
                            self.prompt_admissions.clear(id);
                        }
                        if let Some(done) = item.done {
                            let _ = done.send(TurnSettle::Withdrawn(
                                PROMPT_ABORTED_BEFORE_DELIVERY.to_string(),
                            ));
                        }
                    }
                }
                *lane = kept;
            };
            cancel(&mut core.steering);
            cancel(&mut core.follow_up);
        }
        // A withdrawn continuation's pending guard already released at ITS admission,
        // so the withdraw clears nothing (a mirror clear could drop an unrelated guard).
        self.compaction.abort();
        // The in-flight turn's fetch cancels now, not at its next
        // streamed event.
        self.engine.abort_in_flight_turn();
    }

    fn handle_abort(&self) -> DaemonResponse {
        self.request_abort();
        response_success(None, "abort", None)
    }

    fn handle_abort_and_send_queued(&self) -> DaemonResponse {
        // The response acknowledges the abort itself, never the
        // async deliveries the resumed pump runs at the settle.
        self.abort_and_send_queued();
        response_success(None, "abort_and_send_queued", None)
    }

    fn handle_get_state(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_state") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let summary = self.summary_locked(&core);
        response_success(
            None,
            "get_state",
            Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
        )
    }

    /// `get_session_header`: the persisted session header line (TS wraps it
    /// in `{ header: ... }`).
    fn handle_get_session_header(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_session_header") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let Some(store) = core.store.as_ref() else {
            return response_failure(
                None,
                "get_session_header",
                "Session is still initializing",
                None,
            );
        };
        response_success(
            None,
            "get_session_header",
            Some(json!({ "header": crate::session_store::session_header_line(&store.header) })),
        )
    }

    /// `get_session_stats`: counts, token totals, and the context-usage
    /// estimate over the persisted branch (TS `getSessionStats`).
    fn handle_get_session_stats(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_session_stats") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let Some(store) = core.store.as_ref() else {
            return response_failure(
                None,
                "get_session_stats",
                "Session is still initializing",
                None,
            );
        };
        let stats = crate::session_stats::session_stats(store, self.engine.model_context_window());
        response_success(None, "get_session_stats", Some(stats))
    }

    fn handle_get_messages(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_messages") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let messages: Vec<Value> = core
            .store
            .as_ref()
            .map(crate::session_store::SessionFile::messages)
            .unwrap_or_default();
        response_success(None, "get_messages", Some(json!({ "messages": messages })))
    }

    fn handle_get_queue(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_queue") {
            return response;
        }
        let core = self.core.lock().unwrap();
        // The labeled preview when the delivery carries one, else the
        // message text.
        response_success(
            None,
            "get_queue",
            Some(json!({
                "steering": core.steering.iter().map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone())).collect::<Vec<_>>(),
                "followUp": core.follow_up.iter().map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone())).collect::<Vec<_>>(),
            })),
        )
    }

    fn handle_clear_queue(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("clear_queue") {
            return response;
        }
        let mut core = self.core.lock().unwrap();
        let drain_lane = |lane: &mut VecDeque<QueuedItem>| -> Vec<String> {
            lane.drain(..)
                .map(|item| {
                    if let Some(id) = item.admission_id.as_deref() {
                        self.prompt_admissions.clear(id);
                    }
                    item.message
                })
                .collect()
        };
        let steering: Vec<String> = drain_lane(&mut core.steering);
        let follow_up: Vec<String> = drain_lane(&mut core.follow_up);
        let snapshot = Self::snapshot_locked(&core);
        drop(core);
        // The verdict refresh rides the same checkpoint as the snapshot: a stale
        // busy=true from the cleared items' admission must not revive an empty session.
        self.checkpoint_queue(QueueCheckpoint::Settle {
            operation: "queue_cleared",
        });
        let _ = self.emit_action_update(&snapshot);
        response_success(
            None,
            "clear_queue",
            Some(json!({ "steering": steering, "followUp": follow_up })),
        )
    }

    fn handle_abort_and_clear_queue(&self) -> DaemonResponse {
        let cleared = self.handle_clear_queue();
        if !cleared.success {
            return cleared;
        }
        let mut core = self.core.lock().unwrap();
        core.abort_requested = true;
        // The same TS `requestAbort()` suspension as the bare `abort`.
        core.queued_input_suspended = true;
        drop(core);
        // And the same eager agent abort.
        self.engine.abort_in_flight_turn();
        response_success(None, "abort_and_clear_queue", cleared.data)
    }

    fn handle_get_last_assistant_text(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_last_assistant_text") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let text = core.store.as_ref().and_then(|store| {
            store
                .messages()
                .into_iter()
                .rev()
                .find(|message| crate::types::message_role(message) == Some("assistant"))
                .map(|message| crate::types::message_text(&message))
        });
        response_success(
            None,
            "get_last_assistant_text",
            Some(json!({ "text": text })),
        )
    }

    async fn handle_kill(&self, payload: &Value) -> DaemonResponse {
        let reason = KillCloseReason::from_payload(payload);
        // The session is closing: the continuation mint sites and
        // their settle-hook retries bail from here on.
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.mark_session_closed();
        }
        // TS `closeSession` aborts the side questions per attached client
        // before `closeSessionOnce`'s arms run.
        self.side_questions
            .abort_all_and_settle(SIDE_QUESTION_SETTLE_TIMEOUT)
            .await;
        // `killed` cancels the session's scheduled jobs; `replaced` keeps the plain
        // cron jobs but cancels the subagent's RLM heartbeats; `shutdown` keeps them
        // all. The store cancel is durable, so the stopped session's own heartbeats
        // can never revive it.
        match reason {
            KillCloseReason::Killed => self.cancel_session_scheduled_jobs().await,
            KillCloseReason::Replaced => self.cancel_session_rlm_heartbeats().await,
            KillCloseReason::Shutdown => {}
        }
        // The close cascades to the resident children with the SAME reason before
        // the session's own archive and dispose; a close failure is swallowed.
        let child_reason = match reason {
            KillCloseReason::Killed => crate::rlm_children::ChildCloseReason::Killed,
            KillCloseReason::Shutdown => crate::rlm_children::ChildCloseReason::Shutdown,
            KillCloseReason::Replaced => crate::rlm_children::ChildCloseReason::Replaced,
        };
        if let Err(error) = self.close_rlm_children(child_reason).await {
            eprintln!("pa-daemon: RLM child close at kill failed: {error:#}");
        }
        // The `archived` entry lands before the turn's aborted row (the abort flag
        // below gates the aborted row), so the file order stays the TS one.
        // The guard rides a block, not an explicit drop: a `drop(core)` does not
        // end the guard's slot in an async generator (the awaits need Send).
        {
            let mut core = self.core.lock().unwrap();
            // `shutdown` keeps the resume entry, so its file stays
            // live on disk; the killed and replaced closes archive.
            if reason != KillCloseReason::Shutdown {
                if let Some(store) = core.store.as_mut() {
                    if let Err(error) = store.persist_entry(
                        "session_state",
                        json!({ "state": { "status": "archived" } }),
                    ) {
                        return response_failure(None, "kill", &error.to_string(), None);
                    }
                }
            }
            core.created = false;
        }
        // The abort funnel fires BEFORE every close step that can wait on the
        // session mutex the running turn holds across its provider wait: the later
        // awaits settle on an already-cancelled turn. The cancel sweep must land
        // before the close clears the lanes.
        {
            let mut core = self.core.lock().unwrap();
            core.abort_requested = true;
            core.steering.clear();
            core.follow_up.clear();
        }
        self.work_notify.notify_one();
        self.compaction.abort();
        self.tree_navigation.abort();
        self.engine.abort_in_flight_turn();
        // The awaited settle lets the aborted turn's row broadcast and persist (the
        // #247 gate's aborted-row exception); only then does the runtime dispose run
        // (the kernel teardown must not race a live run).
        self.await_session_work_settled().await;
        // The session-ended finalization runs AFTER the awaited settle: the
        // ended-run accounting includes the aborted turn, never a pending response.
        self.engine.archive_session_telemetry().await;
        // The session's kernel dies with the session: the worker keeps the engine
        // object, so the #235 engine-drop teardown cannot run yet — dispose explicitly.
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.dispose_kernel().await;
        }
        let active_session_id = self.core.lock().unwrap().active_session_id.clone();
        let _ = self.emit_session_closed(&active_session_id, reason.session_closed_reason());
        let _ = self.record_recovery(false, reason.recovery_operation());
        let lease = self
            .core
            .lock()
            .unwrap()
            .store
            .as_mut()
            .and_then(|store| store.lease.take());
        drop(lease);
        // The session runtime ended (TS `prime-agent stop <agent>`): the
        // pane reporter releases its pane as the last write on the wire —
        // no report may reclaim it afterwards. The slot is taken out
        // first (swapped to the disabled no-op) so a later attach can
        // adopt the pane again; the taken handle's release is the
        // release of the session this kill stopped.
        let reporter = std::mem::take(&mut *self.herdr.lock().unwrap());
        reporter.release().await;
        response_success(None, "kill", None)
    }

    /// `mark_anthropic_warning_shown` (Rust-native, operator directive
    /// 2026-09-29): the interactive client reports that it just drew the
    /// Anthropic subscription ban-risk warning; the worker persists the
    /// once-per-session-lifecycle marker row (the gate a reattach, a resume,
    /// or a worker replacement reads). Idempotent — a session already marked
    /// (or an in-memory session with no file) answers success without a
    /// second row.
    fn handle_mark_anthropic_warning_shown(&self) -> DaemonResponse {
        const NAME: &str = "mark_anthropic_warning_shown";
        if let Err(response) = self.require_created(NAME) {
            return response;
        }
        let mut core = self.core.lock().unwrap();
        let Some(store) = core.store.as_mut() else {
            return response_failure(None, NAME, "Session is still initializing", None);
        };
        if store.anthropic_warning_shown() {
            return response_success(None, NAME, None);
        }
        match store.mark_anthropic_warning_shown() {
            Ok(()) => response_success(None, NAME, None),
            Err(error) => response_failure(None, NAME, &error.to_string(), None),
        }
    }

    pub(crate) fn handle_rename(&self, command: &str, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created(command) {
            return response;
        }
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        if name.trim().is_empty() {
            return response_failure(None, command, "Session name cannot be empty", None);
        }
        let mut core = self.core.lock().unwrap();
        let previous = core
            .store
            .as_ref()
            .and_then(|store| store.session_name().map(str::to_string));
        if let Some(store) = core.store.as_mut() {
            if let Err(error) = store.persist_entry("session_info", json!({ "name": name })) {
                return response_failure(None, command, &error.to_string(), None);
            }
        }
        let summary = self.summary_locked(&core);
        // TS #2529 `applyStateSessionName`: a rename that changed an
        // existing name leaves the renamed session a displayed transcript
        // notice (" by parent" when the rename arrived from the parent
        // session); a first name leaves none. The notice's durable row
        // lands under the SAME core lock as the name write — worker
        // commands run concurrently, so a second lock scope here could
        // interleave another command's writes between the name and its
        // notice, ordering the notice against a contradicted name history.
        // The broadcast (the client frames) runs after the lock drops, in
        // the `session_info_changed` order TS emits.
        let renamed_notice = previous
            .as_deref()
            .filter(|previous| *previous != name)
            .map(|previous| {
                let content = if payload.get("renamedBy").and_then(Value::as_str)
                    == Some(
                        pa_core::session_engine::agent_messaging::AgentFamilyRelationship::Parent
                            .as_str(),
                    ) {
                    format!("Session renamed `{previous}` -> `{name}` by parent")
                } else {
                    format!("Session renamed `{previous}` -> `{name}`")
                };
                json!({
                    "customType": pa_core::session_engine::messages::SESSION_RENAMED_CUSTOM_TYPE,
                    "content": content,
                    "display": true,
                })
            });
        if let Some(notice) = renamed_notice.as_ref() {
            persist_custom_row(&mut core, notice);
        }
        drop(core);
        // `session_info_changed` makes every attached client re-read
        // the name.
        self.emit_worker_event(serde_json::json!({
            "type": "session_info_changed",
            "name": name,
        }));
        // The sender identity follows the live name.
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
        if let Some(notice) = renamed_notice.as_ref() {
            self.broadcast_custom_row(notice);
        }
        response_success(
            None,
            command,
            Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
        )
    }
}
