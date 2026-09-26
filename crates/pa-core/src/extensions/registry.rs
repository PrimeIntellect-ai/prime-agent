//! The in-Rust mirror of registered extension state (design doc §3.2
//! `registry.rs`): tools, commands, flags, shortcuts, message-renderer
//! types, and queued provider registrations collected from the sidecar.
//!
//! The registry keeps one [`ExtensionRegistration`] per loaded extension, in
//! load order, and derives every view with the TS runner's rules:
//! - tools: first registration per name wins across extensions
//!   (runner.ts `getAllRegisteredTools`);
//! - commands: collision suffixing `name:2`, `name:3`, ... for the
//!   invocation names (runner.ts `resolveRegisteredCommands`);
//! - flags: first registration per name wins (`getFlags`), with values from
//!   CLI overrides (`flagValues`) over registered defaults;
//! - shortcuts: keys normalized to lowercase, extension-vs-extension
//!   conflicts resolve last-wins with a diagnostic, reserved built-ins win
//!   (`getShortcuts`);
//! - events: the set of event names with at least one handler
//!   (`hasHandlers` gating).

use std::collections::{BTreeMap, HashMap, HashSet};

use pa_types::extension_rpc::{ExtensionRegistration, ToolRegistration};
use pa_types::JsonMap;
use serde_json::Value;

/// A command after collision resolution (TS `ResolvedCommand`, the fields
/// the session surfaces consume).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedExtensionCommand {
    /// The name the extension registered (`registerCommand` first argument).
    pub name: String,
    /// The name dispatch and autocomplete use: `name`, or `name:N` when
    /// multiple extensions registered the same name.
    pub invocation_name: String,
    pub description: Option<String>,
    pub extension_path: String,
}

/// A shortcut after the conflict rules (TS `getShortcuts` output entries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedShortcut {
    /// Normalized (lowercase) key id.
    pub key: String,
    pub description: Option<String>,
    pub extension_path: String,
}

/// A warning-level diagnostic from registration resolution (TS
/// `ResourceDiagnostic { type: "warning" }`; surfaces in startup notices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationDiagnostic {
    pub message: String,
    pub path: String,
}

/// The TS runner.ts `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` list:
/// extension shortcuts lose against these canonical builtin ids. Ported as
/// data (runner.ts L63-83) so the conflict rules stay byte-comparable.
pub const RESERVED_KEYBINDING_IDS: &[&str] = &[
    "app.interrupt",
    "app.clear",
    "app.exit",
    "app.suspend",
    "app.model.select",
    "app.model.cycleForward",
    "app.model.cycleBackward",
    "app.tools.expand",
    "app.subagents.focus",
    "app.editor.external",
    "app.message.followUp",
    "tui.input.submit",
    "tui.select.confirm",
    "tui.select.cancel",
    "tui.input.copy",
    "tui.editor.deleteToLineEnd",
];

/// The builtin keybinding table the shortcut conflict rules need: normalized
/// key id -> (canonical binding id, whether extension overrides are blocked).
#[derive(Debug, Clone, Default)]
pub struct BuiltinKeybindings {
    /// Key id -> (keybinding id, `restrict_override`).
    pub by_key: HashMap<String, (String, bool)>,
}

impl BuiltinKeybindings {
    /// Build the table from resolved builtin bindings (pa-tui's config
    /// surface), the TS `buildBuiltinKeybindings` rules: keys normalize to
    /// lowercase, and a reserved action wins over a non-reserved action
    /// bound to the same key.
    pub fn from_bindings(bindings: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        let mut by_key: HashMap<String, (String, bool)> = HashMap::new();
        for (keybinding, keys) in bindings {
            let restrict = RESERVED_KEYBINDING_IDS.contains(&keybinding.as_str());
            for key in keys {
                let normalized = key.to_lowercase();
                match by_key.get(&normalized) {
                    Some((_, existing_restrict)) if *existing_restrict && !restrict => {}
                    _ => {
                        by_key.insert(normalized, (keybinding.clone(), restrict));
                    }
                }
            }
        }
        BuiltinKeybindings { by_key }
    }

