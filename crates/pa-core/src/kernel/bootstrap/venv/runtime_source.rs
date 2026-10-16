//! The runtime source concern: the packaged
//! sidecar layout, the source-checkout fallback, and the content identity
//! that invalidates an existing venv on any runtime change.

use super::{expand_home, Digest, Path, PathBuf};
use anyhow::Context;

/// Directory of the installed `prime-agent-runtime` sources. The Rust binary ships the same sidecar
/// layout the compiled TS executable uses.
pub(in crate::kernel::bootstrap) fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_home(&env_dir);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| crate::packages::exe_dir_of(&exe))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The packaged sidecar directory (the exe-adjacent layout): the TS `runtimeCandidateDirs`
/// bun-binary candidates.
pub(in crate::kernel::bootstrap) fn packaged_runtime_dir() -> Option<PathBuf> {
    resolve_runtime_source_dir(&package_dir(), None)
}

fn resolve_runtime_source_dir(package: &Path, checkout: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = vec![
        package.join("prime-agent-runtime"),
        package.join("dist").join("prime-agent-runtime"),
    ];
    // Source checkouts keep the sidecar at the workspace root (TS resolves
    // module-relative monorepo candidates the same way).
    if let Some(root) = checkout {
        candidates.push(root.join("prime-agent-runtime"));
    }
    candidates.into_iter().find_map(|candidate| {
        // Always pass an absolute filesystem path to uv, including when
        // PI_PACKAGE_DIR was relative. A manifest alone is not a runtime.
        let candidate = candidate.canonicalize().ok()?;
        if !["pyproject.toml", "src/rlm/__init__.py", "src/rlm/repl.py"]
            .iter()
            .all(|file| candidate.join(file).is_file())
        {
            return None;
        }
        let manifest = std::fs::read_to_string(candidate.join("pyproject.toml")).ok()?;
        let manifest: toml::Value = toml::from_str(&manifest).ok()?;
        (manifest.get("project")?.get("name")?.as_str()? == "prime-agent-runtime")
            .then_some(candidate)
    })
}

pub(in crate::kernel::bootstrap) fn require_runtime_source_dir() -> anyhow::Result<PathBuf> {
    resolve_runtime_source_dir(&package_dir(), crate::packages::source_checkout_root()).context(
        "Prime Agent requires a local prime-agent-runtime directory containing its pyproject.toml and src/rlm sources; reinstall Prime Agent with the runtime beside the binary, or set PI_PACKAGE_DIR to the complete trusted package directory. The runtime will not be downloaded from a package index.",
    )
}

/// Hash the manifest, Python sources, and packaged machine library so any
/// runtime change invalidates an existing venv.
pub(in crate::kernel::bootstrap) fn hash_runtime_source(
    source_dir: &Path,
) -> anyhow::Result<String> {
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
        std::fs::write(rlm.join("__init__.py"), "")?;
        std::fs::write(rlm.join("repl.py"), "")?;
        let machines = rlm.join("machines").join("review-sweep");
        std::fs::create_dir_all(&machines)?;
        std::fs::write(machines.join("MACHINE.md"), machine_body)?;
        std::fs::write(
            temp.join("pyproject.toml"),
            "[project]\nname = 'prime-agent-runtime'\n",
        )?;
        Ok(())
    }

    #[test]
    fn missing_or_incomplete_runtime_sources_are_not_resolved() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let package = temp.path();
        assert_eq!(resolve_runtime_source_dir(package, None), None);
        let runtime = package.join("prime-agent-runtime");
        runtime_fixture(&runtime, "machine")?;
        for file in ["pyproject.toml", "src/rlm/__init__.py", "src/rlm/repl.py"] {
            let path = runtime.join(file);
            let contents = std::fs::read(&path)?;
            std::fs::remove_file(&path)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
            // A directory with the expected file name is also invalid.
            std::fs::create_dir(&path)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
            std::fs::remove_dir(&path)?;
            std::fs::write(&path, contents)?;
        }
        for manifest in ["not toml", "[project]", "[project]\nname = 'other'"] {
            std::fs::write(runtime.join("pyproject.toml"), manifest)?;
            assert_eq!(resolve_runtime_source_dir(package, None), None);
        }
        Ok(())
    }

    #[test]
    fn packaged_dist_and_checkout_sources_resolve_to_absolute_paths() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let package = temp.path().join("package");
        let checkout = temp.path().join("checkout");
        let direct = package.join("prime-agent-runtime");
        let dist = package.join("dist/prime-agent-runtime");
        let source = checkout.join("prime-agent-runtime");
        for runtime in [&source, &dist, &direct] {
            runtime_fixture(runtime, "machine")?;
            assert_eq!(
                resolve_runtime_source_dir(&package, Some(&checkout)),
                Some(runtime.canonicalize()?)
            );
        }
        // An incomplete first candidate must not hide a valid dist payload.
        std::fs::remove_file(direct.join("src/rlm/repl.py"))?;
        assert_eq!(
            resolve_runtime_source_dir(&package, Some(&checkout)),
            Some(dist.canonicalize()?)
        );
        Ok(())
    }

    #[test]
    fn relative_package_paths_are_never_returned_as_requirements() -> anyhow::Result<()> {
        let cwd = std::env::current_dir()?;
        let temp = tempfile::tempdir_in(&cwd)?;
        let runtime = temp.path().join("prime-agent-runtime");
        runtime_fixture(&runtime, "machine")?;
        let relative = temp.path().strip_prefix(&cwd)?;
        assert_eq!(
            resolve_runtime_source_dir(relative, None),
            Some(runtime.canonicalize()?)
        );
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
