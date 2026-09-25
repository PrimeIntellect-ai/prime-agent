//! Global keybinding registry with TS DEFAULT_* defaults.
//!
//! Port of `packages/tui/src/keybindings.ts` + `coding-agent/src/core/keybindings.ts`.
//! Every binding is configurable via `~/.prime/agent/keybindings.json`; the
//! defaults below are the TS product's DEFAULT_* tables verbatim. User
//! bindings load with the TS parse semantics (`toKeybindingsConfig` +
//! `migrateKeybindingsConfig`): legacy names migrate, malformed values drop,
//! and an empty array disables a binding.

use anyhow::Result;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingDefinition {
    pub default_keys: &'static [&'static str],
    #[allow(dead_code)]
    pub description: &'static str,
    pub default_key_scope: Option<&'static str>,
}

macro_rules! def {
    ($keys:expr, $desc:expr) => {
        KeybindingDefinition {
            default_keys: $keys,
            description: $desc,
            default_key_scope: None,
        }
    };
    ($keys:expr, $desc:expr, scope $scope:expr) => {
        KeybindingDefinition {
            default_keys: $keys,
            description: $desc,
            default_key_scope: Some($scope),
        }
    };
}

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
        // "super+left" is the macOS Cmd+Left line-start key (a prompt-
        // editor-keybinds addition; see the divergence note above).
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
    // SANCTIONED DIVERGENCE from TS (operator ask 2026-09-24, documented
    // per the #289 precedent): the ids below have no TS counterpart — the
    // TS editor's key set stops at the bindings above. The prompt bar
    // carries the full standard text-editing set instead: redo, selection
    // (shift+arrow families, select-all), document/paragraph jumps, word
    // selection, cut/copy of the selection, and character transposition.
    // The `super+` defaults are the macOS Cmd keys (the kitty protocol
    // delivers them as the SUPER modifier); every binding stays
    // user-configurable through keybindings.json exactly like the rest.
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
        def!(&["ctrl+home", "super+up"], "Move to start of text", scope "editor"),
    ),
    (
        "tui.editor.cursorDocEnd",
        def!(&["ctrl+end", "super+down"], "Move to end of text", scope "editor"),
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
        // `shift+ctrl+down` is `tui.viewport.follow` (the fullscreen
        // transcript key the session dispatch consumes before the editor),
        // so the paragraph-select default is `shift+alt+down` instead.
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
    ("app.shortcuts", def!(&["?"], "Show keyboard shortcuts")),
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
    (
        "app.transcript.runs",
        def!(&["alt+t"], "Open the condensed tool runs view"),
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

pub type KeybindingsConfig = BTreeMap<String, Vec<String>>;

/// One explicit user-config conflict (TS `KeybindingConflict`): a key
/// claimed by more than one user binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingConflict {
    pub key: String,
    pub keybindings: Vec<String>,
}

/// A parsed key id (TS `parseKeyId`): the modifier set plus the base key,
/// lowercase, so matching is case- and order-insensitive exactly like
/// `matchesKey` (a config value `Ctrl+O` matches the `ctrl+o` a key event
/// decodes to; `ctrl+shift+down` matches the event id `shift+ctrl+down`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedKeyId {
    key: String,
    ctrl: bool,
    shift: bool,
    alt: bool,
    super_key: bool,
}

/// TS `parseKeyId`: split on `+`, the last part is the key, the rest are
/// modifiers; `esc` and `escape` name the same key. An empty key id or
/// trailing `+` parses to `None` (never matches).
fn parse_key_id(id: &str) -> Option<ParsedKeyId> {
    let parts: Vec<&str> = id.split('+').collect();
    let raw_key = parts.last()?.trim().to_lowercase();
    if raw_key.is_empty() {
        return None;
    }
    let key = match raw_key.as_str() {
        "esc" => "escape".to_string(),
        other => other.to_string(),
    };
    let mut parsed = ParsedKeyId {
        key,
        ctrl: false,
        shift: false,
        alt: false,
        super_key: false,
    };
    for part in &parts {
        match part.trim().to_lowercase().as_str() {
            "ctrl" => parsed.ctrl = true,
            "shift" => parsed.shift = true,
            "alt" => parsed.alt = true,
            "super" => parsed.super_key = true,
            _ => {}
        }
    }
    Some(parsed)
}

/// TS `normalizeKeys`: dedupe preserving first-seen order; a single key is a
/// one-element list. Malformed ids stay (they simply never match, like TS).
fn normalize_keys(keys: &[String]) -> Vec<String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for key in keys {
        if seen.insert(key.clone()) {
            out.push(key.clone());
        }
    }
    out
}

