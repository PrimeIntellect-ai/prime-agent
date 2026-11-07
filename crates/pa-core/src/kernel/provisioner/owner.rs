//! The provisioner's owner task: the only writer of the provisioner state. Boot,
//! stop, kill and dispose arrive as commands and run in order, so no lock scope
//! has to stand in for that ordering.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::{mpsc, oneshot};

use super::{
    run_startup, AbortSignal, KernelBootstrapProgressHandler, KernelShutdownOptions,
    ProvisionerInner, ReplKernelManager, RestoreResult, StartupFailure,
};

pub(super) type EnsureReply = oneshot::Sender<anyhow::Result<ReplKernelManager>>;

pub(super) enum Command {
    Ensure {
        progress: Option<KernelBootstrapProgressHandler>,
        /// The joined boot's last stage, for the caller to replay to `progress`.
        joined: oneshot::Sender<Option<String>>,
        reply: EnsureReply,
    },
    Stop {
        snapshot: bool,
        done: oneshot::Sender<()>,
    },
    Kill {
        done: Option<oneshot::Sender<()>>,
    },
    Dispose {
        snapshot: bool,
        done: oneshot::Sender<()>,
    },
    /// A boot stage; the reply carries the listeners the boot must notify.
    Progress {
        generation: u64,
        message: String,
        listeners: oneshot::Sender<Vec<KernelBootstrapProgressHandler>>,
    },
    /// A boot's restore outcome, recorded only for the armed, undisposed
    /// generation; the reply says whether it was.
    Restored {
        generation: u64,
        restore: RestoreResult,
        armed: oneshot::Sender<bool>,
    },
    /// Whether the generation is still armed and undisposed.
    Armed {
        generation: u64,
        reply: oneshot::Sender<bool>,
    },
    TeardownPolicy {
        generation: u64,
        reply: oneshot::Sender<(bool, Option<u64>)>,
    },
    GateDone {
        gate: u64,
    },
    BootSettled {
        generation: u64,
        result: Result<(ReplKernelManager, u64), StartupFailure>,
    },
    /// A disposed boot's teardown finished.
    BootTornDown {
        generation: u64,
        duration_ms: u64,
    },
}

/// What the provisioner owns. Doomed boots and gates span every slot, so they
/// live beside it.
enum Slot {
    Empty,
    Booting(Boot),
    Live(ReplKernelManager),
    /// Terminal: every later `ensure()` fails. `snapshot` is the latest dispose's
    /// policy for the teardown still owed; `pending` is what the slot held when the
    /// dispose landed.
    Disposed {
        snapshot: bool,
        pending: Pending,
        waiters: Vec<DisposeWaiter>,
    },
}

enum Pending {
    Nothing,
    /// The boot settles by tearing its kernel down with the dispose's policy.
    Boot(Boot),
    /// Shut down with the dispose's policy once the boots it waits have settled.
    Kernel(ReplKernelManager),
}

/// One boot generation until its settle is delivered.
struct Boot {
    generation: u64,
    killed: AbortSignal,
    waiters: Vec<EnsureReply>,
    listeners: Vec<KernelBootstrapProgressHandler>,
    last_message: Option<String>,
    /// Stops armed while this boot ran (gate, snapshot policy): they shut down
    /// whatever kernel is published once the boot settles.
    stops: Vec<(u64, bool)>,
}

/// A teardown that may write the snapshot (a stop's shutdown, or a failed boot's
/// own teardown). Revival boots wait every gate armed before them; gates open in
/// arm order, and a stop returns when its gate opens.
struct Gate {
    id: u64,
    done: bool,
    stop: Option<oneshot::Sender<()>>,
}

struct DisposeWaiter {
    boots: Vec<u64>,
    done: oneshot::Sender<()>,
}

pub(super) struct OwnerState {
    slot: Slot,
    /// Boots `kill()` invalidated that have not settled; `dispose()` waits them.
    doomed: Vec<Boot>,
    last_restore: Option<RestoreResult>,
    next_generation: u64,
    next_gate: u64,
    gates: VecDeque<Gate>,
    /// Boots waiting for every gate up to the id to open.
    gate_waiters: Vec<(u64, oneshot::Sender<()>)>,
}

