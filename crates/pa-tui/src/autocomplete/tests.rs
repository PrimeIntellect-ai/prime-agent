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

/// `/update` stays VISIBLE: the fast filter is the only hidden-command policy.
#[test]
fn update_lists_in_the_menu_under_every_hidden_set() {
    let mut provider = provider("/tmp");
    let visible = provider.get_suggestions(&["/up".to_string()], 0, 3, false);
    let items = ready(visible).items;
    assert!(
        items.iter().any(|item| item.value == "update"),
        "update lists by default: {items:?}"
    );
    provider.set_hidden_commands(std::collections::HashSet::from(["fast".to_string()]));
    let visible = provider.get_suggestions(&["/up".to_string()], 0, 3, false);
    let items = ready(visible).items;
    assert!(
        items.iter().any(|item| item.value == "update"),
        "update stays listed under the fast filter: {items:?}"
    );
}

/// The `/tier` argument position offers the injected items, filtered by the typed term,
/// with the current tier marked; other commands fall through to path completion.
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
    // A term with no match answers nothing.
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

/// Dot entries list only for an explicit dot-prefix anchor (operator ruling 2026-09-25):
/// a directory browse never surfaces the cwd's dotfiles.
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
    assert_eq!(values("src/"), ["src/module.rs"]);
    assert_eq!(values(""), ["src/", "main.rs"]);
    // A bare `.` is the dot-name browse; a bare `..` searches a `..`
    // filename prefix, so nothing matches.
    assert_eq!(values("."), [".claude/", ".hidden"]);
    assert!(provider
        .get_suggestions(&["..".to_string()], 0, 2, true)
        .is_none());
    assert_eq!(values("./.cl"), ["./.claude/"]);
    assert_eq!(values(".h"), [".hidden"]);
    // A trailing `.` after a separator is the same explicit dot-name
    // browse.
    assert_eq!(values("src/."), ["src/.local"]);
    assert_eq!(values("./."), ["./.claude/", "./.hidden"]);
}

/// Nested matches list with fd's semantics, the scoped form keeps the typed scope in the
/// display, and applying a file item leaves the trailing space.
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
        at_suggestions(&provider, text)
            .expect("suggestions")
            .items
            .into_iter()
            .map(|item| item.value)
            .collect()
    };
    // The exact `.hidden/partial` name sorts ahead of the
    // `partial_match.rs` prefix match; `.git` never lists.
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
    // The selected row carries the menu marker; the selection band
    // spans the row.
    assert!(rendered[0].starts_with("\u{203a} cmd0"));
    assert_eq!(rendered[0].chars().count(), 60);
    assert!(rendered.iter().any(|l| l.ends_with("[arg]")));
    // The shared scroll status row, not a directional form.
    assert!(rendered.iter().any(|l| l.trim() == "(1/7)"));
    assert!(rendered.iter().any(|l| l.contains("description 0")));
}

#[test]
fn empty_items_render_the_shared_no_match_row() {
    let state = AutocompleteState::new(Vec::new(), 5, String::new(), None);
    let lines = state.render(&theme(), 40);
    let text: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(text, "  No matching commands");
}

/// An unclamped `(n/m)` would overwrite the adjacent terminal cells.
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
    // The skill commands follow the builtin commands in the list.
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
    // A `/skill:brain` prefix suggests the skill command, and a
    // mid-line reference does too.
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
    // A skill invocation always wants the request text, so the
    // completion lands in the argument position: the trailing space
    // stays and the cursor sits after it.
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
    // A menu-confirmed skill keeps the leading `/` and stays a command
    // submission (the file path would drop it).
    let provider = provider_with_skill("/tmp");
    let item = item("skill:brainstorm");
    let result =
        provider.apply_completion(&["/skill:brain".to_string()], 0, 12, &item, "/skill:brain");
    assert_eq!(result.lines[0], "/skill:brainstorm ");
    assert_eq!(result.cursor_col, "/skill:brainstorm ".chars().count());
}

