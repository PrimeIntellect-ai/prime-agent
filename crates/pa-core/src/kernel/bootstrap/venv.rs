//! Venv discovery, build, lock, and the shared `.bootstrap-version` cache:
//! the machine state behind [`super::ensure_kernel_python`]. The version
//! file is a cross-session cache, not a per-session manifest.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use anyhow::{anyhow, Context};
use sha2::Digest;

use super::{
    default_rlm_extra_uv_args, EnsureKernelPythonOptions, KernelPythonSkill,
    DEFAULT_RLM_EXTRA_PACKAGES,
};

// The concern children (the flows + the shared record stay in the
// composition root).
mod layout;
mod probe;
mod runtime_source;
mod skills;
mod uv;
mod version;

use layout::home_dir;
pub(crate) use layout::{expand_home, resolve_writable_kernel_venv_dir};
pub use layout::{kernel_venv_dir, kernel_venv_python};
pub use probe::invalidate_runtime_probe_cache;
#[cfg(test)]
use probe::{installed_rlm_dir, lock_probe_memo, runtime_probe_key};
// The memo-clear helper and the live-probe package-dir walk exist only behind
// the unix tests (see their gates in probe.rs and tests.rs).
#[cfg(all(test, unix))]
use probe::{clear_in_process_probe_memo_for_tests, installed_package_dir};
pub(crate) use probe::{
    has_prime_agent_runtime, missing_python_skill_import_labels, missing_rlm_extra_import_labels,
};
use probe::{has_prime_agent_runtime_memoized, installed_runtime_identity};
use runtime_source::collect_python_files;
pub(super) use runtime_source::{hash_runtime_source, require_runtime_source_dir};
pub(super) use runtime_source::{package_dir, packaged_runtime_dir};
#[cfg(test)]
use skills::{file_content_hash, read_python_skill_dependency_names};
use skills::{normalize_project_name, read_python_skill_project_name};
pub(crate) use skills::{normalize_python_skills, BootstrapPythonSkill};
pub(crate) use uv::ensure_uv;
#[cfg(test)]
use uv::windows_executable_candidates;
use version::{
    bootstrap_base_version_current, bootstrap_skill_key, bootstrap_version_current,
    read_bootstrap_version, read_bootstrap_version_raw, write_bootstrap_version,
    STATE_SNAPSHOT_REQUIREMENT,
};
#[cfg(test)]
use version::{recorded_skills_cover, BOOTSTRAP_SCHEMA};

const PYTHON_VERSION: &str = "3.11";
pub(crate) struct UvCommand<'a> {
    pub(super) executable: &'a str,
    pub(super) project: Option<&'a Path>,
}
pub(crate) const BOOTSTRAP_LOCK_NAME: &str = ".bootstrap.lock";
pub(crate) const BOOTSTRAP_LOCK_RETRY_MS: u64 = 100;
pub(crate) const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS: u64 = 30_000;
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct BootstrapVersion {
    schema: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra_uv_args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    python_skills: Option<Vec<BootstrapPythonSkill>>,
}

async fn run_async(command: &str, args: &[String], project: Option<&Path>) -> anyhow::Result<()> {
    // Run on a blocking thread: the bootstrap is an IO-bound child process.
    let command = command.to_string();
    let args = args.to_vec();
    let project = project.map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new(&command);
        // uv otherwise discovers uv.toml/pyproject.toml from the process cwd,
        // which may be the repository opened before the first prompt.
        child.arg("--no-config").args(&args).stdin(Stdio::null());
        let mut env = crate::kernel::python_env::inherited_python_env();
        crate::kernel::python_env::sanitize_uv_path(&mut env, project.as_deref());
        child.env_clear().envs(env);
        // Hidden window on Windows (TS `spawnHidden`).
        crate::platform::process::set_no_window(&mut child);
        // CPython must read UTF-8 .pth files even under a Windows legacy
        // code page (TS bootstrap.ts:429).
        if cfg!(windows) {
            child.env("PYTHONUTF8", "1");
        }
        let status = child
            .status()
            .with_context(|| format!("failed to spawn {command}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!(
                "{} {} failed with exit code {}",
                command,
                args.join(" "),
                status.code().unwrap_or(-1)
            ))
        }
    })
    .await
    .map_err(|e| anyhow!("bootstrap task join failed: {e}"))?
}

