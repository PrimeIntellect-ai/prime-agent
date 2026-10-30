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
    factory_reply_lists_runs, live_run_count, parse_factory_runs, FactoryView, FactoryViewAction,
    FACTORY_WATCH_TICK_MS,
};
use crate::interactive::{SelectionOrigin, SessionPanel, SessionSelection};
use crate::session_ui::{picker_viewport_rows, UI_REQUEST_TIMEOUT_MS};
use crate::subagents::{descendant_entries_with_depth, SessionIdentity};

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
    ChildStop {
        session: String,
        message: String,
        tone: crate::agents_view::StatusTone,
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
    /// Open hands off to the child's session, the run stop/resume ride the
    /// daemon lane and the child stop rides `cancel_rlm_child` (bounded,
    /// with the outcome reported), and Close closes.
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
                self.close_panel_to_agents_view();
                self.dirty = true;
            }
            Some(FactoryViewAction::Open { child_id }) => self.open_factory_child(view, &child_id),
            Some(FactoryViewAction::Stop { run_id }) => {
                self.factory_control(view, "stop", run_id).await?;
            }
            Some(FactoryViewAction::StopChild { child_id, label }) => {
                self.stop_factory_child(child_id, label);
            }
            Some(FactoryViewAction::Resume { run_id }) => {
                self.factory_control(view, "resume", run_id).await?;
            }
        }
        Ok(())
    }

    /// Open a state's child session: hand off like `/resume <session>`
    /// (the selection plus the leave-now signal), with the child's depth
    /// and this page on its selected row as the origin leaving the child
    /// returns to. A child the roster cannot open yet reports on the
    /// page's error line.
    fn open_factory_child(&mut self, view: &mut AgentView, child_id: &str) {
        if let Some((selection, rlm_depth)) =
            factory_child_selection(&self.roster, &self.session_identity(), child_id)
        {
            self.pending_selection = Some(selection);
            self.pending_selection_rlm_depth = rlm_depth;
            self.pending_selection_origin = Some(SelectionOrigin {
                panel: SessionPanel::FactoryRuns {
                    row: view
                        .factory_view
                        .as_ref()
                        .and_then(FactoryView::selected_row)
                        .cloned(),
                },
                closes_to_agents_view: self.panel_returns_to_agents_view,
            });
            self.exit_requested = true;
        } else if let Some(factory_view) = view.factory_view.as_mut() {
            factory_view.set_error(Some(format!(
                "cannot open {child_id}: no live runtime or saved session yet"
            )));
        }
        self.dirty = true;
    }

    /// Stop a state's running child through the agents view's stop
    /// (`cancel_rlm_child` on this session, its parent). The kernel
    /// treats the cancel as a failed attempt under the state's retries
    /// and failure policy. Success toasts; a no-effect or failed stop
    /// lands on the page's error line.
    fn stop_factory_child(&mut self, child_id: String, label: String) {
        let action = crate::agents_view::DeleteAction::StopSubagent {
            active_session_id: self.active_session_id.clone(),
            child_id,
            name: label,
        };
        let client = self.client.clone();
        let tx = self.factory_updates.clone();
        let session = self.active_session_id.clone();
        tokio::spawn(async move {
            let (message, tone) = match tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                crate::agents_view::execute_delete_action(&client, &action),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => (
                    "timed out waiting for the Prime Agent daemon response".to_string(),
                    crate::agents_view::StatusTone::Error,
                ),
            };
            let _ = tx.send(FactoryUpdate::ChildStop {
                session,
                message,
                tone,
            });
        });
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
        Some(live_run_count(&reply))
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
            FactoryUpdate::ChildStop {
                session,
                message,
                tone,
            } => {
                if session == self.active_session_id {
                    match tone {
                        crate::agents_view::StatusTone::Muted => self.toast(&message, view),
                        crate::agents_view::StatusTone::Warning
                        | crate::agents_view::StatusTone::Error => {
                            if let Some(factory_view) = view.factory_view.as_mut() {
                                factory_view.set_error(Some(message));
                            } else {
                                self.toast(&message, view);
                            }
                        }
                    }
                    self.dirty = true;
                    self.spawn_factory_refresh();
                }
                return;
            }
        };
        // Only refresh deliveries release the refresh slot; child-stop
        // results are independent of any snapshot currently in flight.
        self.factory_refresh_in_flight = false;
        let queued = std::mem::take(&mut self.factory_refresh_queued);
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

/// How a factory child opens: its roster row among this session's DIRECT
/// children (child ids are only unique among siblings), opened like an
/// agents-view row ([`SessionSelection::open_summary`], with the row's
/// `rlmDepth`).
fn factory_child_selection(
    roster: &[Value],
    session: &SessionIdentity,
    child_id: &str,
) -> Option<(SessionSelection, Option<u32>)> {
    let summary = descendant_entries_with_depth(roster, session)
        .into_iter()
        .filter(|(_, depth)| *depth == 1)
        .filter_map(|(entry, _)| entry.get("summary"))
        .find(|summary| summary.get("rlmChildId").and_then(Value::as_str) == Some(child_id))?;
    let rlm_depth = summary
        .get("rlmDepth")
        .and_then(Value::as_u64)
        .map(|depth| depth as u32);
    Some((SessionSelection::open_summary(summary)?, rlm_depth))
}

#[cfg(test)]
mod fold_tests {
    use super::super::SessionUi;
    use super::{factory_child_selection, SessionIdentity, SessionSelection};
    use serde_json::json;

    /// A factory child opens through the roster: among this session's
    /// direct children, a live runtime attaches and a saved-only child
    /// resumes its file, each with its row's depth; a deeper descendant reusing the id (child ids
    /// are only unique among siblings) and an unknown id resolve nothing.
    #[test]
    fn a_factory_child_resolves_to_attach_or_resume_via_the_roster() {
        let child = |agent: &str, child_id: &str, parent: &str, extra: serde_json::Value| {
            let mut summary = json!({
                "runtimeKind": "subagent",
                "rlmChildId": child_id,
                "parentActiveSessionId": parent,
            });
            summary
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            json!({ "agentId": agent, "summary": summary })
        };
        let roster = vec![
            child(
                "a",
                "review-1",
                "root",
                json!({ "activeSessionId": "live-a", "rlmDepth": 1 }),
            ),
            child("b", "fix-1", "root", json!({ "sessionFile": "/s/b.jsonl" })),
            child(
                "c",
                "deep-1",
                "live-a",
                json!({ "activeSessionId": "live-c" }),
            ),
        ];
        let root = SessionIdentity::new(Some("root".to_string()), None, None);
        assert_eq!(
            factory_child_selection(&roster, &root, "review-1"),
            Some((SessionSelection::Attach("live-a".to_string()), Some(1)))
        );
        assert_eq!(
            factory_child_selection(&roster, &root, "fix-1"),
            Some((SessionSelection::Resume("/s/b.jsonl".into()), None))
        );
        assert_eq!(factory_child_selection(&roster, &root, "deep-1"), None);
        assert_eq!(factory_child_selection(&roster, &root, "missing"), None);
    }

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
