//! The `/tree` selector surface: the bordered pane over the tree list,
//! its label-edit input, and the post-selection "Summarize branch?"
//! choice (TS `TreeSelectorComponent`).

use crate::keybindings::KeybindingsManager;
use crate::search_input::SearchInput;
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
    /// Navigate to the entry (the daemon `navigate_tree` call).
    Navigate {
        target_id: String,
        summarize: bool,
        custom_instructions: Option<String>,
    },
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
    /// The label input for one entry (TS `LabelInput`): the search
    /// input holds the draft, so its full edit grammar (Backspace,
    /// Delete, the word/line kills) owns the non-intercepted keys.
    LabelInput {
        entry_id: String,
        input: SearchInput,
    },
    /// "Summarize branch?" (the TS three-option selector).
    Summarize { target_id: String, selected: usize },
    /// Custom summarization instructions (the TS inline editor).
    CustomPrompt {
        target_id: String,
        input: SearchInput,
    },
}

const SUMMARIZE_OPTIONS: [&str; 3] = ["No summary", "Summarize", "Summarize with custom prompt"];

/// The `/tree` selector.
pub struct TreeSelector {
    list: TreeList,
    mode: Mode,
    /// The `branchSummary.skipPrompt` setting: select navigates
    /// directly with no summary instead of asking.
    skip_summarize_prompt: bool,
}

