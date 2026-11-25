//! The run view: ONE run — the SAME block diagram the machine view
//! draws, with the live overlay painted over it. The run's header and
//! stats ride the top; every state's box carries its status glyph and
//! color (running accent, done muted, error red, pending dim), its agent
//! occupancy (`… · 3 run · 2 queued`), and its spawned child sessions
//! nested underneath; the last-fired edges light green. The machines
//! list is the multi-run surface (the stacked feed retired).
//!
//! The arrows walk the run's header and EVERY state in declared order
//! (a state without a child stays selectable — the node view inspects
//! never-entered and python states too); Enter opens the state's NODE
//! VIEW (the shared inspection surface: the instance list, the realized
//! prompt, the inputs, the answer, the template files), `o`/→ open the
//! state's latest child session through the standard session open, ←/Esc
//! close the page. Navigation never acts on a run: the stop rides the
//! agents view's two-press `app.agents.delete` grammar (a header stops
//! its run, a state stops its running child), and `r` resumes a paused
//! run.
//!
//! The view is pure presentation and selection: the session UI owns the
//! refresh cadence (the run's collect cycle: a bounded watch on the
//! selected run, then the graph list), executes the actions (run
//! stop/resume on the daemon's `factory_activity` lane, the node view's
//! `node` fetch, a child stop on `cancel_rlm_child`, the open through
//! the session's roster), and repaints on the snapshot signatures'
//! hysteresis (a per-transition repaint never spams: only a
//! notice-worthy run-shape change flips the repaint signal).

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

mod blocks;
mod diagram;
mod library;
mod mermaid;
pub(crate) mod node;
#[cfg(test)]
mod tests;

pub use library::{
    library_reply_lists_machines, overview_reply_lists_runs, parse_library_machines,
    parse_library_warnings, parse_overview_runs, parse_overview_warnings, LibraryMachine,
    LibraryRun, LibraryView, LibraryViewAction, MALFORMED_LIBRARY_REPLY_ERROR,
    MALFORMED_OVERVIEW_REPLY_ERROR,
};

use blocks::{block_diagram, DiagramOverlay, OverlayChild, OverlayNode};
use diagram::{
    node_glyph, run_state_color, FactoryEdge, FactoryNodeState, FactoryState, FactoryTransition,
    FactoryUsage,
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

    /// Whether the run is paused (an escalate, budget, or max-* pause
    /// waiting for resume): live, but not running. Every count splits the
    /// live runs on this one predicate.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.state.as_deref() == Some("paused")
    }
}

/// The live runs split on [`FactoryRunSnapshot::is_paused`]: the agents
/// view's factory line shows the running runs apart from the paused
/// ones (the bar's machines item shows the running count alone).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FactoryRunCounts {
    pub running: usize,
    pub paused: usize,
}

impl FactoryRunCounts {
    /// Count the live runs of one parsed reply.
    #[must_use]
    pub fn of(runs: &[FactoryRunSnapshot]) -> Self {
        let mut counts = Self::default();
        for run in runs.iter().filter(|run| run.is_live()) {
            if run.is_paused() {
                counts.paused += 1;
            } else {
                counts.running += 1;
            }
        }
        counts
    }
}

/// The activity dock's expanded items: the live runs, paused first,
/// each `<name> <state>` — the count item beside them numbers the
/// running runs only.
#[must_use]
pub fn dock_factory_items(runs: &[FactoryRunSnapshot]) -> Vec<String> {
    let mut live: Vec<&FactoryRunSnapshot> = runs.iter().filter(|run| run.is_live()).collect();
    live.sort_by_key(|run| !run.is_paused());
    live.iter()
        .map(|run| match &run.state {
            Some(state) => format!("{} {state}", run.display_name()),
            None => run.display_name(),
        })
        .collect()
}

/// One run-level action the page offers on a live run: the stop that
/// tears the run and its children down, and the pause complement's
/// resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactoryAction {
    Stop,
    Resume,
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

