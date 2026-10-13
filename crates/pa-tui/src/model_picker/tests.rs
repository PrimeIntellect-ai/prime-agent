use super::*;
use crate::keybindings::KeybindingsManager;
use crate::theme::{ColorMode, Theme};

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

/// One catalog model with explicit cost and an optional thinking map.
fn model(provider: &str, id: &str, name: &str, reasoning: bool, map: Option<&str>) -> Model {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": name, "api": "openai-completions", "provider": provider,
        "baseUrl": "https://example.invalid/v1", "reasoning": reasoning,
        "thinkingLevelMap": map.map(|m| serde_json::from_str::<serde_json::Value>(m).unwrap()),
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .expect("mock model deserializes")
}

/// The fable map: low..max on, off/minimal off.
fn fable_map() -> &'static str {
    r#"{"off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max"}"#
}

/// A reasoning model whose only on-level is high.
fn high_only_map() -> &'static str {
    r#"{"minimal": null, "low": null, "medium": null, "high": "high", "xhigh": null, "max": null}"#
}

/// The 4.6 map: low..max on except xhigh.
fn opus_map() -> &'static str {
    r#"{"minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": "max"}"#
}

/// A battery-shaped catalog: the mock-1 current model plus the featured Claude ladder.
fn battery_catalog() -> Vec<Model> {
    vec![
        model("prime-inference", "mock-1", "Mock 1", false, None),
        model(
            "prime-inference",
            "anthropic/claude-fable-5",
            "Claude Fable 5",
            true,
            Some(fable_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-haiku-4.5",
            "Claude Haiku 4.5",
            true,
            Some(high_only_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4.6",
            "Claude Opus 4.6",
            true,
            Some(opus_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4.7",
            "Claude Opus 4.7",
            true,
            Some(opus_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4.8",
            "Claude Opus 4.8",
            true,
            Some(opus_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-sonnet-4.5",
            "Claude Sonnet 4.5",
            true,
            Some(high_only_map()),
        ),
        model(
            "prime-inference",
            "anthropic/claude-sonnet-4.6",
            "Claude Sonnet 4.6",
            true,
            Some(opus_map()),
        ),
        model(
            "prime-inference",
            "deepseek/deepseek-v4",
            "Deepseek V4",
            false,
            None,
        ),
    ]
}

fn current() -> CurrentModel {
    CurrentModel {
        provider: "prime-inference".to_string(),
        model_id: "mock-1".to_string(),
    }
}

fn configured() -> HashSet<String> {
    ["prime-inference".to_string()].into_iter().collect()
}

fn picker_options(catalog: Vec<Model>) -> ModelPickerOptions {
    ModelPickerOptions {
        models: catalog,
        current: Some(current()),
        configured_providers: configured(),
        recent_models: Vec::new(),
        scoped_models: Vec::new(),
        thinking_level: Some(ModelThinkingLevel::Medium),
        viewport_rows: 19,
    }
}

/// Rendered frame rows as trimmed plain text (tmux-capture shape).
fn frame_text(picker: &mut ModelPicker) -> Vec<String> {
    picker
        .render(&theme(), 120, &kb())
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .map(|row| row.trim_end().to_string())
        .collect()
}

/// The scope view: a session with scoped models opens on the scoped list, the scope row above it;
/// Alt+S swaps to the full catalog and back, and the macOS option-composed `ß` toggles too.
#[test]
fn scope_toggles_between_the_scoped_list_and_the_catalog() {
    let catalog = battery_catalog();
    let mut options = picker_options(catalog);
    options.scoped_models = [0, 3]
        .into_iter()
        .map(|index| {
            let model = &options.models[index];
            ModelPicker::model_key_provider(&model.provider, &model.id)
        })
        .collect();
    let mut picker = ModelPicker::new(options);
    assert_eq!(
        picker.filtered_len(),
        2,
        "the picker opens on the scoped list"
    );
    let rows = frame_text(&mut picker);
    // The scope row renders ABOVE the search field with one leading space (TS
    // v0.9.7, the parity run's b3 frame).
    let scope_row = rows
        .iter()
        .position(|row| row.starts_with(" Scope: all | scoped"));
    let search_row = rows
        .iter()
        .position(|row| row.contains("Search models"))
        .expect("the search field renders");
    assert!(
        scope_row.is_some_and(|scope_row| {
            scope_row < search_row && rows[scope_row].contains("Alt+S scope (all/scoped)")
        }),
        "the scope row renders above the search field with its leading space:
{}",
        rows.join("\n")
    );
    assert_eq!(
        picker.handle_key("alt+s", &kb()),
        ModelPickerAction::ScopeToggled { scoped: false },
        "alt+s swaps to the catalog side"
    );
    assert_eq!(
        picker.filtered_len(),
        9,
        "the catalog side lists everything"
    );
    assert_eq!(
        picker.handle_key("alt+s", &kb()),
        ModelPickerAction::ScopeToggled { scoped: true },
        "alt+s swaps back to the scoped side"
    );
    assert_eq!(picker.filtered_len(), 2);
    assert_eq!(
        picker.handle_key("\u{df}", &kb()),
        ModelPickerAction::ScopeToggled { scoped: false },
        "the option-composed \u{df} toggles too"
    );
    assert_eq!(picker.filtered_len(), 9);
}

/// A scope the loaded catalog cannot resolve still scopes (the scope keys off the session's list,
/// never off what the catalog resolves): the picker opens with no rows, Alt+S still works, and a
/// refresh that brings the entries fills them.
#[test]
fn a_scope_the_catalog_cannot_resolve_still_scopes() {
    let catalog = battery_catalog();
    let mut options = picker_options(catalog);
    options.scoped_models = vec!["prime-inference/mock-9".to_string()];
    let mut picker = ModelPicker::new(options);
    assert!(picker.has_scoped_models(), "the session's scope counts");
    assert_eq!(picker.filtered_len(), 0, "the scoped side has no rows yet");
    assert_eq!(
        picker.handle_key("alt+s", &kb()),
        ModelPickerAction::ScopeToggled { scoped: false },
        "alt+s still offers the catalog side"
    );
    assert_eq!(
        picker.filtered_len(),
        9,
        "the catalog side lists everything"
    );
    assert_eq!(
        picker.handle_key("alt+s", &kb()),
        ModelPickerAction::ScopeToggled { scoped: true },
        "alt+s returns to the scoped side"
    );
    let mut refreshed = battery_catalog();
    refreshed.push(model("prime-inference", "mock-9", "Mock 9", false, None));
    picker.update_state(None, refreshed, configured());
    assert_eq!(
        picker.filtered_len(),
        1,
        "the refresh resolved the key: the scoped row appears"
    );
}

/// The frame matches the TS inline menu panel row for row (the f17 model-selector capture
/// geometry): bordered search field, `›` rows with the effort cluster centered (squares at column
/// 54, label at 62), trailing flush right, scroll indicator, price detail, key hint.
#[test]
fn renders_the_ts_inline_panel_shape() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    let rows = frame_text(&mut picker);
    let border = "\u{2500}".repeat(120);
    assert_eq!(rows[0], border, "top rule");
    assert_eq!(rows[2], border, "bottom rule");
    // The search field: prompt, caret cell, dim placeholder.
    assert_eq!(rows[1], " >  Search models");
    // The current model leads, marked `current · provider`, no effort cluster
    // (no thinking surface); the trailing sits flush right.
    assert_eq!(
        rows[3],
        format!(
            "\u{203a} Mock 1{}current \u{b7} prime-inference",
            " ".repeat(87)
        )
    );
    // The effort cluster: name cell (17), centered gap (33), arrow slots,
    // squares, label cell (6), then the trailing provider.
    let effort_row = |name: &str, squares: &str, label: &str| {
        let name_pad = " ".repeat(17 - name.chars().count());
        let label_pad = " ".repeat(6 - label.chars().count());
        format!(
            "  {name}{name_pad}{}  {squares}   {label}{label_pad}{}prime-inference",
            " ".repeat(33),
            " ".repeat(37),
        )
    };
    assert_eq!(
        rows[4],
        effort_row(
            "Claude Fable 5",
            "\u{25a0}\u{25a0}\u{25a1}\u{25a1}\u{25a1}",
            "medium"
        )
    );
    assert_eq!(
        rows[5],
        effort_row("Claude Haiku 4.5", "\u{25a0}    ", "high")
    );
    assert_eq!(
        rows[6],
        effort_row(
            "Claude Opus 4.6",
            "\u{25a0}\u{25a0}\u{25a1}\u{25a1} ",
            "medium"
        )
    );
    assert_eq!(rows[11], "  (1/9)");
    assert_eq!(rows[12], "");
    assert_eq!(
        rows[13],
        format!(
            " Input{}Cached input{}Output {}$ / 1M tokens",
            " ".repeat(34 - 5),
            " ".repeat(34 - 12),
            " ".repeat(34 - 6),
        )
    );
    assert_eq!(
        rows[14],
        format!(" $0{}$0{}$0", " ".repeat(32), " ".repeat(32))
    );
    assert_eq!(rows[15], "");
    assert_eq!(
        rows[16],
        " \u{2191}/\u{2193} model \u{b7} \u{2190}/\u{2192} effort \u{b7} Enter select \u{b7} Esc close"
    );

    assert_eq!(rows.len(), 18, "the frame ends on the blank: {rows:?}");
    assert_eq!(rows[17], "");
}

#[test]
fn the_current_model_leads_and_matches_only_by_provider_and_id() {
    let picker = ModelPicker::new(picker_options(battery_catalog()));
    let model = picker.selected_model().expect("selection");
    assert_eq!(model.id, "mock-1");
    assert_eq!(picker.selected_index(), 0);
}

#[test]
fn enter_applies_the_selection() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "mock-1".to_string(),
            effort: None,
        }))
    );
}

