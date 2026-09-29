use super::*;

fn provider(base: &str) -> CombinedAutocompleteProvider {
    CombinedAutocompleteProvider::from_registry(std::path::PathBuf::from(base))
}

/// The suggestions of a synchronous lookup (every source except `@`).
fn ready(lookup: Option<SuggestionLookup>) -> Suggestions {
    match lookup {
        Some(SuggestionLookup::Ready(suggestions)) => suggestions,
        other => panic!("expected ready suggestions, got {other:?}"),
    }
}

fn item(value: &str) -> CompletionItem {
    CompletionItem {
        value: value.to_string(),
        label: value.to_string(),
        description: None,
        argument_hint: None,
        source_tag: None,
    }
}

#[test]
fn slash_context_matches_ts_positions() {
    // Name at the prompt start.
    let ctx = get_slash_command_context(&["/he".to_string()], 0, 3).unwrap();
    assert_eq!(ctx.kind, SlashKind::Name);
    assert_eq!(ctx.prefix, "/he");
    assert!(ctx.at_prompt_start);
    // Argument position carries the command name.
    let ctx = get_slash_command_context(&["/goal ship".to_string()], 0, 10).unwrap();
    assert_eq!(ctx.kind, SlashKind::Argument);
    assert_eq!(ctx.command_name.as_deref(), Some("goal"));
    assert_eq!(ctx.prefix, "ship");
    // Leading whitespace still counts as the command position.
    let ctx = get_slash_command_context(&["  /he".to_string()], 0, 5).unwrap();
    assert_eq!(ctx.prefix, "/he");
    // A second `/` inside the token kills the context.
    assert!(get_slash_command_context(&["/a/b".to_string()], 0, 4).is_none());
    // A mid-line `/token` completes without prompt-start status.
    let ctx = get_slash_command_context(&["run /he".to_string()], 0, 7).unwrap();
    assert_eq!(ctx.kind, SlashKind::Name);
    assert_eq!(ctx.prefix, "/he");
    assert!(!ctx.at_prompt_start);
    assert!(get_slash_command_context(&["plain".to_string()], 0, 5).is_none());
}

#[test]
fn slash_suggestions_filter_fuzzily() {
    let provider = provider("/tmp");
    let suggestions = ready(provider.get_suggestions(&["/se".to_string()], 0, 3, false));
    assert_eq!(suggestions.kind, Some(SuggestionKind::SlashCommand));
    assert_eq!(suggestions.prefix, "/se");
    assert!(suggestions.items.iter().any(|i| i.value == "settings"));
    // Aliases join the search text: /think matches the effort command.
    let suggestions = ready(provider.get_suggestions(&["/think".to_string()], 0, 6, false));
    assert_eq!(suggestions.items[0].value, "effort");
    // The bare '/' shows the whole registry.
    let suggestions = ready(provider.get_suggestions(&["/".to_string()], 0, 1, false));
    assert_eq!(
        suggestions.items.len(),
        SlashCommandRegistry::builtin().all().len()
    );
}

#[test]
fn hidden_commands_drop_rows_from_the_menu() {
    let mut provider = provider("/tmp");
    let visible = provider.get_suggestions(&["/f".to_string()], 0, 2, false);
    let items = ready(visible).items;
    assert!(
        items.iter().any(|item| item.value == "fast"),
        "fast lists by default: {items:?}"
    );
    provider.set_hidden_commands(std::collections::HashSet::from(["fast".to_string()]));
    let visible = provider.get_suggestions(&["/f".to_string()], 0, 2, false);
    let items = ready(visible).items;
    assert!(
        !items.iter().any(|item| item.value == "fast"),
        "hidden fast drops from the menu: {items:?}"
    );
}

