//! One machine's drill-in on the factory page: its block diagram (every
//! state a labelled box, every transition a labelled edge), with one node
//! selected, and the selected node's files (the prompt Markdown, the
//! shared context, the rubric, or the python module) one Enter away. The
//! machine's mermaid and any mermaid fence in a node's Markdown render as
//! diagrams (the same block-diagram renderer), never as source text.

use serde_json::Value;

use super::super::blocks::block_diagram;
use super::super::mermaid::{mermaid_block_lines, split_mermaid_fences, FileSegment};
use super::super::{parse_run, FactoryRunSnapshot};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::markdown::{render_markdown, MarkdownStyle};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

/// The detail frame's pinned rows: the blank and the hint (the error row
/// rides the same tail when one is set).
const PINNED_ROWS: usize = 2;
/// The wrap width the key loop measures the files document at (the render
/// clamps the scroll to the real width's document).
const MEASURE_WIDTH: usize = 100;

/// One drilled-in machine: the graph payload in the run page's snapshot
/// shape, the description, the declared params, each state's files, and
/// the mermaid rendering.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryDetail {
    pub name: String,
    pub description: String,
    pub snapshot: FactoryRunSnapshot,
    pub params: Vec<String>,
    /// Every file's text once, by path.
    pub files: Vec<(String, String)>,
    /// Each state's files, by path.
    pub state_files: Vec<(String, Vec<String>)>,
    /// The machine's own mermaid (`spec_to_mermaid`), rendered as a
    /// diagram below the block diagram.
    pub mermaid: String,
}

impl LibraryDetail {
    /// Fold one `library` graph reply; a reply that cannot parse answers
    /// `None` (the page reports the lane error instead of a half diagram).
    pub(super) fn parse(data: &Value) -> Option<Self> {
        let snapshot = parse_run(data)?;
        let name = snapshot.spec_id.clone();
        if name.is_empty() {
            return None;
        }
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        let text = |key: &str| {
            data.get(key)
                .and_then(Value::as_str)
                .map(scrub)
                .unwrap_or_default()
        };
        let list = |key: &str| {
            data.get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let files = list("files")
            .iter()
            .filter_map(|file| {
                Some((
                    scrub(file.get("path")?.as_str()?),
                    scrub(file.get("text")?.as_str()?),
                ))
            })
            .collect();
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
        Some(Self {
            name,
            description: text("description"),
            snapshot,
            params: list("params").iter().filter_map(param_label).collect(),
            files,
            state_files,
            mermaid: text("mermaid"),
        })
    }

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
}

/// `task: text (required)`, `max_loc: int = 400`.
fn param_label(param: &Value) -> Option<String> {
    let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
    let name = scrub(param.get("name")?.as_str()?);
    let ty = scrub(param.get("type")?.as_str()?);
    Some(match param.get("default") {
        Some(default) => format!("{name}: {ty} = {}", scrub(&default.to_string())),
        None => format!("{name}: {ty} (required)"),
    })
}

/// What a key did to the drill-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DetailKey {
    Handled,
    /// Esc on the diagram: leave the drill-in.
    Leave,
}

/// The drill-in's state: the machine, the selected node, whether its
/// files are open, and each mode's scroll.
#[derive(Debug)]
pub(super) struct DetailView {
    pub(super) detail: LibraryDetail,
    node: usize,
    files_open: bool,
    diagram_scroll: usize,
    files_scroll: usize,
}

impl DetailView {
    pub(super) fn new(detail: LibraryDetail) -> Self {
        Self {
            detail,
            node: 0,
            files_open: false,
            diagram_scroll: 0,
            files_scroll: 0,
        }
    }

    fn node_id(&self) -> Option<&str> {
        self.detail
            .snapshot
            .states
            .get(self.node)
            .map(|state| state.id.as_str())
    }

