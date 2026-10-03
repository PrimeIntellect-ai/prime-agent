use super::*;
use crate::agents_view_state::reconcile_unified_sessions;
use serde_json::json;
use std::collections::{HashMap, HashSet};

fn roster_entry(agent: &str, status: &str, summary: &serde_json::Value) -> serde_json::Value {
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

/// Rows for a roster with the ONE subagents line of every `expanded`
/// parent open (the merged group's expansion set).
fn rows_for(
    roster: &[serde_json::Value],
    scope: Option<&AgentsViewScope>,
    expanded: &[&str],
) -> Vec<AgentsViewRow> {
    let records = reconcile_unified_sessions(roster, &[]);
    let rollups = compute_rollups(&records);
    let expanded: HashSet<String> = expanded.iter().map(ToString::to_string).collect();
    build_rows(
        &records,
        scope,
        &expanded,
        &HashSet::default(),
        &rollups,
        None,
    )
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
        roster_entry("parent", "idle", &parent),
        roster_entry("opened", "idle", &opened),
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
        rows.iter().any(|row| {
            row.kind == RowKind::SubagentSummary && row.title == "1 subagents (0 running)"
        }),
        "the parent's ONE line labels the aggregate: {rows:?}"
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
        roster_entry("source", "idle", &source),
        roster_entry("fork", "idle", &fork),
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

/// The ONE line under a parent (the operator's 2026-09-28 merge):
/// `1 subagents (1 running)` — the full roster count first, the
/// running subset in the parenthetical — with the TS-parity
/// `subagents:` identity, expanding to the child at depth 1.
#[test]
fn parent_with_child_renders_the_summary_row_and_nested_child() {
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
    ];
    // Collapsed: the parent, its ONE summary row, nothing else.
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].kind, RowKind::Agent);
    assert_eq!(rows[1].kind, RowKind::SubagentSummary);
    assert_eq!(rows[1].identity, "subagents:file:/x/p.jsonl");
    assert_eq!(rows[1].parent_identity.as_deref(), Some("file:/x/p.jsonl"));
    assert_eq!(rows[1].title, "1 subagents (1 running)");
    assert!(!rows[1].expanded);
    assert_eq!(rows[0].descendant_count, 1);
    assert_eq!(rows[0].running_subagent_count, 1);
    // Expanded: the child nests under the ONE line at depth 1.
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].title, "1 subagents (1 running)");
    assert!(rows[1].expanded);
    assert_eq!(rows[2].kind, RowKind::Subagent);
    assert_eq!(rows[2].depth, 1);
    assert_eq!(rows[2].title, "worker one");
    assert_eq!(rows[2].parent_identity.as_deref(), Some("file:/x/p.jsonl"));
}

/// The merged group nests recursively: every child renders in place
/// (the two-line flatten-through is gone), each carrying its own ONE
/// line, and deep chains stay reachable through the nesting alone.
#[test]
fn deeper_descendants_roll_up_and_nest_recursively() {
    let mut grandchild = child_summary("gc", "c", "grandchild");
    grandchild["rlmChildId"] = json!("child-gc");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "idle", &child_summary("c", "p", "worker one")),
        roster_entry("gc", "running", &grandchild),
    ];
    // Collapsed: the parent's ONE line carries the whole subtree —
    // total 2 (the child and the grandchild), running 1 (the
    // grandchild).
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows[0].descendant_count, 2);
    assert_eq!(rows[0].running_subagent_count, 1);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].kind, RowKind::SubagentSummary);
    assert_eq!(rows[1].title, "2 subagents (1 running)");
    // Expanding the parent's line renders the child in place (never
    // flattened through), and the child's own line counts its
    // subtree: `1 subagents (1 running)`.
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
    assert_eq!(rows[3].title, "1 subagents (1 running)");
    // The nested line's parent identity is the child's own
    // parent-qualified identity (the same key the expansion set
    // carries).
    assert_eq!(rows[3].parent_identity, Some(rows[2].identity.clone()));
    // Expanding the child's line too reveals the grandchild at
    // depth 2 (a subagent row's identity is its parent-qualified
    // `agent:` alias, so the expansion keys off the rendered row).
    let child_identity = rows
        .iter()
        .find(|row| row.title == "worker one")
        .expect("the child row")
        .identity
        .clone();
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl", child_identity.as_str()]);
    // The parent, its line, the child, the child's line, the
    // grandchild.
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[4].kind, RowKind::Subagent);
    assert_eq!(rows[4].depth, 2);
    assert_eq!(rows[4].title, "grandchild");
}

