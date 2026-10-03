//! The reply flow (TS `toggleReplyTarget`/`setReplyTarget`/`sendReply`,
//! agents-view-mode.ts:1585-2108): the space-key composer over the
//! prompt, its arm/disarm and key routing, the headline fetch the arm
//! fires, the send/resume/kill dispatches, and the landed outcomes'
//! statuses — moved with its concern.
use serde_json::Value;

use super::delete::PendingDelete;
use super::rename::{Rename, RenameTarget};
use super::status::{Status, StatusTone};
use super::{AgentsViewMode, Composer, DaemonClient, UiInput};
use crate::agents_view_forest::RowKind;
use crate::editor::{Editor, EditorEvent};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use pa_types::daemon::{DaemonCommand, PromptInput, StreamingBehavior};
use pa_types::slash_commands::{
    is_session_slash_command_name, parse_slash_command, SlashCommandRegistry,
    SESSION_SLASH_COMMAND_NAMES,
};
use tokio::sync::mpsc;

/// The row-targeted view commands (TS `AGENTS_VIEW_COMMAND_NAMES`): the
/// one name list the parser, the rejection rule, and the autocomplete
/// entries all read.
pub(super) const VIEW_COMMAND_NAMES: [&str; 2] = ["name", "kill"];

/// TS `AGENTS_VIEW_COMMAND_DESCRIPTIONS` (the autocomplete entries'
/// labels): the view commands' own descriptions, `/name`'s argument
/// hint, and its takes-argument.
const VIEW_COMMAND_DESCRIPTIONS: [(&str, &str, Option<&str>, bool); 2] = [
    ("name", "Set session display name", Some("<name>"), true),
    (
        "kill",
        "Stop this agent's runtime (session stays resumable)",
        None,
        false,
    ),
];

/// TS `createReplyComposerAutocompleteProvider` (:813-824): the
/// session-owned builtins plus the view commands, path completion
/// based at the target's own cwd (the reply runs in the target's
/// directory, not the view's).
fn reply_autocomplete_provider(
    summary: &Value,
    fallback_cwd: &std::path::Path,
) -> Box<dyn crate::autocomplete::AutocompleteProvider + Send> {
    let registry = SlashCommandRegistry::builtin_cached();
    let mut commands: Vec<crate::autocomplete::SlashCommandEntry> = SESSION_SLASH_COMMAND_NAMES
        .iter()
        .filter_map(|name| registry.get(name))
        .map(|command| crate::autocomplete::SlashCommandEntry {
            name: command.name.to_string(),
            aliases: command.aliases.iter().map(ToString::to_string).collect(),
            description: Some(command.description.to_string()),
            argument_hint: command.argument_hint.map(str::to_string),
            takes_argument: command.takes_argument,
            source_tag: None,
        })
        .collect();
    for (name, description, argument_hint, takes_argument) in VIEW_COMMAND_DESCRIPTIONS {
        let builtin = registry.get(name);
        commands.push(crate::autocomplete::SlashCommandEntry {
            name: name.to_string(),
            aliases: builtin
                .map(|command| command.aliases.to_vec())
                .unwrap_or_default()
                .iter()
                .map(ToString::to_string)
                .collect(),
            description: Some(description.to_string()),
            argument_hint: argument_hint.map(str::to_string),
            takes_argument,
            source_tag: None,
        });
    }
    let base = summary
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .map_or_else(|| fallback_cwd.to_path_buf(), std::path::PathBuf::from);
    Box::new(crate::autocomplete::CombinedAutocompleteProvider::new(
        commands, base,
    ))
}

/// The reply target (TS `replyTarget`): the row's key
/// (`activeSessionId ?? id`) plus the summary captured at arm.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ReplyTarget {
    pub(super) key: String,
    pub(super) summary: Value,
}

/// The header's headline state (TS `replyLastAssistantText` +
/// `replyLastAssistantTextLoading`).
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Headline {
    /// The live fetch runs (the dim "Loading last response..." line).
    Loading,
    /// The fetch landed, or the saved target's recap: `None` renders
    /// the dim "No response yet" line.
    Loaded(Option<String>),
}

/// The reply composer's state: the target, the editor owning the draft,
/// the header's headline and time, and the submitted draft while a
/// send or view command is out (restored on failure, TS's
/// `editor.setText(value)` under the same-target-empty-editor guard).
pub(super) struct ReplyComposer {
    pub(super) target: ReplyTarget,
    pub(super) editor: Editor,
    pub(super) headline: Headline,
    /// The relative age at arm (TS `replyHeaderTime`).
    pub(super) time: String,
    pub(super) in_flight: Option<String>,
}