#[test]
fn typed_filter_selects_the_match_and_enter_applies_it() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.set_query("haiku");
    assert_eq!(picker.query(), "haiku");
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "anthropic/claude-haiku-4.5".to_string(),
            effort: None,
        }))
    );
}

/// The Tab-intercepted partial keeps the caret at its end, so typing extends the
/// filter instead of inserting before it.
#[test]
fn a_row_click_lands_the_arrows_on_the_clicked_rows_effort() {
    let kb = kb();
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    // A nonempty search keeps Left/Right on the search field until the user
    // enters the list (an arrow move) — a row click is the same entry.
    picker.set_query("fable");
    assert!(
        picker.search.value().contains("fable"),
        "the query prefilled"
    );
    picker.select_filtered(0);
    let before = picker.search.value().to_string();
    picker.handle_key("left", &kb);
    assert_eq!(
        picker.search.value(),
        before,
        "Left adjusted the clicked row's effort, not the search"
    );
}

#[test]
fn set_query_prefill_leaves_the_caret_at_the_end() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.set_query("gp");
    assert_eq!(picker.search.cursor(), 2, "the caret sits after gp");
    picker.handle_key("t", &kb());
    assert_eq!(picker.query(), "gpt");
    assert_eq!(picker.search.cursor(), 3);
}