/// The live runs in a graph reply ([`FactoryRunSnapshot::is_live`]).
#[must_use]
pub fn live_run_count(data: &Value) -> usize {
    parse_factory_runs(data)
        .iter()
        .filter(|run| run.is_live())
        .count()
}

/// A session's stored factory specs: the host's `factorySpecs` count, carried by the unscoped
/// graph reply and by an inactive session's catalog row (absent reads zero).
#[must_use]
pub fn stored_spec_count(data: &Value) -> usize {
    data.get("factorySpecs")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or_default()
}

/// A session's stored factory specs (durable) and its live runs, the paused ones apart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FactoryCounts {
    pub specs: usize,
    pub runs: FactoryRunCounts,
}

impl FactoryCounts {
    /// The counts of an unscoped graph reply.
    #[must_use]
    pub fn of(data: &Value) -> Self {
        Self {
            specs: stored_spec_count(data),
            runs: FactoryRunCounts::of(&parse_factory_runs(data)),
        }
    }

    /// `N machines · M running[ · K paused]`, or `None` while the session has neither specs nor
    /// live runs: the agents view's per-session factory line shows exactly then. The bar's
    /// machines item composes its own running count directly — never route the bar back
    /// through this label; its specs and paused segments belong to the agents view alone.
    #[must_use]
    pub fn label(self) -> Option<String> {
        let FactoryRunCounts { running, paused } = self.runs;
        (self.specs > 0 || running + paused > 0).then(|| {
            let noun = if self.specs == 1 {
                "machine"
            } else {
                "machines"
            };
            let paused = if paused > 0 {
                format!(" \u{b7} {paused} paused")
            } else {
                String::new()
            };
            format!("{} {noun} \u{b7} {running} running{paused}", self.specs)
        })
    }
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
pub(crate) fn parse_run(run: &Value) -> Option<FactoryRunSnapshot> {
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
    /// Open the selected state's latest child session.
    Open {
        child_id: String,
    },
    /// Open the selected state's node view (the shared inspection
    /// surface: the realized prompt, the inputs, the answer, the child
    /// session lines).
    OpenNode {
        run_id: String,
        state_id: String,
    },
    /// Stop the selected run (a confirmed stop on its header).
    Stop {
        run_id: String,
    },
    /// Stop the selected state's running child (a confirmed stop on its
    /// state row); `label` names the row (`<run>/<state>`).
    StopChild {
        child_id: String,
        label: String,
    },
    /// Resume the selected (paused) run.
    Resume {
        run_id: String,
    },
    Close,
}

/// One selectable row, by identity: a run's header (`state_id` `None`)
/// or one of its states with a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactoryRow {
    pub run_id: String,
    pub state_id: Option<String>,
}

impl FactoryRow {
    /// A run's header row (the machines page's run rows open the run page
    /// on it).
    #[must_use]
    pub fn header(run_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            state_id: None,
        }
    }
}

/// The `/factory` view's state: the parsed run panels, the selected row,
/// the armed stop, and the hysteresis bookkeeping.
#[derive(Debug)]
pub struct FactoryView {
    runs: Vec<FactoryRunSnapshot>,
    selected: Option<FactoryRow>,
    /// The row a first stop press armed, with the stop it armed: the next
    /// stop press on the same row confirms exactly that stop (a child a
    /// retry replaced in between is a different stop), any other key
    /// disarms.
    armed: Option<(FactoryRow, FactoryViewAction)>,
    error: Option<String>,
    viewport_rows: usize,
    /// The open node view (the shared inspection surface): mounted by
    /// Enter on a state row, closed by Esc back to the diagram.
    pub node: Option<node::NodeView>,
}

impl FactoryView {
    /// Build the view from the first snapshot batch. The batch arrives
    /// newest-first ([`parse_factory_runs`]'s reading order), so the
    /// default selection — the first row — is the newest run's header.
    #[must_use]
    pub fn new(runs: Vec<FactoryRunSnapshot>, viewport_rows: usize) -> Self {
        let mut view = Self {
            runs,
            selected: None,
            armed: None,
            error: None,
            viewport_rows,
            node: None,
        };
        view.selected = view.rows().into_iter().next();
        view
    }

