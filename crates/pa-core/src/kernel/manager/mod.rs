//! Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
//! (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr kept
//! as a diagnostics tail. The protocol is documented in
//! prime-agent-runtime/src/rlm/repl.md (protocol version 3).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use std::io::Write;

use anyhow::anyhow;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Notify};

use crate::kernel::cancellation::{merge_signals, AbortSignal};
use crate::kernel::live_kernels;
use crate::kernel::orphan_journal;
use crate::kernel::protocol::{parse_event, Event, Request, REPL_PROTOCOL_VERSION};
use crate::kernel::shared::FACTORY_ACTIVITY_ACTIONS;
use crate::kernel::shared::{
    parse_attachment_display, parse_diff_display, parse_sent_agent_message, ExecuteOptions,
    ExecuteResult, ExecuteStatus, HostRequestPayload, KernelAttachment, KernelBashCommands,
    KernelDiffDisplay, KernelError, KernelManagerOptions, KernelSentAgentMessage,
    KernelShutdownOptions, LateSentAgentMessageCallback, StreamName, AGENT_MESSAGE_DISPLAY_MIME,
    ATTACHMENT_DISPLAY_MIME, BASH_ACTIVITY_DISPLAY_MIME, BASH_COMMAND_DISPLAY_MIME,
    DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_SNAPSHOT_DEBOUNCE_MS, DIFF_DISPLAY_MIME,
    FACTIVITY_SETTLE_TIMEOUT_MS, FACTIVITY_WATCH_TIMEOUT_MS_CAP, HOST_REQUEST_SHUTDOWN_TIMEOUT_MS,
    KERNEL_ABORT_GRACE_MS, KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE, KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
    KERNEL_BUSY_REUSE_WAIT_MS, KERNEL_SHUTDOWN_TIMEOUT_MS, KERNEL_STDERR_LOG_BUDGET_MARKER,
    MAX_ATTACHMENT_DATA_CHARS, MAX_BACKGROUND_OUTPUT_CHARS, MAX_KERNEL_STDERR_CHARS,
    MAX_KERNEL_STDERR_LOG_BYTES, MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
    RESTORE_EXECUTION_TIMEOUT_MS, SNAPSHOT_EXECUTION_TIMEOUT_MS,
};
use crate::kernel::state_snapshot::{
    RestoreResult, SnapshotResult, SnapshotSkip, DEFAULT_SNAPSHOT_MAX_BYTES,
    DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
};

const READY_TIMEOUT_MS: u64 = 30_000;
const REPAIR_STEP_TIMEOUT_MS: u64 = 30_000;
/// The MCP status lane's settle margin over the per-server timeout (the
/// kernel lists every server concurrently): the reply always settles
/// inside the bound, and a wedged reply errors instead of hanging the
/// caller.
const MCP_STATUS_SETTLE_MARGIN_MS: u64 = 5_000;
/// Largest legit frame is an attachment display event, base64 capped at
/// `MAX_ATTACHMENT_DATA_CHARS`; a longer line is corruption the protocol repair owns.
const MAX_PROTOCOL_LINE_BYTES: usize = 32 * 1024 * 1024;
/// Runtime-minted host-request ids never repeat; the bound only guards a
/// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS: usize = 1024;

pub type KernelBootstrapProgressHandler = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct KernelStartOptions {
    pub signal: Option<AbortSignal>,
    pub on_bootstrap_progress: Option<KernelBootstrapProgressHandler>,
}

/// Lock a mutex, surviving poisoning: the guarded state is plain data, and a
/// panicked reader must not cascade into an unusable kernel.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KernelState {
    Idle,
    Starting,
    Running,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExitInfo {
    code: Option<i32>,
    signal: Option<i32>,
}

/// Fields of a settled execution shared with the stdout reader task.
#[derive(Default)]
// The mirrored TS API shape is deliberate (the booleans are the product's own surface).
#[allow(clippy::struct_excessive_bools)]
struct ExecBuffers {
    stdout: String,
    stderr: String,
    stdout_chars: usize,
    stderr_chars: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
    result: Option<String>,
    diffs: Vec<KernelDiffDisplay>,
    attachments: Vec<KernelAttachment>,
    attachment_oversized: bool,
    sent_agent_messages: Vec<KernelSentAgentMessage>,
    bash_commands: Option<KernelBashCommands>,
    background_output: String,
    background_output_chars: usize,
    background_output_truncated: bool,
    error: Option<KernelError>,
    status: ExecuteStatus,
    done_fields: Option<Value>,
    settled: bool,
}