    /// The diagram document and each state's first row in it.
    fn diagram_document(&self, theme: &Theme, width: usize) -> (Vec<Line>, Vec<usize>) {
        let detail = &self.detail;
        let mut document: Vec<Line> = Vec::new();
        let mut header: Line = vec![Span::raw("  ")];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "machine: "));
        header.push(theme.fg_span(ThemeColor::Text, detail.name.clone()));
        if !detail.description.is_empty() {
            header.push(theme.fg_span(ThemeColor::Muted, format!(" — {}", detail.description)));
        }
        document.push(truncate_line(&header, width, ""));
        if !detail.params.is_empty() {
            let mut params: Line = vec![Span::raw("  ")];
            params.push(theme.fg_span(ThemeColor::ToolTitle, "params: "));
            params.push(theme.fg_span(ThemeColor::Muted, detail.params.join(", ")));
            document.push(truncate_line(&params, width, ""));
        }
        document.push(vec![Span::raw("")]);
        let diagram = block_diagram(
            theme,
            &detail.snapshot.states,
            &detail.snapshot.transitions,
            Some(self.node),
        );
        let offset = document.len();
        let node_rows = diagram.node_rows.iter().map(|row| row + offset).collect();
        document.extend(
            diagram
                .lines
                .into_iter()
                .map(|line| truncate_line(&line, width, "")),
        );
        (document, node_rows)
    }

    /// The selected node's files: Markdown rendered, everything else as
    /// code.
    fn files_document(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let node = self.node_id().unwrap_or_default();
        let files = self.detail.node_files(node);
        let mut document: Vec<Line> = Vec::new();
        let mut header: Line = vec![Span::raw("  ")];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "node: "));
        header.push(theme.fg_span(ThemeColor::Text, node.to_string()));
        header.push(theme.fg_span(
            ThemeColor::Muted,
            format!(
                " · {} · {} file{}",
                self.detail.name,
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ),
        ));
        document.push(truncate_line(&header, width, ""));
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
                // A mermaid fence renders as the diagram it describes;
                // the prose around it renders as Markdown.
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

    fn visible_rows(viewport_rows: usize, error: bool, total: usize) -> usize {
        viewport_rows
            .saturating_sub(PINNED_ROWS + usize::from(error))
            .max(1)
            .min(total.max(1))
    }

    /// One key on the drill-in: ↑/↓ walk the nodes (or scroll the open
    /// files), PgUp/PgDn page, Enter opens the node's files, Esc closes the
    /// files, then leaves.
    pub(super) fn handle_key(
        &mut self,
        key: &str,
        kb: &KeybindingsManager,
        viewport_rows: usize,
        error: bool,
    ) -> DetailKey {
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            if self.files_open {
                self.files_open = false;
                return DetailKey::Handled;
            }
            return DetailKey::Leave;
        }
        let up = kb.matches(key, "tui.select.up");
        let down = kb.matches(key, "tui.select.down");
        let page_up = kb.matches(key, "tui.select.pageUp");
        let page_down = kb.matches(key, "tui.select.pageDown");
        if self.files_open {
            let total = self.files_document(&theme, MEASURE_WIDTH).len();
            let visible = Self::visible_rows(viewport_rows, error, total);
            let step = if page_up || page_down { visible } else { 1 } as isize;
            let delta = if up || page_up {
                -step
            } else if down || page_down {
                step
            } else {
                0
            };
            self.files_scroll = (self.files_scroll as isize + delta)
                .clamp(0, total.saturating_sub(visible) as isize)
                as usize;
            return DetailKey::Handled;
        }
        if kb.matches(key, "tui.select.confirm") {
            self.files_open = true;
            self.files_scroll = 0;
            return DetailKey::Handled;
        }
        let (document, node_rows) = self.diagram_document(&theme, usize::MAX);
        let total = document.len();
        let visible = Self::visible_rows(viewport_rows, error, total);
        let max_scroll = total.saturating_sub(visible);
        if page_up || page_down {
            let delta = if page_up {
                -(visible as isize)
            } else {
                visible as isize
            };
            self.diagram_scroll =
                (self.diagram_scroll as isize + delta).clamp(0, max_scroll as isize) as usize;
            return DetailKey::Handled;
        }
        if (up || down) && !node_rows.is_empty() {
            let last = node_rows.len() - 1;
            self.node = if up {
                self.node.saturating_sub(1)
            } else {
                (self.node + 1).min(last)
            };
            // Keep the whole selected box in the window.
            let top = node_rows[self.node];
            let bottom = top + 4;
            if top < self.diagram_scroll {
                self.diagram_scroll = top.saturating_sub(2);
            } else if bottom > self.diagram_scroll + visible {
                self.diagram_scroll = (bottom + 2).saturating_sub(visible).min(max_scroll);
            }
        }
        DetailKey::Handled
    }

    pub(super) fn render(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        viewport_rows: usize,
        error: Option<&str>,
    ) -> Vec<Line> {
        let (document, scroll) = if self.files_open {
            (self.files_document(theme, width), self.files_scroll)
        } else {
            (self.diagram_document(theme, width).0, self.diagram_scroll)
        };
        let total = document.len();
        let visible = Self::visible_rows(viewport_rows, error.is_some(), total);
        let scroll = scroll.min(total.saturating_sub(visible));
        let mut rows: Vec<Line> = document.into_iter().skip(scroll).take(visible).collect();
        while rows.len() < viewport_rows.saturating_sub(PINNED_ROWS + usize::from(error.is_some()))
        {
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
            format!("{arrows} scroll · {pages} page · {esc} back to the diagram")
        } else {
            format!(
                "{arrows} node · {pages} scroll · {} files · {esc} back",
                key("tui.select.confirm", "Enter")
            )
        }
    }
}