    fn conflict(&self, key: &str) -> Option<(&str, bool)> {
        self.by_key
            .get(key)
            .map(|(keybinding, restrict)| (keybinding.as_str(), *restrict))
    }
}

/// The registry: one registration per extension path, in load order.
#[derive(Debug, Clone, Default)]
pub struct ExtensionRegistry {
    by_path: Vec<ExtensionRegistration>,
}

impl ExtensionRegistry {
    pub fn from_registrations(registrations: &[ExtensionRegistration]) -> Self {
        ExtensionRegistry {
            by_path: registrations.to_vec(),
        }
    }

    /// True when empty: no sidecar state landed (the session proceeds
    /// without extension machinery, preserving the fast path).
    pub fn is_empty(&self) -> bool {
        self.by_path.is_empty()
    }

    /// Merge a full load cycle (the `hello` result registrations).
    pub fn merge_load(&mut self, registrations: &[ExtensionRegistration]) {
        for registration in registrations {
            self.merge_notification(registration.clone());
        }
    }

    /// Merge one extension's (re)registration: a post-hello
    /// `registration` notification replaces that extension's contribution
    /// in place (load order preserved), or appends it when new.
    pub fn merge_notification(&mut self, registration: ExtensionRegistration) {
        if let Some(existing) = self
            .by_path
            .iter_mut()
            .find(|existing| existing.path == registration.path)
        {
            *existing = registration;
        } else {
            self.by_path.push(registration);
        }
    }

    /// All loaded extensions, in load order.
    pub fn extensions(&self) -> &[ExtensionRegistration] {
        &self.by_path
    }

    /// Registered tools, first registration per name wins across
    /// extensions (runner.ts `getAllRegisteredTools`).
    pub fn tools(&self) -> Vec<&ToolRegistration> {
        let mut seen = HashSet::new();
        let mut tools = Vec::new();
        for extension in &self.by_path {
            for tool in &extension.tools {
                if seen.insert(tool.name.clone()) {
                    tools.push(tool);
                }
            }
        }
        tools
    }

    /// A tool definition by name (first-wins, `getToolDefinition`).
    pub fn tool(&self, name: &str) -> Option<&ToolRegistration> {
        self.tools().into_iter().find(|tool| tool.name == name)
    }

    /// Commands with invocation names (runner.ts `resolveRegisteredCommands`
    /// collision suffixing).
    pub fn commands(&self) -> Vec<ResolvedExtensionCommand> {
        let mut commands = Vec::new();
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for extension in &self.by_path {
            for command in &extension.commands {
                commands.push((extension, command));
                *counts.entry(command.name.as_str()).or_default() += 1;
            }
        }
        let mut seen: HashMap<&str, usize> = HashMap::new();
        let mut taken: HashSet<String> = HashSet::new();
        commands
            .into_iter()
            .map(|(extension, command)| {
                let occurrence = seen.entry(command.name.as_str()).or_default();
                *occurrence += 1;
                let base = if counts[command.name.as_str()] > 1 {
                    format!("{}:{occurrence}", command.name)
                } else {
                    command.name.clone()
                };
                let mut invocation_name = base;
                if taken.contains(&invocation_name) {
                    let mut suffix = *occurrence;
                    loop {
                        suffix += 1;
                        invocation_name = format!("{}:{suffix}", command.name);
                        if !taken.contains(&invocation_name) {
                            break;
                        }
                    }
                }
                taken.insert(invocation_name.clone());
                ResolvedExtensionCommand {
                    name: command.name.clone(),
                    invocation_name,
                    description: command.description.clone(),
                    extension_path: extension.path.clone(),
                }
            })
            .collect()
    }

