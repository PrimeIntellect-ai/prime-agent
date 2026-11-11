//! Project-settings trust (the CWE-426 gate): a repository's
//! `<project>/.prime/agent/settings.json` loads ENTIRELY INERT until the
//! user has explicitly trusted it. Trust is per project, recorded in the
//! user-level registry (`<agent dir>/trusted-projects.json`), and keyed by
//! the settings file's fingerprint, so any change to the file re-prompts.
//! Headless and API paths never prompt: no registry entry means denied.

use std::path::{Path, PathBuf};

use anyhow::Result;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

use super::types::Settings;

use super::storage::{atomic_write_with, AtomicWriteOptions, FileSettingsStorage};

/// The user-level registry file name, beside `settings.json` in the agent dir.
pub const TRUSTED_PROJECTS_FILE: &str = "trusted-projects.json";

/// The SHA-256 fingerprint of a project settings document, hex-encoded over
/// the file's exact bytes: any change (whitespace included) re-prompts.
#[must_use]
pub fn fingerprint(content: &str) -> String {
    fingerprint_hex(content.as_bytes())
}

/// The same digest over raw bytes (registry keys encode OS paths losslessly).
fn fingerprint_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .fold(String::with_capacity(digest.len() * 2), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// The pinned fingerprint for a project's config surface: the settings
/// file's exact bytes when present (any change re-prompts), the empty
/// sentinel when absent (its later appearance re-prompts). `None` for an
/// unreadable settings file: it is refused outright.
#[must_use]
pub fn project_fingerprint(settings_path: &Path) -> Option<String> {
    Some(match std::fs::read_to_string(settings_path) {
        Ok(content) => fingerprint(&content),
        // The absence sentinel pins the not-yet-existing file: its later
        // appearance re-prompts. Any other read failure (permissions,
        // invalid UTF-8) refuses outright — an unreadable file must
        // never ride an absence pin.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return None,
    })
}

/// The restrictive-key projection of an untrusted project document: the
/// privacy opt-outs (`agentTraces.enabled=false`, `telemetry.enabled=false`,
/// `images.blockImages=true`) apply regardless of trust — declining trust
/// never increases sharing — while everything else stays inert.
#[must_use]
pub(crate) fn restrictive_projection(value: &serde_json::Value) -> Settings {
    let mut map = serde_json::Map::new();
    let mut carry = |section: &str, field: &str, when: bool| {
        let value = value
            .get(section)
            .and_then(|section| section.get(field))
            .and_then(serde_json::Value::as_bool);
        if value == Some(when) {
            map.insert(
                section.to_string(),
                serde_json::json!({ field.to_string(): when }),
            );
        }
    };
    carry("agentTraces", "enabled", false);
    carry("telemetry", "enabled", false);
    carry("images", "blockImages", true);
    super::load::from_value_lenient(&serde_json::Value::Object(map))
}

/// The registry key for one project's settings file: the hex SHA-256 of
/// the canonicalized project directory's OS bytes (the settings file's
/// grandparent's parent). Keying by the project directory — never the file
/// path — is the trust model's core invariant: a second project that
/// symlinks its settings file at a trusted one shares the fingerprint but
/// keeps its own key, so it still needs its own trust decision. The digest
/// encoding is lossless: a `to_string_lossy` key would collide distinct
/// non-UTF-8 paths. Fail-closed for lookups: an unresolvable key simply
/// never matches a differently-spelled entry.
fn registry_key(settings_path: &Path) -> String {
    let project_dir = settings_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent);
    let key = project_dir
        .and_then(|dir| std::fs::canonicalize(dir).ok())
        .unwrap_or_else(|| settings_path.to_path_buf());
    fingerprint_hex(key.as_os_str().as_encoded_bytes())
}

/// Read the registry's fingerprint entry for `settings_path`; `None` on any
/// missing, unreadable, or malformed registry (denied, never open).
fn registered_fingerprint(registry_path: &Path, settings_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(registry_path).ok()?;
    let registry: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&content).ok()?;
    registry
        .get(&registry_key(settings_path))?
        .as_str()
        .map(str::to_string)
}

