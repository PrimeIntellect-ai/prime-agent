//! The interactive first-load project-config trust prompt (CWE-426): a
//! repository's own Prime Agent config — `settings.json`, `SYSTEM.md`,
//! `APPEND_SYSTEM.md`, the discovered `skills`/`prompts`/`themes`
//! directories, and ancestor `.agents/skills` — stays entirely inert until
//! the user answers for the project. Headless modes never reach this
//! prompt; for them the gate stays deny-by-default in `pa-core`.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::Result;
use pa_core::settings::{escape_control, FileSettingsStorage, SettingsScope, SettingsStorage};

/// The prompt's settings line: every top-level key `settings.json` sets.
/// Keys only, never values: the file may link to content outside the
/// project.
fn settings_summary(content: &str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) if map.is_empty() => None,
        Ok(serde_json::Value::Object(map)) => {
            let keys = map
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("settings.json sets: {}", escape_control(&keys)))
        }
        _ => Some("settings.json does not parse as a JSON object".to_string()),
    }
}

/// Flush pending type-ahead so a stray pre-typed line cannot answer the
/// trust question.
fn flush_typeahead() {
    pa_core::platform::process::flush_stdin_typeahead();
}

/// Prompt for the project's config trust on the first load, before any
/// settings read for that project. Called for the launch cwd before the
/// CLI's earliest settings reads, and again for a resumed session's saved
/// cwd when it differs. Without `ask` or a terminal it prints the
/// ignored-config notice to stderr instead (stdout carries the protocols).
pub(crate) fn prompt_first_load(cwd: &Path, agent_dir: &Path, ask: bool) -> Result<()> {
    let entries = pa_core::settings::gated_project_entries(cwd, agent_dir);
    if entries.is_empty() {
        return Ok(());
    }
    let settings_path = cwd
        .join(pa_core::settings::CONFIG_DIR_NAME)
        .join("settings.json");
    let registry_path = agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE);
    let fingerprint = pa_core::settings::project_fingerprint(&settings_path).ok();
    if fingerprint.as_deref().is_some_and(|fingerprint| {
        pa_core::settings::project_trusted(&registry_path, &settings_path, fingerprint)
    }) {
        return Ok(());
    }
    match fingerprint {
        Some(fingerprint) if ask && std::io::stdin().is_terminal() => {
            confirm_and_trust(cwd, agent_dir, &entries, &fingerprint, false)
        }
        // A refused pinned file cannot be trusted here; `prime-agent trust`
        // names the file and the cause.
        _ => {
            eprintln!("{}", pa_core::settings::ignored_project_notice(cwd));
            Ok(())
        }
    }
}

/// `prime-agent trust [--yes] [<dir>]`: show the project's gated config and
/// record the user's trust; an already-trusted project stays unchanged.
pub(crate) fn run_trust_command(args: &[String]) -> i32 {
    let yes = args.iter().any(|arg| arg == "--yes");
    let dirs: Vec<&String> = args.iter().filter(|arg| *arg != "--yes").collect();
    if dirs.len() > 1 || dirs.iter().any(|arg| arg.starts_with("--")) {
        eprintln!("Usage: prime-agent trust [--yes] [<dir>]");
        return 1;
    }
    if !yes && !std::io::stdin().is_terminal() {
        eprintln!("prime-agent trust asks for confirmation: run it in a terminal, or pass --yes.");
        return 1;
    }
    let dir = match dirs.first() {
        Some(dir) => std::path::absolute(dir),
        None => std::env::current_dir(),
    };
    let result = dir.map_err(anyhow::Error::from).and_then(|dir| {
        if !dir.is_dir() {
            anyhow::bail!(
                "{} is not a directory",
                escape_control(&dir.display().to_string())
            );
        }
        let agent_dir = crate::config::get_agent_dir();
        let entries = pa_core::settings::gated_project_entries(&dir, &agent_dir);
        if entries.is_empty() {
            println!(
                "{} has no Prime Agent project config to trust.",
                escape_control(&dir.display().to_string())
            );
            return Ok(());
        }
        let settings_path = dir
            .join(pa_core::settings::CONFIG_DIR_NAME)
            .join("settings.json");
        let fingerprint = pa_core::settings::project_fingerprint(&settings_path)?;
        let registry_path = agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE);
        if pa_core::settings::project_trusted(&registry_path, &settings_path, &fingerprint) {
            println!(
                "{} is already trusted; nothing changed.",
                escape_control(&dir.display().to_string())
            );
            return Ok(());
        }
        confirm_and_trust(&dir, &agent_dir, &entries, &fingerprint, yes)
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Error: {error:#}");
            1
        }
    }
}

/// List the project's gated config, ask unless `yes`, and record the trust
/// pinned to `fingerprint`, the files as shown.
fn confirm_and_trust(
    cwd: &Path,
    agent_dir: &Path,
    entries: &[PathBuf],
    fingerprint: &str,
    yes: bool,
) -> Result<()> {
    let settings_path = cwd
        .join(pa_core::settings::CONFIG_DIR_NAME)
        .join("settings.json");
    let registry_path = agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE);
    println!("This repository carries its own Prime Agent config, which can change how Prime Agent behaves here:");
    for entry in entries {
        println!("  {}", escape_control(&entry.display().to_string()));
    }
    // Read through the project storage, like the pin (its link and size rules).
    let settings = FileSettingsStorage::new(cwd, agent_dir)
        .read(SettingsScope::Project)
        .ok()
        .flatten();
    if let Some(summary) = settings.as_deref().and_then(settings_summary) {
        println!("  {summary}");
    }
    let trusted = if yes {
        true
    } else {
        println!("They stay ignored until you trust them. Trust covers this repository's subdirectories and worktrees; a different settings.json, SYSTEM.md, or APPEND_SYSTEM.md asks again.");
        flush_typeahead();
        crate::daemon_discovery::stop::prompt_yes_no("Trust this repository's config?")
    };
    if !trusted {
        println!("Ignored. The repository's settings and discovered files stay inactive.");
        return Ok(());
    }
    let repository = pa_core::settings::trust_project(&registry_path, &settings_path, fingerprint)?;
    println!("Trusted. The repository's settings and discovered files now apply.");
    println!(
        "Recorded in {}; to revoke, delete the entry for {}.",
        escape_control(&registry_path.display().to_string()),
        escape_control(&repository.display().to_string())
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The summary lists every top-level key, never a value.
    #[test]
    fn the_summary_lists_every_top_level_key_and_no_values() {
        let content = r#"{"autonomous": true, "sessionDir": "/elsewhere", "telemetry": false}"#;
        assert_eq!(
            settings_summary(content).as_deref(),
            Some("settings.json sets: autonomous, sessionDir, telemetry")
        );
    }
}
