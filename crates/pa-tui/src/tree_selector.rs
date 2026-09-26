//! The `/tree` selector surface: the bordered pane over the tree list, with
//! its label-edit input and the post-selection "Summarize branch?" choice
//! (TS `TreeSelectorComponent` + interactive-mode's navigate flow).

use crate::keybindings::KeybindingsManager;
use crate::theme::{Theme, ThemeColor};
use crate::tree_list::{FilterMode, TreeList, TreeListAction};
use crate::tree_nodes::{build_tree, TreeNode};
use crate::width::{line_width, truncate_line};
use crate::Line;
use serde_json::Value;

/// What the caller must run after a key press.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeSelectorAction {
    /// Nothing emitted; the view re-renders from the component state.
    None,
    /// Navigate to the entry (the daemon `navigate_tree` call), with the
    /// summarize choice resolved.
    Navigate {
        target_id: String,
        summarize: bool,
        custom_instructions: Option<String>,
    },
    /// The selector closed (Escape on the list).
    Cancel,
    /// A label was saved: persist it (`set_session_entry_label`).
    LabelChange {
        entry_id: String,
        label: Option<String>,
    },
}

/// The interactive modes inside the selector pane.
enum Mode {
    /// The tree list.
    Tree,
    /// The label input for one entry (TS `LabelInput`).
    LabelInput { entry_id: String, input: String },
    /// "Summarize branch?" (TS `showExtensionSelector` with the three
    /// options).
    Summarize { target_id: String, selected: usize },
    /// Custom summarization instructions (TS `showExtensionEditor`).
    CustomPrompt { target_id: String, input: String },
}

/// The summarize options, in order.
const SUMMARIZE_OPTIONS: [&str; 3] = ["No summary", "Summarize", "Summarize with custom prompt"];

/// The `/tree` selector.
pub struct TreeSelector {
    list: TreeList,
    mode: Mode,
    /// The `branchSummary.skipPrompt` setting: selecting a row navigates
    /// directly with no summary instead of asking.
    skip_summarize_prompt: bool,
}

impl TreeSelector {
    /// Build the selector over the `get_session_tree` response data.
    /// `skip_summarize_prompt` mirrors the `branchSummary.skipPrompt` setting
    /// (the choice pass is skipped, defaulting to no summary).
    pub fn new(
        data: &Value,
        terminal_rows: u16,
        skip_summarize_prompt: bool,
        initial_filter_mode: FilterMode,
    ) -> Option<Self> {
        let flat = crate::tree_nodes::parse_flat_nodes(data);
        if flat.is_empty() {
            return None;
        }
        let tree: Vec<TreeNode> = build_tree(flat);
        if tree.is_empty() {
            return None;
        }
        let leaf_id = data
            .get("leafId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let max_visible_lines = (terminal_rows as usize / 2).max(5);
        let list = TreeList::new(tree, leaf_id, max_visible_lines, None, initial_filter_mode);
        Some(TreeSelector {
            list,
            mode: Mode::Tree,
            skip_summarize_prompt,
        })
    }

    /// The current leaf id (the caller needs it for the "already at this
    /// point" no-op check).
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.list.current_leaf_id()
    }

    /// Re-open helper (TS re-shows the selector with the same selection
    /// after a cancelled branch summary): move the cursor to `entry_id`.
    pub fn set_initial_selection(&mut self, entry_id: Option<&str>) {
        self.list.move_selection_to(entry_id);
    }

    /// Apply a saved label locally (TS `updateNodeLabel`).
    pub fn update_label(&mut self, entry_id: &str, label: Option<&str>) {
        self.list
            .update_node_label(entry_id, label.map(str::to_string), "");
    }