/// A sibling staging path for a rebuild: the new venv is built here and only
/// then renamed into place, so the live path keeps serving the previous venv
/// for the whole build.
pub(crate) fn venv_candidate_path(venv: &Path) -> PathBuf {
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    venv.with_file_name(format!(
        "{name}.candidate-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// Rewrite the build path out of a finished candidate.
///
/// A venv is path-dependent: `uv` writes the build path into console-script
/// shebangs (`bin/pip`), the activation scripts, and `pyvenv.cfg`. After the
/// swap those entries must name the live path, or every console script fails
/// with "bad interpreter". Only small top-level text entries are touched: the
/// interpreter symlink and installed package payloads are left alone.
fn relocate_venv_paths(candidate: &Path, venv: &Path) -> anyhow::Result<()> {
    let from = candidate.to_string_lossy().to_string();
    let to = venv.to_string_lossy().to_string();
    if from == to {
        return Ok(());
    }
    let mut targets: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(candidate) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_file() && (name.starts_with("activate") || name == "pyvenv.cfg") {
                targets.push(path);
            }
        }
    }
    // POSIX keeps console scripts in `bin`, Windows in `Scripts`.
    for scripts in ["bin", "Scripts"] {
        if let Ok(entries) = std::fs::read_dir(candidate.join(scripts)) {
            for entry in entries.flatten() {
                let path = entry.path();
                // Console scripts are regular files; the interpreter is a symlink.
                if path.is_file() && !path.is_symlink() {
                    targets.push(path);
                }
            }
        }
    }
    for path in targets {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        // Skip binaries and oversized payloads: shebangs and activation
        // scripts are small UTF-8 text.
        if bytes.len() > 1024 * 1024 || bytes.contains(&0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        if !text.contains(&from) {
            continue;
        }
        std::fs::write(&path, text.replace(&from, &to))
            .with_context(|| format!("relocating {}", path.display()))?;
    }
    Ok(())
}

/// Whether a venv has the interpreter and configuration written by `uv venv`.
fn venv_structure_complete(venv: &Path) -> bool {
    kernel_venv_python(venv).exists() && venv.join("pyvenv.cfg").is_file()
}

/// Restore a complete aside left by a process killed during the two-rename swap.
/// The caller holds the bootstrap lock, so no live rebuild owns the aside.
pub(crate) fn recover_interrupted_venv_swap(venv: &Path) -> anyhow::Result<()> {
    let parent = venv.parent().unwrap_or(Path::new("/"));
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let prefix = format!("{name}.old-");
    let mut asides: Vec<_> = std::fs::read_dir(parent)?
        .flatten()
        .filter(|entry| {
            entry.file_name().to_string_lossy().starts_with(&prefix)
                && venv_structure_complete(&entry.path())
        })
        .collect();
    asides.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let Some(aside) = asides.pop() else {
        return Ok(());
    };
    let aside = aside.path();
    if venv.exists() {
        if venv_structure_complete(venv) {
            return Ok(());
        }
        let partial = venv.with_file_name(format!(
            "{name}.partial-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::rename(venv, &partial)
            .with_context(|| format!("moving incomplete {} aside", venv.display()))?;
    }
    std::fs::rename(&aside, venv)
        .with_context(|| format!("restoring {} from {}", venv.display(), aside.display()))?;
    Ok(())
}

/// Move a fully built `candidate` onto the live `venv` path.
///
/// The live path is absent only between the two renames. A killed process can
/// leave the old venv aside in that window; the next lock holder restores it
/// before sweeping staging paths. A failed candidate move restores the old venv
/// immediately, and cleanup never removes the aside until the replacement is
/// structurally complete.
pub(crate) fn swap_venv_into_place(candidate: &Path, venv: &Path) -> anyhow::Result<()> {
    if candidate.exists() && !venv_structure_complete(candidate) {
        anyhow::bail!("candidate venv {} is incomplete", candidate.display());
    }
    relocate_venv_paths(candidate, venv)?;
    if !venv.exists() {
        return std::fs::rename(candidate, venv)
            .with_context(|| format!("moving {} into {}", candidate.display(), venv.display()));
    }
    let name = venv.file_name().unwrap_or_default().to_string_lossy();
    let aside = venv.with_file_name(format!(
        "{name}.old-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(venv, &aside).with_context(|| format!("moving {} aside", venv.display()))?;
    if let Err(error) = std::fs::rename(candidate, venv) {
        // Put the working venv back before reporting the failure. A failed
        // restore must not hide behind the first error: the caller has to know
        // that the live path is now the aside directory, not the old venv.
        if let Err(restore) = std::fs::rename(&aside, venv) {
            return Err(anyhow::anyhow!(
                "moving {} into {} failed ({error:#}), and restoring {} from {} failed too \
                 ({restore:#})",
                candidate.display(),
                venv.display(),
                venv.display(),
                aside.display()
            ));
        }
        return Err(error)
            .with_context(|| format!("moving {} into {}", candidate.display(), venv.display()));
    }
    if !venv_structure_complete(venv) {
        std::fs::remove_dir_all(venv)
            .with_context(|| format!("removing incomplete replacement venv {}", venv.display()))?;
        std::fs::rename(&aside, venv).with_context(|| {
            format!(
                "restoring {} from {} after incomplete replacement",
                venv.display(),
                aside.display()
            )
        })?;
        anyhow::bail!("replacement venv {} is incomplete", venv.display());
    }
    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
}

pub(crate) async fn bootstrap_venv(
    venv: &Path,
    source_dir: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
    project: Option<&Path>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(venv.parent().unwrap_or(Path::new("/")))?;
    let uv = ensure_uv(project)?;
    let uv_command = UvCommand {
        executable: &uv,
        project,
    };
    let python = kernel_venv_python(venv);

    let venv_str = venv.to_string_lossy().to_string();
    let python_str = python.to_string_lossy().to_string();
    let mut install_args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        python_str,
        source_dir.to_string_lossy().to_string(),
    ];
    install_args.push(STATE_SNAPSHOT_REQUIREMENT.to_string());
    for uv_arg in default_rlm_extra_uv_args() {
        install_args.push(uv_arg.to_string());
    }

    run_async(
        uv_command.executable,
        &[
            "python".to_string(),
            "install".to_string(),
            PYTHON_VERSION.to_string(),
        ],
        uv_command.project,
    )
    .await?;
    run_async(
        uv_command.executable,
        &[
            "venv".to_string(),
            venv_str,
            "--python".to_string(),
            PYTHON_VERSION.to_string(),
            // The preceding `uv python install` provisions this runtime.
            // Avoid querying Python executables found on the caller's PATH.
            "--managed-python".to_string(),
            "--seed".to_string(),
        ],
        uv_command.project,
    )
    .await?;
    run_async(uv_command.executable, &install_args, uv_command.project).await?;
    sync_python_skills(
        &uv_command,
        venv,
        &python,
        source_dir,
        runtime_identity,
        python_skills,
        options,
    )
    .await
}

/// True when installing `skill` displaces `existing`'s install. uv replaces
/// distributions by project name and leaves different-named distributions
/// installed side by side, so another package path is displaced in two
/// ways: the same import name stays installed and shadows this skill on
/// sys.path, and the same project name has its code replaced outright.
fn displaces_install(existing: &BootstrapPythonSkill, skill: &BootstrapPythonSkill) -> bool {
    existing.package_path != skill.package_path
        && (existing.import_name == skill.import_name
            || normalize_project_name(&read_python_skill_project_name(existing))
                == normalize_project_name(&read_python_skill_project_name(skill)))
}

/// Install/refresh the editable Python skills recorded in the version file. Only skills missing or
/// changed are installed. Per-skill failures warn and continue.
pub(crate) async fn sync_python_skills(
    uv: &UvCommand<'_>,
    venv: &Path,
    python: &Path,
    source_dir: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    let version = read_bootstrap_version(venv);
    // Previously installed skills still present on disk: their records carry over so
    // sessions with different skill sets share one venv cache.
    let current_python_skills: HashMap<String, BootstrapPythonSkill> = version
        .as_ref()
        .and_then(|v| v.python_skills.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|recorded| Path::new(&recorded.package_path).is_dir())
        .map(|s| (bootstrap_skill_key(&s), s))
        .collect();
    let python_str = python.to_string_lossy().to_string();
    let mut installed: HashMap<String, BootstrapPythonSkill> = current_python_skills;
    let mut missing: Vec<&BootstrapPythonSkill> = Vec::new();
    for skill in python_skills {
        let key = bootstrap_skill_key(skill);
        if installed.get(&key).is_some_and(|existing| {
            existing.pyproject_path == skill.pyproject_path
                && existing.pyproject_hash == skill.pyproject_hash
        }) {
            continue;
        }
        missing.push(skill);
    }
    if !missing.is_empty() {
        // Installing a skill can displace another source's install (see
        // [`displaces_install`]). Drop the displaced records before
        // installing: uv swaps distributions by project name, so a displaced
        // record may describe code this sync replaces, and a record dropped
        // while its code is still installed only costs one redundant
        // reinstall. The same-import distributions from other package paths
        // are NOT replaced by the install, so uninstall them first or their
        // editable install shadows the skill this session selected.
        let mut shadowing: Vec<String> = Vec::new();
        for skill in &missing {
            let skill_project = normalize_project_name(&read_python_skill_project_name(skill));
            installed.retain(|_, existing| {
                if !displaces_install(existing, skill) {
                    return true;
                }
                let existing_project = read_python_skill_project_name(existing);
                if normalize_project_name(&existing_project) != skill_project
                    && !shadowing.contains(&existing_project)
                {
                    shadowing.push(existing_project);
                }
                false
            });
        }
        if !shadowing.is_empty() {
            let mut uninstall_args = vec![
                "pip".to_string(),
                "uninstall".to_string(),
                "--python".to_string(),
                python_str.clone(),
            ];
            uninstall_args.extend(shadowing.iter().cloned());
            if let Err(error) = run_async(uv.executable, &uninstall_args, uv.project).await {
                options.report(&format!(
                    "Warning: failed to uninstall the Python skill distributions this sync replaces ({shadowing:?}): {error}"
                ));
            }
        }
        // One uv invocation installs the whole batch of missing skills: a fresh bootstrap otherwise
        // pays one process plus build-backend startup per install. A batch failure falls back to
        // the per-skill loop.
        let mut install_args = vec![
            "pip".to_string(),
            "install".to_string(),
            "--python".to_string(),
            python_str.clone(),
            // Skills may depend on the runtime too. Keep their resolver
            // pinned to the same local source, including per-skill retries.
            source_dir.to_string_lossy().to_string(),
        ];
        for skill in &missing {
            install_args.push("--editable".to_string());
            install_args.push(skill.package_path.clone());
        }
        if run_async(uv.executable, &install_args, uv.project)
            .await
            .is_ok()
        {
            // A changed pyproject (hash moved) replaces the stale record.
            for skill in &missing {
                installed.insert(bootstrap_skill_key(skill), (*skill).clone());
            }
        } else {
            for skill in &missing {
                let result = run_async(
                    uv.executable,
                    &[
                        "pip".to_string(),
                        "install".to_string(),
                        "--python".to_string(),
                        python_str.clone(),
                        source_dir.to_string_lossy().to_string(),
                        "--editable".to_string(),
                        skill.package_path.clone(),
                    ],
                    uv.project,
                )
                .await;
                match result {
                    Ok(()) => {
                        installed.insert(bootstrap_skill_key(skill), (*skill).clone());
                    }
                    Err(error) => options.report(&format!(
                        "Warning: Python skill {} failed to install and will be unavailable: {error}",
                        skill.import_name
                    )),
                }
            }
        }
    }
    let mut merged: Vec<BootstrapPythonSkill> = installed.into_values().collect();
    merged.sort_by(|a, b| {
        a.package_path
            .cmp(&b.package_path)
            .then(a.import_name.cmp(&b.import_name))
    });
    write_bootstrap_version(venv, runtime_identity, &merged)
}

pub(crate) fn kernel_base_ready(python: &str, venv: &Path, runtime_identity: &str) -> bool {
    let (version, raw) = read_bootstrap_version_raw(venv);
    bootstrap_base_version_current(version, runtime_identity)
        && has_prime_agent_runtime_memoized(
            python,
            runtime_identity,
            &raw,
            &installed_runtime_identity(Path::new(python), venv),
            venv,
        )
}

pub(crate) fn kernel_ready(
    python: &str,
    venv: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
) -> bool {
    let (version, raw) = read_bootstrap_version_raw(venv);
    bootstrap_version_current(version.as_ref(), runtime_identity, python_skills)
        && has_prime_agent_runtime_memoized(
            python,
            runtime_identity,
            &raw,
            &installed_runtime_identity(Path::new(python), venv),
            venv,
        )
}

#[cfg(test)]
mod tests;
