//! The node view: one state's inspection surface for the run view. The
//! instance list (one row per spawned child across entries) walks with
//! ↑/↓; the selected instance's document renders the session lines, the
//! REALIZED prompt (the exact text the executor handed the child — the
//! template with params and bound inputs substituted), its inputs, its
//! answer, and the entry's settle outputs — Markdown rendered with the
//! same colored renderer the machine view's files view uses, never plain
//! text. Enter toggles the node's TEMPLATE FILES document (today's files
//! view, byte-for-byte the same colored rendering); `o` jumps into the
//! selected instance's child session through the standard session open
//! (the same chat UI every row opens); Esc steps back (files → document
//! → diagram).

use serde_json::Value;
use std::cell::Cell;
use std::fmt::Write as _;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::markdown::{render_markdown, MarkdownStyle};
use crate::theme::{Theme, ThemeColor};
use crate::width::{truncate_line, wrap_line};
use crate::{Line, Span};

use super::diagram::node_glyph;
use super::mermaid::{mermaid_block_lines, split_mermaid_fences, FileSegment};

/// The node reply's malformed-lane error.
pub const MALFORMED_NODE_REPLY_ERROR: &str = "malformed factory reply (no node document)";

/// The node view's return target (the origin a child-session open
/// records): the run, the state, and the selected instance, so leaving
/// the child reopens the run view with the node view mounted on the
/// same instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeTarget {
    pub run_id: String,
    pub state_id: String,
    /// The selected instance's `(entry, index)` selector, when the
    /// instance list carried one.
    pub instance: Option<(u64, u64)>,
}

/// The node's template files (the machine's `library` payload): every
/// file's text once, by path, and each state's file paths — the same
/// reply the machine view's drill-in folds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeFiles {
    pub files: Vec<(String, String)>,
    pub state_files: Vec<(String, Vec<String>)>,
}

impl NodeFiles {
    /// Parse the library payload's file tables; a reply without them
    /// stays empty (the files document reports "no files recorded").
    pub fn parse(data: &Value) -> Self {
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        let files = data
            .get("files")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|file| {
                        Some((
                            scrub(file.get("path")?.as_str()?),
                            scrub(file.get("text")?.as_str()?),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let state_files = data
            .get("stateFiles")
            .or_else(|| data.get("state_files"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let state = scrub(row.get("state")?.as_str()?);
                        let paths = row
                            .get("paths")?
                            .as_array()?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(scrub)
                            .collect();
                        Some((state, paths))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { files, state_files }
    }

    /// The state's files, resolved to their texts.
    fn node_files(&self, state: &str) -> Vec<(&str, &str)> {
        self.state_files
            .iter()
            .find(|(id, _)| id == state)
            .map(|(_, paths)| {
                paths
                    .iter()
                    .filter_map(|path| {
                        self.files
                            .iter()
                            .find(|(known, _)| known == path)
                            .map(|(path, text)| (path.as_str(), text.as_str()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// One state's files document: the header, then each file — Markdown
    /// rendered colored (mermaid fences as diagrams), other files as code.
    /// `owner` names the run or machine the files belong to.
    pub(super) fn document(
        &self,
        theme: &Theme,
        width: usize,
        state: &str,
        owner: &str,
    ) -> Vec<Line> {
        let files = self.node_files(state);
        let mut document = vec![files_header(theme, width, state, owner, files.len())];
        if files.is_empty() {
            document.push(vec![Span::raw("")]);
            document.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "No files recorded for this state."),
            ]);
        }
        let style = MarkdownStyle::from_theme(theme);
        let inner = width.saturating_sub(4).max(20);
        for (path, text) in files {
            document.push(vec![Span::raw("")]);
            let rule = "─".repeat(inner.saturating_sub(path.chars().count() + 4).min(60));
            document.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Accent, format!("── {path} ")),
                theme.fg_span(ThemeColor::Dim, rule),
            ]);
            document.push(vec![Span::raw("")]);
            let rows: Vec<Line> = if std::path::Path::new(path)
                .extension()
                .is_some_and(|ext| ext == "md")
                || path.starts_with("MACHINE.md")
            {
                let mut rows = Vec::new();
                for segment in split_mermaid_fences(text) {
                    match segment {
                        FileSegment::Text(prose) => {
                            rows.extend(render_markdown(&prose, inner, &style));
                        }
                        FileSegment::Mermaid(source) => {
                            rows.extend(mermaid_block_lines(theme, &source));
                        }
                    }
                }
                rows
            } else {
                text.lines()
                    .map(|line| vec![theme.fg_span(ThemeColor::MdCodeBlock, line.to_string())])
                    .collect()
            };
            for row in rows {
                let mut line: Line = vec![Span::raw("  ")];
                line.extend(row);
                document.push(truncate_line(&line, width, ""));
            }
        }
        document
    }
}

/// The files document's header: `node: <state> · <owner> · N files`.
fn files_header(theme: &Theme, width: usize, state: &str, owner: &str, count: usize) -> Line {
    let mut header: Line = vec![Span::raw("  ")];
    header.push(theme.fg_span(ThemeColor::ToolTitle, "node: "));
    header.push(theme.fg_span(ThemeColor::Text, state.to_string()));
    header.push(theme.fg_span(
        ThemeColor::Muted,
        format!(
            " · {owner} · {count} file{}",
            if count == 1 { "" } else { "s" }
        ),
    ));
    truncate_line(&header, width, "")
}

/// One instance row (the node report's instance list).
#[derive(Debug, Clone, PartialEq)]
pub struct NodeInstance {
    pub index: Option<u64>,
    pub entry: Option<u64>,
    pub status: String,
    pub attempt: u64,
    pub child: Option<String>,
    pub duration_ms: Option<u64>,
}

impl NodeInstance {
    fn parse(value: &Value) -> Option<Self> {
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        let number = |field: &str| value.get(field).and_then(Value::as_u64);
        let text = |field: &str| {
            value
                .get(field)
                .and_then(Value::as_str)
                .map(scrub)
                .filter(|text| !text.is_empty())
        };
        Some(Self {
            entry: number("entry"),
            index: number("index"),
            status: scrub(value.get("status")?.as_str()?),
            attempt: number("attempt").unwrap_or(1),
            child: text("child"),
            duration_ms: value
                .get("duration_ms")
                .or_else(|| value.get("durationMs"))
                .and_then(Value::as_u64),
        })
    }

    /// The row's label: `#0 · e0 · running · attempt 1 · 42s`.
    fn label(&self) -> String {
        let mut text = format!(
            "#{} · e{} · {}",
            self.index.unwrap_or_default(),
            self.entry.unwrap_or_default(),
            self.status
        );
        if self.attempt > 1 {
            let attempt = self.attempt;
            write!(text, " · attempt {attempt}").expect("writing to a String cannot fail");
        }
        if let Some(duration) = self.duration_ms {
            let seconds = duration / 1_000;
            write!(text, " · {seconds}s").expect("writing to a String cannot fail");
        }
        text
    }
}

/// The selected entry's settle outputs and, when present, one instance's document.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeDocument {
    pub entry: Option<u64>,
    pub index: Option<u64>,
    pub status: String,
    pub child: Option<String>,
    pub child_name: Option<String>,
    pub session_dir: Option<String>,
    pub prompt: String,
    pub prompt_truncated: bool,
    pub inputs: Option<String>,
    pub inputs_truncated: bool,
    pub answer: Option<String>,
    pub answer_truncated: bool,
    pub provisional: bool,
    pub capture_failed: bool,
    pub outputs: Option<String>,
    pub outputs_truncated: bool,
    pub output_errors: Option<String>,
    pub output_errors_truncated: bool,
    pub error: Option<String>,
}

impl NodeDocument {
    fn parse(entry: &Value, instance: Option<&Value>) -> Option<Self> {
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        let text = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_str)
                .map(scrub)
                .filter(|text| !text.is_empty())
        };
        let raw_text = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_str)
                .map(scrub)
        };
        let flag = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        let entry_flag = |field: &str| entry.get(field).and_then(Value::as_bool).unwrap_or(false);
        // A preview trimmed to nothing still carries its flag: keep the
        // empty section so the view can show the truncation warning instead
        // of hiding the field.
        let preview = |field: &str, truncated: &str| {
            let value = raw_text(field);
            if value.as_ref().is_some_and(|value| !value.is_empty()) || flag(truncated) {
                Some(value.unwrap_or_default())
            } else {
                None
            }
        };
        let entry_text = |field: &str| {
            entry
                .get(field)
                .and_then(Value::as_str)
                .map(scrub)
                .filter(|text| !text.is_empty())
        };
        let number = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_u64)
        };
        let outputs = match entry.get("outputs") {
            Some(Value::String(outputs)) => {
                let outputs = scrub(outputs);
                (!outputs.is_empty() || entry_flag("outputsTruncated")).then_some(outputs)
            }
            None | Some(Value::Null) => None,
            Some(_) => return None,
        };
        let output_errors = match entry.get("outputErrors") {
            Some(Value::Object(errors)) if !errors.is_empty() => {
                Some(scrub(&serde_json::to_string_pretty(errors).ok()?))
            }
            Some(Value::Object(_) | Value::Null) | None => None,
            Some(_) => return None,
        };
        let status = instance
            .and_then(|instance| instance.get("status"))
            .or_else(|| entry.get("status"))
            .and_then(Value::as_str)
            .map(scrub)?;
        Some(Self {
            entry: entry.get("index").and_then(Value::as_u64),
            index: number("index"),
            status,
            child: text("child"),
            child_name: text("childName"),
            session_dir: text("sessionDir"),
            prompt: text("prompt").unwrap_or_default(),
            prompt_truncated: flag("promptTruncated"),
            inputs: preview("inputs", "inputsTruncated"),
            inputs_truncated: flag("inputsTruncated"),
            answer: preview("answer", "answerTruncated"),
            answer_truncated: flag("answerTruncated"),
            provisional: flag("provisional"),
            capture_failed: flag("captureFailed"),
            outputs,
            outputs_truncated: entry_flag("outputsTruncated"),
            output_errors,
            output_errors_truncated: entry_flag("outputErrorsTruncated"),
            // A binding failure before any instance exists records its
            // diagnostic on the entry, not on an instance. Never borrow it
            // for an existing instance: a foreach entry carries the failed
            // sibling's error while its other instances stay healthy.
            error: text("error").or_else(|| {
                if instance.is_none() {
                    entry_text("error")
                } else {
                    None
                }
            }),
        })
    }
}