/// `/update` is VISIBLE in autocomplete: the fast filter is the only
/// hidden-command policy (model eligibility), and the update command
/// never enters it — the migration path stays discoverable.
#[test]
fn update_lists_in_the_menu_under_every_hidden_set() {
    let mut provider = provider("/tmp");
    let visible = provider.get_suggestions(&["/up".to_string()], 0, 3, false);
    let items = ready(visible).items;
    assert!(
        items.iter().any(|item| item.value == "update"),
        "update lists by default: {items:?}"
    );
    // The live surface's only hidden set (the /fast model filter)
    // never contains the update command.
    provider.set_hidden_commands(std::collections::HashSet::from(["fast".to_string()]));
    let visible = provider.get_suggestions(&["/up".to_string()], 0, 3, false);
    let items = ready(visible).items;
    assert!(
        items.iter().any(|item| item.value == "update"),
        "update stays listed under the fast filter: {items:?}"
    );
}

/// TS #2144 `getServiceTierCompletions`: the `/tier` argument position
/// offers the injected items, filtered by the typed term, with the
/// current tier marked in the description; other commands fall
/// through to path completion.
#[test]
fn tier_argument_completions_list_filter_and_mark_current() {
    let mut provider = provider("/tmp");
    let tier_items = |current: &str| {
        ["default", "flex", "priority", "auto"]
            .iter()
            .map(|tier| CompletionItem {
                value: tier.to_string(),
                label: tier.to_string(),
                description: Some(if *tier == current {
                    "tier (current)".to_string()
                } else {
                    "tier".to_string()
                }),
                argument_hint: None,
                source_tag: None,
            })
            .collect::<Vec<_>>()
    };
    provider.set_argument_completions("tier", tier_items("flex"));
    // No term: every tier lists, the current one marked.
    let suggestions = provider.get_suggestions(&["/tier ".to_string()], 0, 6, false);
    let items = ready(suggestions).items;
    assert_eq!(
        items
            .iter()
            .map(|item| item.value.as_str())
            .collect::<Vec<_>>(),
        ["default", "flex", "priority", "auto"]
    );
    assert!(items
        .iter()
        .any(|item| item.description.as_deref() == Some("tier (current)")));
    // A term filters by prefix.
    let suggestions = provider.get_suggestions(&["/tier pr".to_string()], 0, 8, false);
    let items = ready(suggestions).items;
    assert_eq!(
        items
            .iter()
            .map(|item| item.value.as_str())
            .collect::<Vec<_>>(),
        ["priority"]
    );
    // A term with no match answers nothing (TS `getSuggestions` null
    // at argument positions).
    assert!(provider
        .get_suggestions(&["/tier zz".to_string()], 0, 8, false)
        .is_none());
}

#[test]
fn slash_completion_applies_separator_by_argument() {
    let provider = provider("/tmp");
    // Argument-taking command: completes into the parameter position.
    let result = provider.apply_completion(&["/goa".to_string()], 0, 4, &item("goal"), "/goa");
    assert_eq!(result.lines[0], "/goal ");
    assert_eq!(result.cursor_col, 6);
    // Bare command: no trailing separator.
    let result = provider.apply_completion(&["/refi".to_string()], 0, 5, &item("refine"), "/refi");
    assert_eq!(result.lines[0], "/refine");
    assert_eq!(result.cursor_col, 7);
}

