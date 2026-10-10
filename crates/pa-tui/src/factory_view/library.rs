//! The machine library page: the activity dock's `☰ machines` group's
//! destination — every machine the kernel library resolves (name,
//! description, source), one drill-in per machine. The page is pure
//! presentation and selection on the activity pages' picker keyset
//! (arrows + Enter + Esc): the arrows walk the machine list, Enter
//! drills into the selected machine, and Esc backs out of the drill-in
//! before it closes the page. The session UI owns the daemon lane (the
//! `library` action over the `factory_activity` bridge) and folds the
//! replies into the open view.
//!
//! The drill-in reuses the run page's seams with no new renderer code:
//! the machine's diagram renders through the existing diagram renderer
//! over the graph payload — the same snapshot shape the active-run graph
//! lane answers — and the mermaid text rides below it as plain
//! monospace rows (copyable; GitHub, previews, and external tools render
//! the text — the terminal renders the ANSI diagram above it, a graphics
//! subsystem for in-TUI mermaid pixels does not exist).

use serde_json::Value;

use super::{parse_run, FactoryRunSnapshot};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

/// The machine-library page's malformed-lane error (the factory page's
/// list-lane contract): a reply without the machines list is a
/// malformed lane, never an empty library.
pub const MALFORMED_LIBRARY_REPLY_ERROR: &str = "malformed factory reply (no machines list)";

/// One library machine row (the `library` list action's reply): the name
/// the drill-in asks for, the listing description, and the source level
/// (`repo` for the bundled seeds, `user` for the personal library).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMachine {
    pub name: String,
    pub description: String,
    pub source: String,
}

impl LibraryMachine {
    fn parse(value: &Value) -> Option<Self> {
        // Every daemon-provided display string scrubs its control bytes
        // at this parse seam (the bash activity lane's rule): wire text
        // never reaches a styled span.
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        Some(Self {
            name: scrub(value.get("name")?.as_str()?),
            description: scrub(value.get("description")?.as_str()?),
            source: scrub(value.get("source")?.as_str()?),
        })
        .filter(|machine| !machine.name.trim().is_empty())
    }
}

/// Parse the `library` list reply (`{"machines": [...]}`): every row that
/// carries a name, description, and source drops the malformed ones.
#[must_use]
pub fn parse_library_machines(data: &Value) -> Vec<LibraryMachine> {
    data.get("machines")
        .and_then(Value::as_array)
        .map(|machines| machines.iter().filter_map(LibraryMachine::parse).collect())
        .unwrap_or_default()
}

/// Whether a reply is the library list shape at all (the malformed-lane
/// contract): a reply without the `machines` LIST is a malformed lane,
/// not an empty library.
#[must_use]
pub fn library_reply_lists_machines(data: &Value) -> bool {
    data.get("machines").is_some_and(Value::is_array)
}

/// One drilled-in machine: the graph payload parsed into the run page's
/// snapshot shape (the diagram renderer's input — the same shape the
/// active-run graph lane answers), the machine file's description, and
/// the mermaid rendering below the diagram.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryDetail {
    pub name: String,
    pub description: String,
    pub snapshot: FactoryRunSnapshot,
    pub mermaid: Vec<String>,
}

impl LibraryDetail {
    /// Fold one `library` graph reply into a detail. The reply is the
    /// spec-graph snapshot shape plus the machine file's fields and the
    /// mermaid text; a reply that cannot parse answers `None` (the
    /// session UI reports the exact lane error instead of mounting a
    /// half diagram).
    fn parse(data: &Value) -> Option<Self> {
        let snapshot = parse_run(data)?;
        let name = snapshot.spec_id.clone();
        if name.is_empty() {
            return None;
        }
        let mermaid = data
            .get("mermaid")
            .and_then(Value::as_str)
            .map(crate::menu_panel::scrub_controls)
            .unwrap_or_default();
        Some(Self {
            name,
            description: data
                .get("description")
                .and_then(Value::as_str)
                .map(crate::menu_panel::scrub_controls)
                .unwrap_or_default(),
            snapshot,
            mermaid: mermaid.lines().map(str::to_string).collect(),
        })
    }
}