    /// A command by invocation name (runner.ts `getCommand`).
    pub fn command(&self, invocation_name: &str) -> Option<ResolvedExtensionCommand> {
        self.commands()
            .into_iter()
            .find(|command| command.invocation_name == invocation_name)
    }

    /// Flags, first registration per name wins (runner.ts `getFlags`).
    pub fn flags(&self) -> Vec<&pa_types::extension_rpc::FlagRegistration> {
        let mut seen = HashSet::new();
        let mut flags = Vec::new();
        for extension in &self.by_path {
            for flag in &extension.flags {
                if seen.insert(flag.name.clone()) {
                    flags.push(flag);
                }
            }
        }
        flags
    }

    /// Resolved flag values: CLI-provided values win over registered
    /// defaults (the `flagValues`/`setFlagValue` end state); the first
    /// registration of a name owns the default.
    pub fn flag_values(&self, cli_values: &JsonMap) -> BTreeMap<String, Value> {
        let mut values = BTreeMap::new();
        for extension in &self.by_path {
            for flag in &extension.flags {
                if let Some(default) = &flag.default {
                    values
                        .entry(flag.name.clone())
                        .or_insert_with(|| default.clone());
                }
            }
        }
        for (name, value) in cli_values {
            values.insert(name.clone(), value.clone());
        }
        values
    }

    /// Shortcuts after the conflict rules (runner.ts `getShortcuts`):
    /// reserved builtins win, non-reserved builtins lose to the extension
    /// with a diagnostic, extension-vs-extension conflicts resolve
    /// last-wins with a diagnostic. Returns the map plus diagnostics.
    pub fn shortcuts(
        &self,
        builtins: &BuiltinKeybindings,
    ) -> (Vec<ResolvedShortcut>, Vec<RegistrationDiagnostic>) {
        let mut resolved: HashMap<String, ResolvedShortcut> = HashMap::new();
        let mut diagnostics = Vec::new();
        for extension in &self.by_path {
            for shortcut in &extension.shortcuts {
                let key = shortcut.key.to_lowercase();
                match builtins.conflict(&key) {
                    Some((_keybinding, true)) => {
                        diagnostics.push(RegistrationDiagnostic {
                            message: format!(
                                "Extension shortcut '{}' from {} conflicts with built-in shortcut. Skipping.",
                                shortcut.key, extension.path
                            ),
                            path: extension.path.clone(),
                        });
                        continue;
                    }
                    Some((keybinding, false)) => {
                        diagnostics.push(RegistrationDiagnostic {
                            message: format!(
                                "Extension shortcut conflict: '{}' is built-in shortcut for {} and {}. Using {}.",
                                shortcut.key, keybinding, extension.path, extension.path
                            ),
                            path: extension.path.clone(),
                        });
                    }
                    None => {}
                }
                if let Some(existing) = resolved.get(&key) {
                    diagnostics.push(RegistrationDiagnostic {
                        message: format!(
                            "Extension shortcut conflict: '{}' registered by both {} and {}. Using {}.",
                            shortcut.key, existing.extension_path, extension.path, extension.path
                        ),
                        path: extension.path.clone(),
                    });
                }
                resolved.insert(
                    key.clone(),
                    ResolvedShortcut {
                        key,
                        description: shortcut.description.clone(),
                        extension_path: extension.path.clone(),
                    },
                );
            }
        }
        let shortcuts = resolved.into_values().collect();
        (shortcuts, diagnostics)
    }

    /// Event names with at least one handler, for `hasHandlers` gating.
    pub fn handled_events(&self) -> HashSet<String> {
        self.by_path
            .iter()
            .flat_map(|extension| extension.events.iter().cloned())
            .collect()
    }

    /// Whether any extension subscribes to `event` (runner.ts
    /// `hasHandlers`: Rust only emits events with handlers).
    pub fn has_handlers(&self, event: &str) -> bool {
        self.by_path
            .iter()
            .any(|extension| extension.events.iter().any(|name| name == event))
    }

