//! The managed install-root layout (the TS `native-installation.ts` port):
//! the on-disk contract the coordinator's activation path owns —
//! `bin/prime-agent` and `bin/previous` symlinks into
//! `releases/<version>-<platform>-<sha256>/`, the `.managed` marker, and the
//! `.activation-state` rollback pointer (spec §7 "install root
//! (TS-compatible, native-installation.ts parity)").
//!
//! Divergence from TS, recorded in PORTING-NOTES: TS releases carry
//! `package.json`, `install.sh`, `.archive-sha256`, and `.install-source`
//! from the installer; the Rust release payload (installer-ci-design.md §5)
//! ships `prime-agent`, `prime-agent-runtime/`, `skills/`, `docs/`,
//! `LICENSE`, `README.md`, and the update flow writes `.archive-sha256` and
//! `.install-source` itself at staging time. Validation checks the Rust
//! payload, never the TS asset list.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// The release platforms the update flow knows (TS `NATIVE_PLATFORMS`, the
/// subset the Rust port currently publishes; the manifest ignores unknown
/// entries, so future platforms pass through unvalidated).
pub const KNOWN_PLATFORMS: &[&str] = &[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
];

/// The TS release-platform alias of the running build (`assemble_artifacts.py`
/// `TARGET_ALIASES`). Baseline/musl variants cannot be distinguished at
/// runtime; the plain alias matches what the coordinator downloads.
pub fn current_platform_alias() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
}

/// One symlink target under the install root: the release directory name,
/// version, platform, and archive sha256 parsed from the
/// `../releases/<version>-<platform>-<sha256>/prime-agent` link shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallTarget {
    pub root: PathBuf,
    pub launcher: PathBuf,
    pub executable: PathBuf,
    pub release_dir: PathBuf,
    pub version: String,
    pub platform: String,
    pub sha256: String,
}

/// A validated installation plus its download base URL (TS
/// `NativeInstallation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installation {
    pub target: InstallTarget,
    pub base_url: String,
}

impl Installation {
    pub fn root(&self) -> &Path {
        &self.target.root
    }
    pub fn executable(&self) -> &Path {
        &self.target.executable
    }
    pub fn version(&self) -> &str {
        &self.target.version
    }
}

/// The marker file proving the root belongs to the Prime Agent installer
/// layout (TS `.managed` = `prime-agent-native-v1`).
pub const MANAGED_MARKER: &str = "prime-agent-native-v1";

/// The payload every staged release must carry (installer-ci-design.md §5).
pub const RELEASE_ASSETS: &[&str] = &[
    "prime-agent",
    "prime-agent-runtime",
    "skills",
    "docs",
    "LICENSE",
    "README.md",
];

/// The launcher symlink names under `<root>/bin/`.
pub const CURRENT_LAUNCHER: &str = "prime-agent";
pub const PREVIOUS_LAUNCHER: &str = "previous";

/// Read the install root of `executable`'s managed layout: the executable
/// resolves through `<root>/bin/<link>`; the root is `<root>/.managed`'s
/// directory (TS `getNativeInstallationTarget`).
pub fn install_root_of(executable: &Path) -> Option<PathBuf> {
    let resolved = executable.canonicalize().ok()?;
    // The resolved executable is <root>/releases/<name>/prime-agent: walk up
    // through the release directory to `releases`, then one more level.
    let releases = resolved.parent()?.parent()?;
    if !releases.ends_with("releases") {
        return None;
    }
    let root = releases.parent()?;
    let marker = std::fs::read_to_string(root.join(".managed")).ok()?;
    if marker.trim() != MANAGED_MARKER {
        return None;
    }
    Some(root.to_path_buf())
}

/// Parse one launcher's symlink into a validated [`InstallTarget`] (TS
/// `readNativeTarget`): the link must point at
/// `../releases/<version>-<platform>-<sha256>/prime-agent`, the payload must
/// exist, and `.archive-sha256` must match the recorded digest.
fn read_target(root: &Path, link: &str) -> Result<InstallTarget> {
    let launcher = root.join("bin").join(link);
    let target_text = std::fs::read_link(&launcher)
        .with_context(|| format!("read the {} launcher at {}", link, launcher.display()))?;
    let target = parse_release_link(&target_text).ok_or_else(|| {
        anyhow!(
            "launcher {link} does not target a managed release: {}",
            target_text.display()
        )
    })?;
    let release_dir = root.join("releases").join(release_directory_name(&target));
    let executable = release_dir.join("prime-agent");
    validate_release_dir(&release_dir, &target.sha256)?;
    Ok(InstallTarget {
        root: root.to_path_buf(),
        launcher,
        executable,
        release_dir,
        version: target.version,
        platform: target.platform,
        sha256: target.sha256,
    })
}

