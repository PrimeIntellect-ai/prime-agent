//! The `/factory` view's diagram model: the snapshot shapes (states,
//! transitions, live nodes, usage), the status glyphs and colors, the
//! compact guard rendering, and the Mermaid emitter. One graph model feeds
//! both the ASCII diagram and the Mermaid source, so the in-terminal
//! highlighting and the pasteable highlighting are the same statement.

use serde_json::Value;

use super::get_either;
use crate::theme::ThemeColor;

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
            id: value.get("id")?.as_str()?.to_string(),
            entry: value.get("entry").and_then(Value::as_bool).unwrap_or(false),
            lifecycle: value
                .get("lifecycle")
                .and_then(Value::as_str)
                .unwrap_or("task")
                .to_string(),
            max_entries: get_either(value, "max_entries", "maxEntries")
                .and_then(Value::as_u64)
                .unwrap_or(1),
            subagent: value
                .get("subagent")
                .and_then(Value::as_str)
                .map(str::to_string)
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
                .map(str::to_string)
                .collect::<Vec<_>>(),
            Some(Value::String(source)) => vec![source.clone()],
            _ => return None,
        };
        if from.is_empty() {
            return None;
        }
        Some(Self {
            from,
            to: value.get("to")?.as_str()?.to_string(),
            when: value
                .get("when")
                .and_then(format_guard)
                .filter(|guard| !guard.is_empty()),
        })
    }

    /// The compact edge label: `a + b` for a join, the source id otherwise.
    pub fn edge_label(&self) -> String {
        self.from.join(" + ")
    }
}

/// One last-fired edge from the snapshot's trailing window.
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryEdge {
    pub from: Vec<String>,
    pub to: String,
}

impl FactoryEdge {
    pub fn parse(value: &Value) -> Option<Self> {
        let from = match value.get("from") {
            Some(Value::Array(sources)) => sources
                .iter()
                .filter_map(|source| source.as_str())
                .map(str::to_string)
                .collect::<Vec<_>>(),
            Some(Value::String(source)) => vec![source.clone()],
            _ => return None,
        };
        if from.is_empty() {
            return None;
        }
        Some(Self {
            from,
            to: value.get("to")?.as_str()?.to_string(),
        })
    }

    /// The compact edge label, matching the transition's form.
    pub fn edge_label(&self) -> String {
        self.from.join(" + ")
    }

    /// Whether this fired edge is the given transition (the same sources
    /// and the same target; the snapshot's `from` may arrive in either
    /// order for a join, so the comparison is order-free).
    pub fn matches(&self, transition: &FactoryTransition) -> bool {
        self.to == transition.to
            && self.from.len() == transition.from.len()
            && self
                .from
                .iter()
                .all(|source| transition.from.contains(source))
    }
}

/// One live node's runtime state (the `status()` node shape, compact lane).
#[derive(Debug, Clone, PartialEq)]
pub struct FactoryNodeState {
    pub status: String,
    pub entries_used: u64,
    pub max_entries: u64,
    pub entries: Vec<String>,
    pub instances: Vec<String>,
    pub error: Option<String>,
}