/// The legacy pre-namespaced keybinding ids and their current names (TS
/// `KEYBINDING_NAME_MIGRATIONS` in `coding-agent/src/core/keybindings.ts`).
pub const KEYBINDING_NAME_MIGRATIONS: &[(&str, &str)] = &[
    ("app.message.dequeue", "app.message.navigateOlder"),
    ("cursorUp", "tui.editor.cursorUp"),
    ("cursorDown", "tui.editor.cursorDown"),
    ("cursorLeft", "tui.editor.cursorLeft"),
    ("cursorRight", "tui.editor.cursorRight"),
    ("cursorWordLeft", "tui.editor.cursorWordLeft"),
    ("cursorWordRight", "tui.editor.cursorWordRight"),
    ("cursorLineStart", "tui.editor.cursorLineStart"),
    ("cursorLineEnd", "tui.editor.cursorLineEnd"),
    ("jumpForward", "tui.editor.jumpForward"),
    ("jumpBackward", "tui.editor.jumpBackward"),
    ("pageUp", "tui.editor.pageUp"),
    ("pageDown", "tui.editor.pageDown"),
    ("deleteCharBackward", "tui.editor.deleteCharBackward"),
    ("deleteCharForward", "tui.editor.deleteCharForward"),
    ("deleteWordBackward", "tui.editor.deleteWordBackward"),
    ("deleteWordForward", "tui.editor.deleteWordForward"),
    ("deleteToLineStart", "tui.editor.deleteToLineStart"),
    ("deleteToLineEnd", "tui.editor.deleteToLineEnd"),
    ("yank", "tui.editor.yank"),
    ("yankPop", "tui.editor.yankPop"),
    ("undo", "tui.editor.undo"),
    ("newLine", "tui.input.newLine"),
    ("submit", "tui.input.submit"),
    ("tab", "tui.input.tab"),
    ("copy", "tui.input.copy"),
    ("selectUp", "tui.select.up"),
    ("selectDown", "tui.select.down"),
    ("selectPageUp", "tui.select.pageUp"),
    ("selectPageDown", "tui.select.pageDown"),
    ("selectConfirm", "tui.select.confirm"),
    ("selectCancel", "tui.select.cancel"),
    ("interrupt", "app.interrupt"),
    ("clear", "app.clear"),
    ("clearInput", "app.input.clear"),
    ("exit", "app.exit"),
    ("suspend", "app.suspend"),
    ("selectModel", "app.model.select"),
    ("expandTools", "app.tools.expand"),
    ("focusSubagents", "app.subagents.focus"),
    ("externalEditor", "app.editor.external"),
    ("followUp", "app.message.followUp"),
    ("dequeue", "app.message.navigateOlder"),
    ("pasteImage", "app.clipboard.pasteImage"),
    ("newSession", "app.session.new"),
    ("tree", "app.session.tree"),
    ("fork", "app.session.fork"),
    ("resume", "app.session.resume"),
    ("agentsBack", "app.agents.back"),
    ("agentsReply", "app.agents.reply"),
    ("agentsNew", "app.agents.new"),
    ("agentsDelete", "app.agents.delete"),
    ("agentsProgram", "app.agents.program"),
    ("agentsRename", "app.agents.rename"),
    ("treeFoldOrUp", "app.tree.foldOrUp"),
    ("treeUnfoldOrDown", "app.tree.unfoldOrDown"),
    ("treeEditLabel", "app.tree.editLabel"),
    ("treeToggleLabelTimestamp", "app.tree.toggleLabelTimestamp"),
];

fn legacy_migration(id: &str) -> Option<&'static str> {
    KEYBINDING_NAME_MIGRATIONS
        .iter()
        .find(|(legacy, _)| *legacy == id)
        .map(|(_, current)| *current)
}

/// The config object as an ordered entry list (serde_json maps sort keys,
/// so the TS object order — definition ids first, extras sorted after — is
/// carried by this vector; [`write_json_object`] renders it in order).
pub type OrderedConfig = Vec<(String, serde_json::Value)>;

/// TS `migrateKeybindingsConfig`: rename legacy ids (a legacy entry is
/// dropped when its current name also exists) and order the object with
/// known ids first in definition order, extras sorted after. Values are
/// carried over unchanged (filtering happens in [`to_keybindings_config`]).
/// Returns the migrated entries and whether any rename happened.
pub fn migrate_keybindings_config(
    raw: &serde_json::Map<String, serde_json::Value>,
) -> (OrderedConfig, bool) {
    let mut migrated = false;
    let mut config: OrderedConfig = Vec::new();
    for (key, value) in raw {
        let Some(next_key) = legacy_migration(key) else {
            config.push((key.clone(), value.clone()));
            continue;
        };
        migrated = true;
        if raw.contains_key(next_key) {
            // The current name is authoritative; the legacy entry drops.
            continue;
        }
        config.push((next_key.to_string(), value.clone()));
    }
    (order_keybindings_config(config), migrated)
}

/// TS `orderKeybindingsConfig`: known ids first in definition order, the
/// rest sorted.
fn order_keybindings_config(mut config: OrderedConfig) -> OrderedConfig {
    let mut ordered: OrderedConfig = Vec::new();
    for (id, _) in TUI_KEYBINDINGS.iter().chain(APP_KEYBINDINGS.iter()) {
        if let Some(position) = config.iter().position(|(key, _)| key == id) {
            let (_, value) = config.remove(position);
            ordered.push((id.to_string(), value));
        }
    }
    config.sort_by(|a, b| a.0.cmp(&b.0));
    ordered.extend(config);
    ordered
}

