//! The hint bar: the effective bindings, the stop-or-delete slot riding
//! the selected row, and the segments that drop.

use super::*;

#[test]
fn hints_render_the_effective_bindings() {
    // Defaults: TS `renderHints` with the stock keys, plus the
    // stop-or-delete slot the selected live row arms and the rename
    // slot the renameable agent row arms.
    let mode = mode_with_parent_and_child();
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+R rename   Space reply   Ctrl+X stop   Ctrl+N new"
    );
    // A user override moves the hint with the handler.
    let mode = mode_with_user_bindings(&[("app.agents.new", "ctrl+t")]);
    let hints = flat(&mode.render_hints(120, None));
    assert_eq!(
        hints,
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+R rename   Space reply   Ctrl+X stop   Ctrl+T new"
    );
    assert!(!hints.contains("Ctrl+N"), "the default new hint is gone");
    // An override on the delete binding moves its slot too.
    let mode = mode_with_user_bindings(&[("app.agents.delete", "ctrl+k")]);
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("Ctrl+K stop"), "{hints}");
    assert!(!hints.contains("Ctrl+X"), "{hints}");
}

/// The stop-or-delete slot rides the selected row: a live row stops,
/// a saved-only row deletes, and a row with no arming target (a
/// summary row) drops the slot instead of advertising a no-op. An
/// empty override drops it everywhere.
#[test]
fn hints_delete_slot_rides_the_selected_row() {
    // The live parent (an idle-but-live session) stops.
    let mode = mode_with_parent_and_child();
    assert!(flat(&mode.render_hints(120, None)).contains("Ctrl+X stop"));
    // A saved-only row (no live session) deletes: the Inactive
    // section's saved row, selected like the saved-arms test.
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
    // A summary row has no target: no slot, and the confirm never
    // arms there either.
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
    // An override that empties the binding drops the slot (an
    // unbound action is never advertised).
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.delete".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    assert!(
        !flat(&mode.render_hints(120, None)).contains("Ctrl+X"),
        "an unbound delete never advertises"
    );
}

/// Every bar segment drops when its action is unbound — navigate,
/// open, parent, and new follow the jump and stop-or-delete slots'
/// contract; a two-key segment keeps whichever of the pair is
/// bound.
#[test]
fn hints_drop_segments_for_unbound_actions() {
    // up/down emptied drops navigate; open emptied keeps the bound
    // confirm key alone; new emptied drops its segment.
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
    // confirm and open both emptied drops the open segment
    // entirely; the other segments keep their keys.
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.confirm".to_string(), Vec::new());
    cfg.insert("app.agents.open".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains(" open"), "{hints}");
    assert!(hints.contains("navigate"), "{hints}");
    // The scoped parent segment drops when the back binding is
    // emptied.
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.back".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    mode.scope_active = true;
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains("parent"), "{hints}");
    // A multi-key delete override names every configured key (the
    // dispatch takes the whole set).
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

/// The delete and parent slots share the handler's empty-search
/// gate: their keys are inert while a query is active, so the bar
/// drops them until the search clears.
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
    // The search cleared, the slots return.
    mode.query.clear();
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("parent"), "{hints}");
}