impl FactoryNodeState {
    pub fn parse(value: &Value) -> Option<Self> {
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|entry| entry.get("status").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            status: value.get("status")?.as_str()?.to_string(),
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
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            error: value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
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
    /// inputs) or running, or — for snapshots without entry rows — the
    /// derived `running` status. A never-entered node (no entries) is not
    /// active: the diagram paints it dim, not bright.
    pub fn is_active(&self) -> bool {
        if self.entries.is_empty() {
            return self.status == "running";
        }
        self.entries
            .iter()
            .any(|status| status == "pending" || status == "running")
            || self.status == "running"
    }

    /// Instances still queued (prepared, never admitted).
    pub fn pending_instances(&self) -> u64 {
        self.instances
            .iter()
            .filter(|status| *status == "pending")
            .count() as u64
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
        None => Some(format!("{output}{op}")),
    }
}

/// The Mermaid source for one run: a `flowchart TD` with the same graph
/// model as the ASCII diagram, `classDef` styling matching the terminal
/// diagram's highlighting (`active` bright for the in-flight nodes,
/// `pending` dim for the queued ones), and `linkStyle` marks on the
/// last-fired edges — pasteable to GitHub or mermaid.live, rendering the
/// same highlighting.
///
/// Node ids are index-based (`s0`, `s1`, ...) with the machine's state ids
/// as labels, so any valid state id renders verbatim; join edges render
/// dotted (one per source) with the join label.
#[must_use]
pub fn mermaid_source(run: &super::FactoryRunSnapshot) -> String {
    let mut lines: Vec<String> = Vec::new();
    let spec_id = &run.spec_id;
    let header = match (&run.name, run.state.as_deref()) {
        (Some(name), Some(state)) => format!("%% factory: {name} — {state}"),
        (Some(name), None) => format!("%% factory: {name}"),
        (None, Some(state)) => format!("%% factory: {spec_id} — {state}"),
        (None, None) => format!("%% factory spec: {spec_id}"),
    };
    lines.push(header);
    lines.push("flowchart TD".to_string());
    // Node declarations: index ids, label carries the state id (and the
    // entry marker).
    for (index, state) in run.states.iter().enumerate() {
        let label = if state.entry {
            format!("{}*", state.id)
        } else {
            state.id.clone()
        };
        lines.push(format!("    s{index}[\"{label}\"]"));
    }
    // Edge declarations in machine order; join edges render per source,
    // dotted, with the join label.
    let mut edge_index = 0usize;
    let mut fired_edges: Vec<usize> = Vec::new();
    for transition in &run.transitions {
        let label = match (&transition.when, transition.from.len() > 1) {
            (Some(guard), true) => format!("join: {guard}"),
            (Some(guard), false) => guard.clone(),
            (None, true) => "join".to_string(),
            (None, false) => "settled".to_string(),
        };
        let fired = run.last_fired.iter().any(|edge| edge.matches(transition));
        for source in &transition.from {
            let Some(source_index) = run.states.iter().position(|state| &state.id == source) else {
                continue;
            };
            let Some(target_index) = run
                .states
                .iter()
                .position(|state| state.id == transition.to)
            else {
                continue;
            };
            let arrow = if transition.from.len() > 1 {
                "-.->"
            } else {
                "-->"
            };
            lines.push(format!(
                "    s{source_index} {arrow}|{label}| s{target_index}"
            ));
            if fired {
                fired_edges.push(edge_index);
            }
            edge_index += 1;
        }
    }
    // The class definitions: `active` is the diagram's bright class,
    // `pending` its dim queued class (the terminal diagram's dim `pending`
    // glyph — queued nodes never paint bright).
    lines.push(
        "    classDef active fill:#16a34a,stroke:#15803d,stroke-width:3px,color:#f8fafc"
            .to_string(),
    );
    lines.push(
        "    classDef pending fill:#1e293b,stroke:#475569,stroke-width:1px,color:#cbd5e1"
            .to_string(),
    );
    lines.push(
        "    classDef done fill:#475569,stroke:#64748b,stroke-width:1px,color:#e2e8f0".to_string(),
    );
    lines.push(
        "    classDef error fill:#b91c1c,stroke:#dc2626,stroke-width:2px,color:#fee2e2".to_string(),
    );
    // Class assignments from the live overlay: running bright (active),
    // queued dim (pending), errors red, everything settled done.
    for (index, state) in run.states.iter().enumerate() {
        let class = match run.nodes.get(&state.id) {
            Some(node) if node.status == "running" => "active",
            Some(node) if node.status == "pending" => "pending",
            Some(node) if node.status == "error" => "error",
            Some(_) => "done",
            None => continue,
        };
        lines.push(format!("    class s{index} {class}"));
    }
    // The last-fired edge marks (linkStyle indexes count every emitted
    // edge, including join legs).
    for index in fired_edges {
        lines.push(format!(
            "    linkStyle {index} stroke:#16a34a,stroke-width:3px"
        ));
    }
    lines.join("\n")
}
