//! The hint bar: the effective bindings, the stop-or-delete slot riding
//! the selected row, and the segments that drop.

use super::*;

#[test]
fn hints_render_the_effective_bindings() {
    let mode = mode_with_parent_and_child();
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+R rename   Space reply   Ctrl+X stop   Ctrl+N new"
    );
    let mode = mode_with_user_bindings(&[("app.agents.new", "ctrl+t")]);
    let hints = flat(&mode.render_hints(120, None));
    assert_eq!(
        hints,
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+R rename   Space reply   Ctrl+X stop   Ctrl+T new"
    );
    assert!(!hints.contains("Ctrl+N"), "the default new hint is gone");
    let mode = mode_with_user_bindings(&[("app.agents.delete", "ctrl+k")]);
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("Ctrl+K stop"), "{hints}");
    assert!(!hints.contains("Ctrl+X"), "{hints}");
}

/// The stop-or-delete slot rides the selected row: a live row stops, a saved-only row deletes,
/// and a row with no arming target (a summary row) drops the slot instead of a no-op.
#[test]
fn hints_delete_slot_rides_the_selected_row() {
    let mode = mode_with_parent_and_child();
    assert!(flat(&mode.render_hints(120, None)).contains("Ctrl+X stop"));
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![saved_catalog_row("/x/a.jsonl", "a", "a saved session")];
    mode.rebuild_rows();
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.identity.contains("a.jsonl"))
        .expect("the saved row");
    assert!(
        flat(&mode.render_hints(120, None)).contains("Ctrl+X delete"),
        "the saved-only row deletes"
    );
    let mut mode = mode_with_parent_and_child();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.kind == RowKind::SubagentSummary)
        .expect("the summary row");
    assert!(
        !flat(&mode.render_hints(120, None)).contains("Ctrl+X"),
        "the summary row carries no delete slot"
    );
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.delete".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    assert!(
        !flat(&mode.render_hints(120, None)).contains("Ctrl+X"),
        "an unbound delete never advertises"
    );
}

/// Every bar segment drops when its action is unbound; a two-key segment keeps whichever of
/// the pair is bound.
#[test]
fn hints_drop_segments_for_unbound_actions() {
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.up".to_string(), Vec::new());
    cfg.insert("tui.select.down".to_string(), Vec::new());
    cfg.insert("app.agents.open".to_string(), Vec::new());
    cfg.insert("app.agents.new".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains("navigate"), "{hints}");
    assert!(hints.contains("Enter open"), "{hints}");
    assert!(!hints.contains("Enter/\u{2192}"), "{hints}");
    assert!(!hints.contains("new"), "{hints}");
    assert!(hints.contains("Ctrl+X stop"), "{hints}");
    assert!(hints.contains("Home/End first/last"), "{hints}");
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.confirm".to_string(), Vec::new());
    cfg.insert("app.agents.open".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains(" open"), "{hints}");
    assert!(hints.contains("navigate"), "{hints}");
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.back".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    mode.scope_active = true;
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains("parent"), "{hints}");
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert(
        "app.agents.delete".to_string(),
        vec!["ctrl+x".to_string(), "ctrl+d".to_string()],
    );
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("Ctrl+X/Ctrl+D stop"), "{hints}");
}

/// The delete and parent slots share the handler's empty-search gate: their keys are inert
/// while a query is active, so the bar drops them until the search clears.
#[test]
fn hints_drop_the_query_gated_actions_while_searching() {
    let mut mode = mode_with_parent_and_child();
    mode.query = "p".to_string();
    let hints = flat(&mode.render_hints(120, None));
    assert!(
        !hints.contains("Ctrl+X"),
        "the delete slot drops during a search: {hints}"
    );
    let mut mode = mode_with_parent_and_child();
    mode.scope_active = true;
    mode.query = "p".to_string();
    let hints = flat(&mode.render_hints(120, None));
    assert!(
        !hints.contains("parent"),
        "the parent slot drops during a search: {hints}"
    );
    mode.query.clear();
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("parent"), "{hints}");
}
