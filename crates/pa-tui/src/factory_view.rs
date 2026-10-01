//! The `/factory` view: one panel per live factory run — the machine
//! diagram with live highlighting, the run's state, the instances running
//! and queued, the budget consumed, and the milestone tail, with the
//! orchestration keys (stop/resume) and the copy-mermaid action.
//!
//! The view is pure presentation and selection: the session UI owns the
//! refresh cadence (the run's collect cycle: a bounded watch on the
//! selected run, then the graph list), executes the actions through the
//! daemon's `factory_activity` lane, and repaints on the snapshot
//! signatures' hysteresis (a per-transition repaint never spams: only a
//! notice-worthy run-shape change flips the changed marker).
//!
//! The diagram is the honest in-terminal machine graph: every state as a
//! status-glyphed row in the machine's declared order, its outgoing
//! transitions as connector rows underneath (joins rendered once, back
//! edges marked), active nodes bright, pending nodes dim, and the
//! last-fired edges marked. The same graph model emits genuine Mermaid
//! source (a `flowchart TD` with `classDef active` styling and
//! `linkStyle` marks on the last-fired edges) for the copy action —
//! pasteable to GitHub or mermaid.live, rendering the same highlighting.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

mod diagram;
#[cfg(test)]
mod tests;

use diagram::{
    edge_marker, node_glyph, run_state_color, FactoryEdge, FactoryNodeState, FactoryState,
    FactoryTransition, FactoryUsage,
};

/// The refresh cadence's watch bound (ms): the kernel's own collect poll
/// slice (`POLL_TIMEOUT_MS`), so a change repaints at the run's pace.
pub const FACTORY_WATCH_TICK_MS: u64 = 2_000;

/// How many trailing milestone labels a panel shows.
pub const MILESTONE_TAIL: usize = 3;

/// One run's fused snapshot (the kernel `factory.graph` shape).
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryRunSnapshot {
    pub run_id: String,
    pub spec_id: String,
    pub name: Option<String>,
    pub state: Option<String>,
    pub elapsed_ms: u64,
    pub budget_limit_ms: Option<u64>,
    pub usage: Option<FactoryUsage>,
    pub states: Vec<FactoryState>,
    pub transitions: Vec<FactoryTransition>,
    pub last_fired: Vec<FactoryEdge>,
    pub milestones: Vec<String>,
    pub nodes: std::collections::HashMap<String, FactoryNodeState>,
}

impl FactoryRunSnapshot {
    /// The panel header's display name: the run's name, else the spec id,
    /// else the run id's head.
    #[must_use]
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| self.spec_id.clone())
    }

    /// The hysteresis signature: the run's notice-worthy shape (the run
    /// state, every node's entry/instance statuses, and the fired-edge
    /// set). Two snapshots with the same signature paint the same panel.
    /// The clock never trips the signature: `elapsed_ms` advances on every
    /// poll, so including it would light the changed marker on every
    /// refresh and the marker would never decay (the elapsed display
    /// repaints on the refresh cadence; only a run-shape change is
    /// notice-worthy).
    #[must_use]
    pub fn signature(&self) -> String {
        let mut parts = vec![self.state.clone().unwrap_or_default()];
        for state in &self.states {
            let node = self.nodes.get(&state.id);
            parts.push(state.id.clone());
            parts.push(node.map_or_else(|| "pending".to_string(), FactoryNodeState::signature));
        }
        for edge in &self.last_fired {
            parts.push(format!("{}->{}", edge.edge_label(), edge.to));
        }
        parts.join("|")
    }

    /// The states with an in-flight entry (the diagram's bright rows).
    #[must_use]
    pub fn active_state_ids(&self) -> Vec<String> {
        self.states
            .iter()
            .filter(|state| {
                self.nodes
                    .get(&state.id)
                    .is_some_and(FactoryNodeState::is_active)
            })
            .map(|state| state.id.clone())
            .collect()
    }
}

