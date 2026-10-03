//! The factory page's session surface: the page open (the activity
//! dock's factory group's destination), the view's key loop, the
//! refresh cadence, and the daemon `factory_activity` lane the page's
//! actions ride.

use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::AgentView;

use crate::factory_view::{
    factory_reply_lists_runs, parse_factory_runs, FactoryView, FactoryViewAction,
    FACTORY_WATCH_TICK_MS,
};
use crate::session_ui::{picker_viewport_rows, UI_REQUEST_TIMEOUT_MS};

/// One background factory refresh's delivery: the session the request
/// asked about (a late reply from a previous session never repaints the
/// newly attached one), the epoch it was issued under (an older response
/// never overwrites a newer snapshot), and the graph list (or the error
/// that replaced it).
pub(crate) enum FactoryUpdate {
    Snapshot {
        session: String,
        epoch: u64,
        data: Value,
    },
    Error {
        session: String,
        epoch: u64,
        message: String,
    },
}

impl super::SessionUi {
    /// Whether the daemon advertises the factory lane (older daemons never
    /// see the command): the open and every refresh tick key on the same
    /// gate, so an unsupported daemon spends no wakeups.
    pub(crate) fn factory_activity_supported(&self) -> bool {
        self.client
            .hello()
            .get("serverCapabilities")
            .and_then(Value::as_array)
            .is_some_and(|caps| {
                caps.iter()
                    .any(|cap| cap.as_str() == Some("factory_activity"))
            })
    }