#[test]
fn path_completion_lists_directories_first() {
    let dir = std::env::temp_dir().join("pa-tui-path-completion");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).expect("mkdir");
    std::fs::create_dir_all(dir.join("docs")).expect("mkdir");
    std::fs::write(dir.join("main.rs"), "fn main() {}").expect("write");
    let provider = provider(dir.to_str().unwrap());
    let suggestions = ready(provider.get_suggestions(&["./ma".to_string()], 0, 4, false));
    assert_eq!(suggestions.kind, Some(SuggestionKind::File));
    assert_eq!(suggestions.items.len(), 1);
    assert_eq!(suggestions.items[0].value, "./main.rs");
    // Directories first, both with trailing slashes.
    let suggestions = ready(provider.get_suggestions(&["./".to_string()], 0, 3, false));
    let values: Vec<&str> = suggestions.items.iter().map(|i| i.value.as_str()).collect();
    assert!(values.contains(&"./docs/"));
    assert!(values.contains(&"./src/"));
    assert!(values.contains(&"./main.rs"));
    assert!(
        values.iter().position(|v| *v == "./main.rs").unwrap()
            > values.iter().position(|v| *v == "./src/").unwrap()
    );
    // Non-path tokens do not trigger on natural typing.
    assert!(provider
        .get_suggestions(&["hello wor".to_string()], 0, 9, false)
        .is_none());
    // ...but an explicit request (Tab) completes any token.
    assert!(provider
        .get_suggestions(&["hello ma".to_string()], 0, 8, true)
        .is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Dot entries list only for an explicit dot-prefix anchor (the
/// operator's 2026-09-25 directive): a directory browse (`./`, `src/`,
/// `..`, the empty root prefix) must not surface the cwd's dotfiles —
/// the old forced pass listed the whole cwd and a `.claude` directory
/// rode first — while a typed dot prefix (`.h`, `./.cl`) still
/// completes hidden paths.
#[test]
fn dotfiles_list_only_for_a_dot_prefix_anchor() {
    let outer = tempfile::TempDir::new().expect("temp dir");
    let base = outer.path().join("base");
    std::fs::create_dir_all(base.join(".claude")).expect("mkdir");
    std::fs::create_dir_all(base.join("src")).expect("mkdir");
    std::fs::write(base.join("src").join("module.rs"), "pub fn m() {}").expect("write");
    std::fs::write(base.join("src").join(".local"), "x").expect("write");
    std::fs::write(base.join(".hidden"), "x").expect("write");
    std::fs::write(base.join("main.rs"), "fn main() {}").expect("write");
    let provider = provider(base.to_str().unwrap());
    let values = |text: &str| -> Vec<String> {
        ready(provider.get_suggestions(&[text.to_string()], 0, text.chars().count(), true))
            .items
            .into_iter()
            .map(|item| item.value)
            .collect()
    };
    // The root browse: non-hidden entries only.
    assert_eq!(
        values("./"),
        ["./src/", "./main.rs"],
        "the cwd browse hides the dot entries"
    );
    // The explicit `src/` browse and the empty-prefix forced pass are
    // the same class of listing.
    assert_eq!(values("src/"), ["src/module.rs"]);
    assert_eq!(values(""), ["src/", "main.rs"]);
    // A bare `.` is the dot-name browse (the bash `.`-then-Tab): the
    // dot entries list. A bare `..` searches a `..` filename prefix
    // (TS basename parity), so nothing matches and no menu opens.
    assert_eq!(values("."), [".claude/", ".hidden"]);
    assert!(provider
        .get_suggestions(&["..".to_string()], 0, 2, true)
        .is_none());
    // A typed dot prefix is the explicit hidden-path browse: dot
    // entries list again.
    assert_eq!(values("./.cl"), ["./.claude/"]);
    assert_eq!(values(".h"), [".hidden"]);
    // A trailing `.` after a separator is the same explicit dot-name
    // browse (`src/.`, `~/.` are the natural next keystrokes after a
    // directory browse when completing a hidden name).
    assert_eq!(values("src/."), ["src/.local"]);
    assert_eq!(values("./."), ["./.claude/", "./.hidden"]);
}

/// The `@` fuzzy file search (the ported fd walk): nested matches list
/// with fd's semantics — hidden entries included, `.git` pruned —
/// the scoped `@src/par` form walks `src` and keeps the typed scope
/// in the display, and applying a file item leaves the trailing
/// space the TS `@` branch adds.
#[test]
fn at_prefix_lists_nested_fuzzy_matches() {
    let outer = tempfile::TempDir::new().expect("temp dir");
    let base = outer.path().join("base");
    std::fs::create_dir_all(base.join("src/deep")).expect("mkdir");
    std::fs::create_dir_all(base.join(".hidden")).expect("mkdir");
    std::fs::create_dir_all(base.join(".git")).expect("mkdir");
    std::fs::write(base.join("src/deep/partial_match.rs"), "x").expect("write");
    std::fs::write(base.join(".hidden/partial"), "x").expect("write");
    std::fs::write(base.join(".git/partial"), "x").expect("write");
    std::fs::write(base.join("other.md"), "x").expect("write");
    let provider = provider(base.to_str().unwrap());
    let values = |text: &str| -> Vec<String> {
        match provider.get_suggestions(&[text.to_string()], 0, text.chars().count(), false) {
            Some(SuggestionLookup::Searching(search)) => search
                .results
                .recv()
                .expect("the search finishes")
                .expect("suggestions")
                .items
                .into_iter()
                .map(|item| item.value)
                .collect(),
            other => panic!("expected a searching lookup, got {other:?}"),
        }
    };
    // The exact `.hidden/partial` name (score 100) sorts ahead of
    // the `partial_match.rs` prefix match (80); `.git` never lists.
    assert_eq!(
        values("see @partial"),
        ["@.hidden/partial", "@src/deep/partial_match.rs"]
    );
    assert_eq!(values("@src/par"), ["@src/deep/partial_match.rs"]);
    let item = CompletionItem {
        value: "@src/deep/partial_match.rs".to_string(),
        label: "partial_match.rs".to_string(),
        description: None,
        argument_hint: None,
        source_tag: None,
    };
    let result = provider.apply_completion(&["see @partial".to_string()], 0, 12, &item, "@partial");
    assert_eq!(result.lines[0], "see @src/deep/partial_match.rs ");
    assert_eq!(result.cursor_col, 31);
}

#[test]
fn should_trigger_file_completion_skips_slash_names() {
    let provider = provider("/tmp");
    assert!(!provider.should_trigger_file_completion(&["/mo".to_string()], 0, 3));
    assert!(provider.should_trigger_file_completion(&["path/to".to_string()], 0, 7));
}

fn theme() -> crate::theme::Theme {
    crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
}

#[test]
fn render_uses_the_menu_panel_grammar() {
    let items: Vec<CompletionItem> = (0..7)
        .map(|i| CompletionItem {
            value: format!("cmd{i}"),
            label: format!("cmd{i}"),
            description: Some(format!("description {i}")),
            argument_hint: Some("[arg]".to_string()),
            source_tag: None,
        })
        .collect();
    let state = AutocompleteState::new(
        items,
        5,
        "/".to_string(),
        Some(SuggestionKind::SlashCommand),
    );
    let lines = state.render(&theme(), 60);
    let text = |line: &Line| -> String { line.iter().map(|s| s.content.as_str()).collect() };
    let rendered: Vec<String> = lines.iter().map(text).collect();
    // The selected row carries the menu marker and the selection band
    // spans the row (padded to the full width).
    assert!(rendered[0].starts_with("\u{203a} cmd0"));
    assert_eq!(rendered[0].chars().count(), 60);
    // The argument hint rides the row's right-aligned trailing cluster.
    assert!(rendered.iter().any(|l| l.ends_with("[arg]")));
    // The shared scroll status row (the menu panel's `(n/m)`), not the
    // old directional `↑ N more` form.
    assert!(rendered.iter().any(|l| l.trim() == "(1/7)"));
    // The selected item's description block under the list.
    assert!(rendered.iter().any(|l| l.contains("description 0")));
}

#[test]
fn empty_items_render_the_shared_no_match_row() {
    let state = AutocompleteState::new(Vec::new(), 5, String::new(), None);
    let lines = state.render(&theme(), 40);
    let text: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(text, "  No matching commands");
}

/// Every overlay row clamps to the render width: the menu rows pad to
/// it and the status rows (scroll indicator, no-match) truncate to
/// it, so a narrow dropdown never emits a row wider than its dock (the
/// overlay renders the rows straight into the editor dock, and an
/// unclamped `(n/m)` would overwrite the adjacent terminal cells).
#[test]
fn narrow_renders_never_exceed_the_frame_width() {
    let mut described = item("cmd0");
    described.description = Some("description 0".to_string());
    let items: Vec<CompletionItem> = std::iter::once(described)
        .chain((1..7).map(|index| item(&format!("cmd{index}"))))
        .collect();
    for width in [4usize, 6, 9, 40] {
        let state = AutocompleteState::new(
            items.clone(),
            5,
            "/".to_string(),
            Some(SuggestionKind::SlashCommand),
        );
        for line in &state.render(&theme(), width) {
            assert!(
                crate::width::spans_width(line) <= width,
                "every row clamps to the frame width {width}: {line:?}"
            );
        }
    }
    let empty = AutocompleteState::new(Vec::new(), 5, String::new(), None);
    for line in &empty.render(&theme(), 6) {
        assert!(
            crate::width::spans_width(line) <= 6,
            "the no-match row clamps to the frame width: {line:?}"
        );
    }
}

#[test]
fn best_match_prefers_exact_then_prefix() {
    let state = AutocompleteState::new(
        vec![item("help"), item("hello")],
        5,
        "/hel".to_string(),
        Some(SuggestionKind::SlashCommand),
    );
    assert_eq!(state.best_match_index("hel"), Some(0));
    assert_eq!(state.best_match_index("hello"), Some(1));
    assert_eq!(state.best_match_index("zzz"), None);
}

/// A `skill:` entry as the daemon `get_commands` response carries it.
fn skill_entry(name: &str, description: &str, scope: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "description": description,
        "source": "skill",
        "sourceInfo": {
            "path": "/tmp/skills/web-search/SKILL.md",
            "source": "local",
            "scope": scope,
            "origin": "top-level",
            "baseDir": "/tmp/skills",
        },
    })
}

