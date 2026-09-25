//! The per-session kernel provisioner: owns one kernel manager, guards its
//! startup, revives the saved namespace before the runtime bootstrap, and
//! disposes/kills on demand.
//!
//! Teardown contract: the provisioner is the manager's strong owner, and the
//! manager's reader/watcher tasks hold only weak references — so dropping the
//! last provisioner handle tears the kernel PROCESS down synchronously
//! (`Inner::drop` sends the kill). An explicit `dispose()` is still the
//! product path (it flushes a final namespace snapshot first), but no kernel
//! can outlive the object graph that created it.
//!
//! Ported from `core/tools/ipython.ts` (`IpythonKernelProvisioner`) and
//! `core/kernel/boot-gate.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;

use crate::kernel::bootstrap::{
    build_rlm_bootstrap_code, KernelBootstrapProgressHandler, KernelPythonSkill,
};
use crate::kernel::cancellation::AbortSignal;
use crate::kernel::manager::{KernelStartOptions, ReplKernelManager};
use crate::kernel::shared::ExecuteStatus;
use crate::kernel::shared::{
    ExecuteOptions, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
    KernelSnapshotConfig,
};
use crate::kernel::state_snapshot::RestoreResult;
use crate::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

/// Above core count because boots are IO-bound, capped so a fan-out can't
/// thrash the FS past the ready-handshake window.
fn default_kernel_boot_concurrency() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
    16.min((cores * 2).max(4))
}

fn resolve_kernel_boot_concurrency() -> usize {
    let Ok(raw) = std::env::var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS") else {
        return default_kernel_boot_concurrency();
    };
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
        return default_kernel_boot_concurrency();
    }
    let parsed: usize = raw.parse().unwrap_or(0);
    if parsed < 1 {
        return default_kernel_boot_concurrency();
    }
    parsed.min(64)
}

/// Semaphore bounding concurrent kernel boots. Resolved lazily on first boot so
/// an env override set before the first kernel starts is honored.
static BOOT_PERMITS: Mutex<Option<Arc<tokio::sync::Semaphore>>> = Mutex::new(None);

async fn with_kernel_boot_permit<F, Fut>(boot: F) -> Fut::Output
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future,
{
    let permits = {
        let mut guard = BOOT_PERMITS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .get_or_insert_with(|| {
                Arc::new(tokio::sync::Semaphore::new(
                    resolve_kernel_boot_concurrency(),
                ))
            })
            .clone()
    };
    let _permit = permits.acquire().await;
    boot().await
}

/// Options for the provisioner's kernel, mirroring the TS `IpythonToolOptions`
/// subset the provisioner consumes.
/// Publishes the restore outcome once the kernel is usable.
pub type RestoreCallback = Arc<dyn Fn(&RestoreResult) + Send + Sync>;

/// Publishes the pre-imported Python skills that failed to import into a
/// freshly started kernel (skill import name -> import error), so the
/// session can tell the model before it wastes turns calling them (TS
/// `IpythonToolOptions.onUnavailableSkills`).
pub type UnavailableSkillsCallback = Arc<
    dyn Fn(&crate::session_engine::python_skills_notice::UnavailablePythonSkills) + Send + Sync,
>;

/// Outcome of one full kernel bootstrap (spawn + handshake + namespace
/// restore + runtime bootstrap), reported once per actual boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelBootstrapOutcome {
    /// The kernel process is running, revived, and runtime-bootstrapped.
    Ready,
    /// Any stage failed; the kernel was torn down before the error surfaced.
    Error,
}

/// What one `kernel bootstrap` telemetry event reports.
#[derive(Debug, Clone, Copy)]
pub struct KernelBootstrapStats {
    /// No prior namespace snapshot existed to restore (fresh session vs a
    /// revived one).
    pub cold: bool,
    pub outcome: KernelBootstrapOutcome,
    /// Wall time of the whole bootstrap, milliseconds.
    pub duration_ms: u64,
}

/// Reports kernel bootstrap results (`kernel bootstrap`, schema v1).
pub type KernelBootstrapResultHandler = Arc<dyn Fn(KernelBootstrapStats) + Send + Sync>;