impl ReplyComposer {
    /// The composer's placeholder (TS `setReplyTarget`'s editor
    /// placeholder switch): the live target replies, the saved target
    /// resumes.
    pub(super) fn placeholder(&self) -> &'static str {
        if self.target.summary.get("activeSessionId").is_some() {
            "Write a reply to this agent"
        } else {
            "Write a prompt to resume this session"
        }
    }

    /// The header line (TS `renderReplyHeaderLine`, :1950-1961): the
    /// warning time and the headline — the first non-empty,
    /// whitespace-collapsed line of the last assistant text — or the
    /// dim loading/no-response line.
    pub(super) fn header_line(&self, theme: &Theme) -> Line {
        let headline = match &self.headline {
            Headline::Loaded(Some(text)) => reply_headline(text).map_or_else(
                || theme.fg(ThemeColor::Dim, "No response yet".to_string()),
                Span::raw,
            ),
            Headline::Loaded(None) => theme.fg(ThemeColor::Dim, "No response yet".to_string()),
            Headline::Loading => theme.fg(ThemeColor::Dim, "Loading last response...".to_string()),
        };
        if self.time.is_empty() {
            vec![headline]
        } else {
            vec![
                theme.fg(ThemeColor::Warning, self.time.clone()),
                Span::raw(" ".to_string()),
                headline,
            ]
        }
    }
}

/// The first non-empty line with its whitespace collapsed (TS
/// `createAgentsViewReplyHeadline`).
fn reply_headline(text: &str) -> Option<String> {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|line| !line.is_empty())
}

/// The replyable row's key (TS `toggleReplyTarget`'s
/// `activeSessionId ?? id` — the same derivation `moveSelection`'s
/// disarm guard compares against).
fn reply_key(summary: &Value) -> String {
    summary
        .get("activeSessionId")
        .and_then(Value::as_str)
        .or_else(|| summary.get("id").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// A successful send's landed facts (TS `sendReply`'s return): the
/// resumed summary when the send resumed a saved session (the
/// composer's selection follows it), and the sticky cwd notice when
/// the resume fell back to a directory that still exists.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ReplySent {
    pub(super) resumed: Option<Value>,
    pub(super) cwd_notice: Option<String>,
}

/// One reply send the run loop dispatches (TS `submit`'s send arm): the
/// CURRENT summary the send resolves to (`resolveCurrentReplyTargetSummary`),
/// the submitted text, the streaming behavior, and the resume config
/// the saved path's create carries.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ReplyRequest {
    pub(super) key: String,
    pub(super) summary: Value,
    pub(super) text: String,
    pub(super) behavior: Option<StreamingBehavior>,
    pub(super) resume_config: Value,
    /// The missing-directory notice the resume config carries (TS
    /// `resolveAgentsViewOpenCwd`): the sticky status on success.
    pub(super) cwd_notice: Option<String>,
}

/// One `/kill` view command the run loop dispatches.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct KillRequest {
    pub(super) key: String,
    pub(super) active_session_id: String,
}

