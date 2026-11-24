//! The venv dir-layout concern: the override-aware
//! kernel venv dir, the writable-dir fallback, the interpreter path, and the
//! retired `.stale-*` copy held beside the venv during a swap.

use super::{anyhow, Context, Path, PathBuf};

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

pub(super) fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Directory of the kernel venv, honoring `PRIME_AGENT_KERNEL_VENV`.
#[must_use]
pub fn kernel_venv_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PRIME_AGENT_KERNEL_VENV") {
        if !override_dir.is_empty() {
            return expand_home(&override_dir);
        }
    }
    home_kernel_venv_dir(&home_dir())
}

/// The default kernel venv under `home`, used when no override is set.
pub(crate) fn home_kernel_venv_dir(home: &Path) -> PathBuf {
    home.join(".prime").join("agent").join("kernel-venv")
}

fn unix_ms(time: std::time::SystemTime) -> u128 {
    time.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Move the venv at `venv` to `<venv>.stale-<unix-ms>` beside it.
///
/// The retired copy covers the swap's crash window: if the process dies
/// before the new venv is in place, the next lock holder renames it back. A
/// failed rename leaves `venv` untouched.
pub(crate) fn retire_venv(venv: &Path) -> anyhow::Result<PathBuf> {
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let retired = venv.with_file_name(format!(
        "{name}.stale-{}",
        unix_ms(std::time::SystemTime::now())
    ));
    crate::platform::rename_onto(venv, &retired)
        .with_context(|| format!("moving {} to {}", venv.display(), retired.display()))?;
    Ok(retired)
}

/// The retired `<venv>.stale-<unix-ms>` copies beside `venv`, newest first.
/// An entry whose stamp does not parse is not a retired copy.
pub(crate) fn retired_venvs(venv: &Path) -> Vec<(u128, PathBuf)> {
    let parent = venv.parent().unwrap_or(Path::new("/"));
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let prefix = format!("{name}.stale-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut retired: Vec<(u128, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let stamp = entry
                .file_name()
                .to_string_lossy()
                .strip_prefix(&prefix)?
                .parse()
                .ok()?;
            Some((stamp, entry.path()))
        })
        .collect();
    retired.sort_by(|a, b| b.cmp(a));
    retired
}

/// Best-effort removal of every retired copy once a complete venv is live;
/// never fails the caller. A copy that cannot be removed now, for example
/// while a kernel still runs from it on Windows, is retried by the next swap.
pub(crate) fn remove_retired_venvs(venv: &Path) {
    for (_, path) in retired_venvs(venv) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

fn xdg_kernel_venv_dir() -> PathBuf {
    let data_home = match std::env::var("XDG_DATA_HOME") {
        Ok(value) if !value.is_empty() => expand_home(&value),
        _ => home_dir().join(".local").join("share"),
    };
    data_home.join("prime").join("agent").join("kernel-venv")
}

pub(crate) fn resolve_writable_kernel_venv_dir() -> anyhow::Result<PathBuf> {
    let primary = kernel_venv_dir();
    if std::fs::create_dir_all(primary.parent().unwrap_or(Path::new("/"))).is_ok() {
        return Ok(primary);
    }
    if std::env::var("PRIME_AGENT_KERNEL_VENV").is_ok_and(|v| !v.is_empty()) {
        return Err(anyhow!(
            "couldn't create kernel venv parent directories for {}",
            primary.display()
        ));
    }
    let fallback = xdg_kernel_venv_dir();
    if std::fs::create_dir_all(fallback.parent().unwrap_or(Path::new("/"))).is_err() {
        return Err(anyhow!(
            "couldn't create kernel venv directory at {} or {}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed",
            primary.display(),
            fallback.display()
        ));
    }
    Ok(fallback)
}

/// Path of the venv's python interpreter.
#[must_use]
pub fn kernel_venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}