#[derive(Default, Clone)]
pub struct IpythonKernelProvisionerOptions {
    /// Python override. Must have prime-agent-runtime installed.
    pub python: Option<PathBuf>,
    pub env: HashMap<String, String>,
    /// Command prefix prepended to every kernel `bash()` invocation.
    pub command_prefix: Option<String>,
    /// Trusted shell path injected for kernel `bash()`; `None` on platforms
    /// without one, where the runtime's teaching error fires instead.
    pub shell_path: Option<PathBuf>,
    pub session_id: Option<String>,
    pub host_handlers: HostRequestHandlers,
    pub python_skills: Vec<KernelPythonSkill>,
    /// Artifact directory of a persistent session; the revivable snapshot and
    /// the stderr log live there. `None` for ephemeral sessions.
    pub snapshot_dir: Option<PathBuf>,
    /// Await (e.g. a previous provisioner's dispose) before reading the snapshot.
    pub ready_gate: Option<Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>>,
    /// Publishes the restore outcome once the kernel is usable.
    pub on_restore: Option<RestoreCallback>,
    /// Fires once per kernel start when installed Python skills failed to
    /// import into the kernel (skill import name -> import error), so the
    /// session can tell the model before it wastes turns calling them.
    pub on_unavailable_skills: Option<UnavailableSkillsCallback>,
    /// Publishes the per-boot result for `kernel bootstrap` telemetry.
    /// Telemetry only; kernel behavior never depends on it.
    pub on_bootstrap_result: Option<KernelBootstrapResultHandler>,
}

/// Why and how long the last startup failed, kept so `ensure()` callers see
/// the full cause instead of a bare "kernel startup failed".
#[derive(Clone)]
struct StartupFailure {
    /// Full error chain (`{:#}` formatting).
    message: String,
    duration_ms: u64,
}

struct ProvisionerState {
    manager: Option<ReplKernelManager>,
    /// The memoized startup: a task that settles by setting `manager`
    /// (success) or clearing itself (failure).
    startup: Option<tokio::task::JoinHandle<()>>,
    startup_listeners: Vec<KernelBootstrapProgressHandler>,
    last_startup_message: Option<String>,
    /// The most recent startup failure; surfaced by `ensure()` until a new
    /// start succeeds, so joining callers get the real cause and duration.
    last_startup_failure: Option<StartupFailure>,
    last_restore: Option<RestoreResult>,
    disposed: bool,
    /// Snapshot policy of the dispose that aborted a startup, honored by
    /// the failed startup's own teardown.
    dispose_snapshot: bool,
}

/// Owns one kernel for one session: lazily starts it, memoizes the startup so
/// concurrent callers join the same boot, revives the saved namespace before
/// the runtime bootstrap, and disposes/kill()s on demand.
///
/// Cloning shares the same kernel and startup state.
#[derive(Clone)]
pub struct IpythonKernelProvisioner {
    inner: Arc<ProvisionerInner>,
}

struct ProvisionerInner {
    cwd: PathBuf,
    options: IpythonKernelProvisionerOptions,
    state: Mutex<ProvisionerState>,
    dispose_signal: AbortSignal,
}

