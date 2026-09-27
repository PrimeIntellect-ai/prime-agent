//! The bash concern: `!`/`!!` user-bash runs with their start/output/end
//! application and flush, the kernel-bash registry, and the bash view.
use super::*;

/// Kernel-bash channel frames: list snapshots refresh the dock and the
/// open bash view, a landed tail feeds the open view's detail row, and
/// background action surfaces as an error row.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BashActivityUpdate {
    /// `epoch` identifies the list request the response answers; only the
    /// latest issued request's response may land.
    List {
        session: String,
        epoch: u64,
        data: Value,
    },
    Tail {
        session: String,
        activity_id: String,
        /// The detail-open generation the request was issued under: a
        /// late tail from an earlier open never lands on a newer one.
        generation: u64,
        tail: String,
    },
    /// A background action settled; re-issue the list from the main loop so
    /// the request carries a fresh epoch (one issued mid-action must not
    /// supersede the post-action snapshot).
    Refresh { session: String },
    Error {
        session: String,
        message: String,
        /// The activity the failed request was about (a tail or kill for
        /// one row): a late failure lands only on that row's open detail
        /// pane, never on whichever row the user switched to.
        activity_id: Option<String>,
        /// The failure came from a tail fetch (the view supersedes it on
        /// the next successful fetch) rather than a kill.
        fetch: bool,
        /// The detail-open generation the failed tail fetch was issued
        /// under: like the tail responses, a late fetch failure from an
        /// earlier open of the same row never lands on the newer one
        /// (a kill owns no generation and stays `None`).
        generation: Option<u64>,
    },
}

/// The attached snapshot's bash slot state, captured by `attach_session`
/// while the client's pre-attach belief is still readable.
#[derive(Debug, Clone, Copy)]
pub(super) struct ResyncBash {
    /// The client's running flag before the attach patched it.
    pub(super) was_running: bool,
    /// The snapshot state's `isBashRunning`.
    pub(super) snap_running: bool,
    /// The snapshot state's `isStreaming` (the flush gate uses it alone,
    /// TS `renderResyncedSession`).
    pub(super) snap_streaming: bool,
}

/// One in-flight side-conversation bash run (TS `sideQuestionBash`): the
/// `runId` the daemon echoes on the run's `bash_*` events, the raw input
/// (`!command`) that seeded it, and whether its output seeds follow-up
/// side questions (the `!`, not the `!!`, variant).
#[derive(Debug, Clone)]
pub(super) struct SideBashRun {
    pub(super) run_id: String,
    input: String,
    seed_transcript: bool,
}

