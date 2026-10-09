//! The running build's product version: the ONE identity the CLI's
//! `--version`, the daemon hello's `appVersion` and `buildId`, the CLI
//! `doctor`/`status` "current" classification, and the TUI reconnect
//! banner all share.
//!
//! The channel stamp: the release pipeline stages a `package.json` version
//! manifest beside the binary (`assemble_artifacts.py` stages the
//! continuous stamp, the beta consume route restamps it to the channel
//! version — the same value `install-rust.sh` records in the
//! `.prime-agent-install` marker), and the shipped binary reads it at
//! runtime. TS parity: the TS daemon's hello `appVersion` was the
//! exe-adjacent manifest's `VERSION` (`packages/coding-agent` config
//! `VERSION: string = pkg.version`), the exact string `--version` printed.
//! A dev build ships no manifest, so the compiled-in workspace version is
//! the fallback — the two surfaces only disagree when a release restamped
//! the manifest without rebuilding, which is precisely the bug this seam
//! exists to close: the daemon used to hard-wire the compiled-in version
//! while the CLI read the manifest.

use std::path::{Path, PathBuf};

/// The compiled-in workspace version: the dev-build fallback used when no
/// packaged `package.json` manifest sits beside the executable.
pub const COMPILED_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The product version of this running build: the packaged manifest's
/// channel stamp, falling back to [`COMPILED_APP_VERSION`] for dev builds.
/// Cached after the first resolution.
#[must_use]
pub fn app_version() -> &'static str {
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(|| {
        packaged_manifest_version_in(&package_dir())
            .unwrap_or_else(|| COMPILED_APP_VERSION.to_string())
    })
}

/// The packaged version manifest's `version` in `dir` (`None` when absent,
/// unparsable, or empty — the caller's fallback applies). The manifest is
/// the release pipeline's own `package.json` (`assemble_artifacts.py`
/// `stage_tree`), so only its `version` string is read.
fn packaged_manifest_version_in(dir: &Path) -> Option<String> {
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// The packaged package dir (`PI_PACKAGE_DIR` wins, else the directory of
/// the executable with launcher symlinks resolved) — the same convention as
/// `pa_core::packages::package_dir`.
fn package_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_PACKAGE_DIR") {
        if !dir.is_empty() {
            return expand_tilde(&dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe_dir_of(&exe))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The directory beside the binary's real file: a launcher symlink must
/// resolve, or the payload shipped beside the real binary is invisible.
fn exe_dir_of(exe: &Path) -> Option<PathBuf> {
    let is_symlink =
        std::fs::symlink_metadata(exe).is_ok_and(|metadata| metadata.file_type().is_symlink());
    let resolved = if is_symlink {
        exe.canonicalize().ok()?
    } else {
        exe.to_path_buf()
    };
    resolved.parent().map(Path::to_path_buf)
}

/// Expand a leading `~` or `~/` segment against the home directory.
fn expand_tilde(path: &str) -> PathBuf {
    let Some(home) = crate::platform::home_dir() else {
        return PathBuf::from(path);
    };
    if path == "~" {
        return home;
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home.join(rest);
    }
    #[cfg(windows)]
    if let Some(rest) = path.strip_prefix("~\\") {
        return home.join(rest);
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The manifest's `version` wins whenever it is a non-empty string;
    /// every broken shape falls back (the compiled-in version below).
    #[test]
    fn manifest_version_reads_only_a_nonempty_string() {
        let dir = tempfile::tempdir().expect("tempdir");
        let with = |manifest: &str| {
            std::fs::write(dir.path().join("package.json"), manifest).expect("write manifest");
            packaged_manifest_version_in(dir.path())
        };
        assert_eq!(
            with(r#"{"name":"prime-agent","version":"9.8.7-test"}"#),
            Some("9.8.7-test".to_string())
        );
        assert_eq!(
            with(r#"{"version":" 0.9.9-beta.55 "}"#),
            Some("0.9.9-beta.55".to_string())
        );
        assert_eq!(with(r#"{"version":""}"#), None);
        assert_eq!(with(r#"{"version":"   "}"#), None);
        assert_eq!(with(r#"{"version":42}"#), None);
        assert_eq!(with("not json at all"), None);
        std::fs::remove_file(dir.path().join("package.json")).expect("remove manifest");
        assert_eq!(packaged_manifest_version_in(dir.path()), None);
    }

    /// The dev-build fallback: with no packaged manifest beside this test
    /// binary, the identity is the compiled-in workspace version (the same
    /// string `--version` prints for a dev build).
    #[test]
    fn app_version_falls_back_without_a_manifest() {
        // The test binary's own exe dir ships no package.json; scrub the
        // override so the ambient environment cannot steer the resolution.
        std::env::remove_var("PI_PACKAGE_DIR");
        assert_eq!(app_version(), COMPILED_APP_VERSION);
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }
}