impl IpythonKernelProvisioner {
    pub fn new(cwd: impl Into<PathBuf>, options: IpythonKernelProvisionerOptions) -> Self {
        Self {
            inner: Arc::new(ProvisionerInner {
                cwd: cwd.into(),
                options,
                state: Mutex::new(ProvisionerState {
                    manager: None,
                    startup: None,
                    startup_listeners: Vec::new(),
                    last_startup_message: None,
                    last_startup_failure: None,
                    last_restore: None,
                    disposed: false,
                    dispose_snapshot: true,
                }),
                dispose_signal: AbortSignal::new(),
            }),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ProvisionerState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The kernel manager, once a startup has completed successfully.
    pub fn manager(&self) -> Option<ReplKernelManager> {
        self.lock_state().manager.clone()
    }

    /// Result of reviving a prior session's namespace on the last kernel start.
    pub fn last_restore(&self) -> Option<RestoreResult> {
        self.lock_state().last_restore.clone()
    }

    /// Whether a kernel has finished starting and is currently running.
    pub fn has_running_kernel(&self) -> bool {
        self.manager().is_some_and(|m| m.is_running())
    }

    /// Start the kernel in the background. Failures are swallowed here and
    /// surface on the next `ensure()`.
    pub fn prewarm(&self) {
        let provisioner = self.clone();
        tokio::spawn(async move {
            let _ = provisioner.ensure(None, None).await;
        });
    }

    /// The kernel manager, starting it first when necessary. Concurrent
    /// callers join one startup; the current startup stage is replayed to
    /// listeners that attach mid-flight.
    ///
    /// # Errors
    ///
    /// Returns an error when the abort signal is already cancelled or fires
    /// during the wait, when the provisioner was disposed, or when the kernel
    /// startup fails (all joined callers see the same failure).
    pub async fn ensure(
        &self,
        on_progress: Option<KernelBootstrapProgressHandler>,
        signal: Option<AbortSignal>,
    ) -> anyhow::Result<ReplKernelManager> {
        if let Some(signal) = &signal {
            if signal.is_aborted() {
                return Err(anyhow!("Python execution aborted"));
            }
        }
        // The guard is strictly scoped to this decision block: a
        // conditionally-dropped non-Send MutexGuard would make ensure()
        // non-Send.
        let decision = {
            let mut state = self.lock_state();
            if state.disposed {
                return Err(anyhow!("Kernel provisioner disposed"));
            }
            // Only a terminally dead kernel drops the memo; a repairing
            // manager (idle/starting) recovers itself.
            if let Some(manager) = &state.manager {
                if manager.is_defunct() {
                    state.manager = None;
                    state.startup = None;
                }
            }
            if let Some(manager) = state.manager.clone() {
                return Ok(manager);
            }
            state.startup.is_some()
        };
        if decision {
            return self.settled_manager(signal).await;
        }
        {
            let mut state = self.lock_state();
            if let Some(progress) = &on_progress {
                if let Some(message) = state.last_startup_message.as_deref() {
                    progress(message);
                }
                state.startup_listeners.push(progress.clone());
            }
        }
        let task = tokio::spawn(run_startup(Arc::clone(&self.inner), on_progress));
        self.lock_state().startup = Some(task);
        let _ = self.wait_for_startup_task(signal.clone()).await;
        self.settled_manager(signal).await
    }

    /// After the memoized startup task handle: on abort the task keeps
    /// running for other callers, mirroring the TS race-with-abort.
    async fn wait_for_startup_task(&self, signal: Option<AbortSignal>) -> anyhow::Result<()> {
        let Some(task) = self.lock_state().startup.take() else {
            return Ok(());
        };
        race_startup(task, signal).await
    }

    /// After the memoized startup settles, return the manager it produced —
    /// or its error when it failed and nothing superseded it.
    async fn settled_manager(
        &self,
        signal: Option<AbortSignal>,
    ) -> anyhow::Result<ReplKernelManager> {
        if let Some(signal) = signal {
            if signal.is_aborted() {
                return Err(anyhow!("Python execution aborted"));
            }
        }
        let state = self.lock_state();
        match state.manager.clone() {
            Some(manager) => Ok(manager),
            None => match state.last_startup_failure.clone() {
                Some(failure) => Err(anyhow!(
                    "kernel startup failed after {}ms: {}",
                    failure.duration_ms,
                    failure.message
                )),
                None => Err(anyhow!("kernel startup failed")),
            },
        }
    }

    /// Remove live variables above the snapshot's per-variable size limit.
    pub async fn prune_oversized_variables(&self) -> Option<Vec<String>> {
        let manager = self.manager()?;
        manager
            .prune_oversized_variables()
            .await
            .and_then(|r| r.pruned)
    }

    /// Live user-defined names in the kernel namespace, or `None` if listing
    /// failed or no kernel is running.
    pub async fn list_namespace_names(&self, signal: Option<AbortSignal>) -> Option<Vec<String>> {
        let manager = self.manager()?;
        manager.list_namespace_names(signal).await
    }

    /// Dispose the kernel owned by this provisioner, including one still
    /// starting up. A still-queued boot drops out of the boot gate.
    pub async fn dispose(&self, options: Option<KernelShutdownOptions>) {
        let snapshot = options.is_none_or(|o| o.snapshot);
        {
            let mut state = self.lock_state();
            state.dispose_snapshot = snapshot;
            state.disposed = true;
        }
        self.inner.dispose_signal.abort();
        let manager = {
            let mut state = self.lock_state();
            state.manager.take()
        };
        if let Some(manager) = manager {
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot,
                    drain_host_requests: true,
                })
                .await;
        }
    }

