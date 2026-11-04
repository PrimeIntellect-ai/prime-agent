use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::Value;

use super::{dim, grouped, js_to_fixed, raw_span, ClientLine, ClientSpan};
use crate::theme::ThemeColor;
use crate::width::{char_width, str_width};
const CONTEXT_BAR_WIDTH: usize = 10;
const MIN_LABEL_WIDTH: usize = 16;
/// The collapsed view's agent-row budget (a deliberate TS delta: TS
/// renders every row): a tree with at most this many rows renders the
/// full TS shape; a bigger tree keeps its highest-usage rows and folds
/// the rest into the summary row behind the expand hint.
const CONTEXT_ROW_BUDGET: usize = 10;

/// A JS number rendered with at most one decimal: `Math.round(x * 10) / 10`
/// through number-to-string (no trailing `.0`).
fn js_tenth(value: f64) -> String {
    let tenth = (value * 10.0).round() / 10.0;
    if tenth.fract() == 0.0 {
        format!("{}", tenth as u64)
    } else {
        format!("{tenth:.1}")
    }
}

/// The spend-relevant usage of one tree node (TS `Usage`, the fields the
/// display reads).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost_total: f64,
}

impl UsageTotals {
    /// `spentTokens`: input + output + cache read + cache write.
    fn spent_tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    /// Fold another parsed total into this one (the per-model tree sums).
    fn add_fold(&mut self, other: &UsageTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.cost_total += other.cost_total;
    }

    fn add(&mut self, other: &Value) {
        let u64_field = |value: &Value, field: &str| {
            value.get(field).and_then(Value::as_u64).unwrap_or_default()
        };
        self.input += u64_field(other, "input");
        self.output += u64_field(other, "output");
        self.cache_read += u64_field(other, "cacheRead");
        self.cache_write += u64_field(other, "cacheWrite");
        self.cost_total += other
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default();
    }
}

/// `formatCost`: `$<toFixed(2)>`.
fn format_cost(cost: f64) -> String {
    format!("${}", js_to_fixed(cost, 2))
}

/// One context-usage snapshot (TS `ContextUsage`); `None` tokens or
/// percent is the unknown-right-after-compaction state.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ContextUsageSnapshot {
    tokens: Option<u64>,
    context_window: u64,
    percent: Option<f64>,
}

impl ContextUsageSnapshot {
    /// `null` tokens/percent parse as `None`; absent fields parse the same
    /// way (both fail the TS null check).
    fn parse_field<T>(usage: &Value, field: &str, read: impl Fn(&Value) -> Option<T>) -> Option<T> {
        match usage.get(field) {
            Some(Value::Null) | None => None,
            Some(value) => read(value),
        }
    }
}

/// One model's own-usage bucket from the daemon's per-model fold
/// (`ownUsageByModel`): the spend billed at that model's rates.
#[derive(Debug, Clone, PartialEq)]
struct ModelUsage {
    provider: String,
    id: String,
    totals: UsageTotals,
}

/// One agent row of the context tree (TS `ContextTreeNode`), plus this
/// port's per-model own-usage breakdown (a deliberate TS delta: a session
/// that switches models mid-conversation shows which model billed what).
#[derive(Debug, Clone, PartialEq)]
struct ContextNode {
    id: String,
    label: String,
    status: String,
    model: Option<(String, String)>,
    own_usage: UsageTotals,
    own_usage_by_model: Vec<ModelUsage>,
    context_usage: Option<ContextUsageSnapshot>,
    /// The factory run that spawned this agent: `(run_id, spec_id)`.
    factory_run: Option<(String, String)>,
    /// A deleted subagent's billing row (the daemon keeps its spend).
    deleted: bool,
    children: Vec<ContextNode>,
}