/// One key press while the machine library page is open, resolved by the
/// view's own key loop (the session UI executes the returned action).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibraryViewAction {
    /// Navigation only.
    None,
    /// Enter on a machine: drill into it (the session UI fetches the
    /// machine's graph payload over the lane and folds it back in).
    DrillIn { name: String },
    /// Esc on the list (or ctrl+c anywhere): close the page.
    Close,
}

/// The machine library page: the machine list, the selection, the open
/// drill-in, and the fetch/error state the session UI folds in.
#[derive(Debug)]
pub struct LibraryView {
    machines: Vec<LibraryMachine>,
    selected: usize,
    /// The open drill-in; `None` is the list mode.
    detail: Option<LibraryDetail>,
    error: Option<String>,
    /// The detail document window's first row (0 = the top).
    detail_scroll: usize,
    viewport_rows: usize,
}

/// The detail frame's pinned rows: the blank and the hint (the error
/// row rides the same tail when one is set), exactly like the info
/// panel's frame.
const DETAIL_PINNED_ROWS: usize = 2;

impl LibraryView {
    /// Build the view from the first list reply. The batch arrives with
    /// the open (the fetch rides the open), so the default selection —
    /// index 0 — is the first machine in the kernel's sorted list.
    #[must_use]
    pub fn new(machines: Vec<LibraryMachine>, viewport_rows: usize) -> Self {
        Self {
            machines,
            selected: 0,
            detail: None,
            error: None,
            detail_scroll: 0,
            viewport_rows,
        }
    }

    /// Mount the view from the open-path fetch (the factory page's
    /// malformed-reply contract: a cached malformed lane mounts with its
    /// error set, never as a silent fake empty state).
    #[must_use]
    pub fn from_reply(data: &Value, viewport_rows: usize) -> Self {
        let mut view = Self::new(parse_library_machines(data), viewport_rows);
        if !library_reply_lists_machines(data) {
            view.set_error(Some(MALFORMED_LIBRARY_REPLY_ERROR.to_string()));
        }
        view
    }

    /// The selected machine row, when the list has one.
    #[must_use]
    pub fn selected_machine(&self) -> Option<&LibraryMachine> {
        self.machines.get(self.selected)
    }

    /// Record one fetch/error line from the session UI (daemon-provided
    /// text painted on the view's error row, so it scrubs).
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// Apply one refreshed list batch: the machines replace the rows and
    /// the selection stays on the same machine name (a machine that
    /// left the batch returns the selection to the list's head).
    pub fn apply_machines(&mut self, machines: Vec<LibraryMachine>) {
        let selected_name = self
            .machines
            .get(self.selected)
            .map(|machine| machine.name.clone());
        self.machines = machines;
        self.selected = selected_name
            .and_then(|name| {
                self.machines
                    .iter()
                    .position(|machine| machine.name == name)
            })
            .unwrap_or(0)
            .min(self.machines.len().saturating_sub(1));
    }

    /// Fold one drill-in reply: the machine's detail mounts and the
    /// window resets to the document's top; a reply that cannot parse
    /// reports the lane error on the view's error row instead.
    pub fn apply_detail(&mut self, name: &str, data: &Value) {
        match LibraryDetail::parse(data) {
            Some(detail) => {
                self.detail = Some(detail);
                self.detail_scroll = 0;
                self.error = None;
            }
            None => {
                self.set_error(Some(format!("malformed factory reply for machine {name}")));
            }
        }
    }

