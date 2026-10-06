//! The `/factory` view's diagram model: the snapshot shapes (states,
//! transitions, live nodes, usage — including each stage's agent
//! occupancy counts), the status glyphs and colors, and the compact
//! guard rendering. One graph model feeds the ASCII diagram, so the
//! in-terminal highlighting and the per-stage occupancy labels are the
//! same statement. Every daemon-provided string the model keeps scrubs
//! its control bytes at the parse seam (`scrubbed`): wire text can
//! never drive the terminal.

use serde_json::Value;

use super::get_either;
use crate::theme::ThemeColor;

/// One daemon-provided string scrubbed for the terminal
/// (`crate::menu_panel::scrub_controls`, the bash activity lane's rule):
/// the diagram's rows paint wire-provided ids, subagent names, guard
/// labels, statuses, and errors — none of them may carry a control byte
/// into a styled span (an OSC sequence in that text could otherwise
/// drive the terminal, e.g. overwrite the operator's clipboard via
/// OSC 52). The scrub lands at this parse seam, so every diagram row
/// paints terminal-safe text.
fn scrubbed(text: &str) -> String {
    crate::menu_panel::scrub_controls(text)
}

/// One machine state's declared shape.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryState {
    pub id: String,
    pub entry: bool,
    pub lifecycle: String,
    pub max_entries: u64,
    pub subagent: Option<String>,
}

impl FactoryState {
    pub fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            id: scrubbed(value.get("id")?.as_str()?),
            entry: value.get("entry").and_then(Value::as_bool).unwrap_or(false),
            lifecycle: value
                .get("lifecycle")
                .and_then(Value::as_str)
                .map_or_else(|| "task".to_string(), scrubbed),
            max_entries: get_either(value, "max_entries", "maxEntries")
                .and_then(Value::as_u64)
                .unwrap_or(1),
            subagent: value
                .get("subagent")
                .and_then(Value::as_str)
                .map(scrubbed)
                .filter(|text| !text.is_empty()),
        })
    }
}

/// One declared transition: a join carries every source in `from`.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryTransition {
    pub from: Vec<String>,
    pub to: String,
    pub when: Option<String>,
}

impl FactoryTransition {
    pub fn parse(value: &Value) -> Option<Self> {
        let from = match value.get("from") {
            Some(Value::Array(sources)) => sources
                .iter()
                .filter_map(|source| source.as_str())
                .map(scrubbed)
                .collect::<Vec<_>>(),
            Some(Value::String(source)) => vec![scrubbed(source)],
            _ => return None,
        };
        if from.is_empty() {
            return None;
        }
        Some(Self {
            from,
            to: scrubbed(value.get("to")?.as_str()?),
            when: value
                .get("when")
                .and_then(format_guard)
                .map(|guard| scrubbed(&guard))
                .filter(|guard| !guard.is_empty()),
        })
    }

    /// The compact edge label: `a + b` for a join, the source id otherwise.
    pub fn edge_label(&self) -> String {
        self.from.join(" + ")
    }
}

/// One last-fired edge from the snapshot's trailing window. The optional
/// `when` carries the guard that fired — two guarded transitions may
/// share one from+to pair, so the guard is the identity that tells the
/// diagram WHICH of them fired.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryEdge {
    pub from: Vec<String>,
    pub to: String,
    pub when: Option<String>,
}

impl FactoryEdge {
    pub fn parse(value: &Value) -> Option<Self> {
        let from = match value.get("from") {
            Some(Value::Array(sources)) => sources
                .iter()
                .filter_map(|source| source.as_str())
                .map(scrubbed)
                .collect::<Vec<_>>(),
            Some(Value::String(source)) => vec![scrubbed(source)],
            _ => return None,
        };
        if from.is_empty() {
            return None;
        }
        Some(Self {
            from,
            to: scrubbed(value.get("to")?.as_str()?),
            when: value
                .get("when")
                .and_then(format_guard)
                .map(|guard| scrubbed(&guard))
                .filter(|guard| !guard.is_empty()),
        })
    }

    /// The compact edge label, matching the transition's form.
    pub fn edge_label(&self) -> String {
        self.from.join(" + ")
    }