fn parse_context_node(value: &Value) -> ContextNode {
    let usage_from = |usage: &Value| {
        let mut totals = UsageTotals::default();
        totals.add(usage);
        totals
    };
    let context_usage = value.get("contextUsage").map(|usage| ContextUsageSnapshot {
        tokens: ContextUsageSnapshot::parse_field(usage, "tokens", Value::as_u64),
        context_window: usage
            .get("contextWindow")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        percent: ContextUsageSnapshot::parse_field(usage, "percent", Value::as_f64),
    });
    ContextNode {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        label: value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: value.get("model").and_then(|model| {
            let provider = model.get("provider").and_then(Value::as_str)?;
            let id = model.get("id").and_then(Value::as_str)?;
            Some((provider.to_string(), id.to_string()))
        }),
        own_usage: value.get("ownUsage").map(usage_from).unwrap_or_default(),
        own_usage_by_model: value
            .get("ownUsageByModel")
            .and_then(Value::as_array)
            .map(|buckets| {
                buckets
                    .iter()
                    .filter_map(|bucket| {
                        let provider = bucket.get("provider")?.as_str()?.to_string();
                        let id = bucket.get("id")?.as_str()?.to_string();
                        let totals = bucket.get("ownUsage").map(usage_from)?;
                        Some(ModelUsage {
                            provider,
                            id,
                            totals,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        context_usage,
        factory_run: value.get("factory").and_then(|factory| {
            let run_id = factory.get("runId").and_then(Value::as_str)?;
            let spec_id = factory.get("specId").and_then(Value::as_str)?;
            Some((run_id.to_string(), spec_id.to_string()))
        }),
        deleted: value.get("deleted").and_then(Value::as_bool) == Some(true),
        children: value
            .get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().map(parse_context_node).collect())
            .unwrap_or_default(),
    }
}

/// A synthetic group row: a factory run's agents, or one parent's deleted
/// agents. Its usage sums the real agent rows under it; the grand totals
/// never read it.
#[derive(Debug, Clone, PartialEq)]
struct GroupRow {
    label: String,
    status: String,
    usage: UsageTotals,
    agents: usize,
    /// The collapse folded its agent rows into it.
    folded: bool,
}

/// What one rendered row shows.
enum RowKind<'a> {
    Agent(&'a ContextNode),
    Group(GroupRow),
}

/// One flattened tree row: an agent or group row and its drawing prefix.
struct TreeRow<'a> {
    kind: RowKind<'a>,
    prefix: String,
}

impl TreeRow<'_> {
    fn label(&self) -> String {
        match &self.kind {
            RowKind::Agent(node) => node.label.clone(),
            RowKind::Group(group) if group.folded => format!(
                "{} ({} {})",
                group.label,
                group.agents,
                if group.agents == 1 { "agent" } else { "agents" }
            ),
            RowKind::Group(group) => group.label.clone(),
        }
    }

    fn status(&self) -> &str {
        match &self.kind {
            RowKind::Agent(node) => &node.status,
            RowKind::Group(group) => &group.status,
        }
    }

    fn usage(&self) -> &UsageTotals {
        match &self.kind {
            RowKind::Agent(node) => &node.own_usage,
            RowKind::Group(group) => &group.usage,
        }
    }

    fn node(&self) -> Option<&ContextNode> {
        match &self.kind {
            RowKind::Agent(node) => Some(node),
            RowKind::Group(_) => None,
        }
    }
}

/// One collapse unit: an agent row alone, or a group row followed by every
/// row under it (a run ranks and hides as one).
struct RowUnit<'a> {
    rows: Vec<TreeRow<'a>>,
    usage: UsageTotals,
    agents: usize,
}

/// How a child joins a group row: its factory run first, else its deletion.
#[derive(PartialEq)]
enum GroupKey<'a> {
    Run { run_id: &'a str, spec_id: &'a str },
    Deleted,
}

fn group_key(node: &ContextNode) -> Option<GroupKey<'_>> {
    match &node.factory_run {
        Some((run_id, spec_id)) => Some(GroupKey::Run { run_id, spec_id }),
        None if node.deleted => Some(GroupKey::Deleted),
        None => None,
    }
}

/// One tree level's display items: ungrouped agents in tree order, and each
/// group at its first member's position.
enum TreeItem<'a> {
    Agent(&'a ContextNode),
    Group(GroupKey<'a>, Vec<&'a ContextNode>),
}

fn flatten_tree<'a>(root: &'a ContextNode, run_states: &HashMap<&str, &str>) -> Vec<RowUnit<'a>> {
    let mut units = vec![agent_unit(root, String::new())];
    walk_tree(&root.children, "", run_states, &mut units);
    units
}

