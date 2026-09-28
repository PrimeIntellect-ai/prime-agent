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

// The concern children (cut with their concerns; the flows + the shared
// record stay in the composition root).
mod runtime_source;
mod skills;
mod uv;
mod version;

pub use runtime_source::resolve_runtime_identity;
use runtime_source::{collect_python_files, resolve_runtime_source_dir};
pub(super) use runtime_source::{package_dir, packaged_runtime_dir};
#[cfg(test)]
use skills::{
    file_content_hash, read_python_skill_dependency_names, read_python_skill_project_name,
};
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
const RUNTIME_REQUIREMENT: &str = "prime-agent-runtime";
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

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Directory of the kernel venv, honoring `PRIME_AGENT_KERNEL_VENV`.
pub fn kernel_venv_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PRIME_AGENT_KERNEL_VENV") {
        if !override_dir.is_empty() {
            return expand_home(&override_dir);
        }
    }
    home_dir().join(".prime").join("agent").join("kernel-venv")
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
pub fn kernel_venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

async fn run_async(command: &str, args: &[String]) -> anyhow::Result<()> {
    // Run on a blocking thread: the bootstrap is an IO-bound child process.
    let command = command.to_string();
    let args = args.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new(&command);
        child.args(&args).stdin(Stdio::null());
        // Hidden window on Windows (TS `spawnHidden`).
        crate::platform::process::set_no_window(&mut child);
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

fn python_imports(python: &str, module_name: &str) -> bool {
    run_quiet(python, &["-c", &format!("import {module_name}")])
}

fn run_quiet(command: &str, args: &[&str]) -> bool {
    let mut child = std::process::Command::new(command);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Hidden window on Windows (TS `spawnHidden`).
    crate::platform::process::set_no_window(&mut child);
    matches!(child.status(), Ok(status) if status.success())
}

/// The runtime-ready assertion from the TS product: a current
/// prime-agent-runtime with the callable RLM surface, harness CRUD, bash
/// handles, and protocol version 3.
const RUNTIME_READY_CHECK: &str = "import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ['create_memory', 'update_memory', 'delete_memory', 'create_skill', 'update_skill', 'delete_skill', 'create_subagent', 'update_subagent', 'delete_subagent', 'create_prompt_note', 'update_prompt_note', 'delete_prompt_note', 'record_refinement']; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert callable(rlm.spawn); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm.spawn); assert inspect.signature(rlm.spawn).parameters['name'].default is inspect.Parameter.empty; assert not hasattr(rlm, 'run'); assert not hasattr(rlm.rlm, 'run'); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert callable(rlm.create_session); assert callable(rlm.rlm.create_session); assert callable(rlm.progress_note); assert callable(rlm.rlm.progress_note); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')";

pub(crate) fn has_prime_agent_runtime(python: &str) -> bool {
    run_quiet(python, &["-c", RUNTIME_READY_CHECK])
}

pub(crate) fn missing_rlm_extra_import_labels(python: &str) -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .filter(|(_, import, _)| !python_imports(python, import))
        .map(|(_, _, label)| *label)
        .collect()
}

pub(crate) fn missing_python_skill_import_labels(
    python: &str,
    python_skills: &[KernelPythonSkill],
) -> Vec<String> {
    python_skills
        .iter()
        .filter(|skill| !python_imports(python, &skill.import_name))
        .map(|skill| format!("{} ({})", skill.name, skill.import_name))
        .collect()
}

pub(crate) async fn bootstrap_venv(
    venv: &Path,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(venv.parent().unwrap_or(Path::new("/")))?;
    let uv = ensure_uv()?;
    let python = kernel_venv_python(venv);
    let source_dir = resolve_runtime_source_dir();
    let runtime_requirement = source_dir.as_ref().map_or_else(
        || RUNTIME_REQUIREMENT.to_string(),
        |p| p.to_string_lossy().to_string(),
    );
    let runtime_identity = resolve_runtime_identity();

    let venv_str = venv.to_string_lossy().to_string();
    let python_str = python.to_string_lossy().to_string();
    let mut install_args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        python_str,
        runtime_requirement,
    ];
    install_args.push(STATE_SNAPSHOT_REQUIREMENT.to_string());
    for uv_arg in default_rlm_extra_uv_args() {
        install_args.push(uv_arg.to_string());
    }

    run_async(
        &uv,
        &[
            "python".to_string(),
            "install".to_string(),
            PYTHON_VERSION.to_string(),
        ],
    )
    .await?;
    run_async(
        &uv,
        &[
            "venv".to_string(),
            venv_str,
            "--python".to_string(),
            PYTHON_VERSION.to_string(),
            "--seed".to_string(),
        ],
    )
    .await?;
    run_async(&uv, &install_args).await?;
    sync_python_skills(
        &uv,
        venv,
        &python,
        &runtime_identity,
        python_skills,
        options,
    )
    .await
}

