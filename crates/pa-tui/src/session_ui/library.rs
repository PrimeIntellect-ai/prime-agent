//! The machine library page's session surface: the page open (the
//! activity dock's machine-library group's destination), the view's key
//! loop, and the daemon `factory_activity` lane the page's fetches ride
//! (the `library` action: the machine list on open, one machine's graph
//! payload on the drill-in).

use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::AgentView;

use crate::factory_view::{
    parse_library_machines, LibraryView, LibraryViewAction, MALFORMED_LIBRARY_REPLY_ERROR,
};
use crate::session_ui::{picker_viewport_rows, UI_REQUEST_TIMEOUT_MS};

/// One background library-list fetch's delivery (the open path's fetch):
/// the session the request asked about, the epoch it was issued under (an
/// older response never overwrites a newer open's fetch), and the list
/// reply (or the error that replaced it).
pub(crate) enum LibraryUpdate {
    Machines {
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
    /// Open the machine library page: the activity dock's
    /// machine-library group's destination (the factory page's sibling —
    /// the same lane, the same opt-in gate). The keypress never waits on
    /// the daemon (the factory page's pattern): the view mounts at once
    /// and the list fetch lands through the fold; a daemon without the
    /// lane reports exactly that instead of mounting nothing silently.
    pub(crate) fn open_library_page(&mut self, view: &mut AgentView) {
        if !self.factory_activity_supported() {
            self.note(
                "The machine library page needs a daemon that advertises the factory lane",
                view,
            );
            return;
        }
        // The mounted view belongs to this session: the epoch guard drops
        // a late reply from a previous session's open.
        self.library_list_epoch += 1;
        view.library_view = Some(LibraryView::new(
            Vec::new(),
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.dirty = true;
        self.spawn_library_list_refresh();
    }

    /// One key press while the view is open: the view resolves the key;
    /// the drill-in rides the daemon lane (bounded, with the outcome on
    /// the view's error row), and Esc closes.
    pub(crate) async fn handle_library_view_key(
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
            .library_view
            .as_mut()
            .map(|library_view| library_view.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(LibraryViewAction::None) | None => {}
            Some(LibraryViewAction::Close) => {
                view.library_view = None;
                self.dirty = true;
            }
            Some(LibraryViewAction::DrillIn { name }) => {
                self.fetch_library_graph(view, name).await?;
            }
        }
        Ok(())
    }

    /// Fetch one machine's graph payload over the lane (the drill-in's
    /// request, the factory page's stop/resume pattern: one bounded
    /// request, the reply folds straight into the open view, and a
    /// failure surfaces on the view's error row).
    async fn fetch_library_graph(&mut self, view: &mut AgentView, name: String) -> Result<()> {
        let reply = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::FactoryActivity {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    action: "library".to_string(),
                    run_id: None,
                    spec_id: Some(name.clone()),
                    timeout_ms: None,
                    rest: Map::default(),
                },
            )
            .await;
        match reply {
            Ok(data) => {
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.apply_detail(&name, &data);
                }
            }
            Err(error) => {
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.set_error(Some(format!("{error:#}")));
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// Fire the open path's list fetch (the heartbeat refresh's shape,
    /// one-shot: the library changes only through `prime-agent factory
    /// import | export`, so an open refetches rather than a standing
    /// poll). The reply lands through the run loop's channel; a stale
    /// epoch (a later open already fired) drops at fold time.
    pub(crate) fn spawn_library_list_refresh(&mut self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let epoch = self.library_list_epoch;
        let tx = self.library_updates.clone();
        tokio::spawn(async move {
            let fetched = client.request_ok(DaemonCommand::FactoryActivity {
                id: None,
                active_session_id: active_session_id.clone(),
                action: "library".to_string(),
                run_id: None,
                spec_id: None,
                timeout_ms: None,
                rest: Map::default(),
            });
            let fetched =
                tokio::time::timeout(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), fetched).await;
            let update = match fetched {
                Ok(Ok(data)) => LibraryUpdate::Machines {
                    session: active_session_id,
                    epoch,
                    data,
                },
                Ok(Err(error)) => LibraryUpdate::Error {
                    session: active_session_id,
                    epoch,
                    message: format!("{error:#}"),
                },
                Err(_) => LibraryUpdate::Error {
                    session: active_session_id,
                    epoch,
                    message: "timed out waiting for the Prime Agent daemon response".to_string(),
                },
            };
            let _ = tx.send(update);
        });
    }

    /// Fold one library fetch delivery into the session: a foreign session
    /// or a stale epoch (a later open already fired) drops; the open view
    /// absorbs the machines (a malformed reply keeps the rows and
    /// reports the lane instead of painting a fake empty state), and an
    /// error lands on the view's error row.
    pub(crate) fn apply_library_update(&mut self, update: LibraryUpdate, view: &mut AgentView) {
        let (session, epoch, payload) = match update {
            LibraryUpdate::Machines {
                session,
                epoch,
                data,
            } => (session, epoch, Ok(data)),
            LibraryUpdate::Error {
                session,
                epoch,
                message,
            } => (session, epoch, Err(message)),
        };
        if session != self.active_session_id || epoch != self.library_list_epoch {
            return;
        }
        if let Some(library_view) = view.library_view.as_mut() {
            match payload {
                Ok(data) => {
                    if crate::factory_view::library_reply_lists_machines(&data) {
                        library_view.set_error(None);
                        library_view.apply_machines(parse_library_machines(&data));
                    } else {
                        library_view.set_error(Some(MALFORMED_LIBRARY_REPLY_ERROR.to_string()));
                    }
                }
                Err(message) => {
                    library_view.set_error(Some(message));
                }
            }
        }
        self.dirty = true;
    }
}