fn agent_unit(node: &ContextNode, prefix: String) -> RowUnit<'_> {
    RowUnit {
        rows: vec![TreeRow {
            kind: RowKind::Agent(node),
            prefix,
        }],
        usage: node.own_usage,
        agents: 1,
    }
}

/// The branch glyph for one child and the prefix its own children continue.
fn branch(ancestors: &str, is_last: bool) -> (String, String) {
    if is_last {
        (
            format!("{ancestors}\u{2514}\u{2500} "),
            format!("{ancestors}   "),
        )
    } else {
        (
            format!("{ancestors}\u{251c}\u{2500} "),
            format!("{ancestors}\u{2502}  "),
        )
    }
}

fn walk_tree<'a>(
    children: &'a [ContextNode],
    ancestors: &str,
    run_states: &HashMap<&str, &str>,
    units: &mut Vec<RowUnit<'a>>,
) {
    let mut items: Vec<TreeItem<'a>> = Vec::new();
    for child in children {
        match group_key(child) {
            None => items.push(TreeItem::Agent(child)),
            Some(key) => {
                let group = items.iter_mut().find_map(|item| match item {
                    TreeItem::Group(existing, members) if *existing == key => Some(members),
                    _ => None,
                });
                match group {
                    Some(members) => members.push(child),
                    None => items.push(TreeItem::Group(key, vec![child])),
                }
            }
        }
    }
    let count = items.len();
    for (index, item) in items.into_iter().enumerate() {
        let (prefix, next) = branch(ancestors, index + 1 == count);
        match item {
            TreeItem::Agent(node) => {
                units.push(agent_unit(node, prefix));
                walk_tree(&node.children, &next, run_states, units);
            }
            TreeItem::Group(key, members) => {
                let mut inner = Vec::new();
                for (member_index, member) in members.iter().enumerate() {
                    let (member_prefix, member_next) =
                        branch(&next, member_index + 1 == members.len());
                    inner.push(agent_unit(member, member_prefix));
                    walk_tree(&member.children, &member_next, run_states, &mut inner);
                }
                let mut usage = UsageTotals::default();
                let mut agents = 0;
                for row in inner.iter().flat_map(|unit| &unit.rows) {
                    if let RowKind::Agent(node) = &row.kind {
                        usage.add_fold(&node.own_usage);
                        agents += 1;
                    }
                }
                let (label, status) = match key {
                    GroupKey::Run { run_id, spec_id } => {
                        let run6: String = run_id.chars().take(6).collect();
                        let status = run_states.get(run_id).map_or_else(
                            || derived_run_status(&members),
                            |state| run_state_status(state),
                        );
                        (format!("factory {spec_id} {run6}"), status)
                    }
                    GroupKey::Deleted => ("deleted agents".to_string(), "deleted"),
                };
                let mut rows = vec![TreeRow {
                    kind: RowKind::Group(GroupRow {
                        label,
                        status: status.to_string(),
                        usage,
                        agents,
                        folded: false,
                    }),
                    prefix,
                }];
                rows.extend(inner.into_iter().flat_map(|unit| unit.rows));
                units.push(RowUnit {
                    rows,
                    usage,
                    agents,
                });
            }
        }
    }
}

/// A polled factory run state in the status-icon vocabulary.
fn run_state_status(state: &str) -> &str {
    match state {
        "stopping" => "running",
        "failed" => "error",
        "stopped" => "cancelled",
        other => other,
    }
}

/// A run missing from the polled factory graph: running while any agent
/// runs, errored when any errored, else done.
fn derived_run_status(members: &[&ContextNode]) -> &'static str {
    let any = |statuses: &[&str]| {
        members
            .iter()
            .any(|member| statuses.contains(&member.status.as_str()))
    };
    if any(&["running", "active"]) {
        "running"
    } else if any(&["error"]) {
        "error"
    } else {
        "done"
    }
}

/// The status icon and its color; statuses outside the TS vocabulary
/// render like `queued` (the TS switch is type-exhaustive and cannot
/// produce one).
fn status_icon(status: &str) -> (&'static str, ThemeColor) {
    match status {
        "active" => ("\u{25cf}", ThemeColor::Accent),
        "running" => ("\u{25c6}", ThemeColor::Accent),
        "done" => ("\u{2713}", ThemeColor::Success),
        "error" | "cancelled" => ("\u{2717}", ThemeColor::Error),
        _ => ("\u{25c7}", ThemeColor::Dim),
    }
}