/// The version of a release directory name (the launcher-link parse over the
/// same shape; `None` for anything that is not a managed release name).
pub fn release_version_of(directory_name: &str) -> Option<String> {
    parse_release_link(Path::new(&format!(
        "../releases/{directory_name}/prime-agent"
    )))
    .map(|link| link.version)
}

/// The `releases/` directory name of a parsed link (`<version>-<platform>-<sha256>`).
fn release_directory_name(link: &ReleaseLink) -> String {
    format!("{}-{}-{}", link.version, link.platform, link.sha256)
}

/// The release a running executable lives in: its release directory and the
/// version parsed from the directory name. This is the updater's baseline
/// anchor — the version the update decision compares against comes from the
/// directory the RUNNING binary occupies, never from a launcher that can
/// point elsewhere. A hand-named directory (`0.10.0-rust-<sha>` dogfood
/// trains) fails the parse and is refused as a baseline, so the updater can
/// never plan an update "from" a version its binary does not report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningRelease {
    pub release_dir: PathBuf,
    pub version: String,
}

/// The running binary's release directory and version.
///
/// # Errors
///
/// Returns an error when the executable path cannot be resolved, does not
/// live in a release directory, or its directory name is not a managed
/// release name.
pub fn running_release(executable: &Path) -> Result<RunningRelease> {
    let resolved = executable
        .canonicalize()
        .with_context(|| format!("resolve {}", executable.display()))?;
    let directory = resolved
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            anyhow!(
                "{} does not live in a release directory",
                resolved.display()
            )
        })?;
    let version = release_version_of(&directory).ok_or_else(|| {
        anyhow!(
            "{} runs from release directory {directory:?}, which is not a managed release name (<version>-<platform>-<sha256>)",
            resolved.display()
        )
    })?;
    let release_dir = resolved
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", resolved.display()))?
        .to_path_buf();
    Ok(RunningRelease {
        release_dir,
        version,
    })
}

/// Whether an install source is one the release layout accepts
/// (`http://`/`https://`, the `validate_release_dir` read-side contract).
pub fn install_source_is_valid(source: &str) -> bool {
    let protocol = source.trim().split("://").next().unwrap_or_default();
    protocol == "https" || protocol == "http"
}

/// fsync a directory so its entries survive a crash (staged releases and
/// the launcher repoint must never reference an unwritten inode; a
/// directory fd opened read-only accepts `sync_all` on POSIX platforms).
///
/// # Errors
///
/// Returns an error when the directory cannot be opened or its `sync_all`
/// fails.
pub fn sync_directory(path: &Path) -> Result<()> {
    let dir = std::fs::File::open(path)?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", path.display()))
}

/// The parsed shape of a launcher link target.
struct ReleaseLink {
    version: String,
    platform: String,
    sha256: String,
}

/// Parse `../releases/<version>-<platform>-<sha256>/prime-agent` (TS
/// `NATIVE_RELEASE_DIRECTORY`, without a regex dependency: strip the digest
/// from the right, then match the longest known platform suffix - the
/// platform may itself contain dashes and the version a prerelease tag).
/// The TS layout allows an optional 6-character build id after the digest;
/// a Rust coordinator reading a TS-era install root must accept it too.
fn parse_release_link(target: &Path) -> Option<ReleaseLink> {
    let text = target.to_str()?;
    if !text.starts_with("../releases/") || !text.ends_with("/prime-agent") {
        return None;
    }
    let directory = &text["../releases/".len()..text.len() - "/prime-agent".len()];
    let digest_start = directory.rfind('-')?;
    let mut sha256 = &directory[digest_start + 1..];
    if sha256.len() > 64 + 1 + 6 {
        // Strip the TS build-id suffix: `<64 hex>.<6 alnum>`.
        let (digest, suffix) = sha256.split_once('.')?;
        if suffix.len() != 6 || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        sha256 = digest;
    }
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let head = &directory[..digest_start];
    let mut platforms: Vec<&str> = KNOWN_PLATFORMS.to_vec();
    platforms.sort_by_key(|platform| std::cmp::Reverse(platform.len()));
    let platform = platforms.into_iter().find(|platform| {
        head.strip_suffix(&format!("-{platform}"))
            .is_some_and(|version| !version.is_empty())
    })?;
    let version = head.strip_suffix(&format!("-{platform}"))?;
    Some(ReleaseLink {
        version: version.to_string(),
        platform: platform.to_string(),
        sha256: sha256.to_string(),
    })
}

