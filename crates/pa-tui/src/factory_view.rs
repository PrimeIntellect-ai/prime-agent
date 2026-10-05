//! The `/factory` view: one panel per live factory run — the machine
//! diagram with live highlighting, the run's state, the instances
//! running and queued, the budget consumed, and the milestone tail — on
//! the activity pages' picker keyset (arrows + Enter + Esc): the arrows
//! move the run selection over the NEWEST-FIRST feed (a run created
//! after an existing one renders above it, and the page opens with the
//! newest run selected), Enter opens the selected run's in-page action
//! rows (stop/resume — the heartbeats picker's drill-in shape), and Esc
//! backs out of the open action rows or closes the page.
//!
//! The view is pure presentation and selection: the session UI owns the
//! refresh cadence (the run's collect cycle: a bounded watch on the
//! selected run, then the graph list), executes the actions through the
//! daemon's `factory_activity` lane, and repaints on the snapshot
//! signatures' hysteresis (a per-transition repaint never spams: only a
//! notice-worthy run-shape change flips the changed marker).
//!
//! The diagram is the honest in-terminal machine graph: every state as a
//! status-glyphed row in the machine's declared order — the row's label
//! carrying the stage's agent occupancy (`reviewing (3 run · 2 queued)`:
//! how many agents run at the node, how many queue behind them) — its
//! outgoing transitions as connector rows underneath (joins rendered
//! once, back edges marked), active nodes bright, pending nodes dim, and
//! the last-fired edges marked.

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

    /// The states with an in-flight entry or live instances (the
    /// diagram's bright rows).
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

    /// Whether the run still holds running children (admitted residents,
    /// or any in-flight instance a terminal state can carry — a `done`
    /// run whose residents still run stays actionable).
    #[must_use]
    pub fn children_in_flight(&self) -> bool {
        self.usage.as_ref().is_some_and(|usage| usage.running > 0)
    }

    /// Whether the run is LIVE in the dock/page sense: a live state
    /// (running/stopping/paused), or children still in flight — the
    /// kernel's own unscoped-list liveness rule (`state in live_states
    /// or running > 0`): a `done`/`failed` run whose resident children
    /// still run keeps its panel, its dock count, and its stop control
    /// while any child runs, and a fully terminal run offers nothing.
    #[must_use]
    pub fn is_live(&self) -> bool {
        matches!(
            self.state.as_deref(),
            Some("running" | "stopping" | "paused")
        ) || self.children_in_flight()
    }
}

/// One run-level action the page offers on a live run (the heartbeats
/// picker's action-row grammar): the stop that tears the run and its
/// children down, and the pause complement's resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactoryAction {
    Stop,
    Resume,
}

impl FactoryAction {
    /// The action row's label.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Stop => "Stop the run",
            Self::Resume => "Resume the run",
        }
    }
}

/// Parse the daemon `factory_activity` graph reply: `{"runs": [...]}` in
/// the kernel's compact snapshot shape. Malformed rows drop (a truncated
/// panel never renders), and an unknown shape answers an empty view.
///
/// The reply carries the registry's start order, oldest run first (the
/// kernel's documented polling order — `FactoryExecutor.graph` in
/// `rlm/factory.py`); the view reads NEWEST-FIRST, like a live activity
/// feed, so this seam reverses the list exactly once and every view path
/// (the mount and the refresh fold) receives the same reading order. The
/// wire contract stays stable: the kernel reply and the agent
/// conversation API keep their oldest-first order — the reading order is
/// presentation. Reversal, never an `elapsedMs` sort: the elapsed clock
/// grows live, truncates to whole milliseconds, and each row snapshots
/// at its own tick, so two close-start runs could flip between
/// refreshes; the reply's start order is total and stable.
#[must_use]
pub fn parse_factory_runs(data: &Value) -> Vec<FactoryRunSnapshot> {
    let Some(runs) = data.get("runs").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut parsed: Vec<FactoryRunSnapshot> = runs.iter().filter_map(parse_run).collect();
    parsed.reverse();
    parsed
}

