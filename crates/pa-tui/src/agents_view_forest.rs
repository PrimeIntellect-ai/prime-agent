//! The agents-view subagent forest: how unified records nest into the
//! session list's rows. One pass computes the record hierarchy (parent
//! linkage, rollups), then row building emits top-level agents with their
//! subagent summary lines and, when a line is expanded, its nested
//! children. Selection resolution and ancestry walks over that row tree
//! live here too. Pure functions on the wire forms (roster summaries and
//! saved-catalog rows); the view module owns input and painting.
//!
//! Operator directive (2026-09-25, deliberate TS divergence): a parent
//! with running descendants carries TWO summary lines. The running line
//! titles `"{direct}, {nested} running"` (direct = immediately running
//! children, nested = further running descendants below them) and expands
//! to ONLY running rows — flattened through non-running ancestors so a
//! `0, N running` line still reveals its nested workers. The inactive
//! line titles `"{n} inactive subagent(s)"` and expands to the
//! not-running children, so historical agents stay discoverable without
//! contaminating the running expansion. TS `createSubagentSummaryRow`
//! instead titles one `"{n} subagents running"` / `"{n} subagents"` line
//! that expands to every child.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::agents_view_state::{
    now_ms, relative_age, section_rank, summary_for_record, Section, UnifiedRecord,
};
use crate::subagents::{summary_identity_keys, summary_parent_keys};

mod summary;

pub(crate) use summary::{is_subagent_summary, session_model};
pub use summary::{selection_key, session_title, summary_identity};

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
    pub model: String,
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
    /// The running/inactive summary lines under an agent (TS
    /// `subagent-summary`, split by the operator's 2026-09-25
    /// directive).
    SubagentSummary,
    /// A nested child row inside an expanded list (TS `subagent`).
    Subagent,
}

/// The running line's identity prefix (TS `subagent-summary` keeps the
/// `subagents:` prefix, so a carried selection restores onto it).
pub(crate) const SUMMARY_ROW_PREFIX: &str = "subagents:";
/// The inactive line's identity prefix (the operator's historical
/// agents' separate line).
pub(crate) const INACTIVE_SUMMARY_ROW_PREFIX: &str = "subagents-inactive:";

/// Whether a row identity is one of a parent's summary lines (the
/// running or the inactive line): such identities pin selection
/// fallbacks to summary rows, which reuse their parent's session key,
/// and the inactive prefix drives the toggle's expansion-set dispatch.
pub(crate) fn is_summary_row_identity(identity: &str) -> bool {
    identity.starts_with(SUMMARY_ROW_PREFIX) || identity.starts_with(INACTIVE_SUMMARY_ROW_PREFIX)
}

impl AgentsViewRow {
    /// Rows the selection may land on (TS `selectable`: every row here).
    pub fn selectable(&self) -> bool {
        true
    }
}

/// One session's stable selection key (TS `AgentsViewSelectionKey`): a
/// row's identity flips when its session persists or re-attaches, so the
/// session ids re-find it across those transitions.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionKey {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
}

/// One recursive rollup over the record hierarchy (TS
/// `AgentsViewRecursiveRollup`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rollup {
    pub cost: f64,
    /// Every descendant subagent's spend (the running line's aggregate
    /// cost cell): each child's recursive rollup plus this record's
    /// deleted-descendant bucket. Status-independent — running, idle,
    /// and inactive descendants all bill.
    pub descendants: f64,
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
        // `descendants` starts at the deleted-descendant bucket: the
        // bucket is descendant spend, so the aggregate bills it even
        // though no live child row carries it (a nested child's own
        // bucket already rides that child's `cost`).
        let mut rollup = Rollup {
            cost: own_cost,
            descendants: deleted_descendants,
            descendant_count: 0,
        };
        for child in index.children_by_parent.get(position).into_iter().flatten() {
            if !is_subagent_descendant(&records[*child], &records[*position]) {
                continue;
            }
            rollup.cost += rollups[*child].cost;
            rollup.descendants += rollups[*child].cost;
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
    model: String,
    age: String,
    own_cost: f64,
    recursive_cost: f64,
    /// Every descendant's spend (the running line's cost cell): the
    /// rollup's descendant total, status-independent.
    descendant_cost: f64,
    descendant_count: usize,
    running_subagent_count: usize,
    /// Direct children currently roster-running: the `direct` number of
    /// the running line's `"{direct}, {nested} running"` title (the
    /// nested number is the recursive running count minus this).
    direct_running: usize,
    record: usize,
    search_score: Option<f64>,
}

