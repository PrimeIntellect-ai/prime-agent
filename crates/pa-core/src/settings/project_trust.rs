//! Project-settings trust (the CWE-426 gate): a repository's
//! `<project>/.prime/agent/settings.json` loads ENTIRELY INERT until the
//! user has explicitly trusted it. Trust is per project, recorded in the
//! user-level registry (`<agent dir>/trusted-projects.json`), and pinned to
//! one fingerprint over `settings.json`, `SYSTEM.md`, and `APPEND_SYSTEM.md`,
//! so any change to those files re-prompts.
//! Headless and API paths never prompt: no registry entry means denied.

use std::path::{Path, PathBuf};

use anyhow::Result;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

use super::types::Settings;

use super::storage::{atomic_write_with, AtomicWriteOptions, FileSettingsStorage, SettingsStorage};

/// The user-level registry file name, beside `settings.json` in the agent dir.
pub const TRUSTED_PROJECTS_FILE: &str = "trusted-projects.json";

/// Hex-encode a SHA-256 digest.
fn hex(digest: &[u8]) -> String {
    digest
        .iter()
        .fold(String::with_capacity(digest.len() * 2), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// The project root a settings file belongs to (`<project>/.prime/agent/`s
/// parent's parent).
fn project_root(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map_or_else(|| settings_path.to_path_buf(), Path::to_path_buf)
}

/// The trust pin: one SHA-256 over the project's `settings.json`,
/// `SYSTEM.md`, and `APPEND_SYSTEM.md`, each framed as name, presence,
/// length, bytes, so any change to any of them (a file appearing or
/// disappearing included) re-prompts. `settings` is the settings document
/// as the caller read it (`None` when absent); the prompt files are read
/// beside `settings_path`. `None` when a prompt file exists but cannot be
/// read (permissions, invalid UTF-8): an unreadable file never rides a pin.
fn pin(settings_path: &Path, settings: Option<&str>) -> Option<String> {
    let (system, append) = prompt_files(settings_path)?;
    Some(pin_over(settings, system.as_deref(), append.as_deref()))
}

/// The pinned prompt files beside `settings_path`, ONE read of each through
/// the project storage (its link, size, and regular-file rules), so a
/// checkout cannot hang or exhaust the process before any trust decision.
/// `None` when either is refused or unreadable.
fn prompt_files(settings_path: &Path) -> Option<(Option<String>, Option<String>)> {
    let storage = FileSettingsStorage::new(project_root(settings_path), PathBuf::new());
    let system = storage.read_project_file("SYSTEM.md").ok()?;
    let append = storage.read_project_file("APPEND_SYSTEM.md").ok()?;
    Some((system, append))
}

/// The pin over given settings and prompt-file contents (already read by
/// the caller): the write path reads the prompt files ONCE and derives
/// both its admit check and its re-pin from that single read.
#[must_use]
pub(crate) fn pin_over(
    settings: Option<&str>,
    system: Option<&str>,
    append: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    let mut frame = |name: &str, content: Option<&str>| {
        let bytes = content.unwrap_or_default().as_bytes();
        hasher.update(name.as_bytes());
        hasher.update([u8::from(content.is_some())]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    frame("settings.json", settings);
    frame("SYSTEM.md", system);
    frame("APPEND_SYSTEM.md", append);
    hex(&hasher.finalize())
}

/// The trust pin for a project as it is on disk now (see [`pin`]), with
/// `settings.json` read the way the loader reads it (the bounded project
/// storage). `None` when a pinned file is unreadable or refused: such a
/// project cannot be trusted.
#[must_use]
pub fn project_fingerprint(settings_path: &Path) -> Option<String> {
    let project_dir = settings_path.parent()?.parent()?.parent()?;
    // Only the project scope is read, so the agent dir is never consulted.
    let settings = FileSettingsStorage::new(project_dir, PathBuf::new())
        .read(super::storage::SettingsScope::Project)
        .ok()?;
    pin(settings_path, settings.as_deref())
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
    hex(&Sha256::digest(key.as_os_str().as_encoded_bytes()))
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

/// The existing gated project-config entries for `cwd`: the
/// `.prime/agent` files and directories plus the `.agents/skills`
/// directories the auto-discovery loads. Empty when the project's config
/// dir is the agent dir itself: that is the user's own global config.
#[must_use]
pub fn gated_project_entries(cwd: &Path, agent_dir: &Path) -> Vec<PathBuf> {
    let config_dir = cwd.join(super::storage::CONFIG_DIR_NAME);
    if config_dir == agent_dir {
        return Vec::new();
    }
    let mut entries = [
        "settings.json",
        "SYSTEM.md",
        "APPEND_SYSTEM.md",
        "skills",
        "prompts",
        "themes",
    ]
    .iter()
    .map(|name| config_dir.join(name))
    .filter(|path| path.exists())
    .collect::<Vec<PathBuf>>();
    entries.extend(
        gated_agents_skill_dirs(cwd)
            .into_iter()
            .filter(|dir| dir.is_dir()),
    );
    entries
}

/// The project dir whose gated config is present but untrusted, so the
/// session ignores it: the one source of the ignored-config notice.
#[must_use]
pub fn ignored_project_dir(cwd: &Path, agent_dir: &Path, trusted: bool) -> Option<PathBuf> {
    (!trusted && !gated_project_entries(cwd, agent_dir).is_empty()).then(|| cwd.to_path_buf())
}

/// The one-line ignored-config notice for `dir`. The path is printed on
/// every headless launch, so control bytes (a checkout path carrying
/// CSI/OSC sequences) are escaped like every other printed path.
#[must_use]
pub fn ignored_project_notice(dir: &Path) -> String {
    format!(
        "This project's Prime Agent config is ignored until you trust it: run `prime-agent trust {}`. Sessions started after that load it.",
        escaped_path(dir)
    )
}

/// A path with control bytes replaced by `?` (the interactive prompt's
/// escaping rule, for the headless notice).
fn escaped_path(path: &Path) -> std::borrow::Cow<'_, str> {
    let text = path.display().to_string();
    if text.chars().any(char::is_control) {
        text.chars()
            .map(|char| if char.is_control() { '?' } else { char })
            .collect::<String>()
            .into()
    } else {
        text.into()
    }
}

/// The `.agents/skills` directories the auto-discovery would load for this
/// cwd (its own first, up to and including the git repo root), with the
/// user's global directory excluded: the loader and the trust prompt share
/// this one source of truth so the gated paths the prompt lists can never
/// drift from what the discovery actually loads.
#[must_use]
fn gated_agents_skill_dirs(cwd: &Path) -> Vec<PathBuf> {
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

    /// Whether the registry pins this project with `settings` as its
    /// settings document (as the loader read it; `None` when absent).
    #[must_use]
    pub(crate) fn admits(&self, settings: Option<&str>) -> bool {
        pin(&self.settings_path, settings).is_some_and(|pin| self.matches(&pin))
    }

    /// The prompt files' content, ONE read of each (the write path's admit
    /// check and its re-pin share this read, so nothing unlocked sits
    /// between the check and the pin that lands in the registry).
    /// `None` when a prompt file is unreadable or refused: such a project
    /// cannot be trusted.
    #[must_use]
    pub(crate) fn prompt_files(&self) -> Option<(Option<String>, Option<String>)> {
        prompt_files(&self.settings_path)
    }

    /// Whether the registry pins this project with the given pin.
    #[must_use]
    pub(crate) fn matches(&self, pin: &str) -> bool {
        project_trusted(&self.registry_path, &self.settings_path, pin)
    }

    /// Re-pin this project's trust with an ALREADY-VALIDATED pin — derived
    /// from the same single prompt-file read the admit check used, never a
    /// fresh disk read.
    ///
    /// # Errors
    ///
    /// Returns an error when the registry cannot be read or written.
    pub(crate) fn trust_pin(&self, pin: &str) -> Result<()> {
        trust_project(&self.registry_path, &self.settings_path, pin)
    }
}
