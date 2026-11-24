//! Kernel Python environment bootstrap: the public entry point [`ensure_kernel_python`]
//! resolves (and on first run builds) the venv that runs `python -m rlm.repl`,
//! deduplicating concurrent bootstraps; the venv and version-file machinery lives in
//! [`venv`], the runtime bootstrap code in [`runtime_code`].

pub(crate) mod dir_lock;
mod disk_memo;
mod runtime_code;
pub(crate) mod venv;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;

use dir_lock::acquire_bootstrap_lock;
pub use runtime_code::{
    build_rlm_bootstrap_code, parse_unavailable_python_skills, UnavailablePythonSkills,
    PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER,
};
use venv::{
    bootstrap_venv, ensure_uv, expand_home, has_prime_agent_runtime, home_kernel_venv_dir,
    missing_python_skill_import_labels, missing_rlm_extra_import_labels, normalize_python_skills,
    resolve_writable_kernel_venv_dir, sync_python_skills, BootstrapPythonSkill, UvCommand,
};
pub use venv::{invalidate_runtime_probe_cache, kernel_venv_dir, kernel_venv_python};
use venv::{kernel_base_ready, kernel_ready};

/// One Python skill the kernel should import at bootstrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelPythonSkill {
    pub name: String,
    pub import_name: String,
    pub package_path: PathBuf,
    pub pyproject_path: PathBuf,
}

/// The default extra packages pre-installed in the kernel venv and promised to
/// the model in the system prompt.
pub const DEFAULT_RLM_EXTRA_PACKAGES: [(&str, &str, &str); 13] = [
    // (uvArg, importName, promptLabel)
    ("requests", "requests", "requests"),
    ("httpx", "httpx", "httpx"),
    ("pyyaml", "yaml", "yaml (PyYAML)"),
    ("tomli", "tomli", "tomli"),
    ("python-dotenv", "dotenv", "dotenv (python-dotenv)"),
    ("pandas", "pandas", "pandas"),
    ("numpy", "numpy", "numpy"),
    ("scipy", "scipy", "scipy"),
    ("beautifulsoup4", "bs4", "bs4 (Beautiful Soup)"),
    ("lxml", "lxml", "lxml"),
    ("pydantic", "pydantic", "pydantic"),
    ("tyro", "tyro", "tyro"),
    ("pillow", "PIL", "Pillow"),
];

#[must_use]
pub fn default_rlm_extra_uv_args() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(uv, _, _)| *uv)
        .collect()
}

#[must_use]
pub fn default_rlm_extra_import_names() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(_, import, _)| *import)
        .collect()
}

#[must_use]
pub fn default_rlm_extra_import_labels() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(_, _, label)| *label)
        .collect()
}

/// Progress callback for the bootstrap (`ensure_kernel_python`).
pub type KernelBootstrapProgressHandler = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct EnsureKernelPythonOptions {
    pub python_skills: Vec<KernelPythonSkill>,
    pub on_progress: Option<KernelBootstrapProgressHandler>,
}

impl EnsureKernelPythonOptions {
    pub(crate) fn report(&self, message: &str) {
        match &self.on_progress {
            Some(handler) => handler(message),
            None => eprintln!("{message}"),
        }
    }
}

fn format_bootstrap_failure(error: &anyhow::Error) -> anyhow::Error {
    let mut message = format!(
        "Failed to set up the Python kernel runtime. {error:#}\n\
         First-time setup needs the bundled local runtime and internet to install uv, Python, and default Python packages; once set up, Prime Agent runs offline. \
         An interrupted runtime upgrade needs network once more, so re-run this while online. \
         Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap."
    );
    // The packaged exe-adjacent sidecar is the kernel runtime source; when it is missing everywhere
    // (packaged layout and source checkout), name it.
    if venv::packaged_runtime_dir().is_none() {
        let package = venv::package_dir();
        let _ = write!(message,
            "\nThe packaged prime-agent-runtime directory was not found (looked next to the executable at {} and PI_PACKAGE_DIR); reinstall prime-agent so the kernel runtime ships beside the binary.",
            package.display()
        );
    }
    anyhow!(message)
}

/// One in-flight bootstrap per unique options set, joined by concurrent callers.
type InFlightBootstrap = Option<(
    String,
    Arc<tokio::sync::Mutex<Option<anyhow::Result<PathBuf>>>>,
)>;

static IN_FLIGHT: Mutex<InFlightBootstrap> = Mutex::new(None);