#[test]
fn command_catalog_parse_keeps_skills_and_source_labels() {
    // Only `skill`-source commands list, through the source ladder.
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
    // Prompt-template entries stay out; a malformed response yields
    // no entries.
    assert!(skill_command_entries(&serde_json::json!({})).is_empty());
    assert!(skill_command_entries(&serde_json::json!({"commands": []})).is_empty());
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
    assert!(autocomplete_source_label(&serde_json::Value::Null).is_none());
}

#[test]
fn render_shows_the_source_tag_as_a_trailing_segment() {
    // The source tag renders after the argument hint, both muted
    // trailing segments.
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

/// One `@` provider query's answer: the built index's inline one, or the background
/// walk's once it finishes.
fn at_suggestions(provider: &CombinedAutocompleteProvider, text: &str) -> Option<Suggestions> {
    match provider.get_suggestions(&[text.to_string()], 0, text.chars().count(), false) {
        Some(SuggestionLookup::Searching(search)) => {
            search.results.recv().expect("the search finishes")
        }
        Some(SuggestionLookup::Ready(suggestions)) => Some(suggestions),
        None => None,
    }
}

/// The `@` suggestion items of one provider query.
fn at_values(provider: &CombinedAutocompleteProvider, text: &str) -> Vec<CompletionItem> {
    at_suggestions(provider, text)
        .map(|suggestions| suggestions.items)
        .unwrap_or_default()
}

/// The `@` item values of one provider query.
fn at_item_values(provider: &CombinedAutocompleteProvider, text: &str) -> Vec<String> {
    at_values(provider, text)
        .into_iter()
        .map(|item| item.value)
        .collect()
}

/// A typed directory scope with an empty query lists the directory's children.
#[test]
fn at_directory_scope_lists_its_children() {
    let base = tempfile::TempDir::new().expect("temp dir");
    std::fs::create_dir_all(base.path().join("prime-agent/src")).expect("mkdir");
    for file in [
        "prime-agent/src/lib.rs",
        "prime-agent/README.md",
        "prime-agent/Cargo.toml",
        "prime-agent/.env",
        "other.md",
    ] {
        std::fs::write(base.path().join(file), "x").expect("write");
    }
    let provider = provider(base.path().to_str().expect("utf8"));
    assert_eq!(
        at_item_values(&provider, "@prime-agent/"),
        [
            "@prime-agent/src/",
            "@prime-agent/README.md",
            "@prime-agent/Cargo.toml",
            "@prime-agent/src/lib.rs",
            "@prime-agent/.env",
        ]
    );
}

/// The `@` ranking: match class, hidden entries below unless the query is dotted, fewer
/// segments, fewer chars, directories before files, then byte order.
#[test]
fn at_ranking_orders_by_class_hidden_and_length() {
    let base = tempfile::TempDir::new().expect("temp dir");
    for dir in ["main/", "main.d/", "src/", ".github/", "deploy/k8s/"] {
        std::fs::create_dir_all(base.path().join(dir)).expect("mkdir");
    }
    for file in [
        "main.c",
        "main.rs",
        "main.json",
        "src/main.rs",
        "src/domain.rs",
        ".mainrc",
        ".github/main.yml",
        "deploy/k8s/app.yml",
    ] {
        std::fs::write(base.path().join(file), "x").expect("write");
    }
    let provider = provider(base.path().to_str().expect("utf8"));
    for (query, expected) in [
        (
            "@main",
            vec![
                "@main/",
                "@main.d/",
                "@main.c",
                "@main.rs",
                "@main.json",
                "@src/main.rs",
                "@.github/main.yml",
                "@src/domain.rs",
                "@.mainrc",
            ],
        ),
        ("@yml", vec!["@deploy/k8s/app.yml", "@.github/main.yml"]),
        ("@.yml", vec!["@.github/main.yml", "@deploy/k8s/app.yml"]),
    ] {
        assert_eq!(at_item_values(&provider, query), expected, "query {query}");
    }
}

/// The parity fixture: nested directories, a hidden file, a pruned `.git`, a gitignored
/// directory (the `.git` directory makes the gitignore rules apply), a directory entry,
/// and mixed case.
fn parity_fixture() -> tempfile::TempDir {
    let outer = tempfile::TempDir::new().expect("temp dir");
    let base = outer.path().join("base");
    std::fs::create_dir_all(base.join(".git/objects")).expect("mkdir");
    std::fs::write(base.join(".git/config"), "git").expect("write");
    std::fs::write(base.join(".gitignore"), "ignored/\n").expect("write");
    std::fs::create_dir_all(base.join("src/deep")).expect("mkdir");
    std::fs::create_dir_all(base.join("ignored")).expect("mkdir");
    std::fs::write(base.join("src/partial_match.rs"), "x").expect("write");
    std::fs::write(base.join("src/ExactCase.rs"), "x").expect("write");
    std::fs::write(base.join("src/deep/other.rs"), "x").expect("write");
    std::fs::write(base.join("ignored/never.rs"), "x").expect("write");
    std::fs::write(base.join(".hidden"), "x").expect("write");
    std::fs::write(base.join("README.md"), "x").expect("write");
    outer
}

/// The index answers exactly what the walk answers: one provider on the built index,
/// one forced onto the walk path (an over-cap build disables its index), across the
/// scope and case shapes the two paths could drift on.
#[test]
fn at_index_matches_the_walk_suggestions() {
    let outer = parity_fixture();
    let base = outer.path().join("base");
    let indexed = provider(base.to_str().expect("utf8"));
    let walked = provider(base.to_str().expect("utf8"));
    assert!(indexed
        .file_index
        .build(&base, file_index::MAX_INDEX_ENTRIES));
    assert!(!walked.file_index.build(&base, 1));
    for query in [
        "",
        "match",
        "par",
        "README.md",
        "ExactCase",
        "deep/other",
        "src/",
        "src/deep/",
        "src/par",
        "src/deep/o",
        "./READ",
        "ignored/ne",
    ] {
        assert_eq!(
            at_values(&indexed, &format!("@{query}")),
            at_values(&walked, &format!("@{query}")),
            "query @{query}"
        );
    }
}

#[test]
fn at_lookup_answers_inline_from_a_built_index() {
    let outer = parity_fixture();
    let base = outer.path().join("base");
    let provider = provider(base.to_str().expect("utf8"));
    assert!(provider
        .file_index
        .build(&base, file_index::MAX_INDEX_ENTRIES));
    let text = "@par";
    assert!(matches!(
        provider.get_suggestions(&[text.to_string()], 0, text.len(), false),
        Some(SuggestionLookup::Ready(_))
    ));
}

/// A xorshift generator: the random trees need no dependency.
struct XorShift(u64);

impl XorShift {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        usize::try_from(self.0 % bound as u64).expect("below a usize bound")
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// A random tree of at least `entries` index entries under `base`, returned as their
/// printed forms: nested directories; names mixing ASCII case, Unicode (case-fold
/// outliers included), and regex metacharacters; a hidden file; and a gitignored
/// directory beside `.git`.
fn random_tree(base: &std::path::Path, rng: &mut XorShift, entries: usize) -> Vec<String> {
    const WORDS: [&str; 16] = [
        "src", "Lib", "main", "README", "Test", "util", "MODULE", "café", "Straße", "İzmir",
        "ſtate", "日本", "文件", "🦀crab", "naïve", "data",
    ];
    const MARKS: [&str; 12] = ["", ".", "-", "#", "&", "~", "+", "(", "[", "$", "_", ""];
    const EXTENSIONS: [&str; 6] = ["", ".rs", ".md", ".TXT", ".tar.gz", ".json"];
    std::fs::create_dir_all(base.join(".git")).expect("mkdir");
    std::fs::write(base.join(".git/config"), "git").expect("write");
    std::fs::write(base.join(".gitignore"), "ignored/\n").expect("write");
    std::fs::create_dir_all(base.join("ignored")).expect("mkdir");
    std::fs::write(base.join("ignored/Ignored-main.rs"), "x").expect("write");
    std::fs::write(base.join(".hidden-main.rs"), "x").expect("write");
    let mut dirs = vec![String::new()];
    let mut forms = vec![".gitignore".to_string(), ".hidden-main.rs".to_string()];
    while forms.len() < entries {
        let parent = dirs[rng.below(dirs.len())].clone();
        let stem = format!(
            "{parent}{}{}{}{}",
            rng.pick(&WORDS),
            rng.pick(&MARKS),
            rng.pick(&WORDS),
            forms.len()
        );
        if parent.matches('/').count() < 4 && rng.below(8) == 0 {
            std::fs::create_dir(base.join(&stem)).expect("mkdir");
            dirs.push(format!("{stem}/"));
            forms.push(format!("{stem}/"));
        } else {
            let rel = format!("{stem}{}", rng.pick(&EXTENSIONS));
            std::fs::write(base.join(&rel), "x").expect("write");
            forms.push(rel);
        }
    }
    forms
}

/// Queries over a random tree: the bare query, metacharacter and Unicode fragments (an
/// invalid regex among them), and from real entries their exact names, prefixes,
/// substrings, case variants, scoped, `./` scoped, and full-path shapes.
fn random_queries(forms: &[String], rng: &mut XorShift) -> Vec<String> {
    let mut queries: Vec<String> = [
        "", ".", "-", "#", "&", "~", "+", "(", "[", "$", ".*", "s.c", "[a-z]+0", "é", "ß", "SS",
        "İ", "i", "ſ", "s", "日本", "🦀", "MAIN", "./", "./main", "ignored/",
    ]
    .map(String::from)
    .to_vec();
    queries.push("ignored/Ig".to_string());
    for _ in 0..8 {
        let form = &forms[rng.below(forms.len())];
        let path = fuzzy_file_search::form_trimmed(form);
        let name: Vec<char> = fuzzy_file_search::form_name(form).chars().collect();
        let start = rng.below(name.len());
        let end = start + 1 + rng.below(name.len() - start);
        let part: String = name[start..end].iter().collect();
        queries.push(name.iter().collect());
        queries.push(name[..end].iter().collect());
        queries.push(part.to_uppercase());
        queries.push(part.to_lowercase());
        if let Some((parent, _)) = path.rsplit_once('/') {
            let parent_name = parent.rsplit('/').next().unwrap_or_default();
            queries.push(format!("{parent}/{part}"));
            queries.push(format!("./{parent}/"));
            queries.push(format!("{parent_name}/{part}"));
        }
        queries.push(part);
    }
    queries
}

/// The index answers what the full, uncut walk ranks — fd's walk rules, the shared
/// matcher, and the shared ranking — on random trees, one small and one large enough
/// for a multi-chunk scan; where the walk's result cut cannot apply (at most
/// [`fuzzy_file_search::MAX_WALK_RESULTS`] matches), the walk provider answers the same.
#[test]
fn at_index_matches_the_walk_on_random_trees() {
    const SEEDS: u64 = 1;
    let large = (2 * file_index::SCAN_CHUNK_MIN).max(32_768) + 1_000;
    for seed in 0..SEEDS {
        for entries in [300, large] {
            let mut rng = XorShift(0x9E37_79B9_7F4A_7C15 ^ seed);
            let outer = tempfile::TempDir::new().expect("temp dir");
            let base = outer.path().join("base");
            let forms = random_tree(&base, &mut rng, entries);
            let indexed = provider(base.to_str().expect("utf8"));
            let walked = provider(base.to_str().expect("utf8"));
            assert!(indexed
                .file_index
                .build(&base, file_index::MAX_INDEX_ENTRIES));
            assert!(!walked.file_index.build(&base, 1));
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let mut walks: HashMap<std::path::PathBuf, Vec<String>> = HashMap::new();
            for query in random_queries(&forms, &mut rng) {
                let at_prefix = format!("@{query}");
                let mut matched = 0;
                let expected =
                    fuzzy_file_search::resolve_search(&base, &at_prefix, &cancel, |search, _| {
                        let walk =
                            walks
                                .entry(search.walk_base.to_path_buf())
                                .or_insert_with(|| {
                                    fuzzy_file_search::walk_builder(search.walk_base)
                                        .build()
                                        .filter_map(Result::ok)
                                        .filter_map(|entry| {
                                            fuzzy_file_search::fd_printed_form(
                                                &entry,
                                                search.walk_base,
                                            )
                                        })
                                        .collect()
                                });
                        let walk_base = search.walk_base.to_string_lossy();
                        let mut target = String::new();
                        let found: Vec<&String> = walk
                            .iter()
                            .filter(|form| search.matches(&walk_base, form, &mut target))
                            .collect();
                        matched = found.len();
                        fuzzy_file_search::suggestions(
                            fuzzy_file_search::top_ranked(
                                found.into_iter().filter_map(|form| search.score(form)),
                            ),
                            search,
                        )
                    })
                    .map(|suggestions| suggestions.items)
                    .unwrap_or_default();
                let context = format!("seed {seed}, {entries} entries, query {at_prefix}");
                assert_eq!(at_values(&indexed, &at_prefix), expected, "{context}");
                if matched <= fuzzy_file_search::MAX_WALK_RESULTS {
                    assert_eq!(at_values(&walked, &at_prefix), expected, "{context}");
                }
            }
        }
    }
}

/// Watched changes land: a new file and a new directory with a file appear in the
/// index, and vanish with their deletion. The bounded polling waits on external
/// OS events.
#[test]
fn at_index_tracks_watcher_events() {
    let outer = parity_fixture();
    let base = outer.path().join("base");
    let provider = provider(base.to_str().expect("utf8"));
    assert!(provider
        .file_index
        .build(&base, file_index::MAX_INDEX_ENTRIES));
    let values = |query: &str| {
        at_values(&provider, &format!("@{query}"))
            .into_iter()
            .map(|item| item.value)
            .collect::<Vec<_>>()
    };
    let settle = |present: bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let settled = if present {
                values("watched.rs").contains(&"@watched.rs".to_string())
                    && values("watched_dir").contains(&"@watched_dir/".to_string())
                    && values("inside").contains(&"@watched_dir/inside.rs".to_string())
            } else {
                values("watched.rs").is_empty()
                    && values("watched_dir").is_empty()
                    && values("inside").is_empty()
            };
            if settled {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the watcher never settled the entries (present={present})"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    };
    std::fs::write(base.join("watched.rs"), "x").expect("write");
    std::fs::create_dir_all(base.join("watched_dir")).expect("mkdir");
    std::fs::write(base.join("watched_dir/inside.rs"), "x").expect("write");
    settle(true);
    // A directory replaced by a file drops the directory's descendants too.
    std::fs::remove_dir_all(base.join("watched_dir")).expect("remove");
    std::fs::write(base.join("watched_dir"), "x").expect("write");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let replaced = values("inside").is_empty()
            && values("watched_dir").contains(&"@watched_dir".to_string());
        if replaced {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the watcher never settled the replaced directory"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    std::fs::remove_file(base.join("watched.rs")).expect("remove");
    std::fs::remove_file(base.join("watched_dir")).expect("remove");
    settle(false);
    // A deleted session base drops the whole index: the next query rebuilds into
    // whatever the tree still holds (nothing) instead of serving stale entries.
    std::fs::remove_dir_all(base).expect("remove");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if values("par").is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the watcher never dropped the deleted base's index"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}
