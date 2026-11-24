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
use crate::width::truncate_line;
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
        let flag = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        let entry_flag = |field: &str| entry.get(field).and_then(Value::as_bool).unwrap_or(false);
        let number = |field: &str| {
            instance
                .and_then(|instance| instance.get(field))
                .and_then(Value::as_u64)
        };
        let outputs = match entry.get("outputs") {
            Some(Value::String(outputs)) => Some(scrub(outputs)).filter(|text| !text.is_empty()),
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
            inputs: text("inputs"),
            inputs_truncated: flag("inputsTruncated"),
            answer: text("answer"),
            answer_truncated: flag("answerTruncated"),
            provisional: flag("provisional"),
            capture_failed: flag("captureFailed"),
            outputs,
            outputs_truncated: entry_flag("outputsTruncated"),
            output_errors,
            output_errors_truncated: entry_flag("outputErrorsTruncated"),
            error: text("error"),
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
    request_epoch: u64,
    last_width: Cell<Option<usize>>,
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
            request_epoch: 0,
            last_width: Cell::new(None),
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
        let document = NodeDocument::parse(entry, instance);
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
            request_epoch: 0,
            last_width: Cell::new(None),
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
            instance: self.selected_selector(),
        }
    }

    /// Fold one `node` reply into the open view: the instance list and
    /// the document replace theirs, the selection follows its instance
    /// when present, the scroll resets, and the files document (fetched
    /// separately) survives. An empty entry leaves no instance selected.
    /// A malformed reply keeps the last good document and reports on the
    /// error row instead.
    pub fn merge_reply(&mut self, data: &Value) {
        let Some(reply) = Self::parse_reply(&self.run_id, &self.state_id, data) else {
            self.error = Some(MALFORMED_NODE_REPLY_ERROR.to_string());
            return;
        };
        if !reply.run_name.is_empty() {
            self.run_name = reply.run_name;
        }
        self.instances = reply.instances;
        self.document = reply.document;
        self.never_entered = reply.never_entered;
        self.selected = self.document.as_ref().and_then(|document| {
            let (entry, index) = (document.entry?, document.index?);
            self.instances
                .iter()
                .position(|row| row.entry == Some(entry) && row.index == Some(index))
        });
        self.scroll = 0;
        self.error = None;
    }

    /// Mark the newest node-document request for this mounted view.
    pub fn set_request_epoch(&mut self, request_epoch: u64) {
        self.request_epoch = request_epoch;
    }

    /// Apply a node-document reply only if no newer instance fetch replaced it.
    pub fn apply_request_result(
        &mut self,
        request_epoch: u64,
        result: Result<Value, String>,
    ) -> bool {
        if self.request_epoch != request_epoch {
            return false;
        }
        match result {
            Ok(data) => self.merge_reply(&data),
            Err(message) => self.set_error(message),
        }
        true
    }

    /// Record the node fetch's failure on the error row (the last good
    /// document stays).
    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    /// Fold the template-files fetch (the machine's `library` payload)
    /// into the view.
    pub fn set_files(&mut self, files: NodeFiles) {
        self.files = Some(files);
        self.files_error = None;
    }

    /// Record a template-files fetch failure without replacing the node's
    /// own document error or last good file snapshot.
    pub fn set_files_error(&mut self, message: &str) {
        self.files_error = Some(crate::menu_panel::scrub_controls(message));
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
            let width = self.last_width.get().unwrap_or_default();
            let total = self.files_document(&theme, width).len();
            let visible = visible_rows(viewport_rows, total);
            let step = if page_up || page_down { visible } else { 1 };
            let delta = if up || page_up {
                -(step as isize)
            } else if down || page_down {
                step as isize
            } else {
                return false;
            };
            self.files_scroll = (self.files_scroll as isize + delta)
                .clamp(0, total.saturating_sub(visible) as isize)
                as usize;
            return true;
        }
        if up {
            let selected = match self.selected {
                Some(selected) if selected > 0 => Some(selected - 1),
                Some(_) => self.selected,
                None => self.instances.len().checked_sub(1),
            };
            if selected != self.selected {
                self.selected = selected;
                self.scroll = 0;
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
                self.selected = selected;
                self.scroll = 0;
            }
            return true;
        }
        if page_up || page_down {
            let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
            let width = self
                .last_width
                .get()
                .unwrap_or_default()
                .saturating_sub(4)
                .max(20);
            let total = self.document_lines(Some(&theme), width).len();
            let visible = visible_rows(viewport_rows, total);
            self.scroll = if page_up {
                self.scroll.saturating_sub(visible)
            } else {
                self.scroll
                    .saturating_add(visible)
                    .min(total.saturating_sub(visible))
            };
            return true;
        }
        false
    }

    /// The instance document's rows: the instance list, then the
    /// selected instance's sections. Markdown sections render through
    /// the colored Markdown renderer (the files view's own), so the
    /// node's text keeps its color; JSON sections render as code.
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
            let text = if self.never_entered {
                "  not yet entered"
            } else {
                "  no instances were created"
            };
            plain_line(&mut rows, theme, text, ThemeColor::Muted);
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
                if let Some(theme) = theme {
                    rows.push(vec![
                        theme.fg_span(ThemeColor::MdCodeBlock, line.to_string())
                    ]);
                } else {
                    rows.push(vec![Span::raw(line.to_string())]);
                }
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
        // The realized prompt: the exact text the child received —
        // Markdown, colored like the template file it realizes.
        rows.push(vec![Span::raw("")]);
        section(&mut rows, "realized prompt");
        if document.prompt.is_empty() {
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
            plain_line(&mut rows, theme, &format!("    {error}"), ThemeColor::Error);
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
                    self.run_id.clone()
                } else {
                    self.run_name.clone()
                }
            ),
        ));
        let mut rows = vec![header, vec![Span::raw("")]];
        self.last_width.set(Some(width));
        let inner_width = width.saturating_sub(4).max(20);

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
        let visible = viewport_rows
            .saturating_sub(rows.len() + 4 + error_rows)
            .max(1);
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
                "{arrows}/{pages} scroll · {} back to the node · {esc} back to the diagram",
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

/// The windowed row count for one document total.
fn visible_rows(viewport_rows: usize, total: usize) -> usize {
    viewport_rows.saturating_sub(6).max(4).min(total.max(1))
}