    /// Custom session message types with a registered renderer.
    pub fn message_renderer_types(&self) -> Vec<String> {
        let mut types = Vec::new();
        let mut seen = HashSet::new();
        for extension in &self.by_path {
            for custom_type in &extension.message_renderer_types {
                if seen.insert(custom_type.clone()) {
                    types.push(custom_type.clone());
                }
            }
        }
        types
    }

    /// Queued provider registrations, in load order, first registration of
    /// a name wins (flushed at bind in TS; the provider seam lands with the
    /// event-surface stage).
    pub fn providers(&self) -> Vec<&pa_types::extension_rpc::ProviderRegistration> {
        let mut seen = HashSet::new();
        let mut providers = Vec::new();
        for extension in &self.by_path {
            for provider in &extension.providers {
                if seen.insert(provider.name.clone()) {
                    providers.push(provider);
                }
            }
        }
        providers
    }

    /// Normalized prompt snippets: whitespace collapsed to one line,
    /// empty-after-normalization dropped (TS agent-session.ts
    /// `_normalizePromptSnippet`), keyed by tool name for the custom-prompt
    /// path.
    pub fn prompt_snippets(&self) -> BTreeMap<String, String> {
        let mut snippets = BTreeMap::new();
        for tool in self.tools() {
            if let Some(snippet) = tool
                .prompt_snippet
                .as_deref()
                .and_then(normalize_prompt_snippet)
            {
                snippets.insert(tool.name.clone(), snippet);
            }
        }
        snippets
    }

    /// Normalized prompt guidelines of the registered tools: trimmed,
    /// empty dropped, deduplicated preserving order (TS agent-session.ts
    /// `_normalizePromptGuidelines`).
    pub fn prompt_guidelines(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut guidelines = Vec::new();
        for tool in self.tools() {
            for guideline in tool.prompt_guidelines.iter().flatten() {
                let normalized = guideline.trim();
                if !normalized.is_empty() && seen.insert(normalized.to_string()) {
                    guidelines.push(normalized.to_string());
                }
            }
        }
        guidelines
    }
}

