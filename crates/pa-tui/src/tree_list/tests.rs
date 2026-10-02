use super::*;
use crate::tree_nodes::{build_tree, TreeNodeData};
use serde_json::Map;

fn message_node(id: &str, parent: Option<&str>, timestamp: &str, text: &str) -> TreeNodeData {
    TreeNodeData {
        entry: FileEntry::Message {
            message: pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Map::default(),
            }),
            base: pa_types::session::EntryBase {
                id: Some(id.to_string()),
                parent_id: parent.map(str::to_string),
                timestamp: Some(timestamp.to_string()),
                rest: Map::default(),
            },
        },
        label: None,
        label_timestamp: None,
    }
}

fn assistant_node(id: &str, parent: Option<&str>, timestamp: &str) -> TreeNodeData {
    TreeNodeData {
        entry: FileEntry::Message {
            message: pa_types::session::AgentMessage::Assistant(pa_types::ai::AssistantMessage {
                content: vec![],
                api: "openai-completions".to_string(),
                provider: "openai".to_string(),
                model: "m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Map::default(),
            }),
            base: pa_types::session::EntryBase {
                id: Some(id.to_string()),
                parent_id: parent.map(str::to_string),
                timestamp: Some(timestamp.to_string()),
                rest: Map::default(),
            },
        },
        label: None,
        label_timestamp: None,
    }
}

fn assistant_text_node(
    id: &str,
    parent: Option<&str>,
    timestamp: &str,
    text: &str,
) -> TreeNodeData {
    let mut node = assistant_node(id, parent, timestamp);
    if let FileEntry::Message {
        message: pa_types::session::AgentMessage::Assistant(assistant),
        ..
    } = &mut node.entry
    {
        assistant.content = vec![pa_types::ai::AssistantContentBlock::Text(
            pa_types::ai::TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: Map::default(),
            },
        )];
    }
    node
}

fn settings_node(id: &str, parent: Option<&str>, timestamp: &str) -> TreeNodeData {
    TreeNodeData {
        entry: FileEntry::ModelChange {
            payload: pa_types::session::ModelChangeEntry {
                provider: "openai".to_string(),
                model_id: "m".to_string(),
            },
            base: pa_types::session::EntryBase {
                id: Some(id.to_string()),
                parent_id: parent.map(str::to_string),
                timestamp: Some(timestamp.to_string()),
                rest: Map::default(),
            },
        },
        label: None,
        label_timestamp: None,
    }
}

fn list(flat: Vec<TreeNodeData>, leaf: Option<&str>) -> TreeList {
    TreeList::new(
        &build_tree(flat),
        leaf.map(str::to_string),
        40,
        None,
        FilterMode::Default,
    )
}

#[test]
fn default_view_hides_settings_entries() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        settings_node("m1", Some("u1"), "2024-01-01T00:00:02.000Z"),
        assistant_node("a1", Some("m1"), "2024-01-01T00:00:03.000Z"),
    ];
    let tree = list(flat, Some("a1"));
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    // The model change is hidden; the user and assistant rows stay.
    assert_eq!(visible, vec!["u1", "a1"]);
    // The active leaf leads the initial selection.
    assert_eq!(tree.selected_id().as_deref(), Some("a1"));
}

#[test]
fn user_only_and_all_filters() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        settings_node("m1", Some("u1"), "2024-01-01T00:00:02.000Z"),
        assistant_node("a1", Some("m1"), "2024-01-01T00:00:03.000Z"),
    ];
    let mut tree = list(flat, Some("a1"));
    tree.filter_mode = FilterMode::UserOnly;
    tree.apply_filter();
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["u1"]);
    tree.filter_mode = FilterMode::All;
    tree.apply_filter();
    assert_eq!(tree.filtered.len(), 3);
}

#[test]
fn branch_move_selects_nearest_visible_ancestor() {
    // u1 -> a1 -> u2 (leaf), u3 sibling under a1.
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
        message_node("u3", Some("a1"), "2024-01-01T00:00:04.000Z", "sibling"),
    ];
    let mut tree = list(flat, Some("u2"));
    assert_eq!(tree.selected_id().as_deref(), Some("u2"));
    // Folding u1 hides its subtree; the cursor walks up to u1.
    tree.folded.insert("u1".to_string());
    tree.apply_filter();
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["u1"], "descendants hidden: {visible:?}");
    assert_eq!(tree.selected_id().as_deref(), Some("u1"));
    // Unfolding restores the rows and the cursor stays on u1.
    tree.folded.clear();
    tree.apply_filter();
    assert_eq!(tree.selected_id().as_deref(), Some("u1"));
}

