use super::*;

fn cfg(entries: &[(&str, &[&str])]) -> KeybindingsConfig {
    entries
        .iter()
        .map(|(id, keys)| {
            (
                id.to_string(),
                keys.iter().map(ToString::to_string).collect::<Vec<_>>(),
            )
        })
        .collect()
}

#[test]
fn defaults_match_ts() {
    let kb = KeybindingsManager::new();
    assert!(kb.matches("ctrl+o", "app.tools.expand"));
    assert!(kb.matches("escape", "app.input.clear"));
    assert!(kb.matches("ctrl+shift+down", "tui.viewport.follow"));
    assert!(kb.matches("shift+alt+up", "tui.viewport.top"));
    assert!(kb.matches("ctrl+w", "tui.editor.deleteWordBackward"));
    assert!(kb.matches("alt+backspace", "tui.editor.deleteWordBackward"));
    assert!(kb.matches("ctrl+-", "tui.editor.undo"));
    assert!(kb.matches("shift+enter", "tui.input.newLine"));
    assert!(!kb.matches("ctrl+o", "app.clear"));
}

#[test]
fn user_rebind_supersedes_scope_default() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &["ctrl+e"])]));
    assert!(kb.matches("ctrl+e", "app.tools.expand"));
    // ctrl+e is also editor cursorLineEnd default in the same scope:
    // claimed => removed there.
    assert!(!kb.matches("ctrl+e", "tui.editor.cursorLineEnd"));
    assert!(kb.matches("end", "tui.editor.cursorLineEnd"));
}

#[test]
fn keeps_shared_defaults_when_user_binding_repeats_own_default() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[(
        "tui.input.submit",
        &["enter", "ctrl+enter"],
    )]));
    assert_eq!(
        kb.get_keys("tui.input.submit"),
        vec!["enter".to_string(), "ctrl+enter".to_string()]
    );
    assert_eq!(kb.get_keys("tui.select.confirm"), vec!["enter".to_string()]);
}

#[test]
fn keeps_shared_cursor_defaults_when_user_binding_repeats_own_default() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[("tui.select.up", &["up", "ctrl+p"])]));
    assert_eq!(
        kb.get_keys("tui.select.up"),
        vec!["up".to_string(), "ctrl+p".to_string()]
    );
    assert_eq!(kb.get_keys("tui.editor.cursorUp"), vec!["up".to_string()]);
}

#[test]
fn evicts_defaults_claimed_as_added_user_binding() {
    let kb =
        KeybindingsManager::with_user_bindings(cfg(&[("tui.editor.cursorUp", &["up", "ctrl+b"])]));
    assert_eq!(
        kb.get_keys("tui.editor.cursorUp"),
        vec!["up".to_string(), "ctrl+b".to_string()]
    );
    // cursorLeft loses its ctrl+b default (same editor scope, added claim).
    assert_eq!(
        kb.get_keys("tui.editor.cursorLeft"),
        vec!["left".to_string()]
    );
}

#[test]
fn reports_direct_user_binding_conflicts() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[
        ("tui.input.submit", &["ctrl+x"]),
        ("tui.select.confirm", &["ctrl+x"]),
    ]));
    // TS preserves the config's insertion order; the Rust config store
    // is a BTreeMap, so the claimants list is deterministic by binding
    // id ("tui.input.submit" sorts first, the TS config order too).
    assert_eq!(
        kb.get_conflicts(),
        &[KeybindingConflict {
            key: "ctrl+x".to_string(),
            keybindings: vec![
                "tui.input.submit".to_string(),
                "tui.select.confirm".to_string(),
            ],
        }]
    );
    assert_eq!(
        kb.get_keys("tui.editor.cursorLeft"),
        vec!["left".to_string(), "ctrl+b".to_string()]
    );
}

#[test]
fn reports_conflicts_when_explicit_binding_restates_default() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[
        ("tui.editor.cursorUp", &["up", "ctrl+b"]),
        ("tui.editor.cursorLeft", &["left", "ctrl+b"]),
    ]));
    assert_eq!(
        kb.get_conflicts(),
        &[KeybindingConflict {
            key: "ctrl+b".to_string(),
            keybindings: vec![
                "tui.editor.cursorLeft".to_string(),
                "tui.editor.cursorUp".to_string(),
            ],
        }]
    );
    assert_eq!(
        kb.get_keys("tui.editor.cursorUp"),
        vec!["up".to_string(), "ctrl+b".to_string()]
    );
    assert_eq!(
        kb.get_keys("tui.editor.cursorLeft"),
        vec!["left".to_string(), "ctrl+b".to_string()]
    );
}

