//! The machine-wide persistent shells: the rows under the list's `Persistent shells` heading
//! (each shell with the session it is assigned to, `(deleted)` once that session is gone), and
//! the bash view their open mounts over the view (output and kill).
use std::collections::HashMap;

use super::{
    mpsc, AgentsViewMode, AgentsViewRow, DaemonClient, DaemonCommand, RowKind, Section, UiInput,
    Value,
};
use crate::agents_view_forest::session_title;
use crate::agents_view_state::{summary_for_record, UnifiedRecord};
use crate::bash_view::{format_duration, parse_bash_activities, BashView, BashViewAction};

/// The daemon capability that serves the machine-wide shell list, output, and kill.
pub(super) const CAPABILITY: &str = "persistent_shells";

/// The list poll's cadence: the next fetch arms when the last one landed.
pub(super) const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

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
    /// One row per shell, its title the assigned session's title: `(deleted)` once the loaded
    /// catalog and the roster both lack the session, nothing while the catalog still loads.
    pub(super) fn persistent_shell_rows(&self, records: &[UnifiedRecord]) -> Vec<AgentsViewRow> {
        let titles: HashMap<String, String> = records
            .iter()
            .map(summary_for_record)
            .filter_map(|summary| {
                let session_id = summary.get("sessionId")?.as_str()?.to_string();
                Some((session_id, session_title(&summary)))
            })
            .collect();
        self.persistent_shells
            .get("activities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|shell| {
                let id = shell.get("id")?.as_str()?;
                let assignment = shell
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .and_then(|session_id| titles.get(session_id).cloned())
                    .or_else(|| self.saved_catalog_loaded.then(|| "(deleted)".to_string()))
                    .unwrap_or_default();
                Some(AgentsViewRow {
                    kind: RowKind::PersistentShell,
                    section: Section::Inactive,
                    identity: format!("{ROW_PREFIX}{id}"),
                    parent_identity: None,
                    summary: serde_json::json!({
                        "shellId": id,
                        "command": shell.get("command").and_then(Value::as_str).map(single_line),
                        "durationMs": shell.get("durationMs").and_then(Value::as_u64),
                        "status": shell.get("status"),
                    }),
                    title: assignment,
                    model: String::new(),
                    cost: 0.0,
                    age: String::new(),
                    depth: 0,
                    descendant_count: 0,
                    running_subagent_count: 0,
                    expanded: false,
                    has_spawn_code: false,
                })
            })
            .collect()
    }

    /// The text of one shell row: `$ <command> · <elapsed> · <session>`, the command clipped so
    /// the elapsed time and the assignment stay readable; no assignment while the catalog loads.
    pub(super) fn persistent_shell_text(row: &AgentsViewRow, width: usize) -> String {
        let command = row
            .summary
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut tail = format!(
            " \u{b7} {}",
            format_duration(row.summary.get("durationMs").and_then(Value::as_u64))
        );
        if !row.title.is_empty() {
            tail.push_str(" \u{b7} ");
            tail.push_str(&row.title);
        }
        let room = width
            .saturating_sub(2 + crate::width::str_width(&tail))
            .max(8);
        let command = crate::width::truncate_to_width(command, room, "\u{2026}");
        format!("$ {command}{tail}")
    }

    /// Enter on a shell row: the bash view over every persistent shell, opened on this one.
    pub(super) fn open_persistent_shell(&mut self, row: &AgentsViewRow) {
        let Some(id) = row.summary.get("shellId").and_then(Value::as_str) else {
            return;
        };
        let mut view = BashView::new(
            parse_bash_activities(&self.persistent_shells),
            self.last_height,
        );
        self.pending_shell_action = Some(view.open(id));
        self.shell_view = Some(view);
    }

    /// One key while the bash view is open: it owns every key; its close returns to the list.
    pub(super) fn handle_shell_view_key(&mut self, key: &str) {
        if key == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let Some(view) = self.shell_view.as_mut() else {
            return;
        };
        match view.handle_key(key, &self.keybindings) {
            BashViewAction::Close => self.shell_view = None,
            BashViewAction::None => {}
            action => self.pending_shell_action = Some(action),
        }
    }

    /// A landed list: the rows rebuild and an open bash view follows, only when it changed.
    pub(super) fn apply_persistent_shells(&mut self, data: Value) {
        if data == self.persistent_shells {
            return;
        }
        if let Some(view) = self.shell_view.as_mut() {
            view.apply_activities(parse_bash_activities(&data));
            view.clear_error();
        }
        self.persistent_shells = data;
        self.rebuild_rows();
    }
}

fn single_line(value: &str) -> String {
    crate::menu_panel::scrub_controls(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
