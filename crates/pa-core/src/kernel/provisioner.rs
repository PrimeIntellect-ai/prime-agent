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
    build_rlm_bootstrap_code, parse_unavailable_python_skills, KernelBootstrapProgressHandler,
    KernelPythonSkill, UnavailablePythonSkills,
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
    /// settles, so owed continuations can resume (TS
    /// `IpythonToolOptions.onBackgroundWorkSettled`).
    pub on_background_work_settled: Option<crate::kernel::shared::BackgroundWorkSettledCallback>,
    /// Fires once per kernel start when installed Python skills failed to
    /// import into the kernel (skill import name -> import error), so the
    /// session can tell the model before it wastes turns calling them
    /// (TS `IpythonToolOptions.onUnavailableSkills`).
    pub on_unavailable_skills: Option<UnavailableSkillsCallback>,
    /// Publishes the per-boot result for the `kernel_bootstrap_*` counters.
    /// Telemetry only; kernel behavior never depends on it.
    pub on_bootstrap_result: Option<KernelBootstrapResultHandler>,
}

/// Why and how long one startup failed, published through the shared startup
/// watch so every joined `ensure()` caller sees the same cause and duration
/// instead of a bare "kernel startup failed".
#[derive(Clone)]
struct StartupFailure {
    /// Full error chain (`{:#}` formatting).
    message: String,
    duration_ms: u64,
}

type StartupResult = Result<ReplKernelManager, StartupFailure>;

/// How one boot's settle publishes: the normal park, one of the two
/// teardown rejects (a racing dispose; a memo generation invalidated by
/// `kill()`), or the boot's own failure.
enum Settle {
    /// The boot's manager parked into the provisioner.
    Published(ReplKernelManager),
    /// A dispose raced the boot: tear the kernel down with the dispose's
    /// snapshot policy and reject with its cause.
    TearDownForDispose {
        manager: ReplKernelManager,
        snapshot: bool,
        duration_ms: u64,
    },
    /// The memo this boot armed was cleared underneath it (`kill()`, or a
    /// defunct clear superseding the generation): never publish a kernel
    /// into a memo generation the boot no longer owns - kill it instead.
    TearDownForKill {
        manager: ReplKernelManager,
        duration_ms: u64,
    },
    /// The boot failed on its own; its failure already carries the cause
    /// and duration.
    Failed(StartupFailure),
}

/// One `stop_kernel` call's starting point.
enum StopArm {
    /// Neither a live kernel nor an in-flight boot: nothing to stop.
    Nothing,
    /// A stop is already armed for the same in-flight boot; its gate opens
    /// once that stop's shutdown settles.
    Joined(tokio::sync::watch::Receiver<bool>),
    /// This stop's own gate, installed atomically with the manager take
    /// (direct) or the in-flight boot it joins.
    Armed {
        manager: Option<ReplKernelManager>,
        startup: Option<tokio::sync::watch::Receiver<Option<StartupResult>>>,
        stop_tx: tokio::sync::watch::Sender<bool>,
        /// The gate this arm superseded. The stop task waits it before
        /// opening its own, so a revival gated on this stop's gate can
        /// never cross before the superseded stop's final snapshot flush
        /// settles; and because every task waits only a gate OLDER than
        /// its own arm, the waits cannot form a cycle (the
        /// wait-the-installed-gate shape admitted both the missed
        /// supersede window and a three-task deadlock).
        previous_stop: Option<tokio::sync::watch::Receiver<bool>>,
    },
}

struct ProvisionerState {
    manager: Option<ReplKernelManager>,
    /// Shared result of the in-flight boot. Joined callers retain its manager
    /// even when a concurrent stop takes the provisioner's live owner.
    startup: Option<tokio::sync::watch::Receiver<Option<StartupResult>>>,
    startup_listeners: Vec<KernelBootstrapProgressHandler>,
    last_startup_message: Option<String>,
    last_restore: Option<RestoreResult>,
    disposed: bool,
    /// Snapshot policy of the dispose that aborted a startup, honored by
    /// the failed startup's own teardown.
    dispose_snapshot: bool,
    /// The in-flight `stop_kernel` shutdown (TS #2483's `pendingStop`): a
    /// revival boot waits for it to finish flushing its final snapshot
    /// before reading that snapshot back, so the two kernels never race
    /// over the same on-disk file. The receiver yields `true` once the
    /// recorded stop settles (a settled stop awaits instantly; a dead
    /// sender errs and unblocks the same way); each stop supersedes the
    /// previous.
    pending_stop: Option<tokio::sync::watch::Receiver<bool>>,
    /// The startup memo the installed pending-stop gate is armed against;
    /// `None` when the gate was armed with a directly-taken manager. A
    /// second stop of the SAME in-flight boot joins the armed gate instead
    /// of superseding it: each stop arming its own gate would have the
    /// take-LOSING stop task open a fresh gate before the winner's final
    /// snapshot flush, un-gating a revival to race that flush.
    pending_stop_for_startup: Option<tokio::sync::watch::Receiver<Option<StartupResult>>>,
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
                    last_restore: None,
                    disposed: false,
                    dispose_snapshot: true,
                    pending_stop: None,
                    pending_stop_for_startup: None,
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
    #[must_use]
    pub fn manager(&self) -> Option<ReplKernelManager> {
        self.lock_state().manager.clone()
    }

