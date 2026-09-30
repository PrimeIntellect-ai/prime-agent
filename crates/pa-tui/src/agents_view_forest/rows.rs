use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::lineage::{depth_consistent_parent, is_subagent_descendant};
use super::{
    is_subagent_summary, session_model, session_title, AgentsViewRow, AgentsViewScope, Rollup,
    RowKind, SUMMARY_ROW_PREFIX,
};
use crate::agents_view_state::{
    now_ms, relative_age, section_rank, summary_for_record, Section, UnifiedRecord,
};
use crate::subagents::{summary_identity_keys, summary_parent_keys};

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
    record: usize,
    search_score: Option<f64>,
}

/// Build the session-list rows (TS `buildAgentsViewRows`, plus the
/// operator's one-line subagent summary): top-level agents, each with
/// its ONE subagents line (`N subagents (M running)` — N = the full
/// roster, M = the running subset — expanding to the whole roster in
/// one group, running rows first). `expanded` holds the parent row
/// identities whose lines are open; `program_shown` holds the parent
/// identities whose spawn programs render inside the open list (TS
/// `programShownParents`); `rollups` carries the unfiltered hierarchy
/// totals; a scope excludes its root and lifts its direct children to
/// top-level rows.
pub(crate) fn build_rows<S: std::hash::BuildHasher + Default>(
    records: &[UnifiedRecord],
    scope: Option<&AgentsViewScope>,
    expanded: &HashSet<String, S>,
    program_shown: &HashSet<String, S>,
    rollups: &HashMap<String, Rollup, S>,
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
        let mut descendants = 0;
        let mut descendants_cost = 0.0;
        for child in children_by_parent.get(index).into_iter().flatten() {
            running += usize::from(base[*child].section == Section::Running)
                + base[*child].running_subagent_count;
            descendants += 1 + base[*child].descendant_count;
            descendants_cost += base[*child].recursive_cost;
        }
        base[*index].running_subagent_count = running;
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
    let forest = RowForest {
        base: &base,
        children_by_parent: &children_by_parent,
        expanded,
        program_shown,
        anchor,
    };
    let mut rows: Vec<AgentsViewRow> = Vec::new();
    for root in visible_roots {
        forest.emit(root, 0, None, &mut rows);
    }
    rows
}

/// The assembled forest one emit pass walks.
struct RowForest<'a, S: std::hash::BuildHasher + Default> {
    base: &'a [BaseRow],
    children_by_parent: &'a HashMap<usize, Vec<usize>>,
    expanded: &'a HashSet<String, S>,
    /// The parents whose spawn programs render inside their open list
    /// (TS `programShownParents`).
    program_shown: &'a HashSet<String, S>,
    anchor: Option<&'a str>,
}

impl<S: std::hash::BuildHasher + Default> RowForest<'_, S> {
    /// Emit one row, then its ONE summary line, then its expanded
    /// children (TS `emit`): depth and parent identity come from the
    /// walk. The line expands to the FULL roster in one group — the
    /// running children first (each carrying its own running state and
    /// its own nested line), the not-running children after — so every
    /// descendant is reachable through the nesting alone.
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
        let mut summary_row = merged_summary_row(row, depth + 1, is_expanded);
        summary_row.has_spawn_code = children
            .iter()
            .any(|child| spawn_code(&self.base[*child].summary).is_some());
        rows.push(summary_row);
        if !is_expanded {
            return;
        }
        let mut sorted = children.clone();
        sorted.sort_by(|a, b| compare_base(&self.base[*a], &self.base[*b], self.anchor));
        // One group, one order (the operator's contract): the running
        // rows first — `compare_base`'s section rank already sinks the
        // not-running rows below them — so the partition is explicit
        // rather than left to the comparator's section ordering.
        let (running_kids, other_kids): (Vec<usize>, Vec<usize>) = sorted
            .iter()
            .copied()
            .partition(|child| self.base[*child].section == Section::Running);
        let ordered: Vec<usize> = running_kids.into_iter().chain(other_kids).collect();
        // TS `groupChildrenBySpawnCode`: while the program shows, each spawn cell's
        // code renders once above the children it launched. Hidden keeps the flat
        // running-first order.
        let groups: Vec<(Option<&str>, Vec<usize>)> = if self.program_shown.contains(&row.identity)
        {
            let mut groups: Vec<(Option<&str>, Vec<usize>)> = Vec::new();
            for child in ordered {
                let code = spawn_code(&self.base[child].summary);
                match groups.iter_mut().find(|(group, _)| *group == code) {
                    Some((_, kids)) => kids.push(child),
                    None => groups.push((code, vec![child])),
                }
            }
            groups
        } else {
            vec![(None, ordered)]
        };
        for (group_index, (code, kids)) in groups.into_iter().enumerate() {
            if let Some(code) = code {
                rows.extend(spawn_code_rows(row, code, depth + 1, group_index));
            }
            for child in kids {
                self.emit(child, depth + 1, Some(&row.identity), rows);
            }
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
        model: row.model.clone(),
        cost: row.recursive_cost,
        age: row.age.clone(),
        depth,
        descendant_count: row.descendant_count,
        running_subagent_count: row.running_subagent_count,
        expanded: false,
        has_spawn_code: false,
    }
}