    /// Handle one key id; the emitted action carries the caller's work.
    pub fn handle_key(&mut self, kb: &KeybindingsManager, id: &str) -> TreeSelectorAction {
        match &mut self.mode {
            Mode::Tree => match self.list.handle_key(kb, id) {
                TreeListAction::Select(target_id) => {
                    if self.skip_summarize_prompt {
                        // The skip-prompt setting: navigate with no summary.
                        TreeSelectorAction::Navigate {
                            target_id,
                            summarize: false,
                            custom_instructions: None,
                        }
                    } else {
                        self.mode = Mode::Summarize {
                            target_id,
                            selected: 0,
                        };
                        TreeSelectorAction::None
                    }
                }
                TreeListAction::Cancel => TreeSelectorAction::Cancel,
                TreeListAction::EditLabel(entry_id) => {
                    let current = self.list.label_of(&entry_id).unwrap_or_default();
                    self.mode = Mode::LabelInput {
                        entry_id,
                        input: current,
                    };
                    TreeSelectorAction::None
                }
                TreeListAction::None => TreeSelectorAction::None,
            },
            Mode::LabelInput { entry_id, input } => {
                if kb.matches(id, "tui.select.confirm") {
                    let label = input.trim().to_string();
                    let label = (!label.is_empty()).then_some(label);
                    let action = TreeSelectorAction::LabelChange {
                        entry_id: entry_id.clone(),
                        label,
                    };
                    self.mode = Mode::Tree;
                    action
                } else if kb.matches(id, "tui.select.cancel") {
                    self.mode = Mode::Tree;
                    TreeSelectorAction::None
                } else if kb.matches(id, "tui.editor.deleteCharBackward") {
                    input.pop();
                    TreeSelectorAction::None
                } else if let Some(ch) = printable(id) {
                    input.push(ch);
                    TreeSelectorAction::None
                } else {
                    TreeSelectorAction::None
                }
            }
            Mode::Summarize {
                target_id,
                selected,
            } => {
                if kb.matches(id, "tui.select.confirm") {
                    match *selected {
                        0 => {
                            let target_id = target_id.clone();
                            self.mode = Mode::Tree;
                            TreeSelectorAction::Navigate {
                                target_id,
                                summarize: false,
                                custom_instructions: None,
                            }
                        }
                        1 => {
                            let target_id = target_id.clone();
                            self.mode = Mode::Tree;
                            TreeSelectorAction::Navigate {
                                target_id,
                                summarize: true,
                                custom_instructions: None,
                            }
                        }
                        _ => {
                            let target_id = target_id.clone();
                            self.mode = Mode::CustomPrompt {
                                target_id,
                                input: String::new(),
                            };
                            TreeSelectorAction::None
                        }
                    }
                } else if kb.matches(id, "tui.select.up") {
                    *selected = (*selected + SUMMARIZE_OPTIONS.len() - 1) % SUMMARIZE_OPTIONS.len();
                    TreeSelectorAction::None
                } else if kb.matches(id, "tui.select.down") {
                    *selected = (*selected + 1) % SUMMARIZE_OPTIONS.len();
                    TreeSelectorAction::None
                } else if kb.matches(id, "tui.select.cancel") {
                    // Escape re-opens the tree with the same selection.
                    self.mode = Mode::Tree;
                    TreeSelectorAction::None
                } else {
                    TreeSelectorAction::None
                }
            }
            Mode::CustomPrompt { target_id, input } => {
                if kb.matches(id, "tui.select.confirm") {
                    let instructions = input.trim().to_string();
                    let target_id = target_id.clone();
                    self.mode = Mode::Tree;
                    TreeSelectorAction::Navigate {
                        target_id,
                        summarize: true,
                        custom_instructions: (!instructions.is_empty()).then_some(instructions),
                    }
                } else if kb.matches(id, "tui.select.cancel") {
                    // A cancelled editor loops back to the choice (TS).
                    let target_id = target_id.clone();
                    self.mode = Mode::Summarize {
                        target_id,
                        selected: 2,
                    };
                    TreeSelectorAction::None
                } else if kb.matches(id, "tui.editor.deleteCharBackward") {
                    input.pop();
                    TreeSelectorAction::None
                } else if let Some(ch) = printable(id) {
                    input.push(ch);
                    TreeSelectorAction::None
                } else {
                    TreeSelectorAction::None
                }
            }
        }
    }