fn provider_with_skill(base: &str) -> CombinedAutocompleteProvider {
    let mut provider = provider(base);
    provider.set_skill_commands(vec![SlashCommandEntry {
        name: "skill:brainstorm".to_string(),
        aliases: Vec::new(),
        description: Some("Brainstorm approaches".to_string()),
        argument_hint: Some(SKILL_ARGUMENT_HINT.to_string()),
        takes_argument: true,
        source_tag: Some("#project".to_string()),
    }]);
    provider
}

#[test]
fn skill_commands_list_after_the_builtins() {
    // TS `createBaseAutocompleteProvider`: the skill commands follow
    // the builtin commands in the provider's list.
    let provider = provider_with_skill("/tmp");
    let items = provider.slash_suggestions("/");
    assert!(items.len() > SlashCommandRegistry::builtin().all().len());
    assert_eq!(items.last().unwrap().value, "skill:brainstorm");
    assert_eq!(
        items.last().unwrap().description.as_deref(),
        Some("Brainstorm approaches")
    );
    assert_eq!(
        items.last().unwrap().source_tag.as_deref(),
        Some("#project")
    );
}

#[test]
fn skill_commands_suggest_for_the_typed_prefix_and_inline_references() {
    // TS autocomplete.test.ts: a `/skill:brain` prefix suggests the
    // skill command, and a mid-line reference suggests it too.
    let provider = provider_with_skill("/tmp");
    let items = provider.slash_suggestions("/skill:brain");
    let values: Vec<&str> = items.iter().map(|item| item.value.as_str()).collect();
    assert_eq!(values, vec!["skill:brainstorm"]);
    let suggestions =
        ready(provider.get_suggestions(&["Please use /skill:brain".to_string()], 0, 23, false));
    assert_eq!(suggestions.prefix, "/skill:brain");
    assert_eq!(
        suggestions
            .items
            .iter()
            .map(|item| item.value.as_str())
            .collect::<Vec<_>>(),
        vec!["skill:brainstorm"]
    );
}

