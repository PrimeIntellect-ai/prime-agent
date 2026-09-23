//! The `/hotkeys` guide (TS `getHotkeysGuide` in
//! `modes/interactive/interactive-mode.ts`): the full keyboard-shortcut
//! reference rendered from the EFFECTIVE bindings, so user
//! `keybindings.json` overrides show their keys in the guide.

use crate::keybindings::{format_key_text, KeybindingsManager};

/// TS `getAppKeyDisplay` / `getEditorKeyDisplay`: every effective key of
/// the binding joined with `/`, each part formatted for display
/// (`ctrl+o` -> `Ctrl+O`, arrows -> glyphs, `escape` -> `Esc`).
fn key_display(kb: &KeybindingsManager, id: &str) -> String {
    format_key_text(&kb.get_keys(id).join("/"))
}

/// The `/hotkeys` reference. Keys render from the effective binding set;
/// a disabled binding (an empty user override) omits its conditional row,
/// like TS (`${interrupt ? ...}`).
pub fn hotkeys_guide(kb: &KeybindingsManager) -> String {
    let cursor_up = key_display(kb, "tui.editor.cursorUp");
    let cursor_down = key_display(kb, "tui.editor.cursorDown");
    let cursor_left = key_display(kb, "tui.editor.cursorLeft");
    let cursor_right = key_display(kb, "tui.editor.cursorRight");
    let cursor_word_left = key_display(kb, "tui.editor.cursorWordLeft");
    let cursor_word_right = key_display(kb, "tui.editor.cursorWordRight");
    let cursor_line_start = key_display(kb, "tui.editor.cursorLineStart");
    let cursor_line_end = key_display(kb, "tui.editor.cursorLineEnd");
    let jump_forward = key_display(kb, "tui.editor.jumpForward");
    let jump_backward = key_display(kb, "tui.editor.jumpBackward");
    let page_up = key_display(kb, "tui.editor.pageUp");
    let page_down = key_display(kb, "tui.editor.pageDown");
    let submit = key_display(kb, "tui.input.submit");
    let new_line = key_display(kb, "tui.input.newLine");
    let delete_word_backward = key_display(kb, "tui.editor.deleteWordBackward");
    let delete_word_forward = key_display(kb, "tui.editor.deleteWordForward");
    let delete_to_line_start = key_display(kb, "tui.editor.deleteToLineStart");
    let delete_to_line_end = key_display(kb, "tui.editor.deleteToLineEnd");
    let yank = key_display(kb, "tui.editor.yank");
    let yank_pop = key_display(kb, "tui.editor.yankPop");
    let undo = key_display(kb, "tui.editor.undo");
    let tab = key_display(kb, "tui.input.tab");
    let clear = key_display(kb, "app.clear");
    let clear_input = key_display(kb, "app.input.clear");
    let interrupt = key_display(kb, "app.interrupt");
    let shortcuts_key = key_display(kb, "app.shortcuts");
    let exit = key_display(kb, "app.exit");
    let select_model = key_display(kb, "app.model.select");
    let expand_tools = key_display(kb, "app.tools.expand");
    let focus_subagents = key_display(kb, "app.subagents.focus");
    let manage_heartbeats = key_display(kb, "app.heartbeats.open");
    let external_editor = key_display(kb, "app.editor.external");
    let prompt_stash = key_display(kb, "app.prompt.stash");
    let follow_up = key_display(kb, "app.message.followUp");
    let browse_queue = key_display(kb, "app.message.navigateOlder");
    let reorder_queue = format!(
        "{} / {}",
        key_display(kb, "app.message.moveEarlier"),
        key_display(kb, "app.message.moveLater")
    );
    let paste_image = key_display(kb, "app.clipboard.pasteImage");
    let viewport_page_up = key_display(kb, "tui.viewport.pageUp");
    let viewport_page_down = key_display(kb, "tui.viewport.pageDown");
    let viewport_top = key_display(kb, "tui.viewport.top");
    let viewport_follow = key_display(kb, "tui.viewport.follow");

    let mut hotkeys = format!(
        r#"
**Navigation**
| Key | Action |
|-----|--------|
| `{cursor_up}` / `{cursor_down}` / `{cursor_left}` / `{cursor_right}` | Move cursor / browse history (Up when empty) |
| `{cursor_word_left}` / `{cursor_word_right}` | Move by word |
| `{cursor_line_start}` | Start of line |
| `{cursor_line_end}` | End of line |
| `{jump_forward}` | Jump forward to character |
| `{jump_backward}` | Jump backward to character |
| `{page_up}` / `{page_down}` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| `{submit}` | Send message |
| `{new_line}` | New line |
| `{delete_word_backward}` | Delete word backwards |
| `{delete_word_forward}` | Delete word forwards |
| `{delete_to_line_start}` | Delete to start of line |
| `{delete_to_line_end}` | Delete to end of line |
| `{yank}` | Paste the most-recently-deleted text |
| `{yank_pop}` | Cycle through the deleted text after pasting |
| `{undo}` | Undo |

**Other**
| Key | Action |
|-----|--------|
| `{tab}` | Path completion / accept autocomplete |
| `{clear_input}` | Clear input / cancel autocomplete |
| `{clear}` | Interrupt current operation (first) / exit (second) |
"#
    );
    if !interrupt.is_empty() {
        hotkeys.push_str(&format!(
            "| `{interrupt}` | Interrupt current operation |\n"
        ));
    }
    if !shortcuts_key.is_empty() {
        hotkeys.push_str(&format!("| `{shortcuts_key}` | Show quick shortcuts |\n"));
    }
    hotkeys.push_str(&format!(
        r#"| `{exit}` | Exit (when editor is empty) |
| `{select_model}` | Open model selector |
| `{expand_tools}` | Cycle overview → thinking + diffs → all output |
| `{focus_subagents}` | Focus activity (←/→ select group, Enter open) |
| `{manage_heartbeats}` | Manage heartbeats |
| `{external_editor}` | Edit message in external editor |
| `{prompt_stash}` | Stash or restore draft prompt |
| `{follow_up}` | Queue follow-up message |
| `{browse_queue}` | Browse and edit queued messages |
| `{reorder_queue}` | Reorder the selected queued message |
| `{paste_image}` | Paste image from clipboard |
| `/` | Slash commands |

**Fullscreen mode (`/fullscreen`)**
| Key | Action |
|-----|--------|
| `{viewport_page_up}` / `{viewport_page_down}` | Scroll transcript by page |
| `{viewport_top}` | Scroll to top |
| `{viewport_follow}` | Scroll to bottom and follow output |
| mouse wheel | Scroll transcript |
| mouse drag | Select and copy text |
| mouse click on link | Open link in browser |
"#
    ));
    hotkeys
}

