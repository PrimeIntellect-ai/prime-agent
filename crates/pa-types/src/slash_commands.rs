//! The builtin slash-command vocabulary. Port of `core/slash-commands.ts`:
//! the command table every surface shares (the interactive TUI, the session
//! engine's command admission, and CLI suggestion help), plus the parse and
//! suggestion helpers over it.
//!
//! Pure data and pure functions only. This is the shared-vocabulary crate:
//! the TUI cannot import the session engine, and one table must serve both
//! sides, so the data lives here (the TS product keeps the same single
//! table in core and imports it from its TUI).

use std::collections::HashMap;

/// Session-executed commands (their behavior lives in the session engine).
pub const SESSION_SLASH_COMMAND_NAMES: [&str; 4] = ["compact", "refine", "goal", "autonomous"];

/// Durable row custom types (TS core/messages.ts): the command echo and its
/// result, as persisted in sessions and rendered by every surface.
pub const SESSION_SLASH_COMMAND_CUSTOM_TYPE: &str = "session_slash_command";
pub const SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE: &str = "session_slash_command_result";

/// True when `value` names a session-executed command.
pub fn is_session_slash_command_name(value: &str) -> bool {
    SESSION_SLASH_COMMAND_NAMES.contains(&value)
}

/// Where a command executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashCommandExecution {
    /// Client-side UI action (default).
    Client,
    /// Session-engine behavior.
    Session,
}

/// One builtin slash command. Descriptions and argument hints are
/// user-facing: keep them byte-identical to the TS table.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltinSlashCommand {
    pub name: &'static str,
    pub description: &'static str,
    pub execution: SlashCommandExecution,
    pub argument_hint: Option<&'static str>,
    pub aliases: &'static [&'static str],
    pub takes_argument: bool,
}

