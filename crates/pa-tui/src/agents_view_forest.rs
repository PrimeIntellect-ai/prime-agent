//! The agents-view subagent forest: how unified records nest into the
//! session list's rows. One pass computes the record hierarchy (parent
//! linkage, rollups), then row building emits top-level agents with their
//! `N subagents` summary rows and, when a parent is expanded, its nested
//! children. Selection resolution and ancestry walks over that row tree
//! live here too. Pure functions on the wire forms (roster summaries and
//! saved-catalog rows); the view module owns input and painting.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::agents_view_state::{
    now_ms, relative_age, section_rank, summary_for_record, Section, UnifiedRecord,
};
use crate::subagents::{summary_identity_keys, summary_parent_keys};

/// A summary field's non-empty string value.
fn get_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The activity-side status label (TS `getSessionStatusLabel`, the fields
/// the Rust summaries carry).
pub(crate) fn session_status_label(summary: &Value) -> String {
    if let Some(label) = get_str(summary, "statusLabel") {
        return label.to_string();
    }
    if summary
        .get("lastHeardFromAt")
        .is_some_and(|value| !value.is_null())
    {
        return format!(
            "last heard {}",
            relative_age(get_str(summary, "lastHeardFromAt"), now_ms())
        );
    }
    // A non-ready worker cannot report fresh runtime flags; its state is the row's story.
    if let Some(state) = get_str(summary, "workerState") {
        if state != "ready" {
            return state.to_string();
        }
    }
    if summary.get("isCompacting") == Some(&Value::Bool(true)) {
        return "compacting".to_string();
    }
    if summary.get("isStreaming") == Some(&Value::Bool(true)) {
        let running_tools = summary.get("isRunningTools") == Some(&Value::Bool(true));
        return if running_tools {
            "running tools".to_string()
        } else {
            "thinking".to_string()
        };
    }
    if summary.get("isRunningTools") == Some(&Value::Bool(true)) {
        return "running tools".to_string();
    }
    if summary.get("isBashRunning") == Some(&Value::Bool(true)) {
        return "running bash".to_string();
    }
    if let Some(active) = summary
        .get("sessionActions")
        .and_then(|actions| actions.get("active"))
        .filter(|active| !active.is_null())
    {
        if let Some(label) = active.get("label").and_then(Value::as_str) {
            return label.to_string();
        }
        if let Some(kind) = active.get("kind").and_then(Value::as_str) {
            return kind.replace('_', " ");
        }
    }
    let queued = summary
        .get("sessionActions")
        .and_then(|actions| actions.get("queuedCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if queued > 0 {
        return format!("{queued} queued");
    }
    if get_str(summary, "lifecycle") == Some("archived") {
        return "archived".to_string();
    }
    if summary.get("hasActiveHeartbeat") == Some(&Value::Bool(true)) {
        return "heartbeat active".to_string();
    }
    if get_str(summary, "runtimeKind") == Some("subagent")
        && summary.get("repliedSinceTask") == Some(&Value::Bool(true))
    {
        return "replied".to_string();
    }
    String::new()
}

/// The model column text: the bare model id plus `:level` when a thinking
/// level is active ("off" reads as noise and stays bare).
pub(crate) fn session_model(summary: &Value) -> String {
    // Live workers publish the model object with `id` (the engine's
    // `model_metadata`); seeded roster rows and saved-session rows carry
    // `modelId` (the persisted selector). Both read as the full model id.
    let Some(id) = get_str(summary, "model").or_else(|| {
        summary
            .get("model")
            .and_then(|model| model.get("id").or_else(|| model.get("modelId")))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
    }) else {
        return "-".to_string();
    };
    let bare = id.rsplit('/').next().unwrap_or(id).to_string();
    match get_str(summary, "thinkingLevel") {
        Some(level) if level != "off" => format!("{bare}:{level}"),
        _ => bare,
    }
}

pub fn session_title(summary: &Value) -> String {
    let cwd_basename = get_str(summary, "cwd").map(|cwd| {
        std::path::Path::new(cwd)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    for candidate in [
        get_str(summary, "sessionName"),
        get_str(summary, "firstMessage"),
        cwd_basename.as_deref(),
        get_str(summary, "sessionId"),
        get_str(summary, "id"),
    ] {
        let normalized = candidate
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        if !normalized.is_empty() {
            return normalized;
        }
    }
    "Untitled agent".to_string()
}

/// The scope of a scoped agents view (TS `AgentsViewScopeKey` plus the
/// display name): the subtree root the view lists descendants of.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewScope {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
    pub session_name: Option<String>,
}

/// One rendered list row (TS `AgentsViewRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewRow {
    /// Which of the three row shapes this row renders as.
    pub kind: RowKind,
    pub section: Section,
    pub identity: String,
    /// The agent row this row is nested under (summary rows and nested
    /// children carry their parent's identity).
    pub parent_identity: Option<String>,
    /// The merged summary the open action acts on (summary rows reuse
    /// their parent's).
    pub summary: Value,
    pub title: String,
    pub status_label: String,
    pub model: String,
    /// The row's own activity text (the status label).
    pub activity: String,
    /// Own usage cost plus every descendant's (TS `recursiveCost`).
    pub cost: f64,
    pub age: String,
    /// Nesting depth: 0 for top-level agent rows.
    pub depth: usize,
    /// Every descendant session under this row (TS `descendantCount`).
    pub descendant_count: usize,
    /// Live running descendants (TS `runningSubagentCount`).
    pub running_subagent_count: usize,
    /// The summary row's list is expanded (TS `expanded`).
    pub expanded: bool,
}

/// The three list row shapes (TS `AgentsViewRowKind`; the read-only
/// spawn-code rows belong to the program surface, not this one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    /// A top-level agent row.
    Agent,
    /// The `N subagents` toggle row under an agent (TS `subagent-summary`).
    SubagentSummary,
    /// A nested child row inside an expanded list (TS `subagent`).
    Subagent,
}

impl AgentsViewRow {
    /// Rows the selection may land on (TS `selectable`: every row here).
    pub fn selectable(&self) -> bool {
        true
    }
}

/// Whether a summary is a spawned subagent (TS `isSubagentSummary`): the
/// runtime kind decides when present; summaries from daemons that predate
/// it still carry subagent linkage and never surface as top-level agents.
pub(crate) fn is_subagent_summary(summary: &Value) -> bool {
    match summary.get("runtimeKind").and_then(Value::as_str) {
        Some(kind) => kind == "subagent",
        None => [
            "rlmChildId",
            "rlmParentNodeId",
            "parentActiveSessionId",
            "parentSessionId",
            "parentSessionPath",
        ]
        .iter()
        .any(|field| {
            summary
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        }),
    }
}

/// The stable row identity of one summary (TS `getAgentsViewSummaryIdentity`):
/// the roster-qualified child id for subagents, else file, active, session.
pub fn summary_identity(summary: &Value) -> String {
    let get = |field: &str| {
        summary
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    if get("runtimeKind") == Some("subagent") && summary.get("rlmChildId").is_some() {
        return format!(
            "agent:{}",
            pa_types::daemon::agent_roster::roster_agent_id_for_summary(summary)
        );
    }
    if let Some(file) = get("sessionFile") {
        return format!("file:{file}");
    }
    if let Some(active) = get("activeSessionId") {
        return format!("active:{active}");
    }
    format!("session:{}", get("sessionId").unwrap_or_default())
}

/// One session's stable selection key (TS `AgentsViewSelectionKey`): a
/// row's identity flips when its session persists or re-attaches, so the
/// session ids re-find it across those transitions.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionKey {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
}

/// The selection key of one summary (TS `getAgentsViewSelectionKey`).
pub fn selection_key(summary: &Value) -> SelectionKey {
    let get = |field: &str| {
        summary
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    SelectionKey {
        session_id: get("sessionId"),
        active_session_id: get("activeSessionId"),
    }
}

/// One recursive rollup over the record hierarchy (TS
/// `AgentsViewRecursiveRollup`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rollup {
    pub cost: f64,
    pub descendant_count: usize,
}

/// The record hierarchy (TS `UnifiedSessionIndex`): every record by its
/// aliases, and each record's children by parent linkage.
struct RecordIndex {
    by_key: HashMap<String, usize>,
    children_by_parent: HashMap<usize, Vec<usize>>,
}

/// Build the record hierarchy (TS `buildUnifiedSessionIndex`).
fn build_record_index(records: &[UnifiedRecord]) -> RecordIndex {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        for alias in &record.aliases {
            by_key.insert(alias.clone(), index);
        }
    }
    let mut children_by_parent: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, _) in records.iter().enumerate() {
        let Some(parent) = find_parent_index(records, &by_key, index) else {
            continue;
        };
        if parent == index {
            continue;
        }
        children_by_parent.entry(parent).or_default().push(index);
    }
    RecordIndex {
        by_key,
        children_by_parent,
    }
}

