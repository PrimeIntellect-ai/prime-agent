//! The subagent-family data layer shared by the session view's summary box
//! and the agents view's scoped mode: which roster entries descend from a
//! session, and how their statuses classify. Pure functions over roster
//! entries (the supervisor's `roster_subscribe` wire form); the wire
//! classification vocabulary lives in pa-types.

use serde_json::Value;

use pa_types::daemon::agent_roster::{classify_summary_value, AgentRosterStatus};

/// One session's family-addressing identity (TS `AgentsViewScopeKey` plus
/// the file key): the keys its child rows reference it by.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionIdentity {
    pub active_session_id: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
}

impl SessionIdentity {
    #[must_use]
    pub fn new(
        active_session_id: Option<String>,
        session_id: Option<String>,
        session_file: Option<String>,
    ) -> Self {
        Self {
            active_session_id,
            session_id,
            session_file,
        }
    }

    /// The keys this session is referenced by as a parent, in the one
    /// format `summary_parent_keys`/`summary_identity_keys` build (the
    /// same `active:`/`session:`/`file:` vocabulary the roster rows and
    /// the agents-view records speak).
    pub(crate) fn keys(&self) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(id) = self.active_session_id.as_deref() {
            keys.push(format!("active:{id}"));
        }
        if let Some(id) = self.session_id.as_deref() {
            keys.push(format!("session:{id}"));
        }
        if let Some(path) = self.session_file.as_deref() {
            keys.push(format!("file:{path}"));
        }
        keys
    }
}

/// Live descendant counts of one session's subtree (TS
/// `SubagentSummaryCounts`), with the operator's 2026-09-25 running
/// split: `running_direct` counts the immediately-running children,
/// `running_nested` the further running descendants below them (their
/// sum is the recursive `running` total).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SubagentCounts {
    pub total: usize,
    pub running: usize,
    pub running_direct: usize,
    pub running_nested: usize,
    pub idle: usize,
    pub inactive: usize,
}

fn get_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The parent-reference keys of one summary (TS `getParentKeys`):
/// `active:<id>`, `session:<id>`, `file:<path>` over the parent fields.
pub(crate) fn summary_parent_keys(summary: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = get_str(summary, "parentActiveSessionId") {
        keys.push(format!("active:{id}"));
    }
    if let Some(id) = get_str(summary, "parentSessionId") {
        keys.push(format!("session:{id}"));
    }
    if let Some(path) = get_str(summary, "parentSessionPath") {
        keys.push(format!("file:{path}"));
    }
    keys
}

/// The keys a session is referenced by as a parent (TS `parentIdentityKeys`).
pub(crate) fn summary_identity_keys(summary: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = get_str(summary, "activeSessionId") {
        keys.push(format!("active:{id}"));
    }
    if let Some(id) = get_str(summary, "sessionId") {
        keys.push(format!("session:{id}"));
    }
    if let Some(path) = get_str(summary, "sessionFile") {
        keys.push(format!("file:{path}"));
    }
    keys
}

/// Every row whose summary descends from `parent`, breadth-first over the
/// parent linkage, with each row's depth below `parent` (TS
/// `collectSubagentDescendantSummaries`): child rows link through their
/// parent keys, and each linked row extends the walk with its own
/// identity keys so deeper descendants stay reachable. The depth pairs
/// the direct/nested running counts (depth 1 = a direct child).
#[must_use]
pub fn descendant_positions_with_depth(
    summaries: &[&Value],
    parent: &SessionIdentity,
) -> Vec<(usize, usize)> {
    let mut by_parent_key: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (position, summary) in summaries.iter().enumerate() {
        if get_str(summary, "runtimeKind") != Some("subagent") {
            continue;
        }
        for key in summary_parent_keys(summary) {
            by_parent_key.entry(key).or_default().push(position);
        }
    }
    let mut queue: Vec<(String, usize)> = parent.keys().into_iter().map(|key| (key, 0)).collect();
    let mut positions: Vec<(usize, usize)> = Vec::new();
    let mut linked: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut index = 0;
    while index < queue.len() {
        // The owned copy ends the slice borrow before the extend below
        // mutates the queue.
        let (key, owner_depth) = queue[index].clone();
        for position in by_parent_key.get(&key).into_iter().flatten() {
            if linked.insert(*position) {
                positions.push((*position, owner_depth + 1));
                queue.extend(
                    summary_identity_keys(summaries[*position])
                        .into_iter()
                        .zip(std::iter::repeat(owner_depth + 1)),
                );
            }
        }
        index += 1;
    }
    positions
}

