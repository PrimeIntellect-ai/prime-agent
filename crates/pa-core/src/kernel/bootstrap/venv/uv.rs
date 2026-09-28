//! The uv discovery concern (moved with its concern): the PATH/PATHEXT
//! executable search and the `ensure_uv` resolution with its install
//! guidance.

use super::*;

const UV_INSTALL_COMMAND: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";

fn find_executable(name: &str) -> Option<PathBuf> {
    let path_value = std::env::var("PATH").ok()?;
    // The bare name on Unix; PATHEXT extension candidates on Windows
    // (TS `findExecutable` -> `windowsExecutableCandidates`).
    #[cfg(windows)]
    let candidates = windows_executable_candidates(name, std::env::var("PATHEXT").ok().as_deref());
    #[cfg(not(windows))]
    let candidates = vec![name.to_string()];
    for dir in std::env::split_paths(&path_value) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in &candidates {
            let full_path = dir.join(candidate);
            if full_path.is_file() && is_executable(&full_path) {
                return Some(full_path);
            }
        }
    }
    None
}

/// TS `WINDOWS_PATHEXT_DEFAULT`: the extension order `windowsExecutableCandidates`
/// uses when `PATHEXT` yields nothing usable.
#[cfg(any(windows, test))]
const WINDOWS_PATHEXT_DEFAULT: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// The bare name followed by the supported PATHEXT extensions, in
/// `PATHEXT` order when it yields supported extensions, else the TS default
/// order. A name that already ends in a default extension is never suffixed
/// again (TS `windowsExecutableCandidates` verbatim).
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

/// Find `uv` on PATH or at `~/.local/bin/uv` (`uv.exe` on Windows). Returns
/// `Err` with install guidance when missing: the Rust binary never
/// auto-installs (the TS interactive confirm belongs to the CLI layer).
pub(crate) fn ensure_uv() -> anyhow::Result<String> {
    if let Some(from_path) = find_executable("uv") {
        return Ok(from_path.to_string_lossy().to_string());
    }
    let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let local_uv = home_dir().join(".local").join("bin").join(uv_name);
    if is_executable(&local_uv) {
        return Ok(local_uv.to_string_lossy().to_string());
    }
    Err(anyhow!(
        "uv is required to set up the Python kernel. Install uv yourself: {UV_INSTALL_COMMAND}"
    ))
}
