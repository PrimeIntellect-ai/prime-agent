//! The session-lifecycle concern: the open/attach/reattach pipeline
//! (the session selection's open, the §10 reattach, the attach fold,
//! and the transcript rebuild it feeds), the stats refresh, and the
//! detach/exit request helpers.
use super::{
    attach_data_from_response, create_session, mpsc, reconstruct, resume_hint_from_stats,
    ActivityUpdates, AgentView, BTreeMap, ChatEntry, CompactionAbortNote, Context, DaemonClient,
    DaemonCommand, DockFold, Duration, GoalView, HashSet, InteractiveOptions, LoaderTokenTracker,
    Map, MessageBlock, ModelCatalogUpdate, PromptOrder, PromptSubmitNote, ReattachOutcome,
    RebuildKind, RecoveryKind, ReloadNote, Result, ResyncBash, SessionSelection, SessionUi,
    ShareNote, UpdateNote, Value, EXIT_DETACH_TIMEOUT_MS, EXIT_STATS_TIMEOUT_MS,
    UI_REQUEST_TIMEOUT_MS,
};

impl SessionUi {
    /// Create/attach per the session selection and return the live state.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open(
        client: DaemonClient,
        options: &InteractiveOptions,
        notes: mpsc::UnboundedSender<String>,
        compaction_abort_notes: mpsc::UnboundedSender<CompactionAbortNote>,
        prompt_notes: mpsc::UnboundedSender<PromptSubmitNote>,
        share_notes: mpsc::UnboundedSender<ShareNote>,
        reload_notes: mpsc::UnboundedSender<ReloadNote>,
        update_notes: mpsc::UnboundedSender<UpdateNote>,
        traces_upload_notes: mpsc::UnboundedSender<crate::traces::TraceUploadAllNote>,
        catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
        auth_panel_notes: mpsc::UnboundedSender<crate::auth_panel::AuthPanelRequest>,
        activity_updates: ActivityUpdates,
    ) -> Result<SessionUi> {
        let active_session_id = match &options.session {
            SessionSelection::New => create_session(&client, options, None).await?,
            SessionSelection::NewChild { rlm_depth, .. } => {
                let id = create_session(&client, options, None).await?;
                // `tui agents new scoped`, fire-and-forget (the
                // `subagents_view_opened` pattern): the open never waits on
                // the telemetry flush.
                if let Some(telemetry) = options.telemetry.clone() {
                    let depth = *rlm_depth;
                    tokio::spawn(async move {
                        telemetry.scoped_agent_created(depth).await;
                    });
                }
                id
            }
            SessionSelection::Attach(id) => id.clone(),
            SessionSelection::Resume(_) => {
                create_session(&client, options, Some(&options.session)).await?
            }
        };
        // The single prompt-submit worker (see [`PromptOrder`]): it owns
        // the ordered drain, so submit order on the wire is submit order
        // at the channel, and no per-submit task can reorder two rapid
        // submissions. The worker lives with the orders channel — the
        // session drops its sender and the worker's recv() ends, so the
        // task never outlives the run (the agents-view handoff and the
        // exit both drop the session).
        let (orders_tx, orders_rx) = mpsc::unbounded_channel::<PromptOrder>();
        tokio::spawn(Self::prompt_submit_worker(orders_rx, prompt_notes.clone()));
        let mut session = SessionUi {
            client,
            active_session_id: String::new(),
            session_id: String::new(),
            attach_event_generation: String::new(),
            attach_event_sequence: 0,
            last_event_sequence: 0,
            attach_cursor_present: false,
            session_name: None,
            cwd: options.cwd.clone(),
            session_dir: options.session_dir.clone(),
            script_path: options.script_path.clone(),
            model_selection: options.model_selection.clone(),
            models: options.models.clone(),
            model_catalog: options.model_catalog.clone(),
            model_configured_providers: options.model_configured_providers.clone(),
            model_recent_models: options.model_recent_models.clone(),
            default_thinking_level: options.default_thinking_level.clone(),
            models_fetched_at: None,
            catalog_updates,
            heartbeat_updates: activity_updates.heartbeats,
            telemetry_disabled: options.telemetry_disabled,
            code_block_indent: options.code_block_indent.clone(),
            tree_filter_mode: crate::tree_list::filter_mode_from_str(&options.tree_filter_mode),
            branch_summary_skip_prompt: options.branch_summary_skip_prompt,
            last_status_index: None,
            show_images: options.show_images,
            fullscreen_mouse: options.fullscreen_mouse,
            service_tier: None,
            speed_display_enabled: false,
            speed_stats: None,
            client_settings: options.client_settings.clone(),
            anthropic_subscription_warning_shown: false,
            anthropic_warning_mark_pending: std::sync::Arc::default(),
            active_side_question_id: None,
            side_question_counter: 0,
            share: None,
            reload: None,
            reload_notes,
            share_notes,
            trace_upload: None,
            traces_upload_notes,
            pending_traces_login: None,
            traces_login_run: None,
            traces_login_gen: 0,
            pasted_images: BTreeMap::default(),
            next_image_marker_id: 1,
            pending_snapshot: None,
            trim_after_frame: false,
            pending_model: None,
            pending_model_provider: None,
            pending_thinking_suffix: None,
            pending_queue: None,
            queue_selection: crate::queued::QueueSelection::default(),
            context: None,
            list_rows: Vec::new(),
            turn_active: false,
            turn_ends_seen: 0,
            last_prompt_turn_end: 0,
            steering_mode: "all".to_string(),
            streaming_index: None,
            working_tokens: LoaderTokenTracker::default(),
            turn_error_shown: false,
            pending_tools: HashSet::default(),
            aborted_tools: HashSet::default(),
            last_assistant_text: None,
            osc_sink: crate::clipboard::OscSink::Stdout,
            pending_confirm: None,
            traces: options.traces.clone(),
            provider_auth: options.provider_auth.clone(),
            pending_model_sign_in: None,
            auth_panel_notes,
            auth_panel_cancel: None,
            update_commands: options.update_commands.clone(),
            update_notes,
            update_in_flight: false,
            exit_requested: false,
            open_agents_view: false,
            scoped_agents_view: None,
            roster: Vec::new(),
            heartbeat_catalog: Vec::new(),
            heartbeat_refresh_in_flight: false,
            heartbeat_refresh_queued: false,
            heartbeat_refresh_epoch: 0,
            command_updates: activity_updates.commands,
            command_refresh_epoch: 0,
            skill_commands_cache: Vec::new(),
            bash_activities: serde_json::json!({"activities": []}),
            bash_list_epoch: 0,
            bash_updates: activity_updates.bash,
            factory_graph: serde_json::json!({"runs": []}),
            factory_view_session: None,
            factory_refresh_in_flight: false,
            factory_refresh_queued: false,
            factory_list_epoch: 0,
            factory_updates: activity_updates.factory,
            factory_selected_run: None,
            subagents_focused: false,
            activity_group: crate::chrome::ActivityGroup::Subagents,
            subagent_counts: crate::subagents::SubagentCounts::default(),
            session_file: None,
            pending_selection: None,
            return_to_agents_view: !options.no_session,
            client_auth: options.client_auth.clone(),
            keybindings: options.keybindings.clone(),
            prompt_stash: options.prompt_stash.clone(),
            stash_session_id: String::new(),
            dirty: true,
            ctrl_c_hint_until: None,
            goal_view: GoalView::new(),
            notes,
            compaction_abort_notes,
            prompt_orders: orders_tx,
            input_submission_generation: 0,
            prompt_in_flight: 0,
            transcript_stale: false,
            telemetry: options.telemetry.clone(),
            scroll_adoption_emitted: false,
            exit_reason: "daemon_closed",
            reconnect: None,
            daemon_closing_notice: None,
            transport_lost: None,
            pending_rebind: None,
            reconnection_failed: None,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            escape_repeat_action: None,
            escape_repeat_until: None,
            escape_tree_shortcut_spent: false,
            user_bash_running: false,
            user_bash_card: None,
            user_bash_started_at: None,
            user_bash_counter: 0,
            resync_bash: None,
            loader_anchor_ms: None,
            side_bash: None,
            side_bash_discarded: None,
            side_bash_counter: 0,
            suspend_requested: false,
            external_editor_request: None,
            pending_mcp_auth: None,
            picker_restored_draft: false,
            suspend_adoption_emitted: false,
            selection_auto_scroll: None,
            selection_adoption_emitted: false,
            copies: Vec::new(),
            pressed_hyperlink: None,
            left_mouse_dragged: false,
            opened_urls: Vec::new(),
            pressed_click: None,
            click_adoption_emitted: false,
        };
        session
            .attach_session(&active_session_id, DockFold::FirstFrame)
            .await
            .with_context(|| format!("attaching session {active_session_id}"))?;
        // The scope-back reopen's restore lands AFTER the attach: the
        // attach's rebind reset clears the focus, so the reopen's own
        // restore must survive it.
        session.subagents_focused = options.restore_dock_focus;
        Ok(session)
    }

    /// Spec §10.2-§10.5: reattach after a restart. The fresh client
    /// (connected to the successor supervisor) replaces the dead one; the
    /// attach goes by DURABLE session id, so the slice-5 queued-attach
    /// contract absorbs any restore still in flight (the §10.3 hello's
    /// `update_resume.complete` is surfaced as a banner line). The
    /// transcript rebuilds from the attach snapshot - the same machinery
    /// `/switch` uses - and the recovery's row lands after it.
    ///
    /// `kind` names the driver that owns the recovery: the update restart
    /// paints its §10.5 banner, while a lost or announced-shutdown window
    /// (TS #2458) reports the restart version-honestly instead.
    pub(crate) async fn reattach_after_recovery(
        &mut self,
        client: DaemonClient,
        view: &mut AgentView,
        kind: RecoveryKind,
    ) -> Result<ReattachOutcome> {
        // One reattach attempt's budget (§10.4: a queued attach can
        // legitimately wait out a slow restore — the budget's expiry is a
        // RETRY outcome, never a fatal one). The bound lives INSIDE this
        // function — a caller-side timeout would cancel this future
        // mid-attach and skip the failure-path `close()` below, leaking
        // the half-installed client's supervisor connection and reader.
        const REATTACH_BUDGET: Duration = Duration::from_secs(30);
        let hello_resume = client
            .hello()
            .get("updateResume")
            .cloned()
            .unwrap_or(Value::Null);
        let complete = hello_resume.get("complete").and_then(Value::as_bool);
        let update_id = hello_resume
            .get("updateId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.client = client;
        let durable = self.session_id.clone();
        if durable.is_empty() {
            // A failed reattach must not leave the half-installed client
            // (its supervisor connection and reader task) running for the
            // process's lifetime: close it, and the reconnect driver
            // installs a fresh one on its next attempt.
            self.client.hard_close();
            anyhow::bail!("the session's durable id is unknown; cannot reattach");
        }
        let attach = tokio::time::timeout(
            REATTACH_BUDGET,
            self.attach_session(&durable, DockFold::Held),
        )
        .await;
        match attach {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                // A failed reattach must not leave the half-installed
                // client (its supervisor connection and reader task)
                // running: dispose it outright (the writer drops, the
                // socket shuts down, the reader EOFs), and the reconnect
                // driver installs a fresh one on its next attempt.
                self.client.hard_close();
                let what = match kind {
                    RecoveryKind::Update => "after the update",
                    RecoveryKind::Lost | RecoveryKind::Shutdown => "after the restart",
                };
                return Err(error.context(format!("reattaching session {durable} {what}")));
            }
            Err(_) => {
                // A wedged attach outlived the budget (§10.4: a queued
                // attach can legitimately wait out a slow restore): same
                // disposal, but the expiry is a RETRY outcome — the
                // driver's next attempt owns the recovery, never a fatal
                // exit.
                self.client.hard_close();
                return Ok(ReattachOutcome::AttachBudgetExceeded);
            }
        }
        // Flush the attach snapshot BEFORE the banner lands: `rebuild_view`
        // replaces the transcript from the snapshot, so the banner must come
        // after it to survive the rebuild (§10.5's visible end state).
        self.rebuild_view(view, &RebuildKind::Resync);
        match kind {
            RecoveryKind::Update => match complete {
                Some(false) => view.push_entry(crate::chat::ChatEntry::Status {
                    text: "Reconnected — the daemon is finishing its restore; queued work resumes when the session comes up.".to_string(),
                    kind: crate::chat::StatusKind::Info,
                }),
                _ => view.push_entry(crate::chat::ChatEntry::Status {
                    text: format!(
                        "Reconnected to Prime Agent (update {update_id}) — your session and queued work resumed."
                    ),
                    kind: crate::chat::StatusKind::Info,
                }),
            },
            RecoveryKind::Lost | RecoveryKind::Shutdown => {
                // TS #2458 `formatDaemonReconnectBanner`: the recovered
                // window reports the restart version-honestly.
                let daemon_version = self
                    .client
                    .hello()
                    .get("appVersion")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let (text, status_kind) = crate::daemon_reconnect::reconnect_banner(
                    daemon_version.as_deref(),
                    env!("CARGO_PKG_VERSION"),
                );
                view.push_entry(crate::chat::ChatEntry::Status {
                    text,
                    kind: status_kind,
                });
            }
        }
        self.dirty = true;
        Ok(ReattachOutcome::Attached)
    }

    /// Detach the current session and attach `id`, rebuilding the transcript
    /// from the slim attach snapshot.
    ///
    /// The attach itself travels over a direct worker link when the
    /// supervisor issues a ticket (best effort: every failure keeps the
    /// supervisor-routed path, and a failed direct attach retries once over
    /// the supervisor).
    ///
    /// The NEW attach lands before the old id detaches: a failed re-attach
    /// (a replacement mid-teardown, a dead worker) must not strand the pane
    /// locally bound but server-detached - the previous subscription stays
    /// until the new one exists, and the next supersede notice or the
    /// submit-path retry re-attaches when a worker can serve the session.
    pub(crate) async fn attach_session(
        &mut self,
        active_session_id: &str,
        dock_fold: DockFold,
    ) -> Result<()> {
        let previous = self.active_session_id.clone();
        // A direct link is bound to one session: drop it when switching.
        if self
            .client
            .direct_session_id()
            .is_some_and(|direct| direct != active_session_id)
        {
            self.client.drop_direct();
        }
        // The primary interactive connection sends its Herdr pane identity
        // with attach so an env-less session (e.g. cron-created) can adopt
        // it (adopt-if-absent, never rebind — the daemon owns that rule);
        // a client outside a Herdr pane sends nothing (the wire keeps its
        // tip shape).
        let client_env = {
            let env =
                pa_types::daemon::herdr_env::collect_client_env(|key| std::env::var(key).ok());
            (!env.is_empty()).then_some(env)
        };
        let attach_command = |session_id: &str| DaemonCommand::Attach {
            id: None,
            active_session_id: session_id.to_string(),
            client_id: None,
            // `elide_snapshot_images`: the transcript arrives without the
            // base64 image payloads (their fallback-only metadata rows
            // ride the marker), so an image-heavy session's attach stops
            // transferring megabytes the rows never render.
            capabilities: Some(vec![
                "attach_snapshot".to_string(),
                "event_sequence".to_string(),
                "slim_attach".to_string(),
                "elide_snapshot_images".to_string(),
            ]),
            resume_cursor: None,
            telemetry_disabled: self.telemetry_disabled.filter(|disabled| *disabled),
            recovery_config: None,
            env: client_env.clone(),
            launch_env: None,
            rest: Map::default(),
        };
        let direct_attached = self
            .client
            .upgrade_direct(active_session_id)
            .await
            .unwrap_or(false);
        let attached = match self
            .client
            .request_ok(attach_command(active_session_id))
            .await
        {
            Ok(data) => data,
            Err(error) => {
                if !direct_attached {
                    return Err(error);
                }
                // The direct attach failed: one supervisor-routed retry
                // (TS `DaemonAgentConnection.attach` fallback).
                self.client.drop_direct();
                self.client
                    .request_ok(attach_command(active_session_id))
                    .await?
            }
        };
        let data = attached;
        let attach = attach_data_from_response(data)?;
        // The bash slot follows the attached session's live state (TS
        // `applyConnectionStateSnapshot` patches `isBashRunning`): the
        // captured state drives the next rebuild's resync edge. The
        // mounted card id survives the patch (TS keeps
        // `activeBashComponent` tracked) — the rebuild's kind decides
        // its fate.
        let state = attach.snapshot.get("state");
        let resync_bash = ResyncBash {
            was_running: self.user_bash_running,
            snap_running: state
                .and_then(|state| state.get("isBashRunning"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            snap_streaming: state
                .and_then(|state| state.get("isStreaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        self.user_bash_running = resync_bash.snap_running;
        self.resync_bash = Some(resync_bash);
        let reconstructed = reconstruct(&attach);
        let mounted_session_changes = previous != attach.active_session_id;
        self.active_session_id = attach.active_session_id;
        // The new attachment exists (the snapshot above rebuilt from it):
        // retire the superseded id's subscription now, addressed by the
        // captured previous id (the detach must target the OLD address,
        // not the id the pane just adopted).
        if !previous.is_empty() && previous != self.active_session_id {
            let _ = self
                .bounded_request(
                    Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                    DaemonCommand::Detach {
                        id: None,
                        active_session_id: Some(previous),
                        rest: Map::default(),
                    },
                )
                .await;
        }
        self.session_id = reconstructed.session_id;
        self.attach_event_generation
            .clone_from(&reconstructed.event_generation);
        self.attach_event_sequence = reconstructed.last_event_sequence;
        // The live tracker starts at the attach's value (the replayed
        // events' sequences converge onto it by the monotonic max); the
        // cursor-presence gate keeps a cursor-less attach from stashing
        // a handoff under collapsed default key values.
        self.last_event_sequence = reconstructed.last_event_sequence;
        self.attach_cursor_present = reconstructed.cursor_present;
        // The closing notice is per-connection (TS #2458: it clears on
        // every attach): a later bare session stop must not route into a
        // stale shutdown recovery's reconnect hang.
        self.daemon_closing_notice = None;
        self.session_name.clone_from(&reconstructed.session_name);
        self.service_tier.clone_from(&reconstructed.service_tier);
        self.session_file = attach
            .snapshot
            .get("state")
            .and_then(|state| state.get("sessionFile"))
            .and_then(Value::as_str)
            .filter(|file| !file.is_empty())
            .map(str::to_string);
        // The subagent summary follows the fresh session's family: the old
        // roster belongs to the previous session, and the focus returns to
        // the editor (TS `resetSubagentSummary` on rebind).
        self.roster.clear();
        self.subagents_focused = false;
        self.subscribe_roster().await;
        // The dock's heartbeat rows follow `dock_fold` (the enum's
        // contract): a first-content-frame attach folds the fresh fetch
        // BEFORE the attach returns — the first content frame reads the
        // final counts, never a late repaint (the operator's
        // 2026-09-26 zero-shift ruling). TS guarantees the same for its
        // dock: the counts seed from the attach snapshot
        // (`seedSubagentSummary`) and the roster subscription is
        // awaited before the first content render; TS's own heartbeat
        // fetch stays fire-and-forget only because its summary line
        // renders no heartbeat rows.
        match dock_fold {
            DockFold::FirstFrame | DockFold::Fresh => self.heartbeat_catalog.clear(),
            // The held dock keeps its data: an already-up surface's dock
            // must not flicker away while the background refresh runs.
            DockFold::Held => {}
        }
        match dock_fold {
            DockFold::FirstFrame => self.fetch_heartbeat_catalog().await,
            DockFold::Fresh | DockFold::Held => self.spawn_heartbeat_refresh(),
        }
        // The slash-command catalog is session-scoped too (TS
        // `refreshConnectionCatalog` fetches `get_commands` on every
        // rebind): the skill commands land in the autocomplete provider
        // when the response arrives.
        self.spawn_command_catalog_refresh();
        // The dock's bash rows follow the same `dock_fold` contract; the
        // capability gate matches the background refresh (older daemons
        // never see the request), and a failed fold fetch leaves the
        // cleared registry (the 2s poll refills).
        match dock_fold {
            DockFold::FirstFrame | DockFold::Fresh => {
                self.bash_activities = serde_json::json!({"activities": []});
                // The factory lane's cache dies with the previous
                // session too: the dock count and the page mount must
                // never show another session's runs (the 2s poll
                // refills; the spawn below asks for the first frame).
                self.factory_graph = serde_json::json!({"runs": []});
            }
            // The held dock keeps its registry for the same reason it
            // keeps the heartbeat catalog above.
            DockFold::Held => {}
        }
        self.activity_group = crate::chrome::ActivityGroup::Subagents;
        match dock_fold {
            DockFold::FirstFrame => self.fetch_bash_activities().await,
            DockFold::Fresh | DockFold::Held => self.spawn_bash_activity_refresh(),
        }
        // The refilled factory cache is a background refresh away on
        // every fold (the poll's serialization makes an immediate
        // request safe — the in-flight slot frees on its own cycle).
        self.spawn_factory_refresh();
        self.pending_model = reconstructed.model_id;
        self.pending_model_provider = reconstructed.model_provider;
        self.pending_thinking_suffix = reconstructed.thinking_suffix;
        self.last_assistant_text = reconstructed
            .chat
            .iter()
            .rev()
            .find_map(|entry| match entry {
                ChatEntry::Assistant(message) => {
                    message.blocks.iter().rev().find_map(|block| match block {
                        MessageBlock::Text(text) => Some(text.clone()),
                        MessageBlock::Thinking(_) => None,
                    })
                }
                _ => None,
            });
        self.pending_queue = Some(reconstructed.queued);
        self.pending_snapshot = Some(reconstructed.chat);
        self.loader_anchor_ms = reconstructed.last_user_prompt_ms;
        self.goal_view.seed(reconstructed.goal.unwrap_or_default());
        // The resynced state owns the loader (TS `renderResyncedSession`
        // rebuilds from the snapshot): a turn that is still live behind the
        // re-attach keeps the spinner, one that died with the old link (or
        // never ran) does not.
        let streaming = attach.snapshot.get("state").is_some_and(|state| {
            ["isStreaming", "isCompacting"]
                .iter()
                .any(|flag| state.get(flag).and_then(Value::as_bool).unwrap_or(false))
        });
        self.turn_active = streaming;
        self.streaming_index = None;
        // The turn-end watermark restarts only when the mounted session
        // CHANGES: the ends the new stream will see belong to the newly
        // mounted session, and an end owed by the detached session's stream
        // (a turn whose submit outlived the switch — the daemon keeps
        // running it, and its end never arrives on this stream) must not
        // pin the watermark. Without the reset a later prompt's ack would
        // re-arm `turn_active` against an end count that can never catch
        // up, and the idle gates would wait for an end that will never
        // come (the submit-outlived wedge). A SAME-SESSION rebind
        // (recovery, reconnect) keeps the counters: its stream counts ends
        // for the same session, and a prompt note that straddled the
        // recovery still carries comparable values — resetting there would
        // orphan in-flight acks the same way (a turn that already ended
        // before the idle snapshot would re-arm `turn_active` with no
        // `TurnEnded` left to clear it). The mounted snapshot's
        // `streaming` flag carries the live-turn state across the attach.
        if mounted_session_changes {
            self.turn_ends_seen = 0;
            self.last_prompt_turn_end = 0;
        }
        // TS `applyConnectionStateSnapshot` -> `bindPromptStashSession`: the
        // stash state follows the stable id of the session now rendered.
        // The initial attach and every in-place switch (`/switch`, `/new`)
        // rebind through here; a rebind hydrates the session's stashed
        // images into the paste registry.
        let stash_session_id = self.session_id.clone();
        self.bind_prompt_stash_session(&stash_session_id);
        // The attach fold held the wire frame, its decoded tree, and the
        // folded transcript together; the frame and tree drop here, so
        // return their freed heap to the OS instead of keeping the load's
        // peak resident for the TUI's lifetime.
        pa_types::memory_release::trim_freed_heap();
        // The rebuild's first frame materializes the visible window —
        // its wrap/render churn is the TUI's own transient on top of the
        // fold's; arm the post-frame trim so that churn returns too
        // instead of riding the arenas for the process lifetime.
        self.trim_after_frame = true;
        Ok(())
    }

    /// The instant a rebuilt loader anchors at, from the LAST HUMAN
    /// PROMPT's wall-clock time (unix ms). The operator's 2026-09-28
    /// rule: the waiting/executing timer never resets on a view
    /// transition — it counts since the prompt that started the live
    /// turn, however long ago that was. TS
    /// `restoreTurnStartFromMessages` anchors at the run-start
    /// message's timestamp the same way, with no plausibility cap: a
    /// placeholder-era timestamp anchors at its own wall time and the
    /// elapsed reads the wire's garbage (TS clamps only the negative
    /// display at `formatWorkingElapsed`). Only a FUTURE timestamp
    /// keeps the re-attach-instant anchor.
    pub(super) fn loader_anchor_instant(prompt_ms: u64) -> Option<std::time::Instant> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or_default();
        let age = now_ms.checked_sub(prompt_ms)?;
        std::time::Instant::now().checked_sub(std::time::Duration::from_millis(age))
    }

    /// Fold the pending snapshot into the view (fresh transcript, footer
    /// labels). Called after attach and after every session switch.
    pub(crate) fn rebuild_view(&mut self, view: &mut AgentView, kind: &RebuildKind) {
        let resync_bash = self.resync_bash.take();
        // The held cards' fate diverges by rebuild: a rebind drops them
        // with the old transcript (TS `resetCurrentSessionRenderState`), a
        // resync keeps them mounted above the indicator (TS
        // `renderResyncedSession` re-attaches `pendingBashComponents`).
        let held_bash = matches!(kind, RebuildKind::Resync)
            .then(|| std::mem::take(&mut view.pending_bash))
            .unwrap_or_default();
        // A rebind replaces the whole view: the previous session's open
        // bash view dies with its transcript instead of owning keys over
        // the new session's registry. Sessions are independent (TS
        // `rebindCurrentSession`): a rebind also restarts the tok/sec
        // stats and clears the readout left over from the previous session.
        if matches!(kind, RebuildKind::Rebind) {
            view.bash_view = None;
            // The factory view dies the same death — it snapshots the
            // previous session's kernel runs, and its refresh lane must
            // not keep polling the new session's kernel for a view
            // nobody mounted — but ONLY when a different session actually
            // took the view's place. A same-session rebind (the `Unknown
            // active session` reattach in `prompt.rs` replays over the
            // same durable session) keeps the view mounted: the user
            // neither switched sessions nor closed the view, and its
            // refresh lane re-targets the reattached session's kernel on
            // the next tick.
            // The page dies only when it was mounted under a DIFFERENT
            // session: a same-session rebind (the `Unknown active session`
            // reattach) keeps the page and its count — the kernel and its
            // runs did not change. A page that was never mounted owns no
            // state here; the attach fold owns the cache's cross-session
            // reset (every rebind path attaches first, so a switch's
            // stale cache is cleared before the rebuild lands).
            if self
                .factory_view_session
                .as_deref()
                .is_some_and(|session| session != self.session_id)
            {
                view.factory_view = None;
                self.factory_selected_run = None;
                self.factory_view_session = None;
                self.factory_graph = serde_json::json!({"runs": []});
            }
            // The goal panel dies with the old session too: it is a
            // snapshot of the previous session's goal state, and until
            // the new session's own `goal_update` lands it would keep
            // owning the frame over the rebind with stale content.
            view.goal_panel = None;
            // The read-only info panel dies the same death: it holds the
            // previous session's fetched document, and a stale panel
            // would keep consuming keys over the new session.
            view.info_panel = None;
            self.speed_stats = None;
            view.chrome.speed_text = None;
        }
        view.clear_chat();
        // The rebuilt transcript invalidates the tracked status row and
        // a pending click's entry index.
        self.last_status_index = None;
        self.pressed_click = None;
        // The rebuild drops the previous run's pending-tool map (TS
        // `resetPendingToolState` at the rebuild boundary).
        self.pending_tools.clear();
        self.aborted_tools.clear();
        if let Some(items) = self.pending_snapshot.take() {
            for entry in items {
                view.push_entry(entry);
            }
        }
        // The rebuild re-registers the live tool cards the way TS
        // `restoreStreamingMessageFromSnapshot` does (the resumed turn's
        // streamed calls re-enter the pending map): a post-reconnect
        // failure frame can still settle them. Settled cards (a final
        // result attached) stay out.
        for entry in &view.chat {
            if let ChatEntry::Tool(card) = entry {
                if card.result.is_none() || card.result_partial {
                    self.pending_tools.insert(card.id.clone());
                }
            }
        }
        if let Some(model) = self.pending_model.take() {
            view.chrome.model_id = Some(model);
            view.chrome.model_provider = self.pending_model_provider.take();
        }
        // The tray badge mirrors the session-scoped tier on every rebuild:
        // an attach that reports no tier clears the previous session's
        // badge instead of leaving it stranded (the rebuild is where the
        // chrome fields re-sync from the reconstructed session).
        view.chrome.service_tier.clone_from(&self.service_tier);
        // The tray's effort suffix moves with the same snapshot: an
        // attach's state either carries the session's level or reports a
        // model without reasoning, and the bare name wins in both cases.
        view.chrome.thinking_suffix = self.pending_thinking_suffix.take();
        view.queued = self.pending_queue.take().unwrap_or_default();
        // A rebuilt view starts from the snapshot's queue: any browse
        // selection belonged to the previous queue and drops (TS
        // `resetCurrentSessionRenderState` clears the selection).
        let _ = self.queue_selection.reset();
        view.queue_selected = None;
        view.chrome.chat_name = self.session_display();
        view.chrome.context = self.context;
        self.update_subagent_summary(view);
        // The rebuilt transcript invalidates the announcement row tracking;
        // the goal state itself carries over (seeded at attach).
        self.goal_view.reset_row_tracking();
        self.sync_goal_tray(view);
        self.sync_activity_dock(view);
        view.pending_bash = held_bash;
        // The rebuild decides the mounted card's fate: a rebind drops it
        // with the old transcript (TS `resetCurrentSessionRenderState`
        // settles it cancelled and clears the hold — invisible after the
        // clear), a resync runs the `renderResyncedSession` bashFinished
        // edge: a run that ended behind the dead link settles its card
        // with an unknown exit, flushes the hold when no turn is live,
        // and releases the pane's side run (its bash_end never arrives —
        // a transient run is not in the snapshot).
        match kind {
            RebuildKind::Rebind => {
                self.user_bash_card = None;
                self.user_bash_started_at = None;
            }
            RebuildKind::Resync => {
                if let Some(resync) = resync_bash {
                    let bash_finished = resync.was_running && !resync.snap_running;
                    if bash_finished {
                        if let Some(card_id) = self.user_bash_card.take() {
                            if let Some(index) = view.chat.iter().position(|entry| {
                                matches!(entry, ChatEntry::BashExecution(card) if card.id == card_id)
                            }) {
                                if let Some(ChatEntry::BashExecution(card)) =
                                    view.chat.get_mut(index)
                                {
                                    card.set_complete(None, false, false, None);
                                }
                                view.mark_entry_stale(index);
                            } else if let Some(card) = view
                                .pending_bash
                                .iter_mut()
                                .find(|card| card.id == card_id)
                            {
                                card.set_complete(None, false, false, None);
                            }
                            self.user_bash_started_at = None;
                            // TS flushes inside the active-component branch:
                            // a side run (no mounted card) never flushes.
                            if !resync.snap_streaming {
                                Self::flush_pending_bash(view);
                            }
                        }
                        if self.side_bash.take().is_some() {
                            if let Some(pane) = view.side_pane.as_mut() {
                                if let Some(bash) = pane.bash.as_mut() {
                                    bash.running = false;
                                }
                            }
                        }
                        self.side_bash_discarded = None;
                    }
                }
            }
        }
        // The rebuilt chat follows the session's live state: an attached
        // turn that survived the re-attach keeps its loader (TS
        // `renderResyncedSession`), and no stale loader survives a rebuild.
        // The re-mounted loader anchors at the LAST HUMAN PROMPT (the
        // operator's 2026-09-28 rule: the waiting/executing timer never
        // resets on a view transition — an agents-view round trip
        // re-attaches mid-turn and the clock keeps counting from the
        // prompt that started the turn), so the elapsed readout picks up
        // where it left off instead of restarting at the re-attach
        // instant. The live paths (a submit's ack, a turn's engine
        // start) keep their own anchors; only the rebuild re-derives one.
        if self.turn_active {
            let anchor = self
                .loader_anchor_ms
                .and_then(Self::loader_anchor_instant)
                .unwrap_or_else(std::time::Instant::now);
            self.start_loader_at(view, anchor);
        } else {
            view.working = None;
        }
        view.follow();
        // An open `/heartbeats` picker follows the rebuilt session's
        // catalog (the channel fold's `apply_catalog` path): without this
        // a rebind leaves the picker showing the previous session's rows
        // and its Manage actions target stale jobs.
        if let Some(picker) = view.heartbeats_picker.as_mut() {
            picker.apply_catalog(self.heartbeat_catalog.clone(), None);
        }
        // The brand splash is the EMPTY chat's header (TS mounts
        // `BrandSplashHeader` in `ui.start()`): a rebuild that folds a
        // non-empty transcript suppresses it — the chat opened or
        // switched directly into content, where TS's own direct opens
        // attach before mount and the tail-anchored viewport scrolls the
        // splash out of reach — while every rebuild into an empty chat
        // keeps it (a new session shows its header; the incremental
        // first-turn growth never passes through here, so a new chat's
        // splash scrolls away exactly like TS).
        view.splash_suppressed = !view.chat.is_empty();
        self.dirty = true;
    }

    /// Refresh context usage from `get_session_stats` (the TS tray's
    /// connection refresh): tokens, context window, and percent. The
    /// title's spend never comes from here — the roster pushes that
    /// `update_subagent_summary` folds keep it live.
    pub(crate) async fn refresh_stats(&mut self) {
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionStats {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        else {
            return;
        };
        // TS `patchConnectionState` REPLACES the context usage snapshot:
        // unknown usage (tokens null right after a compaction, or a
        // response without the field) clears the tray display instead of
        // keeping the stale one.
        self.context = data.get("contextUsage").and_then(|usage| {
            let tokens = usage.get("tokens").and_then(Value::as_u64)?;
            let window = usage.get("contextWindow").and_then(Value::as_u64)?;
            Some(crate::chrome::ContextUsage {
                tokens,
                context_window: window,
            })
        });
        self.dirty = true;
    }

    /// Detach on the agents-view handoff without blocking it: the request
    /// goes on the wire immediately and a background task owns the
    /// connection until the daemon answers (or the exit cap fires), then
    /// closes it. Attached-client bookkeeping must not delay the switch;
    /// the supervisor also detaches this client when the socket closes, so
    /// the response is not a handoff dependency.
    pub(crate) fn detach_for_handoff(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_millis(EXIT_DETACH_TIMEOUT_MS),
                client.request_ok(DaemonCommand::Detach {
                    id: None,
                    active_session_id: Some(active_session_id),
                    rest: Map::default(),
                }),
            )
            .await;
            client.close();
        });
    }

    /// Detach during the exit path, bounded hard: a wedged worker socket can
    /// never hold the client open (the exit contract is exit-within-1s even
    /// then, so this must stay well under the bound).
    pub(crate) async fn detach_for_exit(&self) {
        let _ = tokio::time::timeout(
            Duration::from_millis(EXIT_DETACH_TIMEOUT_MS),
            self.client.request_ok(DaemonCommand::Detach {
                id: None,
                active_session_id: Some(self.active_session_id.clone()),
                rest: Map::default(),
            }),
        )
        .await;
    }

    /// Fetch the exit resume hint (TS `shutdown` fetches `getSessionStats`
    /// while the connection is alive, then prints `formatResumeHint` after
    /// teardown). Bounded best-effort: a wedged worker or a dead connection
    /// yields no hint instead of holding the exit open.
    pub(crate) async fn exit_resume_hint(&self) -> Option<String> {
        let stats = tokio::time::timeout(
            Duration::from_millis(EXIT_STATS_TIMEOUT_MS),
            self.client.request_ok(DaemonCommand::GetSessionStats {
                id: None,
                active_session_id: self.active_session_id.clone(),
                rest: Map::default(),
            }),
        )
        .await;
        resume_hint_from_stats(&stats.ok()?.ok()?)
    }
}