#[test]
fn dedupes_user_binding_keys() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[(
        "tui.input.submit",
        &["enter", "enter", "ctrl+enter"],
    )]));
    assert_eq!(
        kb.get_keys("tui.input.submit"),
        vec!["enter".to_string(), "ctrl+enter".to_string()]
    );
}

#[test]
fn empty_user_array_disables_binding() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &[])]));
    assert!(kb.get_keys("app.tools.expand").is_empty());
    assert!(!kb.matches("ctrl+o", "app.tools.expand"));
}

#[test]
fn unknown_user_ids_stay_but_never_resolve() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[("not.a.binding", &["ctrl+q"])]));
    assert_eq!(
        kb.get_user_bindings().get("not.a.binding").unwrap(),
        &["ctrl+q".to_string()]
    );
    assert!(kb.get_keys("not.a.binding").is_empty());
    // The unknown claim frees nothing (no definition owns it).
    assert_eq!(
        kb.get_keys("tui.editor.cursorLineStart"),
        vec![
            "home".to_string(),
            "ctrl+a".to_string(),
            "super+left".to_string()
        ]
    );
}

/// The prompt-editor-keybinds additions (documented divergence from
/// the TS table): redo, the selection families, the doc/paragraph
/// jumps, cut/copy, and transpose resolve with their defaults, and a
/// user override replaces them like any other binding.
#[test]
fn editor_keybind_parity_defaults_resolve() {
    let kb = KeybindingsManager::new();
    assert!(kb.matches("ctrl+shift+z", "tui.editor.redo"));
    assert!(kb.matches("shift+left", "tui.editor.selectLeft"));
    assert!(kb.matches("shift+down", "tui.editor.selectDown"));
    assert!(kb.matches("shift+alt+right", "tui.editor.selectWordRight"));
    assert!(kb.matches("shift+end", "tui.editor.selectLineEnd"));
    assert!(kb.matches("shift+alt+down", "tui.editor.selectParagraphDown"));
    // `shift+ctrl+down` is the viewport-follow key: it must not also
    // claim the editor's paragraph-select (the session dispatch owns
    // it first, so binding both would make the editor default dead).
    assert!(!kb.matches("shift+ctrl+down", "tui.editor.selectParagraphDown"));
    assert!(kb.matches("ctrl+t", "tui.editor.transposeChars"));
    assert!(kb.matches("ctrl+x", "tui.editor.cutSelection"));
    assert!(kb.matches("ctrl+shift+c", "tui.editor.copySelection"));
    assert!(kb.matches("ctrl+home", "tui.editor.cursorDocStart"));
    assert!(kb.matches("ctrl+end", "tui.editor.cursorDocEnd"));
    assert!(kb.matches("super+home", "tui.editor.cursorDocStart"));
    assert!(kb.matches("super+end", "tui.editor.cursorDocEnd"));
    // A user rebind replaces the default set.
    let rebound = KeybindingsManager::with_user_bindings(cfg(&[("tui.editor.redo", &["ctrl+r"])]));
    assert!(rebound.matches("ctrl+r", "tui.editor.redo"));
    assert!(!rebound.matches("ctrl+shift+z", "tui.editor.redo"));
}

/// The list-edge jump defaults (the operator's top/bottom
/// navigation): home/end and their ctrl/super variants select the
/// first/last row. The agents view handles them; home/end stay line
/// motion for every editor-scope consumer.
#[test]
fn list_edge_jump_defaults_resolve() {
    let kb = KeybindingsManager::new();
    for key in ["home", "ctrl+home", "super+home", "super+up"] {
        assert!(
            kb.matches(key, "tui.select.top"),
            "{key} selects the first row"
        );
    }
    for key in ["end", "ctrl+end", "super+end", "super+down"] {
        assert!(
            kb.matches(key, "tui.select.bottom"),
            "{key} selects the last row"
        );
    }
    assert!(kb.matches("home", "tui.editor.cursorLineStart"));
    assert!(kb.matches("end", "tui.editor.cursorLineEnd"));
}

/// The heartbeats shortcut is gone (the operator's 2026-09-24
/// directive: "Remove the shortcut of ctrl+r for heartbeats btw"):
/// ctrl+r binds nothing by default (the /heartbeats command and the
/// activity dock's heartbeats group own the open paths), and the
/// rebind-freeing test no longer keeps an app-scope claim for it.
#[test]
fn ctrl_r_is_unbound_by_default() {
    let kb = KeybindingsManager::new();
    assert!(kb.get_keys("app.heartbeats.open").is_empty());
    assert!(!kb.matches("ctrl+r", "app.heartbeats.open"));
}