#[test]
fn skill_command_completes_into_the_argument_position() {
    // A skill invocation always wants the user's request text (a bare
    // submission would expand into the protocol with no task), so the
    // completion lands in the argument position: the trailing space
    // stays and the cursor sits after it, ready for the request.
    let provider = provider_with_skill("/tmp");
    let item = item("skill:brainstorm");
    let result = provider.apply_slash_completion(
        &["/skill:brain".to_string()],
        0,
        12,
        &item,
        "/skill:brain",
    );
    assert_eq!(result.lines[0], "/skill:brainstorm ");
    assert_eq!(result.cursor_col, "/skill:brainstorm ".chars().count());
}

#[test]
fn skill_completions_apply_through_the_slash_path() {
    // TS `applyCompletion` finds skill items over the whole command
    // list, so a menu-confirmed skill keeps the leading `/` and stays
    // a command submission (the file path would drop it) — landing in
    // the argument position like the direct slash completion.
    let provider = provider_with_skill("/tmp");
    let item = item("skill:brainstorm");
    let result =
        provider.apply_completion(&["/skill:brain".to_string()], 0, 12, &item, "/skill:brain");
    assert_eq!(result.lines[0], "/skill:brainstorm ");
    assert_eq!(result.cursor_col, "/skill:brainstorm ".chars().count());
}