/// Plain-space padding to a visible width.
fn pad_end(text: &str, width: usize) -> String {
    let used = str_width(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(used)))
}

fn pad_start(text: &str, width: usize) -> String {
    let used = str_width(text);
    format!("{}{text}", " ".repeat(width.saturating_sub(used)))
}

/// `truncateToWidth(text, max_width, "...")` for plain text: a clipped
/// ellipsis when the width cannot hold it, else a prefix that fits
/// `max_width - 3`.
pub(super) fn truncate_plain(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if str_width(text) <= max_width {
        return text.to_string();
    }
    let ellipsis = "...";
    if str_width(ellipsis) >= max_width {
        let mut out = String::new();
        for c in ellipsis.chars() {
            if str_width(&out) + char_width(c) > max_width {
                break;
            }
            out.push(c);
        }
        return out;
    }
    let mut out = String::new();
    for c in text.chars() {
        if str_width(&out) + char_width(c) + str_width(ellipsis) > max_width {
            break;
        }
        out.push(c);
    }
    format!("{out}{ellipsis}")
}

/// The context column for one row.
fn context_column(usage: Option<&ContextUsageSnapshot>, with_bar: bool) -> Vec<ClientSpan> {
    let Some(usage) = usage else {
        return vec![dim("-")];
    };
    let (Some(tokens), Some(percent)) = (usage.tokens, usage.percent) else {
        return vec![dim("unknown after compaction")];
    };
    let percent = percent.round();
    let detail = format!(
        "{}/{}",
        crate::chrome::format_token_count(tokens),
        crate::chrome::format_token_count(usage.context_window)
    );
    let text = vec![raw_span(format!("{percent}% ")), dim(format!("({detail})"))];
    if !with_bar {
        return text;
    }
    let filled = ((percent / 100.0) * CONTEXT_BAR_WIDTH as f64)
        .round()
        .clamp(0.0, CONTEXT_BAR_WIDTH as f64) as usize;
    let bar_color = if percent >= 80.0 {
        ThemeColor::Warning
    } else {
        ThemeColor::Accent
    };
    let mut row = vec![
        ClientSpan::colored("\u{2593}".repeat(filled), bar_color),
        dim("\u{2591}".repeat(CONTEXT_BAR_WIDTH - filled)),
        raw_span(" "),
    ];
    row.extend(text);
    row
}

fn count_nodes(node: &ContextNode) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}

fn sum_own_usage(node: &ContextNode, total: &mut UsageTotals) {
    total.input += node.own_usage.input;
    total.output += node.own_usage.output;
    total.cache_read += node.own_usage.cache_read;
    total.cache_write += node.own_usage.cache_write;
    total.cost_total += node.own_usage.cost_total;
    for child in &node.children {
        sum_own_usage(child, total);
    }
}

/// The whole tree's own usage summed per model (the `/context` Cost
/// section's breakdown), so a mid-conversation model switch shows each
/// model's share. A deleted row captured before deletes recorded a split
/// folds into the unknown-model bucket (empty provider and id), so the
/// lines still add up.
fn sum_own_usage_by_model(node: &ContextNode, total: &mut Vec<ModelUsage>) {
    let unsplit_deleted =
        (node.deleted && node.own_usage_by_model.is_empty()).then(|| ModelUsage {
            provider: String::new(),
            id: String::new(),
            totals: node.own_usage,
        });
    for bucket in node.own_usage_by_model.iter().chain(&unsplit_deleted) {
        if let Some(existing) = total
            .iter_mut()
            .find(|existing| existing.provider == bucket.provider && existing.id == bucket.id)
        {
            existing.totals.add_fold(&bucket.totals);
        } else {
            total.push(bucket.clone());
        }
    }
    for child in &node.children {
        sum_own_usage_by_model(child, total);
    }
}