/// Build the session-list rows (TS `buildAgentsViewRows`, plus the
/// operator's two-line subagent summary): top-level agents, each with its
/// running line (`d, n running`, expands to the running rows only) and,
/// when non-running children exist, its inactive line (`N inactive
/// subagents`, expands to them). `expanded_running` and
/// `expanded_inactive` hold the parent row identities whose lines are
/// open; `rollups` carries the unfiltered hierarchy totals; a scope
/// excludes its root and lifts its direct children to top-level rows.
pub fn build_rows(
    records: &[UnifiedRecord],
    scope: Option<&AgentsViewScope>,
    expanded_running: &HashSet<String>,
    expanded_inactive: &HashSet<String>,
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
            model,
            age,
            own_cost: summary
                .get("usage")
                .and_then(|usage| usage.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            recursive_cost: rollup.cost,
            descendant_cost: rollup.descendants,
            descendant_count: rollup.descendant_count,
            running_subagent_count: 0,
            direct_running: 0,
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
    // the busy tally, the descendant counts, and the cost rollups).
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
        let mut direct_running = 0;
        let mut descendants = 0;
        let mut descendants_cost = 0.0;
        for child in children_by_parent.get(index).into_iter().flatten() {
            if base[*child].section == Section::Running {
                direct_running += 1;
            }
            running += (base[*child].section == Section::Running) as usize
                + base[*child].running_subagent_count;
            descendants += 1 + base[*child].descendant_count;
            descendants_cost += base[*child].recursive_cost;
        }
        base[*index].running_subagent_count = running;
        base[*index].direct_running = direct_running;
        // Rollups follow the unfiltered hierarchy; the per-pass walk is the
        // fallback when the caller passed none (TS `rollup ?? descendants`).
        if !rollups.contains_key(&base[*index].identity) {
            base[*index].descendant_count = descendants;
            base[*index].descendant_cost = descendants_cost;
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
    let (exposed_running, exposed_inactive) = scan_flatten_exposed(
        &base,
        &children_by_parent,
        expanded_running,
        expanded_inactive,
    );
    let forest = RowForest {
        base: &base,
        children_by_parent: &children_by_parent,
        expanded_running,
        expanded_inactive,
        anchor,
    };
    let mut rows: Vec<AgentsViewRow> = Vec::new();
    let walk = EmitWalk {
        exposed_running: &exposed_running,
        exposed_inactive: &exposed_inactive,
        on_running_path: false,
    };
    for root in visible_roots {
        forest.emit(root, 0, None, &walk, &mut rows);
    }
    rows
}

/// The assembled forest one emit pass walks.
struct RowForest<'a> {
    base: &'a [BaseRow],
    children_by_parent: &'a HashMap<usize, Vec<usize>>,
    expanded_running: &'a HashSet<String>,
    expanded_inactive: &'a HashSet<String>,
    anchor: Option<&'a str>,
}

/// The per-pass state the emit walk threads: the flatten-exposure sets
/// (which ancestor's flatten already renders a line's content) and the
/// running-path flag (a row reached through a running line's expansion
/// keeps its inactive line collapsed — see `emit`). Bundling the walk
/// state keeps the walk's helpers under the too-many-arguments lint.
struct EmitWalk<'a> {
    exposed_running: &'a HashSet<String>,
    exposed_inactive: &'a HashSet<String>,
    on_running_path: bool,
}

