//! `prime-agent prompt`: dump the fully-assembled effective system prompt with
//! its per-layer breakdown, without starting a session or a provider.

use pa_core::resources::{load_resources, LoadedResources, ResourceLoaderOptions};
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
    match assemble_breakdown(&cwd, &get_agent_dir(), parsed.model.as_deref()) {
        Ok((breakdown, errors)) => {
            for error in &errors {
                eprintln!("Error: {error}");
            }
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

/// The resources a fresh root session in `cwd` loads: its settings,
/// auto-discovery, and the user's MCP gating (auth-gated built-in
/// integrations drop their skills), plus the enabled generic MCP servers the
/// prompt's MCP guidance names. `prompt` and `skills` share it.
pub(crate) fn load_session_resources(
    cwd: &std::path::Path,
    agent_dir: &std::path::Path,
) -> anyhow::Result<(SettingsManager, LoadedResources, Vec<String>)> {
    let settings = SettingsManager::create(cwd, agent_dir);
    let (skill_overrides, generic_servers, _manager) =
        pa_core::resources::mcp_gating(settings.global_settings(), agent_dir);
    let resources = load_resources(ResourceLoaderOptions {
        settings: Some(settings.reopen()),
        extra_builtin_skill_overrides: skill_overrides,
        system_prompt: None,
        ..ResourceLoaderOptions::new(cwd, agent_dir)
    })?;
    Ok((settings, resources, generic_servers))
}

/// The model a fresh daemon session runs on: `--model` resolved like the
/// CLI flag, else the daemon's startup chain (the saved default, then the
/// featured default, then the first available or catalog model).
fn session_model(
    selector: Option<&str>,
    settings: &SettingsManager,
    agent_dir: &std::path::Path,
) -> anyhow::Result<pa_types::ai::Model> {
    let registry = pa_core::models::ModelRegistry::create(
        pa_core::auth::AuthStorage::create(agent_dir),
        agent_dir.join("models.json"),
    );
    let all = registry.get_all();
    if let Some(selector) = selector {
        let resolved = pa_core::models::resolve_cli_model(None, selector, all);
        return resolved
            .model
            .ok_or_else(|| anyhow::anyhow!(resolved.error.unwrap_or_default()));
    }
    let available: Vec<pa_types::ai::Model> =
        registry.get_available().into_iter().cloned().collect();
    pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
        cli_provider: None,
        cli_model: None,
        scoped_models: &[],
        is_continuing: false,
        default_provider: settings.get_default_provider(),
        default_model_id: settings.get_default_model(),
        all_models: all,
        available_models: &available,
    })
    .or_else(|| all.first().cloned())
    .ok_or_else(|| anyhow::anyhow!("No models available."))
}

fn assemble_breakdown(
    cwd: &std::path::Path,
    agent_dir: &std::path::Path,
    model: Option<&str>,
) -> anyhow::Result<(pa_core::prompts::SystemPromptBreakdown, Vec<String>)> {
    let (settings, resources, generic_servers) = load_session_resources(cwd, agent_dir)?;
    let model = session_model(model, &settings, agent_dir)?;
    let model_prompts = pa_core::prompts::model_prompts::load_model_prompts(
        Some(&format!("{}/{}", model.provider, model.id)),
        agent_dir,
    );
    let breakdown = pa_core::prompts::system_prompt::system_prompt_breakdown(
        &pa_core::prompts::BuildSystemPromptOptions {
            settings: &settings,
            resources: &resources,
            // A daemon worker registers the host request of every
            // controller-backed skill, so all loaded skills stay visible.
            skills: &resources.skills,
            // The shipped model-tool surface: `python_repl` only; bash/edit are kernel-resident
            // programmatic tools.
            selected_tools: vec![pa_types::ai::PYTHON_TOOL_NAME],
            model_prompt_extras: model_prompts.extras.as_deref(),
            model_input: &model.input,
            cwd: cwd.display().to_string(),
            // A dump has no session file; the tail states the value it uses.
            messages_path: None,
            generic_mcp_servers: generic_servers,
            // A fresh daemon root session.
            rlm_depth: 0,
            factory_child: false,
            daemonless: false,
            can_spawn: true,
        },
    );
    Ok((breakdown, model_prompts.errors))
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

    /// A catalog model without image input.
    const TEXT_MODEL: &str = "prime-inference/z-ai/glm-5.3";

    #[test]
    fn assembles_the_layered_prompt_for_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = tempfile::tempdir().unwrap();
        let (breakdown, errors) =
            assemble_breakdown(dir.path(), agent_dir.path(), Some(TEXT_MODEL)).unwrap();
        assert!(errors.is_empty());
        assert!(breakdown.assembled.starts_with("# prime-agent harness"));
        assert!(breakdown
            .assembled
            .contains("Recursive agent depth: 0 (root)"));
        assert!(breakdown
            .assembled
            .contains("Conversation log: not persisted"));
        assert!(breakdown
            .assembled
            .contains("Image input: this model cannot see images"));
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

    #[test]
    fn the_dump_carries_the_discovered_appended_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join(pa_core::settings::CONFIG_DIR_NAME);
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("APPEND_SYSTEM.md"), "Project appendix.").unwrap();
        let agent_dir = tempfile::tempdir().unwrap();
        let (breakdown, _) =
            assemble_breakdown(dir.path(), agent_dir.path(), Some(TEXT_MODEL)).unwrap();
        assert!(breakdown.assembled.ends_with("Project appendix."));
    }

    #[test]
    fn an_unknown_model_fails_like_the_cli_flag() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = tempfile::tempdir().unwrap();
        let error =
            assemble_breakdown(dir.path(), agent_dir.path(), Some("no-such-model-anywhere"))
                .unwrap_err();
        assert!(error.to_string().contains("not found"), "{error}");
    }
}