impl OwnerState {
    pub(super) fn new() -> Self {
        Self {
            slot: Slot::Empty,
            doomed: Vec::new(),
            last_restore: None,
            next_generation: 0,
            next_gate: 0,
            gates: VecDeque::new(),
            gate_waiters: Vec::new(),
        }
    }

    pub(super) fn manager(&self) -> Option<ReplKernelManager> {
        match &self.slot {
            Slot::Live(manager)
            | Slot::Disposed {
                pending: Pending::Kernel(manager),
                ..
            } => Some(manager.clone()),
            _ => None,
        }
    }

    pub(super) fn last_restore(&self) -> Option<RestoreResult> {
        self.last_restore.clone()
    }

    /// The generation is the armed boot of an undisposed provisioner.
    fn is_armed(&self, generation: u64) -> bool {
        matches!(&self.slot, Slot::Booting(boot) if boot.generation == generation)
    }

    /// The boot of the armed generation, disposed or not.
    fn current_boot(&mut self, generation: u64) -> Option<&mut Boot> {
        match &mut self.slot {
            Slot::Booting(boot)
            | Slot::Disposed {
                pending: Pending::Boot(boot),
                ..
            } if boot.generation == generation => Some(boot),
            _ => None,
        }
    }

    /// Take the published kernel (live, or held for a dispose) out of the slot.
    fn take_published(&mut self) -> Option<ReplKernelManager> {
        if matches!(self.slot, Slot::Live(_)) {
            let Slot::Live(manager) = std::mem::replace(&mut self.slot, Slot::Empty) else {
                unreachable!();
            };
            return Some(manager);
        }
        if let Slot::Disposed { pending, .. } = &mut self.slot {
            if matches!(pending, Pending::Kernel(_)) {
                let Pending::Kernel(manager) = std::mem::replace(pending, Pending::Nothing) else {
                    unreachable!();
                };
                return Some(manager);
            }
        }
        None
    }

    /// Take the armed boot (disposed or not) out of the slot.
    fn take_boot(&mut self) -> Option<Boot> {
        if matches!(self.slot, Slot::Booting(_)) {
            let Slot::Booting(boot) = std::mem::replace(&mut self.slot, Slot::Empty) else {
                unreachable!();
            };
            return Some(boot);
        }
        if let Slot::Disposed { pending, .. } = &mut self.slot {
            if matches!(pending, Pending::Boot(_)) {
                let Pending::Boot(boot) = std::mem::replace(pending, Pending::Nothing) else {
                    unreachable!();
                };
                return Some(boot);
            }
        }
        None
    }

    fn arm_gate(&mut self, stop: Option<oneshot::Sender<()>>) -> u64 {
        self.next_gate += 1;
        self.gates.push_back(Gate {
            id: self.next_gate,
            done: false,
            stop,
        });
        self.next_gate
    }

    fn open_gate(&mut self, id: u64) {
        if let Some(gate) = self.gates.iter_mut().find(|gate| gate.id == id) {
            gate.done = true;
        }
        while self.gates.front().is_some_and(|gate| gate.done) {
            if let Some(stop) = self.gates.pop_front().and_then(|gate| gate.stop) {
                let _ = stop.send(());
            }
        }
        let first_closed = self.gates.front().map_or(u64::MAX, |gate| gate.id);
        let (open, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.gate_waiters)
            .into_iter()
            .partition(|(through, _)| *through < first_closed);
        self.gate_waiters = waiting;
        for (_, tx) in open {
            let _ = tx.send(());
        }
    }

    /// The snapshot policy for a failed boot's teardown: the dispose policy while
    /// the boot is the armed generation (flush when undisposed), but never a flush
    /// for a boot `kill()` invalidated (the replacement is already restoring the same
    /// payload). A flushing teardown arms a gate for its own flush, unless a stop
    /// armed for this boot already covers it (that stop runs only after this teardown).
    fn teardown_policy(&mut self, generation: u64) -> (bool, Option<u64>) {
        let (flush, covered_by_stop) = match &self.slot {
            Slot::Booting(boot) if boot.generation == generation => (true, !boot.stops.is_empty()),
            Slot::Disposed {
                snapshot,
                pending: Pending::Boot(boot),
                ..
            } if boot.generation == generation => (*snapshot, !boot.stops.is_empty()),
            _ => (false, false),
        };
        if !flush || covered_by_stop {
            return (flush, None);
        }
        (flush, Some(self.arm_gate(None)))
    }
}

