//! The per-session kernel provisioner: owns one kernel manager, guards its
//! startup, revives the saved namespace before the runtime bootstrap, and
//! disposes/kills on demand. Reader tasks hold only weak references, so no
//! kernel outlives its provisioner; `dispose()` flushes the snapshot first.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use tokio::sync::{mpsc, oneshot};

use crate::kernel::bootstrap::{
    build_rlm_bootstrap_code, parse_unavailable_python_skills, KernelBootstrapProgressHandler,
    KernelPythonSkill, UnavailablePythonSkills,
};
use crate::kernel::cancellation::AbortSignal;
use crate::kernel::manager::{KernelStartOptions, ReplKernelManager};
use crate::kernel::shared::ExecuteStatus;
use crate::kernel::shared::{
    ExecuteOptions, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
    KernelSnapshotConfig, BASH_COMPLETED_REQUEST_TYPE, BOOTSTRAP_EXECUTION_TIMEOUT_MS,
};
use crate::kernel::state_snapshot::RestoreResult;
use crate::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

mod owner;

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

/// Publishes the restore outcome once the kernel is usable.
pub type RestoreCallback = Arc<dyn Fn(&RestoreResult) + Send + Sync>;

/// Publishes the skills that failed to import into a freshly started
/// kernel (import name -> import error), once the kernel is usable.
pub type UnavailableSkillsCallback = Arc<dyn Fn(&UnavailablePythonSkills) + Send + Sync>;

/// Outcome of one full kernel bootstrap (spawn + handshake + namespace
/// restore + runtime bootstrap), reported once per actual boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelBootstrapOutcome {
    /// The kernel process is running, revived, and runtime-bootstrapped.
    Ready,
    /// Any stage failed; the kernel was torn down before the error surfaced.
    Error,
}

/// One kernel boot's facts for the `kernel_bootstrap_*` session counters.
#[derive(Debug, Clone, Copy)]
pub struct KernelBootstrapStats {
    /// No prior namespace snapshot existed to restore (fresh session vs a
    /// revived one).
    pub cold: bool,
    pub outcome: KernelBootstrapOutcome,
    /// Wall time of the whole bootstrap, milliseconds.
    pub duration_ms: u64,
}

/// Reports kernel bootstrap results (the `kernel_bootstrap_*` session counters).
pub type KernelBootstrapResultHandler = Arc<dyn Fn(KernelBootstrapStats) + Send + Sync>;

#[derive(Default, Clone)]
pub struct IpythonKernelProvisionerOptions {
    /// Python override. Must have prime-agent-runtime installed.
    pub python: Option<PathBuf>,
    /// Default time limit for user `python_repl` cells, in milliseconds
    /// (`None`: never armed; `0`: disabled). The daemon engine resolves it
    /// from settings and disarms it for daemonless sessions; a cell's own
    /// `timeout` argument replaces it. The runtime bootstrap and internal
    /// state ops never arm it.
    pub cell_timeout_ms: Option<u64>,
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
    /// Fires when the kernel's last live background `bash()` handle
    /// settles, so owed continuations can resume.
    pub on_background_work_settled: Option<crate::kernel::shared::BackgroundWorkSettledCallback>,
    /// Fires once per kernel start when installed Python skills failed to import into the kernel,
    /// so the session can tell the model before it wastes turns calling them.
    pub on_unavailable_skills: Option<UnavailableSkillsCallback>,
    /// Publishes the per-boot result for the `kernel_bootstrap_*` counters.
    /// Telemetry only; kernel behavior never depends on it.
    pub on_bootstrap_result: Option<KernelBootstrapResultHandler>,
}

/// Why and how long one startup failed, published to every joined `ensure()`
/// caller so they see the same cause and duration instead of a bare "kernel
/// startup failed".
#[derive(Clone)]
struct StartupFailure {
    /// Full error chain (`{:#}` formatting).
    message: String,
    duration_ms: u64,
}

/// Owns one kernel for one session: starts it, memoizes the startup so concurrent callers join the
/// same boot.
///
/// Cloning shares the same kernel and startup state.
#[derive(Clone)]
pub struct IpythonKernelProvisioner {
    inner: Arc<ProvisionerInner>,
}