#[test]
fn typing_into_the_picker_filters_and_resets_the_selection() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    for character in "mock".chars() {
        assert_eq!(
            picker.handle_key(&character.to_string(), &kb()),
            ModelPickerAction::None
        );
    }
    assert_eq!(picker.query(), "mock");
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "mock-1".to_string(),
            effort: None,
        }))
    );
}

#[test]
fn escape_and_ctrl_c_cancel() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    assert_eq!(
        picker.handle_key("escape", &kb()),
        ModelPickerAction::Cancel
    );
    assert_eq!(
        picker.handle_key("ctrl+c", &kb()),
        ModelPickerAction::Cancel
    );
}

#[test]
fn navigation_wraps_and_enter_applies_the_moved_selection() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    assert_eq!(picker.handle_key("up", &kb()), ModelPickerAction::None);
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "deepseek/deepseek-v4".to_string(),
            effort: None,
        }))
    );
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.handle_key("down", &kb());
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "anthropic/claude-fable-5".to_string(),
            effort: None,
        }))
    );
}

#[test]
fn left_right_adjust_the_selected_effort_and_enter_carries_it() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    // Move onto a reasoning model; its seeded effort is medium.
    picker.handle_key("down", &kb());
    // The empty filter keeps arrows on the effort cluster.
    assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::None);
    let model = picker.selected_model().expect("selection").clone();
    assert_eq!(picker.effort_of(&model), Some(ModelThinkingLevel::Low));
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "anthropic/claude-fable-5".to_string(),
            effort: Some("low".to_string()),
        }))
    );
}

#[test]
fn a_nonempty_filter_keeps_arrows_on_the_search_cursor() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    for character in "claude fable".chars() {
        picker.handle_key(&character.to_string(), &kb());
    }
    // The caret sits at the field's end: left moves the caret inside the text,
    // not the effort cluster or the picker.
    assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::None);
    assert_eq!(picker.query(), "claude fable");
    // Home walks the caret to the field's start; a further left acts like Esc (back
    // only at column 0).
    assert_eq!(picker.handle_key("home", &kb()), ModelPickerAction::None);
    assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::Cancel);
}

