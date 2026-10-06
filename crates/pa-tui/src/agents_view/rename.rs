//! The rename flow: the ctrl+r composer over the prompt, the wire dispatch the confirm
//! executes, and the landed outcome's status.
use serde_json::Value;

use super::{AgentsViewMode, Composer, DaemonClient, UiInput};
use crate::agents_view_forest::RowKind;
use crate::editor::{Editor, EditorEvent};
use pa_types::daemon::DaemonCommand;
use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Rename {
    pub(super) target: RenameTarget,
    pub(super) name: String,
}

/// The rename composer's state: the editor owns the draft (the full cursor/word/
/// kill/undo grammar, no autocomplete — the provider answers only while a reply is
/// armed), and the confirm dispatches the trimmed text.
pub(super) struct RenameComposer {
    pub(super) target: RenameTarget,
    pub(super) editor: Editor,
}

/// Which session a rename targets: the live session through `rename`, the saved file through
/// `rename_saved_session`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RenameTarget {
    Live { active_session_id: String },
    Saved { session_path: String },
}

impl AgentsViewMode {
    /// The selected row's rename target and name prefill (TS
    /// `enterRenameMode`'s gate, :1868-1888): an agent or subagent row
    /// with a live session or a saved file. One definition of
    /// "renameable" — the enter arm and the hint slot both read it.
    pub(super) fn rename_target(&self) -> Option<(RenameTarget, String)> {
        let row = self
            .rows
            .get(self.selected)
            .filter(|row| matches!(row.kind, RowKind::Agent | RowKind::Subagent))?;
        let active = row
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let file = row
            .summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty());
        let target = match (active, file) {
            (Some(active), _) => RenameTarget::Live {
                active_session_id: active.to_string(),
            },
            (None, Some(path)) => RenameTarget::Saved {
                session_path: path.to_string(),
            },
            (None, None) => return None,
        };
        Some((
            target,
            row.summary
                .get("sessionName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ))
    }

    /// Enter the rename composer over the prompt: the search query stays untouched; the armed
    /// confirm is already cleared by the key router's preamble.
    pub(super) fn enter_rename_mode(&mut self) {
        // Renames ride the local daemon or the local file; a tailnet
        // peer's name changes on its own machine (TS #2516).
        if self.guard_remote_row("rename") {
            return;
        }
        let Some((target, name)) = self.rename_target() else {
            // An agent or subagent row with neither target reports (TS
            // :1876-1878); any other selection stays silent (:1871).
            if self
                .rows
                .get(self.selected)
                .is_some_and(|row| matches!(row.kind, RowKind::Agent | RowKind::Subagent))
            {
                self.set_status("This session cannot be renamed");
            }
            return;
        };
        let mut editor = Editor::new();
        editor.set_keybindings(self.keybindings.clone());
        editor.set_text(&name);
        editor.clear_autocomplete_provider();
        self.composer = Composer::Rename(Box::new(RenameComposer { target, editor }));
    }

    /// Rename-mode key routing: cancel exits to search, Enter dispatches the trimmed
    /// draft, other keys go to the editor's grammar (not the search field's subset).
    /// The composer comes in owned and goes back only where the mode continues.
    pub(super) fn handle_rename_key(&mut self, mut rename: Box<RenameComposer>, key: &str) {
        // Every ctrl+c in rename mode counts as handled for the force-quit guard (the default
        // cancel binding includes ctrl+c).
        if key == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        if self.keybindings.matches(key, "tui.select.cancel") {
            return;
        }
        // The editor owns Enter: its submit hands over the trimmed draft, and an
        // empty name exits. Its other events have no host here.
        rename.editor.handle_input(key);
        let submitted = rename
            .editor
            .take_events()
            .into_iter()
            .find_map(|event| match event {
                EditorEvent::Submitted(text) => Some(text),
                _ => None,
            });
        match submitted {
            Some(name) if !name.is_empty() => {
                self.set_status("Renaming agent...");
                self.pending_rename = Some(Rename {
                    target: rename.target,
                    name,
                });
            }
            Some(_) => {}
            None => self.composer = Composer::Rename(rename),
        }
    }

    /// One landed rename outcome: the status names it; a saved target's catalog row patches
    /// its name in place (saved rows get no push).
    pub(super) fn rename_result(&mut self, rename: Rename, outcome: Result<(), String>) {
        // The in-flight draft marks the composer that dispatched the rename (a
        // re-armed composer carries no in-flight draft). Success disarms it; failure
        // restores the draft under the empty-editor guard.
        if let Composer::Reply(reply) = &mut self.composer {
            if reply.in_flight.is_some() {
                match &outcome {
                    Ok(()) => {
                        self.disarm_reply();
                    }
                    Err(_) => {
                        if reply.editor.get_text().is_empty() {
                            if let Some(draft) = reply.in_flight.take() {
                                reply.editor.set_text(&draft);
                            }
                        }
                    }
                }
            }
        }
        match outcome {
            Ok(()) => {
                self.set_status(&format!("Renamed to {}", rename.name));
                self.actions.push("renamed");
                if let RenameTarget::Saved { session_path } = rename.target {
                    if let Some(saved) = self.saved.iter_mut().find(|saved| {
                        saved.get("path").and_then(Value::as_str) == Some(session_path.as_str())
                    }) {
                        saved["name"] = serde_json::json!(rename.name);
                    }
                    self.rebuild_rows();
                }
            }
            Err(error) => {
                self.set_status(&format!("Failed to rename agent: {error}"));
            }
        }
    }
}

/// One rename wire dispatch: the call runs off the key loop with a client clone and its
/// outcome re-enters the loop as a `RenameResult` status line. TS's unknown-command "older
/// build" arm is not ported — the daemon has always had `rename`.
pub(super) fn spawn_rename_dispatch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    rename: Rename,
) -> tokio::task::JoinHandle<()> {
    let client = client.clone();
    tokio::spawn(async move {
        let request = match &rename.target {
            RenameTarget::Live { active_session_id } => DaemonCommand::Rename {
                id: None,
                active_session_id: active_session_id.clone(),
                name: rename.name.clone(),
                renamed_by: None,
                rest: serde_json::Map::default(),
            },
            // No activeSessionId: the supervisor runs the offline catalog rename.
            RenameTarget::Saved { session_path } => DaemonCommand::RenameSavedSession {
                id: None,
                active_session_id: None,
                session_path: session_path.clone(),
                name: rename.name.clone(),
                rest: serde_json::Map::default(),
            },
        };
        let outcome = match client.request(request).await {
            Ok(response) if response.success => Ok(()),
            Ok(response) => Err(response
                .error
                .unwrap_or_else(|| "the command failed".into())),
            Err(error) => Err(format!("{error:#}")),
        };
        let _ = ui_tx.send(UiInput::RenameResult { rename, outcome });
    })
}
