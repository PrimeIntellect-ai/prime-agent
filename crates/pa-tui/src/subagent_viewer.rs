//! The agents-view-esque subagent viewer behind the panel's Subagents
//! group: the session's descendant tree at every depth (the same recursive
//! scope as the dock's subagent counts, the PR #2597 data), one row per
//! subagent with the agents view's per-session cells — name, status, age,
//! cost, tokens — and a detail sheet for the selected row (the #2526
//! column set). Pure functions over the supervisor's `roster_subscribe`
//! wire form; the panel owns keys, selection, and the frame, this module
//! owns the tree.
//!
//! TS reference (`git show org/main:packages/coding-agent/...`):
//! - `modes/agents-view/agents-view-state.ts` `buildAgentsViewRows` +
//!   `AgentsViewRow` — the nested-row shape (parent linkage, depth,
//!   section) and `compareAgentsViewRows` — the sibling order;
//! - `computeRecursiveRollups` (+#2526) — cost and input/output tokens
//!   roll up over the descendant tree, the same scope for both;
//! - `modes/agents-view/agents-view-mode.ts` `formatSessionDuration` ->
//!   `formatAgentsViewRelativeTime` — the age cell (live rows age from
//!   `created`, the rest from `modified`);
//! - #2526 `formatActivityCell` — the status label · recap activity
//!   cell (the Rust roster has no `progressNote` yet, so the recap is
//!   the whole note);
//! - `modes/interactive/agent-activity.ts` `formatTokenCount` — compact
//!   token counts (via the shared `chrome::format_token_count` port).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::agents_view_forest::{session_status_label, session_title};
use crate::agents_view_state::{relative_age, section_rank, timestamp_ms, Section};
use crate::subagents::{
    descendant_entries, entry_status, summary_identity_keys, summary_parent_keys, SessionIdentity,
};
use pa_types::daemon::agent_roster::AgentRosterStatus;

/// One subagent's own usage snapshot (TS `SessionUsageSummary`: the roster
/// summary's `usage` block; `inputTokens` already folds the cache
/// reads/writes, so the viewer's input/output pair is the whole token
/// story the roster publishes).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct SubagentUsage {
    input_tokens: u64,
    output_tokens: u64,
    cost: f64,
}

impl SubagentUsage {
    fn add(self, other: SubagentUsage) -> SubagentUsage {
        SubagentUsage {
            input_tokens: self.input_tokens.saturating_add(other.input_tokens),
            output_tokens: self.output_tokens.saturating_add(other.output_tokens),
            cost: self.cost + other.cost,
        }
    }

    fn has_tokens(self) -> bool {
        self.input_tokens > 0 || self.output_tokens > 0
    }
}

/// One nested subagent row for the panel's Subagents group: the tree
/// position plus the agents view's per-session cells.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentViewerRow {
    /// The stable panel selection id: the summary's active-session id,
    /// else the session id, else the roster agent id.
    pub id: String,
    /// Nesting depth under the session: direct children render
    /// unindented, grandchildren one level in (TS `row.depth`).
    pub depth: usize,
    /// TS `getAgentsViewSessionTitle`: session name, first message,
    /// cwd basename, then ids.
    pub label: String,
    /// `running` | `idle` | `inactive` (the roster classification).
    pub status: &'static str,
    /// Elapsed time, TS `formatSessionDuration`.
    pub age: String,
    /// Own cost plus every descendant's (the #2526 rollup scope),
    /// rendered like the agents view's Cost column: `$X.XX`.
    pub cost: String,
    /// The detail sheet's labeled lines (the #2526 column set for the
    /// fields the Rust roster publishes).
    pub detail: Vec<(&'static str, String)>,
}

fn get_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn section_of(status: AgentRosterStatus) -> Section {
    match status {
        AgentRosterStatus::Running => Section::Running,
        AgentRosterStatus::Idle => Section::Idle,
        AgentRosterStatus::Inactive => Section::Inactive,
    }
}

fn status_word(section: Section) -> &'static str {
    match section {
        Section::Running => "running",
        Section::Idle => "idle",
        Section::Inactive => "inactive",
    }
}