impl AgentsViewMode {
    /// The selected row's reply target (TS `toggleReplyTarget`'s gates:
    /// a top-level agent with a live session or a saved file, never the
    /// row an armed delete sits on) — the arm key and the hint slot's
    /// one "replyable" predicate.
    pub(super) fn reply_target(&self) -> Option<ReplyTarget> {
        let row = self
            .rows
            .get(self.selected)
            .filter(|row| row.kind == RowKind::Agent)?;
        if self
            .pending_delete
            .as_ref()
            .is_some_and(|pending| pending.identity == row.identity)
        {
            return None;
        }
        let summary = &row.summary;
        let active = summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let file = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty());
        if active.is_none() && file.is_none() {
            return None;
        }
        Some(ReplyTarget {
            key: reply_key(summary),
            summary: summary.clone(),
        })
    }

    /// Whether the composer is armed on the given key.
    fn reply_armed_on(&self, key: &str) -> bool {
        matches!(&self.composer, Composer::Reply(reply) if reply.target.key == key)
    }

    /// TS `toggleReplyTarget` (:1795-1838): arm the reply composer over
    /// the selected agent row — the same target disarms.
    pub(super) fn toggle_reply(&mut self) {
        // Replies steer or resume through the local daemon; a tailnet
        // peer's row has no local runtime or file, so the composer cannot
        // deliver for it (TS #2516 — the row is read-only context here).
        if self.guard_remote_row("reply to") {
            return;
        }
        let Some(target) = self.reply_target() else {
            return;
        };
        if self.reply_armed_on(&target.key) {
            self.disarm_reply();
            return;
        }
        self.arm_reply(target);
    }

    /// TS `setReplyTarget(target)`: the composer owns a fresh editor
    /// (the search field's query stays untouched — the filter keeps it,
    /// exactly as TS filters on its saved query); a live target arms the
    /// headline fetch, a saved one starts from its recap; the header's
    /// time is the summary's relative age at arm.
    fn arm_reply(&mut self, target: ReplyTarget) {
        let mut editor = Editor::new();
        editor.set_keybindings(self.keybindings.clone());
        // TS `setReplyTarget` swaps the editor's provider for the
        // reply one (the session commands + the view commands, the
        // target's cwd behind `@` completion).
        editor.set_autocomplete_provider(reply_autocomplete_provider(
            &target.summary,
            &self.options.cwd,
        ));
        let active = target
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        let headline = match &active {
            Some(_) => Headline::Loading,
            None => Headline::Loaded(
                target
                    .summary
                    .get("summary")
                    .or_else(|| target.summary.get("firstMessage"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
        };
        if let Some(active) = active {
            // The headline fetch dispatches off the key loop (the
            // mode holds no client); its result is keyed, and a
            // re-targeted or disarmed composer drops it.
            self.pending_headline = Some((target.key.clone(), active));
        }
        let time = crate::agents_view_state::relative_age(
            target
                .summary
                .get("modified")
                .or_else(|| target.summary.get("created"))
                .and_then(Value::as_str),
            crate::agents_view_state::now_ms(),
        );
        self.composer = Composer::Reply(Box::new(ReplyComposer {
            target,
            editor,
            headline,
            time,
            in_flight: None,
        }));
    }

    /// TS `setReplyTarget(undefined)`: the composer drops (its editor
    /// with it) and the rows rebuild.
    pub(super) fn disarm_reply(&mut self) {
        self.composer = Composer::Search;
        self.rebuild_rows();
    }

    /// TS `moveSelection`'s reply guard (:1487-1493): the reply stays
    /// armed only while the selection sits on the targeted agent row —
    /// a move off it (a nested row, another agent, a re-keyed runtime)
    /// disarms.
    pub(super) fn disarm_reply_off_selected(&mut self) {
        let on_target = match (&self.composer, self.rows.get(self.selected)) {
            (Composer::Reply(reply), Some(row)) => {
                row.kind == RowKind::Agent && reply_key(&row.summary) == reply.target.key
            }
            _ => false,
        };
        if !on_target && matches!(self.composer, Composer::Reply(_)) {
            self.disarm_reply();
        }
    }

    /// The target's CURRENT summary at send time (TS
    /// `resolveCurrentReplyTargetSummary`, :826-842): the unified
    /// records by identity/alias, then the live roster by active id,
    /// then the captured summary — with its stale runtime id dropped
    /// when a persisted target left the live catalog but still has its
    /// file.
    pub(super) fn current_reply_summary(&self, target: &ReplyTarget) -> Value {
        let identity = crate::agents_view_forest::summary_identity(&target.summary);
        if let Some(record) = self
            .records()
            .into_iter()
            .find(|record| record.identity == identity || record.aliases.contains(&identity))
        {
            // TS `summaryForUnifiedRecord`: the merged summary a row
            // acts on — the live summary with saved fields filling the
            // gaps, saved-only records in their synthesized archived
            // shape (the raw catalog row carries `path`, not
            // `sessionFile`).
            return crate::agents_view_state::summary_for_record(&record);
        }
        let active = target
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str);
        if let Some(summary) = active.and_then(|active| {
            self.roster
                .iter()
                .filter_map(|entry| entry.get("summary"))
                .find(|summary| {
                    summary.get("activeSessionId").and_then(Value::as_str) == Some(active)
                })
        }) {
            return summary.clone();
        }
        let mut summary = target.summary.clone();
        if summary.get("sessionFile").is_some() && summary.get("activeSessionId").is_some() {
            // A persisted target missing from the live catalog can still
            // resume from its captured file, but its captured runtime id
            // is stale (TS drops it with the archived lifecycle) — the key
            // leaves entirely, so the presence checks (the steer gate, the
            // resuming status) read it as saved.
            if let Some(object) = summary.as_object_mut() {
                object.remove("activeSessionId");
            }
            summary["lifecycle"] = serde_json::json!("archived");
            summary["activity"] = serde_json::json!("idle");
        }
        summary
    }

    /// The reply-mode key routing (TS `handleInput`'s gates while armed,
    /// :1127-1200, plus the editor's own app checks): the cancel keys
    /// disarm, the empty-editor gates run the view's row actions, the
    /// follow-up key queues, and every other key (Enter included) goes
    /// to the editor, whose submit dispatches. The composer comes in owned
    /// (the caller hands it over) and goes back only where the mode continues.
    pub(super) fn handle_reply_key(
        &mut self,
        mut reply: Box<ReplyComposer>,
        was_delete_armed: Option<PendingDelete>,
        key: &str,
    ) {
        // Every ctrl+c while armed counts as handled for the force-quit
        // guard: the composer's cancel and clear keys include it.
        if key == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        // TS `app.clear` (ctrl+c) disarms — the composer's hints
        // advertise it as cancel, so it never starts the exit flow.
        if self.keybindings.matches(key, "app.clear") {
            self.disarm_reply();
            return;
        }
        let empty = reply.editor.get_text().is_empty();
        if empty {
            // TS :1153: the rename gate disarms first (:1880), then
            // enters the rename composer.
            if self.keybindings.matches(key, "app.agents.rename") {
                self.enter_rename_mode();
                return;
            }
            // TS :1157: the stop-or-delete two-press grammar — the
            // reply stays armed behind the confirm (TS's gates never
            // touch the reply target).
            if self.keybindings.matches(key, "app.agents.delete") {
                self.confirm_delete_for_selected(was_delete_armed);
                self.composer = Composer::Reply(reply);
                return;
            }
            // TS :1164: the reply key toggles — the same target disarms.
            if self.keybindings.matches(key, "app.agents.reply") {
                self.composer = Composer::Reply(reply);
                self.toggle_reply();
                return;
            }
            // TS :1176: the program toggle — the reply stays armed.
            if self.keybindings.matches(key, "app.agents.program") {
                self.cycle_program_for_selected();
                self.composer = Composer::Reply(reply);
                return;
            }
        }
        // TS :1168: alt+enter queues the reply as a follow-up (the blank
        // draft is a no-op, `handleReplyFollowUp`).
        if self.keybindings.matches(key, "app.message.followUp") {
            // Unlike Enter, this path skips the editor's clear — the
            // send arm clears the buffer itself (TS `handleReplyFollowUp`
            // expands the paste markers here and submits).
            let text = reply.editor.get_expanded_text();
            if text.trim().is_empty() {
                self.composer = Composer::Reply(reply);
            } else {
                self.submit_reply(reply, text, Some(StreamingBehavior::FollowUp));
            }
            return;
        }
        // The editor's own app checks (TS `CustomEditor.handleInput`,
        // :194-224): agents-back disarms before the editor's cursor
        // motions — Left never moves the cursor in the TS reply composer
        // (a surprising TS behavior, ported for parity) — and escape
        // disarms (the editor's `onEscape`).
        if self.keybindings.matches(key, "app.agents.back") {
            self.disarm_reply();
            return;
        }
        if self.keybindings.matches(key, "app.input.clear") {
            self.disarm_reply();
            return;
        }
        // TS :1171 (the editor's `onCtrlD`): exit on an empty draft;
        // a draft in flight keeps the editor's delete-char reading.
        if empty && self.keybindings.matches(key, "app.exit") {
            self.running = false;
            return;
        }
        // The editor owns Enter (TS `editor.handleInput` -> `onSubmit`): it
        // applies an open completion (a typed-exact command falls through and
        // submits), turns a trailing backslash into a newline, and a submit
        // clears the buffer and hands over the trimmed, paste-expanded text.
        // The other events (change/autocomplete/clipboard) have no host here.
        reply.editor.handle_input(key);
        let submitted = reply
            .editor
            .take_events()
            .into_iter()
            .find_map(|event| match event {
                EditorEvent::Submitted(text) => Some(text),
                _ => None,
            });
        match submitted {
            Some(value) => self.submit_reply(reply, value, None),
            None => self.composer = Composer::Reply(reply),
        }
    }

    /// TS `submit` (the reply arm, :1585-1631): the trimmed text routes
    /// through the view commands (`/name`, `/kill`), the rejection, or
    /// the send. `behavior` is the queued follow-up (`None` resolves
    /// steer from the target's streaming state, TS `sendReply`'s
    /// ladder).
    fn submit_reply(
        &mut self,
        mut reply: Box<ReplyComposer>,
        value: String,
        follow_up: Option<StreamingBehavior>,
    ) {
        let text = value.trim().to_string();
        // TS `parseAgentsViewCommand` (the builtin alias resolution over
        // the one view-command name list): the submitted `value` restores
        // on the command's own failures (TS restores `value`, not `text`).
        if let Some((name, args)) = parse_view_command(&text) {
            if name == "name" {
                self.submit_name_command(&mut reply, &value, &args);
            } else {
                self.submit_kill_command(&mut reply, &value);
            }
            self.composer = Composer::Reply(reply);
            return;
        }
        // TS `getReplyComposerCommandRejection`: a builtin that is
        // neither session-owned nor a view command never goes to the
        // model as prompt text; the draft stays.
        if let Some(rejection) = reply_command_rejection(&text) {
            self.set_status_tone(&rejection, StatusTone::Warning);
            restore_reply_draft(&mut reply, &value);
            self.composer = Composer::Reply(reply);
            return;
        }
        if text.is_empty() {
            self.composer = Composer::Reply(reply);
            return;
        }
        reply.editor.set_text("");
        let key = reply.target.key.clone();
        let current = self.current_reply_summary(&reply.target);
        let behavior = follow_up.or_else(|| {
            (current.get("activeSessionId").is_some()
                && current.get("isStreaming").and_then(Value::as_bool) == Some(true))
            .then_some(StreamingBehavior::Steer)
        });
        let (resume_config, cwd_notice) = self.resume_config(&current);
        if current.get("activeSessionId").is_none() {
            self.set_status("Resuming session...");
        }
        reply.in_flight = Some(value);
        self.pending_reply = Some(ReplyRequest {
            key,
            summary: current,
            text,
            behavior,
            resume_config,
            cwd_notice,
        });
        self.composer = Composer::Reply(reply);
    }

    /// The `/name` view command (TS `runAgentsViewCommand`'s name arm):
    /// the rename flow against the CURRENT summary — the wire statuses
    /// ride the rename dispatch; on success the reply disarms, on
    /// failure the draft restores.
    fn submit_name_command(&mut self, reply: &mut Box<ReplyComposer>, value: &str, args: &str) {
        let name = args.trim().to_string();
        if name.is_empty() {
            self.set_status_tone("Usage: /name <session name>", StatusTone::Warning);
            restore_reply_draft(reply, value);
            return;
        }
        let current = self.current_reply_summary(&reply.target);
        let Some(target) = rename_target_from_summary(&current) else {
            self.set_status_tone("This session cannot be renamed", StatusTone::Warning);
            restore_reply_draft(reply, value);
            return;
        };
        reply.in_flight = Some(value.to_string());
        self.set_status("Renaming agent...");
        self.pending_rename = Some(Rename { target, name });
    }

    /// The `/kill` view command (TS `runAgentsViewCommand`'s kill arm):
    /// an inactive target warns; a live one dispatches the kill — an
    /// already-finished agent counts as stopped.
    fn submit_kill_command(&mut self, reply: &mut Box<ReplyComposer>, value: &str) {
        let current = self.current_reply_summary(&reply.target);
        let Some(active) = current
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            self.set_status_tone(
                "/kill needs a running agent; this session is inactive",
                StatusTone::Warning,
            );
            restore_reply_draft(reply, value);
            return;
        };
        reply.in_flight = Some(value.to_string());
        self.pending_kill = Some(KillRequest {
            key: reply.target.key.clone(),
            active_session_id: active.to_string(),
        });
    }

    /// TS `createAgentsViewResumeConfig` + `resolveAgentsViewOpenCwd`
    /// (:225-236 + :493-504): the view's create config with the saved
    /// session's cwd removed — or overridden with the view's cwd (and
    /// its notice) when the saved directory no longer exists.
    fn resume_config(&self, summary: &Value) -> (Value, Option<String>) {
        let mut config = self.options.create_config.clone();
        let saved_cwd = summary
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty());
        let exists = saved_cwd.is_some_and(|cwd| std::path::Path::new(cwd).exists());
        let fallback = self.options.cwd.to_string_lossy().to_string();
        let notice = if saved_cwd.is_none_or(|_| exists) {
            None
        } else {
            Some(format!(
                "Original directory is missing ({}); opened in {fallback} instead.",
                saved_cwd.unwrap_or_default()
            ))
        };
        let override_cwd = notice.is_some().then_some(fallback);
        if let Some(override_cwd) = override_cwd {
            config["cwd"] = serde_json::json!(override_cwd);
        } else if let Some(object) = config.as_object_mut() {
            object.remove("cwd");
        }
        (config, notice)
    }

    /// One landed headline (TS `toggleReplyTarget`'s fetch arms): the
    /// header renders the first line of the fetched text — a
    /// re-targeted or disarmed composer drops the result (the key
    /// comparison, TS's `replyTarget?.key === key` guard).
    pub(super) fn headline_result(&mut self, key: &str, result: Result<Option<String>, String>) {
        if !self.reply_armed_on(key) {
            return;
        }
        match result {
            Ok(text) => {
                if let Composer::Reply(reply) = &mut self.composer {
                    reply.headline = Headline::Loaded(text);
                }
            }
            Err(error) => {
                if let Composer::Reply(reply) = &mut self.composer {
                    reply.headline = Headline::Loaded(None);
                }
                self.set_status(&format!("Failed to load latest response: {error}"));
            }
        }
    }

    /// One landed reply send (TS `sendReply`'s outcomes): the sticky
    /// cwd notice or "Reply sent" on success (the resumed summary
    /// selects when the composer still targets it, and the composer
    /// disarms under TS's unchanged-target-empty-editor guard), the
    /// failure status and the draft restore on error.
    pub(super) fn reply_result(&mut self, key: &str, outcome: Result<ReplySent, String>) {
        match outcome {
            Ok(sent) => {
                self.actions.push("reply_sent");
                if let Some(notice) = sent.cwd_notice {
                    self.status = Some(Status::sticky(&notice));
                } else {
                    self.set_status("Reply sent");
                }
                // The selection follows the resumed summary, and the
                // composer disarms, both under TS's unchanged-composer
                // guard (`this.replyTarget === target`): a re-armed
                // composer carries no in-flight draft, so a late result
                // never disarms over the user's fresh compose.
                if self.reply_in_flight(key) {
                    if let Some(resumed) = sent.resumed {
                        self.select_summary_row(&resumed);
                    }
                    if self.reply_editor_empty(key) {
                        self.disarm_reply();
                    }
                }
            }
            Err(error) => {
                self.set_status(&format!("Failed to send reply: {error}"));
                if self.reply_in_flight(key) && self.reply_editor_empty(key) {
                    self.restore_reply_draft(key);
                }
            }
        }
    }

    /// One landed `/kill` (TS `runAgentsViewCommand`'s kill arm): the
    /// composer disarms under the unchanged-target guard, the status
    /// reports the stop, and the roster push refreshes the rows behind
    /// it (the live row leaves the Running section on the next push).
    pub(super) fn kill_result(&mut self, key: &str, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => {
                self.actions.push("killed");
                // TS's kill arm disarms the unchanged composer with no
                // editor check (`disarmIfUnchanged`); the in-flight
                // draft marks it.
                if self.reply_in_flight(key) {
                    self.disarm_reply();
                }
                self.set_status("Agent stopped");
            }
            Err(error) => {
                self.set_status(&format!("Failed to run /kill: {error}"));
                if self.reply_in_flight(key) && self.reply_editor_empty(key) {
                    self.restore_reply_draft(key);
                }
            }
        }
    }

    /// The composer that dispatched the in-flight send or view command
    /// (TS's object-identity guard `this.replyTarget === target`: a
    /// re-armed composer on the same target carries no in-flight draft,
    /// so a late result never disarms or restores over the user's fresh
    /// compose).
    fn reply_in_flight(&self, key: &str) -> bool {
        matches!(&self.composer, Composer::Reply(reply)
            if reply.target.key == key && reply.in_flight.is_some())
    }

    /// The armed composer's editor is empty (TS's
    /// `this.editor.getText().length === 0` guard).
    fn reply_editor_empty(&self, key: &str) -> bool {
        matches!(&self.composer, Composer::Reply(reply)
            if reply.target.key == key && reply.editor.get_text().is_empty())
    }

    /// TS's draft-restore guard: the in-flight draft goes back only when
    /// the composer is still armed on the same target with an empty
    /// editor (the user did not re-arm elsewhere or start typing).
    fn restore_reply_draft(&mut self, key: &str) {
        if let Composer::Reply(reply) = &mut self.composer {
            if reply.target.key == key && reply.editor.get_text().is_empty() {
                if let Some(draft) = reply.in_flight.take() {
                    reply.editor.set_text(&draft);
                }
            }
        }
    }

    /// TS `selectSummary`: land the selection on the resumed session's
    /// row (the identity the rebuild's restore reads).
    fn select_summary_row(&mut self, summary: &Value) {
        let identity = crate::agents_view_forest::summary_identity(summary);
        if let Some(index) = self.rows.iter().position(|row| row.identity == identity) {
            self.selected = index;
            self.sync_selected_row_state();
        }
    }
}