    /// The full pane (TS `TreeSelectorComponent.render`): spacers, borders,
    /// title, hints, search line, the tree, and any active input.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let border = || vec![theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))];
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Vec::new());
        lines.push(border());
        // TS `new Text("  Session Tree", 1, 0)`: the text plus its margin
        // indent render as three leading spaces.
        lines.push(vec![crate::Span::raw("   Session Tree")]);
        // TS composes the hints from `keyText` lookups: every key part is
        // capitalized (`Shift+L`, `Ctrl+D`), and `TruncatedText` appends
        // `...` when the line exceeds the pane width. The label, filter,
        // cycle, and time keys render from the effective bindings, so a
        // user `keybindings.json` override moves the hint with the
        // handler; the move/page/fold arrows stay the literal glyphs TS
        // renders (`^←/^→ or Alt+←/Alt+→`).
        let key_text = |id: &str| crate::keybindings::format_key_text(&kb.get_keys(id).join("/"));
        let filter_keys = [
            "app.tree.filter.default",
            "app.tree.filter.noTools",
            "app.tree.filter.userOnly",
            "app.tree.filter.labeledOnly",
            "app.tree.filter.all",
        ]
        .iter()
        .map(|id| key_text(id))
        .collect::<Vec<_>>()
        .join("/");
        let cycle_keys = format!(
            "{}/{}",
            key_text("app.tree.filter.cycleForward"),
            key_text("app.tree.filter.cycleBackward")
        );
        let label_key = key_text("app.tree.editLabel");
        let time_key = key_text("app.tree.toggleLabelTimestamp");
        // `TruncatedText` cuts the colored string and appends a plain
        // `...` after the color reset.
        let hints_line = vec![theme.fg_span(
            ThemeColor::Muted,
            format!(
                "  ↑/↓: move. ←/→: page. ^←/^→ or Alt+←/Alt+→: fold/branch. {label_key}: label. {filter_keys}: filters ({cycle_keys} cycle). {time_key}: label time"
            ),
        )];
        if line_width(&hints_line) > width {
            let mut hints = truncate_line(&hints_line, width.saturating_sub(3), "");
            hints.push(crate::Span::raw("..."));
            lines.push(hints);
        } else {
            lines.push(truncate_line(&hints_line, width, ""));
        }
        // TS `SearchLine`: the two-space indent sits outside the muted
        // escape.
        let query = self.list.search_query();
        let search: Line = if query.is_empty() {
            vec![
                crate::Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "Type to search:".to_string()),
            ]
        } else {
            vec![
                crate::Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "Type to search: ".to_string()),
                theme.fg_span(ThemeColor::Accent, query.to_string()),
            ]
        };
        lines.push(truncate_line(&search, width, ""));
        lines.push(border());
        lines.push(Vec::new());
        match &self.mode {
            Mode::Tree | Mode::Summarize { .. } | Mode::CustomPrompt { .. } => {
                lines.extend(self.list.render(theme, width));
                match &self.mode {
                    Mode::Summarize { selected, .. } => {
                        lines.push(Vec::new());
                        lines.extend(render_choice(theme, width, kb, selected));
                    }
                    Mode::CustomPrompt { input, .. } => {
                        lines.push(Vec::new());
                        lines.push(truncate_line(
                            &vec![theme.fg_span(
                                ThemeColor::Muted,
                                "  Custom summarization instructions".to_string(),
                            )],
                            width,
                            "",
                        ));
                        let row = if input.is_empty() {
                            vec![crate::Span::raw("  ")]
                        } else {
                            vec![crate::Span::raw(format!("  {input}"))]
                        };
                        lines.push(truncate_line(&row, width, ""));
                        lines.push(truncate_line(
                            &vec![theme
                                .fg_span(ThemeColor::Muted, input_pane_hint(kb, "save", "cancel"))],
                            width,
                            "",
                        ));
                    }
                    _ => {}
                }
            }
            Mode::LabelInput { input, .. } => {
                lines.push(truncate_line(
                    &vec![
                        theme.fg_span(ThemeColor::Muted, "  Label (empty to remove):".to_string())
                    ],
                    width,
                    "",
                ));
                let row = if input.is_empty() {
                    vec![crate::Span::raw("  ")]
                } else {
                    vec![crate::Span::raw(format!("  {input}"))]
                };
                lines.push(truncate_line(&row, width, ""));
                lines.push(truncate_line(
                    &vec![theme.fg_span(ThemeColor::Muted, input_pane_hint(kb, "save", "cancel"))],
                    width,
                    "",
                ));
            }
        }
        lines.push(Vec::new());
        lines.push(border());
        lines
    }
}