struct ProvisionerInner {
    cwd: PathBuf,
    options: IpythonKernelProvisionerOptions,
    /// Written only by the owner task (see [`owner`]); the getters read it.
    state: Arc<Mutex<owner::OwnerState>>,
    commands: mpsc::UnboundedSender<owner::Command>,
    /// The owner's inbox until the first command spawns the owner task.
    inbox: Mutex<Option<mpsc::UnboundedReceiver<owner::Command>>>,
    dispose_signal: AbortSignal,
}

impl IpythonKernelProvisioner {
    pub fn new(cwd: impl Into<PathBuf>, options: IpythonKernelProvisionerOptions) -> Self {
        let (commands, inbox) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(ProvisionerInner {
                cwd: cwd.into(),
                options,
                state: Arc::new(Mutex::new(owner::OwnerState::new())),
                commands,
                inbox: Mutex::new(Some(inbox)),
                dispose_signal: AbortSignal::new(),
            }),
        }
    }

    fn send(&self, command: owner::Command) {
        if let Some(inbox) = owner::lock(&self.inner.inbox).take() {
            tokio::spawn(owner::run(
                Arc::downgrade(&self.inner),
                Arc::clone(&self.inner.state),
                inbox,
            ));
        }
        let _ = self.inner.commands.send(command);
    }

    /// The kernel manager, once a startup has completed successfully.
    #[must_use]
    pub fn manager(&self) -> Option<ReplKernelManager> {
        owner::lock(&self.inner.state).manager()
    }

    /// The default time limit the kernel executor arms for user cells
    /// (`None`: never armed).
    #[must_use]
    pub fn cell_timeout_ms(&self) -> Option<u64> {
        self.inner.options.cell_timeout_ms
    }

    /// The Python skills pre-imported at kernel bootstrap.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn python_skills(&self) -> &[KernelPythonSkill] {
        &self.inner.options.python_skills
    }

    /// Result of reviving a prior session's namespace on the last kernel start.
    #[must_use]
    pub fn last_restore(&self) -> Option<RestoreResult> {
        owner::lock(&self.inner.state).last_restore()
    }

    /// Whether a kernel has finished starting and is currently running.
    #[must_use]
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

    /// The kernel manager, starting it first when necessary. Concurrent callers join one startup.
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
        let (joined, stage) = oneshot::channel();
        let (reply, settled) = oneshot::channel();
        self.send(owner::Command::Ensure {
            progress: on_progress.clone(),
            joined,
            reply,
        });
        let wait = async {
            // A joiner hears the boot's current stage first.
            if let Some(progress) = &on_progress {
                if let Ok(Some(message)) = stage.await {
                    progress(&message);
                }
            }
            settled.await
        };
        // Aborting one waiter leaves the shared startup alive for other
        // callers, like TS raceWithAbort(managerPromise, signal).
        let settled = match &signal {
            Some(signal) => tokio::select! {
                settled = wait => settled,
                () = signal.cancelled() => return Err(anyhow!("Python execution aborted")),
            },
            None => wait.await,
        };
        if let Some(signal) = &signal {
            if signal.is_aborted() {
                return Err(anyhow!("Python execution aborted"));
            }
        }
        settled.map_err(|error| anyhow!("kernel startup task closed: {error}"))?
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

    /// Stop the owned kernel without marking the provisioner disposed (TS
    /// #2483's `stopKernel`): the shutdown flushes the final snapshot, and
    /// the next `ensure()` boots a fresh kernel only after that flush, so a
    /// follow-up turn revives from the flushed snapshot instead of racing the
    /// flush over the same on-disk file. A kernel still starting up is joined
    /// first and shut down the same way; with neither a live kernel nor an
    /// in-flight boot there is nothing to stop. Concurrent stops return in the
    /// order they were armed.
    ///
    /// Best-effort by construction: a failed shutdown leaves no manager
    /// and the next `ensure()` boots fresh.
    pub async fn stop_kernel(&self, options: Option<KernelShutdownOptions>) {
        let (done, stopped) = oneshot::channel();
        self.send(owner::Command::Stop {
            snapshot: options.is_none_or(|o| o.snapshot),
            done,
        });
        let _ = stopped.await;
    }

    /// Dispose the provisioner: waits the in-flight boots (including ones
    /// `kill()` invalidated), then shuts the kernel down with this dispose's
    /// snapshot policy. Every later `ensure()` fails.
    pub async fn dispose(&self, options: Option<KernelShutdownOptions>) {
        let (done, disposed) = oneshot::channel();
        self.send(owner::Command::Dispose {
            snapshot: options.is_none_or(|o| o.snapshot),
            done,
        });
        let _ = disposed.await;
    }

    /// Kill the owned kernel without a final snapshot (busy-kernel restart).
    /// A kernel still starting up is invalidated instead: its boot kills its own
    /// kernel when it settles, and the next `ensure()` boots fresh. Returns before
    /// the owner ran the kill; every later command sees it.
    pub fn kill(&self) {
        self.send(owner::Command::Kill { done: None });
    }

    /// Like [`Self::kill`], resolving once the owner has run it.
    pub async fn kill_and_wait(&self) {
        let (done, killed) = oneshot::channel();
        self.send(owner::Command::Kill { done: Some(done) });
        let _ = killed.await;
    }
}

