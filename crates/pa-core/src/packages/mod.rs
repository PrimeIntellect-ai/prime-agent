//! Package manager subsystem: install/remove/list/update of `npm:`, git, and
//! local-dir package sources against the settings store, plus the
//! configured-npm/git child-process flows.
//!
//! Session resource resolution lives here as well: `PackageManager::resolve`
//! produces the ranked skill/prompt/theme/extension paths sessions consume.
//!
//! Non-goals (follow-up specs in `docs/parity-checklist.md`): the extension
//! *runner* (loading/executing extension modules) and Prime Agent
//! self-updates.

mod git;
mod manager;
mod npm;
mod process;
pub(crate) mod resolve;
pub mod resource_config;
mod source;
mod update;

#[cfg(test)]
mod tests;

pub use manager::{
    BundledSkillsDir, ConfiguredPackage, PackageManager, PackageManagerOptions, PackageUpdate,
    ProgressAction, ProgressEvent, ProgressEventKind, UserOrProject,
};
pub use resolve::{
    MetadataSource, MissingSourceAction, PathMetadata, ResolveExtensionOptions, ResolvedPaths,
    ResolvedResource, ResourceOrigin, ResourceType,
};
pub use source::{parse_git_url, GitSource, LocalSource, NpmSource, ParsedSource, SourceScope};

use std::fmt::Write as _;
use std::path::PathBuf;

/// The TS `CONFIG_DIR_NAME` (project-local settings/packages root).
pub use crate::settings::CONFIG_DIR_NAME;

/// Network probe timeout for npm/git operations (10s).
pub(crate) use npm::NETWORK_TIMEOUT_MS;

/// True when `PI_OFFLINE` disables all package network operations.
pub(crate) fn is_offline_mode_enabled() -> bool {
    std::env::var("PI_OFFLINE").is_ok_and(|value| {
        value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
    })
}

/// The package directory: `PI_PACKAGE_DIR` wins (matching the TS
/// `getPackageDir` override), then the directory of the executable (the
/// packaged bun-binary layout).
pub(crate) fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_tilde(&env_dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The bundled docs directory (TS `getDocsPath`): `<package dir>/docs`.
pub fn docs_path() -> PathBuf {
    package_dir().join("docs")
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// The workspace root at compile time (source-checkout layout): pa-core
/// lives at `<root>/crates/pa-core`.
/// Compile-time workspace root (`<root>/crates/pa-core` ancestors), shared by
/// every package-dir resolution that falls back to the source-checkout layout.
pub(crate) fn source_checkout_root() -> Option<&'static std::path::Path> {
    static ROOT: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .map(std::path::Path::to_path_buf)
    })
    .as_deref()
}

/// The directory of built-in skills shipped with the package (TS
/// `getBundledSkillsDir`): `skills/` next to the executable (the packaged
/// layout), falling back to the workspace `skills/` for source checkouts
/// (TS keeps built-in skills at the package root next to `src/`).
pub(crate) fn get_bundled_skills_dir() -> PathBuf {
    let packaged = package_dir().join("skills");
    if packaged.is_dir() {
        return packaged;
    }
    if let Some(root) = source_checkout_root() {
        let source_checkout = root.join("skills");
        if source_checkout.is_dir() {
            return source_checkout;
        }
    }
    packaged
}

/// Stable temporary directory for resolve-only package installs:
/// `/tmp/pi-extensions/<prefix>/<hash8>/<suffix?>` (the hash keys on
/// prefix+suffix so the same source always maps to one checkout).
pub(crate) fn temporary_dir(prefix: &str, suffix: Option<&str>) -> PathBuf {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(format!("{prefix}-{}", suffix.unwrap_or_default()).as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest[..4].iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    });
    std::env::temp_dir()
        .join("pi-extensions")
        .join(prefix)
        .join(&hash)
        .join(suffix.unwrap_or_default())
}

#[cfg(test)]
pub(crate) mod test_support {
    /// Process-wide env reads and writes (HOME, `PI_OFFLINE`) serialize
    /// through one lock across the packages test modules: parallel test
    /// threads in the same binary otherwise race the process env.
    pub(crate) static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