    /// Kill the owned kernel without a final snapshot (busy-kernel restart).
    pub async fn kill(&self) {
        let manager = self.lock_state().manager.take();
        if let Some(manager) = manager {
            manager.kill().await;
        }
    }
}

fn emit_startup_progress(
    inner: &Arc<ProvisionerInner>,
    on_progress: &Option<KernelBootstrapProgressHandler>,
    message: &str,
) {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.last_startup_message = Some(message.to_string());
    for listener in &state.startup_listeners {
        listener(message);
    }
    if let Some(on_progress) = on_progress {
        on_progress(message);
    }
}

/// Extra startup attempts beyond the first (one transient-failure retry by
/// default). The promise here is resilience against a wedged boot — a venv
/// python still settling, a slow fork under load — not masking a broken setup.
const DEFAULT_STARTUP_RETRIES: u32 = 1;
const DEFAULT_STARTUP_BUDGET_MS: u64 = 90_000;
const RETRY_BACKOFF_MS: [u64; 4] = [250, 1_000, 2_500, 5_000];

fn resolve_startup_retries() -> u32 {
    match std::env::var("PRIME_AGENT_KERNEL_STARTUP_RETRIES") {
        Ok(raw) => raw
            .trim()
            .parse::<u32>()
            .map_or(DEFAULT_STARTUP_RETRIES, |n| n.min(5)),
        Err(_) => DEFAULT_STARTUP_RETRIES,
    }
}

fn resolve_startup_budget_ms() -> u64 {
    match std::env::var("PRIME_AGENT_KERNEL_STARTUP_BUDGET_MS") {
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .unwrap_or(DEFAULT_STARTUP_BUDGET_MS),
        Err(_) => DEFAULT_STARTUP_BUDGET_MS,
    }
}

/// A failed boot the provisioner may retry on its own: transient spawn or
/// ready-handshake problems. Structural failures (disposed, aborts, a
/// misconfigured interpreter, a protocol mismatch, a failed runtime
/// bootstrap) never auto-retry — each needs either user action or a fresh
/// attempt initiated by the caller.
fn startup_failure_is_retryable(error: &anyhow::Error) -> bool {
    const FATAL_MARKERS: [&str; 8] = [
        "provisioner disposed",
        "aborted",
        "Failed to set up the Python kernel runtime",
        "PRIME_AGENT_KERNEL_PYTHON points to a Python",
        "Failed to initialize rlm runtime",
        "Update prime-agent-runtime in the kernel Python",
        "Kernel start superseded",
        "Kernel was disposed during startup",
    ];
    let chain = format!("{error:#}");
    !FATAL_MARKERS.iter().any(|marker| chain.contains(marker))
}