#[test]
fn matching_is_case_and_order_insensitive() {
    let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &["Ctrl+O"])]));
    assert!(kb.matches("ctrl+o", "app.tools.expand"));
    // A ctrl+shift binding matches the event id with shift first.
    assert!(kb.matches("shift+ctrl+down", "tui.viewport.follow"));
    // "esc" and "escape" name the same key (TS matchesKey).
    assert!(kb.matches("esc", "tui.select.cancel"));
    assert!(kb.matches("escape", "tui.select.cancel"));
    // An empty or trailing-modifier id never matches.
    assert!(!kb.matches("", "app.tools.expand"));
    assert!(!kb.matches("ctrl+", "app.tools.expand"));
}

#[test]
fn migrate_renames_legacy_ids_and_orders() {
    let mut raw = serde_json::Map::new();
    raw.insert("expandTools".to_string(), serde_json::json!("ctrl+x"));
    raw.insert("cursorUp".to_string(), serde_json::json!(["up", "ctrl+p"]));
    raw.insert(
        "app.message.dequeue".to_string(),
        serde_json::json!("alt+u"),
    );
    let (config, migrated) = migrate_keybindings_config(&raw);
    assert!(migrated);
    // Definition order first (the ordered config carries it).
    let keys: Vec<&str> = config.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "tui.editor.cursorUp",
            "app.tools.expand",
            "app.message.navigateOlder",
        ]
    );
    let by_id = |id: &str| {
        config
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, value)| value.clone())
            .unwrap()
    };
    assert_eq!(
        by_id("tui.editor.cursorUp"),
        serde_json::json!(["up", "ctrl+p"])
    );
    assert_eq!(by_id("app.tools.expand"), serde_json::json!("ctrl+x"));
}

#[test]
fn migrate_keeps_current_name_when_both_exist() {
    let mut raw = serde_json::Map::new();
    raw.insert("expandTools".to_string(), serde_json::json!("ctrl+x"));
    raw.insert("app.tools.expand".to_string(), serde_json::json!("ctrl+y"));
    let (config, migrated) = migrate_keybindings_config(&raw);
    assert!(migrated);
    assert_eq!(
        config,
        vec![("app.tools.expand".to_string(), serde_json::json!("ctrl+y"))]
    );
}

#[test]
fn load_migrates_legacy_names_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let mut raw = serde_json::Map::new();
    raw.insert("selectConfirm".to_string(), serde_json::json!("enter"));
    raw.insert("interrupt".to_string(), serde_json::json!("ctrl+x"));
    std::fs::write(
        dir.path().join("keybindings.json"),
        serde_json::to_string(&serde_json::Value::Object(raw)).unwrap(),
    )
    .unwrap();
    let kb = KeybindingsManager::create(dir.path());
    assert_eq!(
        kb.get_user_bindings()["tui.select.confirm"],
        vec!["enter".to_string()]
    );
    assert_eq!(
        kb.get_user_bindings()["app.interrupt"],
        vec!["ctrl+x".to_string()]
    );
    assert!(kb.matches("enter", "tui.select.confirm"));
    assert!(kb.matches("ctrl+x", "app.interrupt"));
}

#[test]
fn load_drops_malformed_values() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("keybindings.json"),
        r#"{
  "app.tools.expand": ["ctrl+o", "alt+o"],
  "app.model.select": 5,
  "app.exit": ["ctrl+d", 3],
  "tui.input.submit": "enter",
  "app.interrupt": []
}"#,
    )
    .unwrap();
    let kb = KeybindingsManager::create(dir.path());
    // Well-formed single + array values load.
    assert_eq!(
        kb.get_user_bindings()["tui.input.submit"],
        vec!["enter".to_string()]
    );
    assert_eq!(
        kb.get_user_bindings()["app.tools.expand"],
        vec!["ctrl+o".to_string(), "alt+o".to_string()]
    );
    // A number and a mixed array drop.
    assert!(!kb.get_user_bindings().contains_key("app.model.select"));
    assert!(!kb.get_user_bindings().contains_key("app.exit"));
    // An empty array is a binding disable, not malformed.
    assert!(kb.get_user_bindings().contains_key("app.interrupt"));
    assert!(kb.get_keys("app.interrupt").is_empty());
}