/// Extra startup attempts beyond the first. The promise here is resilience against a wedged boot,
/// not masking a broken setup.
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
/// ready-handshake problems. Structural failures never auto-retry.
fn startup_failure_is_retryable(error: &anyhow::Error) -> bool {
    const FATAL_MARKERS: [&str; 9] = [
        "provisioner disposed",
        "provisioner killed",
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
/// retry allowance or the hard startup budget runs out. Returns the booted
/// manager with the boot's duration, or the failure; the publisher task's
/// atomic settle decides whether the manager may park.
async fn run_startup(
    inner: Arc<ProvisionerInner>,
    boot: owner::BootHandle,
) -> Result<(ReplKernelManager, u64), StartupFailure> {
    let started = std::time::Instant::now();
    let budget = std::time::Duration::from_millis(resolve_startup_budget_ms());
    let mut remaining_retries = resolve_startup_retries();
    let mut attempt: u32 = 0;
    let outcome = loop {
        attempt += 1;
        match start_kernel(&inner, &boot).await {
            Ok(manager) => break Ok(manager),
            Err(error) => {
                // A boot whose generation kill() invalidated must not retry: each attempt
                // spawns an interpreter and runs restore/bootstrap, and a
                // stale attempt's restore would surface notifications and
                // state a fresher generation never asked for.
                if !boot.is_live(&inner.dispose_signal)
                    || !startup_failure_is_retryable(&error)
                    || remaining_retries == 0
                    || started.elapsed() >= budget
                {
                    break Err(error);
                }
                remaining_retries -= 1;
                let backoff_ms =
                    RETRY_BACKOFF_MS[(attempt as usize - 1).min(RETRY_BACKOFF_MS.len() - 1)];
                boot.emit(&format!("Kernel start failed; retrying in {backoff_ms}ms…"))
                    .await;
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {}
                    () = inner.dispose_signal.cancelled() => break Err(error),
                }
                // Re-check after the backoff: kill() can invalidate the
                // generation while this task sleeps it out.
                if !boot.is_live(&inner.dispose_signal) {
                    break Err(error);
                }
            }
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    // The settle (disposed check, generation check, park-or-reject) is the
    // owner's; this task only reports the boot's own outcome and duration.
    match outcome {
        Ok(manager) => Ok((manager, duration_ms)),
        Err(error) => Err(StartupFailure {
            message: format!("{error:#}"),
            duration_ms,
        }),
    }
}

/// Boot one kernel, restore the prior namespace, then run the runtime bootstrap. Reports the result
/// through `on_bootstrap_result` once per actual boot.
async fn start_kernel(
    inner: &Arc<ProvisionerInner>,
    boot: &owner::BootHandle,
) -> anyhow::Result<ReplKernelManager> {
    let started = std::time::Instant::now();
    let cold = !inner
        .options
        .snapshot_dir
        .as_ref()
        .is_some_and(|dir| snapshot_path_in(dir).exists());
    let result = start_kernel_impl(inner, boot).await;
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
    boot: &owner::BootHandle,
) -> anyhow::Result<ReplKernelManager> {
    let options = &inner.options;
    let cwd = inner.cwd.clone();
    let dispose_signal = inner.dispose_signal.clone();
    // The boot-permit closure moves its own clone; the bootstrap below runs
    // on the same shared signal.
    let permit_dispose_signal = dispose_signal.clone();
    // Wait for this provisioner's own in-flight stop_kernel() — and its
    // final snapshot flush — before reading that snapshot back (TS #2483's
    // `pendingStop` gate). `ready_gate` stays the cross-provisioner /reload arm.
    boot.wait_for_gates().await;
    // Wait for a previous provisioner (e.g. on /reload) to finish disposing —
    // and flushing its final snapshot — before reading that snapshot back.
    if let Some(gate) = options.ready_gate.clone() {
        gate().await;
    }
    let snapshot_dir = options.snapshot_dir.clone();
    // The bounded-await default keys on the bash.completed host handler:
    // one source of truth (the registry the daemon registers the notice in).
    let bootstrap_code = build_rlm_bootstrap_code(
        &options.python_skills,
        options
            .host_handlers
            .get(BASH_COMPLETED_REQUEST_TYPE)
            .is_some(),
    );
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
        on_background_work_settled: options.on_background_work_settled.clone(),
        snapshot,
        bootstrap_code: Some(bootstrap_code.clone()),
        stderr_log_path,
    });

    boot.emit("Starting Python kernel...").await;
    // Only the process spawn + ready handshake contends for OS resources under
    // a fan-out, and it is bounded by start()'s own timeout — so the permit
    // covers only start(). Restore/bootstrap run per-kernel afterwards.
    let start = manager.start(KernelStartOptions {
        signal: None,
        on_bootstrap_progress: boot.progress().cloned(),
    });
    let permit_boot = boot.clone();
    let spawn = async {
        with_kernel_boot_permit(move || async move {
            // Disposed, or its generation kill() invalidated, while
            // queued for the permit — don't spawn a kernel nobody wants.
            // The permit frees after the stop/ready gates below, so a boot
            // that waited those gates rechecks liveness here, the last
            // point before the interpreter spawn.
            if permit_dispose_signal.is_aborted() {
                return Err(anyhow!("Kernel provisioner disposed before start"));
            }
            if !permit_boot.is_live(&permit_dispose_signal) {
                return Err(anyhow!("Kernel provisioner killed before start"));
            }
            start.await
        })
        .await
    };
    if let Err(error) = spawn.await {
        // Never leak the kernel process if startup fails after spawn — and
        // never surface the failure before the teardown (final snapshot flush
        // included) finished.
        let (snapshot_policy, _teardown_gate) = boot.teardown_policy().await;
        let _ = manager
            .shutdown(KernelShutdownOptions {
                snapshot: snapshot_policy,
                drain_host_requests: true,
            })
            .await;
        // The drained stderr tail is the only extra evidence a failed boot
        // leaves; attach it to the cause.
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
    let mut snapshot_existed = false;
    if let Some(dir) = &snapshot_dir {
        snapshot_existed = snapshot_path_in(dir).exists();
        boot.emit("Restoring Python state...").await;
        let restore = manager.restore_state().await;
        if snapshot_existed {
            pending_restore = Some(restore.unwrap_or_default());
        }
    }
    boot.emit("Preparing Python runtime...").await;
    // The bootstrap runs on the dispose signal (TS startKernel races every
    // boot stage against the dispose-linked abort): a dispose mid-bootstrap
    // settles the cell aborted, and the aborted-status arm below tears the
    // kernel down instead of leaking it into a disposed provisioner.
    let bootstrap = manager
        .execute_bounded(
            &bootstrap_code,
            ExecuteOptions {
                signal: Some(dispose_signal.clone()),
                ..Default::default()
            },
            Some(BOOTSTRAP_EXECUTION_TIMEOUT_MS),
        )
        .await;
    match bootstrap {
        Ok(bootstrap) if bootstrap.status == ExecuteStatus::Ok && dispose_signal.is_aborted() => {
            // The cell completed, but the provisioner was disposed under it:
            // the same teardown as the aborted-status arm, with the honest
            // disposed-startup cause (TS startKernel's abort error).
            let (snapshot_policy, _teardown_gate) = boot.teardown_policy().await;
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: snapshot_policy,
                    drain_host_requests: true,
                })
                .await;
            return Err(anyhow!("Kernel provisioner disposed during startup"));
        }
        Ok(bootstrap) if bootstrap.status == ExecuteStatus::Ok => {
            if snapshot_existed {
                // The just-restored namespace is fresh: the debounced
                // auto-snapshot would rewrite identical content.
                manager.mark_restored_namespace_fresh();
            }
            // Broken skill imports stay importable-looking placeholders;
            // report them so the model learns before its first call, not
            // from the placeholder's error (TS startKernel) - but only a
            // LIVE generation may report (the owner checks): the callback
            // shares the restore notice's mailbox, and a boot kill()
            // invalidated must not append stale skills-unavailable rows.
            if let Some(errors) = parse_unavailable_python_skills(&bootstrap.stdout) {
                boot.send(owner::Command::UnavailableSkills {
                    generation: boot.generation,
                    errors,
                });
            }
        }
        Ok(bootstrap) => {
            // The kernel booted but its runtime did not initialize: the venv is the prime suspect,
            // so drop the memoized runtime-ready result.
            crate::kernel::bootstrap::invalidate_runtime_probe_cache();
            let details = [bootstrap.stderr.clone()]
                .into_iter()
                .chain(bootstrap.error.iter().map(|e| e.traceback.join("\n")))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            // TS startKernel's catch shuts the failed boot down with the
            // dispose snapshot policy (default true), not `false`.
            let (snapshot_policy, _teardown_gate) = boot.teardown_policy().await;
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: snapshot_policy,
                    drain_host_requests: true,
                })
                .await;
            // An aborted bootstrap with a live dispose signal is the bound
            // firing on a kernel that stopped answering: name the lost
            // bootstrap instead of a bare runtime failure.
            let error = if bootstrap.status == ExecuteStatus::Aborted
                && !dispose_signal.is_aborted()
            {
                anyhow!(
                    "Failed to initialize rlm runtime in the Python kernel: \
                     the runtime bootstrap did not finish within {BOOTSTRAP_EXECUTION_TIMEOUT_MS}ms:\n{details}"
                )
            } else {
                anyhow!("Failed to initialize rlm runtime in the Python kernel:\n{details}")
            };
            return Err(error);
        }
        Err(error) => {
            let (snapshot_policy, _teardown_gate) = boot.teardown_policy().await;
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
    // a notice claiming restored state must never outlive a failed bootstrap,
    // and only a LIVE generation may surface it (the owner checks): a boot
    // kill() invalidated restores its snapshot only for the settle to kill its
    // kernel, so its restore must not fire the notification nor pollute
    // last_restore for the fresher generation.
    if let Some(restore) = pending_restore {
        boot.send(owner::Command::Restored {
            generation: boot.generation,
            restore,
        });
    }
    Ok(manager)
}

