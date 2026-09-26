//! The dispatch surface: command routing, the command handlers,
//! and the abort family.
use super::*;

use serde_json::Value;

use crate::protocol::DaemonResponse;

impl Worker {
    pub(crate) async fn dispatch(&self, command_type: &str, payload: &Value) -> DaemonResponse {
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
        match command_type {
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
            "wait_for_idle" => self.handle_wait_for_idle().await,
            "wait_for_headless_completion" => self.handle_wait_for_headless_completion().await,
            "get_state" => self.handle_get_state(),
            "get_messages" => self.handle_get_messages(),
            "get_session_header" => self.handle_get_session_header(),
            "get_session_stats" => self.handle_get_session_stats(),
            "get_model_catalog" => self.handle_get_model_catalog().await,
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
            "rename_saved_session" => self.handle_rename_saved_session(payload).await,
            "delete_saved_session" => self.handle_delete_saved_session(payload).await,
            "replace_acp_mcp_servers" => self.handle_replace_acp_mcp_servers(payload),
            "set_model" => self.handle_set_model(payload).await,
            "set_thinking_level" => self.handle_set_thinking_level(payload).await,
            "cycle_model" => self.handle_cycle_model(payload).await,
            "set_scoped_models" => self.handle_set_scoped_models(payload),
            "cycle_thinking_level" => self.handle_cycle_thinking_level().await,
            "set_service_tier" => self.handle_set_service_tier(payload),
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
            "reload" => self.handle_reload().await,
            "extension_ui_response" => self.handle_extension_ui_response(payload),
            "cancel_rlm_child" => self.handle_cancel_rlm_child(payload).await,
            "delete_rlm_subagent" => self.handle_delete_rlm_subagent(payload).await,
            // The engine call blocks on the engine runtime (the durable
            // `rlm_max_depth_state` write takes the engine session lock),
            // so it runs on a blocking thread like every other engine
            // call — a direct call would block_on from inside this async
            // task and die.
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
            "cron_list" => self.handle_cron_list(payload).await,
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
        }
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
        Ok(())
    }

    /// `navigate_tree` with the reload's announcement (TS
    /// `_reloadGoalStateFromBranch` -> `_emitGoalUpdate`): a tree move
    /// that reloaded the goal state announces the change at the moment it
    /// happened — before the navigation's response reaches the client —
    /// so attached surfaces never show the pre-navigation goal. The
    /// engine owns the on-change dedupe, so an unchanged reload (or a
    /// no-op leaf move, which never rebuilds) stays silent.
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