/// The summary row's title is count-only (the operator's 2026-09-26
/// follow-up): the ONE line reads `"{total} subagents ({running}
/// running)"` and carries no model mix anymore — the models surface
/// on the child rows' own Model column. The tally walk still folds
/// every depth (the dynamic bound a fixed `0..len` range would
/// strand).
#[test]
fn summary_rows_stay_count_only() {
    let mut glm_one = child_summary("c1", "p", "worker one");
    glm_one["model"] = json!("internal/glm-5.3-fast");
    let mut opus = child_summary("c3", "p", "worker three");
    opus["model"] = json!("anthropic/claude-opus-4-6");
    let mut grandchild = child_summary("gc", "c3", "grandkid");
    grandchild["rlmChildId"] = json!("child-gc");
    grandchild["model"] = json!("anthropic/claude-opus-4-6");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c1", "idle", &glm_one),
        roster_entry("c2", "idle", &child_summary("c2", "p", "worker two")),
        roster_entry("c3", "idle", &opus),
        roster_entry("gc", "idle", &grandchild),
    ];
    let rows = rows_for(&roster, None, &[]);
    let summary = rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary)
        .expect("summary row");
    assert_eq!(summary.title, "4 subagents (0 running)");
    assert!(summary.model.is_empty(), "no model rides the summary row");
    // The child rows keep their own Model column entry (the expanded
    // list renders them).
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    let child = rows
        .iter()
        .find(|row| row.title == "worker one")
        .expect("child row");
    assert_eq!(child.model, "glm-5.3-fast");
    // The child's own line counts only its subtree, also count-only.
    let nested = rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary && row.depth == 2)
        .expect("nested summary row");
    assert_eq!(nested.title, "1 subagents (0 running)");
    // A FOUR-level chain folds at every depth: the great-grandchild
    // still reaches the root's count (the tally walk's dynamic
    // bound — a fixed `0..len` range would strand it out of the
    // rollup).
    let mut gc = child_summary("gc", "c", "grandkid");
    gc["rlmChildId"] = json!("child-gc");
    gc["model"] = json!("anthropic/claude-opus-4-6");
    let mut ggc = child_summary("ggc", "gc", "great-grandkid");
    ggc["rlmChildId"] = json!("child-ggc");
    ggc["model"] = json!("openai/gpt-5.6-sol");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "idle", &child_summary("c", "p", "worker one")),
        roster_entry("gc", "idle", &gc),
        roster_entry("ggc", "idle", &ggc),
    ];
    let rows = rows_for(&roster, None, &[]);
    let summary = rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary)
        .expect("summary row");
    assert_eq!(summary.title, "3 subagents (0 running)");
    assert_eq!(rows[0].descendant_count, 3);
}

/// The ONE line aggregates the whole subtree — every not-running
/// descendant counts in the total, at any depth, and the child's
/// own line keeps the same walk over its subtree.
#[test]
fn idle_descendants_aggregate_into_the_summary_row() {
    let mut grandchild = child_summary("gc", "c", "grandchild");
    grandchild["rlmChildId"] = json!("child-gc");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "idle", &child_summary("c", "p", "worker one")),
        roster_entry("gc", "idle", &grandchild),
    ];
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows[1].title, "2 subagents (0 running)");
    // The child's own line keeps the same walk: one grandchild.
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    let child_summary_row = rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary && row.depth == 2)
        .expect("child summary row");
    assert_eq!(child_summary_row.title, "1 subagents (0 running)");
}

/// A busy subtree runs at any depth: the ONE line's total and its
/// running parenthetical both count the whole tree (`2 subagents
/// (2 running)`), and the line renders alone — one group, never a
/// second per-status line.
#[test]
fn running_descendants_aggregate_into_the_summary_row() {
    let mut grandchild = child_summary("gc", "c", "grandchild");
    grandchild["rlmChildId"] = json!("child-gc");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        roster_entry("gc", "running", &grandchild),
    ];
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows.len(), 2, "ONE line, never a second per-status line");
    assert_eq!(rows[1].title, "2 subagents (2 running)");
}

