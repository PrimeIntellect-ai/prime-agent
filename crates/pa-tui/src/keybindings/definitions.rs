use super::KeybindingDefinition;
/// TUI-level bindings (`TUI_KEYBINDINGS`).
pub const TUI_KEYBINDINGS: &[(&str, KeybindingDefinition)] = &[
    (
        "tui.editor.cursorUp",
        def!(&["up"], "Move cursor up", scope "editor"),
    ),
    (
        "tui.editor.cursorDown",
        def!(&["down"], "Move cursor down", scope "editor"),
    ),
    (
        "tui.editor.cursorLeft",
        def!(&["left", "ctrl+b"], "Move cursor left", scope "editor"),
    ),
    (
        "tui.editor.cursorRight",
        def!(&["right", "ctrl+f"], "Move cursor right", scope "editor"),
    ),
    (
        "tui.editor.cursorWordLeft",
        def!(&["alt+left", "ctrl+left", "alt+b"], "Move cursor word left", scope "editor"),
    ),
    (
        "tui.editor.cursorWordRight",
        def!(&["alt+right", "ctrl+right", "alt+f"], "Move cursor word right", scope "editor"),
    ),
    (
        "tui.editor.cursorLineStart",
        // "super+left" is the macOS Cmd+Left line-start key (see the divergence note above).
        def!(
            &["home", "ctrl+a", "super+left"],
            "Move to line start",
            scope "editor"
        ),
    ),
    (
        "tui.editor.cursorLineEnd",
        def!(
            &["end", "ctrl+e", "super+right"],
            "Move to line end",
            scope "editor"
        ),
    ),
    (
        "tui.editor.jumpForward",
        def!(&["ctrl+]"], "Jump forward to character", scope "editor"),
    ),
    (
        "tui.editor.jumpBackward",
        def!(&["ctrl+alt+]"], "Jump backward to character", scope "editor"),
    ),
    (
        "tui.editor.pageUp",
        def!(&["pageUp"], "Page up", scope "editor"),
    ),
    (
        "tui.editor.pageDown",
        def!(&["pageDown"], "Page down", scope "editor"),
    ),
    (
        "tui.editor.deleteCharBackward",
        def!(&["backspace"], "Delete character backward", scope "editor"),
    ),
    (
        "tui.editor.deleteCharForward",
        def!(&["delete", "ctrl+d"], "Delete character forward", scope "editor"),
    ),
    (
        "tui.editor.deleteWordBackward",
        def!(&["ctrl+w", "alt+backspace"], "Delete word backward", scope "editor"),
    ),
    (
        "tui.editor.deleteWordForward",
        def!(&["alt+d", "alt+delete"], "Delete word forward", scope "editor"),
    ),
    (
        "tui.editor.deleteToLineStart",
        def!(&["ctrl+u"], "Delete to line start", scope "editor"),
    ),
    (
        "tui.editor.deleteToLineEnd",
        def!(&["ctrl+k"], "Delete to line end", scope "editor"),
    ),
    ("tui.editor.yank", def!(&["ctrl+y"], "Yank", scope "editor")),
    (
        "tui.editor.yankPop",
        def!(&["alt+y"], "Yank pop", scope "editor"),
    ),
    (
        "tui.editor.undo",
        def!(&["ctrl+-", "super+z"], "Undo", scope "editor"),
    ),
    // SANCTIONED DIVERGENCE from TS (operator ask 2026-09-24, documented per the #289 precedent):
    // the ids below have no TS counterpart — the prompt bar carries the full standard text-editing
    // set instead: redo, selection (shift+arrow families, select-all), document/paragraph jumps,
    // word selection, cut/copy of the selection, and character transposition. The `super+` defaults
    // are the macOS Cmd keys (the kitty protocol delivers them as the SUPER modifier); every
    // binding stays user-configurable through keybindings.json exactly like the rest.
    (
        "tui.editor.redo",
        def!(
            &["ctrl+shift+z", "super+shift+z"],
            "Redo",
            scope "editor"
        ),
    ),
    (
        "tui.editor.cursorDocStart",
        def!(
            &["ctrl+home", "super+home", "super+up"],
            "Move to start of text",
            scope "editor"
        ),
    ),
    (
        "tui.editor.cursorDocEnd",
        def!(
            &["ctrl+end", "super+end", "super+down"],
            "Move to end of text",
            scope "editor"
        ),
    ),
    (
        "tui.editor.cursorParagraphUp",
        def!(&["ctrl+up"], "Move one paragraph up", scope "editor"),
    ),
    (
        "tui.editor.cursorParagraphDown",
        def!(&["ctrl+down"], "Move one paragraph down", scope "editor"),
    ),
    (
        "tui.editor.selectAll",
        def!(&["super+a", "ctrl+shift+a"], "Select all text", scope "editor"),
    ),
    (
        "tui.editor.selectLeft",
        def!(&["shift+left"], "Select left by character", scope "editor"),
    ),
    (
        "tui.editor.selectRight",
        def!(&["shift+right"], "Select right by character", scope "editor"),
    ),
    (
        "tui.editor.selectUp",
        def!(&["shift+up"], "Select up one line", scope "editor"),
    ),
    (
        "tui.editor.selectDown",
        def!(&["shift+down"], "Select down one line", scope "editor"),
    ),
    (
        "tui.editor.selectWordLeft",
        def!(
            &["shift+alt+left", "shift+ctrl+left"],
            "Select left by word",
            scope "editor"
        ),
    ),
    (
        "tui.editor.selectWordRight",
        def!(
            &["shift+alt+right", "shift+ctrl+right"],
            "Select right by word",
            scope "editor"
        ),
    ),
    (
        "tui.editor.selectLineStart",
        def!(&["shift+home"], "Select to start of line", scope "editor"),
    ),
    (
        "tui.editor.selectLineEnd",
        def!(&["shift+end"], "Select to end of line", scope "editor"),
    ),
    (
        "tui.editor.selectParagraphUp",
        def!(&["shift+ctrl+up"], "Select up one paragraph", scope "editor"),
    ),
    (
        "tui.editor.selectParagraphDown",
        // `shift+ctrl+down` is `tui.viewport.follow` (the fullscreen transcript key the
        // session dispatch consumes before the editor), so the paragraph-select default
        // is `shift+alt+down` instead.
        def!(
            &["shift+alt+down"],
            "Select down one paragraph",
            scope "editor"
        ),
    ),
    (
        "tui.editor.selectDocStart",
        def!(
            &["shift+ctrl+home", "super+shift+up"],
            "Select to start of text",
            scope "editor"
        ),
    ),
    (
        "tui.editor.selectDocEnd",
        def!(
            &["shift+ctrl+end", "super+shift+down"],
            "Select to end of text",
            scope "editor"
        ),
    ),
    (
        "tui.editor.transposeChars",
        def!(&["ctrl+t"], "Swap the characters around the cursor", scope "editor"),
    ),
    (
        "tui.editor.cutSelection",
        def!(
            &["ctrl+x", "super+x"],
            "Cut the selection to the clipboard",
            scope "editor"
        ),
    ),
    (
        "tui.editor.copySelection",
        def!(
            &["ctrl+shift+c", "super+c"],
            "Copy the selection to the clipboard",
            scope "editor"
        ),
    ),
    (
        "tui.input.newLine",
        def!(&["shift+enter"], "Insert newline", scope "editor"),
    ),
    (
        "tui.input.submit",
        def!(&["enter"], "Submit input", scope "editor"),
    ),
    (
        "tui.input.tab",
        def!(&["tab"], "Tab / autocomplete", scope "editor"),
    ),
    (
        "tui.input.copy",
        def!(&["ctrl+c"], "Copy selection", scope "editor"),
    ),
    (
        "tui.viewport.pageUp",
        def!(&["pageUp"], "Scroll transcript up a page (fullscreen)"),
    ),
    (
        "tui.viewport.pageDown",
        def!(&["pageDown"], "Scroll transcript down a page (fullscreen)"),
    ),
    (
        "tui.viewport.top",
        def!(&["shift+alt+up"], "Scroll transcript to top (fullscreen)"),
    ),
    (
        "tui.viewport.follow",
        def!(
            &["ctrl+shift+down"],
            "Scroll to bottom and follow output (fullscreen)"
        ),
    ),
    ("tui.select.up", def!(&["up"], "Move selection up")),
    ("tui.select.down", def!(&["down"], "Move selection down")),
    ("tui.select.pageUp", def!(&["pageUp"], "Selection page up")),
    (
        "tui.select.pageDown",
        def!(&["pageDown"], "Selection page down"),
    ),
    (
        "tui.select.top",
        def!(
            &["home", "ctrl+home", "super+home", "super+up"],
            "Selection to first item"
        ),
    ),
    (
        "tui.select.bottom",
        def!(
            &["end", "ctrl+end", "super+end", "super+down"],
            "Selection to last item"
        ),
    ),
    ("tui.select.confirm", def!(&["enter"], "Confirm selection")),
    (
        "tui.select.cancel",
        def!(&["escape", "ctrl+c"], "Cancel selection"),
    ),
];

