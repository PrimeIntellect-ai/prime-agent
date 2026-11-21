//! The machine library page: the activity dock's `▤ machines` group's
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
    /// Esc or ctrl+c on the list: close the page.
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
    list_error: Option<String>,
    loading: bool,
    /// The detail document window's first row (0 = the top).
    detail_scroll: usize,
    viewport_rows: usize,
    viewport_width: usize,
}

/// The detail frame's pinned rows: the blank and the hint (the error
/// row rides the same tail when one is set), exactly like the info
/// panel's frame.
const DETAIL_PINNED_ROWS: usize = 2;

impl LibraryView {
    /// Build a loaded view with the first machine selected.
    #[must_use]
    pub fn new(machines: Vec<LibraryMachine>, viewport_rows: usize) -> Self {
        Self {
            machines,
            selected: 0,
            detail: None,
            error: None,
            list_error: None,
            loading: false,
            detail_scroll: 0,
            viewport_rows,
            viewport_width: usize::MAX,
        }
    }

    /// Mount the page while the initial machine list is being fetched.
    #[must_use]
    pub fn loading(viewport_rows: usize) -> Self {
        let mut view = Self::new(Vec::new(), viewport_rows);
        view.loading = true;
        view
    }

    /// The selected machine row, when the list has one.
    #[must_use]
    /// The machine an open drill-in shows, when the page is drilled in.
    /// A rebind re-issues this machine's fetch with the new wire id.
    pub fn open_machine_name(&self) -> Option<String> {
        self.detail.as_ref().map(|detail| detail.name.clone())
    }

    pub fn selected_machine(&self) -> Option<&LibraryMachine> {
        self.machines.get(self.selected)
    }