    /// Whether this fired edge is the given transition (the same
    /// sources, the same target, and the same guard — the snapshot's
    /// `from` may arrive in either order for a join, so the source
    /// comparison is order-free; a shared from+to pair with different
    /// guards never cross-marks).
    pub fn matches(&self, transition: &FactoryTransition) -> bool {
        self.to == transition.to
            && self.from.len() == transition.from.len()
            && self
                .from
                .iter()
                .all(|source| transition.from.contains(source))
            && self.when == transition.when
    }
}

/// One live node's runtime state (the `status()` node shape, compact
/// lane). `running`/`queued` are the kernel's per-stage agent counts —
/// how many agents run at the stage and how many queue behind them —
/// and both are single-word keys, so the wire's two spellings carry
/// them identically. `None` on an older kernel's reply, where the
/// accessors derive the counts from the instance rows.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryNodeState {
    pub status: String,
    pub entries_used: u64,
    pub max_entries: u64,
    pub entries: Vec<String>,
    pub instances: Vec<String>,
    pub error: Option<String>,
    pub running: Option<u64>,
    pub queued: Option<u64>,
}

impl FactoryNodeState {
    pub fn parse(value: &Value) -> Option<Self> {
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|entry| entry.get("status").and_then(Value::as_str))
                    .map(scrubbed)
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            status: scrubbed(value.get("status")?.as_str()?),
            entries,
            entries_used: get_either(value, "entries_used", "entriesUsed")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            max_entries: get_either(value, "max_entries", "maxEntries")
                .and_then(Value::as_u64)
                .unwrap_or(1),
            instances: value
                .get("instances")
                .and_then(Value::as_array)
                .map(|instances| {
                    instances
                        .iter()
                        .filter_map(|instance| instance.get("status").and_then(Value::as_str))
                        .map(scrubbed)
                        .collect()
                })
                .unwrap_or_default(),
            error: value.get("error").and_then(Value::as_str).map(scrubbed),
            running: value.get("running").and_then(Value::as_u64),
            queued: value.get("queued").and_then(Value::as_u64),
        })
    }

    /// The hysteresis signature's node part: the status, entries, and
    /// per-instance statuses.
    pub fn signature(&self) -> String {
        format!(
            "{}/{}:{}[{}]",
            self.status,
            self.entries_used,
            self.max_entries,
            self.instances.join(",")
        )
    }

    /// Whether the node is in flight: an entry pending (awaiting its
    /// inputs) or running, an instance still running or queued, or — for
    /// snapshots without entry rows — the derived `running` status. The
    /// instance arm is the occupancy contract: a foreach entry that failed
    /// permanently is terminal at the entry layer while its admitted
    /// siblings still run, so the row stays bright exactly while its
    /// occupancy label can be nonzero. A never-entered node (no entries)
    /// is not active: the diagram paints it dim, not bright.
    pub fn is_active(&self) -> bool {
        if self.entries.is_empty() {
            return self.status == "running";
        }
        self.entries
            .iter()
            .any(|status| status == "pending" || status == "running")
            || self.status == "running"
            || self.running_agents() > 0
            || self.queued_agents() > 0
    }

    /// Agents at this stage in flight (admitted children still
    /// running): the kernel's per-stage count when the reply carries
    /// it, else derived from the instance rows (an older kernel's
    /// reply).
    #[must_use]
    pub fn running_agents(&self) -> u64 {
        self.running
            .unwrap_or_else(|| self.instance_count("running"))
    }

    /// Agents at this stage queued (prepared, never admitted): the
    /// kernel's per-stage count when the reply carries it, else derived
    /// from the instance rows (an older kernel's reply).
    #[must_use]
    pub fn queued_agents(&self) -> u64 {
        self.queued
            .unwrap_or_else(|| self.instance_count("pending"))
    }

    fn instance_count(&self, status: &str) -> u64 {
        self.instances.iter().filter(|row| *row == status).count() as u64
    }

    /// The stage's occupancy label — `3 run · 2 queued` — when agents
    /// sit at this stage; a stage at rest carries no fragment. The
    /// ASCII row renders the stage's live headcount.
    #[must_use]
    pub fn occupancy_label(&self) -> String {
        let running = self.running_agents();
        let queued = self.queued_agents();
        if running == 0 && queued == 0 {
            String::new()
        } else {
            format!("{running} run · {queued} queued")
        }
    }

    /// The row's status text: the status, the entry count, and the error
    /// when one settled badly.
    #[must_use]
    pub fn status_line(&self, state: &FactoryState) -> String {
        let mut text = self.status.clone();
        if state.max_entries > 1 {
            text.push(' ');
            text.push_str(&self.entries_used.min(state.max_entries).to_string());
            text.push('/');
            text.push_str(&state.max_entries.to_string());
        }
        if let Some(error) = &self.error {
            text.push_str(" (");
            text.push_str(error);
            text.push(')');
        }
        text
    }
}

