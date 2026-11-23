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

/// How long a retired `<venv>.stale-<unix-ms>` copy is kept before it can be
/// pruned. Age is counted from the stamp in the name, the moment of retirement.
pub(crate) const STALE_VENV_RETENTION: std::time::Duration =
    std::time::Duration::from_hours(7 * 24);

/// How many earlier retired copies are always kept beside the one just
/// retired, newest first. With the just-retired copy, up to three survive.
pub(crate) const STALE_VENV_KEEP: usize = 2;

fn unix_ms(time: std::time::SystemTime) -> u128 {
    time.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Move the venv at `venv` to `<venv>.stale-<unix-ms>` beside it.
///
/// A rebuild never deletes the venv it replaces: the caller may be a worktree
/// binary or an older install whose runtime differs from the one the user's
/// sessions run, and the retired copy can be renamed back. A failed rename
/// leaves `venv` untouched.
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

/// Best-effort removal of old retired copies; never fails the caller.
///
/// Kept: `just_retired`, plus the newest [`STALE_VENV_KEEP`] earlier copies.
/// Any other copy is removed only when it is older than
/// [`STALE_VENV_RETENTION`]. A copy that cannot be removed now is retried by
/// the next rebuild.
pub(crate) fn prune_retired_venvs(venv: &Path, just_retired: &Path) {
    let now = unix_ms(std::time::SystemTime::now());
    for (stamp, path) in retired_venvs(venv)
        .into_iter()
        .filter(|(_, path)| path != just_retired)
        .skip(STALE_VENV_KEEP)
    {
        if now.saturating_sub(stamp) > STALE_VENV_RETENTION.as_millis() {
            let _ = std::fs::remove_dir_all(&path);
        }
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