#[test]
fn unconfigured_providers_mark_require_sign_in_and_sort_last() {
    let catalog = vec![
        model("prime-inference", "mock-1", "Mock 1", false, None),
        model(
            "other",
            "unconfigured-model",
            "Unconfigured Model",
            false,
            None,
        ),
    ];
    let mut options = picker_options(catalog);
    options.current = None;
    let mut picker = ModelPicker::new(options);
    let rows = frame_text(&mut picker);

    assert!(rows
        .iter()
        .any(|row| row.contains("require sign in \u{b7} other")));
    assert!(rows.iter().any(|row| row.contains("Mock 1")));
}

#[test]
fn update_state_keeps_the_selection_on_the_surviving_model() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.handle_key("down", &kb());
    let mut catalog = battery_catalog();
    // The refresh drops one model and adds another.
    catalog.pop();
    catalog.push(model(
        "prime-inference",
        "new/model",
        "New Model",
        false,
        None,
    ));
    picker.update_state(Some(current()), catalog, configured());
    let selected = picker.selected_model().expect("selection").clone();
    assert_eq!(selected.id, "anthropic/claude-fable-5");
}

#[test]
fn the_effort_seed_clamps_to_the_model_levels() {
    let catalog = vec![
        model("prime-inference", "mock-1", "Mock 1", false, None),
        model(
            "prime-inference",
            "anthropic/claude-haiku-4.5",
            "Claude Haiku 4.5",
            true,
            Some(high_only_map()),
        ),
    ];
    let picker = ModelPicker::new(picker_options(catalog));
    let haiku = picker.model_at(1).expect("catalog").clone();
    // Medium clamps up to the only supported level.
    assert_eq!(picker.effort_of(&haiku), Some(ModelThinkingLevel::High));
}

#[test]
fn paging_moves_by_the_visible_window() {
    let mut catalog = battery_catalog();
    for extra in 0..20 {
        catalog.push(model(
            "prime-inference",
            &format!("extra/{extra}"),
            "Extra",
            false,
            None,
        ));
    }
    let mut options = picker_options(catalog);
    options.current = None;
    let mut picker = ModelPicker::new(options);
    assert_eq!(
        picker.handle_key("pageDown", &kb()),
        ModelPickerAction::None
    );
    assert_eq!(picker.selected_index(), picker.visible_items());
}

#[test]
fn the_sorted_order_matches_the_ts_chain() {
    // The full sort chain: configured, pinned, current, recent, provider, featured, id.
    let catalog = vec![
        model("other", "b-model", "B", false, None),
        model("prime-inference", "z-model-2", "Z2", false, None),
        model("prime-inference", "z-model-10", "Z10", false, None),
        model("prime-inference", "mock-1", "Mock 1", false, None),
    ];
    let mut options = picker_options(catalog);
    options.current = Some(current());
    let picker = ModelPicker::new(options);
    let ids: Vec<&str> = picker
        .all_models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(ids, vec!["mock-1", "z-model-2", "z-model-10", "b-model",]);
}

#[test]
fn an_empty_catalog_opens_the_empty_panel() {
    // TS `handleModelCommand` opens the menu regardless: an empty catalog
    // renders the bordered field and the no-match row.
    let ModelCommandOutcome::Open(mut picker) = ModelPicker::open(picker_options(Vec::new()), "");
    let rows = frame_text(&mut picker);
    assert_eq!(rows[1], " >  Search models");
    assert!(rows.iter().any(|row| row == "  No matching models"));
}

#[test]
fn dispatch_opens_the_picker_with_the_prefilled_search() {
    let ModelCommandOutcome::Open(picker) =
        ModelPicker::open(picker_options(battery_catalog()), " haiku ");
    assert_eq!(picker.query(), "haiku");
}

#[test]
fn a_query_with_no_matches_renders_the_no_matching_row() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.set_query("zzz-no-match");
    let rows = frame_text(&mut picker);
    assert!(rows.iter().any(|row| row == "  No matching models"));
}

#[test]
fn paste_edits_the_filter_like_the_ts_input() {
    let mut picker = ModelPicker::new(picker_options(battery_catalog()));
    picker.paste("mock-1");
    assert_eq!(picker.query(), "mock-1");
    assert_eq!(
        picker.handle_key("enter", &kb()),
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: "prime-inference".to_string(),
            model_id: "mock-1".to_string(),
            effort: None,
        }))
    );
}

/// The ids of the filtered (search-ordered) rows.
fn filtered_ids(picker: &ModelPicker) -> Vec<String> {
    picker
        .filtered
        .iter()
        .map(|&index| picker.all_models[index].id.clone())
        .collect()
}

