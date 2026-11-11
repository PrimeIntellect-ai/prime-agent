//! The interactive first-load project-config trust prompt (CWE-426): a
//! repository's own Prime Agent config — `settings.json`, `SYSTEM.md`,
//! `APPEND_SYSTEM.md`, the discovered `skills`/`prompts`/`themes`
//! directories, and ancestor `.agents/skills` — stays entirely inert until
//! the user answers for the project. Headless modes never reach this
//! prompt; for them the gate stays deny-by-default in `pa-core`.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::Result;

/// The project-side files and directories the trust decision gates.
const GATED_FILES: [&str; 3] = ["settings.json", "SYSTEM.md", "APPEND_SYSTEM.md"];
const GATED_DIRS: [&str; 3] = ["skills", "prompts", "themes"];

/// Escape control bytes (a directory name from an archive can carry
/// terminal control sequences).
fn escaped(text: &str) -> std::borrow::Cow<'_, str> {
    if text.chars().any(char::is_control) {
        text.chars()
            .map(|char| if char.is_control() { '?' } else { char })
            .collect::<String>()
            .into()
    } else {
        text.into()
    }
}

/// The existing gated project-config entries: the `.prime/agent` files and
/// directories plus ancestor `.agents/skills` directories.
fn existing_gated_entries(cwd: &Path) -> Vec<PathBuf> {
    let config_dir = cwd.join(pa_core::settings::CONFIG_DIR_NAME);
    let mut entries = GATED_FILES
        .iter()
        .map(|name| config_dir.join(name))
        .chain(GATED_DIRS.iter().map(|name| config_dir.join(name)))
        .filter(|path| path.exists())
        .collect::<Vec<PathBuf>>();
    let mut ancestor = cwd.to_path_buf();
    while ancestors_up(&mut ancestor) {
        let dir = ancestor.join(".agents").join("skills");
        if dir.is_dir() {
            entries.push(dir);
        }
    }
    entries
}

fn ancestors_up(dir: &mut PathBuf) -> bool {
    match dir.parent() {
        Some(parent) if parent != dir.as_path() => {
            *dir = parent.to_path_buf();
            true
        }
        _ => false,
    }
}

/// The settings entry summary the prompt shows: the keys that visibly
/// change the session, control bytes escaped.
fn settings_summary(settings_path: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(settings_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return vec!["(the settings file does not parse as JSON)".to_string()];
    };
    let mut rows = Vec::new();
    for (section, field) in [
        ("sessionDir", None),
        ("defaultProvider", None),
        ("defaultModel", None),
        ("agentTraces", Some("enabled")),
        ("telemetry", Some("enabled")),
    ] {
        let field_value = match field {
            Some(field) => value.get(section).and_then(|s| s.get(field)),
            None => value.get(section),
        };
        if let Some(field_value) = field_value {
            let label = field.map_or(section.to_string(), |field| format!("{section}.{field}"));
            rows.push(format!("{label} = {field_value}"));
        }
    }
    for array in ["skills", "prompts", "themes"] {
        if let Some(entries) = value.get(array).and_then(serde_json::Value::as_array) {
            rows.push(format!(
                "{array} = [{}]",
                entries
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect::<Vec<String>>()
                    .join(", ")
            ));
        }
    }
    rows.iter().map(|row| escaped(row).into_owned()).collect()
}

/// Flush pending type-ahead so a stray pre-typed line cannot answer the
/// trust question.
fn flush_typeahead() {
    pa_core::platform::process::flush_stdin_typeahead();
}

/// Prompt for the project's config trust on the interactive first load,
/// before any settings read for that project. Called for the launch cwd
/// before the CLI's earliest settings reads, and again for a resumed
/// session's saved cwd when it differs.
pub(crate) fn prompt_first_load(cwd: &Path, agent_dir: &Path) -> Result<()> {
    if !std::io::stdin().is_terminal() {
        return Ok(());
    }
    // The config home itself is the user's own global config, not project
    // content: never self-gate (every global write would re-prompt).
    if cwd.join(pa_core::settings::CONFIG_DIR_NAME) == agent_dir {
        return Ok(());
    }
    let entries = existing_gated_entries(cwd);
    if entries.is_empty() {
        return Ok(());
    }
    let settings_path = cwd
        .join(pa_core::settings::CONFIG_DIR_NAME)
        .join("settings.json");
    let registry_path = agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE);
    let Some(fingerprint) = pa_core::settings::project_fingerprint(&settings_path) else {
        println!(
            "This project's settings file ({}), is a symlink, so it cannot be trusted. Make it a real file first.",
            escaped(&settings_path.display().to_string())
        );
        return Ok(());
    };
    if pa_core::settings::project_trusted(&registry_path, &settings_path, &fingerprint) {
        return Ok(());
    }
    println!("This project carries its own Prime Agent config, which can change how Prime Agent behaves here:");
    for entry in &entries {
        println!("  {}", escaped(&entry.display().to_string()));
    }
    for row in settings_summary(&settings_path) {
        println!("  {row}");
    }
    println!("They stay ignored until you trust them (any settings change asks again).");
    flush_typeahead();
    if crate::daemon_discovery::stop::prompt_yes_no("Trust this project's config?") {
        pa_core::settings::trust_project(&registry_path, &settings_path, &fingerprint)?;
        println!("Trusted. The project's settings and discovered files now apply.");
    } else {
        println!("Ignored. The project's settings and discovered files stay inactive.");
    }
    println!(
        "Trust is recorded in {} and can be revoked by deleting the project's entry.",
        escaped(&registry_path.display().to_string())
    );
    Ok(())
}
