# Keybindings

All keyboard shortcuts can be customized via `~/.prime/agent/keybindings.json`. Each action can be bound to one or more keys.

The config file uses the same namespaced keybinding ids that Prime Agent uses internally and that extension authors use in `keyHint()` and injected `keybindings` managers.

Older configs using pre-namespaced ids such as `cursorUp` or `expandTools` are migrated automatically to the namespaced ids on startup.

After editing `keybindings.json`, restart Prime Agent to apply the changes (the TS product's `/reload` hot-reload of keybindings is not wired in this build yet).

## Key Format

`modifier+key` where modifiers are `ctrl`, `shift`, `alt` (combinable) and keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Modifier combinations: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `ctrl+1`, etc.

## Terminal Key Support

What reaches the app depends on the terminal, not on Prime Agent:

- **Ctrl+Home/End and Ctrl+Up/Down** are sent by common Linux terminals (GNOME Terminal, xterm, Konsole) and by every terminal that speaks the kitty keyboard protocol (kitty, Ghostty, WezTerm, foot, alacritty).
- **`super+` keys are the macOS Cmd keys.** They arrive only from terminals that report the kitty keyboard protocol (Prime Agent enables it when the terminal answers its query). A terminal that keeps Cmd+Arrow for its own shortcuts or its scrollback never sends it to the app: stock macOS Terminal and iTerm2 do exactly that, so do not expect Cmd+Up/Down to work there without a terminal-side mapping.
- **macOS Terminal.app** reserves Home/End/Cmd+Home/End for its own scrollback; nothing reaches the app until you add profile key mappings (Settings → Profiles → Keyboard), for example Home → `\033[H`, End → `\033[F`, Cmd+Up → `\033[1;9A`, Cmd+Down → `\033[1;9B`.
- **iTerm2** ships with Home/End/Cmd+Arrow doing nothing. The "Natural Text Editing" preset (Profiles → Keys → Key Mappings) maps Cmd+Left/Right to line start/end and Option+Left/Right to word motion; a custom key mapping with "Send Escape Sequences" `[1;9A` / `[1;9B` makes Cmd+Up/Down jump to the document start/end in the prompt editor and the first/last item in the agents view. Ctrl+Up/Down and the Option keys work without any mapping.
- In the **agents view**, `home`/`end` jump the list to the first/last row; the search field keeps `ctrl+a`/`ctrl+e` for its own line ends. In every prompt editor, `home`/`end` stay line start/end.

## All Actions

### TUI Editor Cursor Movement

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.cursorUp` | `up` | Move cursor up |
| `tui.editor.cursorDown` | `down` | Move cursor down |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Move cursor left |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Move cursor right |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Move cursor word left |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right |
| `tui.editor.cursorLineStart` | `home`, `ctrl+a`, `super+left` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e`, `super+right` | Move to line end |
| `tui.editor.cursorDocStart` | `ctrl+home`, `super+home`, `super+up` | Move to start of text |
| `tui.editor.cursorDocEnd` | `ctrl+end`, `super+end`, `super+down` | Move to end of text |
| `tui.editor.cursorParagraphUp` | `ctrl+up` | Move one paragraph up |
| `tui.editor.cursorParagraphDown` | `ctrl+down` | Move one paragraph down |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown` | Scroll down by page |

### TUI Editor Selection

`super+` keys are the macOS Cmd keys (delivered by terminals that report the kitty keyboard protocol with Cmd passthrough); on Linux/Windows use the `ctrl+` counterparts.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.selectLeft` | `shift+left` | Select left by character |
| `tui.editor.selectRight` | `shift+right` | Select right by character |
| `tui.editor.selectUp` | `shift+up` | Select up one line |
| `tui.editor.selectDown` | `shift+down` | Select down one line |
| `tui.editor.selectWordLeft` | `shift+alt+left`, `shift+ctrl+left` | Select left by word |
| `tui.editor.selectWordRight` | `shift+alt+right`, `shift+ctrl+right` | Select right by word |
| `tui.editor.selectLineStart` | `shift+home` | Select to start of line |
| `tui.editor.selectLineEnd` | `shift+end` | Select to end of line |
| `tui.editor.selectParagraphUp` | `shift+ctrl+up` | Select up one paragraph |
| `tui.editor.selectParagraphDown` | `shift+ctrl+down` | Select down one paragraph |
| `tui.editor.selectDocStart` | `shift+ctrl+home`, `super+shift+up` | Select to start of text |
| `tui.editor.selectDocEnd` | `shift+ctrl+end`, `super+shift+down` | Select to end of text |
| `tui.editor.selectAll` | `super+a`, `ctrl+shift+a` | Select all text |

Typing, Backspace, Delete, and paste replace an active selection; Escape drops the selection first.

### TUI Editor Deletion

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |

### TUI Input

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter` | Insert new line |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab / autocomplete |

### TUI Kill Ring

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-`, `super+z` | Undo last edit |
| `tui.editor.redo` | `ctrl+shift+z`, `super+shift+z` | Redo the last undone edit |
| `tui.editor.transposeChars` | `ctrl+t` | Swap the characters around the cursor |

### TUI Clipboard and Selection

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | Copy selection |
| `tui.editor.cutSelection` | `ctrl+x`, `super+x` | Cut the selection to the clipboard |
| `tui.editor.copySelection` | `ctrl+shift+c`, `super+c` | Copy the selection to the clipboard |
| `tui.select.up` | `up` | Move selection up |
| `tui.select.down` | `down` | Move selection down |
| `tui.select.pageUp` | `pageUp` | Page up in list |
| `tui.select.pageDown` | `pageDown` | Page down in list |
| `tui.select.top` | `home`, `ctrl+home`, `super+home`, `super+up` | Select first item in list |
| `tui.select.bottom` | `end`, `ctrl+end`, `super+end`, `super+down` | Select last item in list |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

### TUI Fullscreen Transcript

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.viewport.pageUp` | `pageUp` | Scroll transcript up a page |
| `tui.viewport.pageDown` | `pageDown` | Scroll transcript down a page |
| `tui.viewport.top` | `shift+alt+up` | Scroll transcript to top |
| `tui.viewport.follow` | `ctrl+shift+down` | Scroll to bottom and follow output |

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | *(none)* | Interrupt current operation |
| `app.clear` | `ctrl+c` | Interrupt current operation, then exit |
| `app.input.clear` | `escape` | Clear input |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.suspend` | `ctrl+z` (none on Windows) | Suspend to background |
| `app.editor.external` | `ctrl+g` | Open in external editor (`$VISUAL` or `$EDITOR`) |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows) | Paste image from clipboard |
| `app.clipboard.copyLoginUrl` | `c`, `alt+c` | Copy the sign-in URL from a login dialog |

