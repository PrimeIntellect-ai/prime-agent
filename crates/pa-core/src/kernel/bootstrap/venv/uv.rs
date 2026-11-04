//! The uv discovery concern: the PATH/PATHEXT executable search and the `ensure_uv` resolution.

use super::{anyhow, home_dir, Path, PathBuf};
use std::ffi::OsStr;

const UV_INSTALL_COMMAND: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";

fn find_executable(name: &str, path_value: &OsStr, project: Option<&Path>) -> Option<PathBuf> {
    // The bare name on Unix; PATHEXT extension candidates on Windows
    // (TS `findExecutable` -> `windowsExecutableCandidates`).
    #[cfg(windows)]
    let candidates = windows_executable_candidates(name, std::env::var("PATHEXT").ok().as_deref());
    #[cfg(not(windows))]
    let candidates = vec![name.to_string()];
    for dir in std::env::split_paths(path_value) {
        // A relative PATH entry or one overlapping the repository can select
        // a checked-in executable before any user action.
        if !crate::kernel::python_env::safe_path(&dir, project) {
            continue;
        }
        for candidate in &candidates {
            let full_path = dir.join(candidate);
            if crate::kernel::python_env::safe_path(&full_path, project)
                && full_path.is_file()
                && is_executable(&full_path)
            {
                return Some(full_path);
            }
        }
    }
    None
}

/// The extension order `windowsExecutableCandidates` uses when `PATHEXT`
/// yields nothing usable.
#[cfg(any(windows, test))]
const WINDOWS_PATHEXT_DEFAULT: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// The bare name followed by the supported PATHEXT extensions, in `PATHEXT` order, else the TS
/// default order. A name that already ends in a default extension is never suffixed again.
#[cfg(any(windows, test))]
pub(super) fn windows_executable_candidates(name: &str, pathext: Option<&str>) -> Vec<String> {
    let extensions = pathext
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|ext| {
            WINDOWS_PATHEXT_DEFAULT
                .iter()
                .any(|default| default.eq_ignore_ascii_case(ext))
        })
        .collect::<Vec<_>>();
    let lower_name = name.to_lowercase();
    if WINDOWS_PATHEXT_DEFAULT
        .iter()
        .any(|ext| lower_name.ends_with(&ext.to_lowercase()))
    {
        return vec![name.to_string()];
    }
    let defaults: Vec<String> = WINDOWS_PATHEXT_DEFAULT
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    let source: &[String] = if extensions.is_empty() {
        &defaults
    } else {
        &extensions
    };
    let mut seen = std::collections::HashSet::from([lower_name]);
    let mut candidates = vec![name.to_string()];
    for ext in source {
        let candidate = format!("{name}{ext}");
        if seen.insert(candidate.to_lowercase()) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn is_executable(path: &Path) -> bool {
    crate::platform::perms::is_executable(path)
}

/// Find `uv` on PATH or at `~/.local/bin/uv` (`uv.exe` on Windows). Returns `Err` with install
/// guidance when missing: the Rust binary never auto-installs.
pub(crate) fn ensure_uv(project: Option<&Path>) -> anyhow::Result<String> {
    if let Some(from_path) =
        std::env::var_os("PATH").and_then(|path| find_executable("uv", &path, project))
    {
        return Ok(from_path.to_string_lossy().to_string());
    }
    let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let local_uv = home_dir().join(".local").join("bin").join(uv_name);
    if crate::kernel::python_env::safe_path(&local_uv, project) && is_executable(&local_uv) {
        return Ok(local_uv.to_string_lossy().to_string());
    }
    Err(anyhow!(
        "uv is required to set up the Python kernel. Install uv yourself: {UV_INSTALL_COMMAND}"
    ))
}

#[cfg(all(test, unix))]
mod safe_uv_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn uv_search_skips_repository_and_relative_path_entries() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let alias = root.path().join("alias");
        let trusted = root.path().join("trusted");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&alias).unwrap();
        std::fs::create_dir_all(&trusted).unwrap();
        for path in [project.join("uv"), trusted.join("uv")] {
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        symlink(project.join("uv"), alias.join("uv")).unwrap();
        let path = std::env::join_paths([Path::new("."), &project, &alias, &trusted]).unwrap();
        assert_eq!(
            find_executable("uv", &path, Some(&project)),
            Some(trusted.join("uv"))
        );
    }
}