/// Boot the kernel, retrying transient failures with backoff until the
/// retry allowance or the hard startup budget runs out.
async fn run_startup(
    inner: Arc<ProvisionerInner>,
    on_progress: Option<KernelBootstrapProgressHandler>,
) {
    let started = std::time::Instant::now();
    let budget = std::time::Duration::from_millis(resolve_startup_budget_ms());
    let mut remaining_retries = resolve_startup_retries();
    let mut attempt: u32 = 0;
    let outcome = loop {
        attempt += 1;
        match start_kernel(&inner, &on_progress).await {
            Ok(manager) => break Ok(manager),
            Err(error) => {
                if inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .disposed
                    || !startup_failure_is_retryable(&error)
                    || remaining_retries == 0
                    || started.elapsed() >= budget
                {
                    break Err(error);
                }
                remaining_retries -= 1;
                let backoff_ms =
                    RETRY_BACKOFF_MS[(attempt as usize - 1).min(RETRY_BACKOFF_MS.len() - 1)];
                emit_startup_progress(
                    &inner,
                    &on_progress,
                    &format!("Kernel start failed; retrying in {backoff_ms}ms…"),
                );
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {}
                    () = inner.dispose_signal.cancelled() => break Err(error),
                }
            }
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    let (raced_dispose, dispose_snapshot) = {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.startup = None;
        state.startup_listeners.clear();
        state.last_startup_message = None;
        if let Err(error) = &outcome {
            state.manager = None;
            state.last_startup_failure = Some(StartupFailure {
                message: format!("{error:#}"),
                duration_ms,
            });
        }
        (outcome.is_ok() && state.disposed, state.dispose_snapshot)
    };
    if let Ok(manager) = outcome {
        if raced_dispose {
            // A dispose raced the boot: the kernel must not be parked
            // in — or outlive — a disposed provisioner. TS startKernel
            // runs the whole boot on a dispose-linked abort and its
            // catch tears the kernel down with the dispose's snapshot
            // policy; the Rust boot completes and the teardown follows
            // here with the same policy.
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: dispose_snapshot,
                    drain_host_requests: true,
                })
                .await;
            return;
        }
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.last_startup_failure = None;
        state.manager = Some(manager);
    }
}

async fn race_startup(
    task: tokio::task::JoinHandle<()>,
    signal: Option<AbortSignal>,
) -> anyhow::Result<()> {
    match signal {
        None => {
            let _ = task.await;
            Ok(())
        }
        Some(signal) => {
            tokio::select! {
                _ = task => Ok(()),
                _ = signal.cancelled() => Err(anyhow!("Kernel startup aborted")),
            }
        }
    }
}

/// Boot one kernel, restore the prior namespace, then run the runtime
/// bootstrap. Reports the result through `on_bootstrap_result` once per
/// actual boot (`kernel bootstrap` telemetry): timing starts at the first
/// spawn, `cold` means no prior namespace snapshot existed to restore.
async fn start_kernel(
    inner: &Arc<ProvisionerInner>,
    on_progress: &Option<KernelBootstrapProgressHandler>,
) -> anyhow::Result<ReplKernelManager> {
    let started = std::time::Instant::now();
    let cold = !inner
        .options
        .snapshot_dir
        .as_ref()
        .is_some_and(|dir| snapshot_path_in(dir).exists());
    let result = start_kernel_impl(inner, on_progress).await;
    if let Some(report) = &inner.options.on_bootstrap_result {
        report(KernelBootstrapStats {
            cold,
            duration_ms: started.elapsed().as_millis() as u64,
            outcome: match &result {
                Ok(_) => KernelBootstrapOutcome::Ready,
                Err(_) => KernelBootstrapOutcome::Error,
            },
        });
    }
    result
}