pub(crate) struct ActiveExecution {
    request_id: String,
    code: String,
    started: Instant,
    max_chars: usize,
    opts: ExecuteOptions,
    /// The request runs user-namespace code (an execute — the bootstrap class
    /// included, internal or not): its settle can rebind or mutate names.
    namespace_code: bool,
    /// The request replaces the namespace wholesale (a restore).
    restores_namespace: bool,
    buffers: Mutex<ExecBuffers>,
    result_tx: Mutex<Option<oneshot::Sender<anyhow::Result<InternalExecuteResult>>>>,
}

/// `ExecuteResult` plus the raw fields of the request's `done` event (state ops).
pub(crate) struct InternalExecuteResult {
    result: ExecuteResult,
    done_fields: Option<Value>,
}

impl InternalExecuteResult {
    fn aborted(started: Instant) -> Self {
        Self {
            result: ExecuteResult {
                stdout: String::new(),
                stderr: String::new(),
                result: None,
                diffs: None,
                attachments: None,
                sent_agent_messages: None,
                bash_commands: None,
                background_output: None,
                status: ExecuteStatus::Aborted,
                error: None,
                duration_ms: started.elapsed().as_millis() as u64,
            },
            done_fields: None,
        }
    }
}

/// A memoized one-shot operation (start / shutdown / repair / rebootstrap /
/// flush) that concurrent callers join, with an optional abort-aware wait.
struct MemoSlot {
    done: AtomicBool,
    failed: Mutex<Option<String>>,
    notify: Notify,
}

impl MemoSlot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            done: AtomicBool::new(false),
            failed: Mutex::new(None),
            notify: Notify::new(),
        })
    }

    fn outcome(&self) -> anyhow::Result<()> {
        match &*lock(&self.failed) {
            Some(err) => Err(anyhow!("{err}")),
            None => Ok(()),
        }
    }

    async fn wait(&self) -> anyhow::Result<()> {
        loop {
            if self.done.load(Ordering::SeqCst) {
                return self.outcome();
            }
            self.notify.notified().await;
        }
    }

    /// Wait for completion, returning an abort error as soon as `signal` fires.
    async fn wait_or_abort(
        &self,
        signal: Option<&AbortSignal>,
        message: &str,
    ) -> anyhow::Result<()> {
        match signal {
            None => self.wait().await,
            Some(signal) => {
                if signal.is_aborted() {
                    return Err(anyhow!("{message}"));
                }
                let wait = self.wait();
                tokio::select! {
                    r = wait => r,
                    () = signal.cancelled() => Err(anyhow!("{message}")),
                }
            }
        }
    }

    fn finish(&self, error: Option<anyhow::Error>) {
        if let Some(err) = error {
            *lock(&self.failed) = Some(format!("{err:#}"));
        }
        self.done.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
}

struct RepairOwner {
    superseded: AtomicBool,
}

struct RepairHandle {
    owner: Arc<RepairOwner>,
    slot: Arc<MemoSlot>,
}

/// File-stat identity of a snapshot manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ManifestStat {
    mtime: std::time::SystemTime,
    size: u64,
}

/// One-shot post-restore snapshot skip: the debounced auto-snapshot after a
/// bootstrap would rewrite identical content or clobber the payload after a failed restore.
struct RestoredNamespaceSkip {
    manifest_stat: Option<ManifestStat>,
    completed_executions: u64,
}

/// The last committed capture, replayed while the namespace provably cannot
/// have changed: a settled cell is the only path that rebinds namespace objects.
#[derive(Clone)]
struct CaptureFreshness {
    /// Settled USER-execution count at the commit; any later user settle
    /// defeats the memo (internal state requests never move it).
    user_executions: u64,
    /// The invalidation epoch at the commit: any later bump (a
    /// namespace-code or restore settle, a kernel start) defeats the memo.
    epoch: u64,
    /// The payload stat right after the commit — the load-bearing witness:
    /// it fingerprints the file a later restore actually reads.
    payload_stat: Option<ManifestStat>,
    /// The manifest stat right after the commit, re-checked at every consult.
    manifest_stat: Option<ManifestStat>,
    /// The committed capture's result, replayed to callers while fresh: a
    /// fresh capture reports the same lists, except the prune, which finds nothing.
    result: SnapshotResult,
    /// Live names above the per-variable cap survived the commit: a pruning
    /// capture must still run to remove and disclose them.
    live_over_cap: bool,
}