/// App-level bindings (`KEYBINDINGS` additions in coding-agent).
pub const APP_KEYBINDINGS: &[(&str, KeybindingDefinition)] = &[
    ("app.interrupt", def!(&[], "Interrupt current operation")),
    (
        "app.clear",
        def!(&["ctrl+c"], "Interrupt current operation, then exit"),
    ),
    (
        "app.input.clear",
        def!(&["escape"], "Interrupt response or clear prompt"),
    ),
    ("app.exit", def!(&["ctrl+d"], "Exit when editor is empty")),
    ("app.suspend", def!(&["ctrl+z"], "Suspend to background")),
    ("app.model.select", def!(&["ctrl+l"], "Open model selector")),
    (
        "app.model.toggleScope",
        def!(&["alt+s"], "Toggle model selector scope"),
    ),
    (
        "app.model.cycleForward",
        def!(&["alt+m"], "Cycle to the next scoped model"),
    ),
    (
        "app.model.cycleBackward",
        def!(&["shift+alt+m"], "Cycle to the previous scoped model"),
    ),
    (
        "app.tools.expand",
        def!(&["ctrl+o"], "Cycle conversation detail", scope "editor"),
    ),
    ("app.subagents.focus", def!(&["alt+a"], "Focus activity")),
    (
        "app.heartbeats.openSelected",
        def!(&["right"], "Open selected heartbeat"),
    ),
    (
        "app.editor.external",
        def!(&["ctrl+g"], "Open external editor"),
    ),
    (
        "app.prompt.stash",
        def!(&["ctrl+s"], "Stash or restore draft prompt"),
    ),
    (
        "app.message.followUp",
        def!(&["alt+enter"], "Queue follow-up message"),
    ),
    (
        "app.message.navigateOlder",
        def!(&["alt+up"], "Select older pending message"),
    ),
    (
        "app.message.navigateNewer",
        def!(&["alt+down"], "Select newer pending message or draft"),
    ),
    (
        "app.message.moveEarlier",
        def!(&["ctrl+alt+up"], "Move selected pending message earlier"),
    ),
    (
        "app.message.moveLater",
        def!(&["ctrl+alt+down"], "Move selected pending message later"),
    ),
    (
        "app.clipboard.pasteImage",
        def!(&["ctrl+v"], "Paste image from clipboard"),
    ),
    (
        "app.clipboard.copyLoginUrl",
        def!(&["c", "alt+c"], "Copy login URL"),
    ),
    ("app.session.new", def!(&[], "Start a new session")),
    ("app.session.tree", def!(&[], "Open session tree")),
    ("app.session.fork", def!(&[], "Fork current session")),
    ("app.session.resume", def!(&[], "Resume a session")),
    (
        "app.agents.back",
        def!(&["left"], "Return to parent agent scope"),
    ),
    (
        "app.agents.open",
        def!(&["right"], "Drill into selected agent"),
    ),
    (
        "app.modal.back",
        def!(&["left"], "Go back / close the current dialog"),
    ),
    (
        "app.agents.reply",
        def!(&["space"], "Reply to selected agent"),
    ),
    (
        "app.agents.new",
        def!(&["ctrl+n"], "Start a new session from the agents view"),
    ),
    (
        "app.agents.delete",
        def!(&["ctrl+x"], "Stop or delete selected agent"),
    ),
    (
        "app.agents.program",
        def!(&["ctrl+o"], "Show the program that spawned subagents"),
    ),
    (
        "app.agents.rename",
        def!(&["ctrl+r"], "Rename selected agent session"),
    ),
    (
        "app.agents.expand",
        def!(
            &["alt+right"],
            "Expand or collapse selected agent subagents"
        ),
    ),
    (
        "app.tree.foldOrUp",
        def!(&["ctrl+left", "alt+left"], "Fold tree branch or move up"),
    ),
    (
        "app.tree.unfoldOrDown",
        def!(
            &["ctrl+right", "alt+right"],
            "Unfold tree branch or move down"
        ),
    ),
    ("app.tree.editLabel", def!(&["shift+l"], "Edit tree label")),
    (
        "app.tree.toggleLabelTimestamp",
        def!(&["shift+t"], "Toggle tree label timestamps"),
    ),
    (
        "app.tree.filter.default",
        def!(&["ctrl+d"], "Tree filter: default view"),
    ),
    (
        "app.tree.filter.noTools",
        def!(&["ctrl+t"], "Tree filter: hide tool results"),
    ),
    (
        "app.tree.filter.userOnly",
        def!(&["ctrl+u"], "Tree filter: user messages only"),
    ),
    (
        "app.tree.filter.labeledOnly",
        def!(&["ctrl+l"], "Tree filter: labeled entries only"),
    ),
    (
        "app.tree.filter.all",
        def!(&["ctrl+a"], "Tree filter: show all entries"),
    ),
    (
        "app.tree.filter.cycleForward",
        def!(&["ctrl+o"], "Tree filter: cycle forward"),
    ),
    (
        "app.tree.filter.cycleBackward",
        def!(&["shift+ctrl+o"], "Tree filter: cycle backward"),
    ),
];
