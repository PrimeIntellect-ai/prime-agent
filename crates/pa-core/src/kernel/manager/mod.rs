//! Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
//! (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr kept
//! as a diagnostics tail. The protocol is documented in
//! prime-agent-runtime/src/rlm/repl.md (protocol version 3).
//!
//! Ported from `core/kernel/repl-manager.ts`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use std::io::Write;

use anyhow::anyhow;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Notify};

use crate::kernel::cancellation::{merge_signals, AbortSignal};
use crate::kernel::live_kernels;
use crate::kernel::orphan_journal;
use crate::kernel::protocol::{parse_event, Event, Request, REPL_PROTOCOL_VERSION};
use crate::kernel::shared::*;
use crate::kernel::state_snapshot::{
    RestoreResult, SnapshotResult, SnapshotSkip, DEFAULT_SNAPSHOT_MAX_BYTES,
    DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
};

const READY_TIMEOUT_MS: u64 = 30_000;
const REPAIR_STEP_TIMEOUT_MS: u64 = 30_000;
/// Runtime-minted host-request ids never repeat; the bound only guards a
/// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS: usize = 1024;

/// Progress callback for kernel bootstrap (`ensure_kernel_python`).
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
                    _ = signal.cancelled() => Err(anyhow!("{message}")),
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
    /// snapshot itself is the declared culprit).
    pending_restore: bool,
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
    host_inflight: Vec<tokio::task::JoinHandle<()>>,
    active_execution: Option<Arc<ActiveExecution>>,
    /// Source of the most recently started cell, retained after it finishes so
    /// rlm.run spawns from detached asyncio tasks (cell already idle) can
    /// still attribute their spawning program.
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

impl Drop for Inner {
    fn drop(&mut self) {
        // Synchronous best-effort cleanup, mirroring disposeSync().
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

impl ReplKernelManager {
    pub fn new(options: KernelManagerOptions) -> Self {
        let inner = Arc::new(Inner {
            options,
            resolved_python: Mutex::new(None),
            guarded: Mutex::new(Guarded {
                state: KernelState::Idle,
                start_generation: 0,
                graceful_shutdown_generation: None,
                teardown_in_flight: 0,
                startup_protocol_error: None,
                pending_rebootstrap: false,
                pending_restore: false,
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

    pub fn owner_session_id(&self) -> Option<&str> {
        self.inner.options.session_id.as_deref()
    }

    pub fn has_background_work(&self) -> bool {
        !lock(&self.inner.guarded).background_bash_handles.is_empty()
    }

    /// Process id of the spawned kernel child, when present. Used by tests and
    /// orphan bookkeeping; not part of the TS surface.
    pub fn process_id(&self) -> Option<i32> {
        lock(&self.inner.child).as_ref().map(|c| c.pid)
    }

    pub fn is_running(&self) -> bool {
        lock(&self.inner.guarded).state == KernelState::Running
    }

    /// Terminal: the kernel died or was torn down; only a fresh manager can serve again.
    pub fn is_defunct(&self) -> bool {
        lock(&self.inner.guarded).state == KernelState::Shutdown
    }

    /// Diagnostics tail (kernel stderr, at most the last 8 KiB).
    pub fn kernel_stderr(&self) -> String {
        lock(&self.inner.guarded).kernel_stderr.clone()
    }

    // ---------------------------------------------------------------- start

    /// Start the kernel, memoizing concurrent callers onto one startup.
    /// An aborted signal abandons the wait without stopping the underlying
    /// startup, mirroring the TS `raceStartupWithAbort`.
    ///
    /// # Errors
    ///
    /// Returns an error when the abort signal is already cancelled or fires
    /// during the wait, when the kernel process fails to spawn or bootstrap,
    /// or when the startup task itself fails to join.
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
                    _ = signal.cancelled() => {
                        // The startup keeps running for other callers.
                        Err(anyhow!("Kernel startup aborted"))
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------- execute

    /// Execute one cell. Refreshes the on-disk snapshot after real work so a
    /// later resume (or a crash before graceful shutdown) revives the most
    /// recent namespace.
    ///
    /// # Errors
    ///
    /// Returns an error when the in-flight protocol repair fails, or when the
    /// enqueued execution fails (kernel error, timeout, or aborted request).
    pub async fn execute(&self, code: &str, opts: ExecuteOptions) -> anyhow::Result<ExecuteResult> {
        self.wait_for_protocol_repair(opts.signal.as_ref()).await?;
        let result = self.enqueue_execute(code, opts, None).await?;
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
    /// Returns an error when the kernel is not running, the action is
    /// unknown, `tail`/`kill` is missing its activity id, the `tail` line
    /// count is out of the 1..=200 range, or the request to the kernel
    /// fails.
    pub async fn bash_activity(
        &self,
        action: &str,
        activity_id: Option<&str>,
        lines: usize,
    ) -> anyhow::Result<Value> {
        if !self.is_running() {
            return Err(anyhow!("Kernel is not running"));
        }
        // The runtime's pre-validation answers with a protocol error that
        // carries no request id (so the waiter could only time out);
        // mirror the contract locally and fail fast instead.
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
        let fields = if let Ok(Ok(fields)) = tokio::time::timeout(Duration::from_secs(3), rx).await
        {
            fields
        } else {
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

    /// Revive a previously snapshotted namespace into the kernel. Call right
    /// after `start()` and before the runtime bootstrap, which then refreshes
    /// live handles (rlm, skills) over anything restored.
    pub async fn restore_state(&self) -> Option<RestoreResult> {
        self.perform_restore(false).await
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

    /// Per-server MCP tool listing for the host's connections view (the
    /// runtime `mcp_status` request): one entry per requested server with
    /// its tool names/descriptions, or the error string when that server
    /// failed or timed out. `None` when the kernel isn't running.
    ///
    /// The listing opens each not-yet-connected server (bounded by
    /// `per_server_timeout_ms`), so the call can take seconds; callers
    /// bound it with their own deadline.
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
        let opts = ExecuteOptions {
            internal: true,
            ..ExecuteOptions::default()
        };
        let request = Request::McpStatus {
            servers: servers.to_vec(),
            timeout_ms: per_server_timeout_ms,
        };
        match self.enqueue_request(request, "", opts, None).await {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                let connections = r
                    .done_fields
                    .as_ref()
                    .and_then(|fields| fields.get("connections"))
                    .and_then(Value::as_array)
                    .cloned();
                Some(connections.unwrap_or_default())
            }
            Ok(r) => {
                self.inner.append_diagnostic(&format!(
                    "mcp tool listing failed: {}",
                    describe_failure(&r.result)
                ));
                None
            }
            Err(error) => {
                self.inner
                    .append_diagnostic(&format!("mcp tool listing error: {error:#}"));
                None
            }
        }
    }

    // ----------------------------------------------------- lifecycle (rest)

    /// Resolves `true` when this call performed the cleanup (false: a
    /// concurrent teardown won; a joiner\'s options are ignored — the first
    /// caller\'s policy wins).
    ///
    /// # Errors
    ///
    /// The current implementation never returns `Err`: a failed teardown
    /// task is swallowed and reported as `Ok(false)`.
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
    /// Returns an error when a final dispose flush owns the queue tail, or
    /// when the underlying shutdown or start fails.
    pub async fn restart(&self) -> anyhow::Result<()> {
        // A final dispose flush owns the queue tail. Taking a slot now and
        // joining the in-flight shutdown would deadlock: the flush\'s snapshot
        // waits on our slot while we wait on the flush\'s shutdown.
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

    pub async fn kill(&self) {
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
