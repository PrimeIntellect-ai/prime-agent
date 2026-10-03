//! The `agents_view` test harness and family index: the shared fixtures
//! every scenario family drives live here (the idle-row mode, the roster
//! and catalog builders, the parent-child, anchor, bindings, and churn
//! modes); the tests themselves sit in the family children under
//! `tests/`, each holding its scenarios byte-identical to the pre-split
//! file. Add a new family by declaring the module below and moving its
//! fixtures here only when another family drives them too.

use super::*;

mod click_surface;
mod cost_aggregates;
mod delete_stop;
mod drill_down;
mod edge_jumps;
mod entry_anchor;
mod heartbeat_badge;
mod hints_render;
mod hover_band;
mod key_bindings;
mod notices;
mod render_pulse;
mod reply;
mod running_lines;
mod saved_catalog;
mod search_selection;
mod selection_churn;

/// One idle row under test plus a holder row that keeps the selection,
/// with the given title and one model id. The cost/age
/// stay fixed so the expected rows are exact.
fn mode_with_row(title: &str, model: &str) -> (AgentsViewMode, usize) {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    let row = |title: &str| AgentsViewRow {
        section: Section::Idle,
        identity: title.to_string(),
        summary: serde_json::json!({ "sessionName": title }),
        title: title.to_string(),
        model: model.to_string(),
        host_label: None,
        cost: 0.0,
        age: "1s".to_string(),
        depth: 0,
        descendant_count: 0,
        running_subagent_count: 0,
        expanded: false,
        parent_identity: None,
        kind: RowKind::Agent,
        has_spawn_code: false,
    };
    mode.rows = vec![row("holder"), row(title)];
    (mode, 1)
}

fn flat(line: &Line) -> String {
    line.iter().map(|s| s.content.as_str()).collect()
}

/// One SGR left report: a press, a press with the motion bit (a
/// drag), or a release.
fn mouse_report(row: usize, press: bool, motion: bool) -> crate::mouse::MouseEvent {
    crate::mouse::MouseEvent {
        button: crate::mouse::BUTTON_LEFT,
        x: 3,
        y: (row + 1) as u16,
        press,
        motion,
        shift: false,
        alt: false,
        ctrl: false,
    }
}

fn roster_entry(agent: &str, status: &str, summary: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "agentId": agent, "status": status, "summary": summary })
}

fn parent_summary(id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/x/{id}.jsonl"),
        "runtimeKind": "top-level",
        "sessionName": format!("{id} name"),
        "messageCount": 2,
        "rlmDepth": 0,
    })
}

/// One saved-catalog row (TS `serializeSavedSessionInfo`'s shape): the
/// path identity, the durable id, and the display fields the filters
/// read.
fn saved_catalog_row(path: &str, id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "id": id,
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-01-01T00:00:00.000Z",
        "modified": "2024-01-01T00:00:00.000Z",
        "messageCount": 3,
        "name": name,
    })
}

fn child_summary(id: &str, parent: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
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
        "rlmDepth": 1,
    })
}

/// A mode over a live parent/child roster, no scope, fresh selection.
fn mode_with_parent_and_child() -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    mode
}

/// A fresh-open view anchored on the given session (the agents-back
/// handoff state: no carried selection, the session just left).
fn mode_with_anchor(anchor: Option<&str>, roster: Vec<serde_json::Value>) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor.map(str::to_string),
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = roster;
    mode.rebuild_rows();
    mode
}

/// A scoped view over the given roster (the family's shared fixture: the
/// scope shape the subagents summary line's open action carries; the
/// anchor names the session the agents-back handoff waits on).
fn scoped_mode(anchor: Option<&str>, roster: Vec<serde_json::Value>) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor.map(str::to_string),
        scope: Some(AgentsViewScope {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            session_name: Some("p name".to_string()),
        }),
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = roster;
    mode.rebuild_rows();
    mode
}

/// A mode over the same live parent/child roster whose user bindings
/// replace keys (TS `keybindings.json` parity, the #184 binding-test
/// pattern: an override fires, the default goes inert).
fn mode_with_user_bindings(bindings: &[(&str, &str)]) -> AgentsViewMode {
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    for (id, key) in bindings {
        cfg.insert(id.to_string(), vec![key.to_string()]);
    }
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::with_user_bindings(cfg),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    mode
}

fn fresh_mode(roster: Vec<serde_json::Value>) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = roster;
    mode.rebuild_rows();
    mode
}

// -----------------------------------------------------------------------
// Remote mesh row guards (TS #2516): a tailnet peer's row is read-only
// context on this machine; every local action refuses and names the
// machine that owns the session.
// -----------------------------------------------------------------------

/// A mode whose selected row is a remote mesh row.
fn mode_with_remote_row() -> AgentsViewMode {
    let (mut mode, _) = mode_with_row("remote-worker", "model-x");
    let remote = serde_json::json!({
        "sessionName": "remote-worker",
        "remoteHost": "milk.tailnet.ts.net",
        "activeSessionId": "r1-live",
        "sessionFile": "/remote/r1.jsonl",
    });
    mode.rows[1].summary = remote;
    mode
}

/// Opening (attach/resume) a remote row refuses with the machine (TS
/// #2516's open guard: attaching across the mesh is not available).
#[test]
fn opening_a_remote_row_refuses_with_the_machine() {
    let mut mode = mode_with_remote_row();
    mode.selected = 1;
    mode.open_selected();
    let status = mode.status_text().expect("the open must refuse");
    assert!(
        status.contains("Remote agent runs on milk.tailnet.ts.net"),
        "{status}"
    );
    assert!(
        status.contains("attaching across the mesh is not available"),
        "{status}"
    );
    assert!(mode.opened.is_none(), "no attach or resume may start");
}

/// Renaming a remote row refuses with the machine (TS #2516's rename
/// guard: rename it on that machine).
#[test]
fn renaming_a_remote_row_refuses_with_the_machine() {
    let mut mode = mode_with_remote_row();
    mode.selected = 1;
    mode.enter_rename_mode();
    let status = mode.status_text().expect("the rename must refuse");
    assert!(
        status.contains("Remote agent runs on milk.tailnet.ts.net"),
        "{status}"
    );
    assert!(status.contains("rename it on that machine"), "{status}");
}

/// The delete arm's guard refuses with the machine (TS #2516's
/// stop-or-delete guard).
#[test]
fn deleting_a_remote_row_refuses_with_the_machine() {
    let mut mode = mode_with_remote_row();
    mode.selected = 1;
    assert!(mode.guard_remote_row("stop or delete"));
    let status = mode.status_text().expect("the delete must refuse");
    assert!(
        status.contains("Remote agent runs on milk.tailnet.ts.net"),
        "{status}"
    );
    assert!(
        status.contains("stop or delete it on that machine"),
        "{status}"
    );
}

/// The reply arm's guard refuses with the machine (TS #2516: replies
/// steer or resume through the local daemon, so the composer cannot
/// deliver for a tailnet peer's row).
#[test]
fn replying_to_a_remote_row_refuses_with_the_machine() {
    let mut mode = mode_with_remote_row();
    mode.selected = 1;
    mode.toggle_reply();
    let status = mode.status_text().expect("the reply must refuse");
    assert!(
        status.contains("Remote agent runs on milk.tailnet.ts.net"),
        "{status}"
    );
    assert!(status.contains("reply to it on that machine"), "{status}");
    assert!(
        !matches!(mode.composer, super::Composer::Reply(_)),
        "no reply composer may arm on a remote row"
    );
}
