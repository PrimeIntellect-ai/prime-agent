//! Layered system-prompt assembly: static layer files first (cacheable),
//! every session-specific value last. See the parent module docs.

use pa_types::ai::ModelInput;

use crate::resources::{ContextFile, LoadedResources};
use crate::settings::SettingsManager;
use crate::skills::{format_skills_for_prompt, Skill};

use super::layers;

/// The bundled skill the refinement trigger guidance keys on.
pub const REFINE_SKILL_NAME: &str = "refine";

/// Whether a prompt segment belongs to the cache-stable prefix or the
/// session-specific tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    /// Cacheable static prefix content (layer files, or a user replacement).
    Static,
    /// Session-specific tail content; must never leak into [`SegmentKind::Static`].
    Dynamic,
}

/// One named slice of the assembled prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSegment {
    /// Stable segment name (`core`, `usage`, `packages`, `environment`, ...).
    pub name: &'static str,
    pub kind: SegmentKind,
    /// Provenance: the layer file, or what generated the segment.
    pub source: &'static str,
    pub text: String,
}

impl PromptSegment {
    fn static_segment(name: &'static str, source: &'static str, text: String) -> Self {
        Self {
            name,
            kind: SegmentKind::Static,
            source,
            text,
        }
    }

    fn dynamic_segment(name: &'static str, source: &'static str, text: String) -> Self {
        Self {
            name,
            kind: SegmentKind::Dynamic,
            source,
            text,
        }
    }
}

/// The assembled prompt plus its per-layer breakdown. `cached_prefix_len` is
/// the byte length of the static prefix: `assembled[..cached_prefix_len]` is
/// byte-identical across every session that shares the same custom-prompt
/// and model-selection inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemPromptBreakdown {
    pub segments: Vec<PromptSegment>,
    pub assembled: String,
    pub cached_prefix_len: usize,
}

/// Inputs for one session's prompt. Only `resources.system_prompt` and
/// `model_prompt_extras` select the cached prefix; everything else,
/// settings included, feeds the dynamic tail. A conditional tail piece
/// reads its condition from these inputs where its text lives.
pub struct BuildSystemPromptOptions<'a> {
    pub settings: &'a SettingsManager,
    /// The replacement prompt, the appended prompt, and the AGENTS.md
    /// context files.
    pub resources: &'a LoadedResources,
    /// The model-visible skills.
    pub skills: &'a [Skill],
    /// Active tools. Tool schemas carry tool descriptions outside the prompt.
    pub selected_tools: Vec<&'a str>,
    pub model_prompt_extras: Option<&'a str>,
    /// The session model's input modalities.
    pub model_input: &'a [ModelInput],
    pub cwd: String,
    /// Conversation log path.
    pub messages_path: Option<String>,
    /// Enabled user-configured generic MCP servers.
    pub generic_mcp_servers: Vec<String>,
    pub rlm_depth: u32,
    /// Whether this child runs one factory state: the factory reads its
    /// final message, so the child does not reply to the parent.
    pub factory_child: bool,
    /// Whether the session runs without a daemon (no scheduler, no
    /// heartbeat firing). The wake-up facts the daemonless line states
    /// must match the embedding's wiring.
    pub daemonless: bool,
    /// Whether `rlm.spawn` can create children in this session (the
    /// daemonless print host or a daemon worker); a daemonless session
    /// without one cannot spawn at all.
    pub can_spawn: bool,
}

/// Build the system prompt (assembled text only).
#[must_use]
pub fn build_system_prompt(options: &BuildSystemPromptOptions) -> String {
    system_prompt_breakdown(options).assembled
}