    /// Record a drill-in error without changing the list fetch outcome.
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// Record a list fetch outcome without clearing a failed drill-in.
    pub fn set_list_error(&mut self, error: Option<String>) {
        if error.is_some() {
            self.loading = false;
        }
        self.list_error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    fn visible_error(&self) -> Option<&str> {
        self.error.as_deref().or(self.list_error.as_deref())
    }

    /// Apply one refreshed list batch: the machines replace the rows and
    /// the selection stays on the same machine name (a machine that
    /// left the batch returns the selection to the list's head).
    pub fn apply_machines(&mut self, machines: Vec<LibraryMachine>) {
        self.loading = false;
        let selected_name = self
            .machines
            .get(self.selected)
            .map(|machine| machine.name.clone());
        self.machines = machines;
        self.selected = selected_name
            .as_deref()
            .and_then(|name| {
                self.machines
                    .iter()
                    .position(|machine| machine.name == name)
            })
            .unwrap_or(0)
            .min(self.machines.len().saturating_sub(1));
        let selected_after = self
            .machines
            .get(self.selected)
            .map(|machine| machine.name.clone());
        if selected_after != selected_name {
            // The selected machine left the library: its open drill-in
            // belongs to a machine the fresh list no longer has. Closing
            // it here keeps the page from painting a detail that is not
            // reachable from the visible list.
            self.detail = None;
            self.detail_scroll = 0;
        }
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
        if self.detail.is_none() && kb.matches(key, "tui.select.confirm") {
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
            Self::detail_document(&theme, self.viewport_width, detail).len()
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
        let pinned = DETAIL_PINNED_ROWS + usize::from(self.visible_error().is_some());
        self.viewport_rows
            .saturating_sub(pinned)
            .max(1)
            .min(total.max(1))
    }

    /// Render the page: the machine list, or the open drill-in's document
    /// (the diagram plus the mermaid panel) — the error row and the key
    /// hint pinned at the frame's end either way.
    #[must_use]
    pub fn render(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        viewport_rows: usize,
    ) -> Vec<Line> {
        self.viewport_rows = viewport_rows;
        self.viewport_width = width;
        match &self.detail {
            Some(detail) => {
                let document = Self::detail_document(theme, width, detail);
                self.render_detail(theme, width, kb, document)
            }
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
        super::FactoryView::render_diagram(theme, &detail.snapshot, None, &mut document);
        document.push(vec![Span::raw("")]);
        let mut title: Line = vec![Span::raw("  ")];
        title.push(theme.fg_span(ThemeColor::ToolTitle, "mermaid"));
        document.push(title);
        for line in &detail.mermaid {
            let row = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::MdCodeBlock, line.clone()),
            ];
            document.extend(crate::width::wrap_line(&row, width));
        }
        document
    }

    /// The drill-in mode: the document's scroll window (the diagram rides
    /// the top, the mermaid text below), the error row, and the hint
    /// pinned at the frame's end — the info panel's own geometry.
    fn render_detail(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        document: Vec<Line>,
    ) -> Vec<Line> {
        let total = document.len();
        let visible = self.detail_visible_rows(total);
        self.detail_scroll = self.detail_scroll.min(total.saturating_sub(visible));
        let mut rows: Vec<Line> = document
            .into_iter()
            .skip(self.detail_scroll)
            .take(visible)
            .collect();
        if let Some(error) = self.visible_error() {
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        rows.push(vec![Span::raw("")]);
        rows.push(vec![
            Span::raw("  "),
            theme.fg_span(
                ThemeColor::Dim,
                list_hint(kb, "scroll", "back", /*confirm*/ None),
            ),
        ]);
        // Shed footer rows before the frame can crop the document from the front.
        rows.truncate(self.viewport_rows.max(1));
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
        if self.loading {
            body.push(vec![
                theme.fg_span(ThemeColor::Muted, "  Loading machines...")
            ]);
        } else if self.machines.is_empty() && self.visible_error().is_none() {
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
            if !machine.description.is_empty() {
                row.push(theme.fg_span(ThemeColor::Muted, format!(" — {}", machine.description)));
            }
            body.push(truncate_line(&row, width, ""));
        }
        let mut tail: Vec<Line> = Vec::new();
        if let Some(error) = self.visible_error() {
            tail.push(vec![Span::raw("")]);
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        tail.push(vec![Span::raw("")]);
        tail.push(vec![
            Span::raw("  "),
            theme.fg_span(
                ThemeColor::Dim,
                list_hint(kb, "move", "close", Some("open")),
            ),
        ]);
        // Keep the selected machine before chrome when the dock is short.
        let budget = self.viewport_rows.max(1);
        let minimum_body = usize::from(!body.is_empty());
        if header.len() + tail.len() + minimum_body > budget {
            tail.retain(|row| row.iter().any(|span| !span.content.trim().is_empty()));
        }
        header.truncate(budget.saturating_sub(tail.len() + minimum_body));
        tail.truncate(budget.saturating_sub(minimum_body));
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

/// The page's navigation hint, with Enter shown only on the machine list.
fn list_hint(kb: &KeybindingsManager, middle: &str, close: &str, confirm: Option<&str>) -> String {
    let key = |binding: &str, fallback: &str| {
        kb.first_key(binding)
            .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
    };
    let confirm = confirm.map_or_else(String::new, |action| {
        format!(" · {} {action}", key("tui.select.confirm", "Enter"))
    });
    format!(
        "{}/{} {middle}{confirm} · {} {close}",
        key("tui.select.up", "\u{2191}"),
        key("tui.select.down", "\u{2193}"),
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

    fn graph(mermaid: &str) -> Value {
        json!({
            "specId": "builder",
            "machine": {"states": [{"id": "entry", "entry": true}]},
            "mermaid": mermaid,
        })
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
        let text = plain(&view.render(&theme(), 100, &kb(), 30));
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
        assert!(plain(&view.render(&theme(), 100, &kb(), 30)).contains("machine library"));
        assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::Close);
    }

    /// The malformed-reply contract: a drill-in reply that cannot parse
    /// reports the error on the view's error row, never a half diagram.
    #[test]
    fn a_malformed_drill_in_reply_reports_the_lane_error() {
        let mut view = LibraryView::new(Vec::new(), 30);
        view.apply_detail("pr-manager", &json!({"boom": true}));
        assert!(view.detail.is_none());
        let text = plain(&view.render(&theme(), 100, &kb(), 30));
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

    /// A refresh that loses the selected machine closes its open drill-in:
    /// the page never paints a detail for a machine the visible list no
    /// longer selects.
    #[test]
    fn a_refresh_that_loses_the_selected_machine_closes_its_detail() {
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
            }
        );
        view.apply_detail("builder", &graph("entry --> checking"));
        view.apply_machines(vec![LibraryMachine {
            name: "pr-manager".to_string(),
            description: "Drives a PR.".to_string(),
            source: "repo".to_string(),
        }]);
        assert_eq!(
            view.selected_machine().map(|machine| machine.name.as_str()),
            Some("pr-manager")
        );
        assert!(
            view.detail.is_none(),
            "the gone machine's detail closes with the selection"
        );
    }

    #[test]
    fn the_frame_rebudgets_the_library_after_resize() {
        let machines = (0..13)
            .map(|index| LibraryMachine {
                name: format!("machine-{index}"),
                description: String::new(),
                source: "repo".to_string(),
            })
            .collect();
        let mut library = LibraryView::new(machines, 14);
        for _ in 0..2 {
            assert_eq!(library.handle_key("down", &kb()), LibraryViewAction::None);
        }
        let mut view = crate::view::AgentView::new(theme());
        view.library_view = Some(library);
        view.set_terminal_rows(18);
        let _ = view.render_frame(100, 18);

        view.set_terminal_rows(10);
        let shrunk = plain(&view.render_frame(100, 10));
        assert!(shrunk.contains("▸ machine-2"), "{shrunk}");
        assert!(shrunk.contains("Esc close"), "{shrunk}");

        view.set_terminal_rows(30);
        let grown = plain(&view.render_frame(100, 30));
        assert!(grown.contains("machine-12"), "{grown}");
        assert!(grown.contains("▸ machine-2"), "{grown}");
    }

    #[test]
    fn the_compact_frame_keeps_list_outcomes_visible() {
        let mut failed = LibraryView::loading(20);
        failed.set_list_error(Some("offline".to_string()));
        let mut retained = LibraryView::new(
            vec![LibraryMachine {
                name: "builder".to_string(),
                description: String::new(),
                source: "repo".to_string(),
            }],
            20,
        );
        retained.set_list_error(Some("offline".to_string()));
        for (library, expected) in [
            (LibraryView::loading(20), "Loading machines"),
            (
                LibraryView::new(Vec::new(), 20),
                "No machines in the library",
            ),
            (failed, "Error: offline"),
            (retained, "Error: offline"),
        ] {
            let mut view = crate::view::AgentView::new(theme());
            view.set_terminal_rows(6);
            view.chrome.speed_text = Some("42 tok/s".to_string());
            view.library_view = Some(library);
            let text = plain(&view.render_frame(100, 6));
            assert!(text.contains(expected), "{expected}: {text}");
            assert!(text.contains("42 tok/s"), "{text}");
        }
    }

    #[test]
    fn the_frame_keeps_the_enter_target_visible_above_the_speed_footer() {
        let machines = (0..13)
            .map(|index| LibraryMachine {
                name: format!("machine-{index}"),
                description: String::new(),
                source: "repo".to_string(),
            })
            .collect();
        let mut view = crate::view::AgentView::new(theme());
        view.library_view = Some(LibraryView::new(machines, 20));
        view.chrome.speed_text = Some("42 tok/s".to_string());
        for _ in 0..12 {
            let action = view
                .library_view
                .as_mut()
                .unwrap()
                .handle_key("down", &kb());
            assert_eq!(action, LibraryViewAction::None);
        }
        for (terminal_rows, height) in [(6, 6), (30, 6), (30, 30)] {
            // The frame size also wins while the cached terminal size catches up after resize.
            view.set_terminal_rows(terminal_rows);
            let frame = view.render_frame(100, height);
            let text = plain(&frame);
            assert_eq!(frame.len(), height, "{text}");
            assert!(text.contains("▸ machine-12"), "height {height}: {text}");
            assert!(text.contains("42 tok/s"), "height {height}: {text}");
            assert_eq!(
                view.library_view
                    .as_mut()
                    .unwrap()
                    .handle_key("enter", &kb()),
                LibraryViewAction::DrillIn {
                    name: "machine-12".to_string(),
                }
            );
            if height == 30 {
                assert!(text.contains("machine library"), "{text}");
                assert!(text.contains("machine-0"), "{text}");
                assert!(text.contains("Esc close"), "{text}");
            }
        }
    }

    #[test]
    fn the_compact_frame_keeps_the_scrolled_machine_source_visible() {
        for (terminal_rows, budget) in [(5, 1), (6, 2)] {
            let mut library = LibraryView::new(Vec::new(), 20);
            library.apply_detail("builder", &graph("entry --> checking\nchecking --> done"));
            let mut view = crate::view::AgentView::new(theme());
            // A six-row frame can arrive before the cached terminal size catches up.
            view.set_terminal_rows(terminal_rows);
            view.chrome.speed_text = Some("42 tok/s".to_string());
            view.library_view = Some(library);
            let _ = view.render_frame(100, 6);
            let library = view.library_view.as_mut().unwrap();
            assert_eq!(library.viewport_rows, budget);
            let document_rows =
                LibraryView::detail_document(&theme(), 100, library.detail.as_ref().unwrap()).len();
            for _ in 0..document_rows {
                assert_eq!(library.handle_key("down", &kb()), LibraryViewAction::None);
            }
            let frame = view.render_frame(100, 6);
            let text = plain(&frame);
            assert_eq!(frame.len(), 6, "{text}");
            assert!(
                text.contains("checking --> done"),
                "budget {budget}: {text}"
            );
            assert!(text.contains("42 tok/s"), "budget {budget}: {text}");
            assert_eq!(
                view.library_view.as_mut().unwrap().handle_key("up", &kb()),
                LibraryViewAction::None
            );
            let text = plain(&view.render_frame(100, 6));
            assert!(
                text.contains("entry --> checking"),
                "budget {budget}: {text}"
            );
        }
    }

    #[test]
    fn enter_keeps_the_open_detail_and_scroll_position() {
        let mut view = LibraryView::new(
            vec![LibraryMachine {
                name: "builder".to_string(),
                description: String::new(),
                source: "repo".to_string(),
            }],
            6,
        );
        view.apply_detail("builder", &graph(&"entry --> entry\n".repeat(20)));
        let _ = view.render(&theme(), 100, &kb(), 6);
        assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
        let before = view.render(&theme(), 100, &kb(), 6);
        assert!(view.detail_scroll > 0);
        assert_eq!(view.handle_key("enter", &kb()), LibraryViewAction::None);
        assert_eq!(view.render(&theme(), 100, &kb(), 6), before);
    }

    #[test]
    fn vertical_scroll_reaches_the_end_of_a_wrapped_mermaid_row() {
        let mut view = LibraryView::new(Vec::new(), 6);
        let mermaid = format!("{}TAIL", "x".repeat(60));
        view.apply_detail("builder", &graph(&mermaid));
        let _ = view.render(&theme(), 12, &kb(), 6);
        let mut end = Vec::new();
        for _ in 0..100 {
            assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
            end = view.render(&theme(), 12, &kb(), 6);
        }
        let text = plain(&end);
        assert!(text.contains("TAIL"), "{text}");
        assert!(end.iter().all(|row| crate::width::line_width(row) <= 12));
        let detail = view.detail.as_ref().unwrap();
        let source = LibraryView::detail_document(&theme(), 12, detail);
        let title = source
            .iter()
            .position(|row| plain(std::slice::from_ref(row)).trim() == "mermaid")
            .unwrap();
        let wrapped: String = source[title + 1..]
            .iter()
            .flat_map(|row| row.iter().map(|span| span.content.as_str()))
            .collect();
        assert_eq!(wrapped.trim_start(), mermaid);
    }

    #[test]
    fn a_pending_list_is_not_an_empty_library() {
        let mut view = LibraryView::loading(20);
        let pending = plain(&view.render(&theme(), 100, &kb(), 20));
        assert!(pending.contains("Loading machines"), "{pending}");
        assert!(!pending.contains("No machines"), "{pending}");

        view.apply_machines(Vec::new());
        let loaded = plain(&view.render(&theme(), 100, &kb(), 20));
        assert!(!loaded.contains("Loading machines"), "{loaded}");
        assert!(loaded.contains("No machines"), "{loaded}");

        let mut failed = LibraryView::loading(20);
        failed.set_list_error(Some("fetch failed".to_string()));
        let error = plain(&failed.render(&theme(), 100, &kb(), 20));
        assert!(error.contains("fetch failed"), "{error}");
        assert!(!error.contains("Loading machines"), "{error}");
        assert!(!error.contains("No machines"), "{error}");
    }
}