// The mirrored TS API shape is deliberate (the booleans are the product's own surface).
#[allow(clippy::struct_excessive_bools)]
struct Guarded {
    state: KernelState,
    start_generation: u64,
    /// Generation whose graceful `shutdown()` owns the teardown, so the exit
    /// handler must not run it.
    graceful_shutdown_generation: Option<u64>,
    teardown_in_flight: u32,
    startup_protocol_error: Option<String>,
    /// A repair discarded its kernel: the next fresh start must re-run the runtime bootstrap.
    pending_rebootstrap: bool,
    /// Restore the saved namespace on that fresh start too (false when the
    /// snapshot itself is the declared culprit). A failed non-repair restore re-arms it.
    pending_restore: bool,
    /// Settled-execution counter: the post-restore skip arm and the debounced
    /// snapshot compare it to spot a real cell in between.
    completed_executions: u64,
    /// Settled USER executions only (internal state requests never touch the
    /// user namespace); the capture-freshness memo compares this counter.
    user_executions: u64,
    /// A restore attempt failed or revived only part of the saved namespace;
    /// only a fully-successful restore clears it.
    restore_incomplete: bool,
    /// The restore settle's execution count: the debounced auto-snapshot stays suppressed
    /// until a third execution settles, so a near-zero debounce cannot fire before the skip arm.
    restore_boot_hold: Option<u64>,
    /// Tri-state manifest stat of the last non-repair restore ATTEMPT:
    /// `None` = no attempt yet, `Some(None)` = manifest was missing at it.
    #[allow(clippy::option_option)] // the tri-state IS the semantics
    restored_manifest_stat: Option<Option<ManifestStat>>,
    /// Armed one-shot post-restore snapshot skip (see `RestoredNamespaceSkip`).
    restored_namespace_skip: Option<RestoredNamespaceSkip>,
    /// The recurring freshness memo every capture entry consults (see `CaptureFreshness`).
    capture_freshness: Option<CaptureFreshness>,
    /// Bumped by every memo invalidation, so an invalidation landing
    /// mid-capture can never be re-described by that capture's post-await arm.
    freshness_epoch: u64,
    /// Bumped by every capture COMMIT: a straggling earlier capture's delayed stat
    /// probe could otherwise pair its stale result lists with the newer capture's files.
    capture_sequence: u64,
    /// Unattributed stream text that arrived between cells; surfaced on the next execution.
    pending_background_output: String,
    pending_background_output_chars: usize,
    pending_background_output_truncated: bool,
    flushing_snapshot_for_dispose: bool,
    protocol_repair: Option<Arc<RepairHandle>>,
    kernel_stderr: String,
    background_bash_handles: HashMap<String, i32>,
    handled_host_request_ids: (HashSet<String>, VecDeque<String>),
    /// Late agent-message handlers keyed by request id, insertion-ordered with eviction.
    late_handlers: VecDeque<(String, LateSentAgentMessageCallback)>,
    /// Resolvers for done events outside the active execution (the shutdown reply).
    pending_done_waiters: HashMap<String, oneshot::Sender<()>>,
    bash_activity_waiters: HashMap<String, oneshot::Sender<Value>>,
    /// Resolvers for out-of-band `factory_activity` done events (the
    /// factory bridge's lane; ids never collide with cell requests).
    factory_activity_waiters: HashMap<String, oneshot::Sender<Value>>,
    /// Resolvers for out-of-band `mcp_status` done events (the MCP
    /// status lane; ids never collide with cell requests — the eager
    /// settle and the connections view ride it, and a slow server must
    /// never hold the execution queue a python cell needs).
    mcp_status_waiters: HashMap<String, oneshot::Sender<Value>>,
    host_inflight: Vec<tokio::task::JoinHandle<()>>,
    active_execution: Option<Arc<ActiveExecution>>,
    /// Source of the most recently started cell, retained after it finishes so
    /// rlm.run spawns from detached asyncio tasks can still attribute their spawning program.
    last_cell_code: Option<String>,
    ready_tx: Option<oneshot::Sender<anyhow::Result<i64>>>,
}

struct ChildHandle {
    pid: i32,
    stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
    exit_rx: tokio::sync::watch::Receiver<Option<ExitInfo>>,
}

/// The RLM kernel manager: owns one `python -m rlm.repl` subprocess and the
/// JSON-lines protocol v3 conversation with it.
#[derive(Clone)]
pub struct ReplKernelManager {
    pub(crate) inner: Arc<Inner>,
}

