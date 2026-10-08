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
    default_rlm_extra_uv_args, EnsureKernelPythonOptions, KernelBootstrapProgressHandler,
    KernelPythonSkill, DEFAULT_RLM_EXTRA_PACKAGES,
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

/// The default bound on one bootstrap child: generous for slow links (the
/// Python download alone is tens of MB), short of a hang.
const DEFAULT_BOOTSTRAP_CHILD_TIMEOUT_MS: u64 = 600_000;

/// The grace for the post-bound reap and the post-exit drain join: a
/// request (kill, EOF) is not a completed wait, and neither may turn the
/// bound into a new unbounded one.
const REAP_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// The bound on one bootstrap child, overridable for slow links through
/// `PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS`.
fn resolve_bootstrap_child_timeout_ms() -> u64 {
    match std::env::var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS") {
        // A non-positive override is not a bound: it falls back to the
        // default rather than killing every child on sight.
        Ok(value) if !value.is_empty() => value
            .parse::<u64>()
            .ok()
            .filter(|ms| *ms > 0)
            .unwrap_or(DEFAULT_BOOTSTRAP_CHILD_TIMEOUT_MS),
        _ => DEFAULT_BOOTSTRAP_CHILD_TIMEOUT_MS,
    }
}

/// Forward one piped child stream line by line through the progress
/// reporter; the pipe is drained to EOF whatever the reporter does.
/// Lines are read byte-delimited and decoded lossily: a child that emits
/// non-UTF-8 bytes (locale noise, a raw progress escape) is forwarded
/// mangled, never allowed to end the drain mid-stream.
fn drain_child_stream<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
    report: Option<KernelBootstrapProgressHandler>,
) -> std::thread::JoinHandle<()> {
    // One forwarded line is capped: a newline-free stream must not grow
    // the carry without bound (the pipe still drains - the cap only
    // bounds a single forward).
    const MAX_LINE_BYTES: usize = 64 * 1024;
    std::thread::spawn(move || {
        let Some(mut pipe) = pipe else {
            return;
        };
        let mut carry: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8 * 1024];
        loop {
            let read = match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let mut start = 0;
            for (at, byte) in chunk[..read].iter().enumerate() {
                if *byte != b'\n' {
                    continue;
                }
                let mut line = carry.clone();
                line.extend_from_slice(&chunk[start..at]);
                forward_drained_line(&line, report.as_ref());
                carry.clear();
                start = at + 1;
            }
            // The cap check precedes the extend: the carry may already
            // sit at the cap when the next chunk's tail arrives.
            let pending = &chunk[start..read];
            if carry.len() + pending.len() > MAX_LINE_BYTES {
                forward_drained_line(&carry, report.as_ref());
                carry.clear();
            }
            carry.extend_from_slice(pending);
        }
        if !carry.is_empty() {
            forward_drained_line(&carry, report.as_ref());
        }
    })
}

/// One drained line, lossily decoded (a child that emits non-UTF-8 bytes
/// is forwarded mangled, never allowed to end the drain mid-stream).
fn forward_drained_line(bytes: &[u8], report: Option<&KernelBootstrapProgressHandler>) {
    let mut line = String::from_utf8_lossy(bytes).into_owned();
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    match report {
        Some(handler) => handler(&line),
        None => eprintln!("{line}"),
    }
}