impl EmitWalk<'_> {
    /// The variant rows under a running line's expansion walk with: the
    /// same exposure sets, flagged as on the running path.
    fn running_path(&self) -> EmitWalk<'_> {
        EmitWalk {
            exposed_running: self.exposed_running,
            exposed_inactive: self.exposed_inactive,
            on_running_path: true,
        }
    }
}

impl RowForest<'_> {
    /// Emit one row, then its summary lines, then their expanded children
    /// (TS `emit`, plus the operator's running/inactive split): depth and
    /// parent identity come from the walk. Each line expands to its own
    /// status only — the running line to the running rows (flattened
    /// through non-running children so nested workers stay reachable),
    /// the inactive line to the not-running rows (flattened the mirror
    /// way through running children) — and a line whose content an
    /// ancestor's flatten already exposes does not render, so every
    /// agent keeps exactly one visible row however many lines are open.
    /// The walk's `on_running_path` flag marks rows reached through a
    /// running line's expansion: their inactive line keeps rendering its
    /// collapsed row but never EXPANDS there — the operator's rule that
    /// the running expansion carries running rows only holds even when a
    /// child's inactive line is open elsewhere (the inactive rows stay
    /// reachable through the parent's own inactive line). The inactive
    /// expansion keeps the mirror reachability on purpose: a child's
    /// running line opened from within the parent's inactive view
    /// reveals its live worker (the nested toggle is the one visible
    /// path while the parent's running line is collapsed).
    fn emit(
        &self,
        index: usize,
        depth: usize,
        parent_identity: Option<&str>,
        walk: &EmitWalk,
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
        let mut sorted = children.clone();
        sorted.sort_by(|a, b| compare_base(&self.base[*a], &self.base[*b], self.anchor));
        let (running_kids, other_kids): (Vec<usize>, Vec<usize>) = sorted
            .iter()
            .copied()
            .partition(|child| self.base[*child].section == Section::Running);
        if row.running_subagent_count > 0 && !walk.exposed_running.contains(&row.identity) {
            let is_expanded = self.expanded_running.contains(&row.identity);
            rows.push(running_summary_row(row, depth + 1, is_expanded));
            if is_expanded {
                let inner = walk.running_path();
                for child in &running_kids {
                    self.emit(*child, depth + 1, Some(&row.identity), &inner, rows);
                }
                for child in &other_kids {
                    if self.base[*child].running_subagent_count > 0 {
                        self.emit_running_descendants(
                            *child,
                            depth + 1,
                            Some(&row.identity),
                            &inner,
                            rows,
                        );
                    }
                }
            }
        }
        let inactive = row
            .descendant_count
            .saturating_sub(row.running_subagent_count);
        if inactive > 0 && !walk.exposed_inactive.contains(&row.identity) {
            let is_expanded =
                !walk.on_running_path && self.expanded_inactive.contains(&row.identity);
            rows.push(inactive_summary_row(row, depth + 1, is_expanded));
            if is_expanded {
                for child in &other_kids {
                    self.emit(*child, depth + 1, Some(&row.identity), walk, rows);
                }
                for child in &running_kids {
                    let child_inactive = self.base[*child]
                        .descendant_count
                        .saturating_sub(self.base[*child].running_subagent_count);
                    if child_inactive > 0 {
                        self.emit_inactive_descendants(
                            *child,
                            depth + 1,
                            Some(&row.identity),
                            walk,
                            rows,
                        );
                    }
                }
            }
        }
    }

    /// Emit the running descendants of a non-running ancestor the
    /// running path flattens through (the `0, N running` case): the
    /// ancestor itself stays hidden, its running children render at
    /// their true depth, and deeper non-running ancestors continue the
    /// same way. The ancestor is already in the pass's exposed set (the
    /// `scan_flatten_exposed` pre-pass recorded it). An explicit work
    /// stack drives the walk — one entry per flattened ancestor, never
    /// one call frame — so a deep subagent chain cannot overflow the
    /// TUI thread's stack (the LIFO pops keep the recursive pre-order:
    /// a child's own descendants render before its later siblings).
    fn emit_running_descendants(
        &self,
        index: usize,
        depth: usize,
        visible_parent: Option<&str>,
        walk: &EmitWalk,
        rows: &mut Vec<AgentsViewRow>,
    ) {
        // (ancestor, depth, is_running_child): a running child emits its
        // whole subtree in place when its task pops; a non-running
        // ancestor task walks the next level.
        let mut stack: Vec<(usize, usize, bool)> = vec![(index, depth, false)];
        while let Some((node, at_depth, is_running_child)) = stack.pop() {
            if is_running_child {
                self.emit(node, at_depth, visible_parent, walk, rows);
                continue;
            }
            let mut sorted = self
                .children_by_parent
                .get(&node)
                .cloned()
                .unwrap_or_default();
            sorted.sort_by(|a, b| compare_base(&self.base[*a], &self.base[*b], self.anchor));
            for child in sorted.into_iter().rev() {
                if self.base[child].section == Section::Running {
                    stack.push((child, at_depth + 1, true));
                } else if self.base[child].running_subagent_count > 0 {
                    stack.push((child, at_depth + 1, false));
                }
            }
        }
    }

    /// Emit the not-running descendants of a running ancestor the
    /// inactive path flattens through (the inactive line's mirror of
    /// `emit_running_descendants`): the ancestor stays hidden, its
    /// not-running children render at their true depth, and deeper
    /// running ancestors continue the same way. The ancestor is already
    /// in the pass's exposed set (the `scan_flatten_exposed`
    /// pre-pass recorded it). An explicit work stack drives the walk
    /// (the running mirror's stack rule: no call frame per flattened
    /// ancestor, LIFO pops keep the recursive pre-order).
    fn emit_inactive_descendants(
        &self,
        index: usize,
        depth: usize,
        visible_parent: Option<&str>,
        walk: &EmitWalk,
        rows: &mut Vec<AgentsViewRow>,
    ) {
        // (ancestor, depth, is_inactive_child): a not-running child emits
        // its whole subtree in place when its task pops; a running
        // ancestor task walks the next level.
        let mut stack: Vec<(usize, usize, bool)> = vec![(index, depth, false)];
        while let Some((node, at_depth, is_inactive_child)) = stack.pop() {
            if is_inactive_child {
                self.emit(node, at_depth, visible_parent, walk, rows);
                continue;
            }
            let mut sorted = self
                .children_by_parent
                .get(&node)
                .cloned()
                .unwrap_or_default();
            sorted.sort_by(|a, b| compare_base(&self.base[*a], &self.base[*b], self.anchor));
            for child in sorted.into_iter().rev() {
                let child_inactive = self.base[child]
                    .descendant_count
                    .saturating_sub(self.base[child].running_subagent_count);
                if self.base[child].section != Section::Running {
                    stack.push((child, at_depth + 1, true));
                } else if child_inactive > 0 {
                    stack.push((child, at_depth + 1, false));
                }
            }
        }
    }
}