/// Build the system prompt with its per-layer breakdown.
#[must_use]
pub fn system_prompt_breakdown(options: &BuildSystemPromptOptions) -> SystemPromptBreakdown {
    let mut segments: Vec<PromptSegment> = Vec::new();

    // The static prefix: the user's replacement prompt, or the layered files.
    match options.resources.system_prompt.as_deref() {
        Some(custom) if !custom.is_empty() => {
            segments.push(PromptSegment::static_segment(
                "custom",
                "--system-prompt",
                custom.to_string(),
            ));
        }
        _ => {
            segments.push(PromptSegment::static_segment(
                "core",
                layers::layer_source("core").unwrap_or_default(),
                layers::CORE_LAYER.trim().to_string(),
            ));
            segments.push(PromptSegment::static_segment(
                "usage",
                layers::layer_source("usage").unwrap_or_default(),
                layers::USAGE_LAYER.trim().to_string(),
            ));
            segments.push(PromptSegment::static_segment(
                "opinionated",
                layers::layer_source("opinionated").unwrap_or_default(),
                layers::OPINIONATED_LAYER.trim().to_string(),
            ));
            if let Some(extras) = options.model_prompt_extras {
                segments.push(PromptSegment::static_segment(
                    "model-prompts",
                    layers::layer_source("model-prompts").unwrap_or_default(),
                    extras.to_string(),
                ));
            }
        }
    }
    let cached_prefix_len = segments
        .iter()
        .map(|segment| segment.text.len())
        .sum::<usize>()
        + 2 * segments.len().saturating_sub(1);

    // The dynamic tail, in fixed order: packages -> project context ->
    // skills inventory -> MCP servers -> environment -> session role ->
    // additional guidance -> appended prompt.
    let tools = &options.selected_tools;
    let has_ipython = tools.contains(&pa_types::ai::PYTHON_TOOL_NAME);
    let has_file_access = has_ipython || tools.contains(&"bash");

    segments.push(PromptSegment::dynamic_segment(
        "packages",
        "kernel bootstrap defaults",
        packages_section(),
    ));

    let context = context_files_section(&options.resources.agents_files);
    if !context.is_empty() {
        segments.push(PromptSegment::dynamic_segment(
            "project-context",
            "AGENTS.md discovery",
            context,
        ));
    }

    let visible_skills: Vec<&Skill> = options
        .skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if has_file_access && !visible_skills.is_empty() {
        let inventory = format_skills_for_prompt(options.skills).trim().to_string();
        segments.push(PromptSegment::dynamic_segment(
            "skills-inventory",
            "skill discovery",
            inventory,
        ));
    }

    if has_ipython {
        let mcp = format_generic_mcp_guidance(&options.generic_mcp_servers);
        if !mcp.is_empty() {
            segments.push(PromptSegment::dynamic_segment(
                "mcp-servers",
                "generic MCP settings",
                mcp,
            ));
        }
    }

    segments.push(PromptSegment::dynamic_segment(
        "environment",
        "session configuration",
        environment_section(options),
    ));

    let role = session_role_section(options, has_ipython);
    if !role.is_empty() {
        segments.push(PromptSegment::dynamic_segment(
            "session-role",
            "RLM recursion state",
            role,
        ));
    }

    let appended = options.resources.append_system_prompt.join("\n\n");
    if !appended.is_empty() {
        segments.push(PromptSegment::dynamic_segment(
            "appended-prompt",
            "--append-system-prompt",
            appended,
        ));
    }

    let assembled = segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    SystemPromptBreakdown {
        segments,
        assembled,
        cached_prefix_len,
    }
}

fn packages_section() -> String {
    use crate::kernel::bootstrap::default_rlm_extra_import_labels;
    let mut lines = vec![format!(
        "Pre-installed Python packages: {}.",
        default_rlm_extra_import_labels().join(", ")
    )];
    lines.push(
        "Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module)."
            .to_string(),
    );
    lines.join("\n")
}

fn context_files_section(context_files: &[ContextFile]) -> String {
    if context_files.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "# Project Context".to_string(),
        String::new(),
        "Project-specific instructions and guidelines:".to_string(),
        String::new(),
    ];
    for file in context_files {
        lines.push(format!("## {}\n\n{}", file.path.display(), file.content));
    }
    lines.join("\n")
}