/// The age cell (TS `formatSessionDuration`): live rows age from
/// `created` (falling back to `modified`), rows without a live worker
/// from `modified` (falling back to `created`).
fn age_of(summary: &Value, now: u64) -> String {
    let from = if get_str(summary, "activeSessionId").is_some() {
        get_str(summary, "created").or_else(|| get_str(summary, "modified"))
    } else {
        get_str(summary, "modified").or_else(|| get_str(summary, "created"))
    };
    relative_age(from, now)
}

/// The model cell (TS `formatSessionModel`): the bare model name plus
/// the thinking level. The roster wire carries `{provider, modelId}`;
/// the agents view's normalized form `{provider, id}` reads the same.
fn model_label(summary: &Value) -> String {
    let id = get_str(summary, "model").or_else(|| {
        let model = summary.get("model").unwrap_or(&Value::Null);
        get_str(model, "modelId").or_else(|| get_str(model, "id"))
    });
    let Some(id) = id else {
        return String::new();
    };
    let bare = id.rsplit('/').next().unwrap_or(id);
    match get_str(summary, "thinkingLevel") {
        Some(level) if level != "off" => format!("{bare}:{level}"),
        _ => bare.to_string(),
    }
}

/// The activity cell (TS #2526 `formatActivityCell`): the status label,
/// then the recap (the Rust roster has no `progressNote`, so the recap
/// is the whole note).
fn activity_of(summary: &Value) -> String {
    let status = session_status_label(summary);
    let recap = get_str(summary, "summary").unwrap_or_default();
    if status.is_empty() {
        return recap.to_string();
    }
    if recap.is_empty() {
        return status;
    }
    format!("{status} \u{00b7} {recap}")
}

fn summary_usage(summary: &Value) -> SubagentUsage {
    let usage = summary.get("usage").unwrap_or(&Value::Null);
    let count = |field: &str| usage.get(field).and_then(Value::as_u64).unwrap_or_default();
    SubagentUsage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cost: usage
            .get("cost")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
    }
}

/// One tree node's parsed roster data; owned strings only — the roster
/// slice borrows from the host's feeds and the viewer hands back owned
/// rows.
struct Node {
    id: String,
    section: Section,
    title: String,
    own_usage: SubagentUsage,
    recursive_usage: SubagentUsage,
    /// Live running descendants at any depth (TS
    /// `runningSubagentCount`).
    running_descendants: usize,
    last_activity_ms: i64,
    created_ms: i64,
    message_count: u64,
    age: String,
    last_activity: String,
    activity: String,
    /// `""` when the summary carries no model.
    model: String,
    /// `""` when the summary carries no cwd.
    cwd: String,
    parent: Option<usize>,
    children: Vec<usize>,
    depth: usize,
}

fn node(entry: &Value, now: u64) -> Node {
    let summary = entry.get("summary").unwrap_or(&Value::Null);
    Node {
        id: get_str(summary, "activeSessionId")
            .or_else(|| get_str(summary, "sessionId"))
            .or_else(|| get_str(entry, "agentId"))
            .unwrap_or_default()
            .to_string(),
        section: section_of(entry_status(entry)),
        title: session_title(summary),
        own_usage: summary_usage(summary),
        recursive_usage: SubagentUsage::default(),
        running_descendants: 0,
        last_activity_ms: timestamp_ms(get_str(summary, "lastActivityAt")),
        created_ms: timestamp_ms(get_str(summary, "created")),
        message_count: summary
            .get("messageCount")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        age: age_of(summary, now),
        last_activity: relative_age(get_str(summary, "lastActivityAt"), now),
        activity: activity_of(summary),
        model: model_label(summary),
        cwd: get_str(summary, "cwd").unwrap_or_default().to_string(),
        parent: None,
        children: Vec::new(),
        depth: 0,
    }
}

