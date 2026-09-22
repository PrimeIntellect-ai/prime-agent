//! `prime-agent prompt`: dump the fully-assembled effective system prompt
//! with its per-layer breakdown. Assembles the prompt exactly the way a
//! fresh root session would (same resource loading, MCP gating, and tool
//! surface), without starting a session or a provider.

use pa_core::resources::{load_resources, ResourceLoaderOptions};
use pa_core::settings::SettingsManager;

use crate::config::get_agent_dir;

/// The command's parsed arguments.
#[derive(Debug, Default, PartialEq, Eq)]
struct PromptCommandArgs {
    model: Option<String>,
    cwd: Option<String>,
    json: bool,
}

fn parse_args(args: &[String]) -> Result<PromptCommandArgs, String> {
    let mut parsed = PromptCommandArgs::default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => parsed.json = true,
            "--model" => {
                let Some(value) = rest.next() else {
                    return Err("--model requires a value".to_string());
                };
                parsed.model = Some(value.clone());
            }
            "--cwd" => {
                let Some(value) = rest.next() else {
                    return Err("--cwd requires a value".to_string());
                };
                parsed.cwd = Some(value.clone());
            }
            "--help" | "-h" => {
                return Err(String::new());
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(parsed)
}

/// Run the `prompt` command; returns the process exit code.
pub fn run_prompt_command(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(help_request) if help_request.is_empty() => return 0,
        Err(error) => {
            eprintln!("Error: {error}");
            eprintln!("Run `prime-agent help prompt` for usage.");
            return 1;
        }
    };
    let cwd = parsed
        .cwd
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    match assemble_breakdown(&cwd, parsed.model.as_deref()) {
        Ok(breakdown) => {
            if parsed.json {
                print_json(&breakdown);
            } else {
                print_text(&breakdown);
            }
            0
        }
        Err(error) => {
            eprintln!("Error: {error:#}");
            1
        }
    }
}

fn assemble_breakdown(
    cwd: &std::path::Path,
    model: Option<&str>,
) -> anyhow::Result<pa_core::prompts::SystemPromptBreakdown> {
    let agent_dir = get_agent_dir();
    let settings = SettingsManager::create(cwd, &agent_dir);
    // MCP gating: auth-gated built-in integrations drop their skills;
    // enabled persistent generic servers add the prompt MCP guidance.
    let user_servers = settings
        .settings()
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(server, config)| {
            serde_json::from_value(config)
                .ok()
                .map(|parsed| (server, parsed))
        })
        .collect::<std::collections::HashMap<String, pa_core::mcp::McpServerConfig>>();
    let (skill_overrides, generic_servers, _manager) =
        pa_core::mcp::McpManager::prompt_gating(user_servers, &agent_dir);
    let resources = load_resources(ResourceLoaderOptions {
        extra_builtin_skill_overrides: skill_overrides,
        system_prompt: None,
        ..ResourceLoaderOptions::new(cwd.to_path_buf(), agent_dir)
    })?;
    Ok(pa_core::prompts::system_prompt::system_prompt_breakdown(
        &pa_core::prompts::BuildSystemPromptOptions {
            cwd: cwd.display().to_string(),
            // A dump has no session file; the tail states the value it uses.
            messages_path: None,
            model,
            custom_prompt: resources.system_prompt.clone(),
            context_files: resources
                .agents_files
                .iter()
                .map(|file| (file.path.display().to_string(), file.content.clone()))
                .collect(),
            skills: resources.skills.clone(),
            // The shipped model-tool surface: `ipython` only; bash/edit
            // are kernel-resident programmatic tools.
            selected_tools: Some(vec!["ipython"]),
            allow_recursion: Some(true),
            generic_mcp_servers: generic_servers,
            rlm_depth: Some(0),
            ..Default::default()
        },
    ))
}

fn print_text(breakdown: &pa_core::prompts::SystemPromptBreakdown) {
    println!("# prime-agent system prompt breakdown");
    println!();
    println!("cached prefix (static layers, byte-stable across sessions):");
    for segment in &breakdown.segments {
        if segment.kind == pa_core::prompts::SegmentKind::Static {
            print_segment(segment);
        }
    }
    println!("dynamic tail (session-specific, appended after the cached prefix):");
    for segment in &breakdown.segments {
        if segment.kind == pa_core::prompts::SegmentKind::Dynamic {
            print_segment(segment);
        }
    }
    println!();
    println!(
        "cached prefix: {} of {} total chars; dynamic tail follows",
        breakdown.cached_prefix_len,
        breakdown.assembled.len()
    );
    println!();
    println!("{}", breakdown.assembled);
}

fn print_segment(segment: &pa_core::prompts::PromptSegment) {
    println!(
        "  {:<20} {:<38} {:>7} chars",
        segment.name,
        segment.source,
        segment.text.chars().count()
    );
}

fn print_json(breakdown: &pa_core::prompts::SystemPromptBreakdown) {
    let segments = breakdown
        .segments
        .iter()
        .map(|segment| {
            serde_json::json!({
                "name": segment.name,
                "kind": if segment.kind == pa_core::prompts::SegmentKind::Static { "static" } else { "dynamic" },
                "source": segment.source,
                "chars": segment.text.chars().count(),
            })
        })
        .collect::<Vec<_>>();
    println!(
        "{}",
        serde_json::json!({
            "segments": segments,
            "cachedPrefixLen": breakdown.cached_prefix_len,
            "prompt": breakdown.assembled,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags() {
        let parsed = parse_args(&[
            "--model".to_string(),
            "mock/mock-1".to_string(),
            "--json".to_string(),
            "--cwd".to_string(),
            "/w".to_string(),
        ])
        .unwrap();
        assert_eq!(parsed.model.as_deref(), Some("mock/mock-1"));
        assert_eq!(parsed.cwd.as_deref(), Some("/w"));
        assert!(parsed.json);
        assert_eq!(
            parse_args(&["--bogus".to_string()]),
            Err("unknown option \"--bogus\"".to_string())
        );
        assert_eq!(
            parse_args(&["--model".to_string()]),
            Err("--model requires a value".to_string())
        );
    }

    #[test]
    fn help_request_prints_usage() {
        assert_eq!(run_prompt_command(&["--help".to_string()]), 0);
    }

    #[test]
    fn assembles_the_layered_prompt_for_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let breakdown = assemble_breakdown(dir.path(), Some("mock/mock-1")).unwrap();
        assert!(breakdown.assembled.starts_with("# prime-agent harness"));
        assert!(breakdown
            .assembled
            .contains("Recursive agent depth: 0 (root)"));
        assert!(breakdown
            .assembled
            .contains("Conversation log: not persisted"));
        // Every static segment sits inside the cached prefix.
        for segment in &breakdown.segments {
            let inside = breakdown
                .assembled
                .find(&segment.text)
                .is_some_and(|at| at < breakdown.cached_prefix_len);
            assert_eq!(
                inside,
                segment.kind == pa_core::prompts::SegmentKind::Static,
                "segment {} on the wrong side of the cache boundary",
                segment.name
            );
        }
    }
}
