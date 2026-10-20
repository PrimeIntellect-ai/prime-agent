//! Enter on a persistent shell row: a shell whose session still exists opens that session with its
//! Bash panel on the shell; an orphan (its session deleted) opens the Bash list over the orphans.

use super::*;
use crate::interactive::SessionPanel;

fn shell(id: &str, command: &str, session: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "command": command, "sessionId": session, "status": "running",
        "pid": 4242, "startedAt": "2026-01-01T00:00:00+00:00", "durationMs": 12_400,
    })
}

fn enter_on_shell(mode: &mut AgentsViewMode, id: &str) {
    mode.render_frame(100, 30);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.identity == format!("shell:{id}"))
        .unwrap_or_else(|| panic!("no shell row {id:?}: {:?}", mode.rows));
    mode.handle_key("enter");
}

fn frame(mode: &mut AgentsViewMode) -> Vec<String> {
    let (lines, _) = mode.render_frame(100, 30);
    lines
        .iter()
        .map(|line| flat(line).trim_end().to_string())
        .collect()
}

#[test]
fn enter_on_a_live_sessions_shell_opens_the_session_on_its_bash_panel() {
    let mut mode = fresh_mode(vec![roster_entry("p", "idle", &parent_summary("p"))]);
    mode.apply_saved_loaded(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "p"),
        shell("s2", "sleep 600", "p"),
    ]}));
    enter_on_shell(&mut mode, "s2");
    let opened = mode.opened.as_ref().expect("the session opens");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert_eq!(
        opened.panel,
        Some(SessionPanel::Shells {
            shell_id: Some("s2".to_string())
        })
    );
    assert_eq!(opened.selected_row_identity, "shell:s2");
}

#[test]
fn enter_on_a_collapsed_subagents_shell_opens_the_subagent() {
    let mut mode = mode_with_parent_and_child();
    mode.apply_saved_loaded(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "c"),
    ]}));
    assert!(
        !mode.rows.iter().any(|row| row.kind == RowKind::Subagent),
        "the child row is collapsed"
    );
    enter_on_shell(&mut mode, "s1");
    let opened = mode.opened.as_ref().expect("the subagent opens");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
    assert_eq!(opened.expanded_ancestors, vec!["p".to_string()]);
    assert_eq!(
        opened.panel,
        Some(SessionPanel::Shells {
            shell_id: Some("s1".to_string())
        })
    );
}

#[test]
fn enter_on_a_saved_sessions_shell_resumes_the_session() {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_saved_loaded(vec![saved_catalog_row(
        "/x/old.jsonl",
        "old",
        "old session",
    )]);
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "old"),
    ]}));
    enter_on_shell(&mut mode, "s1");
    let opened = mode.opened.as_ref().expect("the saved session resumes");
    assert_eq!(
        opened.selection,
        SessionSelection::Resume(PathBuf::from("/x/old.jsonl"))
    );
    assert_eq!(
        opened.panel,
        Some(SessionPanel::Shells {
            shell_id: Some("s1".to_string())
        })
    );
}

#[test]
fn enter_on_a_shell_while_the_catalog_loads_opens_nothing() {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "unknown"),
    ]}));
    enter_on_shell(&mut mode, "s1");
    assert!(mode.opened.is_none() && mode.shell_view.is_none());
    assert_eq!(mode.status_text(), Some(ANCHOR_LOADING_HINT));
}

/// The first catalog page holds only `newer`; the store has more files after it.
fn mode_with_a_partial_catalog() -> AgentsViewMode {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/new.jsonl", "new", "newer")]);
    mode.rebuild_rows();
    mode.finish_saved_page(Some(SavedMore {
        cursor: "page-two".to_string(),
        remaining: 300,
    }));
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "older"),
    ]}));
    mode
}

#[test]
fn enter_on_a_shell_of_a_session_past_the_loaded_pages_opens_that_session() {
    let mut mode = mode_with_a_partial_catalog();
    enter_on_shell(&mut mode, "s1");
    assert!(
        mode.opened.is_none() && mode.shell_view.is_none(),
        "a partial catalog cannot prove the session deleted"
    );
    assert_eq!(
        mode.next_saved_fetch(),
        Some(("page-two".to_string(), None)),
        "the daemon walks the rest of the store"
    );
    mode.buffer_saved_stream_item(saved_catalog_row("/x/older.jsonl", "older", "older"));
    mode.flush_saved_stream();
    let opened = mode.opened.as_ref().expect("the session opens once listed");
    assert_eq!(
        opened.selection,
        SessionSelection::Resume(PathBuf::from("/x/older.jsonl"))
    );
    assert_eq!(
        opened.panel,
        Some(SessionPanel::Shells {
            shell_id: Some("s1".to_string())
        })
    );
}

#[test]
fn enter_on_a_shell_of_a_session_missing_from_the_whole_store_opens_the_orphans() {
    let mut mode = mode_with_a_partial_catalog();
    enter_on_shell(&mut mode, "s1");
    mode.upsert_saved(Vec::new());
    mode.rebuild_rows();
    mode.finish_saved_page(None);
    assert!(mode.opened.is_none());
    let text = frame(&mut mode).join("\n");
    assert!(
        text.contains("Session deleted") && text.contains("cargo watch"),
        "{text}"
    );
}