#[test]
fn search_filters_and_backspace_restores() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "fix the parser"),
        assistant_text_node(
            "a1",
            Some("u1"),
            "2024-01-01T00:00:02.000Z",
            "parser answer",
        ),
        message_node(
            "u2",
            Some("a1"),
            "2024-01-01T00:00:03.000Z",
            "second request",
        ),
    ];
    let kb = KeybindingsManager::new();
    let mut tree = list(flat, Some("u2"));
    for ch in ["p", "a", "r", "s", "e", "r"] {
        tree.handle_key(&kb, ch);
    }
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["u1", "a1"]);
    // Escape with a query clears the search instead of closing.
    tree.handle_key(&kb, "escape");
    assert_eq!(tree.search_query(), "");
    assert_eq!(tree.filtered.len(), 3);
    // Backspace pops one character.
    for ch in ["s", "e", "c", "o", "n", "d"] {
        tree.handle_key(&kb, ch);
    }
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["u2"]);
    tree.handle_key(&kb, "backspace");
    assert_eq!(tree.search_query(), "secon");
}

/// One bracketed paste joins the search query: TS's raw-data gate drops
/// the control bytes, the printable text joins, and the filter re-runs.
#[test]
fn a_paste_joins_the_search_query() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "fix the parser"),
        assistant_text_node(
            "a1",
            Some("u1"),
            "2024-01-01T00:00:02.000Z",
            "parser answer",
        ),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
    ];
    let mut tree = list(flat, Some("u2"));
    tree.paste("parser");
    assert_eq!(tree.search_query(), "parser");
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["u1", "a1"]);
    // The control bytes drop; the printable text around them joins.
    tree.paste("\u{1b}]8;;x\u{7}r");
    assert_eq!(tree.search_query(), "parser]8;;xr");
    // A control-only paste joins nothing.
    tree.paste("\u{1b}\u{7}");
    assert_eq!(tree.search_query(), "parser]8;;xr");
}

/// TS's final arm reads the RAW key data: only printable characters
/// join the query, and every special key arrives as an escape sequence (a
/// control character) and drops. This port receives parsed ids, so the
/// same decode gates the append: the bare multi-character ids ("space",
/// "delete", "home") must never join the query as their own names.
#[test]
fn named_key_ids_never_join_the_search_query() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "second"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "third"),
    ];
    let kb = KeybindingsManager::new();
    let mut tree = list(flat, Some("u2"));
    for key in ["s", "e"] {
        tree.handle_key(&kb, key);
    }
    assert_eq!(tree.search_query(), "se");
    // The named keys join nothing: delete/home drop, exactly as TS's
    // control-character check drops their escape sequences.
    tree.handle_key(&kb, "delete");
    tree.handle_key(&kb, "home");
    assert_eq!(tree.search_query(), "se");
}

/// The space key id types a space (TS appends the raw 0x20; the port
/// receives the `space` id).
#[test]
fn the_space_key_id_types_a_space() {
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "second"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "third"),
    ];
    let kb = KeybindingsManager::new();
    let mut tree = list(flat, Some("u2"));
    for key in ["s", "e", "space", "c", "o", "n", "d"] {
        tree.handle_key(&kb, key);
    }
    assert_eq!(tree.search_query(), "se cond");
    // The query with the space still matches the text with the space.
    let visible: Vec<&str> = tree
        .filtered
        .iter()
        .map(|index| tree.flat[*index].data.entry.id().unwrap())
        .collect();
    assert_eq!(visible, vec!["a1"], "the space is part of the match");
}

#[test]
fn user_only_filter_keeps_hidden_intermediates_out_of_the_visible_tree() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    // u1 -> a1 -> u2 (leaf): the user-only filter hides a1, and the
    // hidden assistant must not join the visible tree (a stray child
    // would branch u1 and give u2 a connector).
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
    ];
    let mut tree = list(flat, Some("u2"));
    let kb = KeybindingsManager::new();
    tree.handle_key(&kb, "ctrl+u");
    let rows = tree.render(&theme, 80);
    let joined: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    // Two user rows, both flat: no connector characters on either.
    assert!(
        joined.iter().any(|row| row.contains("user: first")),
        "{joined:?}"
    );
    assert!(
        joined.iter().any(|row| row.contains("user: second")),
        "{joined:?}"
    );
    assert!(
        !joined
            .iter()
            .any(|row| row.contains("└") || row.contains("├")),
        "the hidden assistant did not branch the visible tree: {joined:?}"
    );
}