/// TS `toKeybindingsConfig`: a value is a key list only when it is a string
/// or an array whose every entry is a string (an empty array disables the
/// binding); anything else drops. Unknown ids survive — they never
/// resolve, but stay in the round-tripped config.
fn to_keybindings_config(value: &serde_json::Value) -> Option<Vec<String>> {
    match value {
        serde_json::Value::String(key) => Some(vec![key.clone()]),
        serde_json::Value::Array(entries) => {
            let keys: Option<Vec<String>> = entries
                .iter()
                .map(|entry| entry.as_str().map(str::to_string))
                .collect();
            keys
        }
        _ => None,
    }
}

/// Read the raw config object at `path` (TS `loadRawConfig`): a missing
/// file, malformed JSON, or a non-object document read as absent.
fn load_raw_config(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let bytes = std::fs::read(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parsed.as_object().cloned()
}

/// TS `KeybindingsManager.loadFromFile`: migrate legacy names, then filter
/// to the well-formed key lists.
fn load_config(path: &Path) -> KeybindingsConfig {
    let Some(raw) = load_raw_config(path) else {
        return KeybindingsConfig::new();
    };
    let (config, _migrated) = migrate_keybindings_config(&raw);
    let mut bindings = KeybindingsConfig::new();
    for (id, value) in &config {
        if let Some(keys) = to_keybindings_config(value) {
            bindings.insert(id.clone(), keys);
        }
    }
    bindings
}

/// Write a JSON object with the TS `JSON.stringify(config, null, 2)`
/// formatting: two-space nesting, a trailing newline. Written by hand
/// (not via `serde_json`) so the definition-first key ordering survives.
fn write_json_object(path: &Path, entries: &OrderedConfig) -> Result<()> {
    let mut out = String::from("{\n");
    let count = entries.len();
    for (index, (key, value)) in entries.iter().enumerate() {
        out.push_str("  ");
        out.push_str(&serde_json::to_string(key)?);
        out.push_str(": ");
        // `JSON.stringify(config, null, 2)`: a property's nested values
        // sit two deeper than the property's own indent (key at 2, nested
        // elements at 4, closing bracket back at 2).
        out.push_str(&stringify_value(value, 4)?);
        if index + 1 < count {
            out.push(',');
        }
        out.push('\n');
    }
    if count == 0 {
        out = String::from("{}\n");
    } else {
        out.push('}');
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// The `JSON.stringify(value, null, indent)` body for one value: scalars
/// inline, arrays and objects one element per line with `indent` spaces.
fn stringify_value(value: &serde_json::Value, indent: usize) -> Result<String> {
    match value {
        serde_json::Value::Array(entries) => {
            if entries.is_empty() {
                return Ok("[]".to_string());
            }
            let mut out = String::from("[\n");
            for (index, entry) in entries.iter().enumerate() {
                out.push_str(&" ".repeat(indent));
                out.push_str(&stringify_value(entry, indent + 2)?);
                if index + 1 < entries.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&" ".repeat(indent.saturating_sub(2)));
            out.push(']');
            Ok(out)
        }
        serde_json::Value::Object(map) => {
            if map.is_empty() {
                return Ok("{}".to_string());
            }
            let mut out = String::from("{\n");
            let count = map.len();
            for (index, (key, entry)) in map.iter().enumerate() {
                out.push_str(&" ".repeat(indent));
                out.push_str(&serde_json::to_string(key)?);
                out.push_str(": ");
                out.push_str(&stringify_value(entry, indent + 2)?);
                if index + 1 < count {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&" ".repeat(indent.saturating_sub(2)));
            out.push('}');
            Ok(out)
        }
        scalar => Ok(serde_json::to_string(scalar)?),
    }
}

/// TS `migrateKeybindingsConfigFile` (the startup migration in
/// `coding-agent/src/migrations.ts`): rewrite `<agentDir>/keybindings.json`
/// with migrated names (and the definition-first ordering) when any legacy
/// id was found; a missing or malformed file is a no-op. Returns whether
/// the file was rewritten.
pub fn migrate_keybindings_file(agent_dir: &Path) -> Result<bool> {
    let config_path = agent_dir.join("keybindings.json");
    let Some(raw) = load_raw_config(&config_path) else {
        return Ok(false);
    };
    let (config, migrated) = migrate_keybindings_config(&raw);
    if !migrated {
        return Ok(false);
    }
    write_json_object(&config_path, &config)?;
    Ok(true)
}

/// Resolved binding table: definition defaults overlaid with user config.
#[derive(Debug, Clone)]
pub struct KeybindingsManager {
    definitions: BTreeMap<&'static str, KeybindingDefinition>,
    resolved: BTreeMap<String, Vec<String>>,
    user_bindings: KeybindingsConfig,
    conflicts: Vec<KeybindingConflict>,
    config_path: Option<PathBuf>,
}

fn all_definitions() -> BTreeMap<&'static str, KeybindingDefinition> {
    let mut map = BTreeMap::new();
    for (id, definition) in TUI_KEYBINDINGS.iter().chain(APP_KEYBINDINGS.iter()) {
        map.insert(*id, definition.clone());
    }
    map
}

impl KeybindingsManager {
    /// All definitions with the TS defaults.
    pub fn new() -> Self {
        Self::with_user_bindings(KeybindingsConfig::new())
    }

    pub fn with_user_bindings(user_bindings: KeybindingsConfig) -> Self {
        let definitions = all_definitions();
        let mut manager = Self {
            definitions,
            resolved: BTreeMap::new(),
            user_bindings,
            conflicts: Vec::new(),
            config_path: None,
        };
        manager.rebuild();
        manager
    }

    /// TS `KeybindingsManager.create(agentDir)`: the user bindings from
    /// `<agentDir>/keybindings.json` (legacy names migrated, malformed
    /// values dropped), remembered for [`reload`](Self::reload).
    pub fn create(agent_dir: &Path) -> Self {
        let config_path = agent_dir.join("keybindings.json");
        let user_bindings = load_config(&config_path);
        let definitions = all_definitions();
        let mut manager = Self {
            definitions,
            resolved: BTreeMap::new(),
            user_bindings,
            conflicts: Vec::new(),
            config_path: Some(config_path),
        };
        manager.rebuild();
        manager
    }

    /// TS `reload()`: re-read the config file this manager was created
    /// from (a no-op for a manager without one).
    pub fn reload(&mut self) {
        let Some(config_path) = &self.config_path else {
            return;
        };
        self.user_bindings = load_config(config_path);
        self.rebuild();
    }

    /// Mirrors TS `KeybindingsManager.rebuild()`: user bindings replace a
    /// definition's keys outright; within the same default scope, a key a
    /// user binding adds (outside its own defaults) is freed from the
    /// other defaults in that scope; keys explicitly claimed by more than
    /// one user binding are reported as conflicts.
    fn rebuild(&mut self) {
        // Explicit claims: every key each known user binding names; added
        // claims: the ones outside that binding's own defaults (these free
        // same-scope defaults of other bindings).
        let mut explicit_claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut added_claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, keys) in &self.user_bindings {
            let Some(definition) = self.definitions.get(id.as_str()) else {
                // Unknown ids never resolve; they stay in the config for
                // the round-trip.
                continue;
            };
            for key in normalize_keys(keys) {
                let claimants = explicit_claims.entry(key.clone()).or_default();
                if !claimants.contains(id) {
                    claimants.push(id.clone());
                }
                if !definition.default_keys.contains(&key.as_str()) {
                    added_claims.entry(key).or_default().push(id.clone());
                }
            }
        }
        self.conflicts = explicit_claims
            .iter()
            .filter(|(_, claimants)| claimants.len() > 1)
            .map(|(key, claimants)| KeybindingConflict {
                key: key.clone(),
                keybindings: claimants.clone(),
            })
            .collect();
        self.resolved.clear();
        for (id, definition) in &self.definitions {
            let keys = match self.user_bindings.get(*id) {
                Some(user_keys) => normalize_keys(user_keys),
                None => definition
                    .default_keys
                    .iter()
                    .filter(|key| {
                        let Some(scope) = definition.default_key_scope else {
                            return true;
                        };
                        let key: &str = key;
                        !added_claims.get(key).is_some_and(|claimants| {
                            claimants.iter().any(|claimant| {
                                self.definitions
                                    .get(claimant.as_str())
                                    .and_then(|d| d.default_key_scope)
                                    == Some(scope)
                            })
                        })
                    })
                    .map(ToString::to_string)
                    .collect(),
            };
            self.resolved.insert(id.to_string(), keys);
        }
    }

    /// TS `matches` (via `matchesKey`): the input's parsed key id equals a
    /// parsed configured key, so matching is case- and order-insensitive.
    pub fn matches(&self, data: &str, keybinding: &str) -> bool {
        let Some(input) = parse_key_id(data) else {
            return false;
        };
        self.resolved.get(keybinding).is_some_and(|keys| {
            keys.iter()
                .any(|key| parse_key_id(key).is_some_and(|parsed| parsed == input))
        })
    }

    pub fn get_keys(&self, keybinding: &str) -> Vec<String> {
        self.resolved.get(keybinding).cloned().unwrap_or_default()
    }

    pub fn first_key(&self, keybinding: &str) -> Option<String> {
        self.get_keys(keybinding).into_iter().next()
    }

    /// TS `keyText(keybinding)`: every key of the binding formatted and
    /// joined with "/" ("Esc/Ctrl+C"); an unbound id renders empty.
    pub fn key_text(&self, keybinding: &str) -> String {
        format_key_text(&self.get_keys(keybinding).join("/"))
    }

    pub fn get_definition(&self, keybinding: &str) -> Option<&KeybindingDefinition> {
        self.definitions.get(keybinding)
    }

    /// The raw user bindings (TS `getUserBindings`): migrated ids with the
    /// well-formed key lists, unknown ids included.
    pub fn get_user_bindings(&self) -> &KeybindingsConfig {
        &self.user_bindings
    }

    /// TS `getConflicts`: keys explicitly claimed by more than one user
    /// binding.
    pub fn get_conflicts(&self) -> &[KeybindingConflict] {
        &self.conflicts
    }

    /// TS `getEffectiveConfig` / `getResolvedBindings`: the effective key
    /// list per definition id (used by extension shortcut conflict rules).
    pub fn get_effective_config(&self) -> BTreeMap<String, Vec<String>> {
        self.resolved.clone()
    }

    pub fn set_user_bindings(&mut self, user_bindings: KeybindingsConfig) {
        self.user_bindings = user_bindings;
        self.rebuild();
    }

    /// Load user bindings from a keybindings.json file (missing file = defaults).
    pub fn load_from_file(path: &Path) -> Self {
        Self::with_user_bindings(load_config(path))
    }
}

impl Default for KeybindingsManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The platform flavor used to label modifier keys in hints (TS
/// `formatKeyPart`'s `platform` parameter, `process.platform` at the call
/// sites): macOS terminals send the literal Control key, so `alt` is
/// labeled `Option` and control is never relabeled as Cmd.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LabelPlatform {
    /// `process.platform === "darwin"`: `alt` renders as `Option`.
    Macos,
    /// Every other platform: `alt` renders as `Alt`.
    Other,
}

impl LabelPlatform {
    /// The platform the binary is running on.
    fn host() -> Self {
        if std::env::consts::OS == "macos" {
            Self::Macos
        } else {
            Self::Other
        }
    }

    fn is_macos(self) -> bool {
        matches!(self, Self::Macos)
    }
}

/// Format a key id for display in hints ("ctrl+o" -> "Ctrl+O", arrows to
/// glyphs; `alt` renders as `Option` on macOS, `Alt` elsewhere).
pub fn format_key_text(key: &str) -> String {
    format_key_text_on(key, LabelPlatform::host())
}

/// The platform-explicit form of [`format_key_text`] (TS `formatKeyText(key,
/// platform)`), so the label choice is testable on every host.
fn format_key_text_on(key: &str, platform: LabelPlatform) -> String {
    key.split('/')
        .map(|binding| {
            binding
                .split('+')
                .map(|part| match part {
                    "escape" => "Esc".to_string(),
                    "up" => "\u{2191}".to_string(),
                    "down" => "\u{2193}".to_string(),
                    "left" => "\u{2190}".to_string(),
                    "right" => "\u{2192}".to_string(),
                    "pageUp" => "PageUp".to_string(),
                    "pageDown" => "PageDown".to_string(),
                    // macOS labels the modifier after the keyboard row
                    // (Option), like TS formatKeyPart's darwin branch.
                    "alt" if platform.is_macos() => "Option".to_string(),
                    // The macOS Cmd key — a prompt-editor-keybinds label
                    // addition (TS never renders a super binding).
                    "super" if platform.is_macos() => "Cmd".to_string(),
                    other => {
                        let mut c = other.chars();
                        match c.next() {
                            Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                            None => String::new(),
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join("+")
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(entries: &[(&str, &[&str])]) -> KeybindingsConfig {
        entries
            .iter()
            .map(|(id, keys)| {
                (
                    id.to_string(),
                    keys.iter().map(ToString::to_string).collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    #[test]
    fn defaults_match_ts() {
        let kb = KeybindingsManager::new();
        assert!(kb.matches("ctrl+o", "app.tools.expand"));
        assert!(kb.matches("escape", "app.input.clear"));
        assert!(kb.matches("ctrl+shift+down", "tui.viewport.follow"));
        assert!(kb.matches("shift+alt+up", "tui.viewport.top"));
        assert!(kb.matches("ctrl+w", "tui.editor.deleteWordBackward"));
        assert!(kb.matches("alt+backspace", "tui.editor.deleteWordBackward"));
        assert!(kb.matches("ctrl+-", "tui.editor.undo"));
        assert!(kb.matches("shift+enter", "tui.input.newLine"));
        assert!(!kb.matches("ctrl+o", "app.clear"));
    }

    #[test]
    fn user_rebind_supersedes_scope_default() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &["ctrl+e"])]));
        assert!(kb.matches("ctrl+e", "app.tools.expand"));
        // ctrl+e is also editor cursorLineEnd default in the same scope:
        // claimed => removed there.
        assert!(!kb.matches("ctrl+e", "tui.editor.cursorLineEnd"));
        assert!(kb.matches("end", "tui.editor.cursorLineEnd"));
    }

    #[test]
    fn keeps_shared_defaults_when_user_binding_repeats_own_default() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[(
            "tui.input.submit",
            &["enter", "ctrl+enter"],
        )]));
        assert_eq!(
            kb.get_keys("tui.input.submit"),
            vec!["enter".to_string(), "ctrl+enter".to_string()]
        );
        assert_eq!(kb.get_keys("tui.select.confirm"), vec!["enter".to_string()]);
    }

    #[test]
    fn keeps_shared_cursor_defaults_when_user_binding_repeats_own_default() {
        let kb =
            KeybindingsManager::with_user_bindings(cfg(&[("tui.select.up", &["up", "ctrl+p"])]));
        assert_eq!(
            kb.get_keys("tui.select.up"),
            vec!["up".to_string(), "ctrl+p".to_string()]
        );
        assert_eq!(kb.get_keys("tui.editor.cursorUp"), vec!["up".to_string()]);
    }

    #[test]
    fn evicts_defaults_claimed_as_added_user_binding() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[(
            "tui.editor.cursorUp",
            &["up", "ctrl+b"],
        )]));
        assert_eq!(
            kb.get_keys("tui.editor.cursorUp"),
            vec!["up".to_string(), "ctrl+b".to_string()]
        );
        // cursorLeft loses its ctrl+b default (same editor scope, added claim).
        assert_eq!(
            kb.get_keys("tui.editor.cursorLeft"),
            vec!["left".to_string()]
        );
    }

    #[test]
    fn reports_direct_user_binding_conflicts() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[
            ("tui.input.submit", &["ctrl+x"]),
            ("tui.select.confirm", &["ctrl+x"]),
        ]));
        // TS preserves the config's insertion order; the Rust config store
        // is a BTreeMap, so the claimants list is deterministic by binding
        // id ("tui.input.submit" sorts first, the TS config order too).
        assert_eq!(
            kb.get_conflicts(),
            &[KeybindingConflict {
                key: "ctrl+x".to_string(),
                keybindings: vec![
                    "tui.input.submit".to_string(),
                    "tui.select.confirm".to_string(),
                ],
            }]
        );
        assert_eq!(
            kb.get_keys("tui.editor.cursorLeft"),
            vec!["left".to_string(), "ctrl+b".to_string()]
        );
    }

    #[test]
    fn reports_conflicts_when_explicit_binding_restates_default() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[
            ("tui.editor.cursorUp", &["up", "ctrl+b"]),
            ("tui.editor.cursorLeft", &["left", "ctrl+b"]),
        ]));
        assert_eq!(
            kb.get_conflicts(),
            &[KeybindingConflict {
                key: "ctrl+b".to_string(),
                keybindings: vec![
                    "tui.editor.cursorLeft".to_string(),
                    "tui.editor.cursorUp".to_string(),
                ],
            }]
        );
        assert_eq!(
            kb.get_keys("tui.editor.cursorUp"),
            vec!["up".to_string(), "ctrl+b".to_string()]
        );
        assert_eq!(
            kb.get_keys("tui.editor.cursorLeft"),
            vec!["left".to_string(), "ctrl+b".to_string()]
        );
    }

    #[test]
    fn dedupes_user_binding_keys() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[(
            "tui.input.submit",
            &["enter", "enter", "ctrl+enter"],
        )]));
        assert_eq!(
            kb.get_keys("tui.input.submit"),
            vec!["enter".to_string(), "ctrl+enter".to_string()]
        );
    }

    #[test]
    fn empty_user_array_disables_binding() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &[])]));
        assert!(kb.get_keys("app.tools.expand").is_empty());
        assert!(!kb.matches("ctrl+o", "app.tools.expand"));
    }

    #[test]
    fn unknown_user_ids_stay_but_never_resolve() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[("not.a.binding", &["ctrl+q"])]));
        assert_eq!(
            kb.get_user_bindings().get("not.a.binding").unwrap(),
            &["ctrl+q".to_string()]
        );
        assert!(kb.get_keys("not.a.binding").is_empty());
        // The unknown claim frees nothing (no definition owns it).
        assert_eq!(
            kb.get_keys("tui.editor.cursorLineStart"),
            vec![
                "home".to_string(),
                "ctrl+a".to_string(),
                "super+left".to_string()
            ]
        );
    }

    /// The prompt-editor-keybinds additions (documented divergence from
    /// the TS table): redo, the selection families, the doc/paragraph
    /// jumps, cut/copy, and transpose resolve with their defaults, and a
    /// user override replaces them like any other binding.
    #[test]
    fn editor_keybind_parity_defaults_resolve() {
        let kb = KeybindingsManager::new();
        assert!(kb.matches("ctrl+shift+z", "tui.editor.redo"));
        assert!(kb.matches("shift+left", "tui.editor.selectLeft"));
        assert!(kb.matches("shift+down", "tui.editor.selectDown"));
        assert!(kb.matches("shift+alt+right", "tui.editor.selectWordRight"));
        assert!(kb.matches("shift+end", "tui.editor.selectLineEnd"));
        assert!(kb.matches("shift+alt+down", "tui.editor.selectParagraphDown"));
        // `shift+ctrl+down` is the viewport-follow key: it must not also
        // claim the editor's paragraph-select (the session dispatch owns
        // it first, so binding both would make the editor default dead).
        assert!(!kb.matches("shift+ctrl+down", "tui.editor.selectParagraphDown"));
        assert!(kb.matches("ctrl+t", "tui.editor.transposeChars"));
        assert!(kb.matches("ctrl+x", "tui.editor.cutSelection"));
        assert!(kb.matches("ctrl+shift+c", "tui.editor.copySelection"));
        assert!(kb.matches("ctrl+home", "tui.editor.cursorDocStart"));
        assert!(kb.matches("ctrl+end", "tui.editor.cursorDocEnd"));
        // A user rebind replaces the default set.
        let rebound =
            KeybindingsManager::with_user_bindings(cfg(&[("tui.editor.redo", &["ctrl+r"])]));
        assert!(rebound.matches("ctrl+r", "tui.editor.redo"));
        assert!(!rebound.matches("ctrl+shift+z", "tui.editor.redo"));
    }

    /// The heartbeats shortcut is gone (the operator's 2026-09-24
    /// directive: "Remove the shortcut of ctrl+r for heartbeats btw"):
    /// ctrl+r binds nothing by default (the /heartbeats command and the
    /// activity dock's heartbeats group own the open paths), and the
    /// rebind-freeing test no longer keeps an app-scope claim for it.
    #[test]
    fn ctrl_r_is_unbound_by_default() {
        let kb = KeybindingsManager::new();
        assert!(kb.get_keys("app.heartbeats.open").is_empty());
        assert!(!kb.matches("ctrl+r", "app.heartbeats.open"));
    }

    #[test]
    fn matching_is_case_and_order_insensitive() {
        let kb = KeybindingsManager::with_user_bindings(cfg(&[("app.tools.expand", &["Ctrl+O"])]));
        assert!(kb.matches("ctrl+o", "app.tools.expand"));
        // A ctrl+shift binding matches the event id with shift first.
        assert!(kb.matches("shift+ctrl+down", "tui.viewport.follow"));
        // "esc" and "escape" name the same key (TS matchesKey).
        assert!(kb.matches("esc", "tui.select.cancel"));
        assert!(kb.matches("escape", "tui.select.cancel"));
        // An empty or trailing-modifier id never matches.
        assert!(!kb.matches("", "app.tools.expand"));
        assert!(!kb.matches("ctrl+", "app.tools.expand"));
    }

    #[test]
    fn migrate_renames_legacy_ids_and_orders() {
        let mut raw = serde_json::Map::new();
        raw.insert("expandTools".to_string(), serde_json::json!("ctrl+x"));
        raw.insert("cursorUp".to_string(), serde_json::json!(["up", "ctrl+p"]));
        raw.insert(
            "app.message.dequeue".to_string(),
            serde_json::json!("alt+u"),
        );
        let (config, migrated) = migrate_keybindings_config(&raw);
        assert!(migrated);
        // Definition order first (the ordered config carries it).
        let keys: Vec<&str> = config.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "tui.editor.cursorUp",
                "app.tools.expand",
                "app.message.navigateOlder",
            ]
        );
        let by_id = |id: &str| {
            config
                .iter()
                .find(|(key, _)| key == id)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        assert_eq!(
            by_id("tui.editor.cursorUp"),
            serde_json::json!(["up", "ctrl+p"])
        );
        assert_eq!(by_id("app.tools.expand"), serde_json::json!("ctrl+x"));
    }

    #[test]
    fn migrate_keeps_current_name_when_both_exist() {
        let mut raw = serde_json::Map::new();
        raw.insert("expandTools".to_string(), serde_json::json!("ctrl+x"));
        raw.insert("app.tools.expand".to_string(), serde_json::json!("ctrl+y"));
        let (config, migrated) = migrate_keybindings_config(&raw);
        assert!(migrated);
        assert_eq!(
            config,
            vec![("app.tools.expand".to_string(), serde_json::json!("ctrl+y"))]
        );
    }

    #[test]
    fn load_migrates_legacy_names_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let mut raw = serde_json::Map::new();
        raw.insert("selectConfirm".to_string(), serde_json::json!("enter"));
        raw.insert("interrupt".to_string(), serde_json::json!("ctrl+x"));
        std::fs::write(
            dir.path().join("keybindings.json"),
            serde_json::to_string(&serde_json::Value::Object(raw)).unwrap(),
        )
        .unwrap();
        let kb = KeybindingsManager::create(dir.path());
        assert_eq!(
            kb.get_user_bindings()["tui.select.confirm"],
            vec!["enter".to_string()]
        );
        assert_eq!(
            kb.get_user_bindings()["app.interrupt"],
            vec!["ctrl+x".to_string()]
        );
        assert!(kb.matches("enter", "tui.select.confirm"));
        assert!(kb.matches("ctrl+x", "app.interrupt"));
    }

    #[test]
    fn load_drops_malformed_values() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("keybindings.json"),
            r#"{
  "app.tools.expand": ["ctrl+o", "alt+o"],
  "app.model.select": 5,
  "app.exit": ["ctrl+d", 3],
  "tui.input.submit": "enter",
  "app.interrupt": []
}"#,
        )
        .unwrap();
        let kb = KeybindingsManager::create(dir.path());
        // Well-formed single + array values load.
        assert_eq!(
            kb.get_user_bindings()["tui.input.submit"],
            vec!["enter".to_string()]
        );
        assert_eq!(
            kb.get_user_bindings()["app.tools.expand"],
            vec!["ctrl+o".to_string(), "alt+o".to_string()]
        );
        // A number and a mixed array drop.
        assert!(!kb.get_user_bindings().contains_key("app.model.select"));
        assert!(!kb.get_user_bindings().contains_key("app.exit"));
        // An empty array is a binding disable, not malformed.
        assert!(kb.get_user_bindings().contains_key("app.interrupt"));
        assert!(kb.get_keys("app.interrupt").is_empty());
    }

    #[test]
    fn missing_or_malformed_file_loads_defaults() {
        let empty = tempfile::tempdir().unwrap();
        let kb = KeybindingsManager::create(empty.path());
        assert!(kb.get_user_bindings().is_empty());
        assert!(kb.matches("ctrl+o", "app.tools.expand"));

        let malformed = tempfile::tempdir().unwrap();
        std::fs::write(malformed.path().join("keybindings.json"), "not json").unwrap();
        let kb = KeybindingsManager::create(malformed.path());
        assert!(kb.get_user_bindings().is_empty());

        let array = tempfile::tempdir().unwrap();
        std::fs::write(
            array.path().join("keybindings.json"),
            r#"["app.tools.expand"]"#,
        )
        .unwrap();
        let kb = KeybindingsManager::create(array.path());
        assert!(kb.get_user_bindings().is_empty());
    }

    #[test]
    fn reload_picks_up_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("keybindings.json"),
            r#"{"app.tools.expand": "ctrl+e"}"#,
        )
        .unwrap();
        let mut kb = KeybindingsManager::create(dir.path());
        assert!(kb.matches("ctrl+e", "app.tools.expand"));
        assert!(!kb.matches("ctrl+o", "app.tools.expand"));
        std::fs::write(
            dir.path().join("keybindings.json"),
            r#"{"app.tools.expand": "ctrl+t"}"#,
        )
        .unwrap();
        kb.reload();
        assert!(kb.matches("ctrl+t", "app.tools.expand"));
        assert!(!kb.matches("ctrl+e", "app.tools.expand"));
    }

    #[test]
    fn startup_migration_rewrites_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("keybindings.json");
        std::fs::write(
            &config_path,
            "{\n  \"cursorUp\": [\"up\", \"ctrl+p\"],\n  \"expandTools\": \"ctrl+x\"\n}\n",
        )
        .unwrap();
        assert!(migrate_keybindings_file(dir.path()).unwrap());
        let rewritten = std::fs::read_to_string(&config_path).unwrap();
        assert_eq!(
            rewritten,
            "{\n  \"tui.editor.cursorUp\": [\n    \"up\",\n    \"ctrl+p\"\n  ],\n  \"app.tools.expand\": \"ctrl+x\"\n}\n"
        );
        // A second run is a no-op (nothing left to migrate).
        assert!(!migrate_keybindings_file(dir.path()).unwrap());
    }

    #[test]
    fn startup_migration_skips_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!migrate_keybindings_file(dir.path()).unwrap());
    }

    #[test]
    fn editor_claims_free_app_defaults_in_editor_scope() {
        // TS keybindings-migration.test: explicit editor bindings win over
        // same-scope application defaults.
        let kb = KeybindingsManager::with_user_bindings(cfg(&[
            ("tui.editor.cursorUp", &["up", "ctrl+o"]),
            ("tui.editor.cursorDown", &["down", "ctrl+n"]),
        ]));
        assert_eq!(
            kb.get_keys("tui.editor.cursorUp"),
            vec!["up".to_string(), "ctrl+o".to_string()]
        );
        assert!(kb.get_keys("app.tools.expand").is_empty());
        // No scope => a claim never frees its default.
        assert_eq!(kb.get_keys("app.agents.new"), vec!["ctrl+n".to_string()]);
    }

    #[test]
    fn effective_config_covers_every_definition() {
        let kb = KeybindingsManager::new();
        let effective = kb.get_effective_config();
        assert_eq!(
            effective.len(),
            TUI_KEYBINDINGS.len() + APP_KEYBINDINGS.len()
        );
        assert_eq!(
            effective.get("tui.viewport.follow"),
            Some(&vec!["ctrl+shift+down".to_string()])
        );
    }

    #[test]
    fn formats_key_text() {
        assert_eq!(format_key_text("ctrl+o"), "Ctrl+O");
        assert_eq!(format_key_text("shift+alt+up"), "Shift+Alt+\u{2191}");
        assert_eq!(format_key_text("escape"), "Esc");
        assert_eq!(format_key_text("ctrl+o/alt+o"), "Ctrl+O/Alt+O");
    }

    #[test]
    fn formats_alt_label_per_platform() {
        // TS formatKeyPart: darwin renders `alt` as `Option` (the macOS
        // keyboard row), every other platform keeps `Alt`.
        assert_eq!(
            format_key_text_on("alt+b", LabelPlatform::Macos),
            "Option+B"
        );
        assert_eq!(format_key_text_on("alt+b", LabelPlatform::Other), "Alt+B");
        assert_eq!(
            format_key_text_on("shift+alt+left", LabelPlatform::Macos),
            "Shift+Option+\u{2190}"
        );
        // Multiple bindings split by `/` keep their platform label per part,
        // and control is never relabeled as Cmd.
        assert_eq!(
            format_key_text_on("alt+o/ctrl+o", LabelPlatform::Macos),
            "Option+O/Ctrl+O"
        );
    }
}
