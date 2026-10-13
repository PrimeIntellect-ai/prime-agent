//! Global keybinding registry with TS DEFAULT_* defaults, port of
//! `packages/tui/src/keybindings.ts` +
//! `coding-agent/src/core/keybindings.ts`. Every binding is configurable via
//! `~/.prime/agent/keybindings.json`; user bindings load with the TS parse semantics: legacy names
//! migrate, malformed values drop, an empty array disables a binding.

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

mod definitions;

pub use definitions::{APP_KEYBINDINGS, TUI_KEYBINDINGS};

pub type KeybindingsConfig = BTreeMap<String, Vec<String>>;

/// One explicit conflict (TS `KeybindingConflict`): a key claimed by more than one user binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingConflict {
    pub key: String,
    pub keybindings: Vec<String>,
}

/// A parsed key id (TS `parseKeyId`): the modifier set plus the base key, lowercase, so
/// matching is case- and order-insensitive exactly like `matchesKey`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedKeyId {
    key: String,
    ctrl: bool,
    shift: bool,
    alt: bool,
    super_key: bool,
}

/// TS `parseKeyId`: split on `+`, the last part is the key, the rest are modifiers; `esc` and
/// `escape` name the same key. An empty key id or trailing `+` parses to `None` (never matches).
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

/// TS `normalizeKeys`: dedupe preserving first-seen order; a single key is a one-element
/// list. Malformed ids stay (they simply never match, like TS).
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

/// The config object as an ordered entry list (`serde_json` maps sort keys, so the TS object order
/// — definition ids first, extras sorted after — is carried by this vector).
pub type OrderedConfig = Vec<(String, serde_json::Value)>;

/// TS `migrateKeybindingsConfig`: rename legacy ids (a legacy entry is dropped when its
/// current name also exists) and order the object with known ids first. Values are
/// carried over unchanged. Returns the migrated entries and whether any rename happened.
#[must_use]
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

/// TS `orderKeybindingsConfig`: known ids first in definition order, the rest sorted.
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

/// TS `toKeybindingsConfig`: a value is a key list only when it is a string or an array whose every
/// entry is a string (an empty array disables the binding); anything else drops.
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

/// Write a JSON object with the TS `JSON.stringify(config, null, 2)` formatting: two-space nesting,
/// a trailing newline. Written by hand so the definition-first key ordering survives.
fn write_json_object(path: &Path, entries: &OrderedConfig) -> Result<()> {
    let mut out = String::from("{\n");
    let count = entries.len();
    for (index, (key, value)) in entries.iter().enumerate() {
        out.push_str("  ");
        out.push_str(&serde_json::to_string(key)?);
        out.push_str(": ");
        // `JSON.stringify(config, null, 2)`: a property's nested values sit two deeper than the
        // property's own indent (key at 2, nested elements at 4, closing bracket back at 2).
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
/// `coding-agent/src/migrations.ts`): rewrite `<agentDir>/keybindings.json` with migrated
/// names when any legacy id was found; a missing or malformed file is a no-op. Returns
/// whether the file was rewritten.
///
/// # Errors
///
/// Returns `Err` when serializing or writing the rewritten `keybindings.json` fails.
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
    #[must_use]
    pub fn new() -> Self {
        Self::with_user_bindings(KeybindingsConfig::new())
    }

    #[must_use]
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
    /// `<agentDir>/keybindings.json` (legacy names migrated, malformed values dropped),
    /// remembered for [`reload`](Self::reload).
    #[must_use]
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

    /// Mirrors TS `KeybindingsManager.rebuild()`: user bindings replace a definition's keys
    /// outright; within the same default scope, a key a user binding adds is freed from the other
    /// defaults in that scope; keys claimed by more than one user binding are reported as
    /// conflicts.
    fn rebuild(&mut self) {
        // Explicit claims: every key each known user binding names; added claims: the ones outside
        // that binding's own defaults (these free same-scope defaults of other bindings).
        let mut explicit_claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut added_claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, keys) in &self.user_bindings {
            let Some(definition) = self.definitions.get(id.as_str()) else {
                // Unknown ids never resolve; they stay in the config for the round-trip.
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
    #[must_use]
    pub fn matches(&self, data: &str, keybinding: &str) -> bool {
        let Some(input) = parse_key_id(data) else {
            return false;
        };
        self.resolved.get(keybinding).is_some_and(|keys| {
            keys.iter()
                .any(|key| parse_key_id(key).is_some_and(|parsed| parsed == input))
        })
    }

    #[must_use]
    pub fn get_keys(&self, keybinding: &str) -> Vec<String> {
        self.resolved.get(keybinding).cloned().unwrap_or_default()
    }

    /// Whether `data` is the macOS option-composed form of one of the id's bound keys (TS
    /// `matches(keyData, id, { optionComposed: true })`: Option+S types `ß` on layouts without
    /// option-as-meta, and the composed character must toggle like Alt+S; only an alt-only binding
    /// composes).
    #[must_use]
    pub fn matches_option_composed(&self, data: &str, keybinding: &str) -> bool {
        self.resolved.get(keybinding).is_some_and(|keys| {
            keys.iter().any(|key| {
                let composed = parse_key_id(key).and_then(|parsed| {
                    (parsed.alt
                        && !parsed.ctrl
                        && !parsed.shift
                        && !parsed.super_key
                        && parsed.key == "s")
                        .then_some("\u{df}")
                });
                composed.is_some_and(|composed| composed == data)
            })
        })
    }

    #[must_use]
    pub fn first_key(&self, keybinding: &str) -> Option<String> {
        self.get_keys(keybinding).into_iter().next()
    }

    /// TS `keyText(keybinding)`: every key of the binding formatted and joined with "/"
    /// ("Esc/Ctrl+C"); an unbound id renders empty.
    #[must_use]
    pub fn key_text(&self, keybinding: &str) -> String {
        format_key_text(&self.get_keys(keybinding).join("/"))
    }

    #[must_use]
    pub fn get_definition(&self, keybinding: &str) -> Option<&KeybindingDefinition> {
        self.definitions.get(keybinding)
    }

    /// The raw user bindings (TS `getUserBindings`): migrated ids with the well-formed
    /// key lists, unknown ids included.
    #[must_use]
    pub fn get_user_bindings(&self) -> &KeybindingsConfig {
        &self.user_bindings
    }

    /// TS `getConflicts`: keys explicitly claimed by more than one user binding.
    #[must_use]
    pub fn get_conflicts(&self) -> &[KeybindingConflict] {
        &self.conflicts
    }

    /// TS `getEffectiveConfig` / `getResolvedBindings`: the effective key list
    /// per definition id (used by shortcut conflict rules).
    #[must_use]
    pub fn get_effective_config(&self) -> BTreeMap<String, Vec<String>> {
        self.resolved.clone()
    }

    pub fn set_user_bindings(&mut self, user_bindings: KeybindingsConfig) {
        self.user_bindings = user_bindings;
        self.rebuild();
    }

    /// Load user bindings from a keybindings.json file (missing file = defaults).
    #[must_use]
    pub fn load_from_file(path: &Path) -> Self {
        Self::with_user_bindings(load_config(path))
    }
}

impl Default for KeybindingsManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The platform flavor used to label modifier keys in hints (TS `formatKeyPart`'s `platform`
/// parameter): macOS labels `alt` as `Option` and never relabels control as Cmd.
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

/// Format a key id for display in hints ("ctrl+o" -> "Ctrl+O", arrows to glyphs;
/// `alt` renders as `Option` on macOS, `Alt` elsewhere).
#[must_use]
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
mod tests;