/// Whether a reply is the graph list shape at all: a reply without the
/// `runs` LIST (absent, or present but not an array) is a malformed
/// lane, not zero runs — the session UI reports it on the open page's
/// error line instead of painting a fake empty state (the emptiness the
/// view shows is real).
#[must_use]
pub fn factory_reply_lists_runs(data: &Value) -> bool {
    data.get("runs").is_some_and(Value::is_array)
}

/// The malformed-lane error line (one message for the mount and the
/// fold): a reply without the runs list is a malformed lane, never
/// zero runs.
pub const MALFORMED_REPLY_ERROR: &str = "malformed factory reply (no runs list)";

fn opt_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

/// One daemon-provided DISPLAY string, scrubbed: control bytes never
/// reach a styled span (`scrub_controls`, the bash activity lane's
/// rule — a run name or milestone carrying an OSC sequence can never
/// drive the terminal, e.g. overwrite the operator's clipboard via
/// OSC 52). The scrub lands at this parse seam, so every paint path
/// (the panel header, the diagram rows, the milestone tail, the
/// Mermaid copy) sees terminal-safe text; the run id stays raw — it
/// never reaches a span and must round-trip the kernel's registry as
/// the stop/resume/watch identity.
fn scrubbed_string(value: Option<&Value>) -> Option<String> {
    opt_string(value).map(|text| crate::menu_panel::scrub_controls(&text))
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
/// kernel's conversation shape stays `snake_case`. Every DISPLAY string
/// scrubs its control bytes ([`scrubbed_string`]) — daemon-provided
/// text never drives the terminal — and the run id stays raw (the
/// stop/resume/watch identity must round-trip the kernel's registry).
fn parse_run(run: &Value) -> Option<FactoryRunSnapshot> {
    let run_id = opt_string(get_either(run, "run_id", "runId")).unwrap_or_default();
    let spec_id = scrubbed_string(get_either(run, "spec_id", "specId")).unwrap_or_default();
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
        if let (Some(id), Some(node)) = (
            scrubbed_string(node.get("id")),
            FactoryNodeState::parse(node),
        ) {
            nodes.insert(id, node);
        }
    }
    let milestones = run
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("milestone"))
        .filter_map(|event| scrubbed_string(event.get("milestone")))
        .collect();
    Some(FactoryRunSnapshot {
        run_id,
        spec_id,
        name: scrubbed_string(run.get("name")),
        state: scrubbed_string(run.get("state")),
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
    Close,
}

/// The page's mode: the run feed, or the selected run's open action rows
/// (the heartbeats picker's list/detail drill-in shape, one level — the
/// feed stays mounted behind the action rows; there is no separate detail
/// page to paint).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    /// The run feed: the arrows walk the run selection.
    Feed,
    /// The open run's action rows: the arrows walk the offered actions.
    /// The tracked action rides by IDENTITY, not index — a fold may
    /// change the run's state (and with it the offered set) while the
    /// rows are open, and a tracked index would silently rename the
    /// selection to a different action (the feed's same-run lesson, one
    /// level up).
    Actions {
        run_id: String,
        action: FactoryAction,
    },
}

/// The `/factory` view's state: the parsed run panels, the selection, the
/// open action rows, and the hysteresis bookkeeping.
#[derive(Debug)]
pub struct FactoryView {
    runs: Vec<FactoryRunSnapshot>,
    /// Per-run recent-change markers: set by [`Self::apply_runs`] when the
    /// signature changed, decayed on the next cycle (no per-transition
    /// repaint spam — one marker per notice-worthy change).
    recent_change: Vec<bool>,
    selected: usize,
    mode: Mode,
    error: Option<String>,
    viewport_rows: usize,
}

impl FactoryView {
    /// Build the view from the first snapshot batch. The batch arrives
    /// newest-first ([`parse_factory_runs`]'s reading order), so the
    /// default selection — index 0 — is the newest run: the page opens on
    /// the feed's live head.
    #[must_use]
    pub fn new(runs: Vec<FactoryRunSnapshot>, viewport_rows: usize) -> Self {
        let recent_change = vec![false; runs.len()];
        Self {
            runs,
            recent_change,
            selected: 0,
            mode: Mode::Feed,
            error: None,
            viewport_rows,
        }
    }