/// The handle a boot reports through; liveness needs no round trip.
#[derive(Clone)]
pub(super) struct BootHandle {
    pub(super) generation: u64,
    killed: AbortSignal,
    progress: Option<KernelBootstrapProgressHandler>,
    commands: mpsc::UnboundedSender<Command>,
    gate: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
}

impl BootHandle {
    pub(super) fn progress(&self) -> Option<&KernelBootstrapProgressHandler> {
        self.progress.as_ref()
    }

    /// Still the armed generation of an undisposed provisioner.
    pub(super) fn is_live(&self, dispose_signal: &AbortSignal) -> bool {
        !dispose_signal.is_aborted() && !self.killed.is_aborted()
    }

    /// Report a stage to the generation's joined callers (none once the generation
    /// is no longer armed), then to the boot's own caller.
    pub(super) async fn emit(&self, message: &str) {
        let (listeners, rx) = oneshot::channel();
        self.send(Command::Progress {
            generation: self.generation,
            message: message.to_string(),
            listeners,
        });
        for listener in rx.await.unwrap_or_default() {
            listener(message);
        }
        if let Some(progress) = &self.progress {
            progress(message);
        }
    }

    /// Wait for the gates armed before this boot (an in-flight stop's final flush).
    pub(super) async fn wait_for_gates(&self) {
        let gate = lock(&self.gate).take();
        if let Some(mut gate) = gate {
            if gate.try_recv() == Err(oneshot::error::TryRecvError::Empty) {
                self.emit("Waiting for the previous kernel to stop...")
                    .await;
                let _ = gate.await;
            }
        }
    }

    /// Record this boot's restore if the generation is still armed; the caller
    /// surfaces the notice only then.
    pub(super) async fn record_restore(&self, restore: RestoreResult) -> bool {
        let (armed, rx) = oneshot::channel();
        self.send(Command::Restored {
            generation: self.generation,
            restore,
            armed,
        });
        rx.await.unwrap_or(false)
    }

    pub(super) async fn is_armed(&self) -> bool {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Armed {
            generation: self.generation,
            reply,
        });
        rx.await.unwrap_or(false)
    }

    pub(super) fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// Ask the owner whether this failed boot's teardown may flush the snapshot.
    /// Hold the returned guard across the shutdown: dropping it opens the gate.
    pub(super) async fn teardown_policy(&self) -> (bool, Option<GateGuard>) {
        let (reply, rx) = oneshot::channel();
        self.send(Command::TeardownPolicy {
            generation: self.generation,
            reply,
        });
        let (flush, gate) = rx.await.unwrap_or((false, None));
        let guard = gate.map(|gate| GateGuard {
            gate,
            commands: self.commands.clone(),
        });
        (flush, guard)
    }
}

pub(super) struct GateGuard {
    gate: u64,
    commands: mpsc::UnboundedSender<Command>,
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::GateDone { gate: self.gate });
    }
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The owner keeps only a weak handle: the inbox closes once every provisioner
/// clone and every boot is gone.
pub(super) async fn run(
    inner: Weak<ProvisionerInner>,
    state: Arc<Mutex<OwnerState>>,
    mut inbox: mpsc::UnboundedReceiver<Command>,
) {
    while let Some(command) = inbox.recv().await {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        handle(&inner, &state, command);
    }
}

