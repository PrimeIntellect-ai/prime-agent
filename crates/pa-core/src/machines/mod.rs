//! The machine library: MACHINE.md discovery and listing.
//!
//! A factory machine is the shareable template counterpart of the factory
//! harness entry: one directory per machine (named after the machine)
//! holding a MACHINE.md, mirroring the shipped skills layout
//! (`skills/<name>/SKILL.md`). The library resolves from two levels, repo
//! first, user second:
//!
//! - repo: the packaged `machines/` beside the executable (`PI_PACKAGE_DIR`
//!   wins), falling back to the workspace `machines/` for source checkouts -
//!   exactly how the bundled skills directory resolves;
//! - user: `<agent dir>/machines` (the personal library; `factory import`
//!   persists there).
//!
//! This module owns the Rust-facing read surface only: frontmatter
//! metadata for `prime-agent factory list`. The machine-spec validation
//! gate stays with the kernel (`rlm.factory`'s write-time validator runs
//! in the kernel Python for import and run), so no spec semantics live
//! here.

use std::path::{Path, PathBuf};

use crate::skills::frontmatter::parse_frontmatter;

/// The machine file name inside one machine directory (`skills` keeps
/// `SKILL.md`; machines keep `MACHINE.md`).
pub const MACHINE_FILE_NAME: &str = "MACHINE.md";

/// The library directory name under the package root / agent dir.
pub const MACHINES_DIR_NAME: &str = "machines";

/// Machine name length cap, mirrored from the skill library.
pub const MACHINE_NAME_MAX_LENGTH: usize = 64;

/// Description length cap, mirrored from the skill library.
pub const MACHINE_DESCRIPTION_MAX_LENGTH: usize = 1024;

/// The library level a listed machine came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineSource {
    /// The shipped / checkout machines directory (team-shared).
    Repo,
    /// The agent-dir machines directory (personal).
    User,
}

impl MachineSource {
    /// The stable label used by the listing output.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Repo => "repo",
            Self::User => "user",
        }
    }
}

/// One library machine as the CLI lists it (frontmatter metadata only).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MachineListing {
    /// The declared machine name (falls back to the directory name,
    /// mirroring the skill loader).
    pub name: String,
    /// The one-line description from the frontmatter.
    pub description: String,
    /// The declared version (frontmatter), if any.
    pub version: Option<String>,
    /// The declared author (frontmatter), if any.
    pub author: Option<String>,
    /// The library level the machine resolved from.
    pub source: MachineSource,
    /// The absolute MACHINE.md path.
    pub path: PathBuf,
}

/// Machine name rules, mirrored from the skill library (`validate_name`):
/// lowercase a-z, 0-9, hyphens; no leading or trailing hyphen; capped
/// length.
#[must_use]
pub fn machine_name_errors(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.len() > MACHINE_NAME_MAX_LENGTH {
        errors.push(format!(
            "machine name exceeds {MACHINE_NAME_MAX_LENGTH} characters ({})",
            name.len()
        ));
    }
    if name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.is_empty()
        && !name.starts_with('-')
        && !name.ends_with('-')
    {
        return errors;
    }
    if name.is_empty()
        || name
            .chars()
            .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    {
        errors.push(
            "machine name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)"
                .to_string(),
        );
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("machine name must not start or end with a hyphen".to_string());
    }
    errors
}