/// TS's immediate draft restore (the editor the submit cleared): the
/// draft goes back when the composer still sits empty.
fn restore_reply_draft(reply: &mut Box<ReplyComposer>, value: &str) {
    if reply.editor.get_text().is_empty() {
        reply.editor.set_text(value);
    }
}

/// TS `parseAgentsViewCommand`: the row-targeted view commands, through
/// the builtin alias resolution.
fn parse_view_command(text: &str) -> Option<(String, String)> {
    let (typed, args) = parse_slash_command(text)?;
    let registry = SlashCommandRegistry::builtin_cached();
    let name = registry
        .resolve_name(&typed)
        .unwrap_or(typed.as_str())
        .to_string();
    VIEW_COMMAND_NAMES
        .contains(&name.as_str())
        .then_some((name, args))
}

/// TS `getReplyComposerCommandRejection`: a parsed slash command that
/// resolves to a builtin that is neither session-owned nor a view
/// command never goes to the model as plain prompt text.
fn reply_command_rejection(text: &str) -> Option<String> {
    let (typed, _args) = parse_slash_command(text)?;
    let registry = SlashCommandRegistry::builtin_cached();
    let name = registry
        .resolve_name(&typed)
        .unwrap_or(typed.as_str())
        .to_string();
    if is_session_slash_command_name(&name) {
        return None;
    }
    if VIEW_COMMAND_NAMES.contains(&name.as_str()) {
        return None;
    }
    if !registry.is_builtin(&typed) {
        return None;
    }
    Some(format!(
        "/{typed} is not available here; open the session to run it"
    ))
}