#[allow(clippy::too_many_lines)]
fn handle(inner: &Arc<ProvisionerInner>, state: &Mutex<OwnerState>, command: Command) {
    match command {
        Command::Ensure {
            progress,
            joined,
            reply,
        } => {
            let mut s = lock(state);
            if matches!(&s.slot, Slot::Disposed { .. }) {
                let _ = reply.send(Err(anyhow::anyhow!("Kernel provisioner disposed")));
                return;
            }
            if matches!(&s.slot, Slot::Live(manager) if manager.is_defunct()) {
                s.slot = Slot::Empty;
            }
            if let Slot::Live(manager) = &s.slot {
                let _ = reply.send(Ok(manager.clone()));
                return;
            }
            if matches!(s.slot, Slot::Empty) {
                let boot = start_boot(inner, &mut s, progress.clone());
                s.slot = Slot::Booting(boot);
            }
            let Slot::Booting(boot) = &mut s.slot else {
                unreachable!("ensure armed a boot");
            };
            boot.waiters.push(reply);
            if let Some(progress) = progress {
                let _ = joined.send(boot.last_message.clone());
                boot.listeners.push(progress);
            }
        }
        Command::Stop { snapshot, done } => {
            let mut s = lock(state);
            if let Some(manager) = s.take_published() {
                let gate = s.arm_gate(Some(done));
                spawn_shutdown(inner, manager, snapshot, gate);
                return;
            }
            let booting = matches!(
                &s.slot,
                Slot::Booting(_)
                    | Slot::Disposed {
                        pending: Pending::Boot(_),
                        ..
                    }
            );
            if booting {
                let gate = s.arm_gate(Some(done));
                if let Slot::Booting(boot)
                | Slot::Disposed {
                    pending: Pending::Boot(boot),
                    ..
                } = &mut s.slot
                {
                    boot.stops.push((gate, snapshot));
                }
            } else {
                let _ = done.send(());
            }
        }
        Command::Kill { done } => {
            let mut s = lock(state);
            if let Some(mut boot) = s.take_boot() {
                boot.killed.abort();
                boot.listeners.clear();
                boot.last_message = None;
                s.doomed.push(boot);
            }
            let manager = s.take_published();
            drop(s);
            if let Some(manager) = manager {
                manager.kill();
            }
            if let Some(done) = done {
                let _ = done.send(());
            }
        }
        Command::Dispose { snapshot, done } => {
            let mut s = lock(state);
            let mut boots: Vec<u64> = s.doomed.iter().map(|boot| boot.generation).collect();
            let slot = std::mem::replace(&mut s.slot, Slot::Empty);
            s.slot = match slot {
                Slot::Disposed {
                    pending, waiters, ..
                } => Slot::Disposed {
                    snapshot,
                    pending,
                    waiters,
                },
                Slot::Empty => Slot::Disposed {
                    snapshot,
                    pending: Pending::Nothing,
                    waiters: Vec::new(),
                },
                Slot::Booting(boot) => Slot::Disposed {
                    snapshot,
                    pending: Pending::Boot(boot),
                    waiters: Vec::new(),
                },
                Slot::Live(manager) => Slot::Disposed {
                    snapshot,
                    pending: Pending::Kernel(manager),
                    waiters: Vec::new(),
                },
            };
            if let Slot::Disposed {
                pending, waiters, ..
            } = &mut s.slot
            {
                if let Pending::Boot(boot) = pending {
                    boots.push(boot.generation);
                }
                waiters.push(DisposeWaiter { boots, done });
            }
            inner.dispose_signal.abort();
            finish_disposes(&mut s);
        }
        Command::Progress {
            generation,
            message,
            listeners,
        } => {
            let mut s = lock(state);
            let notify = s.current_boot(generation).map_or_else(Vec::new, |boot| {
                boot.last_message = Some(message);
                boot.listeners.clone()
            });
            let _ = listeners.send(notify);
        }
        Command::Restored {
            generation,
            restore,
            armed,
        } => {
            let mut s = lock(state);
            let live = s.is_armed(generation);
            if live {
                s.last_restore = Some(restore);
            }
            let _ = armed.send(live);
        }
        Command::Armed { generation, reply } => {
            let _ = reply.send(lock(state).is_armed(generation));
        }
        Command::TeardownPolicy { generation, reply } => {
            let _ = reply.send(lock(state).teardown_policy(generation));
        }
        Command::GateDone { gate } => lock(state).open_gate(gate),
        Command::BootSettled { generation, result } => {
            let mut s = lock(state);
            boot_settled(inner, &mut s, generation, result);
        }
        Command::BootTornDown {
            generation,
            duration_ms,
        } => {
            let mut s = lock(state);
            // A kill() during the teardown moved the boot to the doomed list.
            let boot = if s.current_boot(generation).is_some() {
                s.take_boot()
            } else {
                s.doomed
                    .iter()
                    .position(|boot| boot.generation == generation)
                    .map(|index| s.doomed.remove(index))
            };
            if let Some(boot) = boot {
                let failure = StartupFailure {
                    message: "Kernel provisioner disposed during startup".to_string(),
                    duration_ms,
                };
                deliver(inner, &mut s, boot, &Err(failure));
            }
        }
    }
}