/// The run's usage block.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryUsage {
    pub running: u64,
    pub settled: u64,
    pub spawns: u64,
    pub tool_uses: u64,
    pub max_parallel: u64,
    pub transitions_fired: u64,
}

impl FactoryUsage {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        Some(Self {
            running: value
                .get("running")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            settled: value
                .get("settled")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            spawns: value
                .get("spawns")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            tool_uses: get_either(value, "tool_uses", "toolUses")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            max_parallel: get_either(value, "max_parallel", "maxParallel")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            transitions_fired: get_either(value, "transitions_fired", "transitionsFired")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        })
    }
}

/// The status glyph and color for one node row: active nodes bright,
/// pending dim, done muted, errors red (the diagram's highlighting).
#[must_use]
pub fn node_glyph(status: &str) -> (&'static str, ThemeColor) {
    match status {
        "running" => ("●", ThemeColor::Accent),
        "pending" => ("◐", ThemeColor::Dim),
        "done" => ("✓", ThemeColor::Muted),
        "error" => ("✗", ThemeColor::Error),
        "cancelled" => ("⊘", ThemeColor::Muted),
        _ => ("○", ThemeColor::Dim),
    }
}

/// The run-state color for the panel header.
#[must_use]
pub fn run_state_color(state: Option<&str>) -> ThemeColor {
    match state {
        Some("running" | "stopping") => ThemeColor::Accent,
        Some("paused") => ThemeColor::Warning,
        Some("done") => ThemeColor::Success,
        Some("failed" | "stopped") => ThemeColor::Error,
        _ => ThemeColor::Muted,
    }
}

/// The connector marker for one transition row: the last edge under a
/// source uses the elbow (`└`), joins use the crossbar (`╪`), and a back
/// edge (re-entry, a target earlier in the machine's declared order)
/// carries the return marker (`↩`).
#[must_use]
pub fn edge_marker(
    transition: &FactoryTransition,
    order: &[&str],
    position: impl Fn(&str) -> Option<usize>,
) -> (&'static str, ThemeColor) {
    let back_edge = position(&transition.to)
        .zip(transition.from.first().map(String::as_str))
        .is_some_and(|(target, source)| {
            position(source).is_some_and(|source_position| target < source_position)
        });
    let color = if back_edge {
        ThemeColor::Muted
    } else {
        ThemeColor::BorderMuted
    };
    let marker = if transition.from.len() > 1 {
        "├╪"
    } else if back_edge {
        "├↩"
    } else if order.last().is_some_and(|last| *last == transition.from[0]) {
        "└"
    } else {
        "├"
    };
    (marker, color)
}

/// The compact guard rendering: `verdict.approved eq false`.
#[must_use]
pub fn format_guard(when: &Value) -> Option<String> {
    let object = when.as_object()?;
    let output = object.get("output").and_then(Value::as_str)?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .map(|path| format!(".{path}"))
        .unwrap_or_default();
    let op = object.get("op").and_then(Value::as_str).unwrap_or("eq");
    match object.get("value") {
        Some(value) => Some(format!(
            "{output}{path} {op} {}",
            serde_json::to_string(value).ok()?
        )),
        // The valueless form reads `output.path op` (the same shape as the
        // valued form minus the comparison target — `verdict exists`, not
        // `verdictexists`).
        None => Some(format!("{output}{path} {op}")),
    }
}