#[test]
fn version_key_parses_the_catalog_id_formats() {
    // Hyphen- and dot-joined releases, letter-glued versions, dated snapshots,
    // namespaced ids, and digit-free ids.
    assert_eq!(version_key("claude-opus-5-5"), vec!["5", "5"]);
    assert_eq!(version_key("claude-opus-5.5"), vec!["5", "5"]);
    assert_eq!(version_key("glm-5.3"), vec!["5", "3"]);
    assert_eq!(version_key("glm-5p2"), vec!["5", "2"]);
    assert_eq!(version_key("qwen3.5-plus"), vec!["3", "5"]);
    assert_eq!(version_key("deepseek-v4"), vec!["4"]);
    assert_eq!(version_key("minimax-m2.7"), vec!["2", "7"]);
    assert_eq!(version_key("mimo-v2.5"), vec!["2", "5"]);
    assert_eq!(version_key("kimi-k2.7-code"), vec!["2", "7"]);
    assert_eq!(version_key("o3-mini"), vec!["3"]);
    assert_eq!(version_key("x-ai/grok-4.20"), vec!["4", "20"]);
    assert_eq!(
        version_key("gpt-4o-2024-05-13"),
        vec!["4", "2024", "05", "13"]
    );
    assert_eq!(
        version_key("claude-opus-4-5-20251101"),
        vec!["4", "5", "20251101"]
    );
    assert_eq!(version_key("anthropic/claude-opus-4.7"), vec!["4", "7"]);
    assert_eq!(
        version_key("us.anthropic.claude-opus-4-6-v1:0"),
        vec!["4", "6", "1", "0"]
    );
    assert_eq!(version_key("claude-opus-latest"), Vec::<String>::new());
    assert_eq!(version_key("auto-beta"), Vec::<String>::new());
    // Overlong digit runs (beyond `u64`) are preserved, not dropped.
    assert_eq!(
        version_key("model-18446744073709551616"),
        vec!["18446744073709551616"]
    );
}

#[test]
fn version_desc_orders_runs_newest_first() {
    // Higher versions first; digit value, not text.
    assert_eq!(
        version_desc(&version_key("model-5.5"), &version_key("model-4.7")),
        std::cmp::Ordering::Less
    );
    assert_eq!(
        version_desc(&version_key("model-2"), &version_key("model-10")),
        std::cmp::Ordering::Greater
    );
    // The dated snapshot of a release leads its undated alias.
    assert_eq!(
        version_desc(
            &version_key("model-4-5-20251101"),
            &version_key("model-4-5")
        ),
        std::cmp::Ordering::Less
    );
    // Ids without a version trail every versioned match.
    assert_eq!(
        version_desc(&version_key("model-latest"), &version_key("model-3-8")),
        std::cmp::Ordering::Greater
    );
    // Leading zeros compare by value.
    assert_eq!(
        version_desc(&version_key("model-05"), &version_key("model-5")),
        std::cmp::Ordering::Equal
    );
    // Digit runs beyond `u64` keep their numeric order.
    assert_eq!(
        version_desc(
            &version_key("model-18446744073709551616"),
            &version_key("model-2")
        ),
        std::cmp::Ordering::Less
    );
    assert_eq!(
        version_desc(&version_key("model-4-7"), &version_key("model-4-7")),
        std::cmp::Ordering::Equal
    );
}

#[test]
fn search_ranks_version_descending() {
    // Searching `opus` lists 5.5 before 4.7; both id spellings of 5.5 tie on
    // their version run, and the dated 4.5 snapshot stays below the newer 4.7.
    let catalog = vec![
        model(
            "prime-inference",
            "anthropic/claude-opus-4.7",
            "Claude Opus 4.7",
            false,
            None,
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-5.5",
            "Claude Opus 5.5",
            false,
            None,
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-5-5",
            "Claude Opus 5 5",
            false,
            None,
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4-5-20251101",
            "Claude Opus 4.5 Snapshot",
            false,
            None,
        ),
    ];
    let mut picker = ModelPicker::new(picker_options(catalog));
    picker.set_query("opus");
    assert_eq!(
        filtered_ids(&picker),
        vec![
            "anthropic/claude-opus-5-5",
            "anthropic/claude-opus-5.5",
            "anthropic/claude-opus-4.7",
            "anthropic/claude-opus-4-5-20251101",
        ]
    );
}