/// Validate a release directory's payload and archive digest (TS
/// `validateNativeInstallation`, Rust payload list).
pub(super) fn validate_release_dir(release_dir: &Path, archive_sha256: &str) -> Result<()> {
    for asset in RELEASE_ASSETS {
        let path = release_dir.join(asset);
        if !path.exists() {
            anyhow::bail!(
                "release {} is damaged: {asset} is missing",
                release_dir.display()
            );
        }
    }
    let recorded = std::fs::read_to_string(release_dir.join(".archive-sha256"))
        .with_context(|| format!("read the archive digest of {}", release_dir.display()))?;
    if recorded.trim() != archive_sha256 {
        anyhow::bail!(
            "release {} is damaged: the archive digest does not match its name",
            release_dir.display()
        );
    }
    let source = std::fs::read_to_string(release_dir.join(".install-source"))
        .with_context(|| format!("read the install source of {}", release_dir.display()))?;
    if !install_source_is_valid(&source) {
        anyhow::bail!(
            "release {} has an invalid install source {source:?}",
            release_dir.display()
        );
    }
    Ok(())
}

/// Read the active installation (`bin/prime-agent`), TS
/// `readNativeInstallation(root)`. Falls back to `bin/previous` when the
/// active link is missing (the coordinator's rollback planning path).
///
/// # Errors
///
/// Returns an error when the launcher link cannot be read or validated, or
/// the release's `.install-source` metadata cannot be read.
pub fn read_installation(root: &Path, link: &str) -> Result<Installation> {
    let target = read_target(root, link)?;
    let base_url = std::fs::read_to_string(target.release_dir.join(".install-source"))
        .context("read the install source")?
        .trim()
        .to_string();
    Ok(Installation { target, base_url })
}