impl std::fmt::Debug for ReplKernelManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplKernelManager")
            .field("running", &self.is_running())
            .field("defunct", &self.is_defunct())
            .field("owner_session_id", &self.owner_session_id())
            .finish()
    }
}

pub(crate) struct Inner {
    options: KernelManagerOptions,
    freshness_stat_probe: std::sync::atomic::AtomicBool,
    resolved_python: Mutex<Option<std::path::PathBuf>>,
    guarded: Mutex<Guarded>,
    child: Mutex<Option<ChildHandle>>,
    busy_notify: Notify,
    /// Serializes `execute()` calls — the runtime runs one request at a time.
    execution_queue: tokio::sync::Mutex<()>,
    start_memo: Mutex<Option<Arc<MemoSlot>>>,
    shutdown_memo: Mutex<Option<Arc<MemoSlot>>>,
    rebootstrap_memo: Mutex<Option<Arc<MemoSlot>>>,
    flush_memo: Mutex<Option<Arc<MemoSlot>>>,
    snapshot_timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stderr_closed: Notify,
    stderr_closed_flag: AtomicBool,
    /// File receiving pre-ready kernel stderr, with its remaining write budget.
    stderr_log: Mutex<Option<Arc<Mutex<StderrLog>>>>,
}

struct StderrLog {
    file: std::fs::File,
    budget: u64,
}

impl Inner {
    /// Fire the embedding's background-work settlement notice: the settlement is already recorded,
    /// so a host-callback panic neither breaks the kernel event path nor aborts the teardown.
    fn notify_background_work_settled(&self) {
        let Some(callback) = self.options.on_background_work_settled.clone() else {
            return;
        };
        if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback())) {
            let reason = panic
                .downcast_ref::<&str>()
                .map(|message| (*message).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            self.append_diagnostic(&format!(
                "background work settled callback failed: {reason}"
            ));
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Synchronous best-effort cleanup.
        self.supersede_protocol_repair();
        lock(&self.guarded).state = KernelState::Shutdown;
        live_kernels::remove_inner(self);
        self.cleanup_resources(Signal::Kill);
    }
}

// The manager's sections live in child modules; all sections operate on the
// same [`Inner`] state defined here, so private fields stay in this module.
mod delegations;
mod events;
mod execution;
mod host_requests;
mod repair;
mod requests;
mod snapshot;
mod startup;
mod teardown;

use requests::{append_truncated, describe_failure, Signal};

// Public API

impl ReplKernelManager {
    #[must_use]
    pub fn new(options: KernelManagerOptions) -> Self {
        let inner = Arc::new(Inner {
            options,
            freshness_stat_probe: std::sync::atomic::AtomicBool::new(false),
            resolved_python: Mutex::new(None),
            guarded: Mutex::new(Guarded {
                state: KernelState::Idle,
                start_generation: 0,
                graceful_shutdown_generation: None,
                teardown_in_flight: 0,
                startup_protocol_error: None,
                pending_rebootstrap: false,
                pending_restore: false,
                completed_executions: 0,
                user_executions: 0,
                restore_incomplete: false,
                restore_boot_hold: None,
                restored_manifest_stat: None,
                restored_namespace_skip: None,
                capture_freshness: None,
                freshness_epoch: 0,
                capture_sequence: 0,
                pending_background_output: String::new(),
                pending_background_output_chars: 0,
                pending_background_output_truncated: false,
                flushing_snapshot_for_dispose: false,
                protocol_repair: None,
                kernel_stderr: String::new(),
                background_bash_handles: HashMap::new(),
                handled_host_request_ids: (HashSet::new(), VecDeque::new()),
                late_handlers: VecDeque::new(),
                pending_done_waiters: HashMap::new(),
                bash_activity_waiters: HashMap::new(),
                factory_activity_waiters: HashMap::new(),
                mcp_status_waiters: HashMap::new(),
                host_inflight: Vec::new(),
                active_execution: None,
                last_cell_code: None,
                ready_tx: None,
            }),
            child: Mutex::new(None),
            busy_notify: Notify::new(),
            execution_queue: tokio::sync::Mutex::new(()),
            start_memo: Mutex::new(None),
            shutdown_memo: Mutex::new(None),
            rebootstrap_memo: Mutex::new(None),
            flush_memo: Mutex::new(None),
            snapshot_timer: Mutex::new(None),
            stderr_closed: Notify::new(),
            stderr_closed_flag: AtomicBool::new(false),
            stderr_log: Mutex::new(None),
        });
        Self { inner }
    }

