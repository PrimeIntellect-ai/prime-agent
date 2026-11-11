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
/// directories plus the `.agents/skills` directories auto-discovery loads —
/// through the one shared walk (`gated_agents_skill_dirs`), so the listing
/// cannot drift from what the discovery actually loads; the user's global
/// `~/.agents/skills` stays excluded (it is trusted user config).
fn existing_gated_entries(cwd: &Path) -> Vec<PathBuf> {
    let config_dir = cwd.join(pa_core::settings::CONFIG_DIR_NAME);
    let mut entries = GATED_FILES
        .iter()
        .map(|name| config_dir.join(name))
        .chain(GATED_DIRS.iter().map(|name| config_dir.join(name)))
        .filter(|path| path.exists())
        .collect::<Vec<PathBuf>>();
    for dir in pa_core::settings::gated_agents_skill_dirs(cwd) {
        if dir.is_dir() {
            entries.push(dir);
        }
    }
    entries
}

/// The settings keys the prompt lists: the ones that visibly change the
/// session. Keys only, never values: the file may link to content outside
/// the project.
fn settings_summary(settings_path: &Path) -> Vec<&'static str> {
    const KEYS: [&str; 8] = [
        "sessionDir",
        "defaultProvider",
        "defaultModel",
        "agentTraces.enabled",
        "telemetry.enabled",
        "skills",
        "prompts",
        "themes",
    ];
    let Ok(content) = std::fs::read_to_string(settings_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return vec!["(the settings file does not parse as JSON)"];
    };
    let present = |key: &str| match key.split_once('.') {
        Some((section, field)) => value.get(section).and_then(|s| s.get(field)).is_some(),
        None => value.get(key).is_some(),
    };
    // The loader migrates a legacy telemetry bool to `telemetry.enabled`
    // before applying it (untrusted or not); the summary lists the same key.
    let legacy_telemetry = value
        .get("telemetry")
        .is_some_and(serde_json::Value::is_boolean);
    KEYS.into_iter()
        .filter(|key| present(key) || (*key == "telemetry.enabled" && legacy_telemetry))
        .collect()
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
/// One prompt per project per process: the composition-root call and the
/// resume-cwd call both route through here, and a declined answer must not
/// re-ask in the same session.
static PROMPTED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::OnceLock::new();

fn already_prompted(cwd: &Path) -> bool {
    let registry = PROMPTED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    // `insert` returns true for a FIRST insert: already-prompted is the
    // complement (the entry was present before this call).
    !registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(cwd.to_path_buf())
}

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
            "This project's settings file ({}) is unreadable (permissions or not valid UTF-8), so it cannot be trusted. Make it readable text first.",
            escaped(&settings_path.display().to_string()),
        );
        return Ok(());
    };
    if pa_core::settings::project_trusted(&registry_path, &settings_path, &fingerprint) {
        return Ok(());
    }
    if already_prompted(cwd) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The summary lists keys, never values, and shows a legacy telemetry
    /// bool the way the loader applies it (migrated to `telemetry.enabled`),
    /// so the prompt never hides an opt-out that will take effect.
    #[test]
    fn the_summary_lists_keys_only_with_a_legacy_telemetry_bool_as_the_migrated_key() {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("settings.json");
        std::fs::write(
            &settings_path,
            r#"{"telemetry": false, "sessionDir": "/elsewhere"}"#,
        )
        .unwrap();
        assert_eq!(
            settings_summary(&settings_path),
            ["sessionDir", "telemetry.enabled"]
        );
    }
}