/// The key pair every inner pane's bottom hint renders (TS
/// `ExtensionSelectorComponent`'s `keyHint` pair): each segment carries
/// its binding's first effective key — `tui.select.cancel` defaults to
/// two keys, and the one-line hint shows the primary, the crate's
/// `key_hint` grammar — and a user override that empties a binding
/// drops its segment, so the hint never advertises a default key the
/// pane no longer takes. The action words name what the keys do on that
/// pane.
fn input_pane_hint(kb: &KeybindingsManager, confirm_action: &str, cancel_action: &str) -> String {
    let segments = [
        crate::menu_panel::key_hint(kb, &["tui.select.confirm"], confirm_action),
        crate::menu_panel::key_hint(kb, &["tui.select.cancel"], cancel_action),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<String>>()
    .join("  ");
    format!("  {segments}")
}

/// Render the summarize choice list (the three TS options; row one is
/// "No summary").
fn render_choice(
    theme: &Theme,
    width: usize,
    kb: &KeybindingsManager,
    selected: &usize,
) -> Vec<Line> {
    let mut lines = vec![truncate_line(
        &vec![theme.fg_span(ThemeColor::Muted, "  Summarize branch?".to_string())],
        width,
        "",
    )];
    for (index, option) in SUMMARIZE_OPTIONS.iter().enumerate() {
        let row = if index == *selected {
            vec![
                theme.fg_span(ThemeColor::Accent, "› ".to_string()),
                crate::Span::raw(option.to_string()),
            ]
        } else {
            vec![crate::Span::raw(format!("  {option}"))]
        };
        lines.push(truncate_line(&row, width, ""));
    }
    lines.push(truncate_line(
        &vec![theme.fg_span(ThemeColor::Muted, input_pane_hint(kb, "select", "back"))],
        width,
        "",
    ));
    lines
}

/// One key id's printable character, when it is one (search/input typing).
fn printable(id: &str) -> Option<char> {
    let mut chars = id.chars();
    let c = chars.next()?;
    (chars.next().is_none() && !c.is_control()).then_some(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::{json, Value};

    fn selector_data() -> serde_json::Value {
        serde_json::json!({
            "flatNodes": [{
                "entry": {
                    "type": "custom",
                    "id": "c1",
                    "parentId": null,
                    "timestamp": "2024-01-01T00:00:00.000Z",
                    "customType": "x"
                }
            }],
            "leafId": "c1"
        })
    }

    fn selector() -> TreeSelector {
        TreeSelector::new(&selector_data(), 40, false, FilterMode::Default)
            .expect("a selector over one node")
    }

    fn frame_text(frame: &[Line]) -> String {
        frame
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The tree hint's label, filter, cycle, and time keys render from
    /// the effective bindings (TS composes them from `keyText`): the
    /// defaults match TS's stock string byte for byte, and a user
    /// override moves the hint with the handler instead of leaving the
    /// stale default behind.
    #[test]
    fn tree_hint_renders_the_effective_bindings() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let text = frame_text(&selector().render(&theme, 200, &kb));
        assert!(
            text.contains(
                "  \u{2191}/\u{2193}: move. \u{2190}/\u{2192}: page. ^\u{2190}/^\u{2192} or Alt+\u{2190}/Alt+\u{2192}: fold/branch. Shift+L: label. Ctrl+D/Ctrl+T/Ctrl+U/Ctrl+L/Ctrl+A: filters (Ctrl+O/Shift+Ctrl+O cycle). Shift+T: label time"
            ),
            "{text}"
        );
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("app.tree.editLabel".to_string(), vec!["ctrl+b".to_string()]);
        cfg.insert(
            "app.tree.filter.noTools".to_string(),
            vec!["ctrl+y".to_string()],
        );
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let text = frame_text(&selector().render(&theme, 200, &kb));
        assert!(text.contains("Ctrl+B: label"), "{text}");
        assert!(
            text.contains("Ctrl+D/Ctrl+Y/Ctrl+U/Ctrl+L/Ctrl+A: filters"),
            "{text}"
        );
        assert!(!text.contains("Shift+L: label"), "{text}");
    }

    /// The summarize pane's select/back pair and the input panes'
    /// save/cancel pair render from the effective bindings: each
    /// segment carries its binding's FIRST key (tui.select.cancel
    /// defaults to escape and ctrl+c; the one-line hint names the
    /// primary), and an override that empties a binding drops its
    /// segment instead of advertising the default key.
    #[test]
    fn inner_pane_hints_render_the_effective_bindings() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let mut sel = selector();
        sel.handle_key(&kb, "enter");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("  Enter select  Esc back"), "{text}");
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("tui.select.confirm".to_string(), vec!["ctrl+m".to_string()]);
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let mut sel = selector();
        sel.handle_key(&kb, "ctrl+m");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("  Ctrl+M select  Esc back"), "{text}");
        // An emptied cancel binding drops the back segment: the hint
        // keeps the confirm segment alone, never the default Esc.
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("tui.select.cancel".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let mut sel = selector();
        sel.handle_key(&kb, "enter");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("  Enter select\n"), "{text}");
        assert!(!text.contains("Esc back"), "{text}");
    }

    /// The `get_session_tree` wire payload of a linear chain of user
    /// messages `n0..n{depth-1}`, leaf at the far end.
    fn wire_chain(depth: usize) -> Value {
        let mut flat_nodes = Vec::with_capacity(depth);
        let mut parent: Option<String> = None;
        for step in 0..depth {
            let id = format!("n{step}");
            flat_nodes.push(json!({
                "entry": {
                    "type": "message",
                    "id": id,
                    "parentId": parent,
                    "timestamp": "2024-01-01T00:00:00.000Z",
                    "message": {
                        "role": "user",
                        "content": format!("m{step}"),
                        "timestamp": 0,
                    },
                },
            }));
            parent = Some(id);
        }
        json!({
            "flatNodes": flat_nodes,
            "leafId": format!("n{}", depth - 1),
        })
    }

    /// One cycle-only or cycle-plus-clean-roots payload, with `leaf` as
    /// the reported leaf.
    fn wire_parents(leaf: &str) -> Value {
        json!({
            "flatNodes": [
                {
                    "entry": {
                        "type": "message", "id": "a", "parentId": "b",
                        "timestamp": "2024-01-01T00:00:00.000Z",
                        "message": { "role": "user", "content": "a", "timestamp": 0 },
                    },
                },
                {
                    "entry": {
                        "type": "message", "id": "b", "parentId": "a",
                        "timestamp": "2024-01-01T00:00:01.000Z",
                        "message": { "role": "user", "content": "b", "timestamp": 0 },
                    },
                },
                {
                    "entry": {
                        "type": "message", "id": "r", "parentId": null,
                        "timestamp": "2024-01-01T00:00:02.000Z",
                        "message": { "role": "user", "content": "r", "timestamp": 0 },
                    },
                },
                {
                    "entry": {
                        "type": "message", "id": "c", "parentId": "r",
                        "timestamp": "2024-01-01T00:00:03.000Z",
                        "message": { "role": "user", "content": "c", "timestamp": 0 },
                    },
                },
            ],
            "leafId": leaf,
        })
    }

    fn rows_text(selector: &TreeSelector, theme: &Theme, width: usize) -> Vec<String> {
        selector
            .render(theme, width, &KeybindingsManager::new())
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    #[test]
    fn empty_wire_tree_returns_none() {
        // Empty data never opens the pane: the caller shows its
        // "No entries in session" note instead.
        let empty = json!({ "flatNodes": [], "leafId": null });
        assert!(
            TreeSelector::new(&empty, 40, false, FilterMode::Default).is_none(),
            "empty flatNodes must not open"
        );
        let missing = json!({ "leafId": null });
        assert!(
            TreeSelector::new(&missing, 40, false, FilterMode::Default).is_none(),
            "missing flatNodes must not open"
        );
    }

    #[test]
    fn deep_wire_chain_opens_and_renders() {
        // The operator's crash input: a linear session tens of thousands
        // of entries deep. Build, walk, and render all stay off the call
        // stack, and the leaf stays selected through the whole depth.
        let data = wire_chain(30_000);
        let selector =
            TreeSelector::new(&data, 24, false, FilterMode::Default).expect("deep chain opens");
        assert_eq!(selector.current_leaf_id(), Some("n29999"));
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let text = rows_text(&selector, &theme, 80);
        assert!(
            text.iter().any(|row| row.contains("(30000/30000)")),
            "counter: {text:?}"
        );
        assert!(
            text.iter().any(|row| row.contains("m29999")),
            "leaf row rendered: {text:?}"
        );
    }

    #[test]
    fn single_wire_node_renders() {
        let data = wire_chain(1);
        let selector =
            TreeSelector::new(&data, 24, false, FilterMode::Default).expect("single node opens");
        assert_eq!(selector.current_leaf_id(), Some("n0"));
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let text = rows_text(&selector, &theme, 40);
        assert!(text.iter().any(|row| row.contains("user: m0")), "{text:?}");
        assert!(text.iter().any(|row| row.contains("(1/1)")), "{text:?}");
    }

    #[test]
    fn zero_terminal_rows_and_zero_width_render() {
        // A zero-size terminal geometry must render, not panic: the pane
        // clamps its border and truncates every row to the budget.
        let data = wire_chain(2);
        let selector = TreeSelector::new(&data, 0, false, FilterMode::Default)
            .expect("selector opens at zero terminal rows");
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let rows = selector.render(&theme, 0, &KeybindingsManager::new());
        assert!(!rows.is_empty());
        let rows = selector.render(&theme, 1, &KeybindingsManager::new());
        assert!(!rows.is_empty());
    }

    #[test]
    fn parent_cycles_terminate() {
        // A cycle with no root yields an empty tree (the caller's empty
        // note); with a clean root present the pane opens, and a leaf
        // inside the cycle ends the parent-chain walks instead of
        // spinning.
        let cycle_only = json!({
            "flatNodes": [
                {
                    "entry": {
                        "type": "message", "id": "a", "parentId": "b",
                        "timestamp": "2024-01-01T00:00:00.000Z",
                        "message": { "role": "user", "content": "a", "timestamp": 0 },
                    },
                },
                {
                    "entry": {
                        "type": "message", "id": "b", "parentId": "a",
                        "timestamp": "2024-01-01T00:00:01.000Z",
                        "message": { "role": "user", "content": "b", "timestamp": 0 },
                    },
                },
            ],
            "leafId": "a",
        });
        assert!(TreeSelector::new(&cycle_only, 24, false, FilterMode::Default).is_none());
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        for leaf in ["c", "a"] {
            let selector = TreeSelector::new(&wire_parents(leaf), 24, false, FilterMode::Default)
                .expect("clean root survives a sibling cycle");
            assert_eq!(selector.current_leaf_id(), Some(leaf));
            let rows = selector.render(&theme, 60, &KeybindingsManager::new());
            assert!(!rows.is_empty());
        }
    }
}