fn environment_section(options: &BuildSystemPromptOptions) -> String {
    let cwd = options.cwd.replace('\\', "/");
    let messages_path = options
        .messages_path
        .clone()
        .unwrap_or_else(|| "not persisted".to_string())
        .replace('\\', "/");
    let mut lines = vec![
        format!("Current date: {}", today()),
        format!("Working directory: {cwd}"),
        format!("Conversation log: {messages_path}"),
    ];
    lines.push(if options.model_input.contains(&ModelInput::Image) {
        "Image input: this model can see images; `attach_image` loads them into context."
            .to_string()
    } else {
        "Image input: this model cannot see images; `attach_image` errors for it.".to_string()
    });
    lines.join("\n")
}

fn session_role_section(options: &BuildSystemPromptOptions, has_ipython: bool) -> String {
    let depth = options.rlm_depth;
    let mut lines = vec![format!(
        "Recursive agent depth: {depth}{}",
        if depth == 0 { " (root)" } else { " (not root)" }
    )];
    if options.daemonless {
        lines.push(if options.can_spawn {
            "This session has no daemon: heartbeats never fire, and background `bash()` completions wake you with a queued `[bash-done]` turn; the run waits for live background commands and your subagents before it exits. Subagent replies and exit notices still wake you."
                .to_string()
        } else {
            "This session has no daemon: `rlm.spawn` is unavailable, heartbeats never fire, and background `bash()` completions wake you with a queued `[bash-done]` turn."
                .to_string()
        });
    }
    if has_ipython {
        let agent_inbox = !options.daemonless && options.settings.get_agent_inbox_enabled();
        if agent_inbox {
            lines.push(
                "This session has an agent inbox: bash completions, agent messages, child exits, heartbeats, and factory milestones wait in it, and a short `[inbox …]` notice announces new ones. When the notice says messages are waiting, read them with `msgs = await rlm.inbox.read()`. Your own `bash-done` messages need no reply; when nothing else needs action, end the turn silently."
                    .to_string(),
            );
        }
        lines.push(format!(
            "`await bash(cmd)` waits at most 1 second. If the command is still running, it returns a snapshot: `r.running` is True, `r.exit_code` is None, `r.output` is the output so far, and `r.handle` is the live handle. A completed result has `r.running` False and an integer `r.exit_code`. The command keeps running after a snapshot; end the turn and collect the final result {}.",
            if agent_inbox {
                "when its `[inbox …]` notice arrives"
            } else {
                "on the `[bash-done]` notification"
            }
        ));
        lines.push(
            "Do not run long blocking work in a cell; start long Python work as an asyncio task and check on it in later cells."
                .to_string(),
        );
    } else {
        lines.push(
            "This session has no Python REPL (`python_repl` tool): the programmatic tools described above are unavailable here."
                .to_string(),
        );
    }
    if depth > 0 {
        lines.push(
            "You are a child agent spawned by your parent agent. Task prompts are labeled `[task from parent]`."
                .to_string(),
        );
        if options.factory_child {
            lines.push(
                "Your final message is this state's output, which the factory reads; do not message the parent.".to_string(),
            );
        } else if has_ipython {
            lines.push(
                "When a task calls for an answer, reply explicitly with `await agent_message.send(message, receiver_role=\"parent\")`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.".to_string(),
            );
        }
        if has_ipython {
            lines.push(
                "For long-running work, report brief progress with `await rlm.progress_note('...')` (at most 512 characters, throttled to about one note per 10 seconds); the parent sees notes without needing a reply.".to_string(),
            );
        }
    }
    lines.join("\n")
}