    pub fn set_viewport_rows(&mut self, rows: usize) {
        self.viewport_rows = rows;
    }

    /// The run-level actions the page offers on one run: resume on a
    /// paused run, then stop exactly while the run is live (a `done` run
    /// with residents still in flight keeps its stop; a fully terminal
    /// run offers nothing). Always read from the run's CURRENT snapshot,
    /// so a fold's state change never leaves a stale action offered.
    #[must_use]
    pub fn available_actions(run: &FactoryRunSnapshot) -> Vec<FactoryAction> {
        let mut actions = Vec::with_capacity(2);
        if run.run_id.is_empty() {
            return actions;
        }
        if run.is_paused() {
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

    /// The selectable rows in display order, flattened across panels:
    /// each run's header, then its states whose node has a session
    /// ([`FactoryNodeState::latest_child`]).
    /// The focused run: the selected row's run, else the first (the run
    /// view is the single-run detail; the machines list is the multi-run
    /// surface).
    pub(crate) fn focused_run(&self) -> Option<&FactoryRunSnapshot> {
        let run_id = self
            .selected
            .as_ref()
            .map(|row| row.run_id.as_str())
            .or_else(|| self.runs.first().map(|run| run.run_id.as_str()));
        let id = run_id?;
        self.runs.iter().find(|run| run.run_id == id)
    }

    fn rows(&self) -> Vec<FactoryRow> {
        self.focused_run().map(Self::run_rows).unwrap_or_default()
    }

    /// One run's walk rows: its header, then every state in declared
    /// order — the node view inspects never-entered and python states
    /// too, so a state without a child is still selectable.
    fn run_rows(run: &FactoryRunSnapshot) -> Vec<FactoryRow> {
        let mut rows = vec![FactoryRow::header(&run.run_id)];
        rows.extend(run.states.iter().map(|state| FactoryRow {
            run_id: run.run_id.clone(),
            state_id: Some(state.id.clone()),
        }));
        rows
    }

    /// Apply one refreshed snapshot batch: keep the selection on the same
    /// row, and return whether any run's signature changed this cycle
    /// (the repaint hysteresis, no per-transition spam — the run page's
    /// changed marker retired with the stacked feed; the machines list's
    /// live rows are the signal).
    pub fn apply_runs(&mut self, runs: Vec<FactoryRunSnapshot>) -> bool {
        let mut changed = false;
        for run in &runs {
            let is_new = self
                .runs
                .iter()
                .find(|old| old.run_id == run.run_id)
                .is_some_and(|old| old.signature() != run.signature());
            if is_new {
                changed = true;
            }
        }
        self.runs = runs;
        // The selection rides the row's identity, never its index (the
        // feed reads newest-first, so a newer run folding in shifts every
        // index): a vanished state falls back to its run's header, a
        // vanished run to the first row. The candidate rows come from
        // the SELECTION's own run (the walk's focused run can be another
        // run entirely), falling back to the feed's head.
        let previous = self.selected.take();
        let candidates = previous
            .as_ref()
            .map(|row| row.run_id.as_str())
            .and_then(|run_id| self.runs.iter().find(|run| run.run_id == run_id))
            .or_else(|| self.runs.first())
            .map(Self::run_rows)
            .unwrap_or_default();
        self.selected = match previous {
            Some(row) if candidates.contains(&row) => Some(row),
            Some(row) if candidates.contains(&FactoryRow::header(&row.run_id)) => {
                Some(FactoryRow::header(&row.run_id))
            }
            _ => candidates.into_iter().next(),
        };
        // An armed stop the row no longer offers (the run left the batch
        // or stopped offering stop, the child settled or a retry replaced
        // it) disarms.
        if self
            .armed
            .as_ref()
            .is_some_and(|(row, stop)| self.stop_action(row).as_ref() != Some(stop))
        {
            self.armed = None;
        }
        changed
    }

    /// The run that owns the selected row (the watch target and the run
    /// actions' target).
    #[must_use]
    pub fn selected_run(&self) -> Option<&FactoryRunSnapshot> {
        let selected = self.selected.as_ref()?;
        self.runs.iter().find(|run| run.run_id == selected.run_id)
    }

    #[must_use]
    pub fn selected_row(&self) -> Option<&FactoryRow> {
        self.selected.as_ref()
    }

    /// Select `row` by identity. A row the batch does not list yet stays
    /// selected until the refresh that lists it lands ([`Self::apply_runs`]
    /// keeps a listed selection).
    pub fn select(&mut self, row: FactoryRow) {
        self.selected = Some(row);
    }

    /// Record one fetch/error line from the session UI's refresh. The
    /// message is daemon-provided text painted on the chrome line, so it
    /// scrubs — an OSC sequence in a reply's error reason can never
    /// drive the terminal.
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// One key press. Navigation never acts on a run: the arrows (the
    /// `tui.select.up`/`down` bindings) walk the rows, Enter/→ open the
    /// selected state's session (inert on a header), ←/Esc/ctrl+c close
    /// the page. The stop rides the agents view's two-press grammar on
    /// `app.agents.delete`: the first press arms the selected row, a
    /// second press on it stops (the run on a header, the child on a
    /// state), and any other key only disarms. `r` resumes a paused run.
    #[must_use]
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> FactoryViewAction {
        // The open node view owns the keys first: the instance walk and
        // the scroll ride it; `o` jumps into the selected instance's
        // child session; Esc steps back to the diagram.
        if let Some(node_view) = self.node.as_mut() {
            // Esc steps back through the node view's own ladder: the
            // files document closes first, then the view itself (back
            // to the diagram); ctrl+c leaves the node view outright.
            if key == "ctrl+c" {
                self.node = None;
                return FactoryViewAction::None;
            }
            if kb.matches(key, "tui.select.cancel") {
                if !node_view.step_back() {
                    self.node = None;
                }
                return FactoryViewAction::None;
            }
            if key == "o" {
                return node_view
                    .selected_child()
                    .map_or(FactoryViewAction::None, |child_id| {
                        FactoryViewAction::Open {
                            child_id: child_id.to_string(),
                        }
                    });
            }
            if node_view.handle_key(key, kb, self.viewport_rows) {
                return FactoryViewAction::None;
            }
            return FactoryViewAction::None;
        }
        let armed = self.armed.take();
        if kb.matches(key, "app.agents.delete") {
            let Some(row) = self.selected.clone() else {
                return FactoryViewAction::None;
            };
            let Some(stop) = self.stop_action(&row) else {
                return FactoryViewAction::None;
            };
            if armed
                .as_ref()
                .is_some_and(|(armed_row, armed_stop)| *armed_row == row && *armed_stop == stop)
            {
                return stop;
            }
            self.armed = Some((row, stop));
            return FactoryViewAction::None;
        }
        if armed.is_some() {
            return FactoryViewAction::None;
        }
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            return FactoryViewAction::Close;
        }
        if kb.matches(key, "tui.select.up") {
            self.move_selection(-1);
            return FactoryViewAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            self.move_selection(1);
            return FactoryViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.open_node_selected();
        }
        // The horizontal arrows are fallbacks after the configured
        // bindings, so a rebound Left/Right keeps its configured action.
        match key {
            "left" => FactoryViewAction::Close,
            "right" | "o" => self.open_selected(),
            "r" => match self.selected_run() {
                Some(run) if Self::available_actions(run).contains(&FactoryAction::Resume) => {
                    FactoryViewAction::Resume {
                        run_id: run.run_id.clone(),
                    }
                }
                _ => FactoryViewAction::None,
            },
            _ => FactoryViewAction::None,
        }
    }

    /// One arrow step over the flattened rows; both ends clamp.
    fn move_selection(&mut self, delta: isize) {
        let rows = self.rows();
        if rows.is_empty() {
            return;
        }
        let current = self
            .selected
            .as_ref()
            .and_then(|selected| rows.iter().position(|row| row == selected))
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, rows.len() as isize - 1) as usize;
        self.selected = Some(rows[next].clone());
    }