/// The operator's 2026-09-28 one-dropdown contract: the ONE line
/// expands to the FULL roster in one group — a parent with six
/// running and forty inactive children reads `46 subagents (6
/// running)` and expands to all forty-six rows, the six runners
/// FIRST (with their running state), the historical workers after.
#[test]
fn the_merged_line_expands_to_the_full_roster_running_first() {
    let mut roster = vec![roster_entry("p", "idle", &parent_summary("p"))];
    for n in 1..=6 {
        roster.push(roster_entry(
            &format!("r{n}"),
            "running",
            &child_summary(&format!("r{n}"), "p", &format!("runner {n}")),
        ));
    }
    for n in 1..=40 {
        roster.push(roster_entry(
            &format!("i{n}"),
            "inactive",
            &child_summary(&format!("i{n}"), "p", &format!("old worker {n}")),
        ));
    }
    // Collapsed: the parent and its ONE line, both statuses inside.
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].kind, RowKind::SubagentSummary);
    assert_eq!(rows[1].title, "46 subagents (6 running)");
    assert!(!rows[1].expanded);
    // Enter: the whole roster renders in one group.
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    // The parent, the open line, and all forty-six children.
    assert_eq!(rows.len(), 48);
    assert!(rows[1].expanded);
    let children = &rows[2..48];
    assert!(
        children
            .iter()
            .take(6)
            .all(|row| row.kind == RowKind::Subagent && row.section == Section::Running),
        "the six runners render first, in their running state: {rows:?}"
    );
    assert!(
        children
            .iter()
            .skip(6)
            .all(|row| row.section != Section::Running),
        "the historical workers follow the runners: {rows:?}"
    );
    assert!(
        children.iter().any(|row| row.title == "old worker 40"),
        "the historical agents stay discoverable in the one group: {rows:?}"
    );
}

/// Both levels expanded on a mixed tree: every agent renders exactly
/// once — the merged group's in-place nesting is the one visible
/// path to every descendant (the operator's no-duplicates
/// safeguard).
#[test]
fn the_expanded_group_renders_each_agent_once() {
    let mut grandchild = child_summary("gc", "c2", "grandkid");
    grandchild["rlmChildId"] = json!("child-gc");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        roster_entry("c2", "idle", &child_summary("c2", "p", "worker two")),
        roster_entry("gc", "running", &grandchild),
    ];
    // A subagent row's identity is its parent-qualified `agent:`
    // alias, so the second level's expansion key comes off the
    // rendered child row.
    let first_pass = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    let worker_two = first_pass
        .iter()
        .find(|row| row.title == "worker two")
        .expect("the idle child renders in the merged group")
        .identity
        .clone();
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl", worker_two.as_str()]);
    let mut seen: HashSet<String> = HashSet::new();
    for row in &rows {
        assert!(
            seen.insert(row.identity.clone()),
            "the row {row:?} renders more than once"
        );
    }
    // The running grandchild renders through its own parent's line
    // (every descendant reachable through the nesting alone).
    assert!(
        rows.iter().any(|row| row.title == "grandkid"),
        "the running grandchild renders in place: {rows:?}"
    );
}

/// Summary-line identities pin the selection's fallbacks to the ONE
/// summary row (the `subagents:` prefix; the merged group's
/// identity scheme). A carried legacy `subagents-inactive:` identity
/// (the 2026-09-25 two-line scheme) resolves by its session key
/// onto the PARENT row — the graceful degrade for a selection
/// carried across the merge.
#[test]
fn selection_pins_the_one_summary_line_identity() {
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        roster_entry("i", "idle", &child_summary("i", "p", "old worker")),
    ];
    let collapsed = rows_for(&roster, None, &[]);
    let key = SelectionKey {
        session_id: Some("p".to_string()),
        active_session_id: Some("p-live".to_string()),
        remote_host: None,
    };
    let index = resolve_selection(&collapsed, 0, Some("subagents:file:/x/p.jsonl"), Some(&key));
    assert_eq!(collapsed[index].kind, RowKind::SubagentSummary);
    assert_eq!(collapsed[index].title, "2 subagents (1 running)");
    // The legacy inactive-line identity no longer names a row: the
    // fallback pins the selection onto the parent's own row.
    let index = resolve_selection(
        &collapsed,
        0,
        Some("subagents-inactive:file:/x/p.jsonl"),
        Some(&key),
    );
    assert_eq!(collapsed[index].kind, RowKind::Agent);
}