/// The subagents line under one agent (the operator's 2026-09-28
/// one-dropdown directive): `"{total} subagents ({running} running)"` —
/// `total` = the FULL descendant roster (running + inactive), `running`
/// = the running subset — expanding to the whole roster in one group,
/// the running rows first. TS parity: TS `createSubagentSummaryRow`
/// titles one `"{n} subagents running"` / `"{n} subagents"` line that
/// expands to every child — this is the same one-line shape with the
/// operator's both-counts label, a sanctioned divergence. The title
/// stays count-only (the expanded children render their own Model
/// column).
///
/// The line reuses its parent's summary so the open action and selection
/// keys resolve the parent. The `cost` cell is the whole descendant
/// tree's spend — the line always renders while any descendant exists,
/// so the aggregate never loses its row (TS `createSubagentSummaryRow`
/// pins `recursiveCost: 0` there, a deliberate divergence) — and the
/// line carries no age.
fn merged_summary_row(parent: &BaseRow, depth: usize, expanded: bool) -> AgentsViewRow {
    let total = parent.descendant_count;
    let running = parent.running_subagent_count;
    AgentsViewRow {
        kind: RowKind::SubagentSummary,
        section: parent.section,
        identity: format!("{SUMMARY_ROW_PREFIX}{}", parent.identity),
        parent_identity: Some(parent.identity.clone()),
        summary: parent.summary.clone(),
        title: format!("{total} subagents ({running} running)"),
        model: String::new(),
        cost: parent.descendant_cost,
        age: String::new(),
        depth,
        descendant_count: 0,
        running_subagent_count: running,
        expanded,
        has_spawn_code: false,
    }
}

/// TS `hasSpawnCode` (agents-view-state.ts:1021-1023): the summary's
/// `spawnCode` is a string with a non-blank trim. The ONE predicate —
/// and the value the program rows render, never a second read.
fn spawn_code(summary: &Value) -> Option<&str> {
    let code = summary.get("spawnCode").and_then(Value::as_str)?;
    (!code.trim().is_empty()).then_some(code)
}

/// TS `MAX_SPAWN_CODE_LINES` (agents-view-state.ts:67): the program
/// body's row cap, so a long spawn cell cannot flood the view.
const MAX_SPAWN_CODE_LINES: usize = 10;

/// TS `buildSpawnCodeRows` (agents-view-state.ts:1051-1083): one spawn
/// cell's program as read-only rows — the code's lines (trailing
/// whitespace stripped, capped, the remainder counted), wrapped in
/// blank pad rows. Each row reuses the parent's section and summary and
/// carries the code line in `title` (code rows are never selected,
/// searched, or deleted, so no separate code field exists).
fn spawn_code_rows(
    parent: &BaseRow,
    code: &str,
    depth: usize,
    group_index: usize,
) -> Vec<AgentsViewRow> {
    let make_row = |title: &str, line_index: &str| AgentsViewRow {
        kind: RowKind::Code,
        section: parent.section,
        identity: format!("code:{}:{group_index}:{line_index}", parent.identity),
        parent_identity: Some(parent.identity.clone()),
        summary: parent.summary.clone(),
        title: title.to_string(),
        model: String::new(),
        cost: 0.0,
        age: String::new(),
        depth,
        descendant_count: 0,
        running_subagent_count: 0,
        expanded: false,
        has_spawn_code: false,
    };
    // TS `spawnCode.replace(/\s+$/, "")`: strip the trailing whitespace
    // editors leave, then split the program into its lines — the cap
    // reads the first lines and counts the rest from the one iterator,
    // with no intermediate collection.
    let mut lines = code.trim_end().split('\n');
    let mut rows: Vec<AgentsViewRow> = Vec::new();
    // A blank panel line above and below pads the program into a clean
    // block (TS :1081-1082).
    rows.push(make_row("", "pad-top"));
    for (line_index, line) in lines.by_ref().take(MAX_SPAWN_CODE_LINES).enumerate() {
        rows.push(make_row(line, &line_index.to_string()));
    }
    let hidden = lines.count();
    if hidden > 0 {
        rows.push(make_row(
            &format!(
                "\u{2026} +{hidden} more {}",
                if hidden == 1 { "line" } else { "lines" }
            ),
            "more",
        ));
    }
    rows.push(make_row("", "pad-bottom"));
    rows
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
        let busy = u8::from(b.running_subagent_count > 0);
        let busy_a = u8::from(a.running_subagent_count > 0);
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