    /// The actions the page offers on one run (the heartbeats picker's
    /// `availableActions` grammar): the pause complement first — resume
    /// on a paused run — then stop, exactly while the run is live (a
    /// `done` run with residents still in flight keeps its stop; a
    /// fully terminal run offers nothing). The offered set is derived
    /// from the run's CURRENT snapshot everywhere — the render, the
    /// arrow walk, the Enter confirmation — so a fold's state change
    /// can never leave a stale action offered.
    #[must_use]
    pub fn available_actions(run: &FactoryRunSnapshot) -> Vec<FactoryAction> {
        let mut actions = Vec::with_capacity(2);
        if run.run_id.is_empty() {
            return actions;
        }
        if run.state.as_deref() == Some("paused") {
            actions.push(FactoryAction::Resume);
        }
        if run.is_live() {
            actions.push(FactoryAction::Stop);
        }
        actions
    }

    /// Mount the view from the poll cache (the open path's builder): the
    /// parsed panels, and — when the cached reply is a malformed lane (no
    /// runs list) — the malformed-reply error set at once. A malformed
    /// cache can never mount as a silent fake empty state: the fold's
    /// malformed-reply contract holds at mount too, so the page's first
    /// frame already says why the list is empty instead of waiting a
    /// poll cycle for the fold to say it.
    #[must_use]
    pub fn from_reply(data: &Value, viewport_rows: usize) -> Self {
        let mut view = Self::new(parse_factory_runs(data), viewport_rows);
        if !factory_reply_lists_runs(data) {
            view.set_error(Some(MALFORMED_REPLY_ERROR.to_string()));
        }
        view
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
        // Keep the selection on the same run id, never the same index:
        // the list reads newest-first, so a newer run folding in moves
        // the selected run down without stealing the selection. A run
        // that left the batch (the wire cap's oldest-end trim, a
        // cleared registry) returns the selection to the feed's head —
        // the newest run — because the same slot names a different run
        // in the reversed order.
        let selected_id = self.runs.get(self.selected).map(|run| run.run_id.clone());
        self.runs = runs;
        self.recent_change = recent_change;
        self.selected = match selected_id {
            Some(selected_id) => self
                .runs
                .iter()
                .position(|run| run.run_id == selected_id)
                .unwrap_or(0),
            None => 0,
        };
        // The open action rows ride the same fold discipline as the
        // feed's selection: a run that left the batch closes the rows,
        // and a state change under them re-reads the offered set — a
        // paused run that stopped mid-menu no longer offers resume,
        // and the tracked action clamps to what the run still offers
        // (never a stale target: the rows confirm against the folded
        // snapshot, not the one they opened on).
        if let Mode::Actions { run_id, action } = self.mode.clone() {
            let offered = self
                .runs
                .iter()
                .find(|run| run.run_id == run_id)
                .map(Self::available_actions)
                .unwrap_or_default();
            match offered.first().copied() {
                None => self.mode = Mode::Feed,
                Some(first) if !offered.contains(&action) => {
                    self.mode = Mode::Actions {
                        run_id,
                        action: first,
                    };
                }
                Some(_) => {}
            }
        }
        changed
    }

    /// The selected run's snapshot, when any run is live.
    #[must_use]
    pub fn selected_run(&self) -> Option<&FactoryRunSnapshot> {
        self.runs.get(self.selected)
    }

