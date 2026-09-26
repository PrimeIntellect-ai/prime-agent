//! The `/hotkeys` guide (TS `getHotkeysGuide` in
//! `modes/interactive/interactive-mode.ts`): the full keyboard-shortcut
//! reference rendered from the EFFECTIVE bindings, so user
//! `keybindings.json` overrides show their keys in the guide.

use crate::keybindings::{format_key_text, KeybindingsManager};
use std::fmt::Write;

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
    let redo = key_display(kb, "tui.editor.redo");
    let cursor_doc_start = key_display(kb, "tui.editor.cursorDocStart");
    let cursor_doc_end = key_display(kb, "tui.editor.cursorDocEnd");
    let cursor_paragraph_up = key_display(kb, "tui.editor.cursorParagraphUp");
    let cursor_paragraph_down = key_display(kb, "tui.editor.cursorParagraphDown");
    let select_all = key_display(kb, "tui.editor.selectAll");
    let select_word_left = key_display(kb, "tui.editor.selectWordLeft");
    let select_word_right = key_display(kb, "tui.editor.selectWordRight");
    let select_line_start = key_display(kb, "tui.editor.selectLineStart");
    let select_line_end = key_display(kb, "tui.editor.selectLineEnd");
    let cut_selection = key_display(kb, "tui.editor.cutSelection");
    let copy_selection = key_display(kb, "tui.editor.copySelection");
    let transpose_chars = key_display(kb, "tui.editor.transposeChars");
    let tab = key_display(kb, "tui.input.tab");
    let clear = key_display(kb, "app.clear");
    let clear_input = key_display(kb, "app.input.clear");
    let interrupt = key_display(kb, "app.interrupt");
    let exit = key_display(kb, "app.exit");
    let select_model = key_display(kb, "app.model.select");
    let expand_tools = key_display(kb, "app.tools.expand");
    let focus_subagents = key_display(kb, "app.subagents.focus");
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
    let suspend = key_display(kb, "app.suspend");
    let select_paragraph_up = key_display(kb, "tui.editor.selectParagraphUp");
    let select_paragraph_down = key_display(kb, "tui.editor.selectParagraphDown");
    let select_doc_start = key_display(kb, "tui.editor.selectDocStart");
    let select_doc_end = key_display(kb, "tui.editor.selectDocEnd");
    let browse_queue_newer = key_display(kb, "app.message.navigateNewer");

    let mut hotkeys = format!(
        r"
**Navigation**
| Key | Action |
|-----|--------|
| `{cursor_up}` / `{cursor_down}` / `{cursor_left}` / `{cursor_right}` | Move cursor / browse history (Up when empty) |
| `{cursor_word_left}` / `{cursor_word_right}` | Move by word |
| `{cursor_line_start}` | Start of line |
| `{cursor_line_end}` | End of line |
| `{cursor_doc_start}` / `{cursor_doc_end}` | Start / end of text |
| `{cursor_paragraph_up}` / `{cursor_paragraph_down}` | Move one paragraph |
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
| `{redo}` | Redo |
| `{transpose_chars}` | Swap the characters around the cursor |

**Selection**
| Key | Action |
|-----|--------|
| Shift+arrows | Select by character / line |
| `{select_word_left}` / `{select_word_right}` | Select by word |
| `{select_line_start}` / `{select_line_end}` | Select to line start / end |
| `{select_paragraph_up}` / `{select_paragraph_down}` | Select one paragraph |
| `{select_doc_start}` / `{select_doc_end}` | Select to start / end of text |
| `{select_all}` | Select all text |
| `{cut_selection}` | Cut selection |
| `{copy_selection}` | Copy selection |

**Other**
| Key | Action |
|-----|--------|
| `{tab}` | Path completion / accept autocomplete |
| `{clear_input}` | Clear input / cancel autocomplete |
| `{clear}` | Interrupt current operation (first) / exit (second) |
"
    );
    if !interrupt.is_empty() {
        let _ = writeln!(hotkeys, "| `{interrupt}` | Interrupt current operation |");
    }
    let _ = writeln!(
        hotkeys,
        r"| `{exit}` | Exit (when editor is empty) |
| `{suspend}` | Suspend to background |
| `{select_model}` | Open model selector |
| `{expand_tools}` | Cycle overview → thinking + diffs → all output |"
    );
    let _ = writeln!(
        hotkeys,
        r"| `{focus_subagents}` | Focus activity (←/→ select group, Enter open) |
| `{external_editor}` | Edit message in external editor |
| `{prompt_stash}` | Stash or restore draft prompt |
| `{follow_up}` | Queue follow-up message |
| `{browse_queue}` / `{browse_queue_newer}` | Browse and edit queued messages |
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
| mouse click on link | Open link in browser |"
    );
    hotkeys
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
        // The `?` quick-shortcut overlay is removed (the operator's
        // 2026-09-26 directive): the guide keeps no reference to it.
        assert!(!guide.contains("quick shortcuts"), "{guide}");
        assert!(
            guide.contains("**Fullscreen mode (`/fullscreen`)**"),
            "{guide}"
        );
        // The completeness audit's additions: the suspend binding and
        // the paragraph/doc selection pairs gained rows, and the queue
        // browse row names both of its keys.
        assert!(
            guide.contains("| `Ctrl+Z` | Suspend to background |"),
            "{guide}"
        );
        assert!(
            guide.contains(
                "| `Shift+Ctrl+\u{2191}` / `Shift+Alt+\u{2193}` | Select one paragraph |"
            ),
            "{guide}"
        );
        assert!(guide.contains("Select to start / end of text"), "{guide}");
        assert!(
            guide.contains("| `Alt+\u{2191}` / `Alt+\u{2193}` | Browse and edit queued messages |"),
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
    fn guide_renders_disabled_binding_with_empty_key_cell() {
        // TS renders the expandTools row unconditionally: a disabled
        // binding (an empty user override) keeps the row with an empty
        // key cell; only `app.interrupt` is conditional (its row omits
        // when unbound).
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        cfg.insert("app.tools.expand".to_string(), Vec::new());
        let kb = KeybindingsManager::with_user_bindings(cfg);
        let guide = hotkeys_guide(&kb);
        assert!(guide.contains("| `` | Cycle overview"), "{guide}");
        assert!(!guide.contains("Ctrl+O"), "{guide}");
    }
}