/// Install/refresh the editable Python skills recorded in the version file.
/// The version file is a shared cache, not a per-session manifest: records
/// from other sessions carry over, and only skills missing or changed are
/// installed. Per-skill failures warn and continue: one broken skill must
/// not cost the kernel.
pub(crate) async fn sync_python_skills(
    uv: &str,
    venv: &Path,
    python: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    let version = read_bootstrap_version(venv);
    // Previously installed skills still present on disk: their records carry
    // over so sessions with different skill sets share one venv cache
    // instead of forcing reinstalls of each other's skills. Records for
    // skills whose package path disappeared (a retired release dir, a
    // deleted project) cannot serve a future install and are dropped.
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
        // One uv invocation installs the whole batch of missing skills: a
        // fresh kernel bootstrap otherwise pays one process plus build-backend
        // startup per metadata-only editable install (measured: nine serial
        // installs ~1.9s, one batched invocation ~0.4s, warm uv cache). A
        // batch failure falls back to the per-skill loop so one broken skill
        // still costs only its own warning and never blocks the rest.
        let mut install_args = vec![
            "pip".to_string(),
            "install".to_string(),
            "--python".to_string(),
            python_str.clone(),
        ];
        for skill in &missing {
            install_args.push("--editable".to_string());
            install_args.push(skill.package_path.clone());
        }
        if run_async(uv, &install_args).await.is_ok() {
            // A changed pyproject (hash moved) replaces the stale record.
            for skill in &missing {
                installed.insert(bootstrap_skill_key(skill), (*skill).clone());
            }
        } else {
            for skill in &missing {
                let result = run_async(
                    uv,
                    &[
                        "pip".to_string(),
                        "install".to_string(),
                        "--python".to_string(),
                        python_str.clone(),
                        "--editable".to_string(),
                        skill.package_path.clone(),
                    ],
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

/// Process-global memo of a successful runtime-ready probe, tiered above
/// the cross-process on-disk memo ([`super::disk_memo`]): the probe is a
/// full interpreter start (the `import rlm` chain), and re-running it
/// before every kernel start re-pays a cost the kernel spawn itself is
/// about to pay. Memoized on success only: the key carries every input the
/// probe observes (interpreter identity, runtime identity, the venv's
/// recorded bootstrap state, and the installed runtime's content), so a
/// venv rebuilt by anyone — a newer concurrent daemon rewrites
/// `.bootstrap-version` — or damaged out of band — an uninstalled or
/// overwritten `rlm`, a replaced interpreter — misses both layers and
/// revalidates. A failed kernel start drops both layers
/// ([`invalidate_runtime_probe_cache`]), so the startup retry re-probes
/// and rebuilds exactly like the uncached flow. The in-process map dies
/// with the process; the disk layer carries the verdict to the next fresh
/// worker (every cold open and spawned child boots one) under the same
/// key, so only the interpreter probes are skipped on a hit — the key
/// recomputation above (the content walk) is the damage detector, and it
/// runs on every check.
static RUNTIME_PROBE_MEMO: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

fn lock_probe_memo() -> std::sync::MutexGuard<'static, Option<HashMap<String, PathBuf>>> {
    RUNTIME_PROBE_MEMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Identity of the runtime as installed in the venv — the state the probe
/// observes beyond its key inputs: the interpreter binary's stat plus a
/// content hash of the installed `rlm` package tree under the venv's
/// site-packages. Out-of-band damage (a package uninstall or overwrite, a
/// replaced or deleted interpreter) changes this identity, so a memoized
/// probe result can never mask a mutated install: the next
/// [`kernel_ready`] re-probes and rebuilds like the uncached flow.
fn installed_runtime_identity(python: &Path, venv: &Path) -> String {
    let mut hasher = sha2::Sha256::new();
    match std::fs::metadata(python) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .map_or_else(|_| "no-mtime".to_string(), |time| format!("{time:?}"));
            hasher.update(format!("py:{}:{}:{modified}", python.display(), meta.len()).as_bytes());
        }
        Err(error) => hasher.update(format!("py-error:{}:{error}", python.display()).as_bytes()),
    }
    for package in ["rlm", "dill"] {
        match installed_package_dir(venv, package) {
            Some(dir) => match hash_python_tree(&dir) {
                Ok(hash) => hasher.update(format!("{package}:{hash}").as_bytes()),
                Err(error) => hasher.update(format!("{package}-error:{error}").as_bytes()),
            },
            None => hasher.update(format!("{package}-missing").as_bytes()),
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

/// The installed `rlm` package under the venv's site-packages: the
/// Windows layout `<venv>/Lib/site-packages/rlm` (no python-version
/// layer) or the Unix layout `<venv>/lib/python*/site-packages/rlm`.
#[cfg(test)]
fn installed_rlm_dir(venv: &Path) -> Option<PathBuf> {
    installed_package_dir(venv, "rlm")
}

fn installed_package_dir(venv: &Path, package: &str) -> Option<PathBuf> {
    let lib = venv.join("lib");
    let windows_layout = lib.join("site-packages").join(package);
    if windows_layout.is_dir() {
        return Some(windows_layout);
    }
    let entries = std::fs::read_dir(&lib).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if !entry.file_name().to_string_lossy().starts_with("python") {
            continue;
        }
        let installed = entry.path().join("site-packages").join(package);
        if installed.is_dir() {
            return Some(installed);
        }
    }
    None
}

/// Content hash of a python tree: every `.py` file's relative path and
/// bytes, in sorted order (same witness shape as [`hash_runtime_source`]).
fn hash_python_tree(dir: &Path) -> anyhow::Result<String> {
    let mut files = Vec::new();
    collect_python_files(dir, &mut files)?;
    files.sort();
    let mut hasher = sha2::Sha256::new();
    for file in &files {
        let relative = file.strip_prefix(dir)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(&std::fs::read(file)?);
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The memo key: every input the runtime-ready probe observes.
fn runtime_probe_key(
    python: &str,
    runtime_identity: &str,
    version_raw: &str,
    installed_identity: &str,
) -> String {
    format!(
        "{python}\u{0}{runtime_identity}\u{0}{installed_identity}\u{0}sha256:{:x}",
        sha2::Sha256::digest(version_raw.as_bytes())
    )
}

/// The runtime-ready check, memoized on success across two layers: the
/// process-global map first, then the on-disk cross-process memo (a fresh
/// process — every cold open's worker, every spawned child — starts with
/// an empty map, so the disk layer is what carries the verdict across
/// process boundaries). `version_raw` is the raw `.bootstrap-version` text
/// the caller already read; `installed_identity` is the installed-runtime
/// identity from [`installed_runtime_identity`]. The key is recomputed
/// fresh on every call — the content walk inside the identity is the
/// damage detector — so a hit skips only the two interpreter probes.
/// Managed-venv path only: a caller-owned `PRIME_AGENT_KERNEL_PYTHON`
/// override never reaches this (it uses the direct probe, the d14
/// ruling), and no memo file is read or written for it.
fn has_prime_agent_runtime_memoized(
    python: &str,
    runtime_identity: &str,
    version_raw: &str,
    installed_identity: &str,
    venv: &Path,
) -> bool {
    let key = runtime_probe_key(python, runtime_identity, version_raw, installed_identity);
    let memo_path = super::disk_memo::disk_memo_path(venv);
    if lock_probe_memo()
        .as_ref()
        .is_some_and(|memo| memo.contains_key(&key))
    {
        return true;
    }
    if super::disk_memo::disk_memo_hit(&memo_path, &key) {
        let mut memo = lock_probe_memo();
        let entries = memo.get_or_insert_with(HashMap::new);
        if entries.len() >= 16 {
            entries.clear();
        }
        entries.insert(key, memo_path);
        return true;
    }
    if !has_prime_agent_runtime(python) || !python_imports(python, "dill") {
        return false;
    }
    let mut memo = lock_probe_memo();
    let entries = memo.get_or_insert_with(HashMap::new);
    if entries.len() >= 16 {
        entries.clear();
    }
    super::disk_memo::disk_memo_write(&memo_path, &key);
    entries.insert(key, memo_path);
    true
}

/// Drop every memoized runtime-ready result, both layers: the in-process
/// map dies with this call, and every disk memo this process touched is
/// dropped (deleted, or atomically overwritten with the empty map when
/// the delete fails). The next kernel start re-runs the probe (and
/// rebuilds the venv when the probe finds it broken).
pub fn invalidate_runtime_probe_cache() {
    let tracked: Vec<PathBuf> = lock_probe_memo()
        .take()
        .map(|memo| memo.values().cloned().collect())
        .unwrap_or_default();
    for path in tracked {
        super::disk_memo::disk_memo_invalidate(&path);
    }
}

/// Drop only the in-process memo layer, leaving the on-disk layer intact:
/// the fresh-process simulation the disk-memo oracles use (a real fresh
/// process starts with an empty map and the disk file on disk).
#[cfg(test)]
pub(crate) fn clear_in_process_probe_memo_for_tests() {
    *lock_probe_memo() = None;
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
    bootstrap_version_current(version, runtime_identity, python_skills)
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