/// Spawn one bootstrap child: stdin is null, stdout and stderr are piped
/// and forwarded through the progress reporter, and the wait is bounded -
/// a child that never exits is tree-killed at the bound and reported.
async fn run_async(
    command: &str,
    args: &[String],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    // Run on a blocking thread: the bootstrap is an IO-bound child process.
    let command = command.to_string();
    let args = args.to_vec();
    let report = options.on_progress.clone();
    tokio::task::spawn_blocking(move || {
        let mut spawn = std::process::Command::new(&command);
        spawn
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The child leads its own process group on Unix so the bound's
        // group kill reaches its descendants; Windows keeps the hidden
        // window shape (the creation flags replace each other) and
        // `taskkill /T` walks the tree.
        #[cfg(unix)]
        crate::platform::process::set_new_process_group(&mut spawn);
        crate::platform::process::set_no_window(&mut spawn);
        let mut child = spawn
            .spawn()
            .with_context(|| format!("failed to spawn {command}"))?;
        // The pipes must drain while the child runs: a full pipe would
        // block the child before the bound ever fires.
        let drains = [
            drain_child_stream(child.stdout.take(), report.clone()),
            drain_child_stream(child.stderr.take(), report),
        ];
        let bound = std::time::Duration::from_millis(resolve_bootstrap_child_timeout_ms());
        let deadline = std::time::Instant::now() + bound;
        // EOF lands when the child dies; a descendant that inherited the
        // pipes must not trade the bound for a new hang on the exit path.
        let drain_grace = REAP_GRACE;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    // A kill request is not a dead child: the reap gets its
                    // own grace (a child that cannot be killed must not
                    // defeat the bound here either), the verdict reports
                    // what was proven, and the drains are never joined -
                    // a descendant that inherited the pipes can outlive
                    // the kill.
                    // The helper is synchronous and bounded in its own
                    // right: on Windows a hung taskkill is killed by the
                    // helper itself, so this call cannot outlive the bound
                    // - or the child's pid.
                    #[cfg(windows)]
                    let (killed, helper_released) =
                        crate::platform::process::kill_process_group_or_pid_pinned(
                            child.id() as i32
                        );
                    #[cfg(not(windows))]
                    let killed =
                        crate::platform::process::kill_process_group_or_pid(child.id() as i32);
                    let reap_deadline = std::time::Instant::now() + REAP_GRACE;
                    let mut reaped = false;
                    while std::time::Instant::now() < reap_deadline {
                        match child.try_wait() {
                            Ok(Some(_)) => {
                                reaped = true;
                                break;
                            }
                            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                            Err(_) => break,
                        }
                    }
                    // On Windows a helper that survived its own kill may
                    // still act on the pid: the target's pin is held until
                    // the HELPER dies, not just the target - the handle is
                    // the only thing keeping the pid reserved.
                    #[cfg(windows)]
                    match helper_released {
                        Some(released) => {
                            std::thread::spawn(move || {
                                let _ = released.recv();
                                drop(child);
                            });
                        }
                        None => drop(child),
                    }
                    // An unreaped child keeps its parent: dropped, its
                    // later exit would linger as a zombie for the whole
                    // session. It parks on a reaper thread instead - the
                    // thread dies with the child, the verdict never waits.
                    #[cfg(not(windows))]
                    {
                        std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                    }
                    drop(drains);
                    let outcome = match (killed, reaped) {
                        (true, true) => "was terminated",
                        (true, false) => "was sent a kill that did not complete",
                        (false, true) => "exited during the kill reap",
                        (false, false) => "could not be killed",
                    };
                    return Err(anyhow!(
                        "{} {} did not finish within {}ms and {}",
                        command,
                        args.join(" "),
                        bound.as_millis(),
                        outcome
                    ));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(error) => {
                    drop(drains);
                    return Err(anyhow!(error).context(format!("waiting for {command}")));
                }
            }
        };
        // Past the grace the remaining drains are parked: a descendant
        // holding the pipes keeps them blocked, and the thread (a pipe fd
        // and the callback) is released when that descendant dies - the
        // parker joins it then, so nothing accumulates per bootstrap.
        let mut parked: Vec<std::thread::JoinHandle<()>> = Vec::new();
        let drain_deadline = std::time::Instant::now() + drain_grace;
        for drain in drains {
            let drain = drain;
            while !drain.is_finished() && std::time::Instant::now() < drain_deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if drain.is_finished() {
                let _ = drain.join();
            } else {
                parked.push(drain);
            }
        }
        if !parked.is_empty() {
            std::thread::spawn(move || {
                for drain in parked {
                    let _ = drain.join();
                }
            });
        }
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

    // uv's own non-interactive flag on every call: the bootstrap runs
    // unattended and must not depend on terminal output behavior.
    run_async(
        &uv,
        &[
            "--no-progress".to_string(),
            "python".to_string(),
            "install".to_string(),
            PYTHON_VERSION.to_string(),
        ],
        options,
    )
    .await?;
    run_async(
        &uv,
        &[
            "--no-progress".to_string(),
            "venv".to_string(),
            venv_str,
            "--python".to_string(),
            PYTHON_VERSION.to_string(),
            "--seed".to_string(),
        ],
        options,
    )
    .await?;
    install_args.insert(0, "--no-progress".to_string());
    run_async(&uv, &install_args, options).await?;
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

/// Install/refresh the editable Python skills recorded in the version file. Only skills missing or
/// changed are installed. Per-skill failures warn and continue.
pub(crate) async fn sync_python_skills(
    uv: &str,
    venv: &Path,
    python: &Path,
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
        // One uv invocation installs the whole batch of missing skills: a fresh bootstrap otherwise
        // pays one process plus build-backend startup per install. A batch failure falls back to
        // the per-skill loop.
        let mut install_args = vec![
            "--no-progress".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--python".to_string(),
            python_str.clone(),
        ];
        for skill in &missing {
            install_args.push("--editable".to_string());
            install_args.push(skill.package_path.clone());
        }
        if run_async(uv, &install_args, options).await.is_ok() {
            // A changed pyproject (hash moved) replaces the stale record.
            for skill in &missing {
                installed.insert(bootstrap_skill_key(skill), (*skill).clone());
            }
        } else {
            for skill in &missing {
                let result = run_async(
                    uv,
                    &[
                        "--no-progress".to_string(),
                        "pip".to_string(),
                        "install".to_string(),
                        "--python".to_string(),
                        python_str.clone(),
                        "--editable".to_string(),
                        skill.package_path.clone(),
                    ],
                    options,
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