#[test]
fn missing_or_malformed_file_loads_defaults() {
    let empty = tempfile::tempdir().unwrap();
    let kb = KeybindingsManager::create(empty.path());
    assert!(kb.get_user_bindings().is_empty());
    assert!(kb.matches("ctrl+o", "app.tools.expand"));

    let malformed = tempfile::tempdir().unwrap();
    std::fs::write(malformed.path().join("keybindings.json"), "not json").unwrap();
    let kb = KeybindingsManager::create(malformed.path());
    assert!(kb.get_user_bindings().is_empty());

    let array = tempfile::tempdir().unwrap();
    std::fs::write(
        array.path().join("keybindings.json"),
        r#"["app.tools.expand"]"#,
    )
    .unwrap();
    let kb = KeybindingsManager::create(array.path());
    assert!(kb.get_user_bindings().is_empty());
}

#[test]
fn reload_picks_up_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("keybindings.json"),
        r#"{"app.tools.expand": "ctrl+e"}"#,
    )
    .unwrap();
    let mut kb = KeybindingsManager::create(dir.path());
    assert!(kb.matches("ctrl+e", "app.tools.expand"));
    assert!(!kb.matches("ctrl+o", "app.tools.expand"));
    std::fs::write(
        dir.path().join("keybindings.json"),
        r#"{"app.tools.expand": "ctrl+t"}"#,
    )
    .unwrap();
    kb.reload();
    assert!(kb.matches("ctrl+t", "app.tools.expand"));
    assert!(!kb.matches("ctrl+e", "app.tools.expand"));
}

#[test]
fn startup_migration_rewrites_file() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("keybindings.json");
    std::fs::write(
        &config_path,
        "{\n  \"cursorUp\": [\"up\", \"ctrl+p\"],\n  \"expandTools\": \"ctrl+x\"\n}\n",
    )
    .unwrap();
    assert!(migrate_keybindings_file(dir.path()).unwrap());
    let rewritten = std::fs::read_to_string(&config_path).unwrap();
    assert_eq!(
        rewritten,
        "{\n  \"tui.editor.cursorUp\": [\n    \"up\",\n    \"ctrl+p\"\n  ],\n  \"app.tools.expand\": \"ctrl+x\"\n}\n"
    );
    // A second run is a no-op (nothing left to migrate).
    assert!(!migrate_keybindings_file(dir.path()).unwrap());
}

#[test]
fn startup_migration_skips_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!migrate_keybindings_file(dir.path()).unwrap());
}

#[test]
fn editor_claims_free_app_defaults_in_editor_scope() {
    // TS keybindings-migration.test: explicit editor bindings win over
    // same-scope application defaults.
    let kb = KeybindingsManager::with_user_bindings(cfg(&[
        ("tui.editor.cursorUp", &["up", "ctrl+o"]),
        ("tui.editor.cursorDown", &["down", "ctrl+n"]),
    ]));
    assert_eq!(
        kb.get_keys("tui.editor.cursorUp"),
        vec!["up".to_string(), "ctrl+o".to_string()]
    );
    assert!(kb.get_keys("app.tools.expand").is_empty());
    // No scope => a claim never frees its default.
    assert_eq!(kb.get_keys("app.agents.new"), vec!["ctrl+n".to_string()]);
}

#[test]
fn effective_config_covers_every_definition() {
    let kb = KeybindingsManager::new();
    let effective = kb.get_effective_config();
    assert_eq!(
        effective.len(),
        TUI_KEYBINDINGS.len() + APP_KEYBINDINGS.len()
    );
    assert_eq!(
        effective.get("tui.viewport.follow"),
        Some(&vec!["ctrl+shift+down".to_string()])
    );
}

#[test]
fn formats_key_text() {
    assert_eq!(format_key_text("ctrl+o"), "Ctrl+O");
    assert_eq!(format_key_text("shift+alt+up"), "Shift+Alt+\u{2191}");
    assert_eq!(format_key_text("escape"), "Esc");
    assert_eq!(format_key_text("ctrl+o/alt+o"), "Ctrl+O/Alt+O");
}

#[test]
fn formats_alt_label_per_platform() {
    // TS formatKeyPart: darwin renders `alt` as `Option` (the macOS
    // keyboard row), every other platform keeps `Alt`.
    assert_eq!(
        format_key_text_on("alt+b", LabelPlatform::Macos),
        "Option+B"
    );
    assert_eq!(format_key_text_on("alt+b", LabelPlatform::Other), "Alt+B");
    assert_eq!(
        format_key_text_on("shift+alt+left", LabelPlatform::Macos),
        "Shift+Option+\u{2190}"
    );
    // Multiple bindings split by `/` keep their platform label per part,
    // and control is never relabeled as Cmd.
    assert_eq!(
        format_key_text_on("alt+o/ctrl+o", LabelPlatform::Macos),
        "Option+O/Ctrl+O"
    );
}
