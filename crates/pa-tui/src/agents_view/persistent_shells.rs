//! The machine-wide persistent shells: the rows under the list's `Persistent shells` heading. A
//! shell's open lands on its session's Bash panel; an orphan's (its session deleted) mounts the
//! bash view over the orphans (output and kill).
use std::collections::HashMap;

use super::{
    mpsc, scope_ancestors, AgentsViewMode, AgentsViewRow, AgentsViewScope, DaemonClient,
    DaemonCommand, RowKind, Section, SessionPanel, UiInput, Value, ANCHOR_LOADING_HINT,
};
use crate::agents_view_state::{summary_for_record, UnifiedRecord};
use crate::bash_view::{
    format_duration, parse_bash_activities, BashActivity, BashView, BashViewAction,
};

/// The daemon capability that serves the machine-wide shell list, output, and kill.
pub(super) const CAPABILITY: &str = "persistent_shells";

/// The row identity prefix of a shell row.
const ROW_PREFIX: &str = "shell:";

/// One `list_persistent_shells` fetch; a failed read lands as `None` and keeps the last list.
pub(super) fn spawn_list_fetch(client: &DaemonClient, ui_tx: mpsc::UnboundedSender<UiInput>) {
    let client = client.clone();
    tokio::spawn(async move {
        let data = client
            .request_ok(DaemonCommand::ListPersistentShells {
                id: None,
                rest: serde_json::Map::default(),
            })
            .await
            .ok();
        let _ = ui_tx.send(UiInput::PersistentShellsLoaded(data));
    });
}

/// Run one bash-view action against the daemon: an open or load-more fetches the output tail, a
/// kill kills the shell (the returned handle lets the exit drain wait for it).
pub(super) fn spawn_action(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    action: BashViewAction,
) -> Option<tokio::task::JoinHandle<()>> {
    let client = client.clone();
    match action {
        BashViewAction::OpenDetail { id, generation } => Some(spawn_tail(
            client,
            ui_tx,
            id,
            generation,
            crate::bash_view::FIRST_TAIL_LINES,
        )),
        BashViewAction::LoadMore {
            id,
            generation,
            lines,
        } => Some(spawn_tail(client, ui_tx, id, generation, lines)),
        BashViewAction::Kill { id } => Some(tokio::spawn(async move {
            let outcome = client
                .request_ok(DaemonCommand::KillPersistentShell {
                    id: None,
                    shell_id: id.clone(),
                    rest: serde_json::Map::default(),
                })
                .await
                .map(|_| ())
                .map_err(|error| format!("Could not kill bash command: {error:#}"));
            let _ = ui_tx.send(UiInput::PersistentShellKilled { id, outcome });
        })),
        BashViewAction::Close | BashViewAction::None => None,
    }
}

fn spawn_tail(
    client: DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    id: String,
    generation: u64,
    lines: u32,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let outcome = client
            .request_ok(DaemonCommand::TailPersistentShell {
                id: None,
                shell_id: id.clone(),
                lines,
                rest: serde_json::Map::default(),
            })
            .await
            .map(|data| {
                data.get("tail")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .map_err(|error| format!("Bash output: {error:#}"));
        let _ = ui_tx.send(UiInput::PersistentShellTail {
            id,
            generation,
            outcome,
        });
    })
}