/// The descendant positions of `parent`, depth-free (the flat consumers:
/// row and entry collection).
#[must_use]
pub fn descendant_positions(summaries: &[&Value], parent: &SessionIdentity) -> Vec<usize> {
    descendant_positions_with_depth(summaries, parent)
        .into_iter()
        .map(|(position, _)| position)
        .collect()
}

/// The summaries that descend from `parent`.
#[must_use]
pub fn descendant_rows<'a>(summaries: &[&'a Value], parent: &SessionIdentity) -> Vec<&'a Value> {
    descendant_positions(summaries, parent)
        .into_iter()
        .map(|position| summaries[position])
        .collect()
}

/// The roster entries that descend from `parent`, with each entry's
/// depth below it (1 = a direct child).
///
/// # Panics
///
/// Cannot panic: the `expect` re-reads the same `"summary"` key the
/// filter kept, so it always resolves on the collected entries.
#[must_use]
pub fn descendant_entries_with_depth<'a>(
    roster: &'a [Value],
    parent: &SessionIdentity,
) -> Vec<(&'a Value, usize)> {
    let with_summaries: Vec<&'a Value> = roster
        .iter()
        .filter(|entry| entry.get("summary").is_some())
        .collect();
    let summaries: Vec<&'a Value> = with_summaries
        .iter()
        .map(|entry| entry.get("summary").expect("filtered"))
        .collect();
    descendant_positions_with_depth(&summaries, parent)
        .into_iter()
        .map(|(position, depth)| (with_summaries[position], depth))
        .collect()
}

/// The roster entries that descend from `parent`.
#[must_use]
pub fn descendant_entries<'a>(roster: &'a [Value], parent: &SessionIdentity) -> Vec<&'a Value> {
    descendant_entries_with_depth(roster, parent)
        .into_iter()
        .map(|(entry, _)| entry)
        .collect()
}

