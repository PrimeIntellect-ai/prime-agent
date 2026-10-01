use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{is_subagent_summary, AgentsViewScope, Rollup, SelectionKey};
use crate::agents_view_state::{summary_for_record, UnifiedRecord};
use crate::subagents::summary_parent_keys;

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
pub(super) fn depth_consistent_parent(daemon: &Value, parent: &UnifiedRecord) -> bool {
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
pub(super) fn is_subagent_descendant(child: &UnifiedRecord, parent: &UnifiedRecord) -> bool {
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
        // Option would drop with it. The roster row (daemon) is the
        // fresher writer between the two — the same `daemon ?? saved`
        // precedence as the own cost below — so the title (roster rows
        // only) and the agents view bill the same bucket.
        let deleted_descendants = records[*position]
            .daemon
            .as_ref()
            .and_then(|daemon| daemon.get("deletedDescendantUsage"))
            .and_then(|deleted| deleted.get("cost"))
            .and_then(Value::as_f64)
            .or_else(|| {
                records[*position]
                    .saved
                    .as_ref()
                    .and_then(|saved| saved.get("deletedDescendantUsage"))
                    .and_then(|deleted| deleted.get("cost"))
                    .and_then(Value::as_f64)
            })
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
#[must_use]
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
#[must_use]
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
#[must_use]
pub fn scope_depth(records: &[UnifiedRecord], scope: &AgentsViewScope) -> Option<u32> {
    scope_root_index(records, scope).map(|root| {
        summary_for_record(&records[root])
            .get("rlmDepth")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
            + 1
    })
}