/// Pre-compute the flatten-exposed ancestors for one pass, so the emit
/// walk's order never decides a line's visibility: an expanded running
/// line flattens through its non-running children (transitively), an
/// expanded inactive line through its running children, and the walk
/// below records every skipped ancestor. The emit's own flatten walks
/// mirror this scan exactly, so a skipped ancestor's opposite-status
/// line stays suppressed wherever it renders — one visible row per
/// agent when both lines are open.
fn scan_flatten_exposed(
    base: &[BaseRow],
    children_by_parent: &HashMap<usize, Vec<usize>>,
    expanded_running: &HashSet<String>,
    expanded_inactive: &HashSet<String>,
) -> (HashSet<String>, HashSet<String>) {
    /// The running-path scan: record the skipped non-running ancestor,
    /// then walk through its non-running children that own running
    /// descendants (running children render in full — their own lines
    /// ride the suppression sets). An explicit work stack drives the
    /// walk: the set's membership is order-free, and a deep chain never
    /// rides the call stack.
    fn scan_running(
        base: &[BaseRow],
        children_by_parent: &HashMap<usize, Vec<usize>>,
        index: usize,
        exposed_running: &mut HashSet<String>,
    ) {
        let mut stack = vec![index];
        while let Some(index) = stack.pop() {
            exposed_running.insert(base[index].identity.clone());
            for child in children_by_parent.get(&index).into_iter().flatten() {
                if base[*child].section != Section::Running
                    && base[*child].running_subagent_count > 0
                {
                    stack.push(*child);
                }
            }
        }
    }
    /// The inactive-path scan: the running-ancestor mirror (the same
    /// explicit work stack).
    fn scan_inactive(
        base: &[BaseRow],
        children_by_parent: &HashMap<usize, Vec<usize>>,
        index: usize,
        exposed_inactive: &mut HashSet<String>,
    ) {
        let mut stack = vec![index];
        while let Some(index) = stack.pop() {
            exposed_inactive.insert(base[index].identity.clone());
            for child in children_by_parent.get(&index).into_iter().flatten() {
                let child_inactive = base[*child]
                    .descendant_count
                    .saturating_sub(base[*child].running_subagent_count);
                if base[*child].section == Section::Running && child_inactive > 0 {
                    stack.push(*child);
                }
            }
        }
    }
    // Emit's path rule mirrors here: a row reached through a running
    // line's expansion never expands its own inactive line (see
    // `emit`), so a stale `expanded_inactive` entry for such a row is
    // inert — processing it would mark lines whose content never
    // renders, stranding the subtree. The inactive scan skips those
    // rows entirely.
    let on_running_path = scan_running_path_rows(base, children_by_parent, expanded_running);
    let mut exposed_running: HashSet<String> = HashSet::new();
    let mut exposed_inactive: HashSet<String> = HashSet::new();
    for index in 0..base.len() {
        if expanded_running.contains(&base[index].identity) {
            for child in children_by_parent.get(&index).into_iter().flatten() {
                if base[*child].section != Section::Running
                    && base[*child].running_subagent_count > 0
                {
                    scan_running(base, children_by_parent, *child, &mut exposed_running);
                }
            }
        }
        if expanded_inactive.contains(&base[index].identity)
            && !on_running_path.contains(&base[index].identity)
        {
            for child in children_by_parent.get(&index).into_iter().flatten() {
                let child_inactive = base[*child]
                    .descendant_count
                    .saturating_sub(base[*child].running_subagent_count);
                if base[*child].section == Section::Running && child_inactive > 0 {
                    scan_inactive(base, children_by_parent, *child, &mut exposed_inactive);
                }
            }
        }
    }
    (exposed_running, exposed_inactive)
}