    /// Record one fetch/error line from the session UI's refresh. The
    /// message is daemon-provided text painted on the chrome line, so it
    /// scrubs — an OSC sequence in a reply's error reason can never
    /// drive the terminal.
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// One key press on the activity pages' picker keyset (arrows +
    /// Enter + Esc — the heartbeats/bash pages' family): the arrows
    /// move the selection (the feed's run, or the open action rows'
    /// action), Enter opens the selected run's action rows or runs the
    /// selected action, and Esc/ctrl+c back out of the open action rows
    /// or close the page. Every binding reads the keybinding manager
    /// (`tui.select.up`/`down`/`confirm`/`cancel`), so a user's remap
    /// reaches this page exactly like its siblings.
    #[must_use]
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> FactoryViewAction {
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            // Esc backs out of the open action rows before it closes
            // the page — the drill-in's back, on the one close key the
            // page carries (the keyset stays arrows + Enter + Esc).
            if self.mode != Mode::Feed {
                self.mode = Mode::Feed;
                return FactoryViewAction::None;
            }
            return FactoryViewAction::Close;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta: isize = if kb.matches(key, "tui.select.up") {
                -1
            } else {
                1
            };
            self.move_selection(delta);
            return FactoryViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm_selection();
        }
        FactoryViewAction::None
    }

    /// One arrow step: the feed walks the run selection (newest-first —
    /// down the feed reads OLDER), the open action rows walk their
    /// offered set. A run that left the batch under open rows closes
    /// them (the fold's own hand-back, reached from the key path too).
    fn move_selection(&mut self, delta: isize) {
        match self.mode.clone() {
            Mode::Feed => {
                if self.runs.is_empty() {
                    return;
                }
                let next = (self.selected as isize + delta).clamp(0, self.runs.len() as isize - 1)
                    as usize;
                self.selected = next;
            }
            Mode::Actions { run_id, action } => {
                let Some(run) = self.runs.iter().find(|run| run.run_id == run_id) else {
                    self.mode = Mode::Feed;
                    return;
                };
                let actions = Self::available_actions(run);
                let Some(current) = actions.iter().position(|candidate| *candidate == action)
                else {
                    return;
                };
                let next = (current as isize + delta).clamp(0, actions.len() as isize - 1) as usize;
                self.mode = Mode::Actions {
                    run_id,
                    action: actions[next],
                };
            }
        }
    }

    /// Enter: the feed opens the selected run's action rows (when the
    /// run offers any — a terminal run answers nothing), the open rows
    /// run the selected action and return to the feed. The
    /// confirmation re-resolves the run and its offered set against
    /// the CURRENT batch — a fold may have changed the run's state, or
    /// dropped the run, while the rows were open — so the action lands
    /// on the folded truth, never a stale target.
    fn confirm_selection(&mut self) -> FactoryViewAction {
        match self.mode.clone() {
            Mode::Feed => {
                if let Some(run) = self.selected_run() {
                    if let Some(action) = Self::available_actions(run).first().copied() {
                        self.mode = Mode::Actions {
                            run_id: run.run_id.clone(),
                            action,
                        };
                    }
                }
                FactoryViewAction::None
            }
            Mode::Actions { run_id, action } => {
                let offered = self
                    .runs
                    .iter()
                    .find(|run| run.run_id == run_id)
                    .map(Self::available_actions)
                    .unwrap_or_default();
                self.mode = Mode::Feed;
                if offered.contains(&action) {
                    match action {
                        FactoryAction::Stop => FactoryViewAction::Stop { run_id },
                        FactoryAction::Resume => FactoryViewAction::Resume { run_id },
                    }
                } else {
                    FactoryViewAction::None
                }
            }
        }
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
        // The chrome area: the open action rows, the error line from the
        // last failed refresh, and the trailing key hint. The chrome
        // always renders — the hint is the view's only key legend, and
        // the action rows are the page's only action surface.
        let action_rows = self.action_block(theme);
        let mut chrome_rows = 2 + action_rows.len();
        if self.error.is_some() {
            chrome_rows += 2;
        }
        // The dock's frame budget owns the final trim; the view never
        // renders more rows than the viewport asked for. A tall view
        // windows over the panel area: the leading window keeps the top
        // of the feed (the newest panels — the oldest panels drop
        // first), and when the focused run's panel falls below it the
        // window slides to it (the focused run is the actionable one —
        // the feed's selection, or the run whose action rows are
        // open — so a stop/resume target never hides behind the
        // budget); the chrome stays pinned at the end either way.
        let focus = match &self.mode {
            Mode::Actions { run_id, .. } => self
                .runs
                .iter()
                .position(|run| &run.run_id == run_id)
                .unwrap_or(self.selected),
            Mode::Feed => self.selected,
        };
        let budget = self.viewport_rows.max(1);
        let panel_budget = budget.saturating_sub(chrome_rows);
        if panels.len() > panel_budget {
            let mut start = 0;
            if let Some((focus_start, _)) = panel_ranges.get(focus) {
                if *focus_start >= panel_budget {
                    start = *focus_start;
                }
            }
            if start > 0 {
                panels.drain(..start);
            }
            panels.truncate(panel_budget);
        }
        let mut rows = panels;
        rows.extend(action_rows);
        if let Some(error) = &self.error {
            rows.push(vec![Span::raw("")]);
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        rows.push(vec![Span::raw("")]);
        let hint = match self.mode {
            Mode::Feed => Self::feed_hint(kb),
            Mode::Actions { .. } => Self::actions_hint(kb),
        };
        rows.push(vec![Span::raw("  "), theme.fg_span(ThemeColor::Dim, hint)]);
        // A degenerate budget (a sub-chrome viewport on a short terminal)
        // tail-clips: the hint is the chrome's last row and always survives.
        if rows.len() > budget {
            rows.drain(..rows.len() - budget);
        }
        rows.into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }

    /// The feed's bottom hint line (the heartbeats/bash pages' grammar):
    /// the arrows move, Enter opens the selected run's action rows, Esc
    /// closes.
    fn feed_hint(kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        format!(
            "{}/{} move \u{b7} {} actions \u{b7} {} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
            key("tui.select.cancel", "Esc"),
        )
    }

    /// The open action rows' hint line: the arrows walk the actions,
    /// Enter runs the tracked one, Esc backs out to the feed.
    fn actions_hint(kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        format!(
            "{}/{} action \u{b7} {} run \u{b7} {} back",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
            key("tui.select.cancel", "Esc"),
        )
    }

    /// The open action rows (the heartbeats picker's drill-in, one
    /// level): a blank, a header naming the run, one row per offered
    /// action with the tracked one marked. The block rides the
    /// trailing chrome — the panel window's budget keeps it and the
    /// hint painted together.
    fn action_block(&self, theme: &Theme) -> Vec<Line> {
        let Mode::Actions { run_id, action } = &self.mode else {
            return Vec::new();
        };
        let Some(run) = self.runs.iter().find(|run| &run.run_id == run_id) else {
            return Vec::new();
        };
        let mut rows = vec![vec![Span::raw("")]];
        let mut header: Line = vec![Span::raw("  ")];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "actions: "));
        header.push(theme.fg_span(ThemeColor::Text, run.display_name()));
        rows.push(header);
        for offered in Self::available_actions(run) {
            let tracked = offered == *action;
            let mut row: Line = vec![Span::raw("  ")];
            row.push(Span::raw(if tracked { "▸ " } else { "  " }));
            row.push(theme.fg_span(
                if tracked {
                    ThemeColor::Text
                } else {
                    ThemeColor::Muted
                },
                offered.label().to_string(),
            ));
            rows.push(row);
        }
        rows
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
            .map(FactoryNodeState::queued_agents)
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
            // The row paints by the NODE's live activity, not the aggregate
            // status: a multi-entry state whose latest entry settled while
            // an earlier one still runs stays bright (is_active covers
            // every entry's status, not just the newest).
            let (glyph, color) = match node {
                Some(node) if node.is_active() => ("●", ThemeColor::Accent),
                Some(node) => node_glyph(&node.status),
                None => ("○", ThemeColor::Dim),
            };
            let mut row: Line = vec![
                Span::raw("   "),
                theme.fg_span(color, glyph.to_string()),
                Span::raw(" "),
                // The whole row paints in the node's status color: active
                // nodes bright (accent), pending dim, done muted, errors
                // red — the diagram's live highlighting.
                theme.fg_span(color, state.id.clone()),
            ];
            // The stage's agent occupancy rides the label — `reviewing
            // (3 run · 2 queued)` — so the diagram reads as a page of
            // machines with per-stage headcounts; a stage at rest
            // carries no fragment. The counts come from the kernel's
            // per-state report (the instance rows are the older-kernel
            // fallback), and the row's status color is unchanged.
            if let Some(node) = node {
                let occupancy = node.occupancy_label();
                if !occupancy.is_empty() {
                    row.push(theme.fg_span(color, format!(" ({occupancy})")));
                }
            }
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