impl SessionUi {
    /// TS `!command` / `!!command` (interactive-mode `onSubmit`): run the
    /// command through the daemon's user-bash slot — no model turn. `!`
    /// output enters the session context (the daemon records the durable
    /// `bashExecution` row, so follow-up prompts answer it); `!!` stays
    /// excluded. Inside a side conversation the run is transient: it
    /// renders in the pane, stays out of the main context, and (for `!`)
    /// seeds follow-up side questions.
    pub(super) async fn run_chat_bash(
        &mut self,
        text: &str,
        shortcut: &crate::bash_bang::BashShortcut,
        view: &mut AgentView,
    ) -> Result<()> {
        // A running user command blocks a second one (TS `isBashRunning`
        // guard); the editor buffer already cleared on submit, so the
        // draft is not restored.
        if self.user_bash_running {
            self.note_as(
                &already_running_warning(&self.keybindings),
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        // A streaming side turn blocks bash like it blocks follow-up
        // replies: overlapping pane turns would seed out of order; the
        // draft returns to the editor (TS `editor.setText(text)`).
        if view.side_pane.is_some() && self.active_side_question_id.is_some() {
            view.editor.set_text(text);
            self.note_as(
                "\u{26a0} Wait for the current side question to finish or cancel it first.",
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        // Inside a side conversation the command runs inside the pane
        // (its bash_start mounts the row there), stays out of the
        // main-session context, and (for `!`, not `!!`) seeds follow-up
        // side questions.
        let side_bash = view.side_pane.is_some().then(|| {
            self.side_bash_counter += 1;
            SideBashRun {
                run_id: format!("side-bash-{}", self.side_bash_counter),
                input: text.to_string(),
                seed_transcript: !shortcut.excluded,
            }
        });
        if side_bash.is_none() {
            // Main-thread bash clears any side-question state first (TS
            // `clearSideQuestion({ abort: true })`).
            self.clear_side_question(true, view).await;
        }
        view.editor.add_to_history(text);
        // Optimistic running flag (TS `patchConnectionState({
        // isBashRunning: true })`): bash_start only fires after the
        // dispatch, and the clear key must already route to abort_bash
        // in that window.
        self.user_bash_running = true;
        if let Some(telemetry) = self.telemetry.clone() {
            let excluded = shortcut.excluded;
            let side_conversation = side_bash.is_some();
            tokio::spawn(async move {
                telemetry
                    .bash_shortcut_used(excluded, side_conversation)
                    .await;
            });
        }
        let run_id = side_bash.as_ref().map(|run| run.run_id.clone());
        let excluded = shortcut.excluded || side_bash.is_some();
        if let Some(run) = side_bash {
            self.side_bash = Some(run);
        }
        let request = DaemonCommand::ExecuteBash {
            id: None,
            active_session_id: self.active_session_id.clone(),
            command: shortcut.command.clone(),
            exclude_from_context: Some(excluded),
            transient: run_id.is_some().then_some(true),
            run_id: run_id.clone(),
            rest: Map::default(),
        };
        if let Err(error) = self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            // The rejection may mean another client's bash run already
            // holds the slot (TS re-syncs from the daemon state; the
            // settled events patch it either way) — assume idle.
            self.user_bash_running = false;
            if run_id.is_some() && self.side_bash.as_ref().map(|run| run.run_id.clone()) == run_id {
                self.side_bash = None;
            }
            if run_id.is_some() && self.side_bash_discarded == run_id {
                // The pane discarded this run, but it never started, so
                // no bash_end will arrive to consume the marker.
                self.side_bash_discarded = None;
            }
            self.error_row(&format!("{error:#}"), view);
        }
        self.dirty = true;
        Ok(())
    }

    /// The open-time kernel-bash fold: the first `list_kernel_bash`
    /// response lands in the registry synchronously with the attach
    /// (capability-gated and bounded like the background refresh), so
    /// the dock's bash rows ride the first content frame instead of
    /// popping in late. A failed fetch leaves the just-cleared registry
    /// — the 2s poll refills.
    pub(super) async fn fetch_bash_activities(&mut self) {
        if !self.kernel_bash_supported() {
            return;
        }
        // Advance the epoch so a poll still in flight from before the
        // attach (the 2s cadence's spawned list) never overwrites this
        // fold with its older registry: the epoch check drops it at
        // fold time.
        self.bash_list_epoch += 1;
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::ListKernelBash {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        else {
            return;
        };
        self.bash_activities = data;
    }

    /// Whether the daemon advertises the kernel-bash registry (older
    /// daemons never see the list requests).
    fn kernel_bash_supported(&self) -> bool {
        self.client
            .hello()
            .get("serverCapabilities")
            .and_then(Value::as_array)
            .is_some_and(|caps| {
                caps.iter()
                    .any(|cap| cap.as_str() == Some("kernel_bash_activity"))
            })
    }

    pub(crate) fn spawn_bash_activity_refresh(&mut self) {
        if !self.kernel_bash_supported() {
            return;
        }
        // The 2s poll, the view open, and the post-kill refresh can
        // overlap: every request stamps the epoch it was issued under, and
        // only the latest issued request's response lands.
        self.bash_list_epoch += 1;
        let epoch = self.bash_list_epoch;
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let session_for_update = active_session_id.clone();
        let tx = self.bash_updates.clone();
        tokio::spawn(async move {
            if let Ok(data) = client
                .request_ok(DaemonCommand::ListKernelBash {
                    id: None,
                    active_session_id,
                    rest: Map::default(),
                })
                .await
            {
                let _ = tx.send(BashActivityUpdate::List {
                    session: session_for_update,
                    epoch,
                    data,
                });
            }
        });
    }

    /// A late poll from the previous session must not repaint the dock of
    /// the newly attached one: every update carries the session it asked
    /// about, and only that session's frames land.
    pub(crate) fn apply_bash_activity(&mut self, update: BashActivityUpdate, view: &mut AgentView) {
        let session = match &update {
            BashActivityUpdate::List { session, .. }
            | BashActivityUpdate::Tail { session, .. }
            | BashActivityUpdate::Refresh { session }
            | BashActivityUpdate::Error { session, .. } => session,
        };
        if session != &self.active_session_id {
            return;
        }
        match update {
            BashActivityUpdate::List { epoch, data, .. } => {
                // A late response from an older request must not repaint a
                // newer snapshot (a killed process must not come back as
                // running).
                if epoch != self.bash_list_epoch {
                    return;
                }
                if self.bash_activities == data {
                    return;
                }
                // A landed REGISTRY update supersedes a shown error — but
                // only when the registry's rows actually moved (a row
                // settled, started, or left): the running rows' duration
                // ticks every poll and never clear anything. The
                // unrelated dock repaints never clear it either.
                let row_signature = |data: &Value| -> Vec<(String, String, Option<i64>)> {
                    crate::bash_view::parse_bash_activities(data)
                        .into_iter()
                        .map(|row| (row.id, row.status, row.exit_code))
                        .collect()
                };
                let rows_settled = row_signature(&self.bash_activities) != row_signature(&data);
                self.bash_activities = data;
                if rows_settled {
                    if let Some(bash_view) = view.bash_view.as_mut() {
                        bash_view.clear_error();
                    }
                }
                self.update_subagent_summary(view);
            }
            BashActivityUpdate::Tail {
                activity_id,
                tail,
                generation,
                ..
            } => {
                if let Some(bash_view) = view.bash_view.as_mut() {
                    bash_view.set_output(&activity_id, &tail, generation);
                }
            }
            BashActivityUpdate::Error {
                message,
                activity_id,
                fetch,
                generation,
                ..
            } => {
                // An in-view action's failure surfaces in the open bash
                // view — and only when the failed request's row is the
                // open detail (a late failure for another row's request
                // never lands on it); with no view open the transcript
                // row carries it.
                let detail_matches = match (&view.bash_view, &activity_id) {
                    (Some(bash_view), Some(id)) => bash_view.detail_id().as_deref() == Some(id),
                    _ => true,
                };
                if view.bash_view.is_some() && detail_matches {
                    if let Some(bash_view) = view.bash_view.as_mut() {
                        bash_view.set_error(message, fetch, generation);
                    }
                } else {
                    self.error_row(&message, view);
                }
            }
            BashActivityUpdate::Refresh { .. } => {
                // Issue a fresh list from the main loop; its own response
                // lands through this channel with a current epoch.
                self.spawn_bash_activity_refresh();
                return;
            }
        }
        self.dirty = true;
    }

    /// Open the dedicated bash view over the kernel bash registry (the
    /// dock's Bash group's destination): the latest snapshot mounts and
    /// the 2s refresh keeps it current.
    pub(super) fn open_bash_view(&mut self, view: &mut AgentView) {
        self.spawn_bash_activity_refresh();
        view.bash_view = Some(BashView::new(
            crate::bash_view::parse_bash_activities(&self.bash_activities),
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        self.dirty = true;
    }

    /// Fetch one bash activity's output tail off the key loop (a stalled
    /// kernel must not freeze the TUI behind the request bound): the
    /// response lands on the open view through the update channel,
    /// stamped with the detail-open generation it was issued under (the
    /// open's first window or a later lazy load's grown one — the view
    /// owns the window policy).
    fn spawn_bash_tail_fetch(&self, activity_id: String, generation: u64, lines: u32) {
        let client = self.client.clone();
        let session = self.active_session_id.clone();
        let tx = self.bash_updates.clone();
        tokio::spawn(async move {
            let response_id = activity_id.clone();
            let result = client
                .request_ok(DaemonCommand::TailKernelBash {
                    id: None,
                    active_session_id: session.clone(),
                    activity_id,
                    lines: Some(lines),
                    rest: Map::default(),
                })
                .await;
            match result {
                Ok(data) => {
                    if let Some(tail) = data.get("tail").and_then(Value::as_str) {
                        let _ = tx.send(BashActivityUpdate::Tail {
                            session,
                            activity_id: response_id,
                            generation,
                            tail: tail.to_string(),
                        });
                    }
                }
                Err(error) => {
                    let _ = tx.send(BashActivityUpdate::Error {
                        session,
                        message: format!("Bash output: {error:#}"),
                        activity_id: Some(response_id),
                        fetch: true,
                        generation: Some(generation),
                    });
                }
            }
        });
    }

    /// One key press while the bash view is open: the view owns the frame
    /// the same way as the heartbeats view; its actions run the kernel
    /// bash requests off the key loop.
    pub(super) async fn handle_bash_view_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .bash_view
            .as_mut()
            .map(|bash_view| bash_view.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(BashViewAction::Close) => {
                view.bash_view = None;
                // The exit restores the dock's own group (the operator's
                // 2026-09-26 panel-exit ruling): ESC/left lands back on
                // the Shells item, ready to re-open, not on the prompt
                // bar.
                self.focus_activity_dock(view);
            }
            Some(BashViewAction::OpenDetail { id, generation }) => {
                // The lazy tail: the open asks for the first window only
                // (FIRST_TAIL_LINES); the detail's upward scroll grows
                // the window on demand (LoadMore below). The request runs
                // off the key loop (a stalled kernel must not freeze the
                // TUI behind the request bound): the tail lands on the
                // open view through the update channel, stamped with this
                // open's generation so a late response from an earlier
                // open never overwrites it.
                self.spawn_bash_tail_fetch(id, generation, crate::bash_view::FIRST_TAIL_LINES);
            }
            Some(BashViewAction::LoadMore {
                id,
                generation,
                lines,
            }) => {
                // The detail scrolled to the top of its loaded window:
                // re-fetch the row's output with the grown window (the
                // view owns the growth policy, capped by the wire).
                self.spawn_bash_tail_fetch(id, generation, lines);
            }
            Some(BashViewAction::Kill { id }) => {
                let client = self.client.clone();
                let session = self.active_session_id.clone();
                let tx = self.bash_updates.clone();
                tokio::spawn(async move {
                    let error_id = id.clone();
                    let result = client
                        .request_ok(DaemonCommand::KillKernelBash {
                            id: None,
                            active_session_id: session.clone(),
                            activity_id: id,
                            rest: Map::default(),
                        })
                        .await;
                    match result {
                        Ok(_) => {
                            // The killed row settles immediately: the main
                            // loop re-issues the list under a fresh epoch.
                            let _ = tx.send(BashActivityUpdate::Refresh { session });
                        }
                        Err(error) => {
                            let _ = tx.send(BashActivityUpdate::Error {
                                session,
                                message: format!("Could not kill bash command: {error:#}"),
                                activity_id: Some(error_id),
                                fetch: false,
                                generation: None,
                            });
                        }
                    }
                });
            }
            Some(BashViewAction::None) | None => {}
        }
        self.dirty = true;
        Ok(())
    }

    /// `bash_start` (TS the interactive `bash_start` case): a user-bash run
    /// began. The client's running flag patches first (the slot is
    /// session-scoped), then a discarded side run's events are swallowed
    /// (aborting by its identity so the slot frees), a foreign transient
    /// run renders only in its owning client's pane, an own side run
    /// mounts its row in the pane, and a main-thread run mounts the usual
    /// bash transcript card.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn apply_bash_start(
        &mut self,
        command: String,
        exclude_from_context: bool,
        transient: bool,
        run_id: Option<String>,
        view: &mut AgentView,
    ) {
        self.user_bash_running = true;
        if let Some(discarded) = self.side_bash_discarded.clone() {
            if run_id.as_deref() == Some(&discarded) {
                // The discarded run now owns the bash slot: abort only
                // after matching its identity, so a foreign run is never
                // killed (TS aborts the same way).
                self.abort_user_bash();
                return;
            }
            // A different run claimed the slot, so the discarded run lost
            // the race and can never start: render this run normally.
            self.side_bash_discarded = None;
        }
        let own_side_bash = self
            .side_bash
            .as_ref()
            .is_some_and(|run| run_id.as_deref() == Some(run.run_id.as_str()));
        if transient && !own_side_bash {
            // Another client's side-conversation run: it renders only in
            // that client's pane, never in this window's chat.
            return;
        }
        if own_side_bash && view.side_pane.is_some() {
            // The same component as the main thread, mounted inside the
            // pane (TS `sideQuestionComponent.addBash`).
            if let Some(pane) = view.side_pane.as_mut() {
                pane.bash = Some(crate::side_question::PaneBash::new_running(
                    &command,
                    exclude_from_context,
                ));
            }
            self.user_bash_card = None;
            self.user_bash_started_at = None;
            return;
        }
        // The main-thread card (the same component a replayed
        // `bashExecution` row renders). While the agent streams it holds
        // above the execution indicator (TS `pendingMessagesContainer`),
        // flushed into the transcript when the turn settles.
        self.user_bash_counter += 1;
        let id = format!("user-bash-{}", self.user_bash_counter);
        let mut card =
            crate::bash_card::BashExecutionCard::new_running(&id, &command, exclude_from_context);
        card.suppress_leading_space = matches!(view.chat.last(), Some(ChatEntry::AgentMessage(_)));
        if self.turn_active {
            view.pending_bash.push(card);
        } else {
            view.push_entry(ChatEntry::BashExecution(Box::new(card)));
        }
        self.user_bash_card = Some(id);
        self.user_bash_started_at = Some(std::time::Instant::now());
    }

    /// `bash_output` (TS the `bash_output` case): one streamed chunk
    /// appends to the active surface — the pane's row for a side run, the
    /// mounted card's output otherwise. Discarded runs swallow their
    /// chunks.
    pub(super) fn apply_bash_output(&mut self, chunk: &str, view: &mut AgentView) {
        if self.side_bash_discarded.is_some() {
            return;
        }
        // The pane route only while its row is the active run: the bash
        // slot is single-flight, so a still-running pane row owns every
        // chunk, but a settled row from an earlier side run must not
        // swallow a later main-thread run's output (`bash_output` carries
        // no run identity; TS routes by the active component, so a stale
        // pane row never receives the next run's chunks).
        if let Some(pane) = view.side_pane.as_mut() {
            if let Some(bash) = pane.bash.as_mut() {
                if bash.running {
                    bash.output.push_str(chunk);
                    return;
                }
            }
        }
        let Some(card_id) = self.user_bash_card.clone() else {
            return;
        };
        if let Some(card) = view.pending_bash.iter_mut().find(|card| card.id == card_id) {
            card.append_output(chunk);
        } else if let Some(index) = view
            .chat
            .iter()
            .position(|entry| matches!(entry, ChatEntry::BashExecution(card) if card.id == card_id))
        {
            // The streamed card grows inside the transcript: capture the
            // pre-append height so the tail-anchored sparse window folds
            // the growth into its bookkeeping (the `prepare` +
            // `mark_stale` pair every other growing entry uses).
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::BashExecution(card)) = view.chat.get_mut(index) {
                card.append_output(chunk);
            }
            view.mark_entry_stale(index);
        }
    }

    /// `bash_end` (TS the `bash_end` case): the settled run patches the
    /// running flag, completes the mounted row (or surfaces the failure
    /// when no row is mounted), and an own pane-mounted run seeds the
    /// follow-up side questions (the `!`, not `!!`, variant — unless it
    /// was cancelled or failed).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn apply_bash_end(
        &mut self,
        exit_code: Option<i64>,
        cancelled: bool,
        truncated: bool,
        full_output_path: Option<String>,
        error_message: Option<String>,
        transient: bool,
        run_id: Option<String>,
        view: &mut AgentView,
    ) {
        self.user_bash_running = false;
        if let Some(discarded) = self.side_bash_discarded.clone() {
            if run_id.as_deref() == Some(&discarded) {
                // Only the discarded run's own end consumes the marker
                // (bash_start already cleared it for any other run that
                // claimed the slot).
                self.side_bash_discarded = None;
                self.user_bash_card = None;
                return;
            }
        }
        // An own side run: settle the pane's row and seed the follow-up
        // transcript (TS `finishSideQuestionBash`).
        if let Some(run) = self.side_bash.take() {
            let own_run = run_id.as_deref() == Some(run.run_id.as_str());
            let pane_mounted = view
                .side_pane
                .as_ref()
                .is_some_and(|pane| pane.bash.is_some());
            if own_run && pane_mounted {
                let pane = view.side_pane.as_mut().expect("checked");
                if let Some(bash) = pane.bash.as_mut() {
                    bash.running = false;
                    bash.exit_code = exit_code;
                    bash.cancelled = cancelled;
                    bash.truncated = truncated;
                    bash.full_output_path.clone_from(&full_output_path);
                    bash.error_message.clone_from(&error_message);
                }
                if run.seed_transcript && !cancelled && error_message.is_none() {
                    let raw = pane
                        .bash
                        .as_ref()
                        .map(|bash| bash.output.clone())
                        .unwrap_or_default();
                    let (tail, tail_truncated) = crate::bash_bang::truncate_tail(&raw);
                    let output = tail.trim_end_matches('\n').to_string();
                    let answer = crate::bash_bang::bash_output_to_text(
                        &output,
                        exit_code,
                        truncated || tail_truncated,
                        full_output_path.as_deref(),
                    );
                    pane.extra_seeds.push((run.input, answer));
                }
            }
        }
        // The mounted card settles (an error status when the run failed
        // or exited non-zero, TS `setComplete`/`setFailed`), wherever the
        // run mounted — the pending hold keeps its place until the turn
        // flushes (TS `bash_end` does not flush the pending container).
        let started_at = self.user_bash_started_at.take();
        if let Some(card_id) = self.user_bash_card.take() {
            let mut settled = false;
            if let Some(index) = view.chat.iter().position(
                |entry| matches!(entry, ChatEntry::BashExecution(card) if card.id == card_id),
            ) {
                view.prepare_entry_mutation(index);
                if let Some(ChatEntry::BashExecution(card)) = view.chat.get_mut(index) {
                    match &error_message {
                        Some(message) => card.set_failed(message),
                        None => card.set_complete(
                            exit_code,
                            cancelled,
                            truncated,
                            full_output_path.clone(),
                        ),
                    }
                }
                view.mark_entry_stale(index);
                settled = true;
            }
            if !settled {
                if let Some(card) = view.pending_bash.iter_mut().find(|card| card.id == card_id) {
                    match &error_message {
                        Some(message) => card.set_failed(message),
                        None => {
                            card.set_complete(exit_code, cancelled, truncated, full_output_path);
                        }
                    }
                }
            }
            self.track_bash_bang_executed(
                started_at,
                exit_code,
                cancelled,
                error_message.as_deref(),
            );
        } else if let Some(message) = error_message {
            // Transient failures surface in the owning client's pane,
            // not here (TS `showError`: the `⚠ Error:` row).
            if !transient {
                self.error_row(&format!("Bash command failed: {message}"), view);
            }
        }
    }

    /// `flushPendingBashComponents` (TS `turn_end`, the next user prompt,
    /// and the resync's bash-finished path): the in-flight bash cards
    /// held above the indicator while the turn streamed settle into the
    /// transcript.
    pub(super) fn flush_pending_bash(&mut self, view: &mut AgentView) {
        let pending = std::mem::take(&mut view.pending_bash);
        for card in pending {
            view.push_entry(ChatEntry::BashExecution(Box::new(card)));
        }
    }

    /// `tui bash bang executed` (event `bash_bang_executed`, the lane's
    /// settle adoption telemetry): a duration bucket and an exit-code
    /// class, primitives only — never the command or any output.
    fn track_bash_bang_executed(
        &self,
        started_at: Option<std::time::Instant>,
        exit_code: Option<i64>,
        cancelled: bool,
        error_message: Option<&str>,
    ) {
        let Some(telemetry) = self.telemetry.clone() else {
            return;
        };
        let duration_bucket = match started_at {
            Some(start) => {
                let secs = start.elapsed().as_secs();
                match secs {
                    0..=4 => "lt_5s",
                    5..=29 => "5_to_30s",
                    _ => "30s_plus",
                }
            }
            None => "unknown",
        };
        let exit_class = if cancelled {
            "cancelled"
        } else if error_message.is_some() {
            "failed"
        } else {
            match exit_code {
                Some(code) if code != 0 => "nonzero",
                Some(_) => "zero",
                None => "unknown",
            }
        };
        tokio::spawn(async move {
            telemetry
                .bash_bang_executed(duration_bucket, exit_class)
                .await;
        });
    }

    /// `abort_bash` off the UI loop (TS `interruptOrClearInput` fires
    /// `void abortBash()`): the request never blocks key handling, and a
    /// failure surfaces as a background note.
    pub(super) fn abort_user_bash(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            if let Err(error) = client
                .request_ok(DaemonCommand::AbortBash {
                    id: None,
                    active_session_id,
                    rest: Map::default(),
                })
                .await
            {
                let _ = notes.send(format!("the bash abort failed: {error:#}"));
            }
        });
    }
}

#[cfg(test)]
mod bash_bang_tests {
    use super::already_running_warning;
    use crate::keybindings::KeybindingsManager;

    /// TS `isBashRunning` guard: the warning spells the clear key
    /// through the effective bindings (the default is ctrl+c).
    #[test]
    fn the_running_guard_names_the_clear_key() {
        let warning = already_running_warning(&KeybindingsManager::new());
        assert!(
            warning.starts_with("\u{26a0} A bash command is already running. Press ")
                && warning.ends_with(" to cancel it first."),
            "the guard sentence matches TS: {warning}"
        );
        assert!(warning.contains("Ctrl+C"));
    }
}