/// The exe-adjacent (or `PI_PACKAGE_DIR`) package directory, mirroring the
/// kernel bootstrap's `package_dir` resolution.
fn package_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_PACKAGE_DIR") {
        if !dir.is_empty() {
            if let Some(home) = pa_types::platform::home_dir() {
                if dir == "~" {
                    return Some(home);
                }
                if let Some(rest) = dir.strip_prefix("~/") {
                    return Some(home.join(rest));
                }
            }
            return Some(PathBuf::from(dir));
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// The repo-level machines directory, resolved like the bundled skills
/// directory: packaged `machines/` beside the executable (or
/// `PI_PACKAGE_DIR`), falling back to the workspace `machines/` for
/// source checkouts.
#[must_use]
pub fn repo_machines_dir() -> Option<PathBuf> {
    if let Some(package) = package_dir() {
        let packaged = package.join(MACHINES_DIR_NAME);
        if packaged.is_dir() {
            return Some(packaged);
        }
    }
    let checkout = crate::packages::source_checkout_root()?;
    let machines = checkout.join(MACHINES_DIR_NAME);
    machines.is_dir().then_some(machines)
}

/// The personal machines directory under the agent state dir.
#[must_use]
pub fn user_machines_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(MACHINES_DIR_NAME)
}

/// Frontmatter scalar read: `frontmatter[key]` as a string when the value
/// is a plain scalar (numbers stringify, matching the Python subset
/// parser's string view).
fn frontmatter_string(frontmatter: &serde_json::Value, key: &str) -> Option<String> {
    match frontmatter.get(key) {
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Load one MACHINE.md for listing. Mirrors the skill loader: the declared
/// name wins over the directory name, the description is required, and a
/// broken file is skipped with its warning (its exact errors surface when
/// the machine is resolved, imported, or run).
fn load_machine_listing(
    file_path: &Path,
    source: MachineSource,
) -> (Option<MachineListing>, Vec<String>) {
    let mut warnings = Vec::new();
    let raw = match std::fs::read_to_string(file_path) {
        Ok(raw) => raw,
        Err(error) => {
            warnings.push(format!("{}: {error}", file_path.display()));
            return (None, warnings);
        }
    };
    let (frontmatter, _body) = parse_frontmatter(&raw);
    let parent_dir_name = file_path
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = frontmatter_string(&frontmatter, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| parent_dir_name.clone());
    for error in machine_name_errors(&name) {
        warnings.push(format!("{}: {error}", file_path.display()));
    }
    if name != parent_dir_name {
        warnings.push(format!(
            "{}: machine name \"{name}\" does not match parent directory \"{parent_dir_name}\"",
            file_path.display()
        ));
    }
    let description = frontmatter_string(&frontmatter, "description").unwrap_or_default();
    if description.trim().is_empty() {
        warnings.push(format!(
            "{}: frontmatter description is required",
            file_path.display()
        ));
        return (None, warnings);
    }
    if description.len() > MACHINE_DESCRIPTION_MAX_LENGTH {
        warnings.push(format!(
            "{}: frontmatter description exceeds {MACHINE_DESCRIPTION_MAX_LENGTH} characters ({})",
            file_path.display(),
            description.len()
        ));
        return (None, warnings);
    }
    (
        Some(MachineListing {
            name,
            description,
            version: frontmatter_string(&frontmatter, "version"),
            author: frontmatter_string(&frontmatter, "author"),
            source,
            path: file_path.to_path_buf(),
        }),
        warnings,
    )
}

/// List the machine library: repo directory first, user second, deduped by
/// name (the earlier level keeps the name, matching the kernel's
/// resolution order). Broken files are skipped and reported as warnings.
#[must_use]
pub fn list_machines(
    repo_dir: Option<&Path>,
    user_dir: &Path,
) -> (Vec<MachineListing>, Vec<String>) {
    let mut machines: Vec<MachineListing> = Vec::new();
    let mut warnings = Vec::new();
    let levels = [
        (repo_dir, MachineSource::Repo),
        (Some(user_dir), MachineSource::User),
    ];
    for (level_dir, source) in levels {
        let Some(directory) = level_dir else { continue };
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.path().join(MACHINE_FILE_NAME).is_file())
            .map(|entry| entry.path().join(MACHINE_FILE_NAME))
            .collect();
        paths.sort();
        for path in paths {
            let (listing, file_warnings) = load_machine_listing(&path, source);
            warnings.extend(file_warnings);
            if let Some(listing) = listing {
                if !machines
                    .iter()
                    .any(|existing| existing.name == listing.name)
                {
                    machines.push(listing);
                }
            }
        }
    }
    machines.sort_by(|a, b| a.name.cmp(&b.name));
    (machines, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_machine(root: &Path, dir: &str, name: &str, description: &str) -> PathBuf {
        let directory = root.join(dir);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(MACHINE_FILE_NAME);
        std::fs::write(
            &path,
            format!(
                "---\nname: {name}\ndescription: {description}\nversion: 1\nauthor: Tester\n---\n\n# {name}\n\n```machine-spec\n{{\"states\": []}}\n```\n"
            ),
        )
        .unwrap();
        path
    }

    #[test]
    fn machine_name_rules_mirror_the_skill_library() {
        assert!(machine_name_errors("sweep-2").is_empty());
        assert!(machine_name_errors("").len() == 1);
        for bad in ["Sweep", "sweep x", "-sweep", "sweep-"] {
            assert!(!machine_name_errors(bad).is_empty(), "{bad}");
        }
        assert_eq!(
            machine_name_errors(&"a".repeat(65)).len(),
            1,
            "only the length error for a long-but-valid charset name"
        );
    }

    #[test]
    fn lists_repo_first_and_dedupes_by_name() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo-machines");
        let user = temp.path().join("user-machines");
        write_machine(&repo, "sweep", "sweep", "The repo machine.");
        write_machine(&user, "sweep", "sweep", "The user machine.");
        write_machine(&user, "alpha", "alpha", "An early machine.");
        let (machines, warnings) = list_machines(Some(&repo), &user);
        assert!(warnings.is_empty(), "{warnings:?}");
        let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["alpha", "sweep"]);
        let sweep = machines.iter().find(|m| m.name == "sweep").unwrap();
        assert_eq!(sweep.source, MachineSource::Repo);
        assert_eq!(sweep.description, "The repo machine.");
        assert_eq!(sweep.version.as_deref(), Some("1"));
        assert_eq!(sweep.author.as_deref(), Some("Tester"));
        let alpha = machines.iter().find(|m| m.name == "alpha").unwrap();
        assert_eq!(alpha.source, MachineSource::User);
    }

    #[test]
    fn the_declared_name_wins_and_mismatches_warn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user = temp.path().join("user-machines");
        write_machine(&user, "renamed-dir", "sweep", "The renamed machine.");
        let (machines, warnings) = list_machines(None, &user);
        assert_eq!(machines.len(), 1);
        assert_eq!(machines[0].name, "sweep");
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("does not match parent directory")),
            "{warnings:?}"
        );
    }

    #[test]
    fn missing_description_skips_with_a_warning() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user = temp.path().join("user-machines");
        let directory = user.join("broken");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(MACHINE_FILE_NAME),
            "---\nname: broken\n---\n",
        )
        .unwrap();
        let (machines, warnings) = list_machines(None, &user);
        assert!(machines.is_empty());
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("description is required")),
            "{warnings:?}"
        );
    }

    #[test]
    fn user_dir_is_the_agent_dir_machines() {
        let agent_dir = Path::new("/tmp/agent-home");
        assert_eq!(
            user_machines_dir(agent_dir),
            PathBuf::from("/tmp/agent-home/machines")
        );
    }

    #[test]
    fn repo_dir_resolves_the_workspace_seeds_in_a_checkout() {
        // The source-checkout fallback finds the shipped example machines,
        // so `factory list` reports the seeds the kernel can run.
        let repo = repo_machines_dir();
        let Some(repo) = repo else {
            return; // a packaged/exe-adjacent layout without machines/
        };
        let (machines, warnings) =
            list_machines(Some(&repo), Path::new("/nonexistent-user-machines"));
        assert!(warnings.is_empty(), "{warnings:?}");
        let names: Vec<&str> = machines.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"review-sweep"), "{names:?}");
        assert!(names.contains(&"builder"), "{names:?}");
        assert!(names.contains(&"pr-manager"), "{names:?}");
    }
}