impl AgentsViewMode {
    /// One row per live shell (a finished one only while its bash-view detail is open), its title
    /// the command, carrying its session's summary while the roster or the catalog lists it.
    pub(super) fn persistent_shell_rows(&self, records: &[UnifiedRecord]) -> Vec<AgentsViewRow> {
        let sessions: HashMap<String, Value> = records
            .iter()
            .map(summary_for_record)
            .filter_map(|summary| {
                let session_id = summary.get("sessionId")?.as_str()?.to_string();
                Some((session_id, summary))
            })
            .collect();
        let open = self.shell_view.as_ref().and_then(BashView::detail_id);
        self.persistent_shells
            .get("activities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|shell| {
                let id = shell.get("id")?.as_str()?;
                if shell.get("status").and_then(Value::as_str) == Some("finished")
                    && open.as_deref() != Some(id)
                {
                    return None;
                }
                let session = shell
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .and_then(|session_id| sessions.get(session_id).cloned());
                Some(AgentsViewRow {
                    kind: RowKind::PersistentShell,
                    section: Section::Inactive,
                    identity: format!("{ROW_PREFIX}{id}"),
                    parent_identity: None,
                    summary: serde_json::json!({
                        "shellId": id,
                        "session": session,
                    }),
                    title: shell
                        .get("command")
                        .and_then(Value::as_str)
                        .map(single_line)
                        .unwrap_or_default(),
                    model: "-".to_string(),
                    cost: 0.0,
                    age: format_duration(shell.get("durationMs").and_then(Value::as_u64)),
                    depth: 0,
                    descendant_count: 0,
                    running_subagent_count: 0,
                    expanded: false,
                    has_spawn_code: false,
                })
            })
            .collect()
    }

    /// Enter on a shell row: its session opens on the Bash panel with the shell selected; an orphan
    /// opens the bash view over the orphans with it selected, once the daemon's walk of the whole
    /// store says the session is gone (a shell's session may sit past the loaded pages).
    pub(super) fn open_persistent_shell(&mut self, row: &AgentsViewRow) {
        let Some(id) = row.summary.get("shellId").and_then(Value::as_str) else {
            return;
        };
        if let Some(session) = row
            .summary
            .get("session")
            .filter(|session| !session.is_null())
        {
            let ancestors = scope_ancestors(
                &self.records(),
                &AgentsViewScope {
                    session_id: session
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    active_session_id: None,
                    session_name: None,
                },
            );
            self.open_row(
                &AgentsViewRow {
                    summary: session.clone(),
                    ..row.clone()
                },
                ancestors,
            );
            if let Some(opened) = self.opened.as_mut() {
                opened.panel = Some(SessionPanel::Shells {
                    shell_id: Some(id.to_string()),
                });
            }
            return;
        }
        if !self.saved_catalog_loaded || self.saved_more.is_some() {
            // The open is an explicit retry, like a query change, of a walk that failed.
            self.saved_query_rearm = self.saved_fetch_failed;
            self.pending_shell_open = Some(id.to_string());
            self.set_status(ANCHOR_LOADING_HINT);
            return;
        }
        let mut view = BashView::new(
            activities(&self.persistent_shells, &self.rows),
            self.last_height,
        )
        .with_subtitle("Session deleted");
        view.select(id);
        self.shell_view = Some(view);
    }

    /// Retry the pending shell open after the catalog grew or its walk ended, while its row is
    /// still the selected one (moving the selection away abandons it).
    pub(super) fn settle_pending_shell_open(&mut self) {
        let Some(id) = self.pending_shell_open.take() else {
            return;
        };
        if let Some(row) = self
            .rows
            .get(self.selected)
            .filter(|row| row.identity == format!("{ROW_PREFIX}{id}"))
            .cloned()
        {
            self.open_persistent_shell(&row);
        }
    }

    /// One key while the bash view is open: it owns every key; its close returns to the list.
    pub(super) fn handle_shell_view_key(&mut self, key: &str) {
        if key == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let Some(view) = self.shell_view.as_mut() else {
            return;
        };
        let open = view.detail_id();
        match view.handle_key(key, &self.keybindings) {
            BashViewAction::Close => self.shell_view = None,
            BashViewAction::None => {}
            action => self.pending_shell_action = Some(action),
        }
        // A finished shell's row lives only while its detail is open.
        if self.shell_view.as_ref().and_then(BashView::detail_id) != open {
            self.rebuild_rows();
        }
    }

    /// A landed list: the rows rebuild and an open bash view follows, only when it changed; a kill
    /// error clears only when a row moved, never on a running row's duration tick.
    pub(super) fn apply_persistent_shells(&mut self, data: Value) {
        if data == self.persistent_shells {
            return;
        }
        if crate::bash_view::registry_rows_moved(&self.persistent_shells, &data) {
            if let Some(view) = self.shell_view.as_mut() {
                view.clear_error();
            }
        }
        self.persistent_shells = data;
        self.rebuild_rows();
    }
}

/// The orphan bash view's shells: exactly the shells whose row has no session.
pub(super) fn activities(shells: &Value, rows: &[AgentsViewRow]) -> Vec<BashActivity> {
    parse_bash_activities(shells)
        .into_iter()
        .filter(|activity| {
            rows.iter().any(|row| {
                row.kind == RowKind::PersistentShell
                    && row.summary.get("shellId").and_then(Value::as_str)
                        == Some(activity.id.as_str())
                    && row.summary["session"].is_null()
            })
        })
        .collect()
}

fn single_line(value: &str) -> String {
    crate::menu_panel::scrub_controls(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