#[test]
fn search_keeps_logged_in_providers_above_newer_matches() {
    // The logged-in tier outranks text match and version: the configured provider's older model
    // leads the unconfigured provider's newer, better-scoring match.
    let catalog = vec![
        model(
            "prime-inference",
            "anthropic/claude-opus-4.7",
            "Claude Opus 4.7",
            false,
            None,
        ),
        model("other", "opus-9.9", "Opus 9.9", false, None),
    ];
    let mut options = picker_options(catalog);
    options.current = None;
    let mut picker = ModelPicker::new(options);
    picker.set_query("opus");
    assert_eq!(
        filtered_ids(&picker),
        vec!["anthropic/claude-opus-4.7", "opus-9.9"]
    );
}

#[test]
fn search_ranks_version_above_the_current_model() {
    // The version tier outranks the current-model marker: searching `opus` lists
    // 4.8 first even when 4.7 is the session's model.
    let catalog = vec![
        model(
            "prime-inference",
            "anthropic/claude-opus-4.7",
            "Claude Opus 4.7",
            false,
            None,
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4.8",
            "Claude Opus 4.8",
            false,
            None,
        ),
    ];
    let mut options = picker_options(catalog);
    options.current = Some(CurrentModel {
        provider: "prime-inference".to_string(),
        model_id: "anthropic/claude-opus-4.7".to_string(),
    });
    let mut picker = ModelPicker::new(options);
    picker.set_query("opus");
    assert_eq!(
        filtered_ids(&picker),
        vec!["anthropic/claude-opus-4.8", "anthropic/claude-opus-4.7"]
    );
}

#[test]
fn search_keeps_recent_use_within_an_equal_version() {
    // Equal version runs keep the sub-tier tiebreakers: the recent-use rank leads
    // `4.7` over the id-sorted-first `4-7` spelling.
    let catalog = vec![
        model(
            "prime-inference",
            "anthropic/claude-opus-4-7",
            "Claude Opus 4 7",
            false,
            None,
        ),
        model(
            "prime-inference",
            "anthropic/claude-opus-4.7",
            "Claude Opus 4.7",
            false,
            None,
        ),
    ];
    let mut options = picker_options(catalog);
    options.current = None;
    options.recent_models = vec!["prime-inference/anthropic/claude-opus-4.7".to_string()];
    let mut picker = ModelPicker::new(options);
    picker.set_query("opus");
    assert_eq!(
        filtered_ids(&picker),
        vec!["anthropic/claude-opus-4.7", "anthropic/claude-opus-4-7"]
    );
}

#[test]
fn search_compares_version_numbers_and_leaves_unversioned_ids_last() {
    // Digit runs compare by value (10 over 2) and ids without a version trail
    // every versioned match.
    let catalog = vec![
        model("prime-inference", "z-model-2", "Z Model 2", false, None),
        model("prime-inference", "z-model-10", "Z Model 10", false, None),
        model(
            "prime-inference",
            "z-model-next",
            "Z Model Next",
            false,
            None,
        ),
    ];
    let mut picker = ModelPicker::new(picker_options(catalog));
    picker.set_query("model");
    assert_eq!(
        filtered_ids(&picker),
        vec!["z-model-10", "z-model-2", "z-model-next"]
    );
}

#[test]
fn search_ranks_preview_suffixed_ids_by_their_version() {
    // A prerelease suffix never hides the version: `hy4-preview` outranks `hy3`.
    let catalog = vec![
        model("prime-inference", "tencent/hy3", "HY3", false, None),
        model(
            "prime-inference",
            "tencent/hy4-preview",
            "HY4 Preview",
            false,
            None,
        ),
    ];
    let mut picker = ModelPicker::new(picker_options(catalog));
    picker.set_query("hy");
    assert_eq!(
        filtered_ids(&picker),
        vec!["tencent/hy4-preview", "tencent/hy3"]
    );
}

#[test]
fn search_preserves_overlong_version_runs() {
    // A digit run beyond `u64` is a version like any other: the oversized newer
    // release leads, not trails, when text scores tie.
    let catalog = vec![
        model("prime-inference", "model-2", "Model Two", false, None),
        model(
            "prime-inference",
            "model-18446744073709551616",
            "Model Oversized",
            false,
            None,
        ),
    ];
    let mut picker = ModelPicker::new(picker_options(catalog));
    picker.set_query("model");
    assert_eq!(
        filtered_ids(&picker),
        vec!["model-18446744073709551616", "model-2"]
    );
}