/// The bootstrap itself; see [`start_kernel`].
async fn start_kernel_impl(
    inner: &Arc<ProvisionerInner>,
    on_progress: &Option<KernelBootstrapProgressHandler>,
) -> anyhow::Result<ReplKernelManager> {
    let options = &inner.options;
    let cwd = inner.cwd.clone();
    let dispose_signal = inner.dispose_signal.clone();
    // The boot-permit closure moves its own clone; the bootstrap below runs
    // on the same shared signal.
    let permit_dispose_signal = dispose_signal.clone();
    // Wait for a previous provisioner (e.g. on /reload) to finish disposing —
    // and flushing its final snapshot — before reading that snapshot back.
    if let Some(gate) = options.ready_gate.clone() {
        gate().await;
    }
    let snapshot_dir = options.snapshot_dir.clone();
    let bootstrap_code = build_rlm_bootstrap_code(&options.python_skills);
    let mut env = options.env.clone();
    if let Some(shell_path) = &options.shell_path {
        env.insert(
            "PRIME_AGENT_BASH_SHELL".into(),
            shell_path.to_string_lossy().to_string(),
        );
    }
    if let Some(command_prefix) = &options.command_prefix {
        env.insert(
            "PRIME_AGENT_BASH_COMMAND_PREFIX".into(),
            command_prefix.clone(),
        );
    }
    let snapshot = snapshot_dir.as_ref().map(|dir| KernelSnapshotConfig {
        path: snapshot_path_in(dir),
        manifest_path: manifest_path_in(dir),
        max_bytes: None,
        max_variable_bytes: None,
        debounce_ms: None,
    });
    let stderr_log_path = snapshot_dir
        .as_ref()
        .map(|dir| dir.join("kernel-stderr.log"));
    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: options.python.clone(),
        cwd: Some(cwd),
        env,
        session_id: options.session_id.clone(),
        host_handlers: options.host_handlers.clone(),
        python_skills: options.python_skills.clone(),
        snapshot,
        bootstrap_code: Some(bootstrap_code.clone()),
        stderr_log_path,
    });

    emit_startup_progress(inner, on_progress, "Starting Python kernel...");
    // Only the process spawn + ready handshake contends for OS resources under
    // a fan-out, and it is bounded by start()'s own timeout — so the permit
    // covers only start(). Restore/bootstrap run per-kernel afterwards.
    let start = manager.start(KernelStartOptions {
        signal: None,
        on_bootstrap_progress: on_progress.clone(),
    });
    let boot = async {
        with_kernel_boot_permit(move || async move {
            // Disposed while queued for the permit — don't spawn a kernel nobody wants.
            if permit_dispose_signal.is_aborted() {
                return Err(anyhow!("Kernel provisioner disposed before start"));
            }
            start.await
        })
        .await
    };
    if let Err(error) = boot.await {
        // Never leak the kernel process if startup fails after spawn — and
        // never surface the failure before the teardown (final snapshot flush
        // included) finished.
        let snapshot_policy = {
            inner
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .dispose_snapshot
        };
        let _ = manager
            .shutdown(KernelShutdownOptions {
                snapshot: snapshot_policy,
                drain_host_requests: true,
            })
            .await;
        // The drained stderr tail is the only extra evidence a failed boot
        // leaves behind; attach it to the cause so `ensure()` callers see it.
        // Cap the tail: the in-memory buffer holds up to 8 KiB, but the
        // surfaced error must stay readable.
        let stderr_tail = {
            let tail = manager.kernel_stderr();
            let chars: Vec<char> = tail.chars().collect();
            let start = chars.len().saturating_sub(2048);
            chars[start..].iter().collect::<String>()
        };
        let error = if stderr_tail.trim().is_empty() {
            error.context("kernel start")
        } else {
            error.context(format!(
                "kernel start; kernel stderr tail:
{stderr_tail}"
            ))
        };
        return Err(error);
    }

    // Revive a prior session's namespace before the bootstrap, so the
    // bootstrap then overwrites live handles (rlm, skills) on top of anything restored.
    let mut pending_restore: Option<RestoreResult> = None;
    if let Some(dir) = &snapshot_dir {
        let snapshot_existed = snapshot_path_in(dir).exists();
        emit_startup_progress(inner, on_progress, "Restoring Python state...");
        let restore = manager.restore_state().await;
        if snapshot_existed {
            pending_restore = Some(restore.unwrap_or_default());
        }
    }
    emit_startup_progress(inner, on_progress, "Preparing Python runtime...");
    // The bootstrap runs on the dispose signal (TS startKernel races every
    // boot stage against the dispose-linked abort): a dispose mid-bootstrap
    // settles the cell aborted, and the aborted-status arm below tears the
    // kernel down instead of leaking it into a disposed provisioner.
    let bootstrap = manager
        .execute(
            &bootstrap_code,
            ExecuteOptions {
                signal: Some(dispose_signal.clone()),
                // The skill-import report rides stdout at the END of the
                // cell (after any module-init noise): keep the cap high
                // enough that imported skills' import-time output cannot
                // push it out of the buffer.
                max_output_chars: Some(262_144),
                ..Default::default()
            },
        )
        .await;
    match bootstrap {
        Ok(bootstrap) if bootstrap.status == ExecuteStatus::Ok && dispose_signal.is_aborted() => {
            // The cell completed, but the provisioner was disposed under it:
            // the same teardown as the aborted-status arm, with the honest
            // disposed-startup cause (TS startKernel's abort error).
            let snapshot_policy = {
                inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .dispose_snapshot
            };
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: snapshot_policy,
                    drain_host_requests: true,
                })
                .await;
            return Err(anyhow!("Kernel provisioner disposed during startup"));
        }
        Ok(bootstrap) if bootstrap.status == ExecuteStatus::Ok => {
            // Broken skills stay importable-looking placeholders; report them
            // so the model learns before its first call, not from the
            // placeholder's error (TS startKernel parses the same marker).
            if let Some(errors) =
                crate::session_engine::python_skills_notice::parse_unavailable_python_skills(
                    &bootstrap.stdout,
                )
            {
                if let Some(on_unavailable_skills) = &inner.options.on_unavailable_skills {
                    on_unavailable_skills(&errors);
                }
            }
        }
        Ok(bootstrap) => {
            let details = [bootstrap.stderr.clone()]
                .into_iter()
                .chain(bootstrap.error.iter().map(|e| e.traceback.join("\n")))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            // TS startKernel's catch shuts the failed boot down with the
            // dispose snapshot policy (default true), not `false`.
            let snapshot_policy = {
                inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .dispose_snapshot
            };
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: snapshot_policy,
                    drain_host_requests: true,
                })
                .await;
            return Err(anyhow!(
                "Failed to initialize rlm runtime in the Python kernel:\n{details}"
            ));
        }
        Err(error) => {
            let snapshot_policy = {
                inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .dispose_snapshot
            };
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: snapshot_policy,
                    drain_host_requests: true,
                })
                .await;
            return Err(error);
        }
    }

    // Only tell the model what was revived once the kernel is actually usable —
    // a notice claiming restored state must never outlive a failed bootstrap.
    if let Some(restore) = pending_restore {
        if let Some(on_restore) = &inner.options.on_restore {
            on_restore(&restore);
        }
        inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_restore = Some(restore);
    }
    Ok(manager)
}

