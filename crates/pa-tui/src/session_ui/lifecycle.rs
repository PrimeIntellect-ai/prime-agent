//! The open/attach/reattach pipeline (the session selection's open, the
//! §10 reattach, the attach fold, and the transcript rebuild it feeds),
//! the stats refresh, and the detach/exit request helpers.
use super::{
    attach_capabilities, attach_data_from_response, create_session, last_assistant_text_of, mpsc,
    reconstruct, resume_hint_from_stats, ActivityUpdates, AgentView, BTreeMap, ChatEntry,
    CompactionAbortNote, Context, DaemonClient, DaemonCommand, DockFold, Duration, GoalView,
    HashSet, InteractiveOptions, LoaderTokenTracker, Map, ModelCatalogUpdate, PromptOrder,
    PromptSubmitNote, ReattachOutcome, RebuildKind, RecoveryKind, ReloadNote, Result, ResyncBash,
    SessionSelection, SessionUi, ShareNote, TranscriptBackfillNote, UpdateNote, Value,
    EXIT_DETACH_TIMEOUT_MS, EXIT_STATS_TIMEOUT_MS, UI_REQUEST_TIMEOUT_MS,
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
        backfill_notes: mpsc::UnboundedSender<TranscriptBackfillNote>,
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
        // The single prompt-submit worker (see [`PromptOrder`]) lives with the orders channel: the
        // session drops its sender, so the task never outlives the run.
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
            transcript_epoch: 0,
            transcript_backfill: None,
            pending_backfill: None,
            backfill_notes,
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
        // The scope-back reopen's restore lands AFTER the attach: the attach's rebind reset clears
        // the focus, so the reopen's own restore must survive it.
        session.subagents_focused = options.restore_dock_focus;
        Ok(session)
    }

    /// Spec §10.2-§10.5: reattach after a restart — the fresh client replaces the dead one, the
    /// attach goes by DURABLE session id. `kind` names the driver: the update restart paints its
    /// §10.5 banner, a lost or announced-shutdown window reports the restart version-honestly.
    pub(crate) async fn reattach_after_recovery(
        &mut self,
        client: DaemonClient,
        view: &mut AgentView,
        kind: RecoveryKind,
    ) -> Result<ReattachOutcome> {
        // One reattach attempt's budget (§10.4: expiry is a RETRY outcome, never fatal). The bound
        // lives INSIDE this function — a caller-side timeout would cancel this future mid-attach
        // and skip the failure-path `close()`, leaking the half-installed client's connection.
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
            // A failed reattach must not leave the half-installed client running:
            // close it; the reconnect driver installs a fresh one on its next attempt.
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
                // Same disposal: the reconnect driver installs a fresh one next attempt.
                self.client.hard_close();
                let what = match kind {
                    RecoveryKind::Update => "after the update",
                    RecoveryKind::Lost | RecoveryKind::Shutdown => "after the restart",
                };
                return Err(error.context(format!("reattaching session {durable} {what}")));
            }
            Err(_) => {
                // A wedged attach outlived the budget (§10.4): the expiry is a RETRY
                // outcome — the driver's next attempt owns the recovery.
                self.client.hard_close();
                return Ok(ReattachOutcome::AttachBudgetExceeded);
            }
        }
        // Flush the attach snapshot BEFORE the banner lands: `rebuild_view` replaces the transcript
        // from the snapshot, so the banner must come after it to survive the rebuild.
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
                // TS `formatDaemonReconnectBanner`: the recovered window reports the restart
                // version-honestly.
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

    /// Detach the current session and attach `id`, rebuilding the transcript from the slim attach
    /// snapshot; a direct worker link serves the attach when the supervisor issues a ticket (a
    /// failed direct attach retries once over the supervisor). The NEW attach lands before the old
    /// id detaches: a failed re-attach must not strand the pane locally bound but server-detached.
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
            // `elide_snapshot_images`: the transcript arrives without the base64 image payloads, so
            // an image-heavy session's attach stops transferring megabytes.
            capabilities: Some(attach_capabilities()),
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
                self.client.drop_direct();
                self.client
                    .request_ok(attach_command(active_session_id))
                    .await?
            }
        };
        let data = attached;
        let attach = attach_data_from_response(data)?;
        // The bash slot follows the attached session's live state: the captured
        // state drives the next rebuild's resync edge.
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
        // Retire the superseded id's subscription now, addressed by the captured previous id (the
        // detach must target the OLD address, not the newly adopted one).
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
        // The live tracker starts at the attach's value; the cursor-presence gate
        // keeps a cursor-less attach from stashing a handoff.
        self.last_event_sequence = reconstructed.last_event_sequence;
        self.attach_cursor_present = reconstructed.cursor_present;
        // The closing notice is per-connection: it clears on every attach, so a later bare session
        // stop must not route into a stale shutdown recovery's reconnect hang.
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
        // The subagent summary follows the fresh session's family; the focus
        // returns to the editor.
        self.roster.clear();
        self.subagents_focused = false;
        self.subscribe_roster().await;
        // The dock's heartbeat rows follow `dock_fold`: a first-content-frame attach folds the
        // fresh fetch BEFORE the attach returns (the operator's 2026-09-26 zero-shift ruling).
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
        // The slash-command catalog is session-scoped too; the skill commands
        // land in the autocomplete provider when the response arrives.
        self.spawn_command_catalog_refresh();
        // The dock's bash rows follow the same `dock_fold` contract; a failed fold
        // fetch leaves the cleared registry (the 2s poll refills).
        match dock_fold {
            DockFold::FirstFrame | DockFold::Fresh => {
                self.bash_activities = serde_json::json!({"activities": []});
                // The factory lane's cache dies with the previous
                // session too: the dock count and the page mount must
                // never show another session's runs (the 2s poll
                // refills; the spawn below asks for the first frame).
                self.factory_graph = serde_json::json!({"runs": []});
            }
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
        // The tray's context usage follows the attach snapshot (TS
        // `createAgentConnectionState` carries `contextUsage`, and TS's
        // open path never blocks its first frame on a `getSessionStats`
        // fetch — `refreshConnectionContextUsage` runs only after a turn
        // or compaction settles): the rebuild below re-syncs it into the
        // chrome exactly like the other reconstructed session fields.
        self.context = reconstructed.context_usage;
        self.last_assistant_text = last_assistant_text_of(&reconstructed.chat);
        self.pending_queue = Some(reconstructed.queued);
        self.pending_snapshot = Some(reconstructed.chat);
        self.loader_anchor_ms = reconstructed.last_user_prompt_ms;
        self.goal_view.seed(reconstructed.goal.unwrap_or_default());
        // The resynced state owns the loader: a turn still live behind the
        // re-attach keeps the spinner, one that died with the old link does not.
        let streaming = attach.snapshot.get("state").is_some_and(|state| {
            ["isStreaming", "isCompacting"]
                .iter()
                .any(|flag| state.get(flag).and_then(Value::as_bool).unwrap_or(false))
        });
        self.turn_active = streaming;
        self.streaming_index = None;
        // The turn-end watermark restarts only when the mounted session CHANGES: an end owed by the
        // detached session's stream must not pin the watermark (without the reset a later prompt's
        // ack would re-arm `turn_active` against an end count that can never catch up); a
        // SAME-SESSION rebind keeps the counters, or in-flight acks orphan the same way.
        if mounted_session_changes {
            self.turn_ends_seen = 0;
            self.last_prompt_turn_end = 0;
        }
        // The stash state follows the stable id of the session now rendered: the initial attach and
        // every in-place switch rebind through here.
        let stash_session_id = self.session_id.clone();
        self.bind_prompt_stash_session(&stash_session_id);
        // The attach fold's wire frame and decoded tree drop here: return their freed heap to the
        // OS instead of keeping the load's peak resident for the TUI's lifetime.
        pa_types::memory_release::trim_freed_heap();
        // The rebuild's first frame materializes the visible window; arm the
        // post-frame trim so its wrap/render churn returns too.
        self.trim_after_frame = true;
        self.transcript_epoch = self.transcript_epoch.wrapping_add(1);
        self.transcript_backfill = None;
        self.pending_backfill =
            Some(reconstructed.history_before).filter(|history_before| *history_before > 0);
        Ok(())
    }

    /// The instant a rebuilt loader anchors at, from the LAST HUMAN PROMPT's wall-clock time
    /// (operator's 2026-09-28 rule: the timer never resets on a view transition). Like TS
    /// `restoreTurnStartFromMessages`, no plausibility cap: only a FUTURE timestamp keeps the
    /// re-attach-instant anchor.
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
        // The held cards' fate diverges by rebuild: a rebind drops them with the
        // old transcript, a resync keeps them mounted above the indicator.
        let held_bash = matches!(kind, RebuildKind::Resync)
            .then(|| std::mem::take(&mut view.pending_bash))
            .unwrap_or_default();
        // A rebind replaces the whole view: the previous session's open bash view
        // dies with its transcript, and the tok/sec stats restart per session.
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
            view.info_panel = None;
            self.speed_stats = None;
            view.chrome.speed_text = None;
        }
        view.clear_chat();
        self.last_status_index = None;
        self.pressed_click = None;
        self.pending_tools.clear();
        self.aborted_tools.clear();
        if let Some(items) = self.pending_snapshot.take() {
            for entry in items {
                view.push_entry(entry);
            }
        }
        // The rebuild re-registers the live tool cards (the resumed turn's streamed calls re-enter
        // the pending map): a post-reconnect failure frame can still settle them.
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
        // The tray badge mirrors the session-scoped tier on every rebuild: an
        // attach that reports no tier clears the previous session's badge.
        view.chrome.service_tier.clone_from(&self.service_tier);
        // The tray's effort suffix moves with the same snapshot; the bare name
        // wins when the state reports neither.
        view.chrome.thinking_suffix = self.pending_thinking_suffix.take();
        view.queued = self.pending_queue.take().unwrap_or_default();
        // Any browse selection belonged to the previous queue and drops.
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
        // The rebuild decides the mounted card's fate: a rebind drops it with the old transcript; a
        // resync runs the bashFinished edge — a run that ended behind the dead link settles its
        // card with an unknown exit.
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
        // An attached turn that survived the re-attach keeps its loader; the re-mounted loader
        // anchors at the LAST HUMAN PROMPT (the operator's 2026-09-28 rule).
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
        // An open `/heartbeats` picker follows the rebuilt session's catalog — otherwise a rebind
        // leaves it showing the previous session's rows.
        if let Some(picker) = view.heartbeats_picker.as_mut() {
            picker.apply_catalog(self.heartbeat_catalog.clone(), None);
        }
        // The brand splash is the EMPTY chat's header: a rebuild that folds a non-empty transcript
        // suppresses it, every rebuild into an empty chat keeps it.
        view.splash_suppressed = !view.chat.is_empty();
        self.dirty = true;
    }

    /// Refresh context usage from `get_session_stats`: tokens, context window,
    /// and percent. The title's spend comes from the roster pushes instead.
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
        // Unknown usage (tokens null right after a compaction, or a
        // response without the field) clears the tray display.
        self.context = data
            .get("contextUsage")
            .and_then(crate::chrome::ContextUsage::from_wire);
        self.dirty = true;
    }

    /// Detach on the agents-view handoff without blocking it: a background task owns the connection
    /// until the daemon answers; the supervisor also detaches this client when the socket closes.
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

    /// Detach during the exit path, bounded hard: a wedged worker socket can never hold the client
    /// open (the exit contract is exit-within-1s even then, so this must stay well under the
    /// bound).
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

    /// Fetch the exit resume hint, bounded best-effort: a wedged worker or a
    /// dead connection yields no hint instead of holding the exit open.
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