/// The rename target a `/name` dispatches against (TS `renameSession`'s
/// order: the live session first, the saved file second): the CURRENT
/// summary's runtime or file — `None` is the cannot-rename warning.
fn rename_target_from_summary(summary: &Value) -> Option<RenameTarget> {
    let active = summary
        .get("activeSessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    if let Some(active) = active {
        return Some(super::rename::RenameTarget::Live {
            active_session_id: active.to_string(),
        });
    }
    let file = summary
        .get("sessionFile")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())?;
    Some(super::rename::RenameTarget::Saved {
        session_path: file.to_string(),
    })
}

/// One headline fetch (TS `getLastAssistantText`): the call runs off the
/// key loop with a client clone, detached — the exit drain never waits
/// on it, and its keyed result drops when the composer is gone or
/// re-targeted.
pub(super) fn spawn_headline_fetch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    key: String,
    active_session_id: String,
) {
    let client = client.clone();
    tokio::spawn(async move {
        let result = match client
            .request(DaemonCommand::GetLastAssistantText {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::default(),
            })
            .await
        {
            Ok(response) if response.success => Ok(response
                .data
                .as_ref()
                .and_then(|data| data.get("text"))
                .cloned()
                .and_then(|text| text.as_str().map(str::to_string))),
            Ok(response) => Err(response
                .error
                .unwrap_or_else(|| "the command failed".into())),
            Err(error) => Err(format!("{error:#}")),
        };
        let _ = ui_tx.send(UiInput::HeadlineResult {
            key,
            result: match result {
                Ok(text) => Ok(text),
                Err(error) => Err(error),
            },
        });
    });
}