/// Parse the daemon `factory_activity` graph reply: `{"runs": [...]}` in
/// the kernel's compact snapshot shape. Malformed rows drop (a truncated
/// panel never renders), and an unknown shape answers an empty view.
#[must_use]
pub fn parse_factory_runs(data: &Value) -> Vec<FactoryRunSnapshot> {
    let Some(runs) = data.get("runs").and_then(Value::as_array) else {
        return Vec::new();
    };
    runs.iter().filter_map(parse_run).collect()
}

/// Whether a reply is the graph list shape at all: a reply without the
/// `runs` list is a malformed lane, not zero runs — the session UI
/// reports it on the open page's error line instead of painting a fake
/// empty state (the emptiness the view shows is real).
#[must_use]
pub fn factory_reply_lists_runs(data: &Value) -> bool {
    data.as_object()
        .is_some_and(|object| object.contains_key("runs"))
}

fn opt_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

/// One field read that tolerates both spellings: the kernel's
/// conversation shape (`snake_case`) and the activity lane's wire shape
/// (`camelCase` — `_wire_payload` re-keys the reply before it travels).
/// The two spellings never coexist in one reply; either resolves.
fn get_either<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    value.get(snake).or_else(|| value.get(camel))
}

/// Parse one run row: the kernel's compact snapshot shape
/// (`_graph_snapshot` in `rlm/factory.py`) with `run_id`/`spec_id`
/// carrying the identity, `elapsed_ms`/`budget.limit_ms` the clock and
/// budget, `usage` the counters, and `machine`/`nodes`/`last_fired`/
/// `events` the fused structure and live overlay. Every key read
/// tolerates both spellings: the activity wire carries the `camelCase`
/// form (`_wire_payload` converts the reply before it travels) and the
/// kernel's conversation shape stays `snake_case`.
fn parse_run(run: &Value) -> Option<FactoryRunSnapshot> {
    let run_id = opt_string(get_either(run, "run_id", "runId")).unwrap_or_default();
    let spec_id = opt_string(get_either(run, "spec_id", "specId")).unwrap_or_default();
    if run_id.is_empty() && spec_id.is_empty() {
        return None;
    }
    let machine = run.get("machine")?;
    let states = machine
        .get("states")
        .and_then(Value::as_array)
        .map(|states| states.iter().filter_map(FactoryState::parse).collect())
        .unwrap_or_default();
    let transitions = machine
        .get("transitions")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(FactoryTransition::parse).collect())
        .unwrap_or_default();
    let last_fired = get_either(run, "last_fired", "lastFired")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(FactoryEdge::parse).collect())
        .unwrap_or_default();
    let mut nodes = std::collections::HashMap::new();
    for node in run
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let (Some(id), Some(node)) = (opt_string(node.get("id")), FactoryNodeState::parse(node))
        {
            nodes.insert(id, node);
        }
    }
    let milestones = run
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("milestone"))
        .filter_map(|event| opt_string(event.get("milestone")))
        .collect();
    Some(FactoryRunSnapshot {
        run_id,
        spec_id,
        name: opt_string(run.get("name")),
        state: opt_string(run.get("state")),
        elapsed_ms: get_either(run, "elapsed_ms", "elapsedMs")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        budget_limit_ms: run
            .get("budget")
            .and_then(|budget| get_either(budget, "limit_ms", "limitMs"))
            .and_then(Value::as_u64),
        usage: FactoryUsage::parse(run.get("usage")),
        states,
        transitions,
        last_fired,
        milestones,
        nodes,
    })
}

/// One key press while the `/factory` view is open, resolved by the view's
/// own key loop (the session UI executes the returned action).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactoryViewAction {
    None,
    /// Stop the selected run.
    Stop {
        run_id: String,
    },
    /// Resume the selected (paused) run.
    Resume {
        run_id: String,
    },
    /// Copy the selected run's Mermaid source.
    CopyMermaid {
        source: String,
    },
    Close,
}