/// Same as [`IpythonKernelProvisioner::new`] for a `Path`-shaped cwd.
#[must_use]
pub fn provisioner_for_path(
    cwd: &Path,
    options: IpythonKernelProvisionerOptions,
) -> IpythonKernelProvisioner {
    IpythonKernelProvisioner::new(cwd.to_path_buf(), options)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell file the resolver accepts: existing, and executable on unix.
    fn executable_shell(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// The scripted session both shell-setting tests build: a model and
    /// `stream_fn` the settings validation never reaches, no kernel prewarm.
    async fn shell_test_session(
        cwd: PathBuf,
        agent_dir: PathBuf,
    ) -> anyhow::Result<crate::session_engine::engine::SessionEngine> {
        use crate::session_engine::engine::{create_session, SessionEngineConfig};

        let model = pa_agent::types::Model {
            id: "shell-test".into(),
            name: "Shell test".into(),
            api: "test".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            cost: pa_agent::types::UsageCost::default(),
            context_window: 1_000,
            max_tokens: 100,
            max_tokens_explicit: false,
        };
        let provider = Arc::new(pa_agent::scripted::ScriptedProvider::new(model.clone()));
        create_session(SessionEngineConfig {
            cwd,
            agent_dir,
            model: Some(model),
            stream_fn: Some(provider.stream_fn()),
            prewarm_ipython_kernel: Some(false),
            ..Default::default()
        })
        .await
    }

    #[tokio::test]
    async fn session_settings_reach_the_kernel_shell() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        // Project settings override the global setting before the session captures it.
        let global = executable_shell(dir.path(), "global-bash");
        let project = executable_shell(dir.path(), "project-bash");
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({ "shellPath": global.to_string_lossy() }).to_string(),
        )
        .unwrap();
        std::fs::write(
            cwd.join(".prime/agent/settings.json"),
            serde_json::json!({ "shellPath": format!("  {}  ", project.to_string_lossy()) })
                .to_string(),
        )
        .unwrap();
        let engine = shell_test_session(cwd, agent_dir).await.unwrap();
        assert_eq!(engine.provisioner.inner.options.shell_path, Some(project));
    }

    #[tokio::test]
    async fn session_settings_reach_the_kernel_command_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({ "shellCommandPrefix": "shopt -s expand_aliases" }).to_string(),
        )
        .unwrap();
        let engine = shell_test_session(cwd, agent_dir).await.unwrap();
        assert_eq!(
            engine.provisioner.inner.options.command_prefix.as_deref(),
            Some("shopt -s expand_aliases")
        );
    }

    #[tokio::test]
    async fn a_stored_serper_key_reaches_the_kernel_env() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            r#"{ "serper": { "type": "api_key", "key": "!printf key-from-cmd" } }"#,
        )
        .unwrap();
        let engine = shell_test_session(cwd, agent_dir).await.unwrap();
        let injected = engine
            .provisioner
            .inner
            .options
            .env
            .get("SERPER_API_KEY")
            .map(String::as_str);
        // A nonblank ambient SERPER_API_KEY wins (TS parity): the ambient key
        // reaches the kernel through the inherited env, not the wiring.
        if std::env::var("SERPER_API_KEY").is_ok_and(|value| !value.trim().is_empty()) {
            assert_eq!(injected, None);
        } else {
            assert_eq!(injected, Some("key-from-cmd"));
        }
    }

    #[tokio::test]
    async fn an_unsaved_session_blanks_the_kernel_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        let engine = shell_test_session(cwd, agent_dir).await.unwrap();
        assert_eq!(
            engine
                .provisioner
                .inner
                .options
                .env
                .get("RLM_SESSION_ID")
                .map(String::as_str),
            Some(""),
            "an inherited RLM_SESSION_ID must not reach an unsaved session's kernel"
        );
    }

    #[tokio::test]
    async fn without_a_websearch_skill_no_serper_key_env() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({ "bundledSkills": { "websearch": false } }).to_string(),
        )
        .unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            r#"{ "serper": { "type": "api_key", "key": "!printf key-from-cmd" } }"#,
        )
        .unwrap();
        let engine = shell_test_session(cwd, agent_dir).await.unwrap();
        assert!(
            !engine
                .provisioner
                .inner
                .options
                .env
                .contains_key("SERPER_API_KEY"),
            "the key rides the env only when a websearch skill is loaded"
        );
    }

    #[tokio::test]
    async fn session_settings_reject_a_missing_shell_path() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("project");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        let missing = cwd.join("no-such-shell");
        std::fs::write(
            cwd.join(".prime/agent/settings.json"),
            serde_json::json!({ "shellPath": missing.to_string_lossy() }).to_string(),
        )
        .unwrap();
        let Err(err) = shell_test_session(cwd, agent_dir).await else {
            panic!("create_session must reject a missing shellPath");
        };
        let message = err.to_string();
        assert!(
            message.contains("shellPath"),
            "error names the setting: {message}"
        );
        assert!(
            message.contains(missing.to_string_lossy().as_ref()),
            "error names the path: {message}"
        );
    }

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
            "Kernel provisioner killed before start"
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

    #[tokio::test]
    async fn prewarm_swallows_failure_and_keeps_lazy_fallback() {
        let options = IpythonKernelProvisionerOptions {
            python: Some(PathBuf::from("/nonexistent/kernel-python-for-test")),
            ..Default::default()
        };
        let provisioner = IpythonKernelProvisioner::new("/tmp", options);
        provisioner.prewarm();
        // Let the background startup settle into its failure.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            !provisioner.has_running_kernel(),
            "the failed prewarm must not leave a running kernel"
        );
        // The next ensure() surfaces the swallowed cause, not a memo hang.
        let error = provisioner
            .ensure(None, None)
            .await
            .expect_err("the bogus python must fail ensure too");
        assert!(
            format!("{error:#}").contains("failed to spawn"),
            "ensure must surface the spawn cause: {error:#}"
        );
    }

    /// A ready kernel that stops reading stdin must not wedge its bootstrap
    /// request or the failed boot's shutdown behind a full pipe.
    #[cfg(unix)]
    #[tokio::test]
    async fn nonreading_kernel_fails_bootstrap_without_parking_shutdown() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("ready-but-not-reading");
        std::fs::write(
            &python,
            "#!/usr/bin/env python3\nimport json, time\nprint(json.dumps({'event': 'ready', 'protocol': 3, 'python': '3.13.0'}), flush=True)\ntime.sleep(30)\n",
        )
        .expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        let provisioner = IpythonKernelProvisioner::new(
            dir.path(),
            IpythonKernelProvisionerOptions {
                python: Some(python),
                python_skills: vec![KernelPythonSkill {
                    name: "oversized".into(),
                    import_name: "x".repeat(1024 * 1024),
                    package_path: dir.path().into(),
                    pyproject_path: dir.path().join("pyproject.toml"),
                }],
                ..Default::default()
            },
        );
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(9),
            provisioner.ensure(None, None),
        )
        .await
        .expect("timed out bootstrap must not park during failed-boot cleanup")
        .expect_err("kernel never reads bootstrap");
        assert!(format!("{error:#}").contains("runtime bootstrap did not finish"));
        assert!(!provisioner.has_running_kernel());
    }

    /// A kernel that answers the ready handshake but never answers the
    /// bootstrap execute (the wedged-kernel shape: the frame is lost inside
    /// the kernel) fails `ensure` with the bound's message instead of parking
    /// forever, tears its kernel down, and does not auto-retry the fatal
    /// failure.
    #[cfg(unix)]
    #[tokio::test]
    async fn silent_bootstrap_fails_bounded_and_leaves_no_kernel() {
        use std::os::unix::fs::PermissionsExt;

        // Speaks protocol v3: answers the ready handshake, stays silent on
        // every execute (the runtime bootstrap included), and answers the
        // shutdown frame so a teardown does not wait out its kill deadline.
        const SILENT_BOOTSTRAP_RUNTIME: &str = r#"#!/usr/bin/env python3
import json
import os
import sys

base = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(base, "starts"), "a") as f:
    f.write("x")
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "shutdown":
        print(json.dumps({"event": "done", "id": req.get("id"), "status": "ok"}), flush=True)
        break
"#;

        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("fake-kernel");
        std::fs::write(&python, SILENT_BOOTSTRAP_RUNTIME).expect("write fake runtime");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake runtime");
        let provisioner = IpythonKernelProvisioner::new(
            dir.path(),
            IpythonKernelProvisionerOptions {
                python: Some(python),
                ..Default::default()
            },
        );

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            provisioner.ensure(None, None),
        )
        .await
        .expect("the bounded bootstrap must settle the boot")
        .expect_err("a kernel that never answers the bootstrap must not report success");
        let chain = format!("{outcome:#}");
        assert!(
            chain.contains("Failed to initialize rlm runtime"),
            "{chain}"
        );
        assert!(
            chain.contains(&format!(
                "the runtime bootstrap did not finish within {BOOTSTRAP_EXECUTION_TIMEOUT_MS}ms"
            )),
            "{chain}"
        );
        assert!(
            !provisioner.has_running_kernel(),
            "the failed boot must tear its kernel down"
        );
        assert_eq!(
            std::fs::metadata(dir.path().join("starts")).map_or(0, |m| m.len()),
            1,
            "the fatal classification must not auto-retry the boot"
        );
    }
}