/// Resolve the Python interpreter for the kernel: the `PRIME_AGENT_KERNEL_PYTHON`
/// override when valid, else the auto-bootstrapped venv python.
///
/// # Errors
///
/// Returns an error when the override Python is invalid or the venv bootstrap fails.
///
/// # Panics
///
/// The in-flight promise stores its outcome under the same lock, so the `expect` is unreachable.
pub async fn ensure_kernel_python(options: EnsureKernelPythonOptions) -> anyhow::Result<PathBuf> {
    ensure_kernel_python_for_project(options, std::env::current_dir().ok()).await
}

/// The kernel manager knows its session directory even when the host process
/// was launched elsewhere. Keep that directory through probes and uv setup.
pub(crate) async fn ensure_kernel_python_for_project(
    options: EnsureKernelPythonOptions,
    project: Option<PathBuf>,
) -> anyhow::Result<PathBuf> {
    let python_skills = normalize_python_skills(&options.python_skills);
    let key = [
        project
            .as_ref()
            .map_or_else(String::new, |path| path.to_string_lossy().into_owned()),
        std::env::var("PRIME_AGENT_KERNEL_PYTHON").unwrap_or_default(),
        std::env::var("PRIME_AGENT_KERNEL_VENV").unwrap_or_default(),
        std::env::var("HOME").unwrap_or_default(),
        std::env::var("XDG_DATA_HOME").unwrap_or_default(),
        serde_json::to_string(&python_skills).unwrap_or_default(),
    ]
    .join("\u{0}");

    let shared = {
        let mut in_flight = IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match in_flight.as_ref() {
            Some((existing_key, promise)) if *existing_key == key => promise.clone(),
            _ => {
                let promise = Arc::new(tokio::sync::Mutex::new(None));
                *in_flight = Some((key, promise.clone()));
                promise
            }
        }
    };
    let mut guard = shared.lock().await;
    if guard.is_none() {
        *guard =
            Some(ensure_kernel_python_uncached(&options, &python_skills, project.as_deref()).await);
    }
    let outcome = guard.take().expect("outcome was just stored");
    // Drop the registry entry so a later call re-validates instead of reusing
    // a cached rejection forever.
    let mut in_flight = IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if matches!(in_flight.as_ref(), Some((_, promise)) if Arc::ptr_eq(promise, &shared)) {
        *in_flight = None;
    }
    outcome
}

async fn ensure_kernel_python_uncached(
    options: &EnsureKernelPythonOptions,
    python_skills: &[BootstrapPythonSkill],
    project: Option<&std::path::Path>,
) -> anyhow::Result<PathBuf> {
    if let Ok(override_python) = std::env::var("PRIME_AGENT_KERNEL_PYTHON") {
        if !override_python.is_empty() {
            let python = expand_home(&override_python);
            let python_str = python.to_string_lossy().to_string();
            let mut missing = Vec::new();
            if !has_prime_agent_runtime(&python_str) {
                missing.push(
                    "a current prime-agent-runtime with callable rlm.spawn, rlm.create_session, rlm.host_request, rlm.progress_note, rlm.rename, rlm._set_completion_notices_wired, and explicit harness CRUD methods".to_string(),
                );
            }
            if missing.is_empty() {
                let missing_extras = missing_rlm_extra_import_labels(&python_str);
                if !missing_extras.is_empty() {
                    missing.push(format!(
                        "default Python packages ({})",
                        missing_extras.join(", ")
                    ));
                }
            }
            if missing.is_empty() && !options.python_skills.is_empty() {
                let missing_skills =
                    missing_python_skill_import_labels(&python_str, &options.python_skills);
                if !missing_skills.is_empty() {
                    options.report(&format!(
                        "Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: {}",
                        missing_skills.join(", ")
                    ));
                }
            }
            if missing.is_empty() {
                return Ok(python);
            }
            return Err(anyhow!(
                "PRIME_AGENT_KERNEL_PYTHON points to a Python missing {}: {}",
                missing.join(" and "),
                python.display()
            ));
        }
    }

    let venv = resolve_writable_kernel_venv_dir()?;
    let account_home = crate::kernel::python_env::account_home();
    ensure_kernel_venv(
        options,
        python_skills,
        venv,
        project,
        account_home.as_deref(),
    )
    .await
}

/// Set to `1` for every cargo-launched process (tests and `cargo run`) by the
/// workspace's `.cargo/config.toml`, so a test binary, and any worker it spawns,
/// inherits it. `0` turns the refusal off: cargo's `[env]` never overrides a
/// variable that is already set, so unsetting it would not.
const REFUSE_ACCOUNT_KERNEL_VENV_ENV: &str = "PRIME_AGENT_REFUSE_ACCOUNT_KERNEL_VENV";