/// The rows the emit walk reaches through a running line's expansion:
/// every expanded running line's running children — direct and through
/// the running flatten — recursively (a running-path row's own running
/// line still expands). `emit` never expands such a row's inactive
/// line, so the exposure scan ignores their `expanded_inactive`
/// entries. An explicit work stack drives the walk — the flatten legs
/// and the expansion recursion both ride it, never the call stack.
fn scan_running_path_rows(
    base: &[BaseRow],
    children_by_parent: &HashMap<usize, Vec<usize>>,
    expanded_running: &HashSet<String>,
) -> HashSet<String> {
    let mut on_running_path: HashSet<String> = HashSet::new();
    let mut frontier: Vec<usize> = (0..base.len())
        .filter(|index| expanded_running.contains(&base[*index].identity))
        .collect();
    while let Some(index) = frontier.pop() {
        for child in children_by_parent.get(&index).into_iter().flatten() {
            if base[*child].section == Section::Running {
                if on_running_path.insert(base[*child].identity.clone())
                    && expanded_running.contains(&base[*child].identity)
                {
                    frontier.push(*child);
                }
            } else if base[*child].running_subagent_count > 0 {
                // The running flatten: the hidden ancestor's running
                // descendants render on the running path too.
                let mut stack = vec![*child];
                while let Some(ancestor) = stack.pop() {
                    for descendant in children_by_parent.get(&ancestor).into_iter().flatten() {
                        if base[*descendant].section == Section::Running {
                            if on_running_path.insert(base[*descendant].identity.clone())
                                && expanded_running.contains(&base[*descendant].identity)
                            {
                                frontier.push(*descendant);
                            }
                        } else if base[*descendant].running_subagent_count > 0 {
                            stack.push(*descendant);
                        }
                    }
                }
            }
        }
    }
    on_running_path
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
        model: row.model.clone(),
        cost: row.recursive_cost,
        age: row.age.clone(),
        depth,
        descendant_count: row.descendant_count,
        running_subagent_count: row.running_subagent_count,
        expanded: false,
    }
}