#[test]
fn fold_or_up_moves_to_branch_segment() {
    // u1 -> a1 -> u2 (leaf).
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
    ];
    let kb = KeybindingsManager::new();
    let mut tree = list(flat, Some("u2"));
    // From the leaf, fold-or-up walks the visible parent chain; u2 is
    // already the segment start, so the walk continues to the root (TS
    // findBranchSegmentStart "up").
    tree.handle_key(&kb, "ctrl+left");
    assert_eq!(tree.selected_id().as_deref(), Some("u1"));
    // Unfold-or-down follows the single-child chain to the leaf.
    tree.handle_key(&kb, "ctrl+right");
    assert_eq!(tree.selected_id().as_deref(), Some("u2"));
}

#[test]
fn render_marks_active_path_and_connectors() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    // u1 -> a1 -> u2 (leaf) plus sibling u3.
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
        assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
        message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
        message_node("u3", Some("a1"), "2024-01-01T00:00:04.000Z", "sibling"),
    ];
    let tree = list(flat, Some("u2"));
    let rows = tree.render(&theme, 100);
    let text: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect();
    // The active branch (u1, a1, u2) carries the path marker; the
    // selected row is the leaf.
    assert!(text[0].starts_with("  •"), "path marker: {:?}", text[0]);
    let selected = text
        .iter()
        .find(|row| row.starts_with("› "))
        .expect("selected row");
    assert!(selected.contains("• user: second"), "selected: {selected}");
    let sibling = text
        .iter()
        .find(|row| row.contains("sibling"))
        .expect("sibling row");
    assert!(
        sibling.contains("└─") && sibling.contains("user: sibling"),
        "connector: {sibling}"
    );
    // The counter row closes the list.
    assert!(text.last().unwrap().starts_with("  ("));
}

#[test]
fn label_update_round_trips() {
    let flat = vec![message_node(
        "u1",
        None,
        "2024-01-01T00:00:01.000Z",
        "first",
    )];
    let mut tree = list(flat, Some("u1"));
    tree.update_node_label(
        "u1",
        Some("checkpoint".to_string()),
        "2024-01-02T00:00:00.000Z",
    );
    assert_eq!(tree.label_of("u1").as_deref(), Some("checkpoint"));
    tree.update_node_label("u1", None, "");
    assert_eq!(tree.label_of("u1"), None);
}

#[test]
fn deep_chain_walks_and_renders() {
    // A linear session nests one level per entry: the parent-chain
    // walks (the active path, the nearest-visible selection) are
    // id-indexed, so the full depth stays linear instead of scanning
    // the list once per hop.
    let depth = 5_000;
    let mut flat: Vec<TreeNodeData> = Vec::with_capacity(depth);
    let mut parent: Option<String> = None;
    for step in 0..depth {
        let id = format!("n{step}");
        flat.push(message_node(
            &id,
            parent.as_deref(),
            "2024-01-01T00:00:00.000Z",
            &format!("m{step}"),
        ));
        parent = Some(id);
    }
    let leaf = format!("n{}", depth - 1);
    let tree = list(flat, Some(&leaf));
    assert_eq!(tree.selected_id().as_deref(), Some(leaf.as_str()));
    assert_eq!(tree.active_path.len(), depth);
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let rows = tree.render(&theme, 80);
    assert_eq!(rows.len(), 41, "max_visible rows plus the counter");
    let text: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect();
    let counter = text.last().map(String::as_str).unwrap_or_default();
    assert!(counter.contains("(5000/5000)"), "counter: {text:?}");
}

#[test]
fn zero_and_tiny_widths_render_wide_glyphs() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    // Wide glyphs at the cut boundary exercise the grapheme-aware
    // truncation: no row may exceed the budget, not even at zero.
    let flat = vec![
        message_node("u1", None, "2024-01-01T00:00:01.000Z", "wide 漢字 text"),
        message_node("u2", Some("u1"), "2024-01-01T00:00:02.000Z", "second"),
    ];
    let tree = list(flat, Some("u2"));
    for width in [0, 1, 3] {
        let rows = tree.render(&theme, width);
        for (row_index, row) in rows.iter().enumerate() {
            let rendered: usize = row.iter().map(|span| str_width(&span.content)).sum();
            assert!(
                rendered <= width,
                "row {row_index} wider than {width}: {rendered}"
            );
        }
    }
}