/// The rollback installation (TS `readNativeRollbackInstallation`): the
/// `.activation-state` record wins when present — it carries both link
/// targets from the interrupted swap, and trusting the bare `previous` link
/// alone would be ambiguous after a partial repoint.
///
/// # Errors
///
/// Returns an error when the `.activation-state` record cannot be read or is
/// empty or truncated, or when the fallback `previous` installation cannot
/// be read.
pub fn read_rollback_installation(root: &Path) -> Result<Installation> {
    let state_path = root.join(".activation-state");
    if !state_path.exists() {
        return read_installation(root, PREVIOUS_LAUNCHER);
    }
    let state = std::fs::read_to_string(&state_path)
        .with_context(|| format!("read {}", state_path.display()))?;
    // `<current-target>\n<previous-target>\n` (the coordinator's activation
    // writes exactly this shape).
    let mut lines = state.lines();
    let _current = lines
        .next()
        .ok_or_else(|| anyhow!("the activation state at {} is empty", state_path.display()))?;
    let previous = lines.next().ok_or_else(|| {
        anyhow!(
            "the activation state at {} is truncated",
            state_path.display()
        )
    })?;
    // The state's second line is the previous launcher's TARGET text (the
    // swap writes exactly that): parse it, resolve the release directory
    // through the root, and never re-read a link - a rollback must not
    // depend on links a partial swap may not have written yet.
    let target = parse_release_link(Path::new(previous)).ok_or_else(|| {
        anyhow!(
            "the previous target recorded in {} is not a release",
            state_path.display()
        )
    })?;
    let release_dir = root.join("releases").join(release_directory_name(&target));
    validate_release_dir(&release_dir, &target.sha256)?;
    let base_url = std::fs::read_to_string(release_dir.join(".install-source"))?
        .trim()
        .to_string();
    let executable = release_dir.join("prime-agent");
    Ok(Installation {
        target: InstallTarget {
            root: root.to_path_buf(),
            launcher: root.join("bin").join(PREVIOUS_LAUNCHER),
            executable,
            release_dir,
            version: target.version,
            platform: target.platform,
            sha256: target.sha256,
        },
        base_url,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A minimal managed fixture: `.managed`, one release with the full
    /// payload, and a `bin/<link>` pointing at it.
    fn fixture(root: &Path, link: &str, version: &str, sha256: &str) {
        let release = format!("{version}-linux-x64-{sha256}");
        let release_dir = root.join("releases").join(&release);
        std::fs::create_dir_all(&release_dir).unwrap();
        for asset in RELEASE_ASSETS {
            let path = release_dir.join(asset);
            if asset.contains('.') {
                std::fs::write(&path, "x").unwrap();
            } else {
                std::fs::create_dir_all(&path).unwrap();
            }
        }
        std::fs::write(release_dir.join(".archive-sha256"), sha256).unwrap();
        std::fs::write(release_dir.join(".install-source"), "https://example.com").unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join(".managed"), MANAGED_MARKER).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            format!("../releases/{release}/prime-agent"),
            root.join("bin").join(link),
        )
        .unwrap();
    }

    #[test]
    fn reads_and_validates_a_managed_installation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sha = "a".repeat(64);
        fixture(root, CURRENT_LAUNCHER, "0.2.0", &sha);
        let installation = read_installation(root, CURRENT_LAUNCHER).unwrap();
        assert_eq!(installation.version(), "0.2.0");
        assert_eq!(installation.base_url, "https://example.com");
        assert!(installation
            .executable()
            .ends_with("releases/0.2.0-linux-x64-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/prime-agent"));
        assert_eq!(installation.target.platform, "linux-x64");
    }

    #[test]
    fn rejects_a_damaged_release() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sha = "b".repeat(64);
        fixture(root, CURRENT_LAUNCHER, "0.2.0", &sha);
        let release_dir = root.join("releases").join(format!("0.2.0-linux-x64-{sha}"));
        std::fs::remove_file(release_dir.join("README.md")).unwrap();
        assert!(read_installation(root, CURRENT_LAUNCHER).is_err());
    }

    #[test]
    fn activation_state_wins_over_the_bare_previous_link() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let old_sha = "c".repeat(64);
        let new_sha = "d".repeat(64);
        fixture(root, PREVIOUS_LAUNCHER, "0.1.0", &old_sha);
        fixture(root, CURRENT_LAUNCHER, "0.2.0", &new_sha);
        std::fs::write(
            root.join(".activation-state"),
            format!(
                "../releases/0.2.0-linux-x64-{new_sha}/prime-agent\n../releases/0.1.0-linux-x64-{old_sha}/prime-agent\n"
            ),
        )
        .unwrap();
        let rollback = read_rollback_installation(root).unwrap();
        assert_eq!(rollback.version(), "0.1.0");
    }

    #[test]
    fn rollback_without_state_uses_the_previous_link() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let old_sha = "e".repeat(64);
        fixture(root, PREVIOUS_LAUNCHER, "0.1.0", &old_sha);
        let rollback = read_rollback_installation(root).unwrap();
        assert_eq!(rollback.version(), "0.1.0");
    }

    #[test]
    fn anchors_the_running_release_directory() {
        let dir = tempfile::tempdir().unwrap();
        let release = format!("0.1.0-linux-x64-{}", "a".repeat(64));
        let release_dir = dir.path().join(&release);
        std::fs::create_dir_all(&release_dir).unwrap();
        let exe = release_dir.join("prime-agent");
        std::fs::write(&exe, "binary").unwrap();
        let running = running_release(&exe).unwrap();
        assert_eq!(running.version, "0.1.0");
        assert_eq!(running.release_dir, release_dir);
        // A hand-named dogfood directory is not a managed release name.
        let dogfood = dir.path().join("0.10.0-rust-64f66e3d");
        std::fs::create_dir_all(&dogfood).unwrap();
        let stray = dogfood.join("prime-agent");
        std::fs::write(&stray, "binary").unwrap();
        assert!(running_release(&stray).is_err());
    }

    #[test]
    fn install_sources_must_be_http() {
        assert!(install_source_is_valid("https://example.com"));
        assert!(install_source_is_valid(" http://example.com "));
        assert!(!install_source_is_valid("file:///tmp/payload"));
        assert!(!install_source_is_valid("example.com"));
    }

    #[test]
    fn parses_release_link_shapes_only() {
        assert!(parse_release_link(Path::new(
            "../releases/1.2.3-linux-x64-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/prime-agent"
        ))
        .is_some());
        assert!(
            parse_release_link(Path::new("../releases/1.2.3-other-thing/prime-agent")).is_none()
        );
        assert!(parse_release_link(Path::new("/opt/somewhere/else/prime-agent")).is_none());
        assert!(
            parse_release_link(Path::new("../releases/1.2.3-linux-x64-short/prime-agent"))
                .is_none()
        );
    }
}