    #[must_use]
    pub fn owner_session_id(&self) -> Option<&str> {
        self.inner.options.session_id.as_deref()
    }

    #[must_use]
    pub fn has_background_work(&self) -> bool {
        !lock(&self.inner.guarded).background_bash_handles.is_empty()
    }

    /// Process id of the spawned kernel child, when present. Used by tests and
    /// orphan bookkeeping.
    #[must_use]
    pub fn process_id(&self) -> Option<i32> {
        lock(&self.inner.child).as_ref().map(|c| c.pid)
    }

    #[must_use]
    pub fn is_running(&self) -> bool {
        lock(&self.inner.guarded).state == KernelState::Running
    }

    /// Terminal: the kernel died or was torn down; only a fresh manager can serve again.
    #[must_use]
    pub fn is_defunct(&self) -> bool {
        lock(&self.inner.guarded).state == KernelState::Shutdown
    }

    /// Diagnostics tail (kernel stderr, at most the last 8 KiB).
    #[must_use]
    pub fn kernel_stderr(&self) -> String {
        lock(&self.inner.guarded).kernel_stderr.clone()
    }

    /// Start the kernel, memoizing concurrent callers onto one startup.
    /// An aborted signal abandons the wait without stopping the underlying startup.
    ///
    /// # Errors
    ///
    /// Returns an error when the abort signal fires or the kernel fails to spawn or bootstrap.
    pub async fn start(&self, options: KernelStartOptions) -> anyhow::Result<()> {
        if let Some(signal) = &options.signal {
            if signal.is_aborted() {
                return Err(anyhow!("Kernel startup aborted"));
            }
        }
        // The guard is strictly scoped: a conditionally dropped non-Send
        // MutexGuard would make the whole future non-Send.
        let existing = lock(&self.inner.start_memo).as_ref().cloned();
        if let Some(existing) = existing {
            return existing
                .wait_or_abort(options.signal.as_ref(), "Kernel startup aborted")
                .await;
        }
        let slot = {
            let mut memo = lock(&self.inner.start_memo);
            let slot = MemoSlot::new();
            *memo = Some(slot.clone());
            slot
        };
        // Owner: run the startup to completion in a task so the caller\'s abort
        // signal can abandon the wait without killing the kernel for others.
        let inner = self.inner.clone();
        let run_slot = slot.clone();
        let wait_signal = options.signal.clone();
        let task = tokio::spawn(async move {
            let result = inner.do_start(&options).await;
            run_slot.finish(result.as_ref().err().map(|e| anyhow!("{e:#}")));
            if result.is_err() {
                let mut memo = lock(&inner.start_memo);
                // Only clear our own memoization: a stale start must not evict a newer one.
                if matches!(memo.as_ref(), Some(current) if Arc::ptr_eq(current, &run_slot)) {
                    *memo = None;
                }
            }
            result
        });
        match wait_signal.as_ref() {
            None => match task.await {
                Ok(result) => result,
                Err(join_error) => {
                    slot.finish(Some(anyhow!("{join_error}")));
                    Err(anyhow!("{join_error}"))
                }
            },
            Some(signal) => {
                let wait = slot.wait();
                tokio::select! {
                    r = wait => {
                        // Join the task to keep it observable; its result is already in the slot.
                        let _ = task.await;
                        r
                    }
                    () = signal.cancelled() => {
                        // The startup keeps running for other callers.
                        Err(anyhow!("Kernel startup aborted"))
                    }
                }
            }
        }
    }

    /// Execute one cell. Refreshes the on-disk snapshot after real work so a later resume (or a
    /// crash before graceful shutdown) revives namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when the in-flight protocol repair fails or the enqueued execution fails.
    pub async fn execute(&self, code: &str, opts: ExecuteOptions) -> anyhow::Result<ExecuteResult> {
        self.execute_bounded(code, opts, /*execution_timeout_ms*/ None)
            .await
    }

    /// The bounded entry onto the shared execute path: the provisioner's
    /// runtime bootstrap passes its bound, so a lost bootstrap frame fails
    /// the boot loudly instead of parking it forever.
    ///
    /// # Errors
    ///
    /// Returns an error when the in-flight protocol repair fails, or when the
    /// enqueued execution fails (kernel error, timeout, or aborted request).
    pub(crate) async fn execute_bounded(
        &self,
        code: &str,
        opts: ExecuteOptions,
        execution_timeout_ms: Option<u64>,
    ) -> anyhow::Result<ExecuteResult> {
        self.wait_for_protocol_repair(opts.signal.as_ref()).await?;
        let result = self
            .enqueue_execute(code, opts, execution_timeout_ms)
            .await?;
        if result.result.status == ExecuteStatus::Ok {
            self.schedule_snapshot();
        }
        Ok(result.result)
    }