    /// One key press on the activity pages' picker keyset: the arrows
    /// walk the list selection (or scroll the open drill-in's document),
    /// Enter drills into the selected machine (the list) and Esc backs
    /// out of the drill-in before it closes the page.
    #[must_use]
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> LibraryViewAction {
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            // Esc backs out of the open drill-in before it closes the
            // page — the drill-in's back, on the one close key the page
            // carries (the factory page's keyset).
            if self.detail.is_some() {
                self.detail = None;
                self.detail_scroll = 0;
                return LibraryViewAction::None;
            }
            return LibraryViewAction::Close;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta: isize = if kb.matches(key, "tui.select.up") {
                -1
            } else {
                1
            };
            match self.detail {
                Some(_) => self.scroll_detail(delta),
                None => self.move_selection(delta),
            }
            return LibraryViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            if let Some(machine) = self.selected_machine() {
                return LibraryViewAction::DrillIn {
                    name: machine.name.clone(),
                };
            }
        }
        LibraryViewAction::None
    }

    /// One arrow step on the list: the selection walks the machines.
    fn move_selection(&mut self, delta: isize) {
        if self.machines.is_empty() {
            return;
        }
        self.selected =
            (self.selected as isize + delta).clamp(0, self.machines.len() as isize - 1) as usize;
    }

    /// One arrow step on the open drill-in: the document window scrolls a
    /// row (the diagram rides the top; the mermaid text below it).
    fn scroll_detail(&mut self, delta: isize) {
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let total = self.detail.as_ref().map_or(0, |detail| {
            Self::detail_document(&theme, usize::MAX, detail).len()
        });
        let visible = self.detail_visible_rows(total);
        let max = total.saturating_sub(visible);
        self.detail_scroll = (self.detail_scroll as isize)
            .saturating_add(delta)
            .clamp(0, max as isize) as usize;
    }

    /// The drill-in document's window height: the viewport minus the
    /// frame's pinned rows (the blank and the hint, plus the error row
    /// when one is set), clamped to the document itself — the same
    /// geometry the render draws, so the scroll math and the paint never
    /// disagree.
    fn detail_visible_rows(&self, total: usize) -> usize {
        let pinned = DETAIL_PINNED_ROWS + usize::from(self.error.is_some());
        self.viewport_rows
            .saturating_sub(pinned)
            .max(1)
            .min(total.max(1))
    }

    /// Render the page: the machine list, or the open drill-in's document
    /// (the diagram plus the mermaid panel) — the error row and the key
    /// hint pinned at the frame's end either way.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.detail {
            Some(detail) => self.render_detail(theme, width, kb, detail),
            None => self.render_list(theme, width, kb),
        }
    }

    /// The detail document: the machine's header, its diagram (the run
    /// page's existing renderer over the same snapshot shape the
    /// active-run graph lane answers), and the mermaid text panel below
    /// it. The key loop counts the same rows for its scroll bounds.
    fn detail_document(theme: &Theme, width: usize, detail: &LibraryDetail) -> Vec<Line> {
        let mut document: Vec<Line> = Vec::new();
        let mut header: Line = vec![Span::raw("  ")];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "machine: "));
        header.push(theme.fg_span(ThemeColor::Text, detail.name.clone()));
        if !detail.description.is_empty() {
            header.push(theme.fg_span(ThemeColor::Muted, format!(" — {}", detail.description)));
        }
        document.push(truncate_line(&header, width, ""));
        document.push(vec![Span::raw("")]);
        super::FactoryView::render_diagram(theme, &detail.snapshot, &mut document);
        document.push(vec![Span::raw("")]);
        let mut title: Line = vec![Span::raw("  ")];
        title.push(theme.fg_span(ThemeColor::ToolTitle, "mermaid"));
        document.push(title);
        for line in &detail.mermaid {
            let row = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::MdCodeBlock, line.clone()),
            ];
            document.push(truncate_line(&row, width, ""));
        }
        document
    }

    /// The drill-in mode: the document's scroll window (the diagram rides
    /// the top, the mermaid text below), the error row, and the hint
    /// pinned at the frame's end — the info panel's own geometry.
    fn render_detail(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        detail: &LibraryDetail,
    ) -> Vec<Line> {
        let document = Self::detail_document(theme, width, detail);
        let total = document.len();
        let visible = self.detail_visible_rows(total);
        let scroll = self.detail_scroll.min(total.saturating_sub(visible));
        let mut rows: Vec<Line> = document.into_iter().skip(scroll).take(visible).collect();
        if let Some(error) = &self.error {
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        rows.push(vec![Span::raw("")]);
        rows.push(vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Dim, list_hint(kb, "scroll", "back")),
        ]);
        rows.into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }

    /// The list mode: the header, the machine rows (the selected one
    /// marked), the empty state, the error row, and the hint — with the
    /// machine window following the selection over a long library, the
    /// factory page's own budget trim.
    fn render_list(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let mut header = vec![vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::ToolTitle, "machine library"),
        ]];
        let mut body: Vec<Line> = Vec::new();
        if self.machines.is_empty() {
            body.push(vec![Span::raw("")]);
            body.push(vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Muted,
                    "No machines in the library (manage them with prime-agent factory import).",
                ),
            ]);
        }
        for (index, machine) in self.machines.iter().enumerate() {
            let selected = index == self.selected;
            let mut row: Line = vec![Span::raw(if selected { "  ▸ " } else { "    " })];
            row.push(theme.fg_span(
                if selected {
                    ThemeColor::Text
                } else {
                    ThemeColor::Muted
                },
                machine.name.clone(),
            ));
            row.push(theme.fg_span(ThemeColor::Dim, format!(" [{}]", machine.source)));
            row.push(theme.fg_span(ThemeColor::Muted, format!(" — {}", machine.description)));
            body.push(truncate_line(&row, width, ""));
        }
        let mut tail: Vec<Line> = Vec::new();
        if let Some(error) = &self.error {
            tail.push(vec![Span::raw("")]);
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        tail.push(vec![Span::raw("")]);
        tail.push(vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Dim, list_hint(kb, "move", "close")),
        ]);
        // The machine window follows the selection: the header and the
        // tail stay pinned, and the body keeps the selected row in view.
        let budget = self.viewport_rows.max(header.len() + tail.len() + 1);
        let body_budget = budget.saturating_sub(header.len() + tail.len()).max(1);
        let start = if body.len() > body_budget {
            self.selected.saturating_sub(body_budget - 1)
        } else {
            0
        };
        header.extend(body.into_iter().skip(start).take(body_budget));
        header.extend(tail);
        header
    }
}