/// The node view's state: the run + state it inspects, the instance
/// list, the selected instance's document, the template files, and the
/// scrolls.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeView {
    pub run_id: String,
    pub state_id: String,
    pub run_name: String,
    pub instances: Vec<NodeInstance>,
    selected: Option<usize>,
    pub document: Option<NodeDocument>,
    /// The reply named no entry: the state was never entered.
    never_entered: bool,
    pub scroll: usize,
    pub error: Option<String>,
    /// The template-files fetch's failure, independent of the node document.
    files_error: Option<String>,
    /// The node's template files (the `library` payload): `None` until
    /// the fetch lands.
    pub files: Option<NodeFiles>,
    files_open: bool,
    files_scroll: usize,
    /// The active session a template-files fetch is out on: the run's
    /// refresh sends no second one there. A reattach's new active session
    /// drops the old fetch's reply, so it fetches again.
    files_request_session: Option<String>,
    request_epoch: Option<u64>,
    requested_selector: Option<(u64, u64)>,
    last_viewport: Cell<Option<(usize, usize)>>,
}

impl NodeView {
    /// The loading mount: no document yet, no instances yet.
    pub fn loading(run_id: &str, state_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            state_id: state_id.to_string(),
            run_name: String::new(),
            instances: Vec::new(),
            selected: None,
            document: None,
            never_entered: false,
            scroll: 0,
            error: None,
            files_error: None,
            files: None,
            files_open: false,
            files_scroll: 0,
            files_request_session: None,
            request_epoch: None,
            requested_selector: None,
            last_viewport: Cell::new(None),
        }
    }

    /// Parse the `node` action's reply into the view's state.
    pub fn parse_reply(run_id: &str, state_id: &str, data: &Value) -> Option<Self> {
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        let node = data.get("state").or_else(|| data.get("node"))?;
        let mut instances = Vec::new();
        // The node report carries the instances flat (per-state, each row
        // naming its entry); the entries' own rows carry only the entry
        // status.
        if let Some(rows) = node.get("instances").and_then(Value::as_array) {
            instances.extend(rows.iter().filter_map(NodeInstance::parse));
        }
        let name = data
            .get("name")
            .and_then(Value::as_str)
            .map(scrub)
            .filter(|text| !text.is_empty());
        let run_name = name.or_else(|| {
            data.get("specId")
                .and_then(Value::as_str)
                .map(scrub)
                .filter(|text| !text.is_empty())
        });
        let entry = data.get("entry")?;
        let never_entered = entry.is_null();
        let instance = data.get("instance").filter(|instance| !instance.is_null());
        let document = if never_entered {
            None
        } else {
            Some(NodeDocument::parse(entry, instance)?)
        };
        let selected = if document
            .as_ref()
            .is_some_and(|document| document.index.is_none())
        {
            None
        } else {
            (!instances.is_empty()).then_some(0)
        };
        Some(Self {
            run_id: scrub(run_id),
            state_id: scrub(state_id),
            run_name: run_name.unwrap_or_default(),
            instances,
            selected,
            document,
            never_entered,
            scroll: 0,
            error: None,
            files_error: None,
            files: None,
            files_open: false,
            files_scroll: 0,
            files_request_session: None,
            request_epoch: None,
            requested_selector: None,
            last_viewport: Cell::new(None),
        })
    }

    /// The selected instance's (entry, index) selector.
    pub fn selected_selector(&self) -> Option<(u64, u64)> {
        self.selected
            .and_then(|selected| self.instances.get(selected))
            .map(|instance| (instance.entry.unwrap_or(0), instance.index.unwrap_or(0)))
    }

    /// The document's (entry, index) selector.
    pub fn document_selector(&self) -> Option<(u64, u64)> {
        self.document
            .as_ref()
            .and_then(|document| Some((document.entry?, document.index?)))
    }

    /// The selected instance's child id (the jump target; the open rides
    /// the standard session path in the session UI).
    pub fn selected_child(&self) -> Option<&str> {
        self.selected
            .and_then(|selected| self.instances.get(selected))
            .and_then(|instance| instance.child.as_deref())
    }

    /// The return target for a child-session open from this view.
    pub fn target(&self) -> NodeTarget {
        NodeTarget {
            run_id: self.run_id.clone(),
            state_id: self.state_id.clone(),
            instance: self.requested_selector.or(self.selected_selector()),
        }
    }

    /// Fold one `node` reply into the open view: the instance list and
    /// the document replace theirs, the selection follows its instance
    /// when present, the scroll survives refreshes of the same instance,
    /// and the files document (fetched separately) survives. An empty
    /// entry leaves no instance selected.
    /// A malformed reply keeps the last good document and reports on the
    /// error row instead.
    pub fn merge_reply(&mut self, data: &Value) {
        let Some(reply) = Self::parse_reply(&self.run_id, &self.state_id, data) else {
            self.error = Some(MALFORMED_NODE_REPLY_ERROR.to_string());
            return;
        };
        let selection_changed = self.document_selector() != reply.document_selector();
        if !reply.run_name.is_empty() {
            self.run_name = reply.run_name;
        }
        self.requested_selector = None;
        self.instances = reply.instances;
        self.document = reply.document;
        self.never_entered = reply.never_entered;
        self.selected = self.document.as_ref().and_then(|document| {
            let (entry, index) = (document.entry?, document.index?);
            self.instances
                .iter()
                .position(|row| row.entry == Some(entry) && row.index == Some(index))
        });
        if selection_changed {
            self.scroll_to_selected(self.last_viewport.get().map_or(0, |size| size.1));
        }
        self.error = None;
    }

    /// Move the walk to another instance: it drops the fetch the previous
    /// selection had in flight and the error row that fetch set, so the
    /// document never reads as failed while it shows another instance's
    /// good reply.
    fn move_selection(&mut self, selected: Option<usize>, viewport_rows: usize) {
        self.selected = selected;
        self.scroll_to_selected(viewport_rows);
        self.request_epoch = None;
        self.requested_selector = None;
        self.error = None;
    }

    fn scroll_to_selected(&mut self, viewport_rows: usize) {
        self.scroll = self.selected.map_or(0, |index| {
            index.saturating_sub(visible_rows(viewport_rows, self.error.is_some()) - 1)
        });
    }

    /// Mark the newest node-document request for this mounted view.
    pub fn set_request_epoch(&mut self, request_epoch: u64, selector: Option<(u64, u64)>) {
        self.request_epoch = Some(request_epoch);
        self.requested_selector = selector;
    }

    /// Whether the mounted view is waiting for a node-document reply.
    pub fn request_in_flight(&self) -> bool {
        self.request_epoch.is_some()
    }

    /// Apply a node-document reply only if no newer instance fetch replaced it.
    pub fn apply_request_result(
        &mut self,
        request_epoch: u64,
        result: Result<Value, String>,
    ) -> bool {
        if self.request_epoch != Some(request_epoch) {
            return false;
        }
        self.request_epoch = None;
        match result {
            Ok(data) => self.merge_reply(&data),
            Err(message) => self.set_error(&message),
        }
        true
    }

    /// Record the node fetch's failure on the error row (the last good
    /// document stays).
    pub fn set_error(&mut self, message: &str) {
        self.error = Some(crate::menu_panel::scrub_controls(message));
    }

    /// Fold the template-files fetch (the machine's `library` payload)
    /// into the view.
    pub fn set_files(&mut self, files: NodeFiles) {
        self.files = Some(files);
        self.files_error = None;
        self.files_request_session = None;
    }

    /// Record a template-files fetch failure without replacing the node's
    /// own document error or last good file snapshot.
    pub fn set_files_error(&mut self, message: &str) {
        self.files_error = Some(crate::menu_panel::scrub_controls(message));
        self.files_request_session = None;
    }

    /// Whether the view still needs its template files and no fetch for
    /// them is out on `active_session_id`.
    pub fn wants_files(&self, active_session_id: &str) -> bool {
        self.files.is_none() && self.files_request_session.as_deref() != Some(active_session_id)
    }

    /// Record that a template-files fetch went out on `active_session_id`.
    pub fn mark_files_requested(&mut self, active_session_id: &str) {
        self.files_request_session = Some(active_session_id.to_string());
    }

    /// One Esc: the files document closes first (back to the instance
    /// document); the caller closes the view when this returns `false`.
    pub fn step_back(&mut self) -> bool {
        if self.files_open {
            self.files_open = false;
            return true;
        }
        false
    }

    /// One key press. Returns `true` when the view handled it.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager, viewport_rows: usize) -> bool {
        if kb.matches(key, "tui.select.confirm") {
            // Enter toggles the template-files document (the machine
            // view's own files surface, colored as today).
            self.files_open = !self.files_open;
            self.files_scroll = 0;
            return true;
        }
        let up = kb.matches(key, "tui.select.up");
        let down = kb.matches(key, "tui.select.down");
        let page_up = kb.matches(key, "tui.select.pageUp");
        let page_down = kb.matches(key, "tui.select.pageDown");
        if self.files_open {
            let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
            let width = self.last_viewport.get().map_or(0, |size| size.0);
            let total = self.files_document(&theme, width).len();
            let visible = visible_rows(viewport_rows, self.files_error.is_some());
            let step = if page_up || page_down { visible } else { 1 };
            let delta = if up || page_up {
                -(step as isize)
            } else if down || page_down {
                step as isize
            } else {
                return false;
            };
            let max_scroll = total.saturating_sub(visible);
            self.files_scroll = self.files_scroll.min(max_scroll);
            self.files_scroll =
                (self.files_scroll as isize + delta).clamp(0, max_scroll as isize) as usize;
            return true;
        }
        if up {
            let selected = match self.selected {
                Some(selected) if selected > 0 => Some(selected - 1),
                Some(_) => self.selected,
                None => self.instances.len().checked_sub(1),
            };
            if selected != self.selected {
                self.move_selection(selected, viewport_rows);
            }
            return true;
        }
        if down {
            let selected = match self.selected {
                Some(selected) if selected.saturating_add(1) < self.instances.len() => {
                    Some(selected.saturating_add(1))
                }
                Some(_) => self.selected,
                None => (!self.instances.is_empty()).then_some(0),
            };
            if selected != self.selected {
                self.move_selection(selected, viewport_rows);
            }
            return true;
        }
        if page_up || page_down {
            let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
            let width = self
                .last_viewport
                .get()
                .map_or(0, |size| size.0)
                .saturating_sub(4)
                .max(1);
            let total = self.document_lines(Some(&theme), width).len();
            let visible = visible_rows(viewport_rows, self.error.is_some());
            let max_scroll = total.saturating_sub(visible);
            self.scroll = self.scroll.min(max_scroll);
            self.scroll = if page_up {
                self.scroll.saturating_sub(visible)
            } else {
                self.scroll.saturating_add(visible).min(max_scroll)
            };
            return true;
        }
        false
    }

    /// The instance document's rows: the instance list, then the
    /// selected instance's sections. Markdown sections render through
    /// the shared Markdown renderer; JSON sections render as code.
    fn document_lines(&self, theme: Option<&Theme>, width: usize) -> Vec<Line> {
        let mut rows: Vec<Line> = Vec::new();
        for (index, instance) in self.instances.iter().enumerate() {
            let (glyph, color) = node_glyph(&instance.status);
            let marker = if self.selected == Some(index) {
                "▸ "
            } else {
                "  "
            };
            if let Some(theme) = theme {
                rows.push(vec![
                    Span::raw(marker),
                    theme.fg_span(color, glyph.to_string()),
                    Span::raw(" "),
                    theme.fg_span(color, instance.label()),
                ]);
            } else {
                rows.push(vec![Span::raw(format!(
                    "{marker}{glyph} {}",
                    instance.label()
                ))]);
            }
        }
        if self.instances.is_empty() {
            // No document yet reads as loading, and a failed first fetch
            // reads as its error row alone; only a settled reply that
            // carries an entry may claim the state created no instance.
            let text = if self.never_entered {
                Some("  not yet entered")
            } else if self.document.is_some() {
                Some("  no instances were created")
            } else if self.error.is_none() {
                Some("  loading…")
            } else {
                None
            };
            if let Some(text) = text {
                plain_line(&mut rows, theme, text, ThemeColor::Muted);
            }
        }
        if self.selected_selector() != self.document_selector() {
            return rows;
        }
        let Some(document) = &self.document else {
            return rows;
        };
        let style = theme.map(MarkdownStyle::from_theme);
        let section = |rows: &mut Vec<Line>, title: &str| {
            if let Some(theme) = theme {
                rows.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::ToolTitle, title.to_string()),
                ]);
            } else {
                rows.push(vec![Span::raw(format!("  {title}"))]);
            }
        };
        let code = |rows: &mut Vec<Line>, text: &str| {
            for line in text.lines() {
                let styled = if let Some(theme) = theme {
                    vec![theme.fg_span(ThemeColor::MdCodeBlock, line.to_string())]
                } else {
                    vec![Span::raw(line.to_string())]
                };
                rows.extend(wrap_line(&styled, width));
            }
        };
        let markdown = |rows: &mut Vec<Line>, text: &str| {
            if let Some(style) = &style {
                for row in render_markdown(text, width, style) {
                    let mut line: Line = vec![Span::raw("    ")];
                    line.extend(row);
                    rows.push(line);
                }
            } else {
                for line in text.lines() {
                    rows.push(vec![Span::raw(format!("    {line}"))]);
                }
            }
        };
        // The session lines first: what runs here, where it lives.
        rows.push(vec![Span::raw("")]);
        section(&mut rows, "session");
        if let Some(child) = &document.child {
            plain_line(
                &mut rows,
                theme,
                &format!("    child {child}"),
                ThemeColor::Text,
            );
        }
        if let Some(name) = &document.child_name {
            plain_line(
                &mut rows,
                theme,
                &format!("    name {name}"),
                ThemeColor::Muted,
            );
        }
        if let Some(dir) = &document.session_dir {
            plain_line(
                &mut rows,
                theme,
                &format!("    dir {dir}"),
                ThemeColor::Muted,
            );
        }
        if document.status != "running" {
            plain_line(
                &mut rows,
                theme,
                &format!("    status {}", document.status),
                ThemeColor::Muted,
            );
        }
        // The realized prompt is the exact text the child received.
        rows.push(vec![Span::raw("")]);
        section(&mut rows, "realized prompt");
        if document.prompt.is_empty() {
            if document.prompt_truncated {
                plain_line(&mut rows, theme, "    … (truncated)", ThemeColor::Warning);
            } else {
                let text = if document.entry.is_some()
                    && document.index.is_none()
                    && matches!(document.status.as_str(), "done" | "error" | "cancelled")
                {
                    "    (the entry settled without creating an instance)"
                } else if document.capture_failed {
                    "    (the answer capture failed; no realized prompt is available)"
                } else {
                    "    (not yet entered — nothing realized)"
                };
                plain_line(&mut rows, theme, text, ThemeColor::Muted);
            }
        } else {
            markdown(&mut rows, &document.prompt);
            if document.prompt_truncated {
                plain_line(&mut rows, theme, "    … (truncated)", ThemeColor::Warning);
            }
        }
        // The inputs the executor bound.
        if let Some(inputs) = &document.inputs {
            rows.push(vec![Span::raw("")]);
            section(&mut rows, "inputs");
            code(&mut rows, inputs);
            if document.inputs_truncated {
                plain_line(&mut rows, theme, "    … (truncated)", ThemeColor::Warning);
            }
        }
        // The child's answer.
        if let Some(answer) = &document.answer {
            rows.push(vec![Span::raw("")]);
            let title = if document.provisional {
                "answer (provisional)"
            } else {
                "answer"
            };
            section(&mut rows, title);
            markdown(&mut rows, answer);
            if document.answer_truncated {
                plain_line(&mut rows, theme, "    … (truncated)", ThemeColor::Warning);
            }
        }
        // The entry's settle outputs.
        if let Some(outputs) = &document.outputs {
            rows.push(vec![Span::raw("")]);
            section(&mut rows, "outputs");
            code(&mut rows, outputs);
            if document.outputs_truncated {
                plain_line(&mut rows, theme, "    … (truncated)", ThemeColor::Warning);
            }
        }
        if document.output_errors.is_some() || document.output_errors_truncated {
            rows.push(vec![Span::raw("")]);
            section(&mut rows, "output errors");
            if let Some(errors) = &document.output_errors {
                code(&mut rows, errors);
            }
            if document.output_errors_truncated {
                plain_line(
                    &mut rows,
                    theme,
                    "    … (truncated to fit the activity frame)",
                    ThemeColor::Warning,
                );
            }
        }
        if let Some(error) = &document.error {
            rows.push(vec![Span::raw("")]);
            section(&mut rows, "error");
            for line in error.lines() {
                let styled = if let Some(theme) = theme {
                    vec![theme.fg_span(ThemeColor::Error, format!("    {line}"))]
                } else {
                    vec![Span::raw(format!("    {line}"))]
                };
                rows.extend(wrap_line(&styled, width));
            }
        }
        rows
    }

    /// The node's template files: the machine drill-in's files document,
    /// or a loading row until the fetch lands.
    fn files_document(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let owner = if self.run_name.is_empty() {
            &self.run_id
        } else {
            &self.run_name
        };
        if let Some(files) = &self.files {
            return files.document(theme, width, &self.state_id, owner);
        }
        let mut document = vec![files_header(theme, width, &self.state_id, owner, 0)];
        if self.files_error.is_none() {
            document.push(vec![Span::raw("")]);
            document.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "Loading files…"),
            ]);
        }
        document
    }

    /// The page's rows: the header, the windowed document, the hint.
    pub fn render(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        viewport_rows: usize,
    ) -> Vec<Line> {
        let mut header: Line = vec![Span::raw("  ")];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "node: "));
        header.push(theme.fg_span(ThemeColor::Text, self.state_id.clone()));
        header.push(theme.fg_span(
            ThemeColor::Muted,
            format!(
                " · {}",
                if self.run_name.is_empty() {
                    // The run id is kept raw for daemon round-tripping; a
                    // header is user-facing text, so it is scrubbed here.
                    crate::menu_panel::scrub_controls(&self.run_id)
                } else {
                    self.run_name.clone()
                }
            ),
        ));
        let mut rows = vec![header, vec![Span::raw("")]];
        self.last_viewport.set(Some((width, viewport_rows)));
        let inner_width = width.saturating_sub(4).max(1);

        let (document, scroll) = if self.files_open {
            (self.files_document(theme, width), self.files_scroll)
        } else {
            (self.document_lines(Some(theme), inner_width), self.scroll)
        };
        let error = if self.files_open {
            self.files_error.as_ref()
        } else {
            self.error.as_ref()
        };
        let error_rows = usize::from(error.is_some());
        let visible = visible_rows(viewport_rows, error.is_some());
        let scroll = scroll.min(document.len().saturating_sub(visible));
        rows.extend(document.into_iter().skip(scroll).take(visible));
        while rows.len() < viewport_rows.saturating_sub(2 + error_rows) {
            rows.push(vec![]);
        }
        if let Some(error) = error {
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        rows.push(vec![Span::raw("")]);
        rows.push(vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Dim, self.hint(kb)),
        ]);
        rows.into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }

    /// The bottom hint line.
    fn hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let arrows = format!(
            "{}/{}",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}")
        );
        let pages = format!(
            "{}/{}",
            key("tui.select.pageUp", "PgUp"),
            key("tui.select.pageDown", "PgDn")
        );
        let esc = key("tui.select.cancel", "Esc");
        if self.files_open {
            return format!(
                "{arrows}/{pages} scroll · {}/{esc} back to node document",
                key("tui.select.confirm", "Enter")
            );
        }
        format!(
            "{arrows} instance · {pages} scroll · {} files · o open session · {esc} back",
            key("tui.select.confirm", "Enter")
        )
    }
}