/// The carried selection restores onto the merged group (the
/// operator's acceptance): the `subagents:` identity re-finds the
/// ONE summary row across rebuilds, and a carried child session key
/// re-finds the child inside the expanded group.
#[test]
fn the_selection_restores_onto_the_merged_group() {
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        roster_entry("i", "idle", &child_summary("i", "p", "old worker")),
    ];
    // The user selects the ONE line while it is collapsed.
    let collapsed = rows_for(&roster, None, &[]);
    let carried = "subagents:file:/x/p.jsonl";
    let index = resolve_selection(
        &collapsed,
        0,
        Some(carried),
        Some(&SelectionKey {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            remote_host: None,
        }),
    );
    assert_eq!(collapsed[index].identity, carried);
    // The same carried identity restores after a rebuild that
    // expanded the group: the selection lands on the ONE line
    // again, now expanded.
    let expanded = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    let index = resolve_selection(
        &expanded,
        0,
        Some(carried),
        Some(&SelectionKey {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            remote_host: None,
        }),
    );
    assert_eq!(expanded[index].kind, RowKind::SubagentSummary);
    assert_eq!(expanded[index].identity, carried);
    assert!(expanded[index].expanded);
    // A carried child session key re-finds the child row inside the
    // merged group.
    let index = resolve_selection(
        &expanded,
        0,
        None,
        Some(&SelectionKey {
            session_id: Some("i".to_string()),
            active_session_id: Some("i-live".to_string()),
            remote_host: None,
        }),
    );
    assert_eq!(expanded[index].title, "old worker");
    assert_eq!(expanded[index].kind, RowKind::Subagent);
}

#[test]
fn scoped_rows_lift_direct_children_and_exclude_the_root() {
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
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
    assert_eq!(
        scope_root(&records, &scope),
        Some(ScopeRoot {
            child_depth: 1,
            session_file: Some("/x/p.jsonl".to_string()),
            cwd: None,
        })
    );
    assert!(has_session_children(
        &records,
        &SelectionKey {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            remote_host: None,
        }
    ));
}

/// A `--no-session` root's live summary publishes an empty `sessionFile`
/// (the daemon's in-memory store maps its empty path unconditionally):
/// the scope root reads it as absent, so ctrl+n falls back to a plain new
/// root session instead of binding to an empty path.
#[test]
fn a_root_with_an_empty_session_file_binds_nothing() {
    let roster = vec![roster_entry("p", "idle", &{
        let mut summary = parent_summary("p");
        summary["sessionFile"] = json!("");
        summary
    })];
    let scope = AgentsViewScope {
        session_id: Some("p".to_string()),
        active_session_id: Some("p-live".to_string()),
        session_name: None,
    };
    let records = reconcile_unified_sessions(&roster, &[]);
    assert_eq!(
        scope_root(&records, &scope),
        Some(ScopeRoot {
            child_depth: 1,
            session_file: None,
            cwd: None,
        })
    );
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
    let rows = build_rows(
        &records,
        None,
        &std::collections::HashSet::default(),
        &HashSet::default(),
        &rollups,
        None,
    );
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].kind, RowKind::Agent);
    assert_eq!(rows[0].title, "root agent");
    assert_eq!(rows[1].title, "1 subagents (0 running)");
    let expanded: HashSet<String> = [rows[0].identity.clone()].into_iter().collect();
    let rows = build_rows(
        &records,
        None,
        &expanded,
        &HashSet::default(),
        &rollups,
        None,
    );
    assert_eq!(rows[2].title, "saved child");
    assert_eq!(rows[2].kind, RowKind::Subagent);
}

