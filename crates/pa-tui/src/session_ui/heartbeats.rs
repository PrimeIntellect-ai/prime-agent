//! The heartbeats concern: the background catalog fetch and its update
//! fold, the `/heartbeats` manager view's keys and management requests.
use super::{
    key_event_to_id, parse_heartbeats, picker_viewport_rows, scope_heartbeats, sort_heartbeats,
    AgentView, DaemonCommand, Duration, HeartbeatAction, HeartbeatEntry, HeartbeatsPicker,
    HeartbeatsPickerAction, KeyEvent, Map, Result, SessionUi, Value, UI_REQUEST_TIMEOUT_MS,
};

/// A landed heartbeat-catalog refresh for the `/heartbeats` view (TS
/// `refreshHeartbeatCatalog`'s fetch result): the scoped, sorted rows, or
/// the fetch error that keeps the last catalog (stale-while-revalidate).
pub(crate) struct HeartbeatsUpdate {
    /// The refresh epoch this snapshot belongs to: a response older than
    /// the session's current epoch is stale and never overwrites a newer
    /// catalog.
    pub epoch: u64,
    pub heartbeats: Vec<HeartbeatEntry>,
    pub fetch_error: Option<String>,
}

impl SessionUi {
    /// One key press while the `/heartbeats` view is open: Esc/Ctrl+C/close
    /// binding close it; Enter on the list opens the selected heartbeat's
    /// action pane; Enter on an action runs the management request.
    pub(crate) async fn handle_heartbeats_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The view consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .heartbeats_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(HeartbeatsPickerAction::None) => {
                self.dirty = true;
            }
            Some(HeartbeatsPickerAction::Close) => {
                view.heartbeats_picker = None;
                // The exit restores the dock's own group (the operator's
                // 2026-09-26 panel-exit ruling): ESC/left lands back on
                // the Heartbeats item, ready to re-open, not on the
                // prompt bar.
                self.focus_activity_dock(view);
                self.dirty = true;
            }
            Some(HeartbeatsPickerAction::Manage {
                active_session_id,
                job_id,
                action,
            }) => {
                self.run_heartbeat_manage(active_session_id, job_id, action, view)
                    .await;
            }
            None => {}
        }
        Ok(())
    }

    /// Run one heartbeat management request (TS `manageHeartbeat` →
    /// `agentConnection.manageHeartbeat`): the daemon owns the job; the
    /// updated job (or the stop's removal) patches the open view locally,
    /// a background refresh reconciles the catalog, and a failure
    /// surfaces as the view's error row.
    async fn run_heartbeat_manage(
        &mut self,
        active_session_id: String,
        job_id: String,
        action: HeartbeatAction,
        view: &mut AgentView,
    ) {
        let request = DaemonCommand::HeartbeatManage {
            id: None,
            active_session_id,
            job_id,
            action: Value::String(action.as_wire().to_string()),
            rest: Map::default(),
        };
        match self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            Ok(data) => {
                // The daemon returns the updated job (a stop keeps the
                // cancelled row's identity); a patch that cannot parse still
                // leaves the actions pane, and the refresh reconciles.
                match data
                    .get("heartbeat")
                    .and_then(crate::heartbeats_picker::parse_heartbeat_job)
                {
                    Some(job) => {
                        let stopped = action == HeartbeatAction::Stop;
                        let job_id = job.id.clone();
                        if let Some(picker) = view.heartbeats_picker.as_mut() {
                            picker.apply_managed_job(job.clone(), stopped);
                        }
                        // The activity dock follows the same patch the
                        // manager view applied (TS `manageHeartbeat`
                        // rewrites the catalog entry, not just the open
                        // manager).
                        if stopped {
                            self.heartbeat_catalog
                                .retain(|entry| entry.job.id != job_id);
                        } else if let Some(entry) = self
                            .heartbeat_catalog
                            .iter_mut()
                            .find(|entry| entry.job.id == job_id)
                        {
                            entry.job = job;
                        }
                    }
                    None => {
                        if let Some(picker) = view.heartbeats_picker.as_mut() {
                            picker.back_to_list();
                        }
                    }
                }
                self.sync_activity_dock(view);
                self.spawn_heartbeat_refresh();
                self.dirty = true;
            }
            Err(error) => {
                if let Some(picker) = view.heartbeats_picker.as_mut() {
                    picker.set_action_error(format!("{error:#}"));
                }
                self.dirty = true;
            }
        }
    }

    /// Scope a fetched catalog to THIS session only (operator scoping:
    /// nested sessions' heartbeats do not surface in the dock, the
    /// panel, or the `/heartbeats` view — a sanctioned divergence from
    /// TS `scopeHeartbeatsToSession`, which also kept the RLM children's
    /// jobs; the child ids stay empty here).
    fn scope_heartbeats(&self, heartbeats: Vec<HeartbeatEntry>) -> Vec<HeartbeatEntry> {
        scope_heartbeats(
            heartbeats,
            (!self.active_session_id.is_empty()).then_some(self.active_session_id.as_str()),
            (!self.session_id.is_empty()).then_some(self.session_id.as_str()),
            &[],
        )
    }

    /// The open-time heartbeat-catalog fold: the first `heartbeats_list`
    /// response scopes and sorts into the catalog synchronously with the
    /// attach (bounded like every UI request), so the dock's heartbeat
    /// rows ride the first content frame instead of popping in late. A
    /// failed or timed-out fetch leaves the just-cleared catalog — the
    /// same empty-open state the background refresh's failure arm
    /// produces, and the next `heartbeats_changed` event refills.
    pub(crate) async fn fetch_heartbeat_catalog(&mut self) {
        // Advance the epoch so a refresh still in flight from before the
        // attach (a `heartbeats_changed` burst's spawned fetch) never
        // overwrites this fold with its older catalog: the epoch's
        // staleness check drops it at fold time.
        self.heartbeat_refresh_epoch += 1;
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::HeartbeatsList {
                    id: None,
                    active_session_id: None,
                    rest: Map::default(),
                },
            )
            .await
        else {
            return;
        };
        let mut heartbeats = self.scope_heartbeats(parse_heartbeats(&data));
        sort_heartbeats(&mut heartbeats);
        self.heartbeat_catalog = heartbeats;
    }

    /// Fire a background heartbeat-catalog refresh (TS
    /// `refreshHeartbeatCatalog`): the fetch lands through the run loop's
    /// channel into the open view; failures clear nothing — the next
    /// `heartbeats_changed` event retries. At most one refresh runs in
    /// flight with one queued trailing refresh (daemon-wide broadcasts can
    /// burst; stacked concurrent requests would load the supervisor), and
    /// every response carries the epoch it was issued under so a stale
    /// one never overwrites a newer catalog.
    pub(crate) fn spawn_heartbeat_refresh(&mut self) {
        if self.heartbeat_refresh_in_flight {
            self.heartbeat_refresh_queued = true;
            return;
        }
        self.heartbeat_refresh_in_flight = true;
        let updates = self.heartbeat_updates.clone();
        let client = self.client.clone();
        let epoch = self.heartbeat_refresh_epoch;
        tokio::spawn(async move {
            let request = DaemonCommand::HeartbeatsList {
                id: None,
                active_session_id: None,
                rest: Map::default(),
            };
            let fetched = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                client.request_ok(request),
            )
            .await;
            match fetched {
                Ok(Ok(data)) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        epoch,
                        heartbeats: parse_heartbeats(&data),
                        fetch_error: None,
                    });
                }
                Ok(Err(error)) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        epoch,
                        heartbeats: Vec::new(),
                        fetch_error: Some(format!("{error:#}")),
                    });
                }
                Err(_) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        epoch,
                        heartbeats: Vec::new(),
                        fetch_error: Some(
                            "timed out waiting for the Prime Agent daemon response".to_string(),
                        ),
                    });
                }
            }
        });
    }

    /// Fold a landed heartbeat-catalog refresh into the session: re-scope
    /// and re-sort, keep the open view's selection, surface the fetch
    /// error, and re-sync the activity dock (TS `applyHeartbeatCatalog` over
    /// both the manager and the tray's `getTrayHeartbeatLabel`).
    pub(crate) fn apply_heartbeat_update(
        &mut self,
        update: HeartbeatsUpdate,
        view: &mut AgentView,
    ) {
        // The refresh slot frees whether the response landed, failed, or
        // timed out; a burst's queued refresh runs next.
        self.heartbeat_refresh_in_flight = false;
        let queued = std::mem::take(&mut self.heartbeat_refresh_queued);
        // A response from an older refresh never overwrites the newer
        // catalog (an in-flight refresh raced a fresher epoch).
        if update.epoch < self.heartbeat_refresh_epoch {
            if queued {
                self.spawn_heartbeat_refresh();
            }
            return;
        }
        // TS stale-while-revalidate: a failed refresh keeps the last catalog
        // (the dock keeps counting the heartbeats it knows; the daemon's
        // scheduler keeps firing while its catalog read times out), and the
        // failure surfaces only inside an open manager view.
        if let Some(error) = update.fetch_error {
            if let Some(picker) = view.heartbeats_picker.as_mut() {
                picker.set_fetch_error(Some(error));
            }
            self.dirty = true;
        } else {
            let mut heartbeats = self.scope_heartbeats(update.heartbeats);
            sort_heartbeats(&mut heartbeats);
            self.heartbeat_catalog.clone_from(&heartbeats);
            if let Some(picker) = view.heartbeats_picker.as_mut() {
                picker.apply_catalog(heartbeats, None);
            }
            self.sync_activity_dock(view);
            self.dirty = true;
        }
        if queued {
            self.spawn_heartbeat_refresh();
        }
    }

    /// Open the `/heartbeats` view over the CACHED catalog at once (TS
    /// `showHeartbeatManager`'s mount): the keypress never waits on the
    /// daemon — a non-blocking refresh lands through the update channel,
    /// and stale-while-revalidate keeps the mounted catalog on failure
    /// (the error surfaces inside the open view only). The picker owns
    /// the frame while it is open; its close hands the focus back to the
    /// dock's own group (the operator's 2026-09-26 panel-exit ruling).
    pub(crate) fn open_heartbeats_view(&mut self, view: &mut AgentView) {
        self.subagents_focused = false;
        // The view IS the dock's Heartbeates item: every entry path —
        // the dock's Enter or the `/heartbeats` command — leaves the
        // panel's own group selected, so the close restores the
        // Heartbeats dock item (the operator's 2026-09-26 panel-exit
        // ruling; the command path would otherwise keep whatever group
        // the dock held).
        self.activity_group = crate::chrome::ActivityGroup::Heartbeats;
        view.heartbeats_picker = Some(HeartbeatsPicker::new(
            self.heartbeat_catalog.clone(),
            None,
            None,
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.spawn_heartbeat_refresh();
        self.dirty = true;
    }
}

/// The dock's paused-heartbeat count over the scoped catalog: the count
/// is label-independent (the dogfood repro: unlabeled agent heartbeats
/// fire on schedule but a label-keyed count showed none of them).
pub(super) fn paused_heartbeat_count(heartbeats: &[HeartbeatEntry]) -> usize {
    heartbeats
        .iter()
        .filter(|entry| entry.job.status == "paused")
        .count()
}