impl TreeSelector {
    /// Build the selector over the `get_session_tree` response data.
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
        let list = TreeList::new(&tree, leaf_id, max_visible_lines, None, initial_filter_mode);
        Some(TreeSelector {
            list,
            mode: Mode::Tree,
            skip_summarize_prompt,
        })
    }

    /// The current leaf id (the caller's no-op check).
    #[must_use]
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.list.current_leaf_id()
    }

    /// Re-open helper: after a cancelled branch summary, TS re-shows
    /// the selector with the same selection.
    pub fn set_initial_selection(&mut self, entry_id: Option<&str>) {
        self.list.move_selection_to(entry_id);
    }

    /// Apply a saved label locally.
    pub fn update_label(&mut self, entry_id: &str, label: Option<&str>) {
        self.list
            .update_node_label(entry_id, label.map(str::to_string), "");
    }

    /// One bracketed paste (TS routes the raw data to the open input):
    /// the label and custom-prompt inputs take it, the tree search
    /// appends it, and the summarize choice list consumes it.
    pub fn paste(&mut self, text: &str) {
        match &mut self.mode {
            Mode::Tree => self.list.paste(text),
            Mode::LabelInput { input, .. } | Mode::CustomPrompt { input, .. } => input.paste(text),
            Mode::Summarize { .. } => {}
        }
    }

    /// Handle one key id; the emitted action carries the caller's work.
    pub fn handle_key(&mut self, kb: &KeybindingsManager, id: &str) -> TreeSelectorAction {
        match &mut self.mode {
            Mode::Tree => match self.list.handle_key(kb, id) {
                TreeListAction::Select(target_id) => {
                    if self.skip_summarize_prompt {
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
                    // TS `LabelInput` seeds the input with the current label
                    // (`setValue`, which leaves the caret at 0); the port's
                    // prefill puts it at the end.
                    let current = self.list.label_of(&entry_id).unwrap_or_default();
                    let mut input = SearchInput::new();
                    input.prefill(&current);
                    self.mode = Mode::LabelInput { entry_id, input };
                    TreeSelectorAction::None
                }
                TreeListAction::None => TreeSelectorAction::None,
            },
            Mode::LabelInput { entry_id, input } => {
                if kb.matches(id, "tui.select.confirm") {
                    let label = input.value().trim().to_string();
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
                } else {
                    // TS `LabelInput.handleInput`: every other key id goes whole to the input.
                    input.handle_key(id, kb);
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
                                input: SearchInput::new(),
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
                    let instructions = input.value().trim().to_string();
                    let target_id = target_id.clone();
                    self.mode = Mode::Tree;
                    TreeSelectorAction::Navigate {
                        target_id,
                        summarize: true,
                        custom_instructions: (!instructions.is_empty()).then_some(instructions),
                    }
                } else if kb.matches(id, "tui.select.cancel") {
                    // A cancelled editor loops back to the choice.
                    let target_id = target_id.clone();
                    self.mode = Mode::Summarize {
                        target_id,
                        selected: 2,
                    };
                    TreeSelectorAction::None
                } else {
                    // TS's custom-prompt editor (`ExtensionEditorComponent`) takes
                    // every other key id whole.
                    input.handle_key(id, kb);
                    TreeSelectorAction::None
                }
            }
        }
    }

    /// The full pane.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let border = || vec![theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))];
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Vec::new());
        lines.push(border());
        // The margin makes three leading spaces.
        lines.push(vec![crate::Span::raw("   Session Tree")]);
        // The label, filter, cycle, and time keys render from the
        // effective bindings (an override moves the hint with the
        // handler); the arrows stay TS's literal glyphs. An emptied
        // binding drops its key, and a part with every binding empty
        // drops its whole segment.
        let first = |id: &str| {
            kb.first_key(id)
                .map(|key| crate::keybindings::format_key_text(&key))
        };
        let bound = |ids: &[&str]| {
            let keys: Vec<String> = ids.iter().filter_map(|id| first(id)).collect();
            (!keys.is_empty()).then(|| keys.join("/"))
        };
        let mut parts =
            vec!["  ↑/↓: move. ←/→: page. ^←/^→ or Alt+←/Alt+→: fold/branch.".to_string()];
        if let Some(label) = first("app.tree.editLabel") {
            parts.push(format!("{label}: label."));
        }
        if let Some(filters) = bound(&[
            "app.tree.filter.default",
            "app.tree.filter.noTools",
            "app.tree.filter.userOnly",
            "app.tree.filter.labeledOnly",
            "app.tree.filter.all",
        ]) {
            match bound(&[
                "app.tree.filter.cycleForward",
                "app.tree.filter.cycleBackward",
            ]) {
                Some(cycle) => parts.push(format!("{filters}: filters ({cycle} cycle).")),
                None => parts.push(format!("{filters}: filters.")),
            }
        }
        if let Some(time) = first("app.tree.toggleLabelTimestamp") {
            parts.push(format!("{time}: label time"));
        }
        // `TruncatedText` appends a plain `...` after the color reset.
        let hints_line = vec![theme.fg_span(ThemeColor::Muted, parts.join(" "))];
        if line_width(&hints_line) > width {
            let mut hints = truncate_line(&hints_line, width.saturating_sub(3), "");
            hints.push(crate::Span::raw("..."));
            lines.push(hints);
        } else {
            lines.push(truncate_line(&hints_line, width, ""));
        }
        // The two-space indent sits outside the muted escape.
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
                        lines.extend(render_choice(theme, width, kb, *selected));
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
                        lines.push(input_row(theme, width, input));
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
                lines.push(input_row(theme, width, input));
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

/// The key pair every inner pane's bottom hint renders: each segment
/// carries its binding's first effective key.
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

/// The input panes' field row (TS `LabelInput.render`): the two-space
/// indent, then `Input.render` at the remaining width with its caret.
fn input_row(theme: &Theme, width: usize, input: &SearchInput) -> Line {
    let mut row = vec![crate::Span::raw("  ")];
    row.extend(crate::menu_panel::input_render(
        theme,
        width.saturating_sub(2),
        input.value(),
        input.cursor(),
        /*focused*/ true,
    ));
    truncate_line(&row, width, "")
}