fn today() -> String {
    // UTC date in YYYY-MM-DD form; the prompt is date context only.
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() / 86_400);
    // Civil-from-days algorithm (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn format_generic_mcp_guidance(servers: &[String]) -> String {
    let mut enabled: Vec<&String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for server in servers {
        if seen.insert(server) {
            enabled.push(server);
        }
    }
    enabled.sort();
    if enabled.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "# Generic MCP Connections".to_string(),
        String::new(),
        "Generic MCP connections are accessed through the pre-imported Python `mcp` object in the Python REPL, not as top-level native tool namespaces or installed Python skills.".to_string(),
        format!(
            "Enabled generic MCP servers: {}.",
            enabled
                .iter()
                .map(|server| format!("`{server}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ];
    for server in &enabled {
        lines.push(format!(
            "For `{server}`, first discover its tools with `await mcp.list_tools(\"{server}\")`, then call one with `await mcp.call_tool(\"{server}\", \"<tool>\", arguments)`."
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{create_synthetic_source_info, SkillKind, SourceScope};
    use std::path::PathBuf;

    fn skill(name: &str, import: Option<&str>) -> Skill {
        Skill {
            name: name.to_string(),
            description: format!("Skill {name}"),
            file_path: PathBuf::from("/skills/SKILL.md"),
            base_dir: PathBuf::from("/skills"),
            source_info: create_synthetic_source_info("/skills", "user", SourceScope::User, None),
            disable_model_invocation: false,
            kind: if import.is_some() {
                SkillKind::Python
            } else {
                SkillKind::Markdown
            },
            python: import.map(|import_name| crate::skills::SkillPythonMetadata {
                import_name: import_name.to_string(),
                package_path: PathBuf::from("/skills"),
                pyproject_path: PathBuf::from("/skills/pyproject.toml"),
            }),
        }
    }

    /// Owns what the options borrow.
    struct Fixture {
        settings: SettingsManager,
        resources: LoadedResources,
        skills: Vec<Skill>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                settings: SettingsManager::in_memory(&crate::settings::Settings::default()),
                resources: LoadedResources::default(),
                skills: vec![
                    skill("web-search", Some("websearch")),
                    skill("refine", Some("refine")),
                    skill("agent-message", Some("agent_message")),
                ],
            }
        }

        fn options(&self) -> BuildSystemPromptOptions<'_> {
            BuildSystemPromptOptions {
                settings: &self.settings,
                resources: &self.resources,
                skills: &self.skills,
                selected_tools: vec![pa_types::ai::PYTHON_TOOL_NAME],
                model_prompt_extras: None,
                model_input: &[],
                cwd: "/w".to_string(),
                messages_path: Some("/log.jsonl".to_string()),
                generic_mcp_servers: Vec::new(),
                rlm_depth: 0,
                factory_child: false,
                daemonless: false,
                can_spawn: false,
            }
        }
    }

    fn agents_file(content: &str) -> ContextFile {
        ContextFile {
            path: PathBuf::from("AGENTS.md"),
            content: content.to_string(),
        }
    }

    #[test]
    fn default_prompt_is_layered_with_static_prefix_first() {
        let breakdown = system_prompt_breakdown(&Fixture::new().options());
        let prompt = &breakdown.assembled;
        assert!(prompt.starts_with("# prime-agent harness"));
        assert_eq!(breakdown.segments[0].kind, SegmentKind::Static);
        assert_eq!(breakdown.segments[0].name, "core");
        let names: Vec<&str> = breakdown
            .segments
            .iter()
            .map(|segment| segment.name)
            .collect();
        assert_eq!(
            names[..4],
            ["core", "usage", "opinionated", "packages"],
            "core/usage/opinionated layers, then the dynamic tail"
        );
        assert_eq!(
            &prompt[..breakdown.cached_prefix_len],
            format!(
                "{}\n\n{}\n\n{}",
                layers::CORE_LAYER.trim(),
                layers::USAGE_LAYER.trim(),
                layers::OPINIONATED_LAYER.trim()
            )
        );
        let tail = &prompt[breakdown.cached_prefix_len..];
        assert!(tail.contains("Working directory: /w"));
        assert!(tail.contains("Conversation log: /log.jsonl"));
        assert!(tail.contains("<available_skills>"));
        assert!(tail.contains("Recursive agent depth: 0 (root)"));
        assert!(tail.contains("Pre-installed Python packages: requests, httpx,"));
    }

    #[test]
    fn dynamic_tail_isolates_the_cached_prefix() {
        let base = Fixture::new();
        let mut with_context = Fixture::new();
        with_context.resources.agents_files = vec![agents_file("Rule one.")];
        let mut other = with_context.options();
        other.cwd = "/somewhere/else".to_string();
        other.messages_path = None;
        other.rlm_depth = 2;
        other.generic_mcp_servers = vec!["slack".to_string()];
        let left = system_prompt_breakdown(&base.options());
        let right = system_prompt_breakdown(&other);
        assert_eq!(
            left.assembled[..left.cached_prefix_len],
            right.assembled[..right.cached_prefix_len]
        );
        assert_eq!(left.cached_prefix_len, right.cached_prefix_len);
        assert!(right.assembled[right.cached_prefix_len..]
            .contains("Enabled generic MCP servers: `slack`"));
        assert!(right.assembled[right.cached_prefix_len..]
            .contains("You are a child agent spawned by your parent agent."));
    }

    #[test]
    fn factory_child_gets_the_factory_line_instead_of_the_reply_line() {
        const REPLY: &str = "reply explicitly with `await agent_message.send(";
        const FACTORY: &str = "Your final message is this state's output";
        let fixture = Fixture::new();
        let mut child = fixture.options();
        child.rlm_depth = 1;
        let normal = build_system_prompt(&child);
        assert!(normal.contains(REPLY));
        assert!(!normal.contains(FACTORY));
        child.factory_child = true;
        let factory = build_system_prompt(&child);
        assert!(factory.contains(FACTORY));
        assert!(!factory.contains(REPLY));
    }

    #[test]
    fn custom_prompt_replaces_layers_keeps_tail() {
        let mut fixture = Fixture::new();
        fixture.resources.system_prompt = Some("Be terse.".to_string());
        fixture.resources.agents_files = vec![agents_file("Rule one.")];
        let mut options = fixture.options();
        options.model_prompt_extras = Some("Tier-2 guidance.");
        let breakdown = system_prompt_breakdown(&options);
        let prompt = &breakdown.assembled;
        assert!(prompt.starts_with("Be terse."));
        assert_eq!(breakdown.segments[0].name, "custom");
        assert!(prompt.contains("## AGENTS.md\n\nRule one."));
        assert!(prompt.contains("Working directory: /w"));
        assert!(prompt.contains("Current date: "));
        assert!(!prompt.contains("# prime-agent harness"));
        assert!(!prompt.contains("Tier-2 guidance."));
    }

    #[test]
    fn mcp_servers_are_a_tail_segment() {
        let fixture = Fixture::new();
        let mut options = fixture.options();
        options.generic_mcp_servers = vec!["t".to_string(), "t".to_string()];
        let breakdown = system_prompt_breakdown(&options);
        let names: Vec<&str> = breakdown
            .segments
            .iter()
            .map(|segment| segment.name)
            .collect();
        assert!(names.contains(&"mcp-servers"));
        assert!(breakdown.assembled.contains("# Generic MCP Connections"));
        assert!(breakdown
            .assembled
            .contains("Enabled generic MCP servers: `t`."));
    }

    #[test]
    fn daemonless_line_drops_the_stale_no_wake_claim() {
        // The line's one durable contract: it no longer tells daemonless
        // agents that background completions never wake them.
        let fixture = Fixture::new();
        let mut spawning = fixture.options();
        spawning.daemonless = true;
        spawning.can_spawn = true;
        assert!(!build_system_prompt(&spawning).contains("completions do not wake you"));

        let mut bare = fixture.options();
        bare.daemonless = true;
        assert!(!build_system_prompt(&bare).contains("completions do not wake you"));
    }

    #[test]
    fn model_prompt_extras_form_the_last_static_segment() {
        let fixture = Fixture::new();
        let mut options = fixture.options();
        options.model_prompt_extras = Some("Tier-2 guidance.");
        let breakdown = system_prompt_breakdown(&options);
        let names: Vec<&str> = breakdown
            .segments
            .iter()
            .map(|segment| segment.name)
            .collect();
        assert_eq!(
            names[..5],
            ["core", "usage", "opinionated", "model-prompts", "packages"],
            "extras are the last static segment, directly before the dynamic tail"
        );
    }
}