#[test]
fn enter_on_an_orphan_lists_the_orphans_with_it_selected() {
    let mut mode = fresh_mode(vec![roster_entry("p", "idle", &parent_summary("p"))]);
    mode.apply_saved_loaded(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("s1", "cargo watch", "p"),
        shell("o1", "tail -f build.log", "gone"),
        shell("o2", "sleep 600", "gone-too"),
    ]}));
    enter_on_shell(&mut mode, "o2");
    assert!(mode.opened.is_none());
    assert!(
        mode.pending_shell_action.is_none(),
        "the list opens without a detail fetch"
    );
    let lines = frame(&mut mode);
    let text = lines.join("\n");
    assert!(
        lines[1].starts_with("  Bash") && lines[1].ends_with("2 running"),
        "{text}"
    );
    assert_eq!(lines[2], "  Session deleted", "{text}");
    for column in ["Command", "Duration", "PID", "Status"] {
        assert!(lines[4].contains(column), "{text}");
    }
    let selected = lines
        .iter()
        .find(|line| line.starts_with('\u{203a}'))
        .unwrap_or_else(|| panic!("a selected row in:\n{text}"));
    assert!(selected.contains("sleep 600"), "{text}");
    assert!(
        text.contains("tail -f build.log") && !text.contains("cargo watch"),
        "only the orphans list:\n{text}"
    );
    assert!(text.contains("open"), "the list hint:\n{text}");

    mode.handle_key("enter");
    let detail = frame(&mut mode).join("\n");
    assert!(detail.contains("pid 4242"), "{detail}");
}

#[test]
fn stopping_an_orphan_keeps_its_finished_detail_until_back() {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_saved_loaded(Vec::new());
    let running = serde_json::json!({ "activities": [
        shell("o1", "tail -f build.log", "gone"),
        shell("o2", "sleep 600", "gone"),
    ]});
    mode.apply_persistent_shells(running);
    enter_on_shell(&mut mode, "o2");
    mode.handle_key("enter");
    assert!(matches!(
        mode.pending_shell_action.take(),
        Some(crate::bash_view::BashViewAction::OpenDetail { .. })
    ));
    assert!(frame(&mut mode).join("\n").contains("Cancel command"));
    mode.handle_key("enter");
    assert_eq!(
        mode.pending_shell_action.take(),
        Some(crate::bash_view::BashViewAction::Kill {
            id: "o2".to_string()
        })
    );
    let mut stopped = shell("o2", "sleep 600", "gone");
    stopped["status"] = "finished".into();
    stopped["exitCode"] = 143.into();
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("o1", "tail -f build.log", "gone"),
        stopped,
    ]}));
    let detail = frame(&mut mode).join("\n");
    assert!(
        detail.contains("sleep 600") && detail.contains("exit 143"),
        "{detail}"
    );
    assert!(!detail.contains("Cancel command"), "{detail}");

    mode.handle_key("left");
    let list = frame(&mut mode).join("\n");
    assert!(
        list.contains("1 running") && !list.contains("sleep 600"),
        "{list}"
    );
    mode.handle_key("escape");
    assert!(mode.shell_view.is_none());
    let rows = frame(&mut mode).join("\n");
    assert!(
        rows.contains("Persistent shells (1)") && !rows.contains("sleep 600"),
        "{rows}"
    );
}

#[test]
fn a_refused_stop_keeps_its_error_across_a_duration_tick() {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_saved_loaded(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("o1", "sleep 600", "gone"),
    ]}));
    enter_on_shell(&mut mode, "o1");
    mode.handle_key("enter");
    mode.pending_shell_action.take();
    mode.shell_view.as_mut().expect("the overlay").set_error(
        "Could not kill bash command: refused".to_string(),
        false,
        None,
    );
    let mut ticked = shell("o1", "sleep 600", "gone");
    ticked["durationMs"] = 14_400.into();
    mode.apply_persistent_shells(serde_json::json!({ "activities": [ticked] }));
    let text = frame(&mut mode).join("\n");
    assert!(text.contains("refused"), "{text}");
}

#[test]
fn the_orphan_overlay_follows_a_terminal_resize() {
    let mut mode = fresh_mode(Vec::new());
    mode.apply_saved_loaded(Vec::new());
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        shell("o1", "sleep 600", "gone"),
    ]}));
    enter_on_shell(&mut mode, "o1");
    mode.handle_key("enter");
    let Some(crate::bash_view::BashViewAction::OpenDetail { id, generation }) =
        mode.pending_shell_action.take()
    else {
        panic!("the detail opens")
    };
    let tail = (1..=100)
        .map(|n| format!("line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    mode.shell_view
        .as_mut()
        .expect("the overlay")
        .set_output(&id, &tail, generation);
    let (lines, _) = mode.render_frame(100, 12);
    let text = lines.iter().map(flat).collect::<Vec<_>>().join("\n");
    assert!(
        text.contains("line 100") && text.contains("Cancel command"),
        "the shrunk frame keeps the newest output and the action row:\n{text}"
    );
}