/// The tree's per-model buckets when they account for every billed row.
/// `None` when a billed live row carries no per-model fold (a foreign
/// file): a partial breakdown would not add up.
fn tree_own_usage_by_model(root: &ContextNode) -> Option<Vec<ModelUsage>> {
    fn billed(node: &ContextNode) -> bool {
        node.own_usage.spent_tokens() > 0 || node.own_usage.cost_total > 0.0
    }
    fn covers(node: &ContextNode) -> bool {
        (!billed(node) || node.deleted || !node.own_usage_by_model.is_empty())
            && node.children.iter().all(covers)
    }
    if !covers(root) {
        return None;
    }
    let mut total = Vec::new();
    sum_own_usage_by_model(root, &mut total);
    Some(total)
}

/// The collapsed view's summary row (a deliberate TS delta): the hidden
/// agents folded into one label and their spend, so the visible rows plus
/// the summary still add up to the grand totals.
struct HiddenAgents {
    label: String,
    tokens: String,
    cost: String,
}

/// Which agent rows [`context_tree_rows`] renders — this port's collapse
/// knob, a deliberate TS delta (TS renders every row): a fleet session's
/// tree outgrows the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextTreeScope {
    /// The default: a tree over the row budget renders its highest-usage
    /// rows, a summary row for the rest, and the expand hint; a tree
    /// within the budget renders every row, exactly the TS shape.
    Collapsed,
    /// `/context all`: every row of every tree, whatever its size.
    EveryAgent,
}

