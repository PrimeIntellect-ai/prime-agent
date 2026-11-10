//! The interactive first-load project-settings trust prompt (CWE-426): an
//! untrusted repository settings document stays entirely inert until the user
//! answers for exactly its bytes. Headless modes never reach this prompt —
//! for them the gate stays deny-by-default in `pa-core`.

use std::io::IsTerminal;
use std::path::Path;

use anyhow::Result;

use super::{PathBuf, RunOptions};

/// Prompt for the project's settings trust on the interactive first load,
/// before any settings read: a project `.prime/agent/settings.json` whose
/// fingerprint the user registry does not pin asks once, and only on a
/// terminal; every other path (headless, declined, EOF) leaves the project
/// scope denied. A `yes` persists the fingerprint in the user registry.
pub(super) fn prompt_first_load(options: &RunOptions) -> Result<()> {
    let cwd = options.config.cwd.clone();
    let agent_dir = options.config.agent_dir.clone();
    if !std::io::stdin().is_terminal() {
        return Ok(());
    }
    let settings_path = project_settings_path(&cwd);
    let Some(content) = std::fs::read_to_string(&settings_path).ok() else {
        return Ok(());
    };
    let registry_path = agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE);
    let fingerprint = pa_core::settings::fingerprint(&content);
    if pa_core::settings::project_trusted(&registry_path, &settings_path, &fingerprint) {
        return Ok(());
    }
    println!(
        "This project carries its own Prime Agent settings ({}), which can change how Prime Agent behaves here.",
        settings_path.display()
    );
    println!("They stay ignored until you trust them.");
    if crate::daemon_discovery::stop::prompt_yes_no("Trust this project's settings?") {
        pa_core::settings::trust_project(&registry_path, &settings_path, &fingerprint)?;
        println!("Trusted. The project's settings now apply (this answer re-prompts if the file changes).");
    } else {
        println!("Ignored. The project's settings stay inactive.");
    }
    Ok(())
}

/// `<cwd>/.prime/agent/settings.json`, the document the gate fingerprints.
fn project_settings_path(cwd: &Path) -> PathBuf {
    cwd.join(pa_core::settings::CONFIG_DIR_NAME)
        .join("settings.json")
}