/// The running line under one agent (the operator's 2026-09-25
/// directive, a deliberate TS divergence: TS `createSubagentSummaryRow`
/// titles one `"{n} subagents running"` line that expands to every
/// child). The title reads `"{direct}, {nested} running"` — `direct` =
/// immediately running children, `nested` = further running descendants
/// below them — and the expansion renders only running rows, flattened
/// through non-running ancestors. The title stays count-only (the
/// operator's 2026-09-26 follow-up: the model mix left this line, the
/// expanded children render their own Model column).
fn running_summary_row(parent: &BaseRow, depth: usize, expanded: bool) -> AgentsViewRow {
    let direct = parent.direct_running;
    let nested = parent.running_subagent_count.saturating_sub(direct);
    let title = format!("{direct}, {nested} running");
    summary_row(
        parent,
        depth,
        expanded,
        title,
        SUMMARY_ROW_PREFIX,
        parent.descendant_cost,
        parent.running_subagent_count,
    )
}

/// The inactive line under one agent (the operator's 2026-09-25
/// directive): the explicit home for every not-running descendant — the
/// historical agents stay discoverable here without contaminating the
/// running line's expansion. The count aggregates the whole descendant
/// tree's not-running rows (the summary count's deliberate divergence)
/// and the expansion lists the not-running children. The title stays
/// count-only (the operator's 2026-09-26 follow-up: the model mix left
/// this line too), and the line bills the same descendant-tree aggregate
/// the running line does — the aggregate must survive the state where
/// every descendant is done and the running line no longer renders.
fn inactive_summary_row(parent: &BaseRow, depth: usize, expanded: bool) -> AgentsViewRow {
    let inactive = parent
        .descendant_count
        .saturating_sub(parent.running_subagent_count);
    let title = format!(
        "{inactive} inactive {}",
        if inactive == 1 {
            "subagent"
        } else {
            "subagents"
        }
    );
    summary_row(
        parent,
        depth,
        expanded,
        title,
        INACTIVE_SUMMARY_ROW_PREFIX,
        parent.descendant_cost,
        0,
    )
}

/// One summary line's row: both lines reuse their parent's summary so
/// the open action and selection keys resolve the parent. The `cost`
/// cell is the line's aggregate — BOTH lines bill the whole descendant
/// tree (the operator's 2026-09-26 ask; the running line first, then
/// the follow-up: an all-done tree renders no running line, so the
/// inactive line bills the same total — TS `createSubagentSummaryRow`
/// pins `recursiveCost: 0` there, a deliberate divergence), and neither
/// line carries an age.
fn summary_row(
    parent: &BaseRow,
    depth: usize,
    expanded: bool,
    title: String,
    identity_prefix: &str,
    cost: f64,
    running_subagent_count: usize,
) -> AgentsViewRow {
    AgentsViewRow {
        kind: RowKind::SubagentSummary,
        section: parent.section,
        identity: format!("{identity_prefix}{}", parent.identity),
        parent_identity: Some(parent.identity.clone()),
        summary: parent.summary.clone(),
        title,
        model: String::new(),
        cost,
        age: String::new(),
        depth,
        descendant_count: 0,
        running_subagent_count,
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
/// the bounded current index, else the first selectable row. A summary
/// line identity (running or inactive) pins the fallbacks to summary
/// rows, which reuse their parent's session key.
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
    let selected_summary_row = identity.is_some_and(is_summary_row_identity);
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
mod tests;