/// One reply send (TS `sendReply`, :1981-2026): the saved target resumes
/// into the daemon first (`create` with the resume config), then the
/// prompt delivers through the same path as a live reply — the
/// "Sending reply..." progress rides the wire between the two.
pub(super) fn spawn_reply_dispatch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    request: ReplyRequest,
) -> tokio::task::JoinHandle<()> {
    let client = client.clone();
    let key = request.key.clone();
    tokio::spawn(async move {
        let outcome = send_reply(client, &ui_tx, request).await;
        let _ = ui_tx.send(UiInput::ReplyResult { key, outcome });
    })
}

async fn send_reply(
    client: DaemonClient,
    ui_tx: &mpsc::UnboundedSender<UiInput>,
    request: ReplyRequest,
) -> Result<ReplySent, String> {
    let mut sent = ReplySent {
        resumed: None,
        cwd_notice: None,
    };
    let mut active_session_id = request
        .summary
        .get("activeSessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if active_session_id.is_none() {
        // TS `resumeSavedAgentsViewSession`: the create carries the
        // view's resume config and the saved file; the fresh summary is
        // the authoritative target for the prompt.
        let Some(session_path) = request
            .summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
        else {
            return Err("Cannot resume a session without a saved session file".to_string());
        };
        let telemetry_disabled = request
            .resume_config
            .get("telemetryDisabled")
            .and_then(Value::as_bool)
            .filter(|disabled| *disabled)
            .map(|_| true);
        // The resumed session runs in THIS pane: the create carries the
        // client's Herdr pane identity like every create (a client
        // outside a Herdr pane sends nothing — the wire keeps its shape).
        let client_env = {
            let env =
                pa_types::daemon::herdr_env::collect_client_env(|key| std::env::var(key).ok());
            (!env.is_empty()).then_some(env)
        };
        let created = client
            .request(DaemonCommand::Create {
                id: None,
                session_path: Some(session_path),
                continue_recent: None,
                no_session: None,
                name: None,
                config: Some(request.resume_config.clone()),
                telemetry_disabled,
                runtime_metadata: None,
                lifecycle: None,
                env: client_env,
                launch_env: None,
                rest: serde_json::Map::default(),
            })
            .await;
        let summary = match created {
            Ok(response) if response.success => response.data.unwrap_or(Value::Null),
            Ok(response) => {
                return Err(response
                    .error
                    .unwrap_or_else(|| "the command failed".into()))
            }
            Err(error) => return Err(format!("{error:#}")),
        };
        let Some(active) = summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        else {
            return Err("Daemon returned a session without an active session id".to_string());
        };
        sent.cwd_notice = request.cwd_notice.clone();
        sent.resumed = Some(summary);
        active_session_id = Some(active);
    }
    // TS's mid-send status (after the resume, before the prompt).
    let _ = ui_tx.send(UiInput::ReplyProgress("Sending reply...".to_string()));
    let prompt = client
        .request(DaemonCommand::Prompt {
            id: None,
            active_session_id: active_session_id.unwrap_or_default(),
            message: request.text,
            input: PromptInput {
                content: None,
                images: None,
                streaming_behavior: request.behavior,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: None,
                agent_message_id: None,
                custom_message: None,
                queue_key: None,
                prefix_messages: None,
                admission_id: None,
                rlm_notice_nonce: None,
            },
            rest: serde_json::Map::default(),
        })
        .await;
    match prompt {
        Ok(response) if response.success => Ok(sent),
        Ok(response) => Err(response
            .error
            .unwrap_or_else(|| "the command failed".into())),
        Err(error) => Err(format!("{error:#}")),
    }
}

/// One `/kill` dispatch (TS `runAgentsViewCommand`'s kill arm): an
/// `Unknown active session:` refusal counts as stopped (the agent
/// already finished, TS `isUnknownActiveSessionError`).
pub(super) fn spawn_kill_dispatch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    request: KillRequest,
) -> tokio::task::JoinHandle<()> {
    let client = client.clone();
    let key = request.key.clone();
    tokio::spawn(async move {
        let outcome = match client
            .request(DaemonCommand::Kill {
                id: None,
                active_session_id: request.active_session_id,
                rest: serde_json::Map::default(),
            })
            .await
        {
            Ok(response) if response.success => Ok(()),
            Ok(response)
                if response
                    .error
                    .as_deref()
                    .is_some_and(|error| error.starts_with("Unknown active session:")) =>
            {
                Ok(())
            }
            Ok(response) => Err(response
                .error
                .unwrap_or_else(|| "the command failed".into())),
            Err(error) => Err(format!("{error:#}")),
        };
        let _ = ui_tx.send(UiInput::KillResult { key, outcome });
    })
}