/// Same as [`IpythonKernelProvisioner::new`] for a `Path`-shaped cwd.
pub fn provisioner_for_path(
    cwd: &Path,
    options: IpythonKernelProvisionerOptions,
) -> IpythonKernelProvisioner {
    IpythonKernelProvisioner::new(cwd.to_path_buf(), options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_concurrency_defaults_and_override() {
        let default = default_kernel_boot_concurrency();
        assert!(default >= 4);
        std::env::set_var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS", "2");
        assert_eq!(resolve_kernel_boot_concurrency(), 2);
        std::env::set_var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS", "0");
        assert_eq!(resolve_kernel_boot_concurrency(), default);
        std::env::set_var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS", "junk");
        assert_eq!(resolve_kernel_boot_concurrency(), default);
        std::env::set_var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS", "1000");
        assert_eq!(resolve_kernel_boot_concurrency(), 64);
        std::env::remove_var("PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS");
    }

    #[tokio::test]
    async fn ensure_rejects_aborted_signal() {
        let provisioner =
            IpythonKernelProvisioner::new("/tmp", IpythonKernelProvisionerOptions::default());
        let error = provisioner
            .ensure(None, Some(AbortSignal::aborted()))
            .await
            .expect_err("aborted startup must reject");
        assert!(error.to_string().contains("aborted"));
    }

    #[tokio::test]
    async fn dispose_then_ensure_fails() {
        let provisioner =
            IpythonKernelProvisioner::new("/tmp", IpythonKernelProvisionerOptions::default());
        provisioner.dispose(None).await;
        let error = provisioner
            .ensure(None, None)
            .await
            .expect_err("disposed provisioner");
        assert!(error.to_string().contains("disposed"));
    }

    #[test]
    fn retryable_failure_classification() {
        assert!(startup_failure_is_retryable(&anyhow!(
            "failed to spawn kernel python /x"
        )));
        assert!(startup_failure_is_retryable(&anyhow!(
            "Kernel did not become ready within 30000ms. stderr tail: ..."
        )));
        assert!(!startup_failure_is_retryable(&anyhow!(
            "Kernel provisioner disposed before start"
        )));
        assert!(!startup_failure_is_retryable(&anyhow!(
            "Python execution aborted"
        )));
        assert!(!startup_failure_is_retryable(&anyhow!(
            "PRIME_AGENT_KERNEL_PYTHON points to a Python missing a current prime-agent-runtime: /bad"
        )));
        assert!(!startup_failure_is_retryable(&anyhow!(
            "Kernel runtime speaks protocol 2, expected 3. \
             Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent."
        )));
    }

    #[tokio::test]
    async fn startup_failure_surfaces_cause_and_duration() {
        let options = IpythonKernelProvisionerOptions {
            python: Some(PathBuf::from("/nonexistent/kernel-python-for-test")),
            ..Default::default()
        };
        let provisioner = IpythonKernelProvisioner::new("/tmp", options);
        let error = provisioner
            .ensure(None, None)
            .await
            .expect_err("bogus python must fail");
        let message = format!("{error:#}");
        assert!(
            message.contains("kernel startup failed after "),
            "error must carry the duration: {message}"
        );
        assert!(
            message.contains("ms: "),
            "error must carry the duration unit: {message}"
        );
        assert!(
            message.contains("failed to spawn"),
            "error must carry the spawn cause: {message}"
        );
        // The next ensure() retries fresh rather than rethrowing the memo.
        assert!(provisioner.ensure(None, None).await.is_err());
    }

    #[tokio::test]
    async fn startup_retries_transient_failure() {
        // One retry (the default), so the bogus-python boot fails twice and
        // the backoff (>= 250ms) shows up in the elapsed time.
        let started = std::time::Instant::now();
        let options = IpythonKernelProvisionerOptions {
            python: Some(PathBuf::from("/nonexistent/kernel-python-for-test")),
            ..Default::default()
        };
        let provisioner = IpythonKernelProvisioner::new("/tmp", options);
        assert!(provisioner.ensure(None, None).await.is_err());
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(250),
            "the retry backoff must elapse before the failure surfaces"
        );
    }

    #[tokio::test]
    async fn startup_retry_cancelled_by_dispose() {
        let options = IpythonKernelProvisionerOptions {
            python: Some(PathBuf::from("/nonexistent/kernel-python-for-test")),
            ..Default::default()
        };
        let provisioner = IpythonKernelProvisioner::new("/tmp", options);
        let p = provisioner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            p.dispose(None).await;
        });
        // The boot fails; the dispose cancels any pending retry, so ensure()
        // settles without hanging on the backoff chain.
        let started = std::time::Instant::now();
        let _ = provisioner.ensure(None, None).await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "dispose during retry must cancel the backoff promptly"
        );
    }

    #[tokio::test]
    async fn clone_shares_kernel_state() {
        let provisioner =
            IpythonKernelProvisioner::new("/tmp", IpythonKernelProvisionerOptions::default());
        let clone = provisioner.clone();
        provisioner.dispose(None).await;
        assert!(clone.ensure(None, None).await.is_err());
    }

    /// The prewarm contract (TS `prewarm(): void this.ensure().catch(() =>
    /// {})`): a background boot never surfaces its failure at the call site,
    /// and the swallowed failure stays recoverable — the next `ensure()` runs
    /// (and surfaces) a fresh attempt, the lazy first-call start.
    #[tokio::test]
    async fn prewarm_swallows_failure_and_keeps_lazy_fallback() {
        let options = IpythonKernelProvisionerOptions {
            python: Some(PathBuf::from("/nonexistent/kernel-python-for-test")),
            ..Default::default()
        };
        let provisioner = IpythonKernelProvisioner::new("/tmp", options);
        // Returns immediately; the background boot fails on its own.
        provisioner.prewarm();
        // Let the background startup settle into its failure.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            !provisioner.has_running_kernel(),
            "the failed prewarm must not leave a running kernel"
        );
        // The next ensure() surfaces the prewarm's swallowed cause (or a
        // fresh attempt's identical one) instead of hanging on the memo.
        let error = provisioner
            .ensure(None, None)
            .await
            .expect_err("the bogus python must fail ensure too");
        assert!(
            format!("{error:#}").contains("failed to spawn"),
            "ensure must surface the spawn cause: {error:#}"
        );
    }
}