#[test]
fn command_catalog_parse_keeps_skills_and_source_labels() {
    // TS `connectionCommands.filter(source === "skill")` + the
    // `getAutocompleteSourceLabel` ladder.
    let response = serde_json::json!({
        "commands": [
            {
                "name": "review",
                "description": "Review template",
                "source": "prompt",
                "sourceInfo": { "source": "local", "scope": "project" },
            },
            skill_entry("skill:web-search", "Search Google", "user"),
            {
                "name": "skill:packaged",
                "description": "From the registry",
                "source": "skill",
                "sourceInfo": { "source": "npm:@prime/skill-pack", "scope": "project" },
            },
            {
                "name": "skill:path-skill",
                "description": "Path-provided",
                "source": "skill",
                "sourceInfo": { "source": "local", "scope": "temporary" },
            },
        ]
    });
    let entries = skill_command_entries(&response);
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["skill:web-search", "skill:packaged", "skill:path-skill"]
    );
    assert_eq!(entries[0].description.as_deref(), Some("Search Google"));
    assert_eq!(entries[0].source_tag.as_deref(), Some("#user"));
    assert_eq!(
        entries[1].source_tag.as_deref(),
        Some("#project:npm:@prime/skill-pack")
    );
    assert_eq!(entries[2].source_tag.as_deref(), Some("#temporary"));
    // Prompt-template entries are a different surface: they stay out.
    // A malformed or empty response yields no entries.
    assert!(skill_command_entries(&serde_json::json!({})).is_empty());
    assert!(skill_command_entries(&serde_json::json!({"commands": []})).is_empty());
    // Every skill entry advertises its argument (the hint plus the
    // argument position), never a bare command.
    for entry in &entries {
        assert!(
            entry.takes_argument,
            "the skill takes an argument: {entry:?}"
        );
        assert_eq!(entry.argument_hint.as_deref(), Some(SKILL_ARGUMENT_HINT));
    }
}

#[test]
fn source_tag_ladder_matches_ts() {
    let source_info = |source: &str, scope: Option<&str>| {
        let mut value = serde_json::json!({ "source": source });
        if let Some(scope) = scope {
            value["scope"] = serde_json::json!(scope);
        }
        value
    };
    // Builtins keep their own tag; auto/local/cli take the scope
    // prefix; an unknown scope reads temporary; an npm source appends
    // its spec.
    assert_eq!(
        autocomplete_source_label(&source_info("builtin", None)).as_deref(),
        Some("#builtin")
    );
    assert_eq!(
        autocomplete_source_label(&source_info("local", Some("user"))).as_deref(),
        Some("#user")
    );
    assert_eq!(
        autocomplete_source_label(&source_info("cli", Some("project"))).as_deref(),
        Some("#project")
    );
    assert_eq!(
        autocomplete_source_label(&source_info("local", None)).as_deref(),
        Some("#temporary")
    );
    assert_eq!(
        autocomplete_source_label(&source_info("npm:@scope/pack", Some("user"))).as_deref(),
        Some("#user:npm:@scope/pack")
    );
    // No sourceInfo at all: no tag.
    assert!(autocomplete_source_label(&serde_json::Value::Null).is_none());
}

#[test]
fn render_shows_the_source_tag_as_a_trailing_segment() {
    // TS select-list renders the sourceTag after the argument hint;
    // the menu grammar renders both as muted trailing segments.
    let mut described = item("skill:web-search");
    described.description = Some("Search Google".to_string());
    described.source_tag = Some("#user".to_string());
    let state = AutocompleteState::new(
        vec![described],
        5,
        "/skill:web".to_string(),
        Some(SuggestionKind::SlashCommand),
    );
    let rendered = state.render(&theme(), 80);
    let all: String = rendered
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert!(
        all.contains("skill:web-search"),
        "the row names the skill: {all}"
    );
    assert!(
        all.contains("#user"),
        "the row carries the source tag: {all}"
    );
    assert!(
        all.contains("Search Google"),
        "the selected description renders: {all}"
    );
}