/// The `?` quick-shortcut guide (TS `getShortcutGuide`), rendered as the
/// transient overlay above the editor (`app.shortcuts`, default `?`, only
/// with an empty editor): TS `showShortcutGuide` mounts it and the next
/// submission clears it.
pub fn shortcut_guide(kb: &KeybindingsManager) -> String {
    let tab = key_display(kb, "tui.input.tab");
    let new_line = key_display(kb, "tui.input.newLine");
    let clear_input = key_display(kb, "app.input.clear");
    let shortcuts_key = key_display(kb, "app.shortcuts");
    let select_model = key_display(kb, "app.model.select");
    let expand_tools = key_display(kb, "app.tools.expand");
    let external_editor = key_display(kb, "app.editor.external");
    let prompt_stash = key_display(kb, "app.prompt.stash");
    let paste_image = key_display(kb, "app.clipboard.pasteImage");
    let shortcuts_prefix = if shortcuts_key.is_empty() {
        String::new()
    } else {
        format!("`{shortcuts_key}` quick shortcuts · ")
    };
    format!(
        r#"**Prompt**
`!` shell mode · `/` commands · `@` file paths
`{tab}` complete paths · `{new_line}` new line
`{clear_input}` interrupt · press twice to rewind or clear the prompt

**Controls**
`{select_model}` select model · `/effort` set reasoning · `{expand_tools}` overview → thinking + diffs → all output
`{prompt_stash}` stash prompt · `{external_editor}` edit in `$EDITOR`
`{paste_image}` paste image

**Help**
{shortcuts_prefix}`/hotkeys` full reference
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_renders_default_keys() {
        let kb = KeybindingsManager::new();
        let guide = hotkeys_guide(&kb);
        assert!(guide.contains("| `Ctrl+O` | Cycle overview"), "{guide}");
        assert!(
            guide.contains("| `Esc` | Clear input / cancel autocomplete |"),
            "{guide}"
        );
        // The interrupt row is conditional: no default binding, no row.
        assert!(!guide.contains("Interrupt current operation |"), "{guide}");
        assert!(guide.contains("| `?` | Show quick shortcuts |"), "{guide}");
        assert!(
            guide.contains("**Fullscreen mode (`/fullscreen`)**"),
            "{guide}"
        );
    }

    #[test]
    fn guide_renders_user_overrides() {
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert(
            "app.tools.expand".to_string(),
            vec!["ctrl+alt+x".to_string()],
        );
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let guide = hotkeys_guide(&kb);
        assert!(guide.contains("| `Ctrl+Alt+X` | Cycle overview"), "{guide}");
        assert!(!guide.contains("`Ctrl+O`"), "{guide}");
    }

    #[test]
    fn shortcut_guide_renders_keys_and_help_prefix() {
        let kb = KeybindingsManager::new();
        let guide = shortcut_guide(&kb);
        assert!(guide.contains("`Tab` complete paths"), "{guide}");
        assert!(guide.contains("`Esc` interrupt"), "{guide}");
        assert!(
            guide.contains("`?` quick shortcuts · `/hotkeys` full reference"),
            "{guide}"
        );
        // A disabled shortcuts binding drops the prefix but keeps the
        // `/hotkeys` reference.
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("app.shortcuts".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let guide = shortcut_guide(&kb);
        assert!(guide.contains("`/hotkeys` full reference"), "{guide}");
        assert!(!guide.contains("quick shortcuts ·"), "{guide}");
    }

    #[test]
    fn guide_renders_disabled_binding_with_empty_key_cell() {
        // TS renders the expandTools row unconditionally: a disabled
        // binding (an empty user override) keeps the row with an empty
        // key cell; only `app.interrupt` / `app.shortcuts` are
        // conditional (their rows omit when unbound).
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("app.tools.expand".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let guide = hotkeys_guide(&kb);
        assert!(guide.contains("| `` | Cycle overview"), "{guide}");
        assert!(!guide.contains("Ctrl+O"), "{guide}");
    }
}