/// The `/context` rows (TS `formatContextTree`): the agent tree with own
/// token/cost columns and per-agent context utilization, then the grand
/// totals. `width` is the TS render width: `clamp(columns - 2, 60, 120)`.
/// Children sharing a factory run render under one run row (its state from
/// `factory_runs` when the poll has it), and one parent's deleted agents
/// under one `deleted agents` row; group rows sum their agents and never
/// count toward the grand totals.
pub fn context_tree_rows(
    tree: &Value,
    width: usize,
    scope: ContextTreeScope,
    factory_runs: &[crate::factory_view::FactoryRunSnapshot],
) -> Vec<ClientLine> {
    let root = parse_context_node(tree);
    let run_states: HashMap<&str, &str> = factory_runs
        .iter()
        .filter_map(|run| Some((run.run_id.as_str(), run.state.as_deref()?)))
        .collect();
    let mut units = flatten_tree(&root, &run_states);

    // The collapse: a tree over the row budget keeps its highest-usage
    // units (spend decides which agents matter; a group ranks by its sum)
    // and folds the rest into the summary row. A group whose rows do not
    // fit keeps its group row alone. Ties keep tree order (stable sort).
    let mut summary: Option<HiddenAgents> = None;
    let row_count: usize = units.iter().map(|unit| unit.rows.len()).sum();
    // Over the budget something always folds or hides: the hint follows.
    let collapsed = scope == ContextTreeScope::Collapsed && row_count > CONTEXT_ROW_BUDGET;
    let rows: Vec<TreeRow<'_>> = if collapsed {
        units.sort_by(|left, right| {
            right
                .usage
                .spent_tokens()
                .cmp(&left.usage.spent_tokens())
                .then_with(|| right.usage.cost_total.total_cmp(&left.usage.cost_total))
        });
        let mut shown = Vec::new();
        let mut hidden_count = 0;
        let mut hidden_total = UsageTotals::default();
        for mut unit in units {
            let free_rows = CONTEXT_ROW_BUDGET - shown.len();
            if unit.rows.len() <= free_rows {
                shown.extend(unit.rows);
            } else if free_rows > 0 && unit.rows.len() > 1 {
                unit.rows.truncate(1);
                if let RowKind::Group(group) = &mut unit.rows[0].kind {
                    group.folded = true;
                }
                shown.extend(unit.rows);
            } else {
                hidden_count += unit.agents;
                hidden_total.add_fold(&unit.usage);
            }
        }
        if hidden_count > 0 {
            let noun = if hidden_count == 1 { "agent" } else { "agents" };
            summary = Some(HiddenAgents {
                label: format!("{hidden_count} more {noun}"),
                tokens: crate::chrome::format_token_count(hidden_total.spent_tokens()),
                cost: format_cost(hidden_total.cost_total),
            });
        }
        shown
    } else {
        units.into_iter().flat_map(|unit| unit.rows).collect()
    };

    let token_cells: Vec<String> = rows
        .iter()
        .map(|row| crate::chrome::format_token_count(row.usage().spent_tokens()))
        .collect();
    let cost_cells: Vec<String> = rows
        .iter()
        .map(|row| format_cost(row.usage().cost_total))
        .collect();
    let token_width = token_cells
        .iter()
        .map(String::len)
        .chain(["tokens".len()])
        .chain(summary.iter().map(|hidden| hidden.tokens.len()))
        .max()
        .unwrap_or_default();
    let cost_width = cost_cells
        .iter()
        .map(String::len)
        .chain(["cost".len()])
        .chain(summary.iter().map(|hidden| hidden.cost.len()))
        .max()
        .unwrap_or_default();
    // The per-row model column — a deliberate TS delta (TS shows only the
    // root's `Model:` line): the model decides the cost, so every agent row
    // carries its bare model id ("-" without one); the column appears only
    // when at least one node has a model.
    let model_cells: Vec<String> = rows
        .iter()
        .map(
            |row| match row.node().and_then(|node| node.model.as_ref()) {
                Some((_, id)) => id.rsplit('/').next().unwrap_or(id).to_string(),
                None => "-".to_string(),
            },
        )
        .collect();
    let show_models = rows
        .iter()
        .any(|row| row.node().is_some_and(|node| node.model.is_some()));
    let model_width = if show_models {
        model_cells
            .iter()
            .map(|cell| str_width(cell))
            .chain(["model".len()])
            .max()
            .unwrap_or_default()
    } else {
        0
    };
    let max_label = rows
        .iter()
        .map(|row| row.prefix.chars().count() + 2 + str_width(&row.label()))
        .chain(summary.iter().map(|hidden| 2 + str_width(&hidden.label)))
        .max()
        .unwrap_or_default();
    let label_width = MIN_LABEL_WIDTH.max(
        max_label.min(
            width
                .saturating_sub(token_width)
                .saturating_sub(cost_width)
                .saturating_sub(model_width + if show_models { 2 } else { 0 })
                .saturating_sub(28),
        ),
    );

    let mut lines: Vec<ClientLine> = vec![vec![raw_span("Context")], vec![]];
    if let Some((provider, model)) = &root.model {
        lines.push(vec![
            dim("Model:"),
            raw_span(format!(" {provider}/{model}")),
        ]);
        lines.push(vec![]);
    }
    let mut header = format!("  {}", pad_end("agent", label_width));
    if show_models {
        let _ = write!(header, "  {}", pad_end("model", model_width));
    }
    let _ = write!(
        header,
        "  {}  {}  context",
        pad_start("tokens", token_width),
        pad_start("cost", cost_width)
    );
    lines.push(vec![dim(header)]);
    for (index, row) in rows.iter().enumerate() {
        let label_space = label_width
            .saturating_sub(row.prefix.chars().count())
            .saturating_sub(2)
            .max(1);
        let label = truncate_plain(&row.label(), label_space);
        let (icon, icon_color) = status_icon(row.status());
        // TS padEndAnsi/padStartAnsi pad with plain spaces OUTSIDE the
        // color codes, so the padding renders with the default foreground.
        let mut spans = vec![
            dim(row.prefix.clone()),
            ClientSpan::colored(icon, icon_color),
            raw_span(format!(" {label}")),
        ];
        let label_used: usize = spans.iter().map(|span| str_width(&span.text)).sum();
        spans.push(raw_span(format!(
            "{}  ",
            " ".repeat((label_width + 2).saturating_sub(label_used))
        )));
        if show_models {
            spans.push(dim(pad_end(&model_cells[index], model_width)));
            spans.push(raw_span("  "));
        }
        spans.push(raw_span(pad_start(&token_cells[index], token_width)));
        spans.push(raw_span("  "));
        spans.push(raw_span(
            " ".repeat(cost_width.saturating_sub(str_width(&cost_cells[index]))),
        ));
        spans.push(dim(&cost_cells[index]));
        spans.push(raw_span("  "));
        spans.extend(context_column(
            row.node().and_then(|node| node.context_usage.as_ref()),
            row.node().is_some_and(|node| node.id == "root"),
        ));
        lines.push(spans);
    }

    if let Some(hidden) = &summary {
        // The summary row.
        let label_space = label_width.saturating_sub(2).max(1);
        let label = truncate_plain(&hidden.label, label_space);
        let mut spans = vec![dim("..."), dim(format!(" {label}"))];
        let label_used: usize = spans.iter().map(|span| str_width(&span.text)).sum();
        spans.push(raw_span(format!(
            "{}  ",
            " ".repeat((label_width + 2).saturating_sub(label_used))
        )));
        if show_models {
            spans.push(dim(pad_end("-", model_width)));
            spans.push(raw_span("  "));
        }
        spans.push(dim(pad_start(&hidden.tokens, token_width)));
        spans.push(raw_span("  "));
        spans.push(raw_span(
            " ".repeat(cost_width.saturating_sub(str_width(&hidden.cost))),
        ));
        spans.push(dim(&hidden.cost));
        spans.push(raw_span("  "));
        spans.push(dim("-"));
        lines.push(spans);
    }
    if collapsed {
        lines.push(vec![dim("Use /context all to show every agent.")]);
    }

    let mut totals = UsageTotals::default();
    sum_own_usage(&root, &mut totals);
    let agent_count = count_nodes(&root);
    let mut total_line = vec![
        dim("Total:"),
        raw_span(format!(
            " {} tokens ",
            crate::chrome::format_token_count(totals.spent_tokens())
        )),
        dim("\u{b7}"),
        raw_span(format!(" {}", format_cost(totals.cost_total))),
    ];
    if agent_count > 1 {
        total_line.push(dim(format!(" across {agent_count} agents")));
    }
    lines.push(vec![]);
    lines.push(total_line);

    lines.push(vec![]);
    lines.push(vec![raw_span("Tokens")]);
    for (label, value) in [("Input:", totals.input), ("Output:", totals.output)] {
        lines.push(vec![dim(label), raw_span(format!(" {}", grouped(value)))]);
    }
    if totals.cache_read > 0 {
        lines.push(vec![
            dim("Cache Read:"),
            raw_span(format!(" {}", grouped(totals.cache_read))),
        ]);
    }
    if totals.cache_write > 0 {
        lines.push(vec![
            dim("Cache Write:"),
            raw_span(format!(" {}", grouped(totals.cache_write))),
        ]);
    }
    lines.push(vec![
        dim("Total:"),
        raw_span(format!(" {}", grouped(totals.spent_tokens()))),
    ]);

    if totals.cost_total > 0.0 {
        lines.push(vec![]);
        lines.push(vec![raw_span("Cost")]);
        lines.push(vec![
            dim("Total:"),
            raw_span(format!(" ${}", js_to_fixed(totals.cost_total, 4))),
        ]);
        // The per-model breakdown (the model mix decides the cost): the whole
        // tree's buckets, most expensive model first (the unknown-model bucket of
        // unsplit deleted spend sorts the same way). Rendered only when there is
        // more than one line — a single-model tree already names its model.
        let by_model = tree_own_usage_by_model(&root);
        if let Some(mut by_model) = by_model.filter(|by_model| by_model.len() > 1) {
            by_model.sort_by(|a, b| {
                b.totals
                    .cost_total
                    .total_cmp(&a.totals.cost_total)
                    .then_with(|| a.provider.cmp(&b.provider))
                    .then_with(|| a.id.cmp(&b.id))
            });
            for bucket in &by_model {
                let label = if bucket.provider.is_empty() {
                    "unknown model (deleted agents)".to_string()
                } else {
                    format!("{}/{}", bucket.provider, bucket.id)
                };
                lines.push(vec![
                    dim(format!("{label}:")),
                    raw_span(format!(" ${}", js_to_fixed(bucket.totals.cost_total, 4))),
                ]);
            }
        }
    }

    if let Some(root_context) = &root.context_usage {
        lines.push(vec![]);
        lines.push(vec![raw_span("Context")]);
        match (root_context.tokens, root_context.percent) {
            (Some(tokens), Some(percent)) => lines.push(vec![
                dim("Current:"),
                raw_span(format!(
                    " {} / {} ({}%)",
                    grouped(tokens),
                    grouped(root_context.context_window),
                    js_tenth(percent)
                )),
            ]),
            _ => lines.push(vec![dim("Current:"), raw_span(" unknown after compaction")]),
        }
    }

    lines
}