/// The roster status of one entry (the supervisor's classification, with
/// the shared formula as the fallback: TS `rosterStatus ??
/// classifySessionRosterStatus`).
#[must_use]
pub fn entry_status(entry: &Value) -> AgentRosterStatus {
    match get_str(entry, "status") {
        Some("running") => AgentRosterStatus::Running,
        Some("idle") => AgentRosterStatus::Idle,
        Some("inactive") => AgentRosterStatus::Inactive,
        _ => entry
            .get("summary")
            .map_or(AgentRosterStatus::Idle, |summary| {
                classify_summary_value(
                    summary,
                    entry
                        .get("queuedChild")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
            }),
    }
}

/// Count the live subagent descendants of one session (TS
/// `countRosterSubagentStatuses`: rows of any lifecycle count on the live
/// roster; callers that mix saved catalog rows filter their input). The
/// running split rides the descendant depths: depth 1 counts direct,
/// deeper counts nested — the two addends the dock's single running
/// total sums (the operator's 2026-09-28 one-number readout).
#[must_use]
pub fn count_descendants(roster: &[Value], parent: &SessionIdentity) -> SubagentCounts {
    let mut counts = SubagentCounts::default();
    for (entry, depth) in descendant_entries_with_depth(roster, parent) {
        counts.total += 1;
        match entry_status(entry) {
            AgentRosterStatus::Running => {
                counts.running += 1;
                if depth == 1 {
                    counts.running_direct += 1;
                } else {
                    counts.running_nested += 1;
                }
            }
            AgentRosterStatus::Idle => counts.idle += 1,
            AgentRosterStatus::Inactive => counts.inactive += 1,
        }
    }
    counts
}

/// The session's whole-family spend: the `compute_rollups` total the
/// agents view bills the session's row. `None` when the roster holds no
/// record for the session.
pub(crate) fn family_cost(roster: &[Value], session: &SessionIdentity) -> Option<f64> {
    let records = crate::agents_view_state::reconcile_unified_sessions(roster, &[]);
    let rollups = crate::agents_view_forest::compute_rollups(&records);
    let keys = session.keys();
    records
        .iter()
        .find(|record| {
            summary_identity_keys(&crate::agents_view_state::summary_for_record(record))
                .iter()
                .any(|key| keys.contains(key))
        })
        .and_then(|record| rollups.get(&record.identity))
        .map(|rollup| rollup.cost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(agent_id: &str, summary: &Value, status: &str) -> Value {
        json!({ "agentId": agent_id, "summary": summary, "status": status })
    }

    fn parent_summary(id: &str) -> Value {
        json!({
            "sessionId": id,
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/sessions/{id}.jsonl"),
            "runtimeKind": "top-level",
        })
    }

    fn child_summary(id: &str, parent_id: &str, runtime_kind: &str) -> Value {
        json!({
            "sessionId": id,
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/sessions/{id}.jsonl"),
            "runtimeKind": runtime_kind,
            "parentActiveSessionId": format!("{parent_id}-live"),
            "parentSessionId": parent_id,
            "parentSessionPath": format!("/sessions/{parent_id}.jsonl"),
        })
    }

    #[test]
    fn direct_and_deep_descendants_count() {
        let mut gc1_summary = child_summary("gc1", "c1", "subagent");
        gc1_summary["parentActiveSessionId"] = json!("c1-live");
        gc1_summary["parentSessionId"] = json!("c1");
        gc1_summary["parentSessionPath"] = json!("/sessions/c1.jsonl");
        let roster = vec![
            entry("parent", &parent_summary("p1"), "idle"),
            entry("c1", &child_summary("c1", "p1", "subagent"), "running"),
            entry("c2", &child_summary("c2", "p1", "subagent"), "idle"),
            entry("gc1", &gc1_summary, "inactive"),
            entry("other", &parent_summary("p2"), "running"),
        ];
        let counts = count_descendants(
            &roster,
            &SessionIdentity::new(
                Some("p1-live".to_string()),
                Some("p1".to_string()),
                Some("/sessions/p1.jsonl".to_string()),
            ),
        );
        assert_eq!(counts.total, 3);
        assert_eq!(counts.running, 1);
        assert_eq!(counts.running_direct, 1);
        assert_eq!(counts.running_nested, 0);
        assert_eq!(counts.idle, 1);
        assert_eq!(counts.inactive, 1);
    }

    /// The operator's `direct, nested` running pair: the one directly
    /// running child counts direct, the two running grandchildren below
    /// it count nested, and their sum stays the recursive running total.
    #[test]
    fn running_split_counts_direct_and_nested() {
        let mut roster = vec![
            entry("parent", &parent_summary("p1"), "idle"),
            entry("c1", &child_summary("c1", "p1", "subagent"), "running"),
            entry("c2", &child_summary("c2", "p1", "subagent"), "idle"),
        ];
        for name in ["gc1", "gc2"] {
            let grandchild = child_summary(name, "c1", "subagent");
            roster.push(entry(name, &grandchild, "running"));
        }
        let counts = count_descendants(
            &roster,
            &SessionIdentity::new(
                Some("p1-live".to_string()),
                Some("p1".to_string()),
                Some("/sessions/p1.jsonl".to_string()),
            ),
        );
        assert_eq!(counts.total, 4);
        assert_eq!(counts.running, 3);
        assert_eq!(counts.running_direct, 1);
        assert_eq!(counts.running_nested, 2);
        // The pair never double counts: 1 direct + 2 nested = 3 running,
        // the recursive total.
        assert_eq!(
            counts.running,
            counts.running_direct + counts.running_nested
        );
    }

    /// The title bills the same family rollup as the agents-view row:
    /// the root's own spend plus every descendant's, recursively.
    #[test]
    fn family_cost_is_the_agents_view_row_rollup() {
        let summary = |id: &str, depth: u32, usage_cost: f64| {
            json!({
                "sessionId": id,
                "lifecycle": "live",
                "activeSessionId": format!("{id}-live"),
                "sessionFile": format!("/sessions/{id}.jsonl"),
                "runtimeKind": "top-level",
                "rlmDepth": depth,
                "usage": { "cost": usage_cost },
            })
        };
        let root = summary("root", 0, 1.75);
        let mut child = summary("child", 1, 0.30);
        child["runtimeKind"] = json!("subagent");
        child["rlmChildId"] = json!("child-a");
        child["parentActiveSessionId"] = json!("root-live");
        child["parentSessionId"] = json!("root");
        // The grandchild links by its durable session id alone (its
        // parent is no longer live), the shape a ledger-seeded row has.
        let mut grandchild = summary("grand", 2, 0.25);
        grandchild["runtimeKind"] = json!("subagent");
        grandchild["rlmChildId"] = json!("child-b");
        grandchild["parentSessionId"] = json!("child");
        grandchild["parentSessionPath"] = json!("/sessions/child.jsonl");
        let roster = vec![
            entry("root", &root, "idle"),
            entry("child", &child, "running"),
            entry("grand", &grandchild, "idle"),
        ];
        let identity = SessionIdentity::new(
            Some("root-live".to_string()),
            Some("root".to_string()),
            Some("/sessions/root.jsonl".to_string()),
        );
        assert_eq!(family_cost(&roster, &identity), Some(2.30));
        // The same number the agents view bills the root's row — pinned
        // against the row itself, not a second copy of the formula.
        let records = crate::agents_view_state::reconcile_unified_sessions(&roster, &[]);
        let rollups = crate::agents_view_forest::compute_rollups(&records);
        let rows = crate::agents_view_forest::build_rows(
            &records,
            None,
            &std::collections::HashSet::new(),
            &std::collections::HashSet::new(),
            &rollups,
            None,
        );
        let row = rows
            .iter()
            .find(|row| row.kind == crate::agents_view_forest::RowKind::Agent)
            .expect("the root's agent row");
        assert_eq!(
            family_cost(&roster, &identity),
            Some(row.cost),
            "the title and the agents-view row agree"
        );
        // An identity the roster holds no record for renders nothing.
        assert_eq!(
            family_cost(
                &roster,
                &SessionIdentity::new(None, Some("missing".to_string()), None)
            ),
            None
        );
    }

    #[test]
    fn non_subagent_rows_never_link() {
        let roster = vec![
            entry("p1", &parent_summary("p1"), "idle"),
            entry("fork", &child_summary("f1", "p1", "top-level"), "running"),
        ];
        let counts = count_descendants(
            &roster,
            &SessionIdentity::new(
                Some("p1-live".to_string()),
                Some("p1".to_string()),
                Some("/sessions/p1.jsonl".to_string()),
            ),
        );
        assert_eq!(counts.total, 0);
    }

    #[test]
    fn missing_status_falls_back_to_the_formula() {
        let roster = vec![json!({
            "agentId": "c1",
            "summary": {
                "sessionId": "c1",
                "activeSessionId": "c1-live",
                "runtimeKind": "subagent",
                "parentActiveSessionId": "p1-live",
                "activity": "working",
                "isSessionActive": true,
            }
        })];
        let counts = count_descendants(
            &roster,
            &SessionIdentity::new(Some("p1-live".to_string()), Some("p1".to_string()), None),
        );
        assert_eq!(counts.running, 1);
    }
}
