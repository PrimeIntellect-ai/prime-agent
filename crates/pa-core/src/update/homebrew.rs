//! Detect Homebrew-owned Prime Agent binaries before the installer update funnel.
//! Homebrew links `<prefix>/bin/prime-agent` into a Cellar formula or a
//! Caskroom cask: resolving the executable symlink is load-bearing because
//! checking only the invoked `bin` path would miss both managed installs.

use std::ffi::OsStr;
use std::path::Path;

/// The Homebrew package layout that owns the running binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomebrewKind {
    /// A formula keg under `Cellar/prime-agent`.
    Formula,
    /// A cask version under `Caskroom/prime-agent`.
    Cask,
}

impl HomebrewKind {
    /// The fixed telemetry vocabulary for this Homebrew layout.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Formula => "formula",
            Self::Cask => "cask",
        }
    }
}

/// Resolve the executable and identify a Homebrew-managed ancestor pair.
/// Unresolvable paths and unrelated install layouts are not Homebrew-owned.
#[must_use]
pub fn managed_kind(executable: &Path) -> Option<HomebrewKind> {
    let resolved = executable.canonicalize().ok()?;
    for ancestor in resolved.ancestors() {
        if ancestor.file_name() != Some(OsStr::new("prime-agent")) {
            continue;
        }
        let owner = ancestor.parent().and_then(Path::file_name);
        if owner == Some(OsStr::new("Cellar")) {
            return Some(HomebrewKind::Formula);
        }
        if owner == Some(OsStr::new("Caskroom")) {
            return Some(HomebrewKind::Cask);
        }
    }
    None
}

/// The package-manager command to print instead of attempting self-update.
#[must_use]
pub fn upgrade_instruction(kind: HomebrewKind) -> String {
    match kind {
        HomebrewKind::Formula => "Update with: brew upgrade prime-agent".to_string(),
        HomebrewKind::Cask => "Update with: brew upgrade --cask prime-agent".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formula_and_cask_layouts() {
        let root = tempfile::tempdir().unwrap();
        let formula = root
            .path()
            .join("Cellar/prime-agent/1.0.0/libexec/prime-agent");
        let cask = root.path().join("Caskroom/prime-agent/1.0.0/prime-agent");
        std::fs::create_dir_all(formula.parent().unwrap()).unwrap();
        std::fs::create_dir_all(cask.parent().unwrap()).unwrap();
        std::fs::write(&formula, b"binary").unwrap();
        std::fs::write(&cask, b"binary").unwrap();
        assert_eq!(managed_kind(&formula), Some(HomebrewKind::Formula));
        assert_eq!(managed_kind(&cask), Some(HomebrewKind::Cask));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_brew_bin_symlinks_into_the_formula_keg() {
        let root = tempfile::tempdir().unwrap();
        let formula = root
            .path()
            .join("Cellar/prime-agent/1.0.0/libexec/prime-agent");
        let launcher = root.path().join("bin/prime-agent");
        std::fs::create_dir_all(formula.parent().unwrap()).unwrap();
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        std::fs::write(&formula, b"binary").unwrap();
        std::os::unix::fs::symlink(&formula, &launcher).unwrap();
        assert_eq!(managed_kind(&launcher), Some(HomebrewKind::Formula));
    }

    #[test]
    fn ignores_other_kegs_and_non_homebrew_installs() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "Cellar/other-tool/1.0.0/libexec/prime-agent",
            "releases/1.0.0-darwin-arm64-abc123/prime-agent",
            "plain/prime-agent",
        ] {
            let executable = root.path().join(path);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, b"binary").unwrap();
            assert_eq!(managed_kind(&executable), None);
        }
    }
}