    /// Enter on a state row: open the node view (the shared inspection
    /// surface — realized prompt, inputs, answer, the child session); a
    /// header opens nothing.
    fn open_node_selected(&self) -> FactoryViewAction {
        let Some(row) = self.selected.as_ref() else {
            return FactoryViewAction::None;
        };
        let Some(state_id) = row.state_id.clone() else {
            return FactoryViewAction::None;
        };
        FactoryViewAction::OpenNode {
            run_id: row.run_id.clone(),
            state_id,
        }
    }

    /// The selected state's latest child, as the open action; a header
    /// opens nothing.
    fn open_selected(&self) -> FactoryViewAction {
        self.selected
            .as_ref()
            .and_then(|row| self.row_child(row))
            .map_or(FactoryViewAction::None, |(child_id, _)| {
                FactoryViewAction::Open {
                    child_id: child_id.to_string(),
                }
            })
    }

    /// A state row's latest child and its instance row.
    fn row_child(&self, row: &FactoryRow) -> Option<(&str, &diagram::FactoryInstance)> {
        let run = self.runs.iter().find(|run| run.run_id == row.run_id)?;
        run.nodes.get(row.state_id.as_ref()?)?.latest_child()
    }

    /// The row's display label: the run's name, `<run>/<state>` for a
    /// state.
    fn row_label(&self, row: &FactoryRow) -> String {
        let run = self
            .runs
            .iter()
            .find(|run| run.run_id == row.run_id)
            .map_or_else(|| row.run_id.clone(), FactoryRunSnapshot::display_name);
        match &row.state_id {
            Some(state_id) => format!("{run}/{state_id}"),
            None => run,
        }
    }