### Sessions

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.session.new` | *(none)* | Start a new session (`/new`) |
| `app.session.tree` | *(none)* | Open session tree navigator (`/tree`) |
| `app.session.fork` | *(none)* | Fork current session (`/fork`) |
| `app.session.resume` | *(none)* | Open session resume picker (`/resume`) |

### Models and Thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.model.toggleScope` | `alt+s` | Toggle between all and scoped models |

### Configuration Pickers

Models, Providers, and MCP Connections open as separate pickers. Use `escape` to close a picker. Left and right edit a nonempty search field; with an empty model search, they adjust the highlighted model's effort.

### Display and Message Queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Cycle overview → thinking and file diffs → all output |
| `app.transcript.runs` | `alt+t` | Open the condensed tool runs view (Enter expand a run) |
| `app.message.followUp` | `alt+enter` | Queue follow-up message |
| `app.message.navigateOlder` | `alt+up` | Select the next older pending message |
| `app.message.navigateNewer` | `alt+down` | Select the next newer pending message or restore the draft |
| `app.message.moveEarlier` | `ctrl+alt+up` | Move the selected pending message one place earlier in its queue |
| `app.message.moveLater` | `ctrl+alt+down` | Move the selected pending message one place later in its queue |

Ctrl+O changes presentation only: the default hides thinking and collapses tools and diffs; the first press reveals thinking and file diffs; the second expands tool output and full agent-to-agent message bodies; the third returns to the default. Compact sent and received message notices remain visible in every mode. This also works for restored conversations and new streaming content. Ctrl+J, Ctrl+T, and Ctrl+P no longer control conversation expansion.

### Tree Navigation

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Fold current branch segment, or jump to the previous segment start |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |
| `app.tree.editLabel` | `shift+l` | Edit the label on the selected tree node |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle label timestamps in the tree |
| `app.tree.filter.default` | `ctrl+d` | Set tree filter to default view |
| `app.tree.filter.noTools` | `ctrl+t` | Toggle tree filter that hides tool results |
| `app.tree.filter.userOnly` | `ctrl+u` | Toggle tree filter that shows only user messages |
| `app.tree.filter.labeledOnly` | `ctrl+l` | Toggle tree filter that shows only labeled entries |
| `app.tree.filter.all` | `ctrl+a` | Toggle tree filter that shows all entries |
| `app.tree.filter.cycleForward` | `ctrl+o` | Cycle tree filter forward |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Cycle tree filter backward |

## Custom Configuration

Create `~/.prime/agent/keybindings.json`:

```json
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

Each action can have a single key or an array of keys. User config overrides defaults.

On native Windows, `app.suspend` has no default binding because Windows terminals do not support Unix job control. If you bind it manually, Prime Agent shows a status message instead of suspending. In WSL, the normal Linux `ctrl+z`/`fg` behavior still applies.

### Emacs Example

Binding `ctrl+p` below moves the editor cursor up; shortcuts in other views keep their defaults.

```json
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim Example

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+w"]
}
```