    /// Result of reviving a prior session's namespace on the last kernel start.
    #[must_use]
    pub fn last_restore(&self) -> Option<RestoreResult> {
        self.lock_state().last_restore.clone()
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

    /// The kernel manager, starting it first when necessary. Concurrent
    /// callers join one startup; the current startup stage is replayed to
    /// listeners that attach mid-flight.
    ///
    /// # Errors
    ///
    /// Returns an error when the abort signal is already cancelled or fires
    /// during the wait, when the provisioner was disposed, or when the kernel
    /// startup fails (all joined callers see the same failure).
    ///
    /// # Panics
    ///
    /// Panics if the shared startup watch settles without publishing a
    /// result; the publisher always sends the result before clearing the
    /// memo, so this is a construction invariant rather than a runtime
    /// path.
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
        let mut startup = {
            let mut state = self.lock_state();
            if state.disposed {
                return Err(anyhow!("Kernel provisioner disposed"));
            }
            if let Some(manager) = &state.manager {
                if manager.is_defunct() {
                    state.manager = None;
                    state.startup = None;
                }
            }
            if let Some(manager) = state.manager.clone() {
                return Ok(manager);
            }
            if let Some(progress) = &on_progress {
                if let Some(message) = state.last_startup_message.as_deref() {
                    progress(message);
                }
                state.startup_listeners.push(progress.clone());
            }
            if let Some(startup) = &state.startup {
                startup.clone()
            } else {
                let (done_tx, done_rx) = tokio::sync::watch::channel(None);
                let inner = Arc::clone(&self.inner);
                let pending_stop = state.pending_stop.clone();
                let startup_progress = on_progress.clone();
                let startup_memo = done_rx.clone();
                tokio::spawn(async move {
                    let boot = tokio::spawn(run_startup(
                        inner.clone(),
                        startup_progress,
                        pending_stop,
                        startup_memo.clone(),
                    ));
                    let result = match boot.await {
                        Ok(result) => result,
                        Err(error) => {
                            // A panicked boot never reached its own settle;
                            // the settle below still runs so the listener
                            // state clears and the next ensure() boots fresh.
                            Err(StartupFailure {
                                message: format!("kernel startup task failed: {error}"),
                                duration_ms: 0,
                            })
                        }
                    };
                    // Atomic settle/publish: the disposed check, the
                    // memo-generation check, the listener teardown, and the
                    // manager publication share ONE lock scope. Separate
                    // scopes let a dispose or a kill land between the check
                    // and the publish - the boot would park a live kernel
                    // into a provisioner that already reported itself torn
                    // down.
                    let settle = {
                        let mut state = inner
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let mine = state
                            .startup
                            .as_ref()
                            .is_some_and(|memo| memo.same_channel(&startup_memo));
                        // The listener state belongs to the ACTIVE memo
                        // generation: a doomed boot settling against a
                        // newer memo must not wipe the newer boot's
                        // progress listeners or its replayed stage. With
                        // no memo armed at all the entries are stale
                        // (their waiters already hold results) - clear.
                        if mine || state.startup.is_none() {
                            state.startup_listeners.clear();
                            state.last_startup_message = None;
                        }
                        match result {
                            Ok((manager, duration_ms)) => {
                                if state.disposed {
                                    Settle::TearDownForDispose {
                                        manager,
                                        snapshot: state.dispose_snapshot,
                                        duration_ms,
                                    }
                                } else if !mine {
                                    Settle::TearDownForKill {
                                        manager,
                                        duration_ms,
                                    }
                                } else {
                                    state.manager = Some(manager.clone());
                                    Settle::Published(manager)
                                }
                            }
                            Err(failure) => Settle::Failed(failure),
                        }
                    };
                    let settled = match settle {
                        Settle::Published(manager) => Ok(manager),
                        Settle::TearDownForDispose {
                            manager,
                            snapshot,
                            duration_ms,
                        } => {
                            // A dispose raced the boot: tear the kernel down
                            // with the dispose's snapshot policy and reject
                            // with its abort error instead of handing joined
                            // callers a manager that is already dead.
                            let _ = manager
                                .shutdown(KernelShutdownOptions {
                                    snapshot,
                                    drain_host_requests: true,
                                })
                                .await;
                            Err(StartupFailure {
                                message: "Kernel provisioner disposed during startup".to_string(),
                                duration_ms,
                            })
                        }
                        Settle::TearDownForKill {
                            manager,
                            duration_ms,
                        } => {
                            // TS kill() settles the pending startup and kills
                            // the manager it produced.
                            if !manager.is_defunct() {
                                manager.kill();
                            }
                            Err(StartupFailure {
                                message: "Kernel provisioner killed during startup".to_string(),
                                duration_ms,
                            })
                        }
                        Settle::Failed(failure) => Err(failure),
                    };
                    // Publish the completed result before clearing the memo:
                    // joined waiters keep the manager even if stop takes it.
                    let _ = done_tx.send(Some(settled));
                    // Clear only the memo this task installed (TS ensure()'s
                    // `managerPromise === startup` guard): a boot's manager
                    // can turn defunct inside the park->publish->clear window
                    // and another ensure() defunct-clears it and arms a NEWER
                    // memo already; an unconditional clear would wipe that
                    // memo mid-boot and arm a transient duplicate kernel.
                    let mut state = inner
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state
                        .startup
                        .as_ref()
                        .is_some_and(|memo| memo.same_channel(&startup_memo))
                    {
                        state.startup = None;
                    }
                    release_spent_stop_arm(&mut state, &startup_memo);
                });
                state.startup = Some(done_rx.clone());
                done_rx
            }
        };
        // Aborting one waiter leaves the shared startup alive for other
        // callers, like TS raceWithAbort(managerPromise, signal).
        let wait = async { startup.wait_for(Option::is_some).await };
        let completion = match &signal {
            Some(signal) => tokio::select! {
                result = wait => result,
                () = signal.cancelled() => return Err(anyhow!("Python execution aborted")),
            },
            None => wait.await,
        };
        if let Some(signal) = &signal {
            if signal.is_aborted() {
                return Err(anyhow!("Python execution aborted"));
            }
        }
        completion.map_err(|error| anyhow!("kernel startup task closed: {error}"))?;
        let settled = startup
            .borrow()
            .clone()
            .expect("settled startup has a result");
        match settled {
            Ok(manager) => Ok(manager),
            Err(failure) => Err(anyhow!(
                "kernel startup failed after {}ms: {}",
                failure.duration_ms,
                failure.message
            )),
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

    /// Stop the owned kernel without marking the provisioner disposed (TS
    /// #2483's `stopKernel`): the shutdown flushes the final snapshot, and
    /// the next `ensure()` boots a fresh kernel gated on this stop (the
    /// pending-stop revival gate), so a follow-up turn revives from the
    /// flushed snapshot instead of racing the flush over the same on-disk
    /// file. A kernel still starting up is joined first and shut down the
    /// same way (the TS `managerPromise` arm - the boot is not left
    /// resident); with neither a live kernel nor an in-flight boot there
    /// is nothing to stop.
    ///
    /// Concurrent stops of ONE in-flight boot share the first stop's gate
    /// instead of superseding it: each stop arming its own gate would have
    /// whichever stop task loses the manager take open a fresh gate before
    /// the winner's final snapshot flush, un-gating a revival to race that
    /// flush over the same on-disk file.
    ///
    /// Best-effort by construction: a failed shutdown leaves no manager
    /// and the next `ensure()` boots fresh.
    pub async fn stop_kernel(&self, options: Option<KernelShutdownOptions>) {
        let snapshot = options.is_none_or(|o| o.snapshot);
        match self.arm_stop(snapshot) {
            StopArm::Nothing => {}
            StopArm::Joined(mut gate) => {
                // The armed stop's task opens its gate after the shutdown
                // settles; waiting it is this stop's own settle too.
                let _ = gate.wait_for(|done| *done).await;
            }
            StopArm::Armed {
                manager,
                startup,
                stop_tx,
                previous_stop,
                ..
            } => {
                let inner = Arc::clone(&self.inner);
                let stop = tokio::spawn(async move {
                    let manager = if let Some(manager) = manager {
                        Some(manager)
                    } else {
                        if let Some(mut startup) = startup {
                            let _ = startup.wait_for(Option::is_some).await;
                        }
                        inner
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .manager
                            .take()
                    };
                    if let Some(manager) = manager {
                        let _ = manager
                            .shutdown(KernelShutdownOptions {
                                snapshot,
                                drain_host_requests: true,
                            })
                            .await;
                    }
                    // Chained gate (the #3257 shape, kept under the join):
                    // open ours only after the gate THIS arm superseded
                    // settles - never the currently-installed one. A
                    // revival gated on ours then cannot cross before the
                    // superseded stop's final snapshot flush, whether this
                    // task shut its own kernel down or lost the manager
                    // take to the stop that gate belongs to; and because
                    // each task waits only a strictly older gate, the
                    // waits cannot form a cycle.
                    if let Some(mut previous) = previous_stop {
                        let _ = previous.wait_for(|done| *done).await;
                    }
                    let _ = stop_tx.send(true);
                });
                let _ = stop.await;
            }
        }
    }

    /// Claim one stop: take a live manager directly, join a stop already
    /// armed for the same in-flight boot, or arm this stop's own gate for
    /// the in-flight boot's parked kernel. The gate is installed under the
    /// same lock `ensure()` uses to select its startup, so no revival can
    /// miss this stop; `pending_stop_for_startup` records which boot the
    /// gate is armed against so a second stop of that boot joins it
    /// instead of superseding it.
    fn arm_stop(&self, snapshot: bool) -> StopArm {
        let mut state = self.lock_state();
        state.dispose_snapshot = snapshot;
        let manager = state.manager.take();
        let startup = state.startup.clone();
        if manager.is_none() && startup.is_none() {
            return StopArm::Nothing;
        }
        if manager.is_none() {
            let joined = state.pending_stop.clone().filter(|_| {
                state
                    .pending_stop_for_startup
                    .as_ref()
                    .zip(startup.as_ref())
                    .is_some_and(|(armed_for, memo)| armed_for.same_channel(memo))
            });
            if let Some(gate) = joined {
                return StopArm::Joined(gate);
            }
        }
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let previous_stop = state.pending_stop.replace(stop_rx);
        // A gate armed with a directly-taken manager guards that manager's
        // shutdown, not a boot; only a gate armed for an in-flight boot is
        // joinable by the next stop of the same boot.
        state.pending_stop_for_startup = if manager.is_some() {
            None
        } else {
            startup.clone()
        };
        StopArm::Armed {
            manager,
            startup,
            stop_tx,
            previous_stop,
        }
    }

    pub async fn dispose(&self, options: Option<KernelShutdownOptions>) {
        let snapshot = options.is_none_or(|o| o.snapshot);
        let mut startup = {
            let mut state = self.lock_state();
            state.dispose_snapshot = snapshot;
            state.disposed = true;
            state.startup.clone()
        };
        self.inner.dispose_signal.abort();
        if let Some(startup) = &mut startup {
            let _ = startup.wait_for(Option::is_some).await;
        }
        let manager = self.lock_state().manager.take();
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
    /// A kernel still starting up has not been published yet: like TS
    /// `kill()`, the startup memo is cleared (generation invalidation), so
    /// the doomed boot's own settle kills its kernel instead of parking
    /// it, and the next `ensure()` boots fresh - a kill racing a boot
    /// leaves no resident kernel behind.
    pub fn kill(&self) {
        let manager = {
            let mut state = self.lock_state();
            // The stop gate armed against the boot this kill invalidates
            // is spent with it.
            if let Some(armed_for) = state.startup.clone() {
                release_spent_stop_arm(&mut state, &armed_for);
            }
            state.startup = None;
            // The shared progress state belongs to the memo generation
            // kill() just invalidated: its own emits already skip shared
            // writes, and the next ensure() must neither replay the
            // killed boot's stale stage to a fresh handler nor fan the
            // newer boot's stages out to the killed generation's
            // listeners.
            state.startup_listeners.clear();
            state.last_startup_message = None;
            state.manager.take()
        };
        if let Some(manager) = manager {
            manager.kill();
        }
    }
}

/// Release the stop gate armed for `memo`'s boot, if any. The arm's
/// memo receiver is a strong handle to the settled result's manager, and
/// a stale one keeps a parked-or-failed kernel alive past `stop_kernel()`,
/// so a later failed shutdown's process would leak with it as the sole
/// owner. Both spenders call this: the boot's settle and the `kill()` that
/// invalidates the boot.
fn release_spent_stop_arm(
    state: &mut ProvisionerState,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
) {
    if state
        .pending_stop_for_startup
        .as_ref()
        .is_some_and(|armed| armed.same_channel(memo))
    {
        state.pending_stop_for_startup = None;
    }
}

/// The snapshot policy for a failed boot's teardown: the provisioner's
/// dispose policy while the boot's memo generation is still armed, but
/// NEVER a flush for a boot `kill()` invalidated — the replacement
/// generation is already restoring from the same on-disk payload, and a
/// failed doomed boot's teardown flushing over it would rewrite a healthy
/// snapshot (and the kernel stderr log) out from under the new kernel.
/// `dispose()` does not clear the memo, so a disposed boot keeps the
/// dispose's own policy.
///
/// When the policy still flushes, this ALSO installs a pending-stop gate
/// for the teardown's own flush — the decision and the gate share ONE
/// lock scope, so a `kill()` landing between the decision and the flush
/// still leaves the replacement boot gated on this teardown: it restores
/// only after the flush settles (the same revival gate `stop_kernel`
/// arms against its own flush). A stop actively armed for this boot
/// already covers the flush (its task waits this boot's memo, which
/// settles only after the teardown), so the gate stays untouched in
/// that one case; any older, merely installed gate - including one long
/// settled and left in place - covers nothing and is replaced. Hold the
/// returned sender across the shutdown — the gate opens when the
/// teardown scope drops it (a dead sender unblocks the waiters the same
/// way a settled one does).
#[must_use]
fn hold_snapshot_flush_gate(
    inner: &Arc<ProvisionerInner>,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
) -> (bool, Option<tokio::sync::watch::Sender<bool>>) {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let flush = state
        .startup
        .as_ref()
        .is_some_and(|armed| armed.same_channel(memo))
        && state.dispose_snapshot;
    // A stop actively armed for THIS boot covers the teardown's flush
    // through its own memo wait (the stop's task waits this boot's
    // settle, which happens only after the teardown); a merely
    // installed older gate - including one long settled and left in
    // place - covers nothing, so this teardown's gate replaces it.
    let covered_by_active_stop = state
        .pending_stop_for_startup
        .as_ref()
        .is_some_and(|armed_for| armed_for.same_channel(memo));
    if !flush || covered_by_active_stop {
        return (flush, None);
    }
    let (gate_tx, gate_rx) = tokio::sync::watch::channel(false);
    state.pending_stop = Some(gate_rx);
    (flush, Some(gate_tx))
}

/// The boot's memo is still the armed startup generation AND the
/// provisioner is not disposed: a failed attempt may retry, and a
/// restore may surface. `kill()` (or a newer boot's defunct-clear)
/// invalidating the memo makes a further attempt stale work whose
/// kernel the settle would only have to kill.
fn boot_generation_is_live(
    inner: &Arc<ProvisionerInner>,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
) -> bool {
    let state = inner
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    !state.disposed
        && state
            .startup
            .as_ref()
            .is_some_and(|armed| armed.same_channel(memo))
}

fn emit_startup_progress(
    inner: &Arc<ProvisionerInner>,
    on_progress: Option<&KernelBootstrapProgressHandler>,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
    message: &str,
) {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The shared stage belongs to the ACTIVE memo generation: a boot
    // kill() invalidated must not overwrite the newer boot's replayed
    // stage nor fire the newer generation's listeners with its own
    // (the boot's own handler below is its caller's, not shared
    // state, so it keeps firing).
    if state
        .startup
        .as_ref()
        .is_some_and(|armed| armed.same_channel(memo))
    {
        state.last_startup_message = Some(message.to_string());
        for listener in &state.startup_listeners {
            listener(message);
        }
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
/// retry allowance or the hard startup budget runs out. Returns the booted
/// manager with the boot's duration, or the failure; the publisher task's
/// atomic settle decides whether the manager may park.
async fn run_startup(
    inner: Arc<ProvisionerInner>,
    on_progress: Option<KernelBootstrapProgressHandler>,
    pending_stop: Option<tokio::sync::watch::Receiver<bool>>,
    memo: tokio::sync::watch::Receiver<Option<StartupResult>>,
) -> Result<(ReplKernelManager, u64), StartupFailure> {
    let started = std::time::Instant::now();
    let budget = std::time::Duration::from_millis(resolve_startup_budget_ms());
    let mut remaining_retries = resolve_startup_retries();
    let mut attempt: u32 = 0;
    let outcome = loop {
        attempt += 1;
        match start_kernel(&inner, on_progress.as_ref(), pending_stop.clone(), &memo).await {
            Ok(manager) => break Ok(manager),
            Err(error) => {
                // A boot whose memo generation kill() (or a newer boot's
                // defunct-clear) invalidated must not retry: each attempt
                // spawns an interpreter and runs restore/bootstrap, and a
                // stale attempt's restore would surface notifications and
                // state a fresher generation never asked for.
                if !boot_generation_is_live(&inner, &memo)
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
                    on_progress.as_ref(),
                    &memo,
                    &format!("Kernel start failed; retrying in {backoff_ms}ms…"),
                );
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)) => {}
                    () = inner.dispose_signal.cancelled() => break Err(error),
                }
                // Re-check after the backoff: kill() can invalidate the
                // generation while this task sleeps it out.
                if !boot_generation_is_live(&inner, &memo) {
                    break Err(error);
                }
            }
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    // The settle (disposed check, memo-generation check, park-or-reject)
    // runs in the publisher task's atomic scope; this task only reports
    // the boot's own outcome and duration.
    match outcome {
        Ok(manager) => Ok((manager, duration_ms)),
        Err(error) => Err(StartupFailure {
            message: format!("{error:#}"),
            duration_ms,
        }),
    }
}

/// Boot one kernel, restore the prior namespace, then run the runtime
/// bootstrap. Reports the result through `on_bootstrap_result` once per
/// actual boot (`kernel bootstrap` telemetry): timing starts at the first
/// spawn, `cold` means no prior namespace snapshot existed to restore.
async fn start_kernel(
    inner: &Arc<ProvisionerInner>,
    on_progress: Option<&KernelBootstrapProgressHandler>,
    pending_stop: Option<tokio::sync::watch::Receiver<bool>>,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
) -> anyhow::Result<ReplKernelManager> {
    let started = std::time::Instant::now();
    let cold = !inner
        .options
        .snapshot_dir
        .as_ref()
        .is_some_and(|dir| snapshot_path_in(dir).exists());
    let result = start_kernel_impl(inner, on_progress, pending_stop, memo).await;
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
    on_progress: Option<&KernelBootstrapProgressHandler>,
    mut pending_stop: Option<tokio::sync::watch::Receiver<bool>>,
    memo: &tokio::sync::watch::Receiver<Option<StartupResult>>,
) -> anyhow::Result<ReplKernelManager> {
    let options = &inner.options;
    let cwd = inner.cwd.clone();
    let dispose_signal = inner.dispose_signal.clone();
    // The boot-permit closure moves its own clone; the bootstrap below runs
    // on the same shared signal.
    let permit_dispose_signal = dispose_signal.clone();
    // Wait for this provisioner's own in-flight stop_kernel() — and its
    // final snapshot flush — before reading that snapshot back (TS #2483's
    // `pendingStop` gate; a completed stop awaits instantly and each stop
    // supersedes the previous). `ready_gate` stays the cross-provisioner
    // /reload arm.
    if let Some(stop_gate) = &mut pending_stop {
        if !*stop_gate.borrow() {
            emit_startup_progress(
                inner,
                on_progress,
                memo,
                "Waiting for the previous kernel to stop...",
            );
        }
        let _ = stop_gate.wait_for(|done| *done).await;
    }
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
        on_background_work_settled: options.on_background_work_settled.clone(),
        snapshot,
        bootstrap_code: Some(bootstrap_code.clone()),
        stderr_log_path,
    });

    emit_startup_progress(inner, on_progress, memo, "Starting Python kernel...");
    // Only the process spawn + ready handshake contends for OS resources under
    // a fan-out, and it is bounded by start()'s own timeout — so the permit
    // covers only start(). Restore/bootstrap run per-kernel afterwards.
    let start = manager.start(KernelStartOptions {
        signal: None,
        on_bootstrap_progress: on_progress.cloned(),
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
        let (snapshot_policy, _teardown_gate) = hold_snapshot_flush_gate(inner, memo);
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
    let mut snapshot_existed = false;
    if let Some(dir) = &snapshot_dir {
        snapshot_existed = snapshot_path_in(dir).exists();
        emit_startup_progress(inner, on_progress, memo, "Restoring Python state...");
        let restore = manager.restore_state().await;
        if snapshot_existed {
            pending_restore = Some(restore.unwrap_or_default());
        }
    }
    emit_startup_progress(inner, on_progress, memo, "Preparing Python runtime...");
    // The bootstrap runs on the dispose signal (TS startKernel races every
    // boot stage against the dispose-linked abort): a dispose mid-bootstrap
    // settles the cell aborted, and the aborted-status arm below tears the
    // kernel down instead of leaking it into a disposed provisioner.
    let bootstrap = manager
        .execute(
            &bootstrap_code,
            ExecuteOptions {
                signal: Some(dispose_signal.clone()),
                ..Default::default()
            },
        )
        .await;
    match bootstrap {
        Ok(bootstrap) if bootstrap.status == ExecuteStatus::Ok && dispose_signal.is_aborted() => {
            // The cell completed, but the provisioner was disposed under it:
            // the same teardown as the aborted-status arm, with the honest
            // disposed-startup cause (TS startKernel's abort error).
            let (snapshot_policy, _teardown_gate) = hold_snapshot_flush_gate(inner, memo);
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
                // auto-snapshot the bootstrap scheduled would rewrite identical
                // content — or, after a failed restore, clobber the healthy
                // on-disk payload with a skills-only namespace.
                manager.mark_restored_namespace_fresh();
            }
            // Broken skill imports stay importable-looking placeholders;
            // report them so the model learns before its first call, not
            // from the placeholder's error (TS startKernel) - but only a
            // LIVE generation may report: the callback shares the restore
            // notice's mailbox, and a boot kill() invalidated must not
            // append stale skills-unavailable rows the next turn shows the
            // model. Same contract as the restore gate below: the
            // generation check and the callback share ONE lock scope, and
            // the callbacks must not re-enter the provisioner.
            let unavailable = parse_unavailable_python_skills(&bootstrap.stdout);
            if let Some(errors) = unavailable {
                let state = inner
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !state.disposed
                    && state
                        .startup
                        .as_ref()
                        .is_some_and(|armed| armed.same_channel(memo))
                {
                    if let Some(on_unavailable_skills) = &inner.options.on_unavailable_skills {
                        on_unavailable_skills(&errors);
                    }
                }
            }
        }
        Ok(bootstrap) => {
            // The kernel booted but its runtime did not initialize: the venv
            // is the prime suspect, so drop the memoized runtime-ready result
            // and let the next start re-probe (and rebuild when broken).
            crate::kernel::bootstrap::invalidate_runtime_probe_cache();
            let details = [bootstrap.stderr.clone()]
                .into_iter()
                .chain(bootstrap.error.iter().map(|e| e.traceback.join("\n")))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            // TS startKernel's catch shuts the failed boot down with the
            // dispose snapshot policy (default true), not `false`.
            let (snapshot_policy, _teardown_gate) = hold_snapshot_flush_gate(inner, memo);
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
            let (snapshot_policy, _teardown_gate) = hold_snapshot_flush_gate(inner, memo);
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
    // and only a LIVE generation may surface it: a boot kill() invalidated
    // restores its snapshot only for the settle to kill its kernel, so its
    // restore must not fire the notification nor pollute last_restore for
    // the fresher generation. The liveness check, the write, AND the
    // callback share ONE lock scope (this provisioner invokes its
    // callbacks under the state lock - the startup-progress listeners
    // already do - and they must not re-enter the provisioner), so a
    // kill() can no longer slip between the check and the notice.
    if let Some(restore) = pending_restore {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.disposed
            && state
                .startup
                .as_ref()
                .is_some_and(|armed| armed.same_channel(memo))
        {
            state.last_restore = Some(restore.clone());
            if let Some(on_restore) = &inner.options.on_restore {
                on_restore(&restore);
            }
        }
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

    #[test]
    fn a_spent_stop_arm_releases_only_its_own_boot() {
        let provisioner = IpythonKernelProvisioner::new(
            PathBuf::from("/tmp"),
            IpythonKernelProvisionerOptions::default(),
        );
        let (armed_tx, armed_rx) = tokio::sync::watch::channel(None::<StartupResult>);
        let (other_tx, other_rx) = tokio::sync::watch::channel(None::<StartupResult>);
        drop((armed_tx, other_tx));
        {
            let mut state = provisioner.lock_state();
            state.pending_stop_for_startup = Some(armed_rx.clone());
            release_spent_stop_arm(&mut state, &other_rx);
            assert!(
                state.pending_stop_for_startup.is_some(),
                "an arm armed for a different boot is not spent by this boot's settle"
            );
            release_spent_stop_arm(&mut state, &armed_rx);
            assert!(
                state.pending_stop_for_startup.is_none(),
                "the arm armed for this boot is spent by its settle"
            );
        }
    }

    #[test]
    fn kill_releases_the_stop_arm_armed_for_the_killed_boot() {
        let provisioner = IpythonKernelProvisioner::new(
            PathBuf::from("/tmp"),
            IpythonKernelProvisionerOptions::default(),
        );
        let (memo_tx, memo_rx) = tokio::sync::watch::channel(None::<StartupResult>);
        drop(memo_tx);
        {
            let mut state = provisioner.lock_state();
            state.startup = Some(memo_rx.clone());
            state.pending_stop_for_startup = Some(memo_rx);
        }
        provisioner.kill();
        let state = provisioner.lock_state();
        assert!(state.startup.is_none(), "kill() invalidates the memo");
        assert!(
            state.pending_stop_for_startup.is_none(),
            "kill() releases the stop arm armed for the boot it invalidates"
        );
    }

    #[test]
    fn a_doomed_boot_teardown_never_flushes_a_snapshot() {
        let provisioner = IpythonKernelProvisioner::new(
            PathBuf::from("/tmp"),
            IpythonKernelProvisionerOptions::default(),
        );
        let (memo_tx, memo_rx) = tokio::sync::watch::channel(None::<StartupResult>);
        drop(memo_tx);
        // A live boot's failed teardown keeps the dispose policy (true by
        // default) and installs the revival gate for its own flush: a
        // replacement boot that arms after this decision restores only
        // after the flush settles.
        {
            let mut state = provisioner.lock_state();
            state.startup = Some(memo_rx.clone());
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &memo_rx);
        assert!(flushes);
        assert!(
            provisioner.lock_state().pending_stop.is_some(),
            "a flushing teardown gates the revival on its own flush"
        );
        assert!(!provisioner
            .lock_state()
            .pending_stop
            .as_ref()
            .is_some_and(|g| *g.borrow()));
        drop(gate);
        // A boot kill() invalidated must never flush: the replacement
        // generation is already restoring the same on-disk payload.
        provisioner.kill();
        {
            let mut state = provisioner.lock_state();
            state.pending_stop = None;
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &memo_rx);
        assert!(!flushes);
        assert!(gate.is_none());
        assert!(
            provisioner.lock_state().pending_stop.is_none(),
            "a doomed teardown installs no gate"
        );
        // A disposed boot keeps the dispose's own policy (dispose does not
        // clear the memo) and gates the same way.
        let (disposed_tx, disposed_rx) = tokio::sync::watch::channel(None::<StartupResult>);
        drop(disposed_tx);
        {
            let mut state = provisioner.lock_state();
            state.startup = Some(disposed_rx.clone());
            state.disposed = true;
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &disposed_rx);
        assert!(flushes);
        assert!(gate.is_some());
        drop(gate);
        {
            let mut state = provisioner.lock_state();
            state.dispose_snapshot = false;
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &disposed_rx);
        assert!(!flushes);
        assert!(gate.is_none());
        // A stop actively armed for THIS boot covers the flush through its
        // own memo wait (it settles only after this teardown): the
        // teardown leaves that stop's gate untouched.
        let (armed_tx, armed_rx) = tokio::sync::watch::channel(false);
        {
            let mut state = provisioner.lock_state();
            state.dispose_snapshot = true;
            state.pending_stop = Some(armed_rx.clone());
            state.pending_stop_for_startup = Some(disposed_rx.clone());
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &disposed_rx);
        assert!(flushes);
        assert!(
            gate.is_none(),
            "an active stop armed for this boot covers the teardown flush"
        );
        assert!(
            provisioner
                .lock_state()
                .pending_stop
                .as_ref()
                .is_some_and(|g| g.same_channel(&armed_rx)),
            "the active stop's gate survives the teardown decision"
        );
        drop(armed_tx);
        // A merely installed, long-settled older gate covers nothing:
        // the teardown gate replaces it, or a kill() racing the teardown
        // would leave the replacement boot restoring against this
        // teardown's flush.
        {
            let mut state = provisioner.lock_state();
            state.pending_stop_for_startup = None;
        }
        let (flushes, gate) = hold_snapshot_flush_gate(&provisioner.inner, &disposed_rx);
        assert!(flushes);
        assert!(
            gate.is_some(),
            "a stale settled gate must not suppress the teardown gate"
        );
        assert!(
            !provisioner
                .lock_state()
                .pending_stop
                .as_ref()
                .is_some_and(|g| g.same_channel(&armed_rx)),
            "the stale gate is replaced"
        );
        drop(gate);
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