/// The sibling order (TS `compareAgentsViewRows` over the Rust port's
/// fields): running before idle before inactive; message-less rows sink;
/// in the non-running sections a row with live work in its tree reads
/// first; then the most recent activity, the newest creation, the title.
fn compare_nodes(a: &Node, b: &Node) -> Ordering {
    let section = section_rank(a.section).cmp(&section_rank(b.section));
    if section != Ordering::Equal {
        return section;
    }
    let empty_rank = (a.message_count == 0).cmp(&(b.message_count == 0));
    if empty_rank != Ordering::Equal {
        return empty_rank;
    }
    if a.section != Section::Running {
        let busy = (b.running_descendants > 0) as u8;
        let busy_a = (a.running_descendants > 0) as u8;
        let busy_diff = busy.cmp(&busy_a);
        if busy_diff != Ordering::Equal {
            return busy_diff;
        }
        let activity = b.last_activity_ms.cmp(&a.last_activity_ms);
        if activity != Ordering::Equal {
            return activity;
        }
    }
    let created = b.created_ms.cmp(&a.created_ms);
    if created != Ordering::Equal {
        return created;
    }
    let title = a.title.cmp(&b.title);
    if title != Ordering::Equal {
        return title;
    }
    a.id.cmp(&b.id)
}

fn viewer_row(node: &Node, depth: usize) -> SubagentViewerRow {
    let status = status_word(node.section);
    let cost = format!("${:.2}", node.recursive_usage.cost);
    let mut detail = vec![("status", status.to_string())];
    if !node.age.is_empty() {
        detail.push(("age", node.age.clone()));
    }
    if !node.last_activity.is_empty() {
        detail.push(("last activity", node.last_activity.clone()));
    }
    detail.push(("cost", cost.clone()));
    if node.recursive_usage.has_tokens() {
        detail.push((
            "tokens",
            format!(
                "{} in / {} out",
                crate::chrome::format_token_count(node.recursive_usage.input_tokens),
                crate::chrome::format_token_count(node.recursive_usage.output_tokens)
            ),
        ));
    }
    if !node.model.is_empty() {
        detail.push(("model", node.model.clone()));
    }
    if !node.activity.is_empty() {
        detail.push(("activity", node.activity.clone()));
    }
    if !node.cwd.is_empty() {
        detail.push(("cwd", node.cwd.clone()));
    }
    SubagentViewerRow {
        id: node.id.clone(),
        depth,
        label: node.title.clone(),
        status,
        age: node.age.clone(),
        cost,
        detail,
    }
}

