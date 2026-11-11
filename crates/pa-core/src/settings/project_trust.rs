//! Project-settings trust (the CWE-426 gate): a repository's
//! `<project>/.prime/agent/settings.json` loads ENTIRELY INERT until the
//! user has explicitly trusted it. Trust is per repository (its
//! subdirectories and registered worktrees share it), recorded in the
//! user-level registry (`<agent dir>/trusted-projects.json`) as the set of
//! approved pins, each one fingerprint over `settings.json`, `SYSTEM.md`,
//! and `APPEND_SYSTEM.md`, so any other content in those files re-prompts.
//! Headless and API paths never prompt: no registry entry means denied.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
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
/// beside `settings_path`. An error when a prompt file exists but is
/// refused or unreadable: such a file never rides a pin.
fn pin(settings_path: &Path, settings: Option<&str>) -> Result<String> {
    let (system, append) = prompt_files(settings_path)?;
    Ok(pin_over(settings, system.as_deref(), append.as_deref()))
}

/// The pinned prompt files beside `settings_path`, ONE read of each through
/// the project storage (its link, size, and regular-file rules), so a
/// checkout cannot hang or exhaust the process before any trust decision.
/// An error naming the file when either is refused or unreadable.
fn prompt_files(settings_path: &Path) -> Result<(Option<String>, Option<String>)> {
    let storage = FileSettingsStorage::new(project_root(settings_path), PathBuf::new());
    Ok((
        storage.read_project_file("SYSTEM.md")?,
        storage.read_project_file("APPEND_SYSTEM.md")?,
    ))
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
/// storage).
///
/// # Errors
///
/// Returns an error naming the file and the cause when a pinned file is
/// refused or unreadable: such a project cannot be trusted.
pub fn project_fingerprint(settings_path: &Path) -> Result<String> {
    // Only the project scope is read, so the agent dir is never consulted.
    let settings = FileSettingsStorage::new(project_root(settings_path), PathBuf::new())
        .read(super::storage::SettingsScope::Project)
        .with_context(|| format!("cannot read {}", settings_path.display()))?;
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

/// The canonical directory whose trust covers `project_dir`: the git common
/// dir, so a repository's subdirectories and the worktrees the user's own
/// git registered share one decision; outside git, the directory itself. A
/// `.git` that is a symlink, or a `.git` file whose worktree is not
/// registered back in the common dir it names, keys as its own checkout
/// (the root): an untrusted tree never claims another repository's trust.
fn repository_dir(project_dir: &Path) -> PathBuf {
    let Ok(dir) = std::fs::canonicalize(project_dir) else {
        return project_dir.to_path_buf();
    };
    let Some(root) = crate::packages::resolve::discovery::find_git_repo_root(&dir) else {
        return dir;
    };
    let dot_git = root.join(".git");
    let linked_common_dir = || -> Option<PathBuf> {
        // Git metadata is one-line pointer text by nature; every read is
        // bounded (a checkout-controlled file must never exhaust the
        // process before a trust decision) and regular-file-validated.
        let gitdir_line = super::storage::read_git_metadata(&dot_git).ok()?;
        let gitdir =
            std::fs::canonicalize(root.join(gitdir_line.strip_prefix("gitdir:")?.trim())).ok()?;
        let commondir = super::storage::read_git_metadata(&gitdir.join("commondir")).ok()?;
        let common = std::fs::canonicalize(gitdir.join(commondir.trim())).ok()?;
        // `git worktree add` records the worktree's back-pointer inside the
        // common dir: the user's own repository, out of the checkout's reach.
        let back_pointer = super::storage::read_git_metadata(&gitdir.join("gitdir")).ok()?;
        let registered = gitdir.parent() == Some(common.join("worktrees").as_path())
            && std::fs::canonicalize(gitdir.join(back_pointer.trim())).ok()? == dot_git;
        registered.then_some(common)
    };
    match std::fs::symlink_metadata(&dot_git) {
        Ok(metadata) if metadata.is_dir() => dot_git,
        Ok(metadata) if metadata.is_file() => linked_common_dir().unwrap_or(root),
        _ => root,
    }
}

/// The registry key for a repository dir: the hex SHA-256 of its OS bytes
/// (lossless: a `to_string_lossy` key would collide distinct non-UTF-8
/// paths). Keying by the repository — never the settings file — keeps a
/// second project that symlinks its settings file at a trusted one behind
/// its own trust decision.
fn registry_key(repository: &Path) -> String {
    hex(&Sha256::digest(repository.as_os_str().as_encoded_bytes()))
}

/// One repository's registry entry: its path, for revoking by hand, and
/// every pin the user approved for it.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct RegistryEntry {
    path: String,
    pins: Vec<String>,
}

/// The registry's entry for `repository`; `None` on any missing,
/// unreadable, or malformed registry or entry (denied, never open).
fn registry_entry(registry_path: &Path, repository: &Path) -> Option<RegistryEntry> {
    let content = std::fs::read_to_string(registry_path).ok()?;
    let mut registry: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&content).ok()?;
    serde_json::from_value(registry.remove(&registry_key(repository))?).ok()
}