/// The record one parent-reference key list resolves to (TS
/// `findParentRecord`: daemon summary keys first, then the saved catalog's
/// parent path).
fn find_parent_index(
    records: &[UnifiedRecord],
    by_key: &HashMap<String, usize>,
    index: usize,
) -> Option<usize> {
    let mut keys = parent_reference_keys(&records[index]);
    if let Some(saved) = &records[index].saved {
        if let Some(parent_path) = saved.get("parentSessionPath").and_then(Value::as_str) {
            if !parent_path.is_empty() {
                keys.push(format!("file:{parent_path}"));
            }
        }
    }
    keys.iter()
        .find_map(|key| by_key.get(key).copied())
        .filter(|parent| *parent != index)
}

/// The parent-reference keys of one record's daemon summary (the same
/// order TS `getParentKeys` uses).
fn parent_reference_keys(record: &UnifiedRecord) -> Vec<String> {
    record
        .daemon
        .as_ref()
        .map(summary_parent_keys)
        .unwrap_or_default()
}

/// The `parent` record's session file, live summary first, saved catalog
/// row second (both serve absolute paths).
fn parent_record_file(parent: &UnifiedRecord) -> Option<&str> {
    parent
        .daemon
        .as_ref()
        .and_then(|daemon| daemon.get("sessionFile"))
        .and_then(Value::as_str)
        .or_else(|| {
            parent
                .saved
                .as_ref()
                .and_then(|saved| saved.get("path"))
                .and_then(Value::as_str)
        })
}

/// Whether `parent` sits exactly one level above `child`'s live summary:
/// a spawned child's parent binding is depth-consistent (the parent is
/// one level up); a fork's source binding sits at the SAME depth and is
/// a sibling, never a parent.
fn depth_consistent_parent(daemon: &Value, parent: &UnifiedRecord) -> bool {
    let Some(depth) = daemon
        .get("rlmDepth")
        .and_then(Value::as_u64)
        .filter(|depth| *depth > 0)
    else {
        return false;
    };
    let Some(parent_path) = daemon
        .get("parentSessionPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    else {
        return false;
    };
    let parent_depth = parent
        .daemon
        .as_ref()
        .and_then(|daemon| daemon.get("rlmDepth"))
        .and_then(Value::as_u64)
        .or_else(|| {
            parent
                .saved
                .as_ref()
                .and_then(|saved| saved.get("rlmDepth"))
                .and_then(Value::as_u64)
        });
    parent_record_file(parent) == Some(parent_path) && parent_depth == Some(depth - 1)
}