    /// `replace_acp_mcp_servers` (TS daemon-mode.ts case): the session's
    /// owner-fenced ACP MCP store. The ACP transport resolves and validates
    /// the servers before sending them; the worker only fences ownership,
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
        // The real agent engine owns the session's MCP store (one store
        // for admission and prompt gating); scripted harness engines fall
        // back to the worker-level store.
        let manager = self
            .engine
            .acp_mcp_manager()
            .unwrap_or_else(|| std::sync::Arc::clone(&self.acp_mcp));
        let manager = manager.lock().unwrap();
        match manager.replace_acp_servers(&servers, owner_id) {
            // An unchanged list (same owner, identical servers) is a no-op
            // success, like the TS manager's unchanged short-circuit.
            Ok(_) => response_success(None, "replace_acp_mcp_servers", None),
            Err(error) => {
                // Roll back any partially applied configuration with the
                // owner-scoped clear, exactly like the TS rollback, before
                // surfacing the failure.
                if manager.can_release_acp_servers(owner_id) {
                    let _ = manager.replace_acp_servers(&[], owner_id);
                }
                response_failure(None, "replace_acp_mcp_servers", &error.to_string(), None)
            }
        }
    }

    /// Arm the one-shot forced steering batch (TS `abortAndSendQueued`'s
    /// `_forcedAllSteeringActionIds = new Set(queuedSteering.map(...))`):
    /// the visible plain-user steering items — queue-visible rows whose
    /// delivery record is a user message, not an accepted agent message or
    /// an injected custom row — deliver as ONE batched turn at the next
    /// boundary, even under queue mode "one-at-a-time". Returns whether
    /// anything armed; an empty lane (or an all-injected one) arms
    /// nothing and the caller decides from the surviving queue whether
    /// the abort keeps the pump flowing.
    // Called by the `abort_and_send_queued` funnel (the wire command's
    // body, #2599's handler once rebased).
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

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): abort
    /// the active run and keep the queue flowing behind the settled turn
    /// — the armed plain-user steering rows co-deliver as the next
    /// batched turn, then the follow-up lane drains when the session
    /// goes idle, one turn per completed turn. `steeringMode` is never
    /// changed, and the follow-up lane never merges into the batch.
    ///
    /// Abort-only — the queue parks behind the suspension, like the bare
    /// `abort` — when no queue-visible work survives or the scheduler
    /// must stay parked (a held admission pause or a pending shutdown —
    /// TS `canResume`).
    ///
    /// SANCTIONED DIVERGENCE (operator ruling 2026-09-25): TS parks the
    /// queue whenever the steering lane has nothing armable
    /// (`queuedSteering.length === 0`), so a follow-up-only queue sits
    /// parked until an outside resume site fires; here the abort
    /// resumes whenever queue-visible work survived, and a follow-up
    /// parked behind an aborted turn starts promptly once the turn
    /// settles. The bare `abort` command keeps the TS park.
    ///
    /// The `abort_and_send_queued` wire command (schema 29) and the
    /// Ctrl+C trigger dispatch through this funnel
    /// (`handle_abort_and_send_queued` below — the abort-parity lane's
    /// command surface, #2599). Returns whether the queue was resumed
    /// to drain behind the abort (the abort-only arm answers `false`).
    pub(crate) fn abort_and_send_queued(&self) -> bool {
        // TS `canResume`: no disposal in flight, no admission pause held —
        // and the arm only fires in the send arm (`queuedSteering.length
        // === 0 || !canResume` runs the plain `requestAbort()` without
        // touching the armed set).
        let can_resume =
            !self.input_pauses.paused() && !self.core.lock().unwrap().shutdown_requested;
        if !can_resume {
            self.request_abort();
            return false;
        }
        // TS `queuedSteering` + the arm: the visible plain-user steering
        // rows carry the forced-batch flag; an empty (or all-injected)
        // lane arms nothing.
        self.arm_forced_all_steering();
        // TS runs `requestAbort()` in both arms (the suspension parks the
        // queue). The cancel sweep keeps only the queue-visible rows, so
        // the emptiness read below measures exactly the work the abort
        // leaves behind.
        self.request_abort();
        // The resume gate: the abort keeps the queue flowing whenever
        // queue-visible work survived — the armed steering batch or a
        // follow-up-only lane alike. The resumed pump — not this funnel —
        // owns the delivery at the settled turn's boundary: steers first
        // (one batched turn), then the follow-up lane.
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

    /// TS `requestAbort()`: the abort funnel behind both abort commands
    /// (`abort` and `abort_and_send_queued`) - suspend queued-input
    /// admission, cancel the queue-invisible turn actions, abort the
    /// in-flight compaction, and cancel the running turn.
    fn request_abort(&self) {
        {
            let mut core = self.core.lock().unwrap();
            core.abort_requested = true;
            // TS `requestAbort()` suspends queued-input admission: the
            // queue parks and a plain prompt is rejected until a resume
            // site fires.
            core.queued_input_suspended = true;
        }
        // TS `requestAbort()`'s `_cancelSessionActions`: queue-INVISIBLE
        // turn actions cancel with "Prompt aborted before delivery." - a
        // direct prompt admitted on an idle session never became a queue
        // row, so the abort must resolve its waiting response instead of
        // parking it behind the suspension forever (the ACP cancel wedge:
        // the prompt item sat in the lane with no resume site, the
        // `prompt_and_wait` response hung). The queue-visible lanes
        // (steer/follow-up, agent-message deliveries, prompt-behind-work,
        // heartbeat fires) survive parked - the suspension defers the
        // pump, it never drops the queue (the abort-ownership probe).
        {
            let mut core = self.core.lock().unwrap();
            let cancel = |lane: &mut VecDeque<QueuedItem>| {
                let mut kept = VecDeque::new();
                while let Some(item) = lane.pop_front() {
                    if item.queue_visible {
                        kept.push_back(item);
                    } else {
                        if let Some(id) = &item.admission_id {
                            let _ = self.prompt_admissions.cancel(id);
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
        };
        // TS `requestAbort()` also aborts the compaction in flight (manual
        // and automatic): the interrupt key cancels a compacting session.
        self.compaction.abort();
        // `requestAbort()` closes with `this.agent.abort()`: the in-flight
        // turn's fetch cancels now, not at its next streamed event.
        self.engine.abort_in_flight_turn();
    }

    fn handle_abort(&self) -> DaemonResponse {
        self.request_abort();
        response_success(None, "abort", None)
    }

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): abort
    /// the active run and keep the queue flowing at the boundary — the
    /// armed steering rows deliver as ONE co-delivered turn, then the
    /// follow-up lane drains one turn per completed turn; abort-only
    /// when no queue-visible work survives or the scheduler must stay
    /// parked (the abort-only arm leaves the suspension set, so an
    /// emptied queue stays parked like the bare `abort`).
    fn handle_abort_and_send_queued(&self) -> DaemonResponse {
        // The funnel above owns the arm, the abort, and the conditional
        // resume; the response acknowledges the abort itself, never the
        // deliveries the resumed pump runs asynchronously at the settled
        // turn's boundary.
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
        // TS `get_queue` serves `getSteeringMessagePreviews` /
        // `getFollowUpMessagePreviews`: the labeled preview when the
        // delivery carries one, else the message text.
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
        let steering: Vec<String> = core.steering.drain(..).map(|item| item.message).collect();
        let follow_up: Vec<String> = core.follow_up.drain(..).map(|item| item.message).collect();
        let snapshot = self.snapshot_locked(&core);
        drop(core);
        // The cleared lanes are idle again: the verdict refresh rides the
        // same checkpoint as the snapshot (a stale busy=true from the
        // cleared items' admission must not revive an empty session; a
        // clear mid-turn keeps the verdict busy through the turn).
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
        // The session is closing: the continuation mint sites and their
        // settle-hook retries bail from here on (TS `_disposed ||
        // _disposing` in the goal/autonomous resume sites). A stopped
        // session never continues.
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.mark_session_closed();
        }
        // TS `closeSession` aborts the side questions per attached client
        // before `closeSessionOnce`'s arms run.
        self.side_questions
            .abort_all_and_settle(SIDE_QUESTION_SETTLE_TIMEOUT)
            .await;
        // TS `closeSessionOnce`'s first act: `killed` cancels the session's
        // scheduled jobs (`cancelScheduledJobsForSession` — the queued
        // heartbeat follow-ups' purge included); `replaced` keeps the plain
        // cron jobs but cancels the subagent's RLM heartbeats
        // (`cancelSubagentRlmHeartbeats`); `shutdown` keeps them all (the
        // jobs survive the close for the later scheduled wake). The store
        // cancel is durable, so the stopped session's own heartbeats can
        // never revive it (the zombie fix).
        match reason {
            KillCloseReason::Killed => self.cancel_session_scheduled_jobs().await,
            KillCloseReason::Replaced => self.cancel_session_rlm_heartbeats().await,
            KillCloseReason::Shutdown => {}
        }
        // TS `closeSessionOnce(reason)` cascades the close to the
        // session's resident children with the SAME reason before the
        // session's own archive and dispose; a close failure is swallowed
        // here exactly like the daemon-mode kill handler's
        // `.catch(() => undefined)`.
        let child_reason = match reason {
            KillCloseReason::Killed => crate::rlm_children::ChildCloseReason::Killed,
            KillCloseReason::Shutdown => crate::rlm_children::ChildCloseReason::Shutdown,
            KillCloseReason::Replaced => crate::rlm_children::ChildCloseReason::Replaced,
        };
        if let Err(error) = self.close_rlm_children(child_reason).await {
            eprintln!("pa-daemon: RLM child close at kill failed: {error:#}");
        }
        // The persist (TS `archiveSession` -> `appendSessionState`, before
        // `session.abort()`): synchronous in TS, so the `archived` entry
        // lands while the turn still holds its provider wait. The turn can
        // only append its aborted row once the abort flag below opens the
        // gate, so the file order (archived, then the aborted row) stays
        // the TS one. `shutdown` keeps the resume entry (TS
        // `closeKeepsResumeEntry`), so its file stays live on disk. The
        // core lock never blocks on the in-flight turn: the turn runner
        // holds it only for the instants it persists an event, never
        // across the provider wait. The guard rides a block, not an
        // explicit drop: a `drop(core)` does not end the guard's slot in
        // an async generator, so the later awaits would make the future
        // non-Send.
        {
            let mut core = self.core.lock().unwrap();
            // `shutdown` keeps the resume entry (TS
            // `closeKeepsResumeEntry`), so its file stays live on disk;
            // the killed and replaced closes archive (the base's
            // `persist_entry` write).
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
        // The abort funnel fires BEFORE every close step that can wait on
        // the session mutex the running turn holds across its provider
        // wait. TS `session.abort()` starts with `requestAbort()` ->
        // `agent.abort()`, which cancels the in-flight fetch immediately,
        // so the later awaits in the close (the settle, the telemetry
        // archive, the kernel dispose) settle on an already-cancelled
        // turn instead of waiting out the stream. TS dispose cancels the
        // queued session actions and clears the agent queues
        // (`requestAbort` parks the input pump, `dispose` rejects every
        // queued action): nothing may feed another turn after the close
        // below (and the turn runner clears the abort flag when it pops
        // an item, so the cancel must land first).
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
        // The awaited `session.abort()` settles the cancelled in-flight
        // turn and compaction: the aborted turn's row broadcasts and
        // persists here (the #247 gate's aborted-row exception), and only
        // then does the runtime dispose run — the kernel teardown must
        // not race a live run.
        self.await_session_work_settled().await;
        // `session archived` (schema v1) + the session-ended finalization:
        // kill disposes the session like the TS dispose callback, which
        // TS runs AFTER the awaited `session.abort()` — so the ended-run
        // accounting includes the aborted turn, and the settle above has
        // released the turn's hold on the session mutex: this never waits
        // out a pending provider response.
        self.engine.archive_session_telemetry().await;
        // The runtime dispose of the TS close path
        // (`closeSessionOnce` -> `runtime.dispose()` ->
        // `session.disposeAsync` -> `IpythonKernelProvisioner.dispose`,
        // default snapshot policy): the session's kernel dies with the
        // session. The worker keeps the engine object, so the engine-drop
        // teardown from #235 cannot run yet — dispose it explicitly.
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
        response_success(None, "kill", None)
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
        if let Some(store) = core.store.as_mut() {
            if let Err(error) = store.persist_entry("session_info", json!({ "name": name })) {
                return response_failure(None, command, &error.to_string(), None);
            }
        }
        let summary = self.summary_locked(&core);
        drop(core);
        // TS `session.setSessionName` emits `session_info_changed` so every
        // attached client re-reads the name (the interactive mode patches
        // its connection state from the event).
        self.emit_worker_event(serde_json::json!({
            "type": "session_info_changed",
            "name": name,
        }));
        // The sender identity follows the live name.
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
        response_success(
            None,
            command,
            Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
        )
    }
}