/// The trust decision for one project's settings file: its repository has
/// an entry, and the project's pin is one the user approved there or the
/// all-absent pin, which carries no content (a subdirectory or worktree
/// without its own pinned files then behaves like an in-place `git switch`
/// in the trusted checkout). Deny-by-default: any read or parse failure
/// denies.
#[must_use]
pub fn project_trusted(registry_path: &Path, settings_path: &Path, fingerprint: &str) -> bool {
    registry_entry(registry_path, &repository_dir(&project_root(settings_path))).is_some_and(
        |entry| {
            fingerprint == pin_over(None, None, None)
                || entry.pins.iter().any(|pin| pin == fingerprint)
        },
    )
}

/// Record the user's trust for one project's settings file: its pin joins
/// the pins approved for its repository. Returns the repository path the
/// entry names.
///
/// # Errors
///
/// Returns an error when the registry cannot be read or written.
pub fn trust_project(
    registry_path: &Path,
    settings_path: &Path,
    fingerprint: &str,
) -> Result<PathBuf> {
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
                        "the trusted-projects registry {} is malformed; not overwritten: {error}",
                        registry_path.display()
                    )
                })?
            }
            _ => serde_json::Map::new(),
        };
    let repository = repository_dir(&project_root(settings_path));
    let key = registry_key(&repository);
    let mut entry: RegistryEntry = registry
        .get(&key)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    // A git common dir named `.git` shows as its main checkout.
    let path = repository
        .parent()
        .filter(|_| repository.ends_with(".git"))
        .unwrap_or(&repository)
        .to_path_buf();
    entry.path = path.to_string_lossy().into_owned();
    if !entry.pins.iter().any(|pin| pin == fingerprint) {
        entry.pins.push(fingerprint.to_string());
    }
    registry.insert(key, serde_json::to_value(&entry)?);
    atomic_write_with(
        registry_path,
        &serde_json::to_string_pretty(&registry)?,
        AtomicWriteOptions { fsync: true },
    )?;
    drop(guard);
    Ok(path)
}

/// Trust the project at `cwd` as it is on disk: for fixtures exercising
/// the trusted path (the gate's own tests pin the untrusted one).
#[cfg(test)]
pub(crate) fn trust_as_on_disk(cwd: &Path, agent_dir: &Path) {
    let settings_path = cwd
        .join(super::storage::CONFIG_DIR_NAME)
        .join("settings.json");
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();
}

#[cfg(test)]
mod tests;

/// The existing gated project-config entries for `cwd`: the
/// `.prime/agent` files and directories plus the `.agents/skills`
/// directories the auto-discovery loads. Empty when the project's config
/// dir is the agent dir itself: that is the user's own global config.
#[must_use]
pub fn gated_project_entries(cwd: &Path, agent_dir: &Path) -> Vec<PathBuf> {
    let Some(config_dir) = project_config_dir(cwd, agent_dir) else {
        return Vec::new();
    };
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

/// The project config dir for `cwd`; `None` when it is the agent dir itself
/// (a session in `$HOME`): that is the user's own global config, never
/// gated.
fn project_config_dir(cwd: &Path, agent_dir: &Path) -> Option<PathBuf> {
    Some(cwd.join(super::storage::CONFIG_DIR_NAME)).filter(|config_dir| config_dir != agent_dir)
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
        "This repository's Prime Agent config is ignored until you trust it: run `{}`. Sessions started after that load it.",
        trust_command(dir)
    )
}

/// The command that trusts `dir`, its path single-quoted so a path with
/// spaces pastes as one argument.
pub(crate) fn trust_command(dir: &Path) -> String {
    let path = escape_control(&dir.display().to_string()).replace('\'', "'\\''");
    format!("prime-agent trust '{path}'")
}

/// `text` with control characters replaced by `?`: a directory name from
/// an archive can carry terminal control sequences.
#[must_use]
pub fn escape_control(text: &str) -> std::borrow::Cow<'_, str> {
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
pub(crate) fn gated_agents_skill_dirs(cwd: &Path) -> Vec<PathBuf> {
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
    /// The gate for `cwd`'s project scope; `None` when the project config
    /// dir is the agent dir (see [`gated_project_entries`]).
    pub(crate) fn new(cwd: &Path, agent_dir: &Path) -> Option<Self> {
        project_config_dir(cwd, agent_dir).map(|config_dir| ProjectTrustGate {
            registry_path: agent_dir.join(TRUSTED_PROJECTS_FILE),
            settings_path: config_dir.join("settings.json"),
        })
    }

    /// The command that trusts this project.
    pub(crate) fn trust_command(&self) -> String {
        trust_command(&project_root(&self.settings_path))
    }

    /// Whether the registry pins this project with `settings` as its
    /// settings document (as the loader read it; `None` when absent).
    #[must_use]
    pub(crate) fn admits(&self, settings: Option<&str>) -> bool {
        pin(&self.settings_path, settings).is_ok_and(|pin| self.matches(&pin))
    }

    /// The prompt files' content, ONE read of each (the write path's admit
    /// check and its re-pin share this read, so nothing unlocked sits
    /// between the check and the pin that lands in the registry).
    /// An error when a prompt file is unreadable or refused: such a project
    /// cannot be trusted.
    pub(crate) fn prompt_files(&self) -> Result<(Option<String>, Option<String>)> {
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
    pub(crate) fn trust_pin(&self, pin: &str) -> Result<PathBuf> {
        trust_project(&self.registry_path, &self.settings_path, pin)
    }
}