/// Whether `child` rolls up under `parent` (TS `isSubagentDescendantRecord`):
/// agent lineage only — a branched/forked session links to its source but
/// is a sibling chat, so it never nests or double-books totals. Resident
/// children carry the subagent runtime kind; saved children go by depth.
/// A live `top-level` runtime counts too when its opened file carries a
/// spawn-consistent parent binding (the record index already links it).
fn is_subagent_descendant(child: &UnifiedRecord, parent: &UnifiedRecord) -> bool {
    if let Some(daemon) = &child.daemon {
        return is_subagent_summary(daemon) || depth_consistent_parent(daemon, parent);
    }
    let child_depth = child
        .saved
        .as_ref()
        .and_then(|saved| saved.get("rlmDepth"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let parent_depth = parent
        .daemon
        .as_ref()
        .and_then(|daemon| daemon.get("rlmDepth"))
        .and_then(Value::as_u64)
        .or_else(|| {
            parent
                .saved
                .as_ref()
                .and_then(|saved| saved.get("rlmDepth"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    child_depth > parent_depth
}

/// Roll costs and descendant counts over the whole hierarchy (TS
/// `computeRecursiveRollups`), keyed by record identity so filters never
/// change a row's totals.
pub fn compute_rollups(records: &[UnifiedRecord]) -> HashMap<String, Rollup> {
    let index = build_record_index(records);
    // Roots first, then breadth-first: the bottom-up pass below sees every
    // child before its parent.
    let mut order: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(position, _)| find_parent_index(records, &index.by_key, *position).is_none())
        .map(|(position, _)| position)
        .collect();
    // A growing `order` needs a re-evaluated bound: a `0..order.len()`
    // range captures the roots' length once, and every depth-2+ descendant
    // would silently drop out of the rollup walk (its cost vanishing from
    // every ancestor's total).
    let mut slot = 0;
    while slot < order.len() {
        for child in index
            .children_by_parent
            .get(&order[slot])
            .into_iter()
            .flatten()
        {
            order.push(*child);
        }
        slot += 1;
    }
    let mut rollups = vec![Rollup::default(); records.len()];
    for position in order.iter().rev() {
        // The deleted-descendant bucket is read INDEPENDENTLY of the own
        // cost: an orchestrator parent with no own billable work (the
        // own-zero gate omits `usage` entirely) still bills its deleted
        // descendants' spend — the bucket carried inside the own-cost
        // Option would drop with it.
        let deleted_descendants = records[*position]
            .saved
            .as_ref()
            .and_then(|saved| saved.get("deletedDescendantUsage"))
            .and_then(|deleted| deleted.get("cost"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        // Deleted subagents keep no row, and their spend is already
        // subtracted from the parent's own usage by the attribution
        // entries: without this term a deletion erases the money from
        // the subtree total (TS #2506's `computeRecursiveRollups`).
        let own_cost = records[*position]
            .daemon
            .as_ref()
            .and_then(|daemon| daemon.get("usage"))
            .and_then(|usage| usage.get("cost"))
            .and_then(Value::as_f64)
            .or_else(|| {
                records[*position]
                    .saved
                    .as_ref()
                    .and_then(|saved| saved.get("usage"))
                    .and_then(|usage| usage.get("cost"))
                    .and_then(Value::as_f64)
            })
            .unwrap_or(0.0)
            + deleted_descendants;
        let mut rollup = Rollup {
            cost: own_cost,
            descendant_count: 0,
        };
        for child in index.children_by_parent.get(position).into_iter().flatten() {
            if !is_subagent_descendant(&records[*child], &records[*position]) {
                continue;
            }
            rollup.cost += rollups[*child].cost;
            rollup.descendant_count += 1 + rollups[*child].descendant_count;
        }
        rollups[*position] = rollup;
    }
    order.clear();
    records
        .iter()
        .enumerate()
        .map(|(position, record)| (record.identity.clone(), rollups[position]))
        .collect()
}

/// The record a scope key resolves to (TS `findScopeRecord`: active id
/// first, then session id).
fn scope_root_index(records: &[UnifiedRecord], scope: &AgentsViewScope) -> Option<usize> {
    if let Some(active) = &scope.active_session_id {
        if let Some(position) = records.iter().position(|record| {
            summary_for_record(record)
                .get("activeSessionId")
                .and_then(Value::as_str)
                == Some(active.as_str())
        }) {
            return Some(position);
        }
    }
    scope.session_id.as_ref().and_then(|session| {
        records.iter().position(|record| {
            summary_for_record(record)
                .get("sessionId")
                .and_then(Value::as_str)
                == Some(session.as_str())
        })
    })
}

/// Restrict records to the scoped root and every descendant (TS
/// `scopeToSessionSubtree`; the root itself is included — row building
/// excludes it from the visible roots). `None` when the scope root is not
/// in the record set.
pub fn scope_to_subtree(
    records: &[UnifiedRecord],
    scope: &AgentsViewScope,
) -> Option<Vec<UnifiedRecord>> {
    let index = build_record_index(records);
    let root = scope_root_index(records, scope)?;
    let mut retained: HashSet<usize> = HashSet::new();
    let mut queue = vec![root];
    let mut cursor = 0;
    while cursor < queue.len() {
        let current = queue[cursor];
        cursor += 1;
        if !retained.insert(current) {
            continue;
        }
        queue.extend(index.children_by_parent.get(&current).into_iter().flatten());
    }
    Some(
        records
            .iter()
            .enumerate()
            .filter(|(position, _)| retained.contains(position))
            .map(|(_, record)| record.clone())
            .collect(),
    )
}

/// Session ids of the scope root's own ancestors, root-most first (TS
/// `getUnifiedSessionAncestorSessionIds`).
pub fn scope_ancestors(records: &[UnifiedRecord], scope: &AgentsViewScope) -> Vec<String> {
    let index = build_record_index(records);
    let Some(mut current) = scope_root_index(records, scope) else {
        return Vec::new();
    };
    let mut visited: HashSet<usize> = HashSet::new();
    let mut ancestors: Vec<String> = Vec::new();
    while let Some(parent) = find_parent_index(records, &index.by_key, current) {
        if !visited.insert(parent) {
            break;
        }
        ancestors.insert(
            0,
            summary_for_record(&records[parent])
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        );
        current = parent;
    }
    ancestors
}

/// Whether the session has direct children on the record set (TS
/// `hasUnifiedSessionChildren`).
pub fn has_session_children(records: &[UnifiedRecord], key: &SelectionKey) -> bool {
    let index = build_record_index(records);
    let root = records.iter().position(|record| {
        let summary = summary_for_record(record);
        let active = summary.get("activeSessionId").and_then(Value::as_str);
        let session = summary.get("sessionId").and_then(Value::as_str);
        match (&key.active_session_id, &key.session_id) {
            (Some(active_key), _) if Some(active_key.as_str()) == active => true,
            (None, Some(session_key)) if Some(session_key.as_str()) == session => true,
            _ => false,
        }
    });
    root.is_some_and(|root| {
        index
            .children_by_parent
            .get(&root)
            .is_some_and(|children| !children.is_empty())
    })
}

/// The scope root's depth label (TS `getAgentsViewDepth`:
/// `rlmDepth + 1`); `None` when the root is not in the record set.
pub fn scope_depth(records: &[UnifiedRecord], scope: &AgentsViewScope) -> Option<u32> {
    scope_root_index(records, scope).map(|root| {
        summary_for_record(&records[root])
            .get("rlmDepth")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
            + 1
    })
}

/// One base row while the forest is being assembled.
struct BaseRow {
    kind: RowKind,
    section: Section,
    identity: String,
    summary: Value,
    title: String,
    status_label: String,
    model: String,
    activity: String,
    age: String,
    own_cost: f64,
    recursive_cost: f64,
    descendant_count: usize,
    running_subagent_count: usize,
    /// The descendant-tree model multiset (the summary row's model mix):
    /// a real model string (never the `-` placeholder) -> its count. The
    /// collapsed summary row otherwise hides every subagent's model — and
    /// the mix is what tells the operator a tree runs a model blend.
    descendant_models: std::collections::BTreeMap<String, usize>,
    record: usize,
    search_score: Option<f64>,
}

/// Build the session-list rows (TS `buildAgentsViewRows`): top-level
/// agents, each with its `N subagents` summary row, and the nested child
/// rows of every expanded parent. `expanded` holds the parent row
/// identities whose lists are open; `rollups` carries the unfiltered
/// hierarchy totals; a scope excludes its root and lifts its direct
/// children to top-level rows.
pub fn build_rows(
    records: &[UnifiedRecord],
    scope: Option<&AgentsViewScope>,
    expanded: &HashSet<String>,
    rollups: &HashMap<String, Rollup>,
    anchor: Option<&str>,
) -> Vec<AgentsViewRow> {
    let now = now_ms();
    // The scope root's keys, used to lift its direct children to
    // top-level rows (TS `isDirectScopeChild`).
    let scope_root = scope.and_then(|scope| {
        records
            .iter()
            .position(|record| {
                let summary = summary_for_record(record);
                let session = summary.get("sessionId").and_then(Value::as_str);
                let active = summary.get("activeSessionId").and_then(Value::as_str);
                scope.session_id.as_deref() == session
                    || scope.active_session_id.as_deref() == active
            })
            .map(|root| (root, records[root].aliases.clone()))
    });
    let is_direct_scope_child = |summary: &Value| {
        scope_root.as_ref().is_some_and(|(_, keys)| {
            summary_parent_keys(summary)
                .iter()
                .any(|key| keys.contains(key))
        })
    };
    let mut base: Vec<BaseRow> = Vec::with_capacity(records.len());
    for (position, record) in records.iter().enumerate() {
        let summary = summary_for_record(record);
        let kind = if !is_direct_scope_child(&summary)
            && (is_subagent_summary(&summary)
                || records
                    .iter()
                    .any(|parent| depth_consistent_parent(&summary, parent)))
        {
            RowKind::Subagent
        } else {
            RowKind::Agent
        };
        // TS renderRow: the status label shows only when the summary
        // carries `lastHeardFromAt` (live subagent contact) or its own
        // `statusLabel`; roster rows with neither render no activity.
        let has_status_source = summary.get("lastHeardFromAt").is_some_and(|v| !v.is_null())
            || summary.get("statusLabel").is_some_and(|v| !v.is_null());
        let status = if has_status_source {
            session_status_label(&summary)
        } else {
            String::new()
        };
        let age = relative_age(
            if summary
                .get("activeSessionId")
                .and_then(Value::as_str)
                .is_some()
            {
                summary
                    .get("created")
                    .and_then(Value::as_str)
                    .or_else(|| summary.get("modified").and_then(Value::as_str))
            } else {
                summary
                    .get("modified")
                    .and_then(Value::as_str)
                    .or_else(|| summary.get("created").and_then(Value::as_str))
            },
            now,
        );
        let rollup = rollups.get(&record.identity).copied().unwrap_or_default();
        let model = session_model(&summary);
        base.push(BaseRow {
            kind,
            section: record.section,
            search_score: record.search_score,
            identity: record.identity.clone(),
            title: session_title(&summary),
            status_label: status.clone(),
            model,
            activity: status,
            age,
            own_cost: summary
                .get("usage")
                .and_then(|usage| usage.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            recursive_cost: rollup.cost,
            descendant_count: rollup.descendant_count,
            running_subagent_count: 0,
            descendant_models: std::collections::BTreeMap::new(),
            summary,
            record: position,
        });
    }
    // Parent linkage (TS `findParentRow` over each row's summary keys): a
    // subagent row nests under the first row its parent keys resolve to.
    let by_summary_key: HashMap<String, usize> = base
        .iter()
        .enumerate()
        .flat_map(|(index, row)| {
            summary_identity_keys(&row.summary)
                .into_iter()
                .map(move |key| (key, index))
        })
        .collect();
    let mut children_by_parent: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut parent_by_child: HashMap<usize, usize> = HashMap::new();
    let mut nested: HashSet<usize> = HashSet::new();
    for index in 0..base.len() {
        if base[index].kind != RowKind::Subagent {
            continue;
        }
        let parent = summary_parent_keys(&base[index].summary)
            .iter()
            .find_map(|key| by_summary_key.get(key).copied())
            .filter(|parent| *parent != index);
        let Some(parent) = parent else {
            // Saved catalogs stream progressively, so a child can arrive
            // before its parent. Keep it reachable as a root until the
            // parent record appears.
            base[index].kind = RowKind::Agent;
            continue;
        };
        // A branched/forked session links to its source but is a top-level
        // chat in its own right, so it must not nest (nor count in the
        // expander).
        if !is_subagent_descendant(&records[base[index].record], &records[base[parent].record]) {
            base[index].kind = RowKind::Agent;
            continue;
        }
        nested.insert(index);
        children_by_parent.entry(parent).or_default().push(index);
        parent_by_child.insert(index, parent);
    }
    // Busy-descendant tally from the live rows, iterative over the parent
    // forest so deep chains cannot overflow (TS `runningSubagentCount`).
    // The traversal is dynamically bounded — every row appended during the
    // walk is itself traversed — so a chain of any depth folds before its
    // parent (TS's `index < tallyOrder.length` loop; a fixed `0..len` range
    // would strand grandchildren and their descendants out of every fold:
    // the busy tally, the descendant counts, the cost rollups, and the
    // summary row's model mix).
    let mut tally_order: Vec<usize> = (0..base.len())
        .filter(|index| !nested.contains(index))
        .collect();
    let mut position = 0;
    while position < tally_order.len() {
        for child in children_by_parent
            .get(&tally_order[position])
            .into_iter()
            .flatten()
        {
            tally_order.push(*child);
        }
        position += 1;
    }
    for index in tally_order.iter().rev() {
        let mut running = 0;
        let mut descendants = 0;
        let mut descendants_cost = 0.0;
        // The descendant model multiset rolls up in the same walk (the
        // summary row renders the whole descendant tree's model mix,
        // matching its descendant count's deliberate divergence): each
        // child contributes its own model plus its already-rolled map.
        let mut models: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for child in children_by_parent.get(index).into_iter().flatten() {
            running += (base[*child].section == Section::Running) as usize
                + base[*child].running_subagent_count;
            descendants += 1 + base[*child].descendant_count;
            descendants_cost += base[*child].recursive_cost;
            if base[*child].model != "-" {
                *models.entry(base[*child].model.clone()).or_insert(0) += 1;
            }
            for (model, count) in &base[*child].descendant_models {
                *models.entry(model.clone()).or_insert(0) += *count;
            }
        }
        base[*index].descendant_models = models;
        base[*index].running_subagent_count = running;
        // Rollups follow the unfiltered hierarchy; the per-pass walk is the
        // fallback when the caller passed none (TS `rollup ?? descendants`).
        if !rollups.contains_key(&base[*index].identity) {
            base[*index].descendant_count = descendants;
            base[*index].recursive_cost = base[*index].own_cost + descendants_cost;
        }
    }
    // An active query renders the picker as one flat, globally ranked
    // run: every hit and every retained ancestor gets one row (no
    // nesting, no `N subagents` summaries), `compare_base` orders scored
    // hits by relevance and recency and sinks unscored ancestors below
    // every hit, and each row keeps its parent linkage so drill-ins
    // still resolve the ancestor chain.
    if records.iter().any(|record| record.search_score.is_some()) {
        let scope_root_record = scope_root.as_ref().map(|(root, _)| *root);
        let mut flat: Vec<usize> = (0..base.len())
            .filter(|index| Some(base[*index].record) != scope_root_record)
            .collect();
        flat.sort_by(|a, b| compare_base(&base[*a], &base[*b], anchor));
        return flat
            .into_iter()
            .map(|index| {
                let parent = parent_by_child
                    .get(&index)
                    .map(|parent| base[*parent].identity.as_str());
                agents_row(&base[index], 0, parent)
            })
            .collect();
    }
    // Flatten: roots in list order, each followed by its summary row and,
    // when expanded, its children (TS `emit`).
    let roots: Vec<usize> = (0..base.len())
        .filter(|index| !nested.contains(index))
        .collect();
    let mut visible_roots: Vec<usize> = roots
        .iter()
        .copied()
        .filter(|index| Some(base[*index].record) != scope_root.as_ref().map(|(root, _)| *root))
        .collect();
    visible_roots.sort_by(|a, b| compare_base(&base[*a], &base[*b], anchor));
    let forest = RowForest {
        base: &base,
        children_by_parent: &children_by_parent,
        expanded,
        anchor,
    };
    let mut rows: Vec<AgentsViewRow> = Vec::new();
    for root in visible_roots {
        forest.emit(root, 0, None, &mut rows);
    }
    rows
}

/// The assembled forest one emit pass walks.
struct RowForest<'a> {
    base: &'a [BaseRow],
    children_by_parent: &'a HashMap<usize, Vec<usize>>,
    expanded: &'a HashSet<String>,
    anchor: Option<&'a str>,
}

impl RowForest<'_> {
    /// Emit one row, then its summary row, then its expanded children
    /// (TS `emit`): depth and parent identity come from the walk.
    fn emit(
        &self,
        index: usize,
        depth: usize,
        parent_identity: Option<&str>,
        rows: &mut Vec<AgentsViewRow>,
    ) {
        let row = &self.base[index];
        rows.push(agents_row(row, depth, parent_identity));
        let Some(children) = self.children_by_parent.get(&index) else {
            return;
        };
        if children.is_empty() {
            return;
        }
        let is_expanded = self.expanded.contains(&row.identity);
        rows.push(subagent_summary_row(row, depth + 1, is_expanded));
        if !is_expanded {
            return;
        }
        let mut sorted = children.clone();
        sorted.sort_by(|a, b| compare_base(&self.base[*a], &self.base[*b], self.anchor));
        for child in sorted {
            self.emit(child, depth + 1, Some(&row.identity), rows);
        }
    }
}

/// One session row's rendered fields (the display-side slice the layout
/// and the open action read).
fn agents_row(row: &BaseRow, depth: usize, parent_identity: Option<&str>) -> AgentsViewRow {
    AgentsViewRow {
        kind: row.kind,
        section: row.section,
        identity: row.identity.clone(),
        parent_identity: parent_identity.map(str::to_string),
        summary: row.summary.clone(),
        title: row.title.clone(),
        status_label: row.status_label.clone(),
        model: row.model.clone(),
        activity: row.activity.clone(),
        cost: row.recursive_cost,
        age: row.age.clone(),
        depth,
        descendant_count: row.descendant_count,
        running_subagent_count: row.running_subagent_count,
        expanded: false,
    }
}

/// The collapsed summary row's model mix (the operator's cost question:
/// which models the subagent tree runs): `model×count` per distinct
/// model, highest count first, then alphabetical —
/// `glm-5.3-fast×2, opus-4-6`. Empty when no descendant carries
/// model identity.
fn model_mix(models: &std::collections::BTreeMap<String, usize>) -> String {
    let mut entries: Vec<(&String, usize)> = models
        .iter()
        .map(|(model, count)| (model, *count))
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    entries
        .into_iter()
        .map(|(model, count)| {
            if count > 1 {
                format!("{model}\u{d7}{count}")
            } else {
                model.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The `N subagents` summary row under one agent (TS
/// `createSubagentSummaryRow`, with the deliberate divergence that the
/// count aggregates the whole descendant tree rather than the
/// direct-children list): the running label counts the recursively
/// running rows, and finished subagents stay reachable through the row
/// even when nothing is running anymore. The collapsed row is the one
/// place the subagent tree's model mix surfaces — expanded
/// children already render their own Model column.
fn subagent_summary_row(parent: &BaseRow, depth: usize, expanded: bool) -> AgentsViewRow {
    let total = parent.descendant_count;
    let running = parent.running_subagent_count;
    let mut title = if running > 0 {
        format!(
            "{running} {} running",
            if running == 1 {
                "subagent"
            } else {
                "subagents"
            }
        )
    } else {
        format!(
            "{total} {}",
            if total == 1 { "subagent" } else { "subagents" }
        )
    };
    let mix = model_mix(&parent.descendant_models);
    if !mix.is_empty() {
        title.push_str(" \u{b7} ");
        title.push_str(&mix);
    }
    AgentsViewRow {
        kind: RowKind::SubagentSummary,
        section: parent.section,
        identity: format!("subagents:{}", parent.identity),
        parent_identity: Some(parent.identity.clone()),
        summary: parent.summary.clone(),
        title,
        status_label: String::new(),
        model: String::new(),
        activity: String::new(),
        cost: 0.0,
        age: parent.age.clone(),
        depth,
        descendant_count: 0,
        running_subagent_count: running,
        expanded,
    }
}

/// TS `compareAgentsViewRows`: section rank, then empty sessions sink,
/// then recency, then title, then session id.
fn compare_base(a: &BaseRow, b: &BaseRow, anchor: Option<&str>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn get_str<'a>(summary: &'a Value, field: &str) -> Option<&'a str> {
        summary
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    }
    let timestamp = |summary: &Value, field: &str| {
        get_str(summary, field).map_or(0, |value| {
            crate::agents_view_state::timestamp_ms(Some(value))
        })
    };
    // Search hits rank relevance first: the score decides before
    // anything else, retained ancestors (unscored) sink below every hit,
    // and recency breaks score ties; section grouping only orders rows
    // that the query did not rank.
    if let (Some(left), Some(right)) = (a.search_score, b.search_score) {
        let by_score = left.total_cmp(&right);
        if by_score != Ordering::Equal {
            return by_score;
        }
        let activity =
            timestamp(&b.summary, "lastActivityAt").cmp(&timestamp(&a.summary, "lastActivityAt"));
        if activity != Ordering::Equal {
            return activity;
        }
        let created = timestamp(&b.summary, "created").cmp(&timestamp(&a.summary, "created"));
        if created != Ordering::Equal {
            return created;
        }
        return finalize_base(a, b);
    }
    if a.search_score.is_some() != b.search_score.is_some() {
        // The scored hit renders before the retained ancestor.
        return b.search_score.is_some().cmp(&a.search_score.is_some());
    }
    let section = section_rank(a.section).cmp(&section_rank(b.section));
    if section != Ordering::Equal {
        return section;
    }
    // Message-less rows sink to the bottom of their section (anchor exempt).
    let empty = |row: &BaseRow| {
        row.summary
            .get("messageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
            && get_str(&row.summary, "sessionId") != anchor
    };
    let empty_rank = empty(a).cmp(&empty(b));
    if empty_rank != Ordering::Equal {
        return empty_rank;
    }
    if a.section != Section::Running {
        let busy = (b.running_subagent_count > 0) as u8;
        let busy_a = (a.running_subagent_count > 0) as u8;
        let busy_diff = busy.cmp(&busy_a);
        if busy_diff != Ordering::Equal {
            return busy_diff;
        }
        let activity =
            timestamp(&b.summary, "lastActivityAt").cmp(&timestamp(&a.summary, "lastActivityAt"));
        if activity != Ordering::Equal {
            return activity;
        }
    }
    let created = timestamp(&b.summary, "created").cmp(&timestamp(&a.summary, "created"));
    if created != Ordering::Equal {
        return created;
    }
    finalize_base(a, b)
}

/// The shared final tiebreaks: title, then session id.
fn finalize_base(a: &BaseRow, b: &BaseRow) -> std::cmp::Ordering {
    fn session_id(row: &BaseRow) -> Option<&str> {
        row.summary
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    }
    let title = a.title.cmp(&b.title);
    if title != std::cmp::Ordering::Equal {
        return title;
    }
    session_id(a).cmp(&session_id(b))
}

/// Session ids of every ancestor of a nested row, root-most first (TS
/// `collectSubagentAncestorSessionIds`): the chain the view re-expands
/// when the drilled-in child returns to it.
pub fn ancestor_session_ids(rows: &[AgentsViewRow], parent_identity: Option<&str>) -> Vec<String> {
    let mut ancestors: Vec<String> = Vec::new();
    let mut parent = parent_identity;
    let mut guard = 0;
    while let Some(identity) = parent {
        guard += 1;
        if guard > rows.len() {
            break;
        }
        let Some(row) = rows
            .iter()
            .find(|row| row.identity == identity)
            .filter(|row| row.kind != RowKind::SubagentSummary)
        else {
            break;
        };
        ancestors.insert(
            0,
            row.summary
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        );
        parent = row.parent_identity.as_deref();
    }
    ancestors
}

/// Resolve the selection after a rebuild (TS
/// `resolveAgentsViewSelectionState`): the row identity wins, then the
/// active session id, then the session id; an unresolvable anchor keeps
/// the bounded current index, else the first selectable row. A
/// `subagents:` identity pins the fallbacks to summary rows, which reuse
/// their parent's session key.
pub fn resolve_selection(
    rows: &[AgentsViewRow],
    current: usize,
    identity: Option<&str>,
    key: Option<&SelectionKey>,
) -> usize {
    fn find_selectable<F: Fn(&AgentsViewRow) -> bool>(
        rows: &[AgentsViewRow],
        predicate: F,
    ) -> Option<usize> {
        rows.iter()
            .position(|row| row.selectable() && predicate(row))
    }
    if rows.is_empty() {
        return 0;
    }
    let selected_summary_row = identity.is_some_and(|id| id.starts_with("subagents:"));
    let preserves_kind =
        |row: &AgentsViewRow| !selected_summary_row || row.kind == RowKind::SubagentSummary;
    if let Some(identity) = identity {
        if let Some(index) = find_selectable(rows, |row| row.identity == identity) {
            // Synthetic nested rows deliberately reuse their parent's
            // session key, so their exact row identity must win over the
            // active-runtime fallback.
            if rows[index].kind != RowKind::Agent {
                return index;
            }
        }
    }
    if let Some(active) = key.and_then(|key| key.active_session_id.as_deref()) {
        if let Some(index) = find_selectable(rows, |row| {
            preserves_kind(row)
                && row
                    .summary
                    .get("activeSessionId")
                    .or_else(|| row.summary.get("id"))
                    .and_then(Value::as_str)
                    == Some(active)
        }) {
            return index;
        }
    }
    if let Some(identity) = identity {
        if let Some(index) = find_selectable(rows, |row| row.identity == identity) {
            return index;
        }
    }
    if let Some(session) = key.and_then(|key| key.session_id.as_deref()) {
        if let Some(index) = find_selectable(rows, |row| {
            preserves_kind(row)
                && row.summary.get("sessionId").and_then(Value::as_str) == Some(session)
        }) {
            return index;
        }
    }
    let bounded = current.min(rows.len() - 1);
    if rows[bounded].selectable() {
        return bounded;
    }
    rows.iter()
        .position(AgentsViewRow::selectable)
        .unwrap_or(bounded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents_view_state::reconcile_unified_sessions;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    fn roster_entry(agent: &str, status: &str, summary: serde_json::Value) -> serde_json::Value {
        json!({ "agentId": agent, "status": status, "summary": summary })
    }

    fn parent_summary(id: &str) -> serde_json::Value {
        json!({
            "sessionId": id,
            "lifecycle": "live",
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/x/{id}.jsonl"),
            "runtimeKind": "top-level",
            "sessionName": format!("{id} name"),
            "messageCount": 2,
        })
    }

    fn child_summary(id: &str, parent: &str, name: &str) -> serde_json::Value {
        json!({
            "sessionId": id,
            "lifecycle": "live",
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/x/{id}.jsonl"),
            "runtimeKind": "subagent",
            "rlmChildId": format!("child-{id}"),
            "parentActiveSessionId": format!("{parent}-live"),
            "parentSessionId": parent,
            "parentSessionPath": format!("/x/{parent}.jsonl"),
            "sessionName": name,
            "messageCount": 1,
        })
    }

    fn rows_for(
        roster: &[serde_json::Value],
        scope: Option<&AgentsViewScope>,
        expanded: &[&str],
    ) -> Vec<AgentsViewRow> {
        let records = reconcile_unified_sessions(roster, &[]);
        let rollups = compute_rollups(&records);
        let expanded: HashSet<String> = expanded.iter().map(ToString::to_string).collect();
        build_rows(&records, scope, &expanded, &rollups, None)
    }

    /// An opened child session nests under its parent: the live
    /// `top-level` runtime carries the opened file's spawn-time parent
    /// binding one level below the parent, so the view renders it as a
    /// child row behind the parent's collapsed summary, never as a new
    /// top-level agent.
    #[test]
    fn an_opened_child_nests_under_its_parent() {
        let mut opened = parent_summary("opened");
        opened["rlmDepth"] = json!(1);
        opened["parentSessionPath"] = json!("/x/parent.jsonl");
        opened["sessionName"] = json!("opened child");
        let mut parent = parent_summary("parent");
        parent["rlmDepth"] = json!(0);
        let roster = vec![
            roster_entry("parent", "idle", parent),
            roster_entry("opened", "idle", opened),
        ];
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(
            rows.iter().filter(|row| row.kind == RowKind::Agent).count(),
            1,
            "the parent is the only agent row: {rows:?}"
        );
        let parent_row = rows
            .iter()
            .find(|row| row.kind == RowKind::Agent)
            .expect("the parent row");
        assert_eq!(
            parent_row.descendant_count, 1,
            "the opened child rides the parent's aggregate: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|row| row.kind == RowKind::SubagentSummary && row.title == "1 subagent"),
            "the parent's summary row labels the aggregate: {rows:?}"
        );
        let rows = rows_for(&roster, None, &["file:/x/parent.jsonl"]);
        let child = rows
            .iter()
            .find(|row| row.title == "opened child")
            .expect("the expanded list renders the opened child");
        assert_eq!(child.kind, RowKind::Subagent);
        assert_eq!(
            child.parent_identity.as_deref(),
            Some("file:/x/parent.jsonl")
        );
    }

    /// A forked session links its header to its source at the SAME depth:
    /// the fork is a sibling chat and stays a top-level row, and the
    /// source's aggregate never counts it.
    #[test]
    fn a_fork_of_a_child_stays_a_sibling_row() {
        let mut source = parent_summary("source");
        source["rlmDepth"] = json!(1);
        let mut fork = parent_summary("fork");
        fork["rlmDepth"] = json!(1);
        fork["parentSessionPath"] = json!("/x/source.jsonl");
        fork["sessionName"] = json!("forked chat");
        let roster = vec![
            roster_entry("source", "idle", source),
            roster_entry("fork", "idle", fork),
        ];
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(
            rows.iter()
                .filter(|row| row.kind == RowKind::Agent && row.title != "source name")
                .count(),
            1,
            "the fork renders as its own top-level row: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.kind == RowKind::SubagentSummary),
            "the source's aggregate never counts the fork: {rows:?}"
        );
    }

    /// The Model column reads every wire shape of the model selector: a
    /// bare string, a live worker's `model.id`, and a seeded or
    /// saved-session row's `model.modelId` — always the full
    /// `model:thinking` string, never a truncated `provider/` blob.
    #[test]
    fn session_model_reads_every_wire_shape() {
        let bare = json!({"model": "internal/glm-5.3-fast", "thinkingLevel": "high"});
        assert_eq!(session_model(&bare), "glm-5.3-fast:high");
        let live = json!({
            "model": {"id": "internal/glm-5.3-fast", "name": "GLM", "provider": "prime-inference"},
            "thinkingLevel": "high",
        });
        assert_eq!(session_model(&live), "glm-5.3-fast:high");
        let seeded = json!({
            "model": {"provider": "prime-inference", "modelId": "internal/glm-5.3-fast"},
            "thinkingLevel": "high",
        });
        assert_eq!(session_model(&seeded), "glm-5.3-fast:high");
        // "off" reads as noise: the bare model id, no suffix.
        let off = json!({
            "model": {"id": "internal/glm-5.3-fast"},
            "thinkingLevel": "off",
        });
        assert_eq!(session_model(&off), "glm-5.3-fast");
        assert_eq!(session_model(&json!({})), "-");
        assert_eq!(
            session_model(&json!({"model": {"provider": "p"}, "thinkingLevel": "high"})),
            "-",
            "an empty id stays empty — never a `p/`-style blob"
        );
    }

    #[test]
    fn parent_with_child_renders_the_summary_row_and_nested_child() {
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        // Collapsed: the parent, its summary row, nothing else.
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, RowKind::Agent);
        assert_eq!(rows[1].kind, RowKind::SubagentSummary);
        assert_eq!(rows[1].identity, "subagents:file:/x/p.jsonl");
        assert_eq!(rows[1].parent_identity.as_deref(), Some("file:/x/p.jsonl"));
        assert_eq!(rows[1].title, "1 subagent running");
        assert!(!rows[1].expanded);
        assert_eq!(rows[0].descendant_count, 1);
        assert_eq!(rows[0].running_subagent_count, 1);
        // Expanded: the child nests under the summary row at depth 1.
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].title, "1 subagent running");
        assert!(rows[1].expanded);
        assert_eq!(rows[2].kind, RowKind::Subagent);
        assert_eq!(rows[2].depth, 1);
        assert_eq!(rows[2].title, "worker one");
        assert_eq!(rows[2].parent_identity.as_deref(), Some("file:/x/p.jsonl"));
    }

    #[test]
    fn deeper_descendants_roll_up_and_nest_recursively() {
        let mut grandchild = child_summary("gc", "c", "grandchild");
        grandchild["rlmChildId"] = json!("child-gc");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "idle", child_summary("c", "p", "worker one")),
            roster_entry("gc", "running", grandchild),
        ];
        // Collapsed: the parent's descendant count carries the whole
        // subtree (TS rollups span the unfiltered hierarchy).
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(rows[0].descendant_count, 2);
        assert_eq!(rows[0].running_subagent_count, 1);
        assert_eq!(rows[1].title, "1 subagent running");
        // Expanding the parent reveals the child and ITS summary row; the
        // grandchild stays hidden until its own parent expands. The one
        // running grandchild drives the summary title (TS counts live
        // running descendants).
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        assert_eq!(
            rows.iter()
                .map(|row| (row.kind, row.depth))
                .collect::<Vec<_>>(),
            vec![
                (RowKind::Agent, 0),
                (RowKind::SubagentSummary, 1),
                (RowKind::Subagent, 1),
                (RowKind::SubagentSummary, 2),
            ]
        );
        assert_eq!(rows[1].title, "1 subagent running");
        // Expanding both levels reveals the grandchild at depth 2.
        let child_identity = rows
            .iter()
            .find(|row| row.title == "worker one")
            .expect("child row")
            .identity
            .clone();
        let child_identity_str = child_identity.as_str().to_string();
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl", &child_identity_str]);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[4].kind, RowKind::Subagent);
        assert_eq!(rows[4].depth, 2);
        assert_eq!(rows[4].title, "grandchild");
    }

    /// The collapsed summary row carries the subagent tree's model mix
    /// (the operator's cost question: which models the tree runs). The
    /// count spans the whole descendant tree like the summary count
    /// itself; `-` placeholders stay out; ties order alphabetically.
    #[test]
    fn summary_row_carries_the_descendant_model_mix() {
        let mut glm_one = child_summary("c1", "p", "worker one");
        glm_one["model"] = json!("internal/glm-5.3-fast");
        let mut glm_two = child_summary("c2", "p", "worker two");
        glm_two["model"] = json!("internal/glm-5.3-fast");
        let mut opus = child_summary("c3", "p", "worker three");
        opus["model"] = json!("anthropic/claude-opus-4-6");
        let mut grandchild = child_summary("gc", "c3", "grandkid");
        grandchild["rlmChildId"] = json!("child-gc");
        grandchild["model"] = json!("anthropic/claude-opus-4-6");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c1", "idle", glm_one),
            roster_entry("c2", "idle", glm_two),
            roster_entry("c3", "idle", opus),
            roster_entry("gc", "idle", grandchild),
        ];
        // Collapsed: the summary row is the only place the tree's model
        // mix surfaces — two glm workers, two opus rows (a child plus
        // its grandchild).
        let rows = rows_for(&roster, None, &[]);
        let summary = rows
            .iter()
            .find(|row| row.kind == RowKind::SubagentSummary)
            .expect("summary row");
        assert_eq!(
            summary.title,
            "4 subagents \u{b7} claude-opus-4-6\u{d7}2, glm-5.3-fast\u{d7}2"
        );
        // The child's own summary row counts only its subtree.
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        let nested = rows
            .iter()
            .find(|row| row.kind == RowKind::SubagentSummary && row.depth == 2)
            .expect("nested summary row");
        assert_eq!(nested.title, "1 subagent \u{b7} claude-opus-4-6");
        // A child without model identity stays out of the mix.
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "idle", child_summary("c", "p", "worker one")),
        ];
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(rows[1].title, "1 subagent");
        // A FOUR-level chain folds at every depth: the great-grandchild's
        // model reaches the root's mix (the tally walk's dynamic bound —
        // a fixed `0..len` range would strand the great-grandchild out of
        // the rollup).
        let mut gc = child_summary("gc", "c", "grandkid");
        gc["rlmChildId"] = json!("child-gc");
        gc["model"] = json!("anthropic/claude-opus-4-6");
        let mut ggc = child_summary("ggc", "gc", "great-grandkid");
        ggc["rlmChildId"] = json!("child-ggc");
        ggc["model"] = json!("openai/gpt-5.6-sol");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "idle", child_summary("c", "p", "worker one")),
            roster_entry("gc", "idle", gc),
            roster_entry("ggc", "idle", ggc),
        ];
        let rows = rows_for(&roster, None, &[]);
        let summary = rows
            .iter()
            .find(|row| row.kind == RowKind::SubagentSummary)
            .expect("summary row");
        // `worker one` carries no model identity, so the mix counts the
        // grandchild (opus) and the great-grandchild (sol) only.
        assert_eq!(
            summary.title,
            "3 subagents \u{b7} claude-opus-4-6, gpt-5.6-sol"
        );
        assert_eq!(rows[0].descendant_count, 3);
    }

    #[test]
    fn idle_descendants_aggregate_into_the_summary_row() {
        let mut grandchild = child_summary("gc", "c", "grandchild");
        grandchild["rlmChildId"] = json!("child-gc");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "idle", child_summary("c", "p", "worker one")),
            roster_entry("gc", "idle", grandchild),
        ];
        // The `N subagents` row under a parent aggregates every
        // descendant of the subtree, not just its direct children: one
        // child that itself runs a grandchild reads `2 subagents`.
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(rows[1].title, "2 subagents");
        // The child's own summary row keeps the same walk: one grandchild.
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        let child_summary_row = rows
            .iter()
            .find(|row| row.kind == RowKind::SubagentSummary && row.depth == 2)
            .expect("child summary row");
        assert_eq!(child_summary_row.title, "1 subagent");
    }

    #[test]
    fn running_descendants_aggregate_into_the_summary_row() {
        let mut grandchild = child_summary("gc", "c", "grandchild");
        grandchild["rlmChildId"] = json!("child-gc");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
            roster_entry("gc", "running", grandchild),
        ];
        // A busy subtree runs at any depth: the running label counts the
        // child and its grandchild (TS parity for the running branch).
        let rows = rows_for(&roster, None, &[]);
        assert_eq!(rows[1].title, "2 subagents running");
    }

    #[test]
    fn scoped_rows_lift_direct_children_and_exclude_the_root() {
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        let scope = AgentsViewScope {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            session_name: None,
        };
        let records = reconcile_unified_sessions(&roster, &[]);
        // The subtree keeps the root; the rows exclude it.
        let subtree = scope_to_subtree(&records, &scope).expect("subtree");
        assert_eq!(subtree.len(), 2);
        let rows = rows_for(&roster, Some(&scope), &[]);
        assert_eq!(rows.len(), 1);
        // A direct scope child lists as a top-level agent row.
        assert_eq!(rows[0].kind, RowKind::Agent);
        assert_eq!(rows[0].title, "worker one");
        // The scope's ancestors: the root has none; its depth label is
        // rlmDepth + 1.
        assert!(scope_ancestors(&records, &scope).is_empty());
        assert_eq!(scope_depth(&records, &scope), Some(1));
        assert!(has_session_children(
            &records,
            &SelectionKey {
                session_id: Some("p".to_string()),
                active_session_id: Some("p-live".to_string()),
            }
        ));
    }

    #[test]
    fn saved_child_nests_under_its_saved_parent() {
        let saved = vec![
            json!({
                "id": "parent",
                "path": "/x/parent.jsonl",
                "name": "root agent",
                "firstMessage": "orchestrate",
                "messageCount": 1,
            }),
            json!({
                "id": "child",
                "path": "/x/child.jsonl",
                "parentSessionPath": "/x/parent.jsonl",
                "rlmDepth": 1,
                "name": "saved child",
                "firstMessage": "do the work",
                "messageCount": 1,
            }),
        ];
        let records = reconcile_unified_sessions(&[], &saved);
        let rollups = compute_rollups(&records);
        let rows = build_rows(&records, None, &HashSet::default(), &rollups, None);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, RowKind::Agent);
        assert_eq!(rows[0].title, "root agent");
        assert_eq!(rows[1].title, "1 subagent");
        let expanded: HashSet<String> = [rows[0].identity.clone()].into_iter().collect();
        let rows = build_rows(&records, None, &expanded, &rollups, None);
        assert_eq!(rows[2].title, "saved child");
        assert_eq!(rows[2].kind, RowKind::Subagent);
    }

    #[test]
    fn forked_sessions_stay_top_level() {
        let mut fork = child_summary("f", "p", "forked chat");
        fork["runtimeKind"] = json!("top-level");
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("f", "idle", fork),
        ];
        let rows = rows_for(&roster, None, &[]);
        // The fork links to its source but never nests nor counts in the
        // expander (TS `isSubagentDescendantRecord`).
        assert_eq!(rows[0].descendant_count, 0);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.kind == RowKind::Agent));
    }

    #[test]
    fn ancestor_ids_walk_the_row_chain_root_most_first() {
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "idle", child_summary("c", "p", "worker one")),
        ];
        let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        assert_eq!(
            ancestor_session_ids(&rows, rows[2].parent_identity.as_deref()),
            vec!["p".to_string()]
        );
        // A top-level row has no ancestors.
        assert!(ancestor_session_ids(&rows, None).is_empty());
    }

    #[test]
    fn selection_resolves_identity_then_keys_and_pins_summary_rows() {
        let roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        // Identity wins (the parent's identity is its file alias).
        let collapsed = rows_for(&roster, None, &[]);
        let index = resolve_selection(&collapsed, 0, Some("file:/x/p.jsonl"), None);
        assert_eq!(index, 0);
        // A `subagents:` identity pins the fallbacks to the summary row,
        // which reuses its parent's session key (TS
        // `selectedSyntheticKind`).
        let index = resolve_selection(
            &collapsed,
            0,
            Some("subagents:file:/x/p.jsonl"),
            Some(&SelectionKey {
                session_id: Some("p".to_string()),
                active_session_id: Some("p-live".to_string()),
            }),
        );
        assert_eq!(collapsed[index].kind, RowKind::SubagentSummary);
        // Active-id fallback re-finds a re-attached session once its row
        // renders (expand the parent to show the child).
        let expanded = rows_for(&roster, None, &["file:/x/p.jsonl"]);
        let index = resolve_selection(
            &expanded,
            0,
            None,
            Some(&SelectionKey {
                session_id: None,
                active_session_id: Some("c-live".to_string()),
            }),
        );
        assert_eq!(expanded[index].title, "worker one");
        // Nothing resolves: the bounded current index survives.
        assert_eq!(resolve_selection(&collapsed, 1, None, None), 1);
    }

    #[test]
    fn rollups_sum_costs_over_descendants_only() {
        let roster = vec![
            roster_entry(
                "p",
                "idle",
                json!({
                    "sessionId": "p", "lifecycle": "live", "activeSessionId": "p-live",
                    "sessionFile": "/x/p.jsonl", "runtimeKind": "top-level",
                    "messageCount": 1, "usage": { "cost": 0.5 },
                }),
            ),
            roster_entry(
                "c",
                "idle",
                json!({
                    "sessionId": "c", "lifecycle": "live", "activeSessionId": "c-live",
                    "sessionFile": "/x/c.jsonl", "runtimeKind": "subagent",
                    "rlmChildId": "child-c",
                    "parentActiveSessionId": "p-live",
                    "parentSessionId": "p", "parentSessionPath": "/x/p.jsonl",
                    "messageCount": 1, "usage": { "cost": 0.25 },
                }),
            ),
        ];
        let records = reconcile_unified_sessions(&roster, &[]);
        let rollups = compute_rollups(&records);
        let parent = rollups.get("file:/x/p.jsonl").expect("parent rollup");
        assert_eq!(parent.cost, 0.75);
        assert_eq!(parent.descendant_count, 1);

        // The numeric fixture (TS #2506): own $0 + deleted child $0.40 +
        // its deleted grandchild $0.10 (the saved row's
        // deletedDescendantUsage bucket, $0.50 post-order) + live child
        // $0.20 + surviving grandchild $0.30 => the parent's recursive
        // cost EXACTLY $1.00. The deleted children keep no rows: without
        // the bucket term the same tree bills $0.50 (the money vanished -
        // the bug), and a bucket stacked on an own-cost that already
        // carries attributed spend bills $1.50 (the double).
        let deleted = json!({
            "inputTokens": 1_100, "outputTokens": 110, "cost": 0.50
        });
        let saved_parent = json!({
            "path": "/x/p.jsonl", "id": "p",
            "usage": { "inputTokens": 0, "outputTokens": 0, "cost": 0.0 },
            "deletedDescendantUsage": deleted,
        });
        let fixture_roster = vec![
            roster_entry(
                "p",
                "idle",
                json!({
                    "sessionId": "p", "lifecycle": "live", "activeSessionId": "p-live",
                    "sessionFile": "/x/p.jsonl", "runtimeKind": "top-level",
                    "messageCount": 1, "usage": { "cost": 0.0 },
                }),
            ),
            roster_entry(
                "c2",
                "idle",
                json!({
                    "sessionId": "c2", "lifecycle": "live", "activeSessionId": "c2-live",
                    "sessionFile": "/x/c2.jsonl", "runtimeKind": "subagent",
                    "rlmChildId": "child-c2",
                    "parentActiveSessionId": "p-live",
                    "parentSessionId": "p", "parentSessionPath": "/x/p.jsonl",
                    "messageCount": 1, "usage": { "cost": 0.2 },
                }),
            ),
            roster_entry(
                "gc2",
                "idle",
                json!({
                    "sessionId": "gc2", "lifecycle": "live", "activeSessionId": "gc2-live",
                    "sessionFile": "/x/gc2.jsonl", "runtimeKind": "subagent",
                    "rlmChildId": "child-gc2",
                    "parentActiveSessionId": "c2-live",
                    "parentSessionId": "c2", "parentSessionPath": "/x/c2.jsonl",
                    "messageCount": 1, "usage": { "cost": 0.3 },
                }),
            ),
        ];
        let fixture_records =
            reconcile_unified_sessions(&fixture_roster, std::slice::from_ref(&saved_parent));
        let fixture_rollups = compute_rollups(&fixture_records);
        let fixture_parent = fixture_rollups
            .get("file:/x/p.jsonl")
            .expect("parent rollup");
        assert!(
            (fixture_parent.cost - 1.00).abs() < 1e-9,
            "own 0 + deleted bucket 0.50 + live child subtree 0.50 = 1.00, got {}",
            parent.cost
        );
        // Without the bucket the deleted spend vanishes (the pre-fix bug).
        let bare = json!({
            "path": "/x/p.jsonl", "id": "p",
            "usage": { "inputTokens": 0, "outputTokens": 0, "cost": 0.0 },
        });
        let bare_records = reconcile_unified_sessions(&fixture_roster, std::slice::from_ref(&bare));
        let bare_rollups = compute_rollups(&bare_records);
        let bare_parent = bare_rollups.get("file:/x/p.jsonl").expect("parent rollup");
        assert!(
            (bare_parent.cost - 0.50).abs() < 1e-9,
            "no bucket: only the live subtree bills, got {}",
            bare_parent.cost
        );
        let rows = rows_for(&roster, None, &[]);
        // The parent's Cost column shows the recursive total (TS
        // `recursiveCost`), and the details layout carries it.
        assert_eq!(rows[0].cost, 0.75);
        let empty: HashMap<String, Rollup> = HashMap::new();
        let rows = build_rows(&records, None, &HashSet::default(), &empty, None);
        // Without rollups the per-pass walk fills the same totals.
        assert_eq!(rows[0].cost, 0.75);
        assert_eq!(rows[0].descendant_count, 1);
    }

    #[test]
    fn an_active_query_ranks_hits_globally_ancestors_sink_last() {
        // With a query active the list is one flat, globally ranked run:
        // the scored child hit renders by its relevance against every
        // other hit — not nested after its retained ancestor and the
        // ancestor's summary — the unscored ancestor sinks below every
        // scored row, and the child keeps its parent linkage for the
        // drill-in open.
        let roster = vec![
            roster_entry("orch", "running", {
                let mut summary = parent_summary("orch");
                summary["sessionName"] = json!("zebra worker");
                summary
            }),
            roster_entry(
                "kid",
                "running",
                child_summary("kid", "orch", "policy sweep"),
            ),
            roster_entry(
                "cache",
                "idle",
                json!({
                    "sessionId": "cache",
                    "lifecycle": "live",
                    "sessionName": "sweep cache",
                    "messageCount": 2,
                }),
            ),
            roster_entry(
                "weep",
                "idle",
                json!({
                    "sessionId": "weep",
                    "lifecycle": "live",
                    "sessionName": "siberian weeping pine",
                    "messageCount": 2,
                }),
            ),
        ];
        let records = reconcile_unified_sessions(&roster, &[]);
        let filtered = crate::agents_view_state::filter_unified_sessions(
            &records,
            &crate::agents_view_state::parse_search_query("sweep"),
        );
        // The child hit and the top-level hits carry scores; the
        // retained parent stays unscored.
        let by_name = |name: &str| {
            filtered
                .iter()
                .find(|record| record.search.name == name)
                .unwrap_or_else(|| panic!("missing record {name}"))
        };
        assert!(by_name("policy sweep").search_score.is_some());
        assert!(by_name("sweep cache").search_score.is_some());
        assert!(by_name("siberian weeping pine").search_score.is_some());
        assert_eq!(by_name("zebra worker").search_score, None);
        let rollups: HashMap<String, Rollup> = HashMap::new();
        // Expansion state must not reintroduce nesting under a query.
        let mut expanded = HashSet::new();
        expanded.insert("file:/x/orch.jsonl".to_string());
        let rows = build_rows(&filtered, None, &expanded, &rollups, None);
        let titles: Vec<&str> = rows.iter().map(|row| row.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "sweep cache",
                "policy sweep",
                "siberian weeping pine",
                "zebra worker",
            ],
            "hits rank globally by relevance; the retained ancestor sinks last"
        );
        assert!(
            rows.iter().all(|row| row.kind != RowKind::SubagentSummary),
            "the flat query list carries no expander summaries"
        );
        assert!(
            rows.iter().all(|row| row.depth == 0),
            "the flat query list renders unindented"
        );
        let kid = rows
            .iter()
            .find(|row| row.title == "policy sweep")
            .expect("the child hit is present");
        assert_eq!(kid.kind, RowKind::Subagent);
        assert_eq!(
            kid.parent_identity.as_deref(),
            Some("file:/x/orch.jsonl"),
            "the child keeps its ancestor linkage"
        );
    }

    #[test]
    fn equal_scores_break_ties_by_recency_not_section() {
        // Two scored hits with equal tier scores: the more recent one
        // renders first even though it sits in a later section.
        let roster = vec![
            roster_entry(
                "old",
                "running",
                json!({
                    "sessionId": "old",
                    "lifecycle": "live",
                    "sessionName": "sweep alpha",
                    "lastActivityAt": "2024-01-01T00:00:00.000Z",
                    "created": "2024-01-01T00:00:00.000Z",
                    "messageCount": 2,
                }),
            ),
            roster_entry(
                "new",
                "idle",
                json!({
                    "sessionId": "new",
                    "lifecycle": "live",
                    "sessionName": "sweep beta",
                    "lastActivityAt": "2025-01-01T00:00:00.000Z",
                    "created": "2025-01-01T00:00:00.000Z",
                    "messageCount": 2,
                }),
            ),
        ];
        let records = reconcile_unified_sessions(&roster, &[]);
        let filtered = crate::agents_view_state::filter_unified_sessions(
            &records,
            &crate::agents_view_state::parse_search_query("sweep"),
        );
        assert_eq!(filtered.len(), 2);
        let rollups: HashMap<String, Rollup> = HashMap::new();
        let rows = build_rows(&filtered, None, &HashSet::default(), &rollups, None);
        assert_eq!(
            rows[0].title, "sweep beta",
            "recency breaks score ties before section grouping"
        );
        assert_eq!(rows[1].title, "sweep alpha");
    }
}