/// The settle's disposition. The generation check comes first: a boot `kill()`
/// doomed tears down with kill semantics (no flush) even when a dispose raced in
/// behind it; only the armed generation honors the dispose.
fn boot_settled(
    inner: &Arc<ProvisionerInner>,
    s: &mut OwnerState,
    generation: u64,
    result: Result<(ReplKernelManager, u64), StartupFailure>,
) {
    if let Some(index) = s
        .doomed
        .iter()
        .position(|boot| boot.generation == generation)
    {
        let boot = s.doomed.remove(index);
        let settled = result.map(|(manager, duration_ms)| {
            if !manager.is_defunct() {
                manager.kill();
            }
            duration_ms
        });
        let failure = match settled {
            Ok(duration_ms) => StartupFailure {
                message: "Kernel provisioner killed during startup".to_string(),
                duration_ms,
            },
            Err(failure) => failure,
        };
        deliver(inner, s, boot, &Err(failure));
        return;
    }
    match std::mem::replace(&mut s.slot, Slot::Empty) {
        Slot::Booting(boot) if boot.generation == generation => match result {
            Ok((manager, _)) => {
                s.slot = Slot::Live(manager.clone());
                deliver(inner, s, boot, &Ok(manager));
            }
            Err(failure) => deliver(inner, s, boot, &Err(failure)),
        },
        Slot::Disposed {
            snapshot,
            pending: Pending::Boot(mut boot),
            waiters,
        } if boot.generation == generation => match result {
            Ok((manager, duration_ms)) => {
                // A dispose raced the boot: tear the kernel down with the dispose's
                // policy instead of handing joined callers a dead manager.
                boot.listeners.clear();
                boot.last_message = None;
                s.slot = Slot::Disposed {
                    snapshot,
                    pending: Pending::Boot(boot),
                    waiters,
                };
                let commands = inner.commands.clone();
                tokio::spawn(async move {
                    let _ = manager
                        .shutdown(KernelShutdownOptions {
                            snapshot,
                            drain_host_requests: true,
                        })
                        .await;
                    let _ = commands.send(Command::BootTornDown {
                        generation,
                        duration_ms,
                    });
                });
            }
            Err(failure) => {
                s.slot = Slot::Disposed {
                    snapshot,
                    pending: Pending::Nothing,
                    waiters,
                };
                deliver(inner, s, boot, &Err(failure));
            }
        },
        other => s.slot = other,
    }
}

/// Hand a settled boot's outcome to its joined callers, run the stops armed for it
/// (each takes whatever kernel is published now: the boot's own, or a newer
/// generation's after a kill), and release disposes that waited it.
fn deliver(
    inner: &Arc<ProvisionerInner>,
    s: &mut OwnerState,
    boot: Boot,
    settled: &Result<ReplKernelManager, StartupFailure>,
) {
    for waiter in boot.waiters {
        let _ = waiter.send(match settled {
            Ok(manager) => Ok(manager.clone()),
            Err(failure) => Err(anyhow::anyhow!(
                "kernel startup failed after {}ms: {}",
                failure.duration_ms,
                failure.message
            )),
        });
    }
    for (gate, snapshot) in boot.stops {
        match s.take_published() {
            Some(manager) => spawn_shutdown(inner, manager, snapshot, gate),
            None => s.open_gate(gate),
        }
    }
    if let Slot::Disposed { waiters, .. } = &mut s.slot {
        for waiter in waiters.iter_mut() {
            waiter.boots.retain(|settled| *settled != boot.generation);
        }
    }
    finish_disposes(s);
}