/// A test must never build into the account's own kernel venv: that venv serves
/// the user's live sessions, and a test binary's runtime identity differs from
/// the installed one. `account_home` comes from the user database, so a test
/// that points `HOME` at a temp dir still bootstraps there.
fn refuse_account_venv_under_test(venv: &Path, account_home: Option<&Path>) -> anyhow::Result<()> {
    let under_test = cfg!(test)
        || std::env::var_os(REFUSE_ACCOUNT_KERNEL_VENV_ENV).is_some_and(|value| value != "0");
    // Compare resolved locations: a `..` or symlinked spelling of the account
    // venv is still the account venv.
    let resolved = |path: &Path| {
        path.canonicalize()
            .or_else(|_| {
                let parent = path.parent().unwrap_or(Path::new("/")).canonicalize()?;
                Ok::<_, std::io::Error>(parent.join(path.file_name().unwrap_or_default()))
            })
            .unwrap_or_else(|_| path.to_path_buf())
    };
    if under_test
        && account_home.is_some_and(|home| resolved(&home_kernel_venv_dir(home)) == resolved(venv))
    {
        return Err(anyhow!(
            "refusing to bootstrap the account's kernel venv ({}) from a cargo-launched build: \
             it serves your live sessions. Set PRIME_AGENT_KERNEL_VENV to a scratch dir, or set \
             {REFUSE_ACCOUNT_KERNEL_VENV_ENV}=0 to use the account venv deliberately (it will be \
             rebuilt and replaced).",
            venv.display()
        ));
    }
    Ok(())
}

/// Replace the live venv with a freshly built candidate.
///
/// The build writes `candidate` while `venv` keeps serving; only a finished
/// candidate is renamed into place. A later bootstrap recovers the old venv if
/// the process is killed during the two-rename swap.
async fn rebuild_kernel_venv(
    venv: &std::path::Path,
    candidate: &std::path::Path,
    build: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    if let Err(error) = build.await {
        let _ = std::fs::remove_dir_all(candidate);
        return Err(error);
    }
    if let Err(error) = venv::swap_venv_into_place(candidate, venv) {
        let _ = std::fs::remove_dir_all(candidate);
        return Err(error);
    }
    Ok(())
}

async fn ensure_kernel_venv(
    options: &EnsureKernelPythonOptions,
    python_skills: &[BootstrapPythonSkill],
    venv: PathBuf,
    project: Option<&Path>,
    account_home: Option<&Path>,
) -> anyhow::Result<PathBuf> {
    let python = kernel_venv_python(&venv);
    let python_str = python.to_string_lossy().to_string();
    // Validate the local source before probing any installed runtime or
    // removing an existing venv. Missing payloads must fail closed.
    let source_dir =
        venv::require_runtime_source_dir().map_err(|error| format_bootstrap_failure(&error))?;
    let runtime_identity =
        venv::hash_runtime_source(&source_dir).map_err(|error| format_bootstrap_failure(&error))?;
    if kernel_ready(&python_str, &venv, &runtime_identity, python_skills) {
        return Ok(python);
    }
    refuse_account_venv_under_test(&venv, account_home)?;

    let venv_ready = || kernel_ready(&python_str, &venv, &runtime_identity, python_skills);
    let release_lock = match acquire_bootstrap_lock(&venv, &venv_ready).await {
        // A leader finished while this caller waited: adopt its venv instead
        // of rebuilding it a second time.
        Ok(None) => return Ok(python),
        Ok(Some(release_lock)) => release_lock,
        Err(error) if dir_lock::lock_creation_denied(&error) => {
            return unwritable_venv(options, &python, &venv, &runtime_identity, &error);
        }
        Err(error) => return Err(error),
    };
    let result = async {
        if kernel_ready(&python_str, &venv, &runtime_identity, python_skills) {
            return Ok(python);
        }
        if kernel_base_ready(&python_str, &venv, &runtime_identity) {
            let uv = ensure_uv(project)?;
            let uv_command = UvCommand {
                executable: &uv,
                project,
            };
            sync_python_skills(
                &uv_command,
                &venv,
                &python,
                &source_dir,
                &runtime_identity,
                python_skills,
                options,
            )
            .await?;
            return Ok(python);
        }
        let had_venv = venv.exists();
        options.report("› setting up python kernel (one-time, ~30s)…");
        if had_venv {
            options.report("rebuilding kernel venv");
        }
        // Build beside the live path and swap the finished candidate in: a
        // session that already resolved this venv keeps a working interpreter
        // for the whole build, and a failed build leaves the live venv as it
        // was.
        let candidate = venv::venv_candidate_path(&venv);
        rebuild_kernel_venv(
            &venv,
            &candidate,
            bootstrap_venv(
                &candidate,
                &source_dir,
                &runtime_identity,
                python_skills,
                options,
                project,
            ),
        )
        .await?;
        Ok(python)
    }
    .await;
    drop(release_lock);
    options.report("✓ ready");
    result.map_err(|error| format_bootstrap_failure(&error))
}