/// TS `_normalizePromptSnippet`: collapse all whitespace runs to single
/// spaces, trim; `Some` only when non-empty.
pub(crate) fn normalize_prompt_snippet(text: &str) -> Option<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::extension_rpc::{
        CommandRegistration, FlagRegistration, FlagType, ShortcutRegistration,
    };
    use serde_json::json;

    fn tool(name: &str) -> ToolRegistration {
        ToolRegistration {
            name: name.to_string(),
            label: name.to_string(),
            description: format!("The {name} tool"),
            prompt_snippet: None,
            prompt_guidelines: None,
            parameters: json!({"type": "object"}),
            execution_mode: None,
        }
    }

    fn extension(path: &str, tools: Vec<ToolRegistration>) -> ExtensionRegistration {
        ExtensionRegistration {
            path: path.to_string(),
            resolved_path: format!("/{path}"),
            events: Vec::new(),
            tools,
            commands: Vec::new(),
            flags: Vec::new(),
            shortcuts: Vec::new(),
            message_renderer_types: Vec::new(),
            providers: Vec::new(),
        }
    }

    #[test]
    fn tools_first_registration_per_name_wins() {
        // runner.ts getAllRegisteredTools: extensions in load order, first
        // registration per name wins.
        let registry = ExtensionRegistry::from_registrations(&[
            extension("first.ts", vec![tool("hello"), tool("only-first")]),
            extension("second.ts", vec![tool("hello"), tool("world")]),
        ]);
        let names: Vec<&str> = registry.tools().iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["hello", "only-first", "world"]);
        assert_eq!(
            registry.tool("hello").map(|t| t.description.as_str()),
            Some("The hello tool")
        );
        // The winner is the first extension's registration.
        assert_eq!(registry.tool("hello").unwrap().label, "hello");
    }

    #[test]
    fn registration_notification_replaces_in_place() {
        let mut registry =
            ExtensionRegistry::from_registrations(&[extension("a.ts", vec![tool("x")])]);
        let mut updated = extension("a.ts", vec![tool("y")]);
        updated.events = vec!["session_start".to_string()];
        registry.merge_notification(updated);
        assert_eq!(registry.extensions().len(), 1);
        assert_eq!(registry.extensions()[0].events, ["session_start"]);
        let names: Vec<&str> = registry.tools().iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["y"]);
        // New paths append (registration order preserved for the rest).
        registry.merge_notification(extension("b.ts", vec![tool("x")]));
        assert_eq!(registry.extensions().len(), 2);
        assert!(registry.has_handlers("session_start"));
        assert!(!registry.has_handlers("tool_call"));
    }

    #[test]
    fn command_collision_suffixes_follow_the_ts_algorithm() {
        // runner.ts resolveRegisteredCommands: three `greet` commands
        // become greet:1, greet:2, greet:3 (every occurrence of a duplicated
        // name is suffixed, starting at 1); a distinct name stays bare.
        let mut a = extension("a.ts", Vec::new());
        a.commands = vec![CommandRegistration {
            name: "greet".to_string(),
            description: Some("a".to_string()),
        }];
        let mut b = extension("b.ts", Vec::new());
        b.commands = vec![CommandRegistration {
            name: "greet".to_string(),
            description: Some("b".to_string()),
        }];
        let mut c = extension("c.ts", Vec::new());
        c.commands = vec![
            CommandRegistration {
                name: "greet".to_string(),
                description: None,
            },
            CommandRegistration {
                name: "unique".to_string(),
                description: None,
            },
        ];
        let registry = ExtensionRegistry::from_registrations(&[a, b, c]);
        let invocations: Vec<(String, String)> = registry
            .commands()
            .iter()
            .map(|c| (c.invocation_name.clone(), c.extension_path.clone()))
            .collect();
        assert_eq!(
            invocations,
            [
                ("greet:1".to_string(), "a.ts".to_string()),
                ("greet:2".to_string(), "b.ts".to_string()),
                ("greet:3".to_string(), "c.ts".to_string()),
                ("unique".to_string(), "c.ts".to_string()),
            ]
        );
        assert_eq!(registry.command("greet:2").unwrap().name, "greet");
        assert_eq!(registry.command("greet:1").unwrap().extension_path, "a.ts");
        assert!(registry.command("greet:4").is_none());
    }

    #[test]
    fn flags_and_values_cli_overrides_defaults() {
        let mut a = extension("a.ts", Vec::new());
        a.flags = vec![
            FlagRegistration {
                name: "fast".to_string(),
                description: None,
                r#type: FlagType::Boolean,
                default: Some(json!(false)),
            },
            FlagRegistration {
                name: "label".to_string(),
                description: None,
                r#type: FlagType::String,
                default: Some(json!("a-label")),
            },
        ];
        let mut b = extension("b.ts", Vec::new());
        b.flags = vec![FlagRegistration {
            name: "fast".to_string(),
            description: None,
            r#type: FlagType::Boolean,
            default: Some(json!(true)),
        }];
        let registry = ExtensionRegistry::from_registrations(&[a, b]);
        // First registration wins for the definition.
        assert_eq!(registry.flags().len(), 2);
        let mut cli = JsonMap::new();
        cli.insert("fast".to_string(), json!(true));
        let values = registry.flag_values(&cli);
        assert_eq!(values.get("fast"), Some(&json!(true)));
        assert_eq!(values.get("label"), Some(&json!("a-label")));
    }

    #[test]
    fn shortcuts_reserved_and_conflict_rules_match_ts() {
        let mut a = extension("a.ts", Vec::new());
        a.shortcuts = vec![
            ShortcutRegistration {
                key: "F1".to_string(),
                description: Some("a f1".to_string()),
            },
            ShortcutRegistration {
                key: "ctrl+c".to_string(),
                description: None,
            },
        ];
        let mut b = extension("b.ts", Vec::new());
        b.shortcuts = vec![
            ShortcutRegistration {
                key: "f1".to_string(),
                description: Some("b f1".to_string()),
            },
            ShortcutRegistration {
                key: "f2".to_string(),
                description: None,
            },
        ];
        let registry = ExtensionRegistry::from_registrations(&[a, b]);
        let builtins = BuiltinKeybindings::from_bindings([
            ("app.interrupt".to_string(), vec!["ctrl+c".to_string()]),
            ("tui.input.submit".to_string(), vec!["enter".to_string()]),
        ]);
        let (shortcuts, diagnostics) = registry.shortcuts(&builtins);
        // Reserved ctrl+c is skipped; f1 normalizes and resolves last-wins.
        assert_eq!(shortcuts.len(), 2, "{shortcuts:?}");
        let f1 = shortcuts
            .iter()
            .find(|s| s.key == "f1")
            .expect("normalized lowercase key");
        assert_eq!(f1.extension_path, "b.ts");
        assert!(shortcuts.iter().any(|s| s.key == "f2"));
        let messages: Vec<&str> = diagnostics.iter().map(|d| d.message.as_str()).collect();
        assert_eq!(messages.len(), 2, "{messages:?}");
        assert!(messages[0].contains("conflicts with built-in shortcut"));
        assert!(
            messages[1].contains("registered by both a.ts and b.ts. Using b.ts."),
            "{messages:?}"
        );
    }

    #[test]
    fn builtin_keybindings_restricted_action_wins_on_shared_key() {
        // buildBuiltinKeybindings: when two actions bind the same key, the
        // reserved one wins regardless of iteration order.
        let builtins = BuiltinKeybindings::from_bindings([
            ("app.clear".to_string(), vec!["ctrl+l".to_string()]),
            ("app.interrupt".to_string(), vec!["ctrl+l".to_string()]),
        ]);
        assert_eq!(
            builtins.conflict("ctrl+l"),
            Some(("app.interrupt", true)),
            "reserved restrictOverride wins"
        );
    }

    #[test]
    fn prompt_snippets_and_guidelines_normalize_like_ts() {
        let mut t = tool("hello");
        t.prompt_snippet = Some("  - hello: says\n   hello\t  ".to_string());
        t.prompt_guidelines = Some(vec![
            "   Always greet.  ".to_string(),
            "Always greet.".to_string(),
            "   ".to_string(),
            "Then stop.".to_string(),
        ]);
        let registry = ExtensionRegistry::from_registrations(&[extension("a.ts", vec![t])]);
        let snippets = registry.prompt_snippets();
        assert_eq!(
            snippets.get("hello").map(String::as_str),
            Some("- hello: says hello")
        );
        assert_eq!(
            registry.prompt_guidelines(),
            ["Always greet.", "Then stop."]
        );
    }

    #[test]
    fn providers_first_registration_wins() {
        use pa_types::extension_rpc::ProviderRegistration;
        let mut a = extension("a.ts", Vec::new());
        a.providers = vec![ProviderRegistration {
            name: "custom".to_string(),
            config: json!({"baseUrl": "https://a.example"}),
        }];
        let mut b = extension("b.ts", Vec::new());
        b.providers = vec![ProviderRegistration {
            name: "custom".to_string(),
            config: json!({"baseUrl": "https://b.example"}),
        }];
        let registry = ExtensionRegistry::from_registrations(&[a, b]);
        assert_eq!(registry.providers().len(), 1);
        assert_eq!(
            registry.providers()[0].config["baseUrl"],
            json!("https://a.example")
        );
    }
}
