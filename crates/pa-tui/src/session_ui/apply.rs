//! The apply concern: the streamed-event pump — client events, turn
//! updates, assistant/tool rows, compaction aborts, and the telemetry seams.
use super::*;

/// One backgrounded compaction-abort outcome (the abort supervision's UI
/// recovery): a failed abort request surfaces as the transcript note and
/// clears the stuck compaction loader locally — when even the abort could
/// not reach the daemon, the loader must not hang waiting for a
/// `compaction_end` that will never come. The session id keeps a stale
/// outcome from touching another session after `/switch` or `/new`.
pub(crate) struct CompactionAbortNote {
    pub(crate) active_session_id: String,
    /// The loader generation the abort addressed: an outcome applies only
    /// to the exact `compaction_start` that was on screen when the abort
    /// was sent — a newer run's loader is never cleared by a stale one.
    pub(crate) compaction_generation: u64,
    pub(crate) outcome: Result<(), String>,
}

impl SessionUi {
    /// Abort the active turn off the UI loop (TS `interruptOrClearInput`
    /// fires `void abortAndSendQueued()` when streaming, schema 29): the
    /// daemon aborts the run and the queue keeps flowing behind the
    /// settled turn — parked steering delivers as one batched turn, then
    /// the follow-up lane drains one turn per completed turn; a plain
    /// abort when the abort leaves nothing queued. A daemon without the
    /// schema-29 capability gets the plain abort (TS
    /// `supportsServerCapability` + the `isUnknownDaemonCommandError`
    /// catch, both arms of TS `abortAndSendQueued`). The request never
    /// blocks key handling, and a failure surfaces later as a transcript
    /// note.
    fn abort_turn(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            let mut result = if client.supports_server_capability("abort_and_send_queued") {
                client
                    .request_ok(DaemonCommand::AbortAndSendQueued {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
            } else {
                client
                    .request_ok(DaemonCommand::Abort {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
            };
            // A daemon that rejects the command itself gets the plain
            // abort too (TS `isUnknownDaemonCommandError`'s arm).
            if matches!(&result, Err(error) if error.to_string().contains("abort_and_send_queued"))
            {
                result = client
                    .request_ok(DaemonCommand::Abort {
                        id: None,
                        active_session_id,
                        rest: Map::default(),
                    })
                    .await;
            }
            if let Err(error) = result {
                let _ = notes.send(format!("the abort failed: {error:#}"));
            }
        });
    }

    /// Cancel the in-flight compaction off the UI loop (TS
    /// `interruptOrClearInput` fires `abortCompaction()` when the
    /// compaction loader is up — the agent is not streaming during a
    /// compaction, so the interrupt cancels the run, not a turn): the
    /// request never blocks key handling. A failure surfaces later as a
    /// transcript note and clears the stuck loader locally (the abort
    /// supervision's UI recovery): the daemon's own `compaction_end`
    /// normally clears it, but an abort that could not even reach the
    /// daemon must not leave the UI waiting on an end that never comes.
    fn abort_compaction(&self, compaction_generation: u64) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let abort_notes = self.compaction_abort_notes.clone();
        tokio::spawn(async move {
            // Via the supervisor even when a direct link serves the
            // session: the direct link IS the wedged worker in the case
            // the supervisor's abort arm exists for.
            let result = client
                .request_ok_via_supervisor(DaemonCommand::AbortCompaction {
                    id: None,
                    active_session_id: active_session_id.clone(),
                    rest: Map::default(),
                })
                .await;
            if let Err(error) = result {
                let _ = abort_notes.send(CompactionAbortNote {
                    active_session_id,
                    compaction_generation,
                    outcome: Err(format!("{error:#}")),
                });
            }
        });
    }

    /// Apply one backgrounded compaction-abort outcome: the failed note
    /// surfaces as a transcript row and the compaction loader clears —
    /// the local recovery when the abort never reached the daemon. An
    /// outcome from a session this UI no longer shows (`/switch`, `/new`
    /// mid-request), or addressed to a loader a newer `compaction_start`
    /// has since replaced, touches nothing.
    pub(crate) fn apply_compaction_abort_outcome(
        &mut self,
        note: CompactionAbortNote,
        view: &mut AgentView,
    ) {
        if note.active_session_id != self.active_session_id
            || note.compaction_generation != view.compaction_generation
        {
            return;
        }
        if let Err(error) = note.outcome {
            self.note(&format!("the compaction abort failed: {error:#}"), view);
            view.compaction = None;
        }
    }

    /// Apply one background note (a failed abort request) to the transcript.
    pub(crate) fn apply_background_note(&mut self, text: &str, view: &mut AgentView) {
        self.note(text, view);
    }

    /// A compaction succeeded and the durable transcript was rebuilt (it
    /// now starts at the compaction summary): re-fetch it and replace the
    /// view's chat (TS `rebuildChatFromMessages`). Best effort — a failed
    /// fetch keeps the pushed outcome row instead of an empty transcript.
    pub(crate) async fn rebuild_transcript(&mut self, view: &mut AgentView) {
        self.transcript_stale = false;
        // The rebuilt transcript invalidates the tracked status row.
        self.last_status_index = None;
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetMessages {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        else {
            return;
        };
        let Some(messages) = data.get("messages").and_then(Value::as_array) else {
            return;
        };
        let entries = crate::snapshot::transcript_to_entries(messages);
        view.clear_chat();
        for entry in entries {
            view.push_entry(entry);
        }
        view.follow();
        self.dirty = true;
    }

    /// Report the first scroll action of the run (`tui scroll used`),
    /// fire-and-forget so the keypress never waits on the telemetry flush.
    pub(super) fn track_scroll(&mut self, action: &'static str, resumed_following: bool) {
        if self.scroll_adoption_emitted {
            return;
        }
        self.scroll_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.scroll_used(action, resumed_following).await;
            });
        }
    }

    /// Report the run's first selection copy (`tui selection used`),
    /// fire-and-forget like the scroll event: the release never waits on
    /// the telemetry flush. `lines` is the copied text's line count.
    pub(super) fn track_selection(&mut self, lines: usize) {
        if self.selection_adoption_emitted {
            return;
        }
        self.selection_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.selection_used(lines).await;
            });
        }
    }

    /// The run's first click-driven interaction (`tui click used`,
    /// adoption; later clicks in the same run are not reported).
    pub(crate) fn track_click(&mut self, surface: &'static str) {
        if self.click_adoption_emitted {
            return;
        }
        self.click_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.click_used(surface).await;
            });
        }
    }

    /// Take a pending `app.suspend` request (TS `handleCtrlZ`): the
    /// interactive loop performs the process-group suspend cycle; only
    /// the loop owns the renderer that hands the terminal over.
    pub(crate) fn take_suspend_request(&mut self) -> bool {
        std::mem::take(&mut self.suspend_requested)
    }

    /// Report the run's first suspend cycle (`tui suspend used`),
    /// fire-and-forget like the scroll event: the keypress never waits on
    /// the telemetry flush. `outcome` is `resumed` (the SIGCONT
    /// continuation restored the terminal) or `failed` (the cycle errored).
    pub(crate) fn track_suspend_used(&mut self, outcome: &'static str) {
        if self.suspend_adoption_emitted {
            return;
        }
        self.suspend_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.suspend_used(outcome).await;
            });
        }
    }

    /// Report a builtin client-command submission (`agent command used`),
    /// fire-and-forget like the scroll event: the command's handling never
    /// waits on the telemetry flush.
    pub(super) fn track_command_used(&mut self, command: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.command_used(command).await;
            });
        }
    }

    pub(crate) fn apply_client_event(&mut self, event: DaemonClientEvent, view: &mut AgentView) {
        match event {
            DaemonClientEvent::SessionEvent {
                active_session_id,
                event,
            } => {
                if active_session_id != self.active_session_id {
                    return;
                }
                if let Some(update) = event_to_update(&event) {
                    self.apply_update(update, view);
                }
            }
            DaemonClientEvent::SideQuestionEvent {
                active_session_id,
                event,
            } => {
                if active_session_id == self.active_session_id {
                    self.apply_side_question_event(&event, view);
                }
            }
            DaemonClientEvent::SessionClosed {
                active_session_id,
                reason,
            } => {
                if active_session_id == self.active_session_id {
                    self.turn_active = false;
                    view.working = None;
                    self.note(&format!("session closed ({reason})"), view);
                }
            }
            DaemonClientEvent::DirectLinkLost { active_session_id } => {
                // TS `handleTransportClose`: a direct-transport loss is
                // never itself a session loss — the interactive loop
                // re-attaches through the supervisor. Only the active
                // session arms the loop; a replaced link (session switch)
                // reports its old session and is ignored here.
                if active_session_id == self.active_session_id {
                    self.transport_lost = Some(active_session_id);
                }
            }
            DaemonClientEvent::DaemonClosing { reason, update } => {
                // TS #2458 `daemonClosingNotice`: the announcement is the
                // discriminator the interactive loop's shutdown recovery
                // arms on (a bare session stop without it stays stopped).
                self.daemon_closing_notice = Some(reason.clone());
                match update {
                    Some(update) => {
                        // Spec §10: reattach is the default end state. The
                        // banner carries the resume contract; the reconnect
                        // loop in the interactive run drives the rest (UI
                        // stays mounted, retry with backoff up to 10 min,
                        // reattach by durable id once the successor serves).
                        let names = update
                            .sessions
                            .iter()
                            .map(|row| {
                                row.get("name")
                                    .and_then(|value| value.as_str())
                                    .filter(|name| !name.is_empty())
                                    .unwrap_or_else(|| {
                                        row.get("sessionId")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or_default()
                                    })
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        view.push_entry(crate::chat::ChatEntry::Status {
                            text: format!(
                                "Prime Agent is updating — restarting the daemon (about {}s). {} will resume automatically.",
                                update.est_seconds.max(1),
                                if names.is_empty() { "Your session".to_string() } else { names }
                            ),
                            kind: crate::chat::StatusKind::Info,
                        });
                        self.reconnect = Some(update);
                    }
                    None => {
                        self.note(&format!("the daemon is shutting down ({reason})"), view);
                    }
                }
            }
            // The roster push keeps the subagent summary counts live (TS
            // `subscribeAgentRoster` -> `updateSubagentSummaryLine`).
            DaemonClientEvent::RosterUpdate {
                changed,
                removed,
                resync,
            } => {
                self.apply_roster_update(changed, removed, resync);
                self.update_subagent_summary(view);
                self.dirty = true;
            }
            // A heartbeat catalog change anywhere in the daemon (TS
            // `broadcastGlobal`): the scoped catalog refreshes in the
            // background through the update channel (TS
            // `refreshHeartbeatCatalog`) — an open `/heartbeats` view
            // re-renders from the landed update, and the activity dock's
            // counts follow the catalog even with the view closed
            // (another client's pause/resume reaches the dock at once).
            DaemonClientEvent::HeartbeatsChanged => {
                self.spawn_heartbeat_refresh();
            }
            // A background daemon-side catalog refresh changed the served
            // snapshot (the Rust-only no-stall picker-open extension):
            // every client re-fetches instantly — the daemon answers from
            // the warm caches, no stall — and an open `/model` picker
            // folds the fresh catalog through its stable update path
            // (`apply_model_catalog` keeps the selection), no flicker.
            DaemonClientEvent::ModelCatalogChanged => {
                self.spawn_model_catalog_refresh();
            }
            // A worker replacement superseded the id this client holds:
            // the interactive loop re-attaches to the session's current id
            // (a silent rebind - the transcript rebuilds from the attach
            // snapshot, no banner).
            DaemonClientEvent::SessionBinding {
                previous_active_session_id,
                active_session_id,
            } => {
                if previous_active_session_id == self.active_session_id
                    && !active_session_id.is_empty()
                    && active_session_id != self.active_session_id
                {
                    self.pending_rebind = Some(active_session_id);
                }
            }
            // Saved-session list frames belong to the agents-view UI; the
            // session view only reads its own session.
            DaemonClientEvent::SessionListItem { .. }
            | DaemonClientEvent::SessionListProgress { .. } => {}
        }
    }

    fn apply_update(&mut self, update: TurnUpdate, view: &mut AgentView) {
        match update {
            TurnUpdate::TurnStarted => {
                self.turn_active = true;
                self.turn_error_shown = false;
                // TS `agent_start` clears the pending tool map: no card
                // from a previous run settles on this one's failure.
                self.pending_tools.clear();
                self.aborted_tools.clear();
                self.start_loader(view);
            }
            TurnUpdate::UserMessage(text) => {
                // TS `addMessageToChat`'s user case: a skill block parses
                // into the skill-invocation card plus the trailing
                // argument text as its own user block.
                match crate::custom_message::skill_invocation_entries(&text) {
                    Some(entries) => {
                        for entry in entries {
                            view.push_entry(entry);
                        }
                    }
                    None => view.push_entry(ChatEntry::User { text }),
                }
            }
            // `session_info_changed`: the display name moved (the `/name`
            // path also sets it locally; this is the other-client arm).
            TurnUpdate::SessionInfoChanged { name } => {
                self.session_name = name;
                view.chrome.chat_name = self.session_display();
                self.dirty = true;
            }
            // `service_tier_changed`: keep the local tier state current (TS
            // patches the connection state; `/fast` reads it).
            TurnUpdate::ServiceTierChanged { tier } => {
                self.service_tier = Some(tier);
                // The tray badge follows the applied tier (the `fast`
                // token for priority).
                view.chrome.service_tier.clone_from(&self.service_tier);
                self.dirty = true;
            }
            TurnUpdate::CustomRow(entry) => {
                view.push_entry(entry);
            }
            TurnUpdate::AssistantMessage {
                message,
                streaming,
                stream_event,
            } => {
                self.apply_assistant_message(&message, streaming, stream_event.as_ref(), view);
            }
            TurnUpdate::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => {
                // The failed frame's sweep owns the call: the run's late
                // tool frames land on nothing - not the card, not the
                // pending map, not the loader (TS: no component in the
                // cleared pending map).
                if !self.aborted_tools.contains(&tool_call_id) {
                    crate::snapshot::apply_tool_execution_start(
                        view,
                        &tool_call_id,
                        &tool_name,
                        args,
                    );
                    // TS `tool_execution_start` re-registers the call in the
                    // pending map (a card may predate a pending-state reset or
                    // arrive without its own streamed frame).
                    self.pending_tools.insert(tool_call_id.clone());
                    self.set_working_activity("Executing", false, view);
                }
            }
            TurnUpdate::ToolExecutionUpdate {
                tool_call_id,
                partial,
            } => {
                // A `starting` partial (python-kernel bootstrap) owns the
                // loader note (TS `setWorkingMessage`); other updates
                // leave any current note alone. The note rides the
                // landed-result gate: the aborted card's late frames must
                // not clobber the delivered turn's loader.
                let loader_message = crate::snapshot::working_message_from_update(&partial);
                if self.apply_tool_result(&tool_call_id, partial, false, true, view) {
                    if let (Some(message), Some(working)) = (loader_message, view.working.as_mut())
                    {
                        working.message = Some(message);
                    }
                }
            }
            TurnUpdate::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
            } => {
                // The landed-result gate keeps the loader safe: after the
                // interrupt delivers the parked queue, a late end frame from
                // the aborted run must not rewrite the new turn's activity
                // label or clear its loader note.
                if self.apply_tool_result(&tool_call_id, result, is_error, false, view) {
                    self.set_working_activity("Waiting", false, view);
                    // The tool that owned the loader note finished executing
                    // (TS clears `workingMessage` in the tool's `finally`).
                    if let Some(working) = &mut view.working {
                        working.message = None;
                    }
                }
            }
            TurnUpdate::TurnEnded { error } => {
                // Only the engine's own turn_end clears the busy state:
                // trailing `agent_end` frames from the previous turn must
                // not cancel a turn admitted in between (prompt queueing).
                self.streaming_index = None;
                self.turn_ends_seen += 1;
                self.turn_active = false;
                view.working = None;
                view.working_since = None;
                view.retry = None;
                // The turn settled: the bash cards held above the
                // indicator stream into the transcript (TS `turn_end`
                // flushes `pendingBashComponents`).
                self.flush_pending_bash(view);
                // TS `turn_end` clears the pending tool map after the
                // failed frame's settle: stragglers never leak into the
                // next run.
                self.pending_tools.clear();
                self.aborted_tools.clear();
                // A provider failure already surfaced through the failed
                // assistant message and/or the retry-exhausted banner; the
                // turn result error is only a silent-failure backstop.
                if let (Some(error), false) = (error, self.turn_error_shown) {
                    view.push_entry(ChatEntry::Status {
                        text: format!("turn failed: {error}"),
                        kind: StatusKind::Warning,
                    });
                }
            }
            TurnUpdate::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
                reason,
            } => {
                // The retry countdown loader replaces the working loader
                // until the loop settles (TS auto_retry_start). A backup
                // reason is a provider-failover switch: the loader names
                // the backup provider the turn re-routes to (no countdown;
                // the switch re-issues immediately).
                //
                // SANCTIONED DIVERGENCE (operator ruling 2026-09-23): the
                // just-failed attempt's error row leaves the chat — the
                // transient loader line (error + attempt + countdown,
                // updated in place) is the ONE error the chat shows while
                // the episode runs, and the episode's durable outcome row
                // replaces it at the settle. (TS keeps one error row per
                // failed attempt; a 429-storm spammed the chat.)
                pop_superseded_attempt_row(view);
                view.retry = Some(RetryState {
                    attempt,
                    max_attempts,
                    ends_at: std::time::Instant::now() + std::time::Duration::from_millis(delay_ms),
                    error_message,
                    reason,
                });
            }
            TurnUpdate::AutoRetryEnd {
                success: _,
                attempt: _,
                final_error,
                restored_model,
            } => {
                view.retry = None;
                if final_error.is_some() {
                    self.turn_error_shown = true;
                    // The give-up's final failed attempt is superseded by
                    // the ONE terminal line (the durable outcome row that
                    // follows this event renders it; the row text matches
                    // the old live banner).
                    pop_superseded_attempt_row(view);
                }
                // A settled switch restores the primary provider (TS
                // `restoredModel` status line).
                if let Some(restored_model) = restored_model {
                    view.push_entry(ChatEntry::Status {
                        text: format!("Primary provider recovered — back on {restored_model}"),
                        kind: StatusKind::Info,
                    });
                }
            }
            TurnUpdate::CompactionStart {
                reason,
                custom_instructions,
            } => {
                // TS `startCompactionLoader`: the compaction loader fully
                // replaces the working loader for the run's duration. The
                // generation bump retires every in-flight abort outcome
                // that addressed an earlier run's loader.
                view.working = None;
                view.compaction_generation += 1;
                view.compaction = Some(CompactionState {
                    reason: CompactionReason::parse(&reason),
                    custom_instructions,
                    // A fresh run starts with an empty live summary:
                    // the deltas of THIS run accumulate from here (a
                    // replayed `compaction_start` after a re-attach
                    // drops the previous run's partial text too).
                    summary: String::new(),
                });
            }
            TurnUpdate::CompactionSummaryDelta { delta } => {
                // One streamed chunk of the summary the compaction
                // model is generating: append onto the live loader's
                // state (the expanded view renders the accumulated
                // text under the loader, nested like the expanded
                // summary row that settles it). A delta without a live
                // loader (a late attach mid-run, a stale frame after
                // `compaction_end`) drops — the settling end still
                // carries the full summary.
                if let Some(compaction) = view.compaction.as_mut() {
                    compaction.summary.push_str(&delta);
                }
            }
            TurnUpdate::CompactionEnd {
                reason,
                result,
                custom_instructions,
                aborted,
                error_message,
                error_severity,
            } => {
                view.compaction = None;
                if let Some(result) = result {
                    // A succeeded compaction rebuilt the durable transcript
                    // (it now starts at the compaction summary): show the
                    // outcome row immediately, then re-fetch the transcript
                    // so the compacted-away rows drop (TS
                    // `rebuildChatFromMessages`).
                    view.push_entry(ChatEntry::CompactionSummary {
                        summary: result
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        tokens_before: result
                            .get("tokensBefore")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                        custom_instructions,
                    });
                    self.transcript_stale = true;
                } else if reason == "manual" {
                    // TS `compaction_end` handling: aborts and error
                    // messages surface only for user-issued compactions,
                    // through `showError`/`showWarning` (whose rows carry
                    // the `⚠ Error: ` / `⚠ ` prefixes).
                    if aborted {
                        view.push_entry(ChatEntry::Status {
                            text: "\u{26a0} Error: Compaction cancelled".to_string(),
                            kind: StatusKind::Error,
                        });
                    } else if let Some(message) = error_message {
                        if error_severity.as_deref() == Some("warning") {
                            view.push_entry(ChatEntry::Status {
                                text: format!("\u{26a0} {message}"),
                                kind: StatusKind::Warning,
                            });
                        } else {
                            view.push_entry(ChatEntry::Status {
                                text: format!("\u{26a0} Error: {message}"),
                                kind: StatusKind::Error,
                            });
                        }
                    }
                }
            }
            TurnUpdate::Idle => {
                if !self.turn_active {
                    view.working = None;
                }
            }
            TurnUpdate::GoalUpdate(goal) => {
                self.apply_goal_update(goal, view);
            }
            TurnUpdate::BashStart {
                command,
                exclude_from_context,
                transient,
                run_id,
            } => {
                self.apply_bash_start(command, exclude_from_context, transient, run_id, view);
            }
            TurnUpdate::BashOutput { chunk } => {
                self.apply_bash_output(&chunk, view);
            }
            TurnUpdate::BashEnd {
                exit_code,
                cancelled,
                truncated,
                full_output_path,
                error_message,
                transient,
                run_id,
            } => {
                self.apply_bash_end(
                    exit_code,
                    cancelled,
                    truncated,
                    full_output_path,
                    error_message,
                    transient,
                    run_id,
                    view,
                );
            }
            TurnUpdate::QueueUpdated {
                steering,
                follow_ups,
                starting,
                rlm_child_status,
                injected_prompts,
            } => {
                view.queued = crate::queued::QueuedMessages {
                    steering,
                    follow_ups,
                    starting,
                    rlm_child_status,
                    injected_prompts,
                };
                // A queue change under an active browse reconciles the
                // selection (TS `refreshQueueSelectionAt`): the cursor
                // survives only when the addressed item is unchanged; a
                // stale selection drops and its stashed draft returns to
                // the editor.
                if let Some(selected) = self.queue_selection.selected() {
                    let (lane, index, text) =
                        (selected.lane, selected.index, selected.text.clone());
                    if let Some(draft) =
                        self.queue_selection
                            .refresh_at(&view.queued, lane, index, &text)
                    {
                        if view.editor.get_text() == text {
                            view.editor.set_text(&draft);
                        }
                    }
                }
                self.sync_queue_selection(view);
            }
            TurnUpdate::StatusUpdate => {}
        }
        self.dirty = true;
    }

    /// TS `interruptOrClearInput`'s abort ladder, shared by the Ctrl+C and
    /// Escape interrupts: a compacting session aborts the compaction run,
    /// a streaming turn aborts through `abort_and_send_queued` (schema 29),
    /// and a running user bash aborts alongside. The side-question abort
    /// stays at the call sites — the two keys dispose of its pane
    /// differently.
    pub(super) fn interrupt_running_work(&self, view: &AgentView) {
        // TS `interruptOrClearInput` aborts the trace upload sweep first
        // (the handler shows the cancelled row when the run settles).
        if let Some(run) = &self.trace_upload {
            run.cancel.cancel();
        }
        if view.compaction.is_some() {
            // The compaction loader is up (TS `isAgentCompacting()`):
            // the interrupt cancels the compaction run only — the agent
            // is not streaming, so no turn abort goes out, exactly like
            // the TS interrupt key.
            self.abort_compaction(view.compaction_generation);
        } else if self.turn_active {
            // TS shows no transient abort hint: the aborted turn's own
            // assistant row carries the interrupt (the red "Operation
            // aborted" error row inside the message component), so
            // nothing is noted here.
            self.abort_turn();
        }
        // A running user-bash command aborts the same way (TS
        // `interruptOrClearInput` fires `void abortBash()`): the settled
        // run reports cancelled through its bash_end.
        if self.user_bash_running {
            self.abort_user_bash();
        }
    }

    /// Apply an assistant message frame: an open streaming message is
    /// updated in place; otherwise the message expands into a chat component
    /// plus a card per tool call.
    fn apply_assistant_message(
        &mut self,
        message: &Value,
        streaming: bool,
        stream_event: Option<&Value>,
        view: &mut AgentView,
    ) {
        if let Some(event) = stream_event {
            self.track_stream_activity(event, view);
        }
        let (blocks, tool_calls) = assistant_message_parts(message);
        // A message_start always opens a new streaming message (the engine
        // emits one per provider call); later frames update it in place.
        let starts_message = stream_event
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str)
            == Some("start");
        let usage_output = message
            .get("usage")
            .and_then(|usage| usage.get("output"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if streaming {
            if starts_message {
                self.working_tokens.start_message();
            }
            let content_chars: u64 = blocks
                .iter()
                .map(|block| match block {
                    MessageBlock::Text(text) | MessageBlock::Thinking(text) => {
                        text.chars().count() as u64
                    }
                })
                .sum();
            let current = self
                .working_tokens
                .apply_streaming(usage_output, content_chars);
            if let Some(working) = &mut view.working {
                working.tokens = working.tokens.max(current);
            }
        } else {
            self.working_tokens.settle(usage_output);
            self.record_speed_sample(message, view);
        }
        if let Some(text) = blocks.iter().rev().find_map(|block| match block {
            MessageBlock::Text(text) => Some(text.clone()),
            MessageBlock::Thinking(_) => None,
        }) {
            self.last_assistant_text = Some(text);
        }
        let has_tool_calls = !tool_calls.is_empty();
        // A message_start always opens a new streaming message (the engine
        // emits one per provider call); later frames update it in place.
        if starts_message {
            self.streaming_index = None;
        }
        match self.streaming_index {
            Some(index) => {
                view.prepare_entry_mutation(index);
                if let Some(ChatEntry::Assistant(open)) = view.chat.get_mut(index) {
                    open.blocks = blocks;
                    open.has_tool_calls = has_tool_calls;
                    open.streaming = streaming;
                }
                view.mark_entry_stale(index);
            }
            None => {
                if !blocks.is_empty() {
                    view.push_entry(ChatEntry::Assistant(Box::new(
                        crate::chat::AssistantMessage {
                            blocks,
                            has_tool_calls,
                            streaming,
                            error: None,
                            aborted: false,
                        },
                    )));
                    self.streaming_index = Some(view.chat.len() - 1);
                }
            }
        }
        for (id, name, args) in &tool_calls {
            // A streamed tool call first appears queued; the execution start
            // event flips it to running, and later frames refresh its name
            // and args while they stream (TS `updateArgs` + the latest
            // streaming call winning at component creation). The failed
            // run's late frames touch no card either (the settled card
            // keeps its sweep-written result).
            if !self.aborted_tools.contains(id) {
                crate::snapshot::apply_streamed_tool_card(view, id, name, args);
            }
            if starts_message {
                // A new assistant message re-arms a reused id (TS builds a
                // fresh pending component for the new invocation); a late
                // `message_update` from a failed run must not. The re-armed
                // invocation's next streamed frame pushes its own fresh card
                // — the settled card is skipped by its `aborted` flag, the
                // way TS's cleared pending map forces a new component.
                self.aborted_tools.remove(id);
            }
            // TS `message_update` registers every streamed call in the
            // pending map (`message_start` and the final frame never do:
            // their cards either already settled or get the failed frame's
            // sweep); the failed run's late frames stay out too.
            if streaming && !starts_message && !self.aborted_tools.contains(id) {
                self.pending_tools.insert(id.clone());
            }
        }
        if !streaming {
            let open = self.streaming_index.take();
            self.finalize_assistant_error(message, &tool_calls, open, view);
        }
    }

    /// The final frame of a failed assistant message renders its error row
    /// (TS renders it inside the assistant component): `aborted` always
    /// shows, `error` only when the message carries no tool calls (the
    /// pending cards carry the failure then). The row renders inside the
    /// message's own component — the open streaming entry when one exists,
    /// otherwise a fresh entry: TS creates one component per assistant
    /// message (`message_start`), so a content-less provider failure stacks
    /// its own error row per failed attempt instead of decorating the
    /// previous reply (TS `AssistantMessageComponent.rebuild`).
    fn finalize_assistant_error(
        &mut self,
        message: &Value,
        tool_calls: &[(String, String, Value)],
        open: Option<usize>,
        view: &mut AgentView,
    ) {
        // TS `message_end`'s failed-frame block: an aborted run's row text
        // is the client's own — the retry count and the working-elapsed
        // suffix never ride the wire (the rebuild keeps the stored
        // "Operation aborted") — and every still-pending tool card settles
        // with the failure text; late result frames land on nothing.
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let abort_text = if stop_reason == Some("aborted") {
            Some(crate::chat::live_abort_text(
                view.retry.as_ref().map_or(0, |retry| retry.attempt),
                view.working_since.map(|since| since.elapsed().as_secs()),
            ))
        } else {
            None
        };
        if abort_text.is_some() || stop_reason == Some("error") {
            let settle_text = abort_text.clone().unwrap_or_else(|| {
                message
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Error")
                    .to_string()
            });
            crate::snapshot::settle_pending_tool_cards(
                view,
                &mut self.pending_tools,
                &mut self.aborted_tools,
                &settle_text,
            );
        }
        let Some(error) = crate::snapshot::assistant_error_row(message, tool_calls) else {
            return;
        };
        let error = match abort_text {
            Some(text) => crate::snapshot::AssistantErrorRow {
                text,
                aborted: true,
            },
            None => error,
        };
        self.turn_error_shown = true;
        if let Some(index) = open {
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::Assistant(entry)) = view.chat.get_mut(index) {
                entry.error = Some(error.text);
                entry.aborted = error.aborted;
                view.mark_entry_stale(index);
                return;
            }
        }
        // The message rendered no component (empty content): TS still
        // renders the message's own error component, so the failure stacks
        // as a separate row instead of attaching to the last assistant.
        view.push_entry(ChatEntry::Assistant(Box::new(
            crate::chat::AssistantMessage {
                blocks: Vec::new(),
                has_tool_calls: false,
                streaming: false,
                error: Some(error.text),
                aborted: error.aborted,
            },
        )));
    }

    /// Attach a (partial or final) tool result to the matching card.
    /// Returns whether the result landed (a card exists and is not
    /// aborted): the caller's loader work rides the same gate — the
    /// aborted card's late frames must leave the loader untouched too
    /// (TS `tool_execution_end` does nothing without a pending
    /// component).
    fn apply_tool_result(
        &mut self,
        tool_call_id: &str,
        result: Value,
        is_error: bool,
        partial: bool,
        view: &mut AgentView,
    ) -> bool {
        let result = ToolResultView {
            content: result
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            details: result.get("details").cloned().unwrap_or(Value::Null),
            is_error,
        };
        // The result lands on the newest card carrying the id: a re-armed
        // invocation pushed its own card, and the older settled card keeps
        // its sweep-written result (TS's pending map only ever holds the
        // current component).
        let card_index = view
            .chat
            .iter()
            .rposition(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == tool_call_id));
        if let Some(index) = card_index {
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                // The failed frame's sweep owns the call: the tool's late
                // result frames land on nothing (TS `tool_execution_end`
                // finds no component in the cleared pending map).
                if self.aborted_tools.contains(tool_call_id) || card.aborted {
                    return false;
                }
                card.result = Some(result);
                card.result_partial = partial;
                if !partial {
                    card.ended_at = Some(std::time::Instant::now());
                    self.pending_tools.remove(tool_call_id);
                }
                view.mark_entry_stale(index);
                return true;
            }
        }
        false
    }

    /// Update the loader activity label (agent-activity tracker subset).
    fn set_working_activity(
        &mut self,
        activity: &'static str,
        download: bool,
        view: &mut AgentView,
    ) {
        if let Some(working) = &mut view.working {
            working.activity = activity;
            working.download = download;
        }
    }
}
