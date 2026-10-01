//! The `/factory` session surface: the command handler, the view's key
//! loop, the refresh cadence, and the daemon `factory_activity` lane the
//! view's actions ride.

use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::AgentView;

use crate::factory_view::{
    parse_factory_runs, FactoryView, FactoryViewAction, FACTORY_WATCH_TICK_MS,
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

    /// Whether the `/factory` view is mounted (the refresh tick's gate).
    pub(crate) fn factory_view_open(&self) -> bool {
        self.factory_view_open_flag
    }

    /// `/factory`: open the live view over the session's factory runs.
    pub(crate) async fn handle_factory_command(&mut self, view: &mut AgentView) -> Result<()> {
        self.track_command_used("factory");
        if !self.factory_activity_supported() {
            self.error_row(
                "/factory needs a daemon that advertises the factory view",
                view,
            );
            return Ok(());
        }
        self.open_factory_view("/factory", view).await
    }

    /// Open the view: the first graph snapshot mounts synchronously with
    /// the open (a failed fetch reports the command and leaves nothing
    /// mounted), and the refresh cadence keeps it current.
    async fn open_factory_view(&mut self, command: &str, view: &mut AgentView) -> Result<()> {
        match self
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
            Ok(data) => {
                self.factory_view_open_flag = true;
                view.factory_view = Some(FactoryView::new(
                    parse_factory_runs(&data),
                    picker_viewport_rows(view.terminal_rows()),
                ));
                self.sync_factory_selection(view);
                self.dirty = true;
                self.spawn_factory_refresh();
            }
            Err(error) => {
                self.note(&format!("{command} failed: {error:#}"), view);
            }
        }
        Ok(())
    }

    /// One key press while the view is open: the view resolves the key;
    /// stop/resume ride the daemon lane (bounded, with the outcome
    /// reported), the mermaid copy rides the clipboard, and Esc closes.
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
                self.factory_view_open_flag = false;
                self.factory_selected_run = None;
                view.factory_view = None;
                self.dirty = true;
            }
            Some(FactoryViewAction::Stop { run_id }) => {
                self.factory_control(view, "stop", run_id).await?;
            }
            Some(FactoryViewAction::Resume { run_id }) => {
                self.factory_control(view, "resume", run_id).await?;
            }
            Some(FactoryViewAction::CopyMermaid { source }) => {
                match crate::clipboard::copy_to_clipboard(&source, &mut self.osc_sink) {
                    Ok(()) => self.toast("Copied the run's Mermaid diagram to the clipboard", view),
                    Err(message) => self.error_row(&message, view),
                }
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
                let state = data.get("state").and_then(Value::as_str).unwrap_or(action);
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

    /// The refresh cadence (the run's collect cycle): a bounded watch on
    /// the selected run — the kernel returns as soon as it changed — then
    /// the full graph list. Every request stamps the epoch it was issued
    /// under, and only the latest issued request's response lands.
    pub(crate) fn spawn_factory_refresh(&mut self) {
        if !self.factory_activity_supported() || !self.factory_view_open() {
            return;
        }
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
            match client
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
            {
                Ok(data) => {
                    let _ = tx.send(FactoryUpdate::Snapshot {
                        session: active_session_id,
                        epoch,
                        data,
                    });
                }
                Err(error) => {
                    let _ = tx.send(FactoryUpdate::Error {
                        session: active_session_id,
                        epoch,
                        message: format!("{error:#}"),
                    });
                }
            }
        });
    }

    /// Fold one refresh delivery into the open view: a stale epoch (a
    /// newer request already landed) or a foreign session drops. The
    /// changed markers land with the snapshot (the repaint hysteresis —
    /// only a notice-worthy run-shape change repaints the diagram).
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
        };
        if session != self.active_session_id || epoch != self.factory_list_epoch {
            return;
        }
        if let Some(factory_view) = view.factory_view.as_mut() {
            match payload {
                Ok(data) => {
                    factory_view.set_error(None);
                    factory_view.apply_runs(parse_factory_runs(&data));
                }
                Err(message) => factory_view.set_error(Some(message)),
            }
        }
        self.sync_factory_selection(view);
        self.dirty = true;
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