/// The page's key hint (the factory page's hint grammar): the arrows,
/// Enter, and Esc, with the middle action named by the mode (move on the
/// list, scroll on the drill-in) and the close named by it too (close on
/// the list, back out of the drill-in).
fn list_hint(kb: &KeybindingsManager, middle: &str, close: &str) -> String {
    let key = |binding: &str, fallback: &str| {
        kb.first_key(binding)
            .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
    };
    format!(
        "{}/{} {middle} · {} open · {} {close}",
        key("tui.select.up", "\u{2191}"),
        key("tui.select.down", "\u{2193}"),
        key("tui.select.confirm", "Enter"),
        key("tui.select.cancel", "Esc"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;
    use serde_json::json;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn plain(rows: &[Line]) -> String {
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The `library` list reply's wire shape (camelCase-free keys:
    /// name/description/source are single words), one row malformed.
    #[test]
    fn the_list_parses_the_machines_and_skips_malformed_rows() {
        let data = json!({
            "machines": [
                {"name": "pr-manager", "description": "Drive a PR.", "source": "repo"},
                {"name": "mine", "description": "My machine.", "source": "user"},
                {"description": "a row with no name"},
            ]
        });
        assert!(library_reply_lists_machines(&data));
        let machines = parse_library_machines(&data);
        assert_eq!(machines.len(), 2);
        assert_eq!(
            machines[0],
            LibraryMachine {
                name: "pr-manager".to_string(),
                description: "Drive a PR.".to_string(),
                source: "repo".to_string(),
            }
        );
        assert_eq!(machines[1].source, "user");
        // A reply without the machines list is a malformed lane.
        assert!(!library_reply_lists_machines(&json!({"runs": []})));
        assert!(parse_library_machines(&json!({})).is_empty());
    }

    /// The list mode's picker grammar: the arrows move the selection,
    /// Enter answers the selected machine's name, Esc closes.
    #[test]
    fn the_list_walks_the_selection_and_drills_in_on_enter() {
        let mut view = LibraryView::new(
            vec![
                LibraryMachine {
                    name: "builder".to_string(),
                    description: "Builds.".to_string(),
                    source: "repo".to_string(),
                },
                LibraryMachine {
                    name: "pr-manager".to_string(),
                    description: "Drives a PR.".to_string(),
                    source: "repo".to_string(),
                },
            ],
            20,
        );
        assert_eq!(
            view.handle_key("down", &kb()),
            LibraryViewAction::None,
            "the arrows never leave the page"
        );
        assert_eq!(
            view.selected_machine().map(|m| m.name.as_str()),
            Some("pr-manager")
        );
        assert_eq!(
            view.handle_key("enter", &kb()),
            LibraryViewAction::DrillIn {
                name: "pr-manager".to_string()
            }
        );
        assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::Close);
    }

    /// The drill-in's grammar: Esc backs out to the list before it closes
    /// the page, and the detail renders the diagram and the mermaid text.
    #[test]
    fn the_drill_in_renders_the_diagram_and_mermaid_then_esc_backs_out() {
        let data = json!({
            "runId": null,
            "specId": "pr-manager",
            "state": null,
            "machine": {
                "states": [
                    {"id": "entry", "entry": true},
                    {"id": "reviewing", "maxEntries": 4},
                ],
                "transitions": [
                    {"from": "entry", "to": "reviewing"},
                    {"from": "reviewing", "to": "reviewing",
                     "when": {"output": "verdict", "op": "exists"}},
                ],
                "order": ["entry", "reviewing"],
                "run": {"maxParallel": 8},
            },
            "nodes": [],
            "description": "Drive a pull request through review and fix cycles.",
            "mermaid": "stateDiagram-v2\n    state \"entry\" as entry\n",
        });
        let mut view = LibraryView::new(Vec::new(), 30);
        view.apply_detail("pr-manager", &data);
        let text = plain(&view.render(&theme(), 100, &kb()));
        assert!(
            text.contains("machine: pr-manager"),
            "the header renders: {text}"
        );
        assert!(
            text.contains("entry  pending  [entry]"),
            "the diagram renders: {text}"
        );
        assert!(
            text.contains("when verdict exists"),
            "the diagram carries the guarded edge: {text}"
        );
        assert!(
            text.contains("mermaid"),
            "the mermaid panel title renders: {text}"
        );
        assert!(
            text.contains("stateDiagram-v2"),
            "the mermaid text renders as plain rows: {text}"
        );
        assert!(
            text.contains("state \"entry\" as entry"),
            "the mermaid state line rides the panel: {text}"
        );
        // Esc backs out to the list first; the second Esc closes.
        assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::None);
        assert!(plain(&view.render(&theme(), 100, &kb())).contains("machine library"));
        assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::Close);
    }

    /// The malformed-reply contract: a drill-in reply that cannot parse
    /// reports the error on the view's error row, never a half diagram.
    #[test]
    fn a_malformed_drill_in_reply_reports_the_lane_error() {
        let mut view = LibraryView::new(Vec::new(), 30);
        view.apply_detail("pr-manager", &json!({"boom": true}));
        assert!(view.detail.is_none());
        let text = plain(&view.render(&theme(), 100, &kb()));
        assert!(
            text.contains("Error: malformed factory reply for machine pr-manager"),
            "{text}"
        );
    }

    /// The list keeps the selection on the same machine across a refresh.
    #[test]
    fn a_refresh_keeps_the_selection_on_the_same_machine() {
        let mut view = LibraryView::new(
            vec![LibraryMachine {
                name: "builder".to_string(),
                description: "Builds.".to_string(),
                source: "repo".to_string(),
            }],
            20,
        );
        assert_eq!(
            view.handle_key("enter", &kb()),
            LibraryViewAction::DrillIn {
                name: "builder".to_string(),
            },
            "the drill-in answers the selected machine's name"
        );
        view.apply_machines(vec![
            LibraryMachine {
                name: "pr-manager".to_string(),
                description: "Drives a PR.".to_string(),
                source: "repo".to_string(),
            },
            LibraryMachine {
                name: "builder".to_string(),
                description: "Builds.".to_string(),
                source: "repo".to_string(),
            },
        ]);
        assert_eq!(
            view.selected_machine().map(|m| m.name.as_str()),
            Some("builder"),
            "the selection follows the machine, never the index"
        );
    }
}