/// The `/factory` view's state: the parsed run panels, the selection, and
/// the hysteresis bookkeeping.
#[derive(Debug)]
pub struct FactoryView {
    runs: Vec<FactoryRunSnapshot>,
    /// Per-run recent-change markers: set by [`Self::apply_runs`] when the
    /// signature changed, decayed on the next cycle (no per-transition
    /// repaint spam — one marker per notice-worthy change).
    recent_change: Vec<bool>,
    selected: usize,
    error: Option<String>,
    viewport_rows: usize,
}

impl FactoryView {
    /// Build the view from the first snapshot batch.
    #[must_use]
    pub fn new(runs: Vec<FactoryRunSnapshot>, viewport_rows: usize) -> Self {
        let recent_change = vec![false; runs.len()];
        Self {
            runs,
            recent_change,
            selected: 0,
            error: None,
            viewport_rows,
        }
    }

    /// Apply one refreshed snapshot batch: keep the selection on the same
    /// run, and light the changed marker exactly on the runs whose
    /// signature changed this cycle (the marker decays when the run goes
    /// quiet — the repaint hysteresis, no per-transition spam). Returns
    /// whether any run changed.
    pub fn apply_runs(&mut self, runs: Vec<FactoryRunSnapshot>) -> bool {
        let mut changed = false;
        let mut recent_change = Vec::with_capacity(runs.len());
        for run in &runs {
            let is_new = self
                .runs
                .iter()
                .find(|old| old.run_id == run.run_id)
                .is_some_and(|old| old.signature() != run.signature());
            recent_change.push(is_new);
            if is_new {
                changed = true;
            }
        }
        // Keep the selection on the same run id.
        let selected_id = self.runs.get(self.selected).map(|run| run.run_id.clone());
        self.runs = runs;
        self.recent_change = recent_change;
        if let Some(selected_id) = selected_id {
            if let Some(index) = self.runs.iter().position(|run| run.run_id == selected_id) {
                self.selected = index;
            }
        }
        self.selected = self.selected.min(self.runs.len().saturating_sub(1));
        changed
    }

    /// The selected run's snapshot, when any run is live.
    #[must_use]
    pub fn selected_run(&self) -> Option<&FactoryRunSnapshot> {
        self.runs.get(self.selected)
    }