    /// Open the factory page: the activity dock's factory group's
    /// destination (the subagents/heartbeats/shells pages' navigation
    /// family — the dock's Enter and the click both dispatch here). The
    /// keypress never waits on the daemon (the heartbeats/bash page
    /// pattern): the poll cycle's cached graph mounts at once and the
    /// refresh cadence keeps it current; a daemon without the lane
    /// reports exactly that instead of mounting nothing silently.
    pub(crate) fn open_factory_page(&mut self, view: &mut AgentView) {
        if !self.factory_activity_supported() {
            self.note(
                "The factory page needs a daemon that advertises the factory lane",
                view,
            );
            return;
        }
        // The mounted view belongs to this durable session: a later
        // rebind fold keeps it only across the SAME session's reattach.
        self.factory_view_session = Some(self.session_id.clone());
        // The mount holds the fold's malformed-reply contract: a cached
        // malformed lane mounts with its error line, never as a silent
        // fake empty state waiting for the first fold.
        view.factory_view = Some(FactoryView::from_reply(
            &self.factory_graph,
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.sync_factory_selection(view);
        self.dirty = true;
        self.spawn_factory_refresh();
    }

    /// One key press while the view is open: the view resolves the key;
    /// stop/resume ride the daemon lane (bounded, with the outcome
    /// reported), and Esc closes.
    pub(crate) async fn handle_factory_view_key(
        &mut self,
        key: crossterm::event::KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = super::key_event_to_id(&key) else {
            return Ok(());
        };
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .factory_view
            .as_mut()
            .map(|factory_view| factory_view.handle_key(&id, view.editor.keybindings()));
        self.sync_factory_selection(view);
        match action {
            Some(FactoryViewAction::None) | None => {}
            Some(FactoryViewAction::Close) => {
                self.factory_selected_run = None;
                self.factory_view_session = None;
                view.factory_view = None;
                self.dirty = true;
            }
            Some(FactoryViewAction::Stop { run_id }) => {
                self.factory_control(view, "stop", run_id).await?;
            }
            Some(FactoryViewAction::Resume { run_id }) => {
                self.factory_control(view, "resume", run_id).await?;
            }
        }
        Ok(())
    }

    /// One orchestration action (stop/resume): bounded request, the
    /// outcome reported on the view's error line, then an immediate
    /// refresh (the state change repaints without waiting a full cycle).
    async fn factory_control(
        &mut self,
        view: &mut AgentView,
        action: &str,
        run_id: String,
    ) -> Result<()> {
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::FactoryActivity {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    action: action.to_string(),
                    run_id: Some(run_id.clone()),
                    spec_id: None,
                    timeout_ms: None,
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => {
                // The reply's state is daemon-provided text painted by
                // the toast, so it scrubs (`scrub_controls`, the factory
                // view's parse-seam rule): a control byte can never ride
                // the toast to the terminal.
                let state = data
                    .get("state")
                    .and_then(Value::as_str)
                    .map_or_else(|| action.to_string(), crate::menu_panel::scrub_controls);
                self.toast(&format!("Factory run {run_id} is now {state}"), view);
            }
            Err(error) => {
                if let Some(factory_view) = view.factory_view.as_mut() {
                    factory_view.set_error(Some(format!("{error:#}")));
                } else {
                    self.error_row(&format!("{error:#}"), view);
                }
            }
        }
        self.spawn_factory_refresh();
        Ok(())
    }

    /// The session's live factory-run count, the `/factory off` lifecycle
    /// guard's read: the same lane request and the same liveness rule the
    /// dock's count reads (`is_live` — a live state, or children still in
    /// flight), so the refusal names exactly what the dock shows. The
    /// request rides regardless of the hello's advertisement: a client
    /// started before `/factory on` keeps its unadvertised hello, but the
    /// kernel gate reads the settings live, so runs started after the
    /// toggle are live in that same client — the guard must see them.
    /// `Some(0)` also answers the kernel-not-running refusal: the lane
    /// never builds a kernel, and the kernel owns its run registry in
    /// memory, so a session without a kernel cannot host live runs — a
    /// definitive zero, never an unreadable count (the lane answers the
    /// same refusal until some other action boots the kernel, so leaving
    /// it unreadable would pin the lane-advertised client's off behind a
    /// retry that never resolves). `None` when the count cannot be read:
    /// the request failed (an older daemon answers the unknown command
    /// with a failure), or the reply is not the runs list.
    pub(crate) async fn live_factory_runs(&mut self) -> Option<usize> {
        let reply = match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::FactoryActivity {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    action: "graph".to_string(),
                    run_id: None,
                    spec_id: None,
                    timeout_ms: None,
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(reply) => reply,
            // The no-kernel class: the count is exactly zero (nothing
            // can host live runs), so the guard proceeds.
            Err(error) if crate::daemon_client::is_kernel_not_running(&error) => {
                return Some(0);
            }
            // Every other failure class stays unreadable: a timed-out or
            // malformed lane reply cannot prove zero live runs, and the
            // lane-advertised client fails closed on it.
            Err(_) => return None,
        };
        if !factory_reply_lists_runs(&reply) {
            return None;
        }
        Some(
            parse_factory_runs(&reply)
                .iter()
                .filter(|run| run.is_live())
                .count(),
        )
    }

    /// The refresh cadence (the run's collect cycle): a bounded watch on
    /// the selected run — the kernel returns as soon as it changed —
    /// then the full graph list. The cycle runs on the bash poll's
    /// always-on 2-second cadence (the dock's factory count stays live
    /// while the page is closed); an open page adds its selected run's
    /// watch ahead of the graph. At most one refresh runs in flight with
    /// one queued trailing refresh (the heartbeat refresh's
    /// serialization): a tick that fires while the watch/graph pair is
    /// still in flight queues behind it instead of minting a newer epoch
    /// the in-flight reply could never match (the watch alone can span a
    /// whole tick, so overlapping cycles would leave the view
    /// permanently stale). Every request stamps the epoch it was issued
    /// under, and only the latest issued request's response lands.
    pub(crate) fn spawn_factory_refresh(&mut self) {
        if !self.factory_activity_supported() {
            return;
        }
        if self.factory_refresh_in_flight {
            self.factory_refresh_queued = true;
            return;
        }
        self.factory_refresh_in_flight = true;
        self.factory_list_epoch += 1;
        let epoch = self.factory_list_epoch;
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let selected_run = self.factory_selected_run.clone();
        let tx = self.factory_updates.clone();
        tokio::spawn(async move {
            // The watch first: the selected run's change wakes the refresh
            // at the run's own pace instead of a fixed poll interval; a
            // failed or unsupported watch degrades to the plain cadence.
            // The whole cycle sits inside the shared request bound so the
            // refresh slot always frees (a hung request must never pin
            // the cadence), exactly like the heartbeat refresh.
            let cycle = async {
                if let Some(run_id) = selected_run {
                    let _ = client
                        .request_ok(DaemonCommand::FactoryActivity {
                            id: None,
                            active_session_id: active_session_id.clone(),
                            action: "watch".to_string(),
                            run_id: Some(run_id),
                            spec_id: None,
                            timeout_ms: Some(FACTORY_WATCH_TICK_MS),
                            rest: Map::default(),
                        })
                        .await;
                }
                client
                    .request_ok(DaemonCommand::FactoryActivity {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        action: "graph".to_string(),
                        run_id: None,
                        spec_id: None,
                        timeout_ms: None,
                        rest: Map::default(),
                    })
                    .await
            };
            let fetched =
                tokio::time::timeout(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), cycle).await;
            match fetched {
                Ok(Ok(data)) => {
                    let _ = tx.send(FactoryUpdate::Snapshot {
                        session: active_session_id,
                        epoch,
                        data,
                    });
                }
                Ok(Err(error)) => {
                    let _ = tx.send(FactoryUpdate::Error {
                        session: active_session_id,
                        epoch,
                        message: format!("{error:#}"),
                    });
                }
                Err(_) => {
                    let _ = tx.send(FactoryUpdate::Error {
                        session: active_session_id,
                        epoch,
                        message: "timed out waiting for the Prime Agent daemon response"
                            .to_string(),
                    });
                }
            }
        });
    }

    /// The fold's cache decision (the Cursor review finding: a malformed
    /// batch used to clobber the dock's cached reply anyway): a
    /// well-formed batch replaces the cache and parses; a malformed one
    /// keeps the last good reply, so the dock's live-run count and a
    /// later remount never paint a fake empty state (the malformed
    /// contract the view's mount already carries).
    fn fold_factory_reply(
        cache: &mut Value,
        incoming: Value,
    ) -> Option<Vec<crate::factory_view::FactoryRunSnapshot>> {
        if !crate::factory_view::factory_reply_lists_runs(&incoming) {
            return None;
        }
        let runs = parse_factory_runs(&incoming);
        *cache = incoming;
        Some(runs)
    }

    /// Fold one refresh delivery into the session: the dock's count
    /// cache always absorbs the snapshot, the open view applies it, and
    /// a stale epoch (a newer request already landed) or a foreign
    /// session drops. The refresh slot frees whether the response
    /// landed, failed, or timed out, and a tick's queued refresh runs
    /// next (the heartbeat fold's shape). The changed markers land with
    /// the snapshot (the repaint hysteresis — only a notice-worthy
    /// run-shape change repaints the diagram). A reply without the
    /// runs list is a malformed lane, not zero runs: the open view
    /// reports it on its error line instead of painting a fake empty
    /// state (the emptiness the view shows is real).
    pub(crate) fn apply_factory_update(&mut self, update: FactoryUpdate, view: &mut AgentView) {
        // The slot frees on every delivery path; a queued tick fires next.
        self.factory_refresh_in_flight = false;
        let queued = std::mem::take(&mut self.factory_refresh_queued);
        let (session, epoch, payload) = match update {
            FactoryUpdate::Snapshot {
                session,
                epoch,
                data,
            } => (session, epoch, Ok(data)),
            FactoryUpdate::Error {
                session,
                epoch,
                message,
            } => (session, epoch, Err(message)),
        };
        if session != self.active_session_id || epoch != self.factory_list_epoch {
            if queued {
                self.spawn_factory_refresh();
            }
            return;
        }
        match payload {
            Ok(data) => match Self::fold_factory_reply(&mut self.factory_graph, data) {
                Some(runs) => {
                    if let Some(factory_view) = view.factory_view.as_mut() {
                        factory_view.set_error(None);
                        factory_view.apply_runs(runs);
                    }
                }
                None => {
                    if let Some(factory_view) = view.factory_view.as_mut() {
                        factory_view.set_error(Some(
                            crate::factory_view::MALFORMED_REPLY_ERROR.to_string(),
                        ));
                    }
                }
            },
            Err(message) => {
                if let Some(factory_view) = view.factory_view.as_mut() {
                    factory_view.set_error(Some(message));
                }
            }
        }
        self.sync_factory_selection(view);
        self.sync_activity_dock(view);
        self.dirty = true;
        if queued {
            self.spawn_factory_refresh();
        }
    }

    /// Record the view's selected run id (the watch target for the next
    /// refresh tick): the view owns the selection, the session UI owns
    /// the spawned refresh.
    pub(crate) fn sync_factory_selection(&mut self, view: &AgentView) {
        self.factory_selected_run = view
            .factory_view
            .as_ref()
            .and_then(|factory_view| factory_view.selected_run())
            .map(|run| run.run_id.clone())
            .filter(|run_id| !run_id.is_empty());
    }
}

#[cfg(test)]
mod fold_tests {
    use super::super::SessionUi;
    use serde_json::json;

    /// The malformed fold keeps the dock's cached reply (the Cursor
    /// review finding): a bad batch never replaces the last good reply,
    /// so the dock's live-run count and a later remount keep reading it
    /// instead of painting a fake empty state.
    #[test]
    fn a_malformed_batch_never_replaces_the_cached_reply() {
        let mut cache = json!({"runs": [{"runId": "r1", "machine": {}}]});
        let taken = SessionUi::fold_factory_reply(&mut cache, json!({"boom": true}));
        assert!(
            taken.is_none(),
            "a reply without the runs list is not taken"
        );
        assert_eq!(
            cache["runs"][0]["runId"], "r1",
            "the last good reply survives the malformed fold"
        );
        // ...and a well-formed batch replaces the cache and parses.
        let taken = SessionUi::fold_factory_reply(
            &mut cache,
            json!({"runs": [{"runId": "r2", "machine": {}}]}),
        );
        let runs = taken.expect("the well-formed batch is taken");
        assert_eq!(runs.len(), 1);
        assert_eq!(cache["runs"][0]["runId"], "r2");
    }
}