/// Render the summarize choice list (the three TS options; row one is
/// "No summary").
fn render_choice(
    theme: &Theme,
    width: usize,
    kb: &KeybindingsManager,
    selected: usize,
) -> Vec<Line> {
    let mut lines = vec![truncate_line(
        &vec![theme.fg_span(ThemeColor::Muted, "  Summarize branch?".to_string())],
        width,
        "",
    )];
    for (index, option) in SUMMARIZE_OPTIONS.iter().enumerate() {
        let row = if index == selected {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::{json, Value};

    /// A selector over one visible user-message node (the default filter
    /// hides settings-class entries, so the fixtures use `wire_chain`).
    fn selector() -> TreeSelector {
        TreeSelector::new(&wire_chain(1), 40, false, FilterMode::Default)
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

    #[test]
    fn tree_hint_drops_unbound_keys_and_segments() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("app.tree.filter.noTools".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let text = frame_text(&selector().render(&theme, 200, &kb));
        assert!(
            text.contains("Ctrl+D/Ctrl+U/Ctrl+L/Ctrl+A: filters ("),
            "the emptied filter leaves no blank slot: {text}"
        );
        assert!(!text.contains("//"), "no empty key slot: {text}");
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        for id in [
            "app.tree.filter.cycleForward",
            "app.tree.filter.cycleBackward",
        ] {
            cfg.insert(id.to_string(), Vec::new());
        }
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let text = frame_text(&selector().render(&theme, 200, &kb));
        assert!(
            text.contains("Ctrl+D/Ctrl+T/Ctrl+U/Ctrl+L/Ctrl+A: filters."),
            "the cycle suffix drops with its keys: {text}"
        );
        assert!(!text.contains("cycle"), "{text}");
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        for id in [
            "app.tree.filter.default",
            "app.tree.filter.noTools",
            "app.tree.filter.userOnly",
            "app.tree.filter.labeledOnly",
            "app.tree.filter.all",
        ] {
            cfg.insert(id.to_string(), Vec::new());
        }
        cfg.insert("app.tree.editLabel".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let text = frame_text(&selector().render(&theme, 200, &kb));
        assert!(!text.contains("filters"), "{text}");
        assert!(!text.contains("label."), "{text}");
        assert!(text.contains("Shift+T: label time"), "{text}");
    }

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
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("tui.select.cancel".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let mut sel = selector();
        sel.handle_key(&kb, "enter");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("  Enter select\n"), "{text}");
        assert!(!text.contains("Esc back"), "{text}");
    }

    /// Every non-intercepted key reaches the label input: the typed
    /// space lands, ctrl+w deletes the trailing word, ctrl+u clears the
    /// draft.
    #[test]
    fn label_input_edits_through_the_full_key_grammar() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let mut sel = selector();
        sel.handle_key(&kb, "shift+l");
        for key in ["a", "b", "space", "c", "d"] {
            sel.handle_key(&kb, key);
        }
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("ab cd"), "the typed space lands: {text}");
        sel.handle_key(&kb, "ctrl+w");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(
            text.contains("ab "),
            "ctrl+w deletes the trailing word: {text}"
        );
        // The cleared draft saves as the label's removal (TS
        // `onSubmit`'s empty-label arm — the frame's hint rows would
        // swallow a plain substring check, so the action carries the
        // proof).
        sel.handle_key(&kb, "ctrl+u");
        let action = sel.handle_key(&kb, "enter");
        assert_eq!(
            action,
            TreeSelectorAction::LabelChange {
                entry_id: "n0".to_string(),
                label: None,
            },
            "ctrl+u clears the label"
        );
        // The save hands a typed draft out (TS `onSubmit`).
        sel.handle_key(&kb, "shift+l");
        sel.handle_key(&kb, "x");
        let action = sel.handle_key(&kb, "enter");
        assert_eq!(
            action,
            TreeSelectorAction::LabelChange {
                entry_id: "n0".to_string(),
                label: Some("x".to_string()),
            }
        );
    }

    /// TS's custom-prompt editor (the `ExtensionEditorComponent`) hands
    /// every non-intercepted key to the full editor grammar.
    #[test]
    fn custom_prompt_edits_through_the_full_key_grammar() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let mut sel = selector();
        // Enter opens the summarize choice; its third option opens the
        // custom-prompt editor.
        sel.handle_key(&kb, "enter");
        sel.handle_key(&kb, "down");
        sel.handle_key(&kb, "down");
        sel.handle_key(&kb, "enter");
        for key in ["s", "u", "m", "space", "i", "t"] {
            sel.handle_key(&kb, key);
        }
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(text.contains("sum it"), "the typed space lands: {text}");
        sel.handle_key(&kb, "ctrl+w");
        let text = frame_text(&sel.render(&theme, 120, &kb));
        assert!(
            text.contains("sum "),
            "ctrl+w deletes the trailing word: {text}"
        );
        // Enter submits the trimmed instructions (TS `onSubmit`).
        let action = sel.handle_key(&kb, "enter");
        assert_eq!(
            action,
            TreeSelectorAction::Navigate {
                target_id: "n0".to_string(),
                summarize: true,
                custom_instructions: Some("sum".to_string()),
            }
        );
        // The cancel arm keeps its ladder: escape returns to the choice,
        // and Enter on the choice re-opens the editor with an empty draft
        // (TS's cancelled editor loops back to the choice — the frame's
        // hint rows would swallow a plain substring check, so the
        // submitted instructions carry the proof).
        let mut sel = selector();
        sel.handle_key(&kb, "enter");
        sel.handle_key(&kb, "down");
        sel.handle_key(&kb, "down");
        sel.handle_key(&kb, "enter");
        for key in ["o", "l", "d"] {
            sel.handle_key(&kb, key);
        }
        sel.handle_key(&kb, "escape");
        sel.handle_key(&kb, "enter");
        sel.handle_key(&kb, "b");
        let action = sel.handle_key(&kb, "enter");
        assert_eq!(
            action,
            TreeSelectorAction::Navigate {
                target_id: "n0".to_string(),
                summarize: true,
                custom_instructions: Some("b".to_string()),
            },
            "the reopened editor starts empty, so the draft is exactly the new keystroke"
        );
    }

    /// A paste lands in the active input (TS routes the raw data to the
    /// open `Input`): the label editor takes it, the tree search appends
    /// it, and the summarize choice list consumes it.
    #[test]
    fn a_paste_reaches_the_open_input() {
        let kb = KeybindingsManager::new();
        // The label input.
        let mut sel = selector();
        sel.handle_key(&kb, "shift+l");
        sel.paste("renamed");
        let value = match &sel.mode {
            Mode::LabelInput { input, .. } => input.value().to_string(),
            _ => panic!("the label input stays open"),
        };
        assert_eq!(value, "renamed");
        sel.handle_key(&kb, "escape");
        // The tree search appends it.
        sel.paste("chain");
        assert_eq!(sel.list.search_query(), "chain");
        // The summarize choice list consumes it (a fresh selector, the
        // search-filtered list above has no confirm target).
        let mut sel = selector();
        sel.handle_key(&kb, "enter");
        assert!(matches!(sel.mode, Mode::Summarize { .. }));
        sel.paste("ignored");
        assert_eq!(sel.list.search_query(), "");
    }

    /// The label pane draws its caret at the cursor (TS `Input.render`'s
    /// reversed cell): two lefts after "abc" put it on the "b".
    #[test]
    fn label_input_draws_the_caret_at_the_cursor() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let mut sel = selector();
        sel.handle_key(&kb, "shift+l");
        for key in ["a", "b", "c", "left", "left"] {
            sel.handle_key(&kb, key);
        }
        let frame = sel.render(&theme, 120, &kb);
        let is_caret = |span: &crate::Span| {
            span.style
                .add_modifier
                .contains(ratatui::style::Modifier::REVERSED)
        };
        let row = frame
            .iter()
            .find(|line| line.iter().any(is_caret))
            .expect("the label row draws a caret");
        let at = row.iter().position(is_caret).expect("the caret cell");
        let before: String = row[..at].iter().map(|span| span.content.as_str()).collect();
        assert_eq!((before.as_str(), row[at].content.as_str()), ("  a", "b"));
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

    /// A cycle-only or cycle-plus-clean-roots payload, with `leaf` as
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
        // of entries deep — build, walk, and render stay off the call
        // stack.
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