fn start_boot(
    inner: &Arc<ProvisionerInner>,
    s: &mut OwnerState,
    progress: Option<KernelBootstrapProgressHandler>,
) -> Boot {
    s.next_generation += 1;
    let generation = s.next_generation;
    let gate = if s.gates.is_empty() {
        None
    } else {
        let (tx, rx) = oneshot::channel();
        s.gate_waiters.push((s.next_gate, tx));
        Some(rx)
    };
    let killed = AbortSignal::new();
    let handle = BootHandle {
        generation,
        killed: killed.clone(),
        progress,
        commands: inner.commands.clone(),
        gate: Arc::new(Mutex::new(gate)),
    };
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let boot = tokio::spawn(run_startup(Arc::clone(&inner), handle.clone()));
        let result = boot.await.unwrap_or_else(|error| {
            // A panicked boot never reached its own settle; the settle still runs so
            // the next ensure() boots fresh.
            Err(StartupFailure {
                message: format!("kernel startup task failed: {error}"),
                duration_ms: 0,
            })
        });
        handle.send(Command::BootSettled { generation, result });
    });
    Boot {
        generation,
        killed,
        waiters: Vec::new(),
        listeners: Vec::new(),
        last_message: None,
        stops: Vec::new(),
    }
}

fn spawn_shutdown(
    inner: &Arc<ProvisionerInner>,
    manager: ReplKernelManager,
    snapshot: bool,
    gate: u64,
) {
    let commands = inner.commands.clone();
    tokio::spawn(async move {
        let _ = manager
            .shutdown(KernelShutdownOptions {
                snapshot,
                drain_host_requests: true,
            })
            .await;
        let _ = commands.send(Command::GateDone { gate });
    });
}

/// A dispose returns once the boots it found have settled and the published
/// kernel is shut down with the dispose's own policy.
fn finish_disposes(s: &mut OwnerState) {
    let Slot::Disposed {
        snapshot,
        pending,
        waiters,
    } = &mut s.slot
    else {
        return;
    };
    let (ready, waiting): (Vec<_>, Vec<_>) = std::mem::take(waiters)
        .into_iter()
        .partition(|waiter| waiter.boots.is_empty());
    *waiters = waiting;
    for waiter in ready {
        let manager = match std::mem::replace(pending, Pending::Nothing) {
            Pending::Kernel(manager) => Some(manager),
            other => {
                *pending = other;
                None
            }
        };
        let snapshot = *snapshot;
        tokio::spawn(async move {
            if let Some(manager) = manager {
                let _ = manager
                    .shutdown(KernelShutdownOptions {
                        snapshot,
                        drain_host_requests: true,
                    })
                    .await;
            }
            let _ = waiter.done.send(());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{AbortSignal, Boot, OwnerState, Pending, Slot};

    fn boot(generation: u64) -> Boot {
        Boot {
            generation,
            killed: AbortSignal::new(),
            waiters: Vec::new(),
            listeners: Vec::new(),
            last_message: None,
            stops: Vec::new(),
        }
    }

    #[test]
    fn a_failed_boot_teardown_flushes_only_for_the_armed_generation() {
        let mut state = OwnerState::new();
        state.slot = Slot::Booting(boot(1));
        // The armed boot's failed teardown flushes and gates the revival on that flush.
        let (flush, gate) = state.teardown_policy(1);
        assert!(flush);
        assert!(gate.is_some());
        // A boot kill() invalidated never flushes: the replacement generation is
        // already restoring the same on-disk payload.
        state.slot = Slot::Booting(boot(2));
        assert_eq!(state.teardown_policy(1), (false, None));
    }

    #[test]
    fn a_disposed_boot_teardown_follows_the_dispose_policy() {
        let mut state = OwnerState::new();
        state.slot = Slot::Disposed {
            snapshot: false,
            pending: Pending::Boot(boot(1)),
            waiters: Vec::new(),
        };
        assert_eq!(state.teardown_policy(1), (false, None));
        if let Slot::Disposed { snapshot, .. } = &mut state.slot {
            *snapshot = true;
        }
        let (flush, gate) = state.teardown_policy(1);
        assert!(flush);
        assert!(gate.is_some());
    }

    #[test]
    fn a_stop_armed_for_the_boot_covers_its_teardown_flush() {
        let mut state = OwnerState::new();
        let (stop, _stopped) = tokio::sync::oneshot::channel();
        let gate = state.arm_gate(Some(stop));
        let mut armed = boot(1);
        armed.stops.push((gate, true));
        state.slot = Slot::Booting(armed);
        // The stop runs only after this teardown, so it already gates the revival.
        assert_eq!(state.teardown_policy(1), (true, None));
    }
}
