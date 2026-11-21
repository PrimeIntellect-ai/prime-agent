//! The venv dir-layout concern: the override-aware
//! kernel venv dir, the writable-dir fallback, the interpreter path, and the
//! retired `.stale-*` copy kept beside the venv.

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

/// Move a venv built for another runtime to `<venv>.stale-<unix-ms>` beside it,
/// then remove every other `<venv>.stale-*` sibling, so only the newest retired
/// copy stays on disk.
///
/// A bootstrap never deletes the venv it replaces: the caller may be a worktree
/// binary or an older install whose runtime differs from the one the user's
/// sessions run, and the retired copy can be renamed back.
pub(crate) fn retire_stale_venv(venv: &Path) -> anyhow::Result<PathBuf> {
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let prefix = format!("{name}.stale-");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let retired = venv.with_file_name(format!("{prefix}{stamp}"));
    std::fs::rename(venv, &retired)
        .with_context(|| format!("moving {} to {}", venv.display(), retired.display()))?;
    let parent = venv.parent().unwrap_or(Path::new("/"));
    for entry in std::fs::read_dir(parent)?.flatten() {
        let path = entry.path();
        if path != retired && entry.file_name().to_string_lossy().starts_with(&prefix) {
            std::fs::remove_dir_all(&path)
                .with_context(|| format!("removing older {}", path.display()))?;
        }
    }
    Ok(retired)
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