const CANONICAL_BUILTIN_SLASH_COMMANDS: &[BuiltinSlashCommand] = &[
    BuiltinSlashCommand { name: "settings", description: "Open settings menu", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "model", description: "Select model (opens selector UI; Tab filters by typed text)", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "effort", description: "Select reasoning/thinking level (opens selector UI)", execution: SlashCommandExecution::Client, argument_hint: Some("[level]"), aliases: &["thinking"], takes_argument: false },
    BuiltinSlashCommand { name: "fast", description: "Toggle OpenAI Fast mode", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "tier", description: "Show or set the service tier", execution: SlashCommandExecution::Client, argument_hint: Some("[default|flex|priority|auto]"), aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", execution: SlashCommandExecution::Client, argument_hint: Some("[path]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "import", description: "Import and resume a session from a JSONL file", execution: SlashCommandExecution::Client, argument_hint: Some("<path.jsonl>"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "share", description: "Share session as a secret GitHub gist", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "copy", description: "Copy last agent message to clipboard", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "btw", description: "Ask a side question without adding it to the session; replies follow up, esc returns", execution: SlashCommandExecution::Client, argument_hint: Some("<question>"), aliases: &["side"], takes_argument: true },
    BuiltinSlashCommand { name: "name", description: "Set or show the session display name", execution: SlashCommandExecution::Client, argument_hint: Some("[name]"), aliases: &["rename"], takes_argument: true },
    BuiltinSlashCommand { name: "session", description: "Show session info", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "system-prompt", description: "Show the exact system prompt sent to the model", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "logs", description: "Show where daemon and client logs are saved", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "traces", description: "Preview, upload, or configure Prime Agent traces", execution: SlashCommandExecution::Client, argument_hint: Some("[status|on|off|preview|upload|upload-current|upload-all|login]"), aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "context", description: "Show token, cost, and context usage for agent and sub-agents", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &["usage"], takes_argument: false },
    BuiltinSlashCommand { name: "changelog", description: "Show changelog entries", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "update", description: "Update Prime Agent and installed packages", execution: SlashCommandExecution::Client, argument_hint: Some("[source|--self|--extensions|--nightly|--stable]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "nightly", description: "Switch Prime Agent updates to the nightly channel (unreleased builds, may be broken)", execution: SlashCommandExecution::Client, argument_hint: Some("[on|off|status]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "hotkeys", description: "Show all keyboard shortcuts", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "fork", description: "Create a new fork from a previous user message", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "clone", description: "Duplicate the current session at the current position", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "tree", description: "Navigate session tree (switch branches)", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "login", description: "Configure provider authentication", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "logout", description: "Remove provider authentication", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "mcp", description: "Open the MCP connections menu (Tab filters by typed text)", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "plugins", description: "Browse and connect external services", execution: SlashCommandExecution::Client, argument_hint: Some("[search]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "new", description: "Start a new session, optionally named and/or with an initial prompt", execution: SlashCommandExecution::Client, argument_hint: Some("[--name \"session name\" --] [prompt]"), aliases: &["clear"], takes_argument: true },
    BuiltinSlashCommand { name: "compact", description: "Compact the session context; optional instructions focus the summary", execution: SlashCommandExecution::Session, argument_hint: Some("[instructions]"), aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory", execution: SlashCommandExecution::Session, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "goal", description: "Set or view a persistent goal; supports pause, resume, and clear", execution: SlashCommandExecution::Session, argument_hint: Some("[objective]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "autonomous", description: "Set or view autonomous mode with an optional budget", execution: SlashCommandExecution::Session, argument_hint: Some("[status|off|on [--max-continuations <n>] [--max-turns <n>] [--max-tokens <n>] [--timeout-ms <n>] [--gate <command>]]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "rlm-max-depth", description: "Set/view the per-chat persistent RLM max depth immediately; never interrupts or queues the running turn", execution: SlashCommandExecution::Client, argument_hint: Some("[<int> [--global]]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "heartbeat", description: "Set or view a persistent heartbeat; delivery defaults to steer, use --follow-up to queue; supports pause, resume, stop, and clear", execution: SlashCommandExecution::Client, argument_hint: Some("[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "heartbeats", description: "View and manage all user and agent heartbeats", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "resume", description: "Open the agents view, or resume a session by id or path", execution: SlashCommandExecution::Client, argument_hint: Some("[id|path]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
    BuiltinSlashCommand { name: "fullscreen", description: "Toggle fullscreen (alternate screen) rendering with scrollable transcript", execution: SlashCommandExecution::Client, argument_hint: Some("[on|off]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "speed", description: "Toggle footer readout of model output tok/sec (latest response and session average)", execution: SlashCommandExecution::Client, argument_hint: Some("[on|off]"), aliases: &[], takes_argument: true },
    BuiltinSlashCommand { name: "quit", description: "Quit Prime Agent", execution: SlashCommandExecution::Client, argument_hint: None, aliases: &[], takes_argument: false },
];

/// The registry with alias resolution maps prebuilt.
pub struct SlashCommandRegistry {
    commands: &'static [BuiltinSlashCommand],
    by_name: HashMap<&'static str, &'static BuiltinSlashCommand>,
    alias_to_name: HashMap<&'static str, &'static str>,
}

impl SlashCommandRegistry {
    pub fn builtin() -> Self {
        let mut by_name = HashMap::new();
        let mut alias_to_name = HashMap::new();
        for command in CANONICAL_BUILTIN_SLASH_COMMANDS {
            by_name.insert(command.name, command);
            for alias in command.aliases {
                alias_to_name.insert(*alias, command.name);
            }
        }
        Self {
            commands: CANONICAL_BUILTIN_SLASH_COMMANDS,
            by_name,
            alias_to_name,
        }
    }

    /// Shared immutable builtin registry for read-only hot paths such as TUI rendering.
    /// `builtin()` remains available to callers that expect an owned registry.
    pub fn builtin_cached() -> &'static Self {
        static REGISTRY: std::sync::OnceLock<SlashCommandRegistry> = std::sync::OnceLock::new();
        REGISTRY.get_or_init(Self::builtin)
    }

    pub fn all(&self) -> &'static [BuiltinSlashCommand] {
        self.commands
    }

    /// Resolve an alias to its canonical name.
    pub fn resolve_name(&self, name: &str) -> Option<&'static str> {
        self.alias_to_name
            .get(name)
            .copied()
            .or(match self.by_name.get(name) {
                Some(command) => Some(command.name),
                None => None,
            })
    }

    pub fn is_builtin(&self, name: &str) -> bool {
        self.by_name.contains_key(name) || self.alias_to_name.contains_key(name)
    }

    pub fn get(&self, name: &str) -> Option<&'static BuiltinSlashCommand> {
        self.resolve_name(name)
            .and_then(|name| self.by_name.get(name).copied())
    }

    /// Whether a builtin command consumes an argument (aliases included).
    /// `/clear` stays the no-argument compat alias even though `/new` takes one.
    pub fn takes_argument(&self, name: &str) -> bool {
        if name == "clear" {
            return false;
        }
        self.get(name).is_some_and(|command| command.takes_argument)
    }

    /// Parse and resolve a full input line.
    pub fn parse(&self, text: &str) -> Option<ResolvedSlashCommand> {
        let (name, args) = parse_slash_command(text)?;
        let resolved = self.resolve_name(&name)?;
        let is_alias = resolved != name;
        Some(ResolvedSlashCommand {
            name: resolved,
            original_name: name,
            is_alias,
            args,
        })
    }

    /// The suggestion candidates for a mistyped command: every canonical
    /// name and alias, in registry order (`findSlashCommandSuggestion` in
    /// core/slash-commands.ts searches this list).
    pub fn suggestion_candidates(&self) -> Vec<&'static str> {
        let mut candidates = Vec::new();
        for command in self.commands {
            candidates.push(command.name);
            candidates.extend(command.aliases.iter().copied());
        }
        candidates
    }
}

/// A parsed and resolved slash command.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSlashCommand {
    pub name: &'static str,
    /// The name as typed (an alias when `is_alias`).
    pub original_name: String,
    pub is_alias: bool,
    pub args: String,
}

/// Parse a `/name args` line. A leading `/` is required; the name is the
/// token up to the first whitespace separator, the rest (trimmed) is the
/// argument string.
pub fn parse_slash_command(text: &str) -> Option<(String, String)> {
    if !text.starts_with('/') {
        return None;
    }
    let rest = &text[1..];
    match rest.split_once(char::is_whitespace) {
        Some((name, args)) => Some((name.to_string(), args.trim().to_string())),
        None => Some((rest.to_string(), String::new())),
    }
}

/// Suggest the closest candidate command name, mirroring
/// `findSlashCommandSuggestion` in core/slash-commands.ts.
pub fn find_slash_command_suggestion<'a>(input: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let mut closest: Option<(&str, usize)> = None;
    for &candidate in candidates {
        let distance = slash_command_edit_distance(input, candidate);
        if closest.is_none() || distance < closest.unwrap().1 {
            closest = Some((candidate, distance));
        }
    }
    let threshold = if input.len() <= 3 {
        1
    } else {
        std::cmp::max(2, input.len() / 3)
    };
    match closest {
        Some((candidate, distance)) if distance <= threshold => Some(candidate),
        _ => None,
    }
}

/// Levenshtein edit distance (`slashCommandEditDistance`).
fn slash_command_edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for i in 1..=left.len() {
        current[0] = i;
        for j in 1..=right.len() {
            let substitution = previous[j - 1] + usize::from(left[i - 1] != right[j - 1]);
            current[j] = (previous[j] + 1).min(current[j - 1] + 1).min(substitution);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_aliases() {
        let registry = SlashCommandRegistry::builtin();
        assert_eq!(registry.resolve_name("clear"), Some("new"));
        assert_eq!(registry.resolve_name("thinking"), Some("effort"));
        assert_eq!(registry.resolve_name("usage"), Some("context"));
        assert_eq!(registry.resolve_name("rename"), Some("name"));
        assert_eq!(registry.resolve_name("side"), Some("btw"));
        assert!(registry.is_builtin("model"));
        assert!(!registry.is_builtin("nope"));
        // /clear remains the no-argument alias.
        assert!(!registry.takes_argument("clear"));
        assert!(registry.takes_argument("new"));
    }

    #[test]
    fn cached_registry_matches_owned_registry() {
        let owned = SlashCommandRegistry::builtin();
        let cached = SlashCommandRegistry::builtin_cached();
        assert!(std::ptr::eq(cached, SlashCommandRegistry::builtin_cached()));
        assert_eq!(cached.all(), owned.all());
        assert_eq!(
            cached.suggestion_candidates(),
            owned.suggestion_candidates()
        );
        for name in owned.suggestion_candidates().into_iter().chain(["unknown"]) {
            assert_eq!(cached.resolve_name(name), owned.resolve_name(name));
            assert_eq!(cached.get(name), owned.get(name));
            assert_eq!(cached.is_builtin(name), owned.is_builtin(name));
            assert_eq!(cached.takes_argument(name), owned.takes_argument(name));
            let input = format!("/{name} -- example");
            assert_eq!(cached.parse(&input), owned.parse(&input));
        }
    }

    #[test]
    fn parse_resolves_and_keeps_args() {
        let registry = SlashCommandRegistry::builtin();
        let resolved = registry.parse("/thinking high").unwrap();
        assert_eq!(resolved.name, "effort");
        assert!(resolved.is_alias);
        assert_eq!(resolved.original_name, "thinking");
        assert_eq!(resolved.args, "high");
        let plain = registry.parse("/model").unwrap();
        assert_eq!(plain.name, "model");
        assert_eq!(plain.args, "");
        assert!(registry.parse("not a command").is_none());
    }

    #[test]
    fn session_commands_execute_in_session() {
        let registry = SlashCommandRegistry::builtin();
        for name in SESSION_SLASH_COMMAND_NAMES {
            assert!(is_session_slash_command_name(name));
            assert_eq!(
                registry.get(name).unwrap().execution,
                SlashCommandExecution::Session
            );
        }
    }

    #[test]
    fn suggestion_matches_close_names_only() {
        let registry = SlashCommandRegistry::builtin();
        let candidates = registry.suggestion_candidates();
        assert_eq!(
            find_slash_command_suggestion("modle", &candidates),
            Some("model")
        );
        assert_eq!(
            find_slash_command_suggestion("comapct", &candidates),
            Some("compact")
        );
        assert_eq!(find_slash_command_suggestion("zzzzzz", &candidates), None);
    }

    #[test]
    fn edit_distance_counts_substitutions() {
        assert_eq!(slash_command_edit_distance("abc", "abc"), 0);
        assert_eq!(slash_command_edit_distance("ab", "ac"), 1);
        assert_eq!(slash_command_edit_distance("", "abc"), 3);
    }
}