    /// What a confirmed stop on the row does, when the row can be stopped
    /// now: a header stops its run while the run offers stop; a state
    /// stops its latest child while that child runs.
    fn stop_action(&self, row: &FactoryRow) -> Option<FactoryViewAction> {
        if row.state_id.is_some() {
            let (child_id, instance) = self.row_child(row)?;
            return (instance.status == "running").then(|| FactoryViewAction::StopChild {
                child_id: child_id.to_string(),
                label: self.row_label(row),
            });
        }
        let run = self.runs.iter().find(|run| run.run_id == row.run_id)?;
        Self::available_actions(run)
            .contains(&FactoryAction::Stop)
            .then(|| FactoryViewAction::Stop {
                run_id: run.run_id.clone(),
            })
    }

    /// Render the view: one panel per live run (the machine diagram with
    /// live highlighting), the empty state when nothing runs, and the
    /// trailing key hint.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        // The open node view IS the page (the diagram stays mounted
        // under it; Esc returns).
        if let Some(node_view) = &self.node {
            return node_view.render(theme, width, kb, self.viewport_rows);
        }
        // The panel area: one panel per run; the selected row's line (and
        // its panel's start) is recorded for the budget window below.
        let mut panels: Vec<Line> = Vec::new();
        let mut focus: Option<(usize, usize)> = None;
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
        // The run view renders ONE run (the focused run): the machines
        // list is the multi-run surface; this page is the single-run
        // detail the merge promises (the stacked feed retired).
        if let Some(run) = self.focused_run() {
            let panel_start = panels.len();
            if let Some(line) = self.render_panel(theme, width, run, &mut panels) {
                focus = Some((panel_start, line));
            }
        } else if let Some(row) = self.selected.as_ref().filter(|_| !self.runs.is_empty()) {
            // The selected run is not in the cached batch yet: the refresh
            // the open fired lists it.
            panels.push(vec![Span::raw("")]);
            panels.push(vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Muted,
                    format!("Loading run {}…", self.row_label(row)),
                ),
            ]);
        }
        // The chrome area: the error line from the last failed refresh
        // and the trailing key hint (the view's only key legend).
        let mut chrome_rows = 2;
        if self.error.is_some() {
            chrome_rows += 2;
        }
        // The dock's frame budget owns the final trim; the view never
        // renders more rows than the viewport asked for. A tall view
        // windows over the panel area: the leading window keeps the top
        // of the feed (the newest panels — the oldest panels drop
        // first), and when the selected row falls below it the window
        // slides: to the row's panel header when the row fits under it,
        // else just far enough to show the row (an open or stop target
        // never hides behind the budget); the chrome stays pinned at the
        // end.
        let budget = self.viewport_rows.max(1);
        let panel_budget = budget.saturating_sub(chrome_rows);
        if panels.len() > panel_budget {
            // The selected state slides into sight as its WHOLE box (the
            // block diagram's four-row box, not just its top border).
            let start = match focus {
                Some((panel_start, line)) if line >= panel_budget => {
                    let bottom = line + blocks::BOX_ROWS - 1;
                    if bottom - panel_start < panel_budget {
                        panel_start
                    } else {
                        bottom + 1 - panel_budget
                    }
                }
                _ => 0,
            };
            panels.drain(..start);
            panels.truncate(panel_budget);
        }
        let mut rows = panels;
        while rows.len() < panel_budget {
            rows.push(vec![]);
        }
        if let Some(error) = &self.error {
            rows.push(vec![Span::raw("")]);
            rows.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        rows.push(vec![Span::raw("")]);
        let (hint, hint_color) = self.hint(kb);
        rows.push(vec![Span::raw("  "), theme.fg_span(hint_color, hint)]);
        // A degenerate budget (a sub-chrome viewport on a short terminal)
        // tail-clips: the hint is the chrome's last row and always survives.
        if rows.len() > budget {
            rows.drain(..rows.len() - budget);
        }
        rows.into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }

    /// The bottom hint line: the confirm prompt while a stop is armed,
    /// else the keys, with stop/resume only when the selected row offers
    /// them.
    fn hint(&self, kb: &KeybindingsManager) -> (String, ThemeColor) {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let stop_key = key("app.agents.delete", "ctrl+x");
        if let Some((armed, _)) = &self.armed {
            return (
                format!(
                    "stop {}? {stop_key} again to confirm, any other key cancels",
                    self.row_label(armed)
                ),
                ThemeColor::Warning,
            );
        }
        let mut parts = vec![
            format!(
                "{}/{} node",
                key("tui.select.up", "\u{2191}"),
                key("tui.select.down", "\u{2193}"),
            ),
            format!("{} node view", key("tui.select.confirm", "Enter")),
            "o/\u{2192} open session".to_string(),
            "\u{2190} back".to_string(),
        ];
        if self
            .selected
            .as_ref()
            .is_some_and(|selected| self.stop_action(selected).is_some())
        {
            parts.push(format!("{stop_key} stop"));
        }
        if self
            .selected_run()
            .is_some_and(|run| Self::available_actions(run).contains(&FactoryAction::Resume))
        {
            parts.push("r resume".to_string());
        }
        (parts.join(" \u{b7} "), ThemeColor::Dim)
    }

    /// One run's page: the header (name, state), the stats line (budget
    /// consumed, parallel, instances), the overlaid machine diagram, and
    /// the milestone tail. Returns the selected row's line in `rows`.
    fn render_panel(
        &self,
        theme: &Theme,
        width: usize,
        run: &FactoryRunSnapshot,
        rows: &mut Vec<Line>,
    ) -> Option<usize> {
        let selected = self
            .selected
            .as_ref()
            .filter(|row| row.run_id == run.run_id);
        let header_selected = selected.is_some_and(|row| row.state_id.is_none());
        let selected_state = selected.and_then(|row| row.state_id.as_deref());
        // The header: the selection marker, the run's name, its state.
        let mut header: Line = vec![Span::raw(if header_selected { "▸ " } else { "  " })];
        header.push(theme.fg_span(ThemeColor::ToolTitle, "run: "));
        header.push(theme.fg_span(ThemeColor::Text, run.display_name()));
        let state_text = match run.state.as_deref() {
            Some(state) => format!(" — {state}"),
            None => " — not running".to_string(),
        };
        header.push(theme.fg_span(run_state_color(run.state.as_deref()), state_text));
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
        let header_line = rows.len();
        rows.push(header);
        rows.push(truncate_line(&stats, width, ""));
        rows.push(vec![Span::raw("")]);
        let state_line = Self::render_diagram(theme, run, selected_state, rows);
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
        if header_selected {
            Some(header_line)
        } else {
            state_line
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
    /// a status-glyphed row (the selected state marked), its outgoing
    /// transitions as connector rows (joins once, back edges marked, the
    /// last-fired edges marked and colored). Returns the selected state's
    /// line in `rows`.
    /// The run's diagram: the SAME block diagram the machine view
    /// draws, with the live overlay painted over it (the merged view's
    /// one canvas — the run page's separate row renderer retired).
    fn render_diagram(
        theme: &Theme,
        run: &FactoryRunSnapshot,
        selected_state: Option<&str>,
        rows: &mut Vec<Line>,
    ) -> Option<usize> {
        let overlay = Self::overlay_for(run);
        let selected =
            selected_state.and_then(|id| run.states.iter().position(|state| state.id == id));
        let diagram = block_diagram(
            theme,
            &run.states,
            &run.transitions,
            selected,
            Some(&overlay),
        );
        let mut selected_line = None;
        let offset = rows.len();
        for (index, line) in diagram.lines.into_iter().enumerate() {
            if selected.is_some_and(|selected| diagram.node_rows[selected] == index) {
                selected_line = Some(offset + index);
            }
            rows.push(line);
        }
        selected_line
    }

    /// The live overlay for one run: every state's status color and
    /// glyph, its agent occupancy, and the spawned child sessions
    /// nested under the box; the last-fired edges light the arrows.
    fn overlay_for(run: &FactoryRunSnapshot) -> DiagramOverlay {
        let run_short: String = run.run_id.chars().take(6).collect();
        let mut nodes = std::collections::HashMap::new();
        for state in &run.states {
            let Some(node) = run.nodes.get(&state.id) else {
                continue;
            };
            let (glyph, color) = node_glyph(&node.status);
            let children: Vec<OverlayChild> = node
                .instances
                .iter()
                // A pending instance with no child yet nests nothing:
                // the rows list SPAWNED sessions only.
                .filter(|instance| {
                    instance
                        .child
                        .as_deref()
                        .is_some_and(|child| !child.is_empty())
                })
                .map(|instance| {
                    let (_, instance_color) = node_glyph(instance.status.as_str());
                    // The node view's `#index · e<entry>` leads, so each
                    // instance (a foreach, a re-entry) stays apart when the
                    // row clips to the box.
                    let name = state.subagent.as_deref().unwrap_or("agent");
                    let label = format!(
                        "#{} · e{} {run_short}-{name}",
                        instance.index, instance.entry
                    );
                    OverlayChild {
                        label,
                        color: if instance.status == "running" {
                            ThemeColor::Accent
                        } else {
                            instance_color
                        },
                    }
                })
                .collect();
            nodes.insert(
                state.id.clone(),
                OverlayNode {
                    color: if node.is_active() {
                        ThemeColor::Accent
                    } else {
                        color
                    },
                    glyph: glyph.chars().next().unwrap_or('○'),
                    occupancy: node.occupancy_label(),
                    children,
                },
            );
        }
        let fired = run
            .last_fired
            .iter()
            .map(|edge| DiagramOverlay::fired_key(&edge.from, &edge.to, edge.when.as_deref()))
            .collect();
        DiagramOverlay { nodes, fired }
    }
}

/// A compact duration: seconds under a minute, minutes under an hour.
pub(crate) fn format_duration(ms: u64) -> String {
    let seconds = ms / 1_000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m{:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h{:02}m", seconds / 3_600, (seconds % 3_600) / 60)
    }
}