/// One plain (non-Markdown) line at the document's fixed styles.
fn plain_line(rows: &mut Vec<Line>, theme: Option<&Theme>, text: &str, color: ThemeColor) {
    if let Some(theme) = theme {
        rows.push(vec![theme.fg_span(color, text.to_string())]);
    } else {
        rows.push(vec![Span::raw(text.to_string())]);
    }
}

/// The document height after the header, footer, and optional error row.
fn visible_rows(viewport_rows: usize, has_error: bool) -> usize {
    viewport_rows
        .saturating_sub(6 + usize::from(has_error))
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply_with_instances(count: usize) -> Value {
        json!({
            "state": {"instances": (0..count).map(|index| json!({
                "entry": 0, "index": index, "status": "running"
            })).collect::<Vec<_>>()},
            "entry": {"index": 0, "status": "running"},
            "instance": {"index": 0, "status": "running", "prompt": "old prompt",
                "answer": "old answer", "outputs": {"value": "old output"}},
        })
    }

    #[test]
    fn moving_below_the_viewport_keeps_the_selected_instance_visible() {
        let reply = reply_with_instances(30);
        let mut node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let kb = KeybindingsManager::new();
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        for _ in 0..20 {
            assert!(node.handle_key("down", &kb, 12));
        }
        assert_eq!(node.selected_selector(), Some((0, 20)));
        let rows = node.render(&theme, 80, &kb, 12);
        assert!(rows.iter().flatten().any(|span| span.content.contains('▸')));
        let mut reply = reply;
        reply["instance"]["index"] = json!(20);
        node.merge_reply(&reply);
        let rows = node.render(&theme, 80, &kb, 12);
        assert!(rows.iter().flatten().any(|span| span.content.contains('▸')));
        let mut restored = NodeView::loading("run", "worker");
        restored.merge_reply(&reply);
        let rows = restored.render(&theme, 80, &kb, 12);
        assert!(rows.iter().flatten().any(|span| span.content.contains('▸')));
    }

    #[test]
    fn page_up_clamps_after_refresh_or_a_larger_viewport() {
        let mut reply = reply_with_instances(1);
        reply["instance"]["prompt"] = json!("long row\n".repeat(200));
        let mut node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let kb = KeybindingsManager::new();
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        node.render(&theme, 80, &kb, 20);
        node.scroll = 150;
        reply["instance"]["prompt"] = json!("short row\n".repeat(40));
        node.merge_reply(&reply);
        let visible = visible_rows(20, false);
        let total = node.document_lines(Some(&theme), 76).len();
        let end = total.saturating_sub(visible);
        assert!(node.handle_key("pageup", &kb, 20));
        assert_eq!(node.scroll, end.saturating_sub(visible));

        node.scroll = total.saturating_sub(visible_rows(12, false));
        let larger_visible = visible_rows(30, false);
        assert!(node.handle_key("pageup", &kb, 30));
        assert_eq!(
            node.scroll,
            total
                .saturating_sub(larger_visible)
                .saturating_sub(larger_visible)
        );
    }

    #[test]
    fn files_page_up_moves_from_the_clamped_end_after_refresh_or_resize() {
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        for refresh in [false, true] {
            let mut node =
                NodeView::parse_reply("run", "worker", &reply_with_instances(1)).unwrap();
            node.set_files(NodeFiles {
                files: vec![("prompt.md".to_string(), "# file row\n".repeat(100))],
                state_files: vec![("worker".to_string(), vec!["prompt.md".to_string()])],
            });
            assert!(node.handle_key("enter", &kb, 12));
            node.render(&theme, 80, &kb, 12);
            node.files_scroll = node.files_document(&theme, 80).len() - visible_rows(12, false);
            if refresh {
                node.set_files(NodeFiles {
                    files: vec![("prompt.md".to_string(), "# file row\n".repeat(40))],
                    state_files: vec![("worker".to_string(), vec!["prompt.md".to_string()])],
                });
            }
            let viewport_rows = 30;
            node.render(&theme, 80, &kb, viewport_rows);
            let visible = visible_rows(viewport_rows, false);
            let end = node
                .files_document(&theme, 80)
                .len()
                .saturating_sub(visible);
            assert!(node.handle_key("pageup", &kb, viewport_rows));
            assert_eq!(node.files_scroll, end.saturating_sub(visible));
        }
    }

    #[test]
    fn long_input_output_and_output_error_values_remain_readable() {
        let input = format!("{}input_tail", "input_value".repeat(12));
        let output = format!("{}output_tail", "output_value".repeat(12));
        let output_error = format!("{}error_tail", "error_value".repeat(12));
        let mut reply = reply_with_instances(1);
        reply["instance"]["inputs"] = json!(format!("{{\"input\":\"{input}\"}}"));
        reply["entry"]["outputs"] = json!(format!("{{\"output\":\"{output}\"}}"));
        reply["entry"]["outputErrors"] = json!({"output": output_error});
        let node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let text = node
            .render(&theme, 40, &KeybindingsManager::new(), 100)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        for value in [input, output, output_error] {
            assert!(text.contains(&value), "clipped value: {value}");
        }
    }

    #[test]
    fn long_daemon_errors_wrap_instead_of_clipping_their_tail() {
        let error = format!(
            "Traceback (most recent call last):\n{}ValueError: terminal_error_tail_marker",
            "  File \"worker.py\", line 1, in <module>\n".repeat(8)
        );
        let mut reply = reply_with_instances(1);
        reply["instance"]["error"] = json!(error);
        let node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let text = node
            .render(&theme, 40, &KeybindingsManager::new(), 200)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        assert!(
            text.contains("terminal_error_tail_marker"),
            "the error tail was clipped: {text}"
        );
    }

    #[test]
    fn node_fetch_errors_render_without_terminal_controls() {
        let mut node = NodeView::loading("run", "worker");
        node.set_error("fetch failed\u{1b}]52;c;ZXZpbA==\u{7}");
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let text = node
            .render(&theme, 80, &KeybindingsManager::new(), 12)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        assert!(text.contains("Error: fetch failed"), "{text:?}");
        assert!(!text.contains(['\u{1b}', '\u{7}']), "{text:?}");
    }

    #[test]
    fn a_healthy_instance_does_not_borrow_the_entry_error() {
        let reply = json!({
            "state": {"instances": [{"entry": 0, "index": 1, "status": "done"}]},
            "entry": {"index": 0, "status": "error", "error": "sibling 0 failed"},
            "instance": {"entry": 0, "index": 1, "status": "done", "prompt": "healthy"},
        });
        let node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        assert_eq!(node.document.as_ref().unwrap().error, None);
    }

    #[test]
    fn an_entry_error_reaches_the_document_without_an_instance() {
        let reply = json!({
            "state": {"instances": []},
            "entry": {
                "index": 3,
                "status": "error",
                "error": "input 'items' from state 'src' is unavailable",
            },
            "instance": null,
        });
        let node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        assert_eq!(
            node.document.as_ref().unwrap().error.as_deref(),
            Some("input 'items' from state 'src' is unavailable")
        );
        let text = node
            .document_lines(None, 80)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        assert!(text.contains("is unavailable"), "{text}");
    }

    #[test]
    fn previews_truncated_to_empty_keep_their_sections_and_warnings() {
        let reply = json!({
            "state": {"instances": [{"entry": 0, "index": 0, "status": "done"}]},
            "entry": {"index": 0, "status": "done", "outputs": "", "outputsTruncated": true},
            "instance": {
                "index": 0, "status": "done",
                "prompt": "", "promptTruncated": true,
                "inputs": "", "inputsTruncated": true,
                "answer": "", "answerTruncated": true,
            },
        });
        let node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let document = node.document.as_ref().unwrap();
        assert_eq!(document.inputs.as_deref(), Some(""));
        assert_eq!(document.answer.as_deref(), Some(""));
        assert_eq!(document.outputs.as_deref(), Some(""));
        let text = node
            .document_lines(None, 80)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        for section in ["realized prompt", "inputs", "answer", "outputs"] {
            assert!(text.contains(section), "missing {section}: {text}");
        }
        assert!(!text.contains("not yet entered"), "{text}");
        assert_eq!(text.matches("truncated").count(), 4, "{text}");
    }

    #[test]
    fn files_back_hint_matches_the_document_return_target() {
        let mut node = NodeView::parse_reply("run", "worker", &reply_with_instances(1)).unwrap();
        node.set_files(NodeFiles {
            files: vec![("prompt.md".to_string(), "file body".to_string())],
            state_files: vec![("worker".to_string(), vec!["prompt.md".to_string()])],
        });
        let kb = KeybindingsManager::new();
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        assert!(node.handle_key("enter", &kb, 20));
        let files_rows = node.render(&theme, 160, &kb, 20);
        let hint = files_rows
            .last()
            .unwrap()
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(hint.contains("back to node document"));
        assert!(node.step_back());
        let document = node
            .render(&theme, 160, &kb, 20)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        assert!(document.contains("old prompt"));
        assert!(!document.contains("file body"));
        assert!(!node.step_back());
    }

    #[test]
    fn failed_explicit_request_keeps_its_selector_for_the_retry() {
        for mut node in [
            NodeView::loading("run", "worker"),
            NodeView::parse_reply("run", "worker", &reply_with_instances(4)).unwrap(),
        ] {
            node.set_request_epoch(1, Some((2, 3)));
            assert!(node.apply_request_result(1, Err("timeout".to_string())));
            assert!(!node.request_in_flight());
            assert_eq!(node.target().instance, Some((2, 3)));
            let mut reply = reply_with_instances(4);
            reply["entry"]["index"] = json!(2);
            reply["instance"]["index"] = json!(3);
            reply["state"]["instances"][3]["entry"] = json!(2);
            node.set_request_epoch(2, node.target().instance);
            assert!(node.apply_request_result(2, Ok(reply)));
            assert_eq!(node.target().instance, Some((2, 3)));
            assert!(node.handle_key("up", &KeybindingsManager::new(), 20));
            assert_eq!(node.target().instance, Some((0, 2)));
        }
    }

    #[test]
    fn a_changed_selection_hides_the_previous_instances_sections() {
        let reply = reply_with_instances(2);
        let mut node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let kb = KeybindingsManager::new();
        assert!(node.handle_key("down", &kb, 20));
        node.set_request_epoch(1, Some((0, 1)));
        assert!(node.apply_request_result(1, Err("timeout".to_string())));
        let text = node
            .document_lines(None, 80)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        for stale in ["old prompt", "old answer", "old output"] {
            assert!(!text.contains(stale), "stale detail: {stale}");
        }
        assert!(node.handle_key("up", &kb, 20));
        let text = node
            .document_lines(None, 80)
            .into_iter()
            .flatten()
            .map(|span| span.content)
            .collect::<String>();
        assert!(text.contains("old prompt"));
    }

    #[test]
    fn returning_to_the_loaded_instance_rejects_the_pending_reply() {
        let reply = json!({
            "state": {"instances": [
                {"entry": 0, "index": 0, "status": "running"},
                {"entry": 0, "index": 1, "status": "running"},
            ]},
            "entry": {"index": 0, "status": "running"},
            "instance": {"index": 0, "status": "running", "prompt": "loaded"},
        });
        let mut node = NodeView::parse_reply("run", "worker", &reply).unwrap();
        let kb = KeybindingsManager::new();
        assert!(node.handle_key("down", &kb, 20));
        node.set_request_epoch(7, None);
        assert!(node.handle_key("up", &kb, 20));
        let mut late = reply;
        late["instance"]["index"] = json!(1);
        late["instance"]["prompt"] = json!("superseded");
        assert!(!node.apply_request_result(7, Ok(late)));
        assert_eq!(node.selected_selector(), Some((0, 0)));
        assert_eq!(node.document.unwrap().prompt, "loaded");
    }

    #[test]
    fn refreshing_the_same_instance_preserves_document_scroll() {
        let mut reply = json!({
            "state": {"instances": [
                {"entry": 0, "index": 0, "status": "running"},
                {"entry": 0, "index": 1, "status": "running"},
            ]},
            "entry": {"index": 0, "status": "running"},
            "instance": {"index": 0, "status": "running", "prompt": "body row\n".repeat(20)},
        });
        let mut node = NodeView::parse_reply("run", "worker", &reply).expect("node reply");
        node.scroll = 5;
        reply["instance"]["answer"] = json!("new answer");
        node.merge_reply(&reply);
        assert_eq!(node.scroll, 5);

        reply["instance"]["index"] = json!(1);
        node.merge_reply(&reply);
        assert_eq!(node.scroll, 1);
    }

    #[test]
    fn node_replies_clear_only_the_current_pending_request() {
        let mut node = NodeView::loading("run", "worker");
        node.set_request_epoch(1, None);
        node.set_request_epoch(2, None);
        assert!(!node.apply_request_result(1, Err("stale".to_string())));
        assert!(node.request_in_flight());
        assert!(node.apply_request_result(2, Err("current".to_string())));
        assert!(!node.request_in_flight());
        assert!(!node.apply_request_result(2, Err("duplicate".to_string())));
        assert_eq!(node.error.as_deref(), Some("current"));
    }

    #[test]
    fn malformed_documents_preserve_the_last_good_reply() {
        let reply = json!({
            "state": {"instances": [{"entry": 0, "index": 0, "status": "done"}]},
            "entry": {"index": 0, "status": "done", "outputs": "saved outputs"},
            "instance": {"index": 0, "status": "done", "prompt": "saved prompt"},
        });
        let good = NodeView::parse_reply("run", "worker", &reply).expect("node reply");
        for malformed in [
            json!({"index": 0, "outputs": "new outputs"}),
            json!({"index": 0, "status": "done", "outputs": {"invalid": true}}),
            json!({"index": 0, "status": "done", "outputErrors": "invalid"}),
        ] {
            let mut bad_reply = reply.clone();
            bad_reply["entry"] = malformed;
            bad_reply["instance"] = Value::Null;
            let mut node = good.clone();
            node.merge_reply(&bad_reply);
            let mut expected = good.clone();
            expected.error = Some(MALFORMED_NODE_REPLY_ERROR.to_string());
            assert_eq!(node, expected);
        }
        let mut never_entered = reply;
        never_entered["entry"] = Value::Null;
        never_entered["instance"] = Value::Null;
        let mut node = good;
        node.merge_reply(&never_entered);
        assert!(node.never_entered);
        assert_eq!(node.document, None);
        assert_eq!(node.error, None);
    }

    #[test]
    fn paging_reaches_the_document_tail_in_small_viewports() {
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let keybindings = KeybindingsManager::new();
        let content = format!("{}tail marker", "body row\n".repeat(20));
        for files_open in [false, true] {
            for with_error in [false, true] {
                for viewport_rows in [6, 8, 12] {
                    let mut node = NodeView::loading("run", "worker");
                    node.document = Some(NodeDocument {
                        status: "done".to_string(),
                        outputs: Some(content.clone()),
                        ..NodeDocument::default()
                    });
                    node.set_files(NodeFiles {
                        files: vec![("prompt.md".to_string(), content.clone())],
                        state_files: vec![("worker".to_string(), vec!["prompt.md".to_string()])],
                    });
                    if with_error {
                        if files_open {
                            node.set_files_error("refresh failed");
                        } else {
                            node.set_error("refresh failed");
                        }
                    }
                    node.files_open = files_open;
                    node.render(&theme, 80, &keybindings, viewport_rows);
                    for _ in 0..50 {
                        assert!(node.handle_key("pagedown", &keybindings, viewport_rows));
                    }
                    let rows = node.render(&theme, 80, &keybindings, viewport_rows);
                    let text = rows
                        .iter()
                        .flatten()
                        .map(|span| span.content.as_str())
                        .collect::<String>();
                    assert!(
                        text.contains("tail marker"),
                        "tail inaccessible: files={files_open}, error={with_error}, rows={viewport_rows}"
                    );
                    if with_error {
                        assert!(text.contains("refresh failed"));
                    }
                }
            }
        }
    }

    #[test]
    fn moving_the_instance_walk_changes_the_node_selector() {
        let reply = json!({
            "name": "machine",
            "state": {
                "id": "worker",
                "status": "done",
                "instances": [
                    {"entry": 0, "index": 0, "status": "done"},
                    {"entry": 0, "index": 1, "status": "done"},
                ],
            },
            "entry": {"index": 0, "status": "done"},
            "instance": {
                "entry": 0,
                "index": 0,
                "status": "done",
                "prompt": "first prompt",
            },
        });
        let mut node = NodeView::parse_reply("run", "worker", &reply).expect("node reply");
        let keybindings = KeybindingsManager::new();
        assert_eq!(node.selected_selector(), Some((0, 0)));
        assert_eq!(node.document_selector(), Some((0, 0)));

        assert!(node.handle_key("down", &keybindings, 20));
        assert_eq!(node.selected_selector(), Some((0, 1)));
        assert_eq!(node.document_selector(), Some((0, 0)));
    }

    #[test]
    fn the_loading_mount_reads_as_loading_not_as_an_empty_node() {
        let document_text = |node: &NodeView| {
            node.document_lines(None, 80)
                .into_iter()
                .flatten()
                .map(|span| span.content)
                .collect::<String>()
        };
        let mut node = NodeView::loading("run", "worker");
        assert!(document_text(&node).contains("loading…"));
        assert!(!document_text(&node).contains("no instances were created"));
        node.set_error("request failed");
        assert!(!document_text(&node).contains("no instances were created"));
        assert!(!document_text(&node).contains("loading…"));
        node.error = None;
        node.merge_reply(&json!({
            "state": {"instances": []},
            "entry": {"index": 0, "status": "pending"},
            "instance": null,
        }));
        let text = document_text(&node);
        assert!(text.contains("no instances were created"));
        assert!(!text.contains("loading…"));
    }

    #[test]
    fn moving_the_walk_clears_the_previous_fetch_error() {
        let mut node = NodeView::parse_reply("run", "worker", &reply_with_instances(2)).unwrap();
        let keybindings = KeybindingsManager::new();
        assert!(node.handle_key("down", &keybindings, 20));
        node.set_request_epoch(1, Some((0, 1)));
        assert!(node.apply_request_result(1, Err("request failed".to_string())));
        assert_eq!(node.error.as_deref(), Some("request failed"));
        assert!(node.handle_key("up", &keybindings, 20));
        assert_eq!(node.selected_selector(), Some((0, 0)));
        assert_eq!(node.document_selector(), Some((0, 0)));
        assert!(node.error.is_none());
    }

    #[test]
    fn a_files_fetch_in_flight_holds_the_next_one() {
        let mut node = NodeView::loading("run", "worker");
        assert!(node.wants_files("s1"));
        node.mark_files_requested("s1");
        assert!(!node.wants_files("s1"), "one fetch at a time");
        node.set_files_error("library request failed");
        assert!(node.wants_files("s1"), "a failed fetch may retry");
        node.mark_files_requested("s1");
        node.set_files(NodeFiles::default());
        assert!(!node.wants_files("s1"), "landed files need no fetch");
    }
}