    /// Record one fetch/error line from the session UI's refresh.
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error;
    }

    /// One key press: j/k (or the arrow keys) move the selection, s stops
    /// the selected run, r resumes it, m copies its Mermaid source, and
    /// Esc/Ctrl+C close the view.
    #[must_use]
    pub fn handle_key(&mut self, key: &str, _kb: &KeybindingsManager) -> FactoryViewAction {
        match key {
            // `key_event_to_id` reports the Escape key as "escape"; "esc"
            // stays accepted for the callers that already normalize.
            "escape" | "esc" | "ctrl+c" => return FactoryViewAction::Close,
            "down" | "j" | "tab" => {
                if !self.runs.is_empty() {
                    self.selected = (self.selected + 1).min(self.runs.len() - 1);
                }
            }
            "up" | "k" | "shift+tab" => {
                self.selected = self.selected.saturating_sub(1);
            }
            "s" => {
                if let Some(run) = self.selected_run() {
                    if !run.run_id.is_empty() {
                        return FactoryViewAction::Stop {
                            run_id: run.run_id.clone(),
                        };
                    }
                }
            }
            "r" => {
                if let Some(run) = self.selected_run() {
                    if run.state.as_deref() == Some("paused") && !run.run_id.is_empty() {
                        return FactoryViewAction::Resume {
                            run_id: run.run_id.clone(),
                        };
                    }
                }
            }
            "m" => {
                if let Some(run) = self.selected_run() {
                    return FactoryViewAction::CopyMermaid {
                        source: diagram::mermaid_source(run),
                    };
                }
            }
            _ => {}
        }
        FactoryViewAction::None
    }

    /// Render the view: one panel per live run (the machine diagram with
    /// live highlighting), the empty state when nothing runs, and the
    /// trailing key hint.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        // The panel area: one panel per run, each panel's row range
        // recorded for the budget window below.
        let mut panels: Vec<Line> = Vec::new();
        let mut panel_ranges: Vec<(usize, usize)> = Vec::new();
        if self.runs.is_empty() {
            panels.push(vec![Span::raw("")]);
            panels.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Text, "No live factory runs."),
            ]);
            panels.push(vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Muted,
                    "Start one from the conversation: await rlm.factory.run('<spec_id>')",
                ),
            ]);
        }
        for (index, run) in self.runs.iter().enumerate() {
            if index > 0 {
                panels.push(vec![Span::raw("")]);
            }
            let panel_start = panels.len();
            self.render_panel(theme, width, run, index, &mut panels);
            panel_ranges.push((panel_start, panels.len()));
        }
        // The chrome area: the error line from the last failed refresh and
        // the trailing key hint. The chrome always renders — the hint is
        // the view's only key legend.
        let mut chrome_rows = 2usize;
        if self.error.is_some() {
            chrome_rows += 2;
        }
        // The dock's frame budget owns the final trim; the view never
        // renders more rows than the viewport asked for. A tall view
        // windows over the panel area: the trailing window keeps the
        // newest panels, and when the selected run's panel falls outside
        // it the window slides to the selection (a stop/resume target
        // never hides behind the budget); the chrome stays pinned at the
        // end either way.
        let budget = self.viewport_rows.max(1);
        let panel_budget = budget.saturating_sub(chrome_rows);
        if panels.len() > panel_budget {
            let mut start = panels.len().saturating_sub(panel_budget);
            if let Some((selected_start, _)) = panel_ranges.get(self.selected) {
                start = start.min(*selected_start);
            }
            if start > 0 {
                panels.drain(..start);
            }
            panels.truncate(panel_budget);
        }
        let mut rows = panels;
        if let Some(error) = &self.error {
            rows.push(vec![Span::raw("")]);
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
                format!(
                    "{} select · {} stop · {} resume · {} copy mermaid · {} close",
                    format_key_text("j/k"),
                    format_key_text("s"),
                    format_key_text("r"),
                    format_key_text("m"),
                    format_key_text("esc"),
                ),
            ),
        ]);
        let _ = kb;
        // A degenerate budget (a sub-chrome viewport on a short terminal)
        // tail-clips: the hint is the chrome's last row and always survives.
        if rows.len() > budget {
            rows.drain(..rows.len() - budget);
        }
        rows.into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }

    /// One run panel: the header (name, state, changed marker), the stats
    /// line (budget consumed, parallel, instances), the machine diagram,
    /// and the milestone tail.
    fn render_panel(
        &self,
        theme: &Theme,
        width: usize,
        run: &FactoryRunSnapshot,
        index: usize,
        rows: &mut Vec<Line>,
    ) {
        let selected = index == self.selected;
        let changed = self.recent_change.get(index).copied().unwrap_or(false);
        // The header: the selection marker, the run's name, its state.
        let mut header: Line = vec![Span::raw(if selected { "▸ " } else { "  " })];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "factory: "));
        header.push(theme.fg_span(ThemeColor::Text, run.display_name()));
        let state_text = match run.state.as_deref() {
            Some(state) => format!(" — {state}"),
            None => " — not running".to_string(),
        };
        header.push(theme.fg_span(run_state_color(run.state.as_deref()), state_text));
        if changed {
            header.push(theme.fg_span(ThemeColor::Accent, "  ● changed"));
        }
        // The stats tail: elapsed, budget, parallel, instances.
        let running = run
            .usage
            .as_ref()
            .map(|usage| usage.running)
            .unwrap_or_default();
        let stats = vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Muted, Self::stats_line(run, running)),
        ];
        rows.push(header);
        rows.push(truncate_line(&stats, width, ""));
        rows.push(vec![Span::raw("")]);
        Self::render_diagram(theme, run, rows);
        if !run.milestones.is_empty() {
            let tail = run
                .milestones
                .iter()
                .rev()
                .take(MILESTONE_TAIL)
                .rev()
                .cloned()
                .collect::<Vec<_>>()
                .join(" · ");
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::MdQuote, "milestones: "),
                theme.fg_span(ThemeColor::Muted, tail),
            ]);
        }
    }

    fn stats_line(run: &FactoryRunSnapshot, running: u64) -> String {
        let elapsed = format_duration(run.elapsed_ms);
        let budget = match run.budget_limit_ms {
            Some(limit) => format!("budget {}/{}", elapsed, format_duration(limit)),
            None => format!("elapsed {elapsed}"),
        };
        let mut parts = vec![budget];
        if let Some(usage) = &run.usage {
            parts.push(format!(
                "{}/{} parallel",
                running.min(usage.max_parallel),
                usage.max_parallel
            ));
            parts.push(format!("{} settled", usage.settled));
            parts.push(format!("{} transitions", usage.transitions_fired));
        }
        let queued = run
            .nodes
            .values()
            .map(FactoryNodeState::pending_instances)
            .sum::<u64>();
        parts.push(format!("{running} running · {queued} queued"));
        parts.join(" · ")
    }

    /// The machine diagram: every state in the machine's declared order as
    /// a status-glyphed row, its outgoing transitions as connector rows
    /// (joins once, back edges marked, the last-fired edges marked and
    /// colored).
    fn render_diagram(theme: &Theme, run: &FactoryRunSnapshot, rows: &mut Vec<Line>) {
        let order: Vec<&str> = run.states.iter().map(|state| state.id.as_str()).collect();
        let position = |id: &str| order.iter().position(|candidate| *candidate == id);
        for state in &run.states {
            let node = run.nodes.get(&state.id);
            let (glyph, color) =
                node.map_or(("○", ThemeColor::Dim), |node| node_glyph(&node.status));
            let mut row: Line = vec![
                Span::raw("   "),
                theme.fg_span(color, glyph.to_string()),
                Span::raw(" "),
                // The whole row paints in the node's status color: active
                // nodes bright (accent), pending dim, done muted, errors
                // red — the diagram's live highlighting.
                theme.fg_span(color, state.id.clone()),
            ];
            if let Some(subagent) = &state.subagent {
                row.push(theme.fg_span(ThemeColor::Dim, format!(" ({subagent})")));
            }
            let status_text =
                node.map_or_else(|| "pending".to_string(), |node| node.status_line(state));
            row.push(theme.fg_span(color, format!("  {status_text}")));
            if state.entry {
                row.push(theme.fg_span(ThemeColor::Dim, "  [entry]".to_string()));
            }
            rows.push(row);
            // The outgoing edges under the source: single-source transitions
            // render once; a join (a multi-source from list) renders once
            // under its last source with the join label.
            let mut edges: Vec<FactoryTransition> = Vec::new();
            edges.extend(
                run.transitions
                    .iter()
                    .filter(|transition| {
                        transition.from.last().is_some_and(|from| from == &state.id)
                    })
                    .cloned(),
            );
            for edge in &edges {
                let fired = run
                    .last_fired
                    .iter()
                    .any(|candidate| candidate.matches(edge));
                let (marker, marker_color) = edge_marker(edge, &order, position);
                let mut row: Line = vec![Span::raw("   "), Span::raw("│ ")];
                if fired {
                    row.push(theme.fg_span(ThemeColor::Success, "»".to_string()));
                }
                row.push(theme.fg_span(
                    if fired {
                        ThemeColor::Success
                    } else {
                        marker_color
                    },
                    format!("{marker}▶ "),
                ));
                row.push(theme.fg_span(ThemeColor::MdLink, edge.to.clone()));
                if edge.from.len() > 1 {
                    row.push(
                        theme.fg_span(ThemeColor::Dim, format!(" (join: {})", edge.edge_label())),
                    );
                }
                if let Some(guard) = &edge.when {
                    row.push(theme.fg_span(ThemeColor::Dim, format!(" when {guard}")));
                }
                rows.push(row);
            }
        }
    }
}

/// A compact duration: seconds under a minute, minutes under an hour.
fn format_duration(ms: u64) -> String {
    let seconds = ms / 1_000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m{:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h{:02}m", seconds / 3_600, (seconds % 3_600) / 60)
    }
}