/// The session's subagent tree rows, depth-first: every descendant at
/// every depth (`descendant_entries` — the dock's recursive count walks
/// the same rows), nested children under their parents, siblings in the
/// agents view order. Direct children of the session render unindented;
/// each further level indents one step.
pub fn tree_rows(roster: &[Value], identity: &SessionIdentity, now: u64) -> Vec<SubagentViewerRow> {
    let descendants = descendant_entries(roster, identity);
    let mut nodes: Vec<Node> = descendants.iter().map(|entry| node(entry, now)).collect();

    // Identity maps: every descendant's parent-reference keys
    // (`active:`/`session:`/`file:`, TS `parentIdentityKeys` order).
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (index, entry) in descendants.iter().enumerate() {
        let summary = entry.get("summary").unwrap_or(&Value::Null);
        for key in summary_identity_keys(summary) {
            by_key.entry(key).or_insert(index);
        }
    }
    let root_keys: HashSet<String> = [
        identity
            .active_session_id
            .as_deref()
            .map(|id| format!("active:{id}")),
        identity
            .session_id
            .as_deref()
            .map(|id| format!("session:{id}")),
        identity
            .session_file
            .as_deref()
            .map(|path| format!("file:{path}")),
    ]
    .into_iter()
    .flatten()
    .collect();

    // Parent linkage (TS `isDirectScopeChild` first): a parent key that
    // names the root makes the row a direct child no matter which key
    // matched — a stale id in an earlier parent key must not redirect
    // the row to another descendant. Only a row with no root key nests
    // under the first descendant its keys name (TS `findParentRow`'s
    // first-match). The `descendant_entries` walk guarantees every row
    // links on the path from the root, so no parent stays unresolved in
    // well-formed data; an unmatched row renders as a direct child.
    for index in 0..nodes.len() {
        let summary = descendants[index].get("summary").unwrap_or(&Value::Null);
        let keys = summary_parent_keys(summary);
        let parent = if keys.iter().any(|key| root_keys.contains(key)) {
            None
        } else {
            keys.iter().find_map(|key| {
                by_key
                    .get(key)
                    .filter(|&&candidate| candidate != index)
                    .copied()
            })
        };
        if let Some(parent) = parent {
            nodes[index].parent = Some(parent);
            nodes[parent].children.push(index);
        }
    }

    // Level order from the session's direct children: the walk doubles
    // as the depth assignment and, reversed, the post-order for the
    // rollups (a child always appears after its parent in level
    // order, so the reverse visits children first — deep chains stay
    // iterative like the #2597 tally).
    fn level_order(nodes: &mut [Node]) -> Vec<usize> {
        let mut queue: Vec<usize> = nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.parent.is_none())
            .map(|(index, _)| index)
            .collect();
        let mut visited = vec![false; nodes.len()];
        for &root in &queue {
            visited[root] = true;
        }
        let mut cursor = 0;
        while cursor < queue.len() {
            let index = queue[cursor];
            let child_depth = nodes[index].depth + 1;
            for &child in &nodes[index].children {
                if !visited[child] {
                    visited[child] = true;
                    nodes[child].depth = child_depth;
                    queue.push(child);
                }
            }
            cursor += 1;
        }
        queue
    }
    let mut queue = level_order(&mut nodes);
    // A stale-id linkage cycle leaves its rows unreachable from the
    // direct children (they would vanish from the viewer while the
    // dock still counts them). They reached the descendant walk, so
    // they render as direct children instead of disappearing.
    if queue.len() != nodes.len() {
        for index in 0..nodes.len() {
            if !queue.contains(&index) {
                if let Some(old_parent) = nodes[index].parent.take() {
                    nodes[old_parent].children.retain(|&child| child != index);
                }
            }
        }
        queue = level_order(&mut nodes);
    }

    // Recursive rollups (TS `computeRecursiveRollups`): own usage plus
    // every descendant's, and the live running descendant count.
    for &index in queue.iter().rev() {
        let own = nodes[index].own_usage;
        let mut usage = own;
        let mut running = 0usize;
        for &child in &nodes[index].children {
            usage = usage.add(nodes[child].recursive_usage);
            running += nodes[child].running_descendants
                + (nodes[child].section == Section::Running) as usize;
        }
        nodes[index].recursive_usage = usage;
        nodes[index].running_descendants = running;
    }

    // Sibling order (TS `compareAgentsViewRows`) once the rollups exist:
    // the non-running busy rule reads `running_descendants`.
    for index in 0..nodes.len() {
        let mut children = std::mem::take(&mut nodes[index].children);
        children.sort_by(|a, b| compare_nodes(&nodes[*a], &nodes[*b]));
        nodes[index].children = children;
    }
    let mut roots: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.parent.is_none())
        .map(|(index, _)| index)
        .collect();
    roots.sort_by(|a, b| compare_nodes(&nodes[*a], &nodes[*b]));

    // Depth-first emission: each parent immediately followed by its
    // nested children (TS `emit`), over an explicit stack.
    let mut rows: Vec<SubagentViewerRow> = Vec::with_capacity(nodes.len());
    let mut stack: Vec<(usize, usize)> = roots.into_iter().rev().map(|r| (r, 0)).collect();
    while let Some((index, depth)) = stack.pop() {
        rows.push(viewer_row(&nodes[index], depth));
        for &child in nodes[index].children.iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: u64 = 1_790_000_000_000;

    fn entry(agent_id: &str, status: &str, summary: Value) -> Value {
        json!({ "agentId": agent_id, "status": status, "summary": summary })
    }

    fn root_identity() -> SessionIdentity {
        SessionIdentity::new(
            Some("root".to_string()),
            Some("root-session".to_string()),
            Some("/sessions/root.jsonl".to_string()),
        )
    }

    fn child_summary(id: &str, parent_id: &str) -> Value {
        json!({
            "runtimeKind": "subagent",
            "sessionId": id,
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/sessions/{id}.jsonl"),
            "parentActiveSessionId": format!("{parent_id}-live"),
            "parentSessionId": parent_id,
            "parentSessionPath": format!("/sessions/{parent_id}.jsonl"),
        })
    }

    #[test]
    fn a_root_matching_parent_key_wins_over_a_stale_id() {
        // TS `isDirectScopeChild`: any parent key naming the scope root
        // lifts the row to a direct child — a stale first key that
        // happens to name another descendant must not nest the row.
        let roster = vec![
            entry("p", "running", {
                let mut summary = child_summary("p", "root-session");
                summary["sessionName"] = json!("p");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("stale", "idle", {
                let mut summary = child_summary("stale", "root-session");
                // The first parent key names p's live id; the second names
                // the root session — the root wins.
                summary["parentActiveSessionId"] = json!("p-live");
                summary["sessionName"] = json!("stale-id row");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "p");
        assert_eq!(
            rows[1].depth, 0,
            "the root-matching key lifts the row over the stale id: {:?}",
            rows[1]
        );
        assert_eq!(rows[1].label, "stale-id row");
    }

    #[test]
    fn a_stale_id_cycle_renders_as_direct_children_instead_of_vanishing() {
        // Two rows whose first parent keys name each other: the walk
        // reaches both through a shared legitimate parent, so the viewer
        // must never drop them (the dock still counts them).
        let roster = vec![
            entry("p", "running", {
                let mut summary = child_summary("p", "root-session");
                summary["sessionName"] = json!("p");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("a", "idle", {
                let mut summary = child_summary("a", "root-session");
                summary["parentActiveSessionId"] = json!("b-live");
                summary["parentSessionId"] = json!("p");
                summary["parentSessionPath"] = json!("/sessions/p.jsonl");
                summary["sessionName"] = json!("a");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("b", "idle", {
                let mut summary = child_summary("b", "root-session");
                summary["parentActiveSessionId"] = json!("a-live");
                summary["parentSessionId"] = json!("p");
                summary["parentSessionPath"] = json!("/sessions/p.jsonl");
                summary["sessionName"] = json!("b");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(
            rows.len(),
            3,
            "the cycled rows render instead of disappearing: {rows:?}"
        );
        assert!(
            rows.iter().all(|row| row.depth == 0),
            "the recovered rows list as direct children"
        );
        let labels: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        assert_eq!(labels, vec!["p", "a", "b"]);
    }

    #[test]
    fn children_of_children_nest_under_their_parents() {
        let roster = vec![
            entry("c1", "running", {
                let mut summary = child_summary("c1", "root-session");
                summary["sessionName"] = json!("first child");
                summary["messageCount"] = json!(2);
                summary
            }),
            entry("gc1", "idle", {
                let mut summary = child_summary("gc1", "c1");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("c2", "idle", {
                let mut summary = child_summary("c2", "root-session");
                summary["sessionName"] = json!("second child");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].label, "first child");
        assert_eq!(rows[0].depth, 0);
        assert_eq!(rows[1].label, "gc1");
        assert_eq!(
            rows[1].depth, 1,
            "a grandchild renders one level under its parent"
        );
        assert_eq!(rows[2].label, "second child");
        assert_eq!(rows[2].depth, 0);
    }

    #[test]
    fn grandchild_indents_and_the_recursive_rollup_sums_the_tree() {
        let roster = vec![
            entry("c1", "running", {
                let mut summary = child_summary("c1", "root-session");
                summary["sessionName"] = json!("parent");
                summary["messageCount"] = json!(2);
                summary["created"] = json!("2026-09-23T00:00:00Z");
                summary["usage"] =
                    json!({ "inputTokens": 1_500, "outputTokens": 500, "cost": 0.25 });
                summary
            }),
            entry("gc1", "idle", {
                let mut summary = child_summary("gc1", "c1");
                summary["sessionName"] = json!("grandchild");
                summary["messageCount"] = json!(1);
                summary["created"] = json!("2026-09-23T00:00:00Z");
                summary["usage"] = json!({ "inputTokens": 500, "outputTokens": 100, "cost": 0.10 });
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "parent");
        assert_eq!(rows[0].depth, 0);
        assert_eq!(rows[1].label, "grandchild");
        assert_eq!(rows[1].depth, 1);
        // The recursive rollup walks the tree (TS computeRecursiveRollups).
        assert_eq!(rows[0].cost, "$0.35");
        assert_eq!(rows[1].cost, "$0.10");
        let tokens = rows[0]
            .detail
            .iter()
            .find(|(label, _)| *label == "tokens")
            .expect("running rows carry token usage");
        assert_eq!(tokens.1, "2.0k in / 600 out");
        let grandchild_tokens = rows[1]
            .detail
            .iter()
            .find(|(label, _)| *label == "tokens")
            .expect("the grandchild carries its own usage");
        assert_eq!(grandchild_tokens.1, "500 in / 100 out");
    }

    #[test]
    fn running_siblings_list_first_and_messageless_rows_sink() {
        let roster = vec![
            entry("a-idle", "idle", {
                let mut summary = child_summary("a-idle", "root-session");
                summary["messageCount"] = json!(0);
                summary
            }),
            entry("z-idle", "idle", {
                let mut summary = child_summary("z-idle", "root-session");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("running", "running", {
                let mut summary = child_summary("running", "root-session");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(
            rows.iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["running", "z-idle", "a-idle"],
            "running reads first; a message-less row sinks below the title order"
        );
    }

    #[test]
    fn busy_trees_read_first_in_the_idle_section() {
        let roster = vec![
            entry("quiet", "idle", {
                let mut summary = child_summary("quiet", "root-session");
                summary["sessionName"] = json!("a-quiet");
                summary["messageCount"] = json!(1);
                summary["lastActivityAt"] = json!("2026-09-23T10:00:00Z");
                summary
            }),
            entry("busy-parent", "idle", {
                let mut summary = child_summary("busy-parent", "root-session");
                summary["sessionName"] = json!("z-busy");
                summary["messageCount"] = json!(1);
                summary["lastActivityAt"] = json!("2026-09-22T10:00:00Z");
                summary
            }),
            entry("busy-child", "running", {
                let mut summary = child_summary("busy-child", "busy-parent");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(
            rows.iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["z-busy", "busy-child", "a-quiet"],
            "an idle parent with live descendants reads before a more recent idle childless row"
        );
    }

    #[test]
    fn ages_read_the_session_duration_rule() {
        let roster = vec![entry("c1", "running", {
            let mut summary = child_summary("c1", "root-session");
            summary["sessionName"] = json!("worker");
            summary["messageCount"] = json!(1);
            summary["created"] = json!("2026-09-23T00:00:00Z");
            summary["modified"] = json!("2026-09-23T01:00:00Z");
            summary["lastActivityAt"] = json!("2026-09-23T02:00:00Z");
            summary["usage"] = json!({ "inputTokens": 10, "outputTokens": 5, "cost": 0.01 });
            summary
        })];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        let row = &rows[0];
        assert!(
            row.detail.iter().any(|(label, _)| *label == "age"),
            "a live row ages from its creation timestamp"
        );
        assert!(
            row.detail
                .iter()
                .any(|(label, _)| *label == "last activity"),
            "the sheet carries the last-activity time"
        );
        assert!(row.detail.contains(&("cost", "$0.01".to_string())));
    }

    #[test]
    fn title_falls_back_through_the_ts_candidate_chain() {
        let roster = vec![
            entry("named", "idle", {
                let mut summary = child_summary("named", "root-session");
                summary["sessionName"] = json!("  the   fixer ");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("from-message", "idle", {
                let mut summary = child_summary("from-message", "root-session");
                summary["firstMessage"] = json!(" fix   the bug ");
                summary["messageCount"] = json!(1);
                summary
            }),
            entry("from-cwd", "idle", {
                let mut summary = child_summary("from-cwd", "root-session");
                summary["cwd"] = json!("/home/ubuntu/lane-worktrees/fixer");
                summary["messageCount"] = json!(1);
                summary
            }),
        ];
        let rows = tree_rows(&roster, &root_identity(), NOW);
        assert_eq!(rows[0].label, "fix the bug");
        assert_eq!(rows[1].label, "fixer");
        assert_eq!(rows[2].label, "the fixer");
    }
}