/// The trust decision for one project's settings file: registry lookup plus
/// fingerprint match. Deny-by-default: any read or parse failure denies.
#[must_use]
pub fn project_trusted(registry_path: &Path, settings_path: &Path, fingerprint: &str) -> bool {
    registered_fingerprint(registry_path, settings_path).as_deref() == Some(fingerprint)
}

/// Record the user's trust for one project's settings file, fingerprint-pinned.
///
/// # Errors
///
/// Returns an error when the registry cannot be read or written.
pub fn trust_project(registry_path: &Path, settings_path: &Path, fingerprint: &str) -> Result<()> {
    // The locks precede the read: two concurrent trusts must never erase
    // each other's entries through a stale read.
    let _process_guard = super::storage::process_lock(registry_path);
    // `acquire_lock` creates the `{file}.lock` directory without parents:
    // the registry's parent (the agent dir) must exist first.
    if let Some(parent) = registry_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let guard = FileSettingsStorage::acquire_lock(registry_path)?;
    let mut registry: serde_json::Map<String, serde_json::Value> =
        match std::fs::read_to_string(registry_path) {
            Ok(content) if !content.trim().is_empty() => {
                serde_json::from_str(&content).map_err(|error| {
                    anyhow::anyhow!(
                        "the trusted-projects registry is malformed; not overwritten: {error}"
                    )
                })?
            }
            _ => serde_json::Map::new(),
        };
    registry.insert(
        registry_key(settings_path),
        serde_json::Value::String(fingerprint.to_string()),
    );
    atomic_write_with(
        registry_path,
        &serde_json::to_string_pretty(&registry)?,
        AtomicWriteOptions { fsync: true },
    )?;
    drop(guard);
    Ok(())
}

#[cfg(test)]
mod tests;

/// The `.agents/skills` directories the auto-discovery would load for this
/// cwd (its own first, up to and including the git repo root), with the
/// user's global directory excluded: the loader and the trust prompt share
/// this one source of truth so the gated paths the prompt lists can never
/// drift from what the discovery actually loads.
#[must_use]
pub fn gated_agents_skill_dirs(cwd: &Path) -> Vec<PathBuf> {
    let user_agents_skills =
        pa_types::platform::home_dir().map(|home| home.join(".agents").join("skills"));
    crate::packages::resolve::discovery::collect_ancestor_agents_skill_dirs(cwd)
        .into_iter()
        .filter(|dir| user_agents_skills.as_deref() != Some(dir.as_path()))
        .collect()
}

/// The gate a [`super::SettingsManager`] holds for its project scope: the
/// user registry plus the project settings file it fingerprints.
#[derive(Debug, Clone)]
pub(crate) struct ProjectTrustGate {
    registry_path: PathBuf,
    settings_path: PathBuf,
}

impl ProjectTrustGate {
    pub(crate) fn new(cwd: &Path, agent_dir: &Path) -> Self {
        ProjectTrustGate {
            registry_path: agent_dir.join(TRUSTED_PROJECTS_FILE),
            settings_path: cwd
                .join(super::storage::CONFIG_DIR_NAME)
                .join("settings.json"),
        }
    }

    /// Whether the settings-file fingerprint the loader observed is trusted.
    #[must_use]
    pub(crate) fn admits(&self, fingerprint: &str) -> bool {
        project_trusted(&self.registry_path, &self.settings_path, fingerprint)
    }

    /// Record trust for a fingerprint through this gate's registry entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the registry cannot be read or written.
    pub(crate) fn trust(&self, fingerprint: &str) -> Result<()> {
        trust_project(&self.registry_path, &self.settings_path, fingerprint)
    }

    /// The whole-project decision: this project directory's registry entry
    /// pinned to the settings fingerprint (the empty sentinel while the
    /// file is absent), so one trust covers every gated project file.
    #[must_use]
    pub(crate) fn admits_project(&self) -> bool {
        project_fingerprint(&self.settings_path).is_some_and(|fingerprint| {
            project_trusted(&self.registry_path, &self.settings_path, &fingerprint)
        })
    }
}