#[test]
fn forked_sessions_stay_top_level() {
    let mut fork = child_summary("f", "p", "forked chat");
    fork["runtimeKind"] = json!("top-level");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("f", "idle", &fork),
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
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "idle", &child_summary("c", "p", "worker one")),
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
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
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
            remote_host: None,
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
            remote_host: None,
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
            &json!({
                "sessionId": "p", "lifecycle": "live", "activeSessionId": "p-live",
                "sessionFile": "/x/p.jsonl", "runtimeKind": "top-level",
                "messageCount": 1, "usage": { "cost": 0.5 },
            }),
        ),
        roster_entry(
            "c",
            "idle",
            &json!({
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
    assert!((parent.cost - 0.75).abs() < f64::EPSILON);
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
            &json!({
                "sessionId": "p", "lifecycle": "live", "activeSessionId": "p-live",
                "sessionFile": "/x/p.jsonl", "runtimeKind": "top-level",
                "messageCount": 1, "usage": { "cost": 0.0 },
            }),
        ),
        roster_entry(
            "c2",
            "idle",
            &json!({
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
            &json!({
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
    assert!((rows[0].cost - 0.75).abs() < f64::EPSILON);
    let empty: HashMap<String, Rollup> = HashMap::new();
    let rows = build_rows(
        &records,
        None,
        &std::collections::HashSet::default(),
        &HashSet::default(),
        &empty,
        None,
    );
    // Without rollups the per-pass walk fills the same totals.
    assert!((rows[0].cost - 0.75).abs() < f64::EPSILON);
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
    let mut orch_summary = parent_summary("orch");
    orch_summary["sessionName"] = json!("zebra worker");
    let roster = vec![
        roster_entry("orch", "running", &orch_summary),
        roster_entry(
            "kid",
            "running",
            &child_summary("kid", "orch", "policy sweep"),
        ),
        roster_entry(
            "cache",
            "idle",
            &json!({
                "sessionId": "cache",
                "lifecycle": "live",
                "sessionName": "sweep cache",
                "messageCount": 2,
            }),
        ),
        roster_entry(
            "weep",
            "idle",
            &json!({
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
    let rows = build_rows(
        &filtered,
        None,
        &expanded,
        &HashSet::default(),
        &rollups,
        None,
    );
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
            &json!({
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
            &json!({
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
    let rows = build_rows(
        &filtered,
        None,
        &std::collections::HashSet::default(),
        &HashSet::default(),
        &rollups,
        None,
    );
    assert_eq!(
        rows[0].title, "sweep beta",
        "recency breaks score ties before section grouping"
    );
    assert_eq!(rows[1].title, "sweep alpha");
}

/// The operator's 2026-09-26 ask, carried by the ONE line: the
/// summary row's Cost cell aggregates EVERY descendant subagent's
/// spend — running, idle, and inactive rows all bill — and the
/// parent row keeps the recursive total (own + descendants). The
/// merged line always renders while any descendant exists, so the
/// aggregate never loses its row.
#[test]
fn the_summary_line_bills_every_descendant_status() {
    let mut parent = parent_summary("p");
    parent["usage"] = json!({ "cost": 0.25 });
    let mut runner = child_summary("r1", "p", "runner");
    runner["usage"] = json!({ "cost": 1.25 });
    let mut grandchild = child_summary("gc", "r1", "grandkid");
    grandchild["rlmChildId"] = json!("child-gc");
    grandchild["usage"] = json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = json!({ "cost": 2.5 });
    let mut inactive_child = child_summary("x1", "p", "old worker");
    inactive_child["usage"] = json!({ "cost": 0.75 });
    let roster = vec![
        roster_entry("p", "idle", &parent),
        roster_entry("r1", "running", &runner),
        roster_entry("gc", "running", &grandchild),
        roster_entry("i1", "idle", &idle_child),
        roster_entry("x1", "inactive", &inactive_child),
    ];
    let rows = rows_for(&roster, None, &[]);
    assert!(
        (rows[0].cost - 5.0).abs() < f64::EPSILON,
        "the parent row keeps own 0.25 + descendants 4.75"
    );
    let summary = rows
        .iter()
        .find(|row| row.identity == "subagents:file:/x/p.jsonl")
        .expect("the ONE line");
    assert_eq!(summary.title, "4 subagents (2 running)");
    assert!(
        (summary.cost - 4.75).abs() < f64::EPSILON,
        "runner subtree 1.50 + idle 2.50 + inactive 0.75 — every status bills"
    );
}

/// The deleted-descendant bucket (TS #2506's
/// `deletedDescendantUsage`) is descendant spend: the ONE line
/// bills it alongside the live subtree even though no live child
/// row carries it — a deletion must not erase the money from the
/// aggregate any more than from the recursive total.
#[test]
fn the_summary_line_bills_the_deleted_descendant_bucket() {
    let deleted = json!({ "inputTokens": 100, "outputTokens": 10, "cost": 0.5 });
    let saved_parent = json!({
        "path": "/x/p.jsonl", "id": "p",
        "usage": { "inputTokens": 0, "outputTokens": 0, "cost": 0.0 },
        "deletedDescendantUsage": deleted,
    });
    let mut parent = parent_summary("p");
    parent["usage"] = json!({ "cost": 0.25 });
    let mut runner = child_summary("r1", "p", "runner");
    runner["usage"] = json!({ "cost": 0.25 });
    let roster = vec![
        roster_entry("p", "idle", &parent),
        roster_entry("r1", "running", &runner),
    ];
    let records = reconcile_unified_sessions(&roster, std::slice::from_ref(&saved_parent));
    let rollups = compute_rollups(&records);
    assert!(
        (rollups
            .get("file:/x/p.jsonl")
            .expect("parent rollup")
            .descendants
            - 0.75)
            .abs()
            < f64::EPSILON,
        "live child 0.25 + deleted bucket 0.50"
    );
    let rows = build_rows(
        &records,
        None,
        &HashSet::new(),
        &HashSet::new(),
        &rollups,
        None,
    );
    let summary = rows
        .iter()
        .find(|row| row.identity == "subagents:file:/x/p.jsonl")
        .expect("the ONE line");
    assert!((summary.cost - 0.75).abs() < f64::EPSILON);
    assert!(
        (rows[0].cost - 1.0).abs() < f64::EPSILON,
        "own 0.25 + aggregate 0.75"
    );
}

/// A tree that spends nothing bills its `$0.00` cell — the cost cell
/// is part of the row, never a value-dependent extra — and a parent
/// with no subagents renders no collapsed row to bill at all.
#[test]
fn the_summary_line_cost_is_zero_when_nothing_bills() {
    let mut grandchild = child_summary("gc", "r1", "grandkid");
    grandchild["rlmChildId"] = json!("child-gc");
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("r1", "running", &child_summary("r1", "p", "runner")),
        roster_entry("gc", "running", &grandchild),
    ];
    let rows = rows_for(&roster, None, &[]);
    let summary = rows
        .iter()
        .find(|row| row.identity == "subagents:file:/x/p.jsonl")
        .expect("the ONE line");
    assert_eq!(summary.title, "2 subagents (2 running)");
    assert!((summary.cost - 0.0).abs() < f64::EPSILON);
    // No subagents: no summary row renders — there is no collapsed
    // row to bill.
    let lone = rows_for(
        &[roster_entry("p", "idle", &parent_summary("p"))],
        None,
        &[],
    );
    assert_eq!(lone.len(), 1);
    assert_eq!(lone[0].kind, RowKind::Agent);
}

/// A nested parent's own line bills only that parent's subtree, not
/// the root's whole tree: the depth-2 line under an expanded child
/// carries the grandchild's spend alone.
#[test]
fn a_nested_line_bills_its_own_subtree() {
    let mut runner = child_summary("r1", "p", "runner");
    runner["usage"] = json!({ "cost": 1.25 });
    let mut grandchild = child_summary("gc", "r1", "grandkid");
    grandchild["rlmChildId"] = json!("child-gc");
    grandchild["usage"] = json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = json!({ "cost": 2.5 });
    let roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("r1", "running", &runner),
        roster_entry("gc", "running", &grandchild),
        roster_entry("i1", "idle", &idle_child),
    ];
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    // A subagent row's identity is its first alias (the parent-qualified
    // `agent:` id), so the line is looked up off the rendered child row —
    // the same dynamic lookup the drill-in tests use.
    let child_identity = rows
        .iter()
        .find(|row| row.title == "runner")
        .expect("the child row renders inside the expanded group")
        .identity
        .clone();
    let nested = rows
        .iter()
        .find(|row| row.identity == format!("{SUMMARY_ROW_PREFIX}{child_identity}"))
        .expect("the child's own line");
    assert_eq!(nested.title, "1 subagents (1 running)");
    assert!(
        (nested.cost - 0.25).abs() < f64::EPSILON,
        "only the grandchild's spend"
    );
    let root = rows
        .iter()
        .find(|row| row.identity == "subagents:file:/x/p.jsonl")
        .expect("the root's line");
    assert_eq!(root.title, "3 subagents (2 running)");
    assert!(
        (root.cost - 4.0).abs() < f64::EPSILON,
        "runner subtree 1.50 + idle 2.50"
    );
}

/// The operator's acceptance line: a fleet-scale roster — 331
/// inactive children plus 2 running (333 descendants) — renders ONE
/// summary row reading `333 subagents (2 running)`, and expanding
/// it renders ALL 333 in one group, the two runners first with
/// their running state, the 331 historical workers after.
#[test]
fn one_dropdown_renders_the_full_fleet_roster() {
    let mut roster = vec![roster_entry("p", "idle", &parent_summary("p"))];
    roster.push(roster_entry(
        "r1",
        "running",
        &child_summary("r1", "p", "runner one"),
    ));
    roster.push(roster_entry(
        "r2",
        "running",
        &child_summary("r2", "p", "runner two"),
    ));
    for n in 1..=331 {
        roster.push(roster_entry(
            &format!("i{n}"),
            "inactive",
            &child_summary(&format!("i{n}"), "p", &format!("old worker {n}")),
        ));
    }
    // Collapsed: the parent and its ONE line — one number pair, no
    // second per-status line.
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].kind, RowKind::SubagentSummary);
    assert_eq!(rows[1].title, "333 subagents (2 running)");
    assert_eq!(rows[1].identity, "subagents:file:/x/p.jsonl");
    assert!(!rows[1].expanded);
    // Expanded: all 333 render in one group.
    let rows = rows_for(&roster, None, &["file:/x/p.jsonl"]);
    assert_eq!(rows.len(), 335, "the parent, the line, all 333 children");
    assert!(rows[1].expanded);
    let children = &rows[2..];
    assert_eq!(children.len(), 333);
    assert_eq!(
        children
            .iter()
            .filter(|row| row.section == Section::Running)
            .count(),
        2,
        "the two runners render with their running state"
    );
    assert!(
        children
            .iter()
            .take(2)
            .all(|row| row.section == Section::Running),
        "the runners render FIRST: {children:?}"
    );
    assert!(
        children
            .iter()
            .skip(2)
            .all(|row| row.section != Section::Running),
        "the 331 historical workers follow: {children:?}"
    );
    // Every descendant renders exactly once.
    let mut seen: HashSet<String> = HashSet::new();
    for row in children {
        assert!(
            seen.insert(row.identity.clone()),
            "the row {row:?} renders more than once"
        );
    }
}

/// The selection's id fallbacks stay host-scoped (TS #2516's review fix):
/// a local session that reuses a remote row's ids can never take that
/// row's selection, and a remote key never lands on the local copy.
#[test]
fn selection_fallbacks_stay_host_scoped() {
    let remote_summary = json!({
        "id": "shared-1",
        "sessionId": "shared-1",
        "activeSessionId": "shared-1-live",
        "lifecycle": "live",
        "runtimeKind": "top-level",
        "rlmDepth": 0,
        "cwd": "/remote",
        "remoteHost": "milk.tailnet.ts.net",
        "messageCount": 2,
    });
    let local_summary = json!({
        "id": "shared-1",
        "sessionId": "shared-1",
        "activeSessionId": "shared-1-live",
        "lifecycle": "live",
        "runtimeKind": "top-level",
        "rlmDepth": 0,
        "cwd": "/local",
        "sessionFile": "/local/shared-1.jsonl",
        "messageCount": 2,
    });
    let roster = vec![
        roster_entry(
            "remote:milk.tailnet.ts.net#shared-1",
            "running",
            &remote_summary,
        ),
        roster_entry("shared-1", "idle", &local_summary),
    ];
    let rows = rows_for(&roster, None, &[]);
    assert_eq!(rows.len(), 2, "both rows render");
    // A remote-keyed selection restores onto the REMOTE row even though
    // the local row shares every id.
    let remote_key = SelectionKey {
        session_id: Some("shared-1".to_string()),
        active_session_id: Some("shared-1-live".to_string()),
        remote_host: Some("milk.tailnet.ts.net".to_string()),
    };
    let index = resolve_selection(&rows, 0, None, Some(&remote_key));
    assert!(
        rows[index].summary.get("remoteHost").is_some(),
        "the remote key takes the remote row, not the local copy"
    );
    // A local-keyed selection restores onto the LOCAL row.
    let local_key = SelectionKey {
        session_id: Some("shared-1".to_string()),
        active_session_id: Some("shared-1-live".to_string()),
        remote_host: None,
    };
    let index = resolve_selection(&rows, 0, None, Some(&local_key));
    assert!(
        rows[index].summary.get("remoteHost").is_none(),
        "the local key takes the local row, not the remote copy"
    );
}