    /// Queue and run a cell, serializing against all other executions.
    async fn enqueue_execute(
        &self,
        code: &str,
        opts: ExecuteOptions,
        execution_timeout_ms: Option<u64>,
    ) -> anyhow::Result<InternalExecuteResult> {
        self.enqueue_request(
            Request::Execute {
                code: code.to_string(),
            },
            code,
            opts,
            execution_timeout_ms,
        )
        .await
    }

    /// Inspect or stop a kernel-owned bash handle without waiting behind a cell.
    /// Does not boot an idle kernel. The caller scopes this manager to its session.
    ///
    /// # Errors
    ///
    /// Returns an error when the kernel is not running, or the request to the kernel fails.
    pub async fn bash_activity(
        &self,
        action: &str,
        activity_id: Option<&str>,
        lines: usize,
    ) -> anyhow::Result<Value> {
        if !self.is_running() {
            return Err(anyhow!("Kernel is not running"));
        }
        // The runtime's pre-validation answers with a protocol error that carries no request id;
        // mirror the contract locally and fail fast.
        if !matches!(action, "list" | "tail" | "kill") {
            return Err(anyhow!("unknown bash activity action"));
        }
        let requires_id = action != "list" && activity_id.map_or("", str::trim).is_empty();
        if requires_id {
            return Err(anyhow!(
                "bash activity tail/kill requires string activityId"
            ));
        }
        if action == "tail" && !(1..=200).contains(&lines) {
            return Err(anyhow!("lines must be an integer between 1 and 200"));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.inner.guarded)
            .bash_activity_waiters
            .insert(request_id.clone(), tx);
        let frame = json!({"type": "bash_activity", "id": request_id, "action": action,
                           "activityId": activity_id, "lines": lines});
        if let Err(error) = self.inner.write_line(&frame).await {
            lock(&self.inner.guarded)
                .bash_activity_waiters
                .remove(&request_id);
            return Err(error);
        }
        let Ok(Ok(fields)) = tokio::time::timeout(Duration::from_secs(3), rx).await else {
            lock(&self.inner.guarded)
                .bash_activity_waiters
                .remove(&request_id);
            return Err(anyhow!("Kernel bash activity request did not settle"));
        };
        if fields.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(anyhow!(
                "{}",
                fields
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Kernel bash activity failed")
            ));
        }
        Ok(fields)
    }

    /// Run one out-of-band `factory_activity` request against the kernel's
    /// factory executor: the `/factory` view's bridge lane. Like
    /// [`Self::bash_activity`] this bypasses the cell FIFO (a running turn
    /// must never delay the live view) and never boots an idle kernel.
    ///
    /// `action` is one of `graph`/`status`/`watch`/`run`/`stop`/`resume`/
    /// `library` (the machine library's list/graph reads); `run_id`/
    /// `spec_id` carry the target and `timeout_ms` bounds a watch.
    /// The kernel owns the run registry, so the reply is the kernel's
    /// result payload verbatim.
    ///
    /// # Errors
    ///
    /// Returns an error when the kernel is not running, the action or
    /// arguments are invalid, or the request does not settle inside its
    /// per-action bound (a watch gets its own timeout plus a margin; every
    /// other action gets a fixed settle bound).
    pub async fn factory_activity(
        &self,
        action: &str,
        run_id: Option<&str>,
        spec_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<Value> {
        if !self.is_running() {
            return Err(anyhow!("Kernel is not running"));
        }
        if !FACTORY_ACTIVITY_ACTIONS.contains(&action) {
            return Err(anyhow!("unknown factory activity action"));
        }
        let timeout_ms = timeout_ms.unwrap_or(0).min(FACTIVITY_WATCH_TIMEOUT_MS_CAP);
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.inner.guarded)
            .factory_activity_waiters
            .insert(request_id.clone(), tx);
        let frame = json!({
            "type": "factory_activity",
            "id": request_id,
            "action": action,
            "runId": run_id,
            "specId": spec_id,
            "timeoutMs": timeout_ms,
        });
        if let Err(error) = self.inner.write_line(&frame).await {
            lock(&self.inner.guarded)
                .factory_activity_waiters
                .remove(&request_id);
            return Err(error);
        }
        // The bound: a watch waits at most its declared timeout, so the
        // margin covers the executor's own settle work; every other action
        // settles inside a fixed window (run/stop/resume issue child
        // requests through the supervisor, which stay well under it).
        let bound_ms = FACTIVITY_SETTLE_TIMEOUT_MS
            + if action == "watch" {
                timeout_ms + FACTIVITY_SETTLE_TIMEOUT_MS
            } else {
                0
            };
        let Ok(Ok(mut fields)) = tokio::time::timeout(Duration::from_millis(bound_ms), rx).await
        else {
            lock(&self.inner.guarded)
                .factory_activity_waiters
                .remove(&request_id);
            return Err(anyhow!("Kernel factory activity request did not settle"));
        };
        if let Some(object) = fields.as_object_mut() {
            object.remove("event");
            object.remove("id");
        }
        if fields.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(anyhow!(
                "{}",
                fields
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("Kernel factory activity failed")
            ));
        }
        fields
            .as_object_mut()
            .and_then(|object| object.remove("result"))
            .ok_or_else(|| anyhow!("Kernel factory activity reply carried no result"))
    }

    // -------------------------------------------------------- state ops API

    /// Serialize the user namespace to disk (best-effort, per-variable).
    /// `None` when the kernel isn\'t running or no snapshot target was
    /// configured. Never fails on kernel errors; they land in diagnostics.
    pub async fn snapshot_state(&self) -> Option<SnapshotResult> {
        self.capture_snapshot(None, false).await
    }

    /// Persist the namespace, then remove variables above the per-variable cap.
    pub async fn prune_oversized_variables(&self) -> Option<SnapshotResult> {
        self.capture_snapshot(Some(SNAPSHOT_EXECUTION_TIMEOUT_MS), true)
            .await
    }

    /// Revive a previously snapshotted namespace into the kernel. Call right after `start()` and
    /// before the runtime bootstrap, which then refreshes live handles.
    pub async fn restore_state(&self) -> Option<RestoreResult> {
        self.perform_restore(false).await
    }

    /// Arm the one-shot post-restore snapshot skip (see `RestoredNamespaceSkip`);
    /// call after the bootstrap succeeds. No-op when no non-repair restore was attempted.
    pub fn mark_restored_namespace_fresh(&self) {
        self.inner.mark_restored_namespace_fresh();
    }

    /// Live user-defined top-level names, or `None` if the kernel isn\'t running.
    pub async fn list_namespace_names(&self, signal: Option<AbortSignal>) -> Option<Vec<String>> {
        if !self.is_running() {
            return None;
        }
        let opts = ExecuteOptions {
            internal: true,
            signal,
            ..ExecuteOptions::default()
        };
        match self
            .enqueue_request(Request::ListNames, "", opts, None)
            .await
        {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                let names = r
                    .done_fields
                    .as_ref()
                    .and_then(|fields| fields.get("names"))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                Some(names)
            }
            Ok(r) => {
                self.inner.append_diagnostic(&format!(
                    "namespace listing failed: {}",
                    describe_failure(&r.result)
                ));
                None
            }
            Err(error) => {
                self.inner
                    .append_diagnostic(&format!("namespace listing error: {error:#}"));
                None
            }
        }
    }

    /// Per-server MCP tool listing (the runtime `mcp_status` request): one entry per requested
    /// server or the error string when that server failed or timed out. `None` when the kernel
    /// isn't running.
    ///
    /// The listing opens each not-yet-connected server (bounded by
    /// `per_server_timeout_ms`), so the call can take seconds; callers
    /// bound it with their own deadline.
    ///
    /// The request rides the dedicated MCP status lane (the eager
    /// background settle and the connections view are its callers): the
    /// done event settles by request id, so the listing NEVER occupies
    /// the manager's execution queue — a slow or unreachable server
    /// would otherwise park the user's first python cell behind its
    /// handshake for up to the per-server timeout (the pre-bar review's
    /// finding). The kernel runtime's own dedicated lane keeps its
    /// serve loop free the same way, and the registry's per-server locks
    /// still join an early user call onto the same in-flight open.
    pub async fn mcp_tool_listing(
        &self,
        servers: &[String],
        per_server_timeout_ms: u64,
    ) -> Option<Vec<Value>> {
        if !self.is_running() {
            return None;
        }
        if servers.is_empty() {
            return Some(Vec::new());
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.inner.guarded)
            .mcp_status_waiters
            .insert(request_id.clone(), tx);
        let frame = json!({
            "type": "mcp_status",
            "id": request_id,
            "servers": servers,
            "timeout_ms": per_server_timeout_ms,
        });
        if let Err(error) = self.inner.write_line(&frame).await {
            lock(&self.inner.guarded)
                .mcp_status_waiters
                .remove(&request_id);
            self.inner
                .append_diagnostic(&format!("mcp tool listing error: {error:#}"));
            return None;
        }
        // The kernel lists every server concurrently, each bounded by the
        // per-server timeout, so the settle bound is one timeout plus the
        // serve work's margin — a wedged reply never hangs the caller.
        let bound_ms = per_server_timeout_ms.saturating_add(MCP_STATUS_SETTLE_MARGIN_MS);
        let Ok(Ok(fields)) = tokio::time::timeout(Duration::from_millis(bound_ms), rx).await else {
            lock(&self.inner.guarded)
                .mcp_status_waiters
                .remove(&request_id);
            self.inner
                .append_diagnostic("mcp tool listing did not settle inside the per-server bound");
            return None;
        };
        match fields.get("status").and_then(Value::as_str) {
            Some("ok") => {
                let connections = fields.get("connections").and_then(Value::as_array).cloned();
                Some(connections.unwrap_or_default())
            }
            status => {
                self.inner.append_diagnostic(&format!(
                    "mcp tool listing failed: {}",
                    status.unwrap_or("unset status")
                ));
                None
            }
        }
    }

    /// Resolves `true` when this call performed the cleanup (false: a
    /// concurrent teardown won; a joiner\'s options are ignored).
    ///
    /// # Errors
    ///
    /// Never returns `Err`: a failed teardown task is swallowed and reported as `Ok(false)`.
    pub async fn shutdown(&self, opts: KernelShutdownOptions) -> anyhow::Result<bool> {
        let existing = lock(&self.inner.shutdown_memo).as_ref().cloned();
        if let Some(existing) = existing {
            let _ = existing.wait().await;
            return Ok(false);
        }
        let slot = {
            let mut memo = lock(&self.inner.shutdown_memo);
            let slot = MemoSlot::new();
            *memo = Some(slot.clone());
            slot
        };
        lock(&self.inner.guarded).teardown_in_flight += 1;
        self.supersede_protocol_repair();
        let inner = self.inner.clone();
        let result = tokio::spawn(async move {
            let performed = inner.perform_shutdown(opts).await;
            slot.finish(None);
            let mut memo = lock(&inner.shutdown_memo);
            if matches!(memo.as_ref(), Some(current) if Arc::ptr_eq(current, &slot)) {
                *memo = None;
            }
            performed
        })
        .await
        .unwrap_or(false);
        lock(&self.inner.guarded).teardown_in_flight -= 1;
        Ok(result)
    }

    /// Restart the kernel: shut it down with the default options, then start
    /// it again. Does nothing when a concurrent teardown wins the shutdown.
    ///
    /// # Errors
    ///
    /// Returns an error when a dispose flush owns the queue tail, or the shutdown or start fails.
    pub async fn restart(&self) -> anyhow::Result<()> {
        // Taking a slot now and joining the in-flight shutdown would deadlock:
        // the flush\'s snapshot waits on our slot while we wait on the flush\'s shutdown.
        if lock(&self.inner.guarded).flushing_snapshot_for_dispose {
            return Err(anyhow!("Kernel is shutting down"));
        }
        let _queue_guard = self.inner.execution_queue.lock().await;
        let performed = self.shutdown(KernelShutdownOptions::default()).await?;
        if !performed {
            return Ok(());
        }
        lock(&self.inner.guarded).state = KernelState::Idle;
        lock(&self.inner.guarded).kernel_stderr.clear();
        self.start(KernelStartOptions::default()).await
    }

    pub fn kill(&self) {
        self.supersede_protocol_repair();
        {
            let mut g = lock(&self.inner.guarded);
            g.state = KernelState::Shutdown;
        }
        live_kernels::remove_inner(&self.inner);
        self.inner.cleanup_resources(Signal::Kill);
    }

    /// Synchronous best-effort cleanup. Safe to call from drop paths.
    pub fn dispose_sync(&self) {
        self.supersede_protocol_repair();
        lock(&self.inner.guarded).state = KernelState::Shutdown;
        live_kernels::remove_inner(&self.inner);
        self.inner.cleanup_resources(Signal::Term);
    }
}
