//! The runtime source concern: the packaged
//! sidecar layout, the source-checkout fallback, and the content identity
//! that invalidates an existing venv on any runtime change.

use super::{expand_home, Digest, Path, PathBuf, RUNTIME_REQUIREMENT};

/// Directory of the installed `prime-agent-runtime` sources. The Rust binary ships the same sidecar
/// layout the compiled TS executable uses.
pub(in crate::kernel::bootstrap) fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_home(&env_dir);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir
}

/// The packaged sidecar directory (the exe-adjacent layout): the TS `runtimeCandidateDirs`
/// bun-binary candidates.
pub(in crate::kernel::bootstrap) fn packaged_runtime_dir() -> Option<PathBuf> {
    let package = package_dir();
    [
        package.join("prime-agent-runtime"),
        package.join("dist").join("prime-agent-runtime"),
    ]
    .into_iter()
    .find(|candidate| candidate.join("pyproject.toml").exists())
}

fn runtime_candidate_dirs() -> Vec<PathBuf> {
    let mut candidates = packaged_runtime_dir().into_iter().collect::<Vec<_>>();
    // Source checkouts keep the sidecar at the workspace root (TS resolves
    // module-relative monorepo candidates the same way).
    if let Some(root) = crate::packages::source_checkout_root() {
        candidates.push(root.join("prime-agent-runtime"));
    }
    candidates
}

pub(super) fn resolve_runtime_source_dir() -> Option<PathBuf> {
    runtime_candidate_dirs()
        .into_iter()
        .find(|candidate| candidate.join("pyproject.toml").exists())
}

/// Content identity of the runtime: a hash of every `rlm/*.py` file, the
/// packaged machine library under `src/rlm/machines` (wheel package data:
/// machine changes are runtime changes), and `pyproject.toml`, so any
/// runtime change invalidates an existing venv. Falls back to the bare
/// package name when the runtime resolves to a registry install (no local
/// source).
///
/// # Panics
///
/// Panics when hashing the resolved local runtime source fails.
#[must_use]
pub fn resolve_runtime_identity() -> String {
    let Some(source_dir) = resolve_runtime_source_dir() else {
        return RUNTIME_REQUIREMENT.to_string();
    };
    hash_runtime_source(&source_dir).unwrap_or_else(|error| {
        panic!(
            "cannot hash runtime source at {}: {error}",
            source_dir.display()
        )
    })
}

fn hash_runtime_source(source_dir: &Path) -> anyhow::Result<String> {
    let rlm_dir = source_dir.join("src").join("rlm");
    let mut files = vec![source_dir.join("pyproject.toml")];
    collect_python_files(&rlm_dir, &mut files)?;
    collect_package_data_files(&rlm_dir.join("machines"), &mut files)?;
    files.sort();
    let mut hasher = sha2::Sha256::new();
    for file in &files {
        let relative = file.strip_prefix(source_dir)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(&std::fs::read(file)?);
        hasher.update([0]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

pub(super) fn collect_python_files(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_python_files(&path, files)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("py") {
            files.push(path);
        }
    }
    Ok(())
}

/// Collect every file under the packaged machine library (`src/rlm/machines`,
/// any extension: the wheel ships the MACHINE.md files as package data), so
/// machine changes invalidate an existing venv exactly like a `.py` change.
fn collect_package_data_files(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if !dir.is_dir() {
        return Ok(()); // a runtime payload without a machine library is legal
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_package_data_files(&path, files)?;
        } else {
            files.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_fixture(temp: &std::path::Path, machine_body: &str) -> anyhow::Result<()> {
        let rlm = temp.join("src").join("rlm");
        std::fs::create_dir_all(&rlm)?;
        std::fs::write(
            rlm.join("factory.py"),
            "X = 1
",
        )?;
        let machines = rlm.join("machines").join("review-sweep");
        std::fs::create_dir_all(&machines)?;
        std::fs::write(machines.join("MACHINE.md"), machine_body)?;
        std::fs::write(
            temp.join("pyproject.toml"),
            "[project]
",
        )?;
        Ok(())
    }

    #[test]
    fn machine_library_changes_invalidate_the_runtime_identity() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        runtime_fixture(
            temp.path(),
            "---
name: review-sweep
",
        )?;
        let before = hash_runtime_source(temp.path())?;
        runtime_fixture(
            temp.path(),
            "---
name: review-sweep
version: 2
",
        )?;
        let after = hash_runtime_source(temp.path())?;
        assert_ne!(before, after, "a machine file change is a runtime change");

        // A runtime without the machine library still hashes cleanly.
        std::fs::remove_dir_all(temp.path().join("src").join("rlm").join("machines"))?;
        let bare = hash_runtime_source(temp.path())?;
        assert_ne!(bare, after);
        Ok(())
    }
}
