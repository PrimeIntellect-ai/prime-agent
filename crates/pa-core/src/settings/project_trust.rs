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

use super::storage::{atomic_write_with, AtomicWriteOptions, FileSettingsStorage};

/// The user-level registry file name, beside `settings.json` in the agent dir.
pub const TRUSTED_PROJECTS_FILE: &str = "trusted-projects.json";

/// The SHA-256 fingerprint of a project settings document, hex-encoded over
/// the file's exact bytes: any change (whitespace included) re-prompts.
#[must_use]
pub fn fingerprint(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest
        .iter()
        .fold(String::with_capacity(digest.len() * 2), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// The registry key for one project's settings file: the canonicalized
/// project directory (the settings file's grandparent's parent). Keying by
/// the project directory — never the file path — is the trust model's core
/// invariant: a second project that symlinks its settings file at a trusted
/// one shares the fingerprint but keeps its own key, so it still needs its
/// own trust decision. Fail-closed for lookups: an unresolvable key simply
/// never matches a differently-spelled entry.
fn registry_key(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(|project_dir| std::fs::canonicalize(project_dir).ok())
        .unwrap_or_else(|| settings_path.to_path_buf())
}

/// Read the registry's fingerprint entry for `settings_path`; `None` on any
/// missing, unreadable, or malformed registry (denied, never open).
fn registered_fingerprint(registry_path: &Path, settings_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(registry_path).ok()?;
    let registry: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&content).ok()?;
    registry
        .get(registry_key(settings_path).to_string_lossy().as_ref())?
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
        std::fs::read_to_string(registry_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
    registry.insert(
        registry_key(settings_path).to_string_lossy().into_owned(),
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
}
