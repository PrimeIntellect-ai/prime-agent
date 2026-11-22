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

/// Move a venv built for another runtime to `<venv>.stale-<unix-ms>` beside it.
///
/// A bootstrap never deletes the venv it replaces: the caller may be a worktree
/// binary or an older install whose runtime differs from the one the user's
/// sessions run, and the retired copy can be renamed back.
///
/// What stays on disk: the copy this call just retired, PLUS the newest
/// `STALE_VENV_KEEP` (two) earlier retired copies - up to three. That gap is
/// the recovery guarantee: after an interrupted rebuild the newest copy is the
/// partial tree, and the previous complete venv is the one before it. Anything
/// older is pruned only past `STALE_VENV_RETENTION`, best-effort and never
/// fatal.
pub(crate) fn retire_stale_venv(venv: &Path) -> anyhow::Result<PathBuf> {
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let prefix = format!("{name}.stale-");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let retired = venv.with_file_name(format!("{prefix}{stamp}"));
    // Rename FIRST: it is the only step that can fail, and a failure here must
    // leave the live path untouched. An earlier version pruned before renaming,
    // which could delete the last good copy after an interrupted rebuild.
    crate::platform::rename_onto(venv, &retired)
        .with_context(|| format!("moving {} to {}", venv.display(), retired.display()))?;
    // Then prune stale copies that are OLD, best-effort and never fatal. The
    // rename already freed the live path, so a copy that cannot be removed now
    // is simply retried later. Age, not recency, decides: after an interrupted
    // rebuild the newest stale copy may be the PARTIAL tree while an older one
    // is the last good venv, so nothing recent is ever a prune candidate.
    prune_old_stale_copies(venv, &prefix, &retired);
    Ok(retired)
}

/// How old a `kernel-venv.stale-*` copy must be before it is even a prune
/// candidate. A failed rebuild is rare and each leaves one copy, so this is
/// bounded in practice while a recent copy stays available as recovery.
pub(crate) const STALE_VENV_RETENTION: std::time::Duration =
    std::time::Duration::from_hours(7 * 24);

/// How many retired copies are always kept, newest first. Two, so that an
/// interrupted rebuild - whose newest copy is the PARTIAL tree - always leaves
/// the previous complete venv recoverable.
pub(crate) const STALE_VENV_KEEP: usize = 2;

/// Remove `kernel-venv.stale-*` siblings that are both past
/// [`STALE_VENV_RETENTION`] and beyond the newest [`STALE_VENV_KEEP`] copies,
/// never the copy this call just retired, and never failing the caller.
///
/// The name carries a unix-millisecond stamp, so a name sort is a time sort.
fn prune_old_stale_copies(venv: &Path, prefix: &str, keep: &Path) {
    let parent = venv.parent().unwrap_or(Path::new("/"));
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut candidates: Vec<(String, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (entry.path() != keep && name.starts_with(prefix)).then(|| (name, entry.path()))
        })
        .collect();
    candidates.sort();
    // Newest first; the newest STALE_VENV_KEEP are never pruned.
    candidates.reverse();
    let now = std::time::SystemTime::now();
    for (_name, path) in candidates.into_iter().skip(STALE_VENV_KEEP) {
        let old = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_VENV_RETENTION);
        if old {
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