/// The venv's directory denies writes to this user, so the bootstrap lock cannot be
/// created: a base-ready venv degrades the way a `PRIME_AGENT_KERNEL_PYTHON` override
/// does (uncovered skills disabled with a warning, nothing installed), and anything
/// less is a setup error naming the venv and both env overrides.
fn unwritable_venv(
    options: &EnsureKernelPythonOptions,
    python: &std::path::Path,
    venv: &std::path::Path,
    runtime_identity: &str,
    lock_error: &anyhow::Error,
) -> anyhow::Result<PathBuf> {
    let python_str = python.to_string_lossy().to_string();
    if !kernel_base_ready(&python_str, venv, runtime_identity) {
        return Err(anyhow!(
            "cannot set up the Python kernel runtime: the kernel venv at {} is not writable by \
             this user and does not hold a current runtime. Set PRIME_AGENT_KERNEL_VENV to a \
             writable directory, or set PRIME_AGENT_KERNEL_PYTHON to a Python with a current \
             prime-agent-runtime and the default Python packages installed. ({lock_error:#})",
            venv.display()
        ));
    }
    let missing = missing_python_skill_import_labels(&python_str, &options.python_skills);
    if !missing.is_empty() {
        options.report(&format!(
            "Warning: Python skills unavailable in {} and will be disabled: {}",
            venv.display(),
            missing.join(", ")
        ));
    }
    Ok(python.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_rebuild_keeps_the_live_venv_until_the_candidate_is_swapped_in() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let live_python = kernel_venv_python(&venv);
        std::fs::create_dir_all(live_python.parent().unwrap()).unwrap();
        std::fs::write(&live_python, "old").unwrap();
        let candidate = venv::venv_candidate_path(&venv);
        let served = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = Arc::clone(&served);
        let live = live_python.clone();
        let staging = candidate.clone();
        rebuild_kernel_venv(&venv, &candidate, async move {
            // The whole point: while the candidate builds, the live venv still
            // serves the sessions that already resolved it.
            observed.store(live.exists(), std::sync::atomic::Ordering::SeqCst);
            let python = kernel_venv_python(&staging);
            std::fs::create_dir_all(python.parent().unwrap()).unwrap();
            std::fs::write(python, "new").unwrap();
            std::fs::write(staging.join("pyvenv.cfg"), "home = /usr/bin\n").unwrap();
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            served.load(std::sync::atomic::Ordering::SeqCst),
            "the live venv must keep serving for the whole build"
        );
        assert_eq!(std::fs::read_to_string(&live_python).unwrap(), "new");
        assert!(!candidate.exists(), "the candidate is consumed by the swap");
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiter_adopts_a_venv_that_becomes_ready_instead_of_rebuilding() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        // A live owner holds the lock; the venv becomes usable while the
        // waiter polls.
        std::fs::write(&lock, format!("{}\n", std::process::id())).unwrap();
        let acquired = acquire_bootstrap_lock(&venv, &|| true).await;
        let acquired = acquired.expect("a ready venv ends the wait");
        assert!(
            acquired.is_none(),
            "a waiter never becomes a second builder"
        );
        assert_eq!(
            std::fs::read_to_string(&lock).unwrap(),
            format!("{}\n", std::process::id()),
            "the waiter leaves the owner's lock alone"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lock_timeout_prevents_venv_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        std::fs::create_dir(&venv).unwrap();
        let sentinel = venv.join("owner-state");
        std::fs::write(&sentinel, "another bootstrap owns this venv").unwrap();
        let owner = acquire_bootstrap_lock(&venv, &|| false)
            .await
            .unwrap()
            .unwrap();
        let options = EnsureKernelPythonOptions {
            // Fail before any destructive operation or network access if the
            // caller regresses and enters setup without acquiring the lock.
            on_progress: Some(Arc::new(|message| {
                panic!("bootstrap must stop at the lock error, got progress: {message}");
            })),
            ..Default::default()
        };

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(121),
            ensure_kernel_venv(&options, &[], venv, None, /*account_home*/ None),
        )
        .await
        .expect("lock acquisition must have a bounded wait")
        .expect_err("a lock timeout must propagate to the caller");

        assert!(error.to_string().contains("Timed out"), "{error}");
        assert_eq!(
            std::fs::read_to_string(sentinel).unwrap(),
            "another bootstrap owns this venv"
        );
        assert!(root.path().join("kernel-venv.bootstrap.lock").exists());
        drop(owner);
    }

    fn sibling_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The interpreter and `pyvenv.cfg` that `uv venv` writes, at this
    /// platform's layout.
    pub(super) fn write_complete_venv(venv: &Path, interpreter: &str) {
        let python = kernel_venv_python(venv);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(python, interpreter).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\n").unwrap();
    }

    /// A failed swap keeps the old venv live and removes nothing, not even
    /// a leftover retired copy.
    #[test]
    fn a_failed_swap_restores_the_old_venv_and_prunes_nothing() {
        let root = tempfile::tempdir().unwrap();
        write_complete_venv(&root.path().join("kernel-venv.stale-1"), "leftover");
        let venv = root.path().join("kernel-venv");
        write_complete_venv(&venv, "old");
        let before = sibling_names(root.path());

        // The build never produced its candidate, so the swap rejects it before
        // touching the live venv.
        let candidate = venv::venv_candidate_path(&venv);
        venv::swap_venv_into_place(&candidate, &venv).unwrap_err();

        assert_eq!(
            std::fs::read_to_string(kernel_venv_python(&venv)).unwrap(),
            "old"
        );
        assert_eq!(sibling_names(root.path()), before);
    }

    /// Once the new venv is live, the copy the swap just retired and the
    /// leftovers of earlier swaps are all removed.
    #[test]
    fn a_swap_removes_every_retired_venv() {
        let root = tempfile::tempdir().unwrap();
        write_complete_venv(&root.path().join("kernel-venv.stale-1"), "leftover");
        let venv = root.path().join("kernel-venv");
        write_complete_venv(&venv, "old");
        let candidate = venv::venv_candidate_path(&venv);
        write_complete_venv(&candidate, "new");

        venv::swap_venv_into_place(&candidate, &venv).unwrap();

        assert_eq!(
            std::fs::read_to_string(kernel_venv_python(&venv)).unwrap(),
            "new"
        );
        assert_eq!(sibling_names(root.path()), ["kernel-venv"]);
    }

    #[test]
    fn a_failed_removal_never_fails_the_swap() {
        let root = tempfile::tempdir().unwrap();
        // `remove_dir_all` cannot remove a file, even as root.
        std::fs::write(root.path().join("kernel-venv.stale-1"), "x").unwrap();
        let venv = root.path().join("kernel-venv");
        write_complete_venv(&venv, "old");
        let candidate = venv::venv_candidate_path(&venv);
        write_complete_venv(&candidate, "new");

        venv::swap_venv_into_place(&candidate, &venv).expect("a failed removal is not fatal");

        assert_eq!(
            std::fs::read_to_string(kernel_venv_python(&venv)).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn the_account_venv_is_never_bootstrapped_from_a_test() {
        let account_home = tempfile::tempdir().unwrap();
        let venv = home_kernel_venv_dir(account_home.path());
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("marker"), "live").unwrap();
        let options = EnsureKernelPythonOptions {
            on_progress: Some(Arc::new(|message| {
                panic!("the guard must stop the bootstrap first, got progress: {message}");
            })),
            ..Default::default()
        };

        let error =
            ensure_kernel_venv(&options, &[], venv.clone(), None, Some(account_home.path()))
                .await
                .expect_err("a test must not bootstrap the account's venv");

        // The refusal names both ways forward: a scratch venv, or the marker off.
        let message = error.to_string();
        assert!(
            message.contains("Set PRIME_AGENT_KERNEL_VENV to a scratch dir"),
            "{message}"
        );
        assert!(
            message.contains("set PRIME_AGENT_REFUSE_ACCOUNT_KERNEL_VENV=0"),
            "{message}"
        );
        assert_eq!(sibling_names(&venv), vec!["marker".to_string()]);
        let alias = account_home
            .path()
            .join(".prime/agent/../agent/kernel-venv");
        assert!(
            refuse_account_venv_under_test(&alias, Some(account_home.path())).is_err(),
            "a `..` spelling of the account venv is refused too"
        );
        assert_eq!(
            sibling_names(venv.parent().unwrap()),
            vec!["kernel-venv".to_string()]
        );
    }
}
