//! The user bash surface: the worker arms for `execute_bash`,
//! `execute_bash_and_wait`, and `abort_bash`, with
//! `bash_start`/`bash_output`/`bash_end` events and the `bashExecution`
//! durable row. A TS-stack port: sanitization, the 50KB window, the spill.

use std::io::Write;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// How long a run still reads output after its shell exits (TS `EXIT_STDIO_GRACE_MS`): a
/// background process holding the inherited pipes must not hold the run open.
const EXIT_STDIO_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
/// How long a closing session waits for its aborted runs to settle (TS
/// `UPDATE_RESTART_ABORT_BASH_TIMEOUT_MS`).
const CLOSE_SETTLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Streaming window: chunks are retained (spilled to disk beyond this).
const DEFAULT_MAX_BYTES: usize = 50 * 1024;
/// Streaming retention cap: the in-memory tail (TS `maxOutputBytes`).
const STREAM_MAX_BYTES: usize = DEFAULT_MAX_BYTES * 2;
/// Tail truncation line budget (TS `DEFAULT_MAX_LINES`).
const DEFAULT_MAX_LINES: usize = 2000;
/// The TS spill prefix (temp file names in `$TMPDIR`).
const SPILL_PREFIX: &str = "pa-bash";

/// The user-bash slot: one command runs at a time (TS `_userBashRunning`),
/// with a kill switch `abort_bash` pulls.
pub(crate) struct UserBash {
    /// The user-bash claim (`execute_bash` only; TS `runUserBash` guard).
    running: AtomicBool,
    /// Awaited bash runs in flight (TS `_bashAbortControllers.size`):
    /// they count toward `isBashRunning` without claiming the slot.
    awaited: AtomicUsize,
    /// Each invocation owns its cancellation state; a later start cannot clear an earlier abort.
    controllers: std::sync::Mutex<Vec<std::sync::Weak<CancellationToken>>>,
    /// Signals each settle (the slot's release or an awaited run's end).
    settled: Notify,
}

impl UserBash {
    pub(crate) fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            awaited: AtomicUsize::new(0),
            controllers: std::sync::Mutex::new(Vec::new()),
            settled: Notify::new(),
        }
    }

    /// Claim and register synchronously, before the spawned task can race an abort.
    fn claim(&self) -> Option<Arc<CancellationToken>> {
        let mut controllers = self.controllers.lock().unwrap();
        if self.running.swap(true, Ordering::SeqCst) {
            return None;
        }
        let cancellation = Arc::new(CancellationToken::new());
        controllers.retain(|controller| controller.strong_count() > 0);
        controllers.push(Arc::downgrade(&cancellation));
        Some(cancellation)
    }

    fn release(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.settled.notify_waiters();
    }

    /// Whether a user bash or an awaited bash run is in flight (TS `isBashRunning`).
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst) || self.awaited.load(Ordering::SeqCst) > 0
    }

    /// Count one awaited run (`execute_bash_and_wait`) toward [`Self::is_running`]; the returned
    /// bracket decrements on drop, so a dropped future cannot leave the count stuck on.
    pub(crate) fn begin_awaited(&self) -> AwaitedRun<'_> {
        let mut controllers = self.controllers.lock().unwrap();
        let cancellation = Arc::new(CancellationToken::new());
        controllers.retain(|controller| controller.strong_count() > 0);
        controllers.push(Arc::downgrade(&cancellation));
        self.awaited.fetch_add(1, Ordering::SeqCst);
        AwaitedRun {
            user_bash: self,
            cancellation,
        }
    }

    /// Notify every in-flight run to kill its process tree (TS `abortBash`
    /// aborts every controller); the settled runs report cancelled.
    pub(crate) fn abort(&self) {
        let mut controllers = self.controllers.lock().unwrap();
        controllers.retain(|controller| {
            if let Some(controller) = controller.upgrade() {
                controller.cancel();
                true
            } else {
                false
            }
        });
    }

    /// [`Self::abort`], then wait (bounded) until no run is in flight: each run kills its tree
    /// in its own task, so a close must not exit ahead of the kills (TS `abortBashForClose`).
    pub(crate) async fn abort_and_settle(&self) {
        self.abort();
        let settled = async {
            loop {
                // Armed before the check, so a settle in between still wakes this wait.
                let notified = self.settled.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if !self.is_running() {
                    return;
                }
                notified.await;
            }
        };
        let _ = tokio::time::timeout(CLOSE_SETTLE_TIMEOUT, settled).await;
    }
}

impl Worker {
    /// Rust-native kernel bash activity commands. These inspect the Python
    /// handle registry, not the user-bash slot or a client-supplied PID.
    pub(crate) async fn handle_kernel_bash_activity(
        &self,
        command_type: &str,
        payload: &Value,
    ) -> DaemonResponse {
        if let Err(response) = self.require_created(command_type) {
            return response;
        }
        let Some(engine) = &self.agent_engine else {
            return response_failure(None, command_type, "Kernel is not running", None);
        };
        let action = match command_type {
            "list_kernel_bash" => "list",
            "tail_kernel_bash" => "tail",
            "kill_kernel_bash" => "kill",
            _ => return response_failure(None, command_type, "Unknown kernel bash command", None),
        };
        let activity_id = payload.get("activityId").and_then(Value::as_str);
        if action != "list" && activity_id.is_none_or(str::is_empty) {
            return response_failure(None, command_type, "activityId is required", None);
        }
        let lines = if action == "tail" {
            match payload.get("lines") {
                None => 50,
                Some(value) => match value.as_u64() {
                    Some(lines) if (1..=200).contains(&lines) => lines as usize,
                    _ => {
                        return response_failure(
                            None,
                            command_type,
                            "lines must be between 1 and 200",
                            None,
                        )
                    }
                },
            }
        } else {
            50
        };
        match engine.bash_activity(action, activity_id, lines).await {
            Ok(mut fields) => {
                if let Some(object) = fields.as_object_mut() {
                    object.remove("event");
                    object.remove("status");
                    object.remove("reason");
                    object.remove("id"); // kernel request id, not activity id
                    object.remove("activityId");
                    if let Some(activity_id) = activity_id {
                        object.insert("id".to_string(), json!(activity_id));
                    }
                }
                response_success(None, command_type, Some(fields))
            }
            Err(error) => response_failure(None, command_type, &error.to_string(), None),
        }
    }

    /// `execute_bash { command, excludeFromContext?, transient?, runId? }`
    /// (TS `runUserBash`): the running guard rejects a second command;
    /// the response goes out before completion, output streams as
    /// `bash_output`, and the settled `bash_end` (plus the durable row) follows.
    pub(crate) fn handle_execute_bash(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("execute_bash") {
            return response;
        }
        let Some(command) = payload.get("command").and_then(Value::as_str) else {
            return response_failure(
                None,
                "execute_bash",
                "execute_bash requires a command",
                None,
            );
        };
        // Claim the slot synchronously (TS claims before the async dispatch
        // could slip a second command through), through the admission gate:
        // the gate re-check and the claim share the lock, so the close's
        // abort cannot miss the new token (a claim its `abort_and_settle`
        // missed would leave the child running past the exit).
        let cancellation = match self.admit_streamed_bash() {
            Ok(cancellation) => cancellation,
            Err(response) => return response,
        };
        let exclude_from_context = payload
            .get("excludeFromContext")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let transient = payload
            .get("transient")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let run_id = payload.get("runId").and_then(Value::as_str);
        let identity = bash_identity(transient, run_id);
        let start = json!({
            "type": "bash_start",
            "command": command,
            "excludeFromContext": exclude_from_context,
        });
        let start = merge_identity(start, &identity);
        self.emit_worker_event(start);
        // The run outlives the response (bash can exceed the client's
        // request timeout); completion streams via bash_end.
        let core = Arc::clone(&self.core);
        let events = self.events.clone();
        let user_bash = Arc::clone(&self.user_bash);
        let work_notify = Arc::clone(&self.work_notify);
        let command = command.to_string();
        let agent_dir = self.config.agent_dir.clone();
        tokio::spawn(async move {
            let cwd = {
                let core = core.lock().unwrap();
                core.cwd.clone()
            };
            let settings = {
                let core = core.lock().unwrap();
                pa_core::settings::SettingsManager::create(&core.cwd, &agent_dir)
            };
            let prefix = settings.settings().shell_command_prefix.clone();
            let shell_path = settings.settings().shell_path.clone();
            let end = run_bash(RunBash {
                command: &command,
                cwd: &cwd,
                prefix: prefix.as_deref(),
                shell_path: shell_path.as_deref(),
                cancellation: &cancellation,
                on_chunk: Some((Arc::clone(&core), Arc::clone(&events))),
            })
            .await;
            // Persist the durable row (transient runs live only in their
            // pane; reloads and rebuilds cannot resurface them).
            if !transient {
                record_bash_result(
                    &core,
                    &command,
                    &BashResult {
                        output: end.output.clone(),
                        exit_code: end.exit_code,
                        cancelled: end.cancelled,
                        truncated: end.truncated,
                        full_output_path: end.full_output_path.clone(),
                    },
                    exclude_from_context,
                );
            }
            user_bash.release();
            let mut event = json!({
                "type": "bash_end",
                "exitCode": end.exit_code,
                "cancelled": end.cancelled,
                "truncated": end.truncated,
            });
            if let Some(path) = &end.full_output_path {
                event["fullOutputPath"] = json!(path);
            }
            if let Some(error) = &end.error_message {
                event["errorMessage"] = json!(error);
            }
            let event = merge_identity(event, &identity);
            emit_session_event_frame(&core, &events, event);
            // The queue drains after the slot is released (TS
            // `_drainQueuedMessagesAfterBash`).
            work_notify.notify_one();
        });
        response_success(None, "execute_bash", None)
    }

    /// `require_created`'s shutdown gate re-checked with the streamed slot
    /// claim under the same lock: the claim cannot interleave with the gate's
    /// close, so the close's abort always sees — and cancels — the new token
    /// (a claim its `abort_and_settle` missed would leave the child running
    /// past the exit).
    // DaemonResponse is the wire response struct and is deliberately wide; the
    // error channel here carries the whole response, so allow the large-err lint.
    #[allow(clippy::result_large_err)]
    pub(crate) fn admit_streamed_bash(&self) -> Result<Arc<CancellationToken>, DaemonResponse> {
        let core = self.core.lock().unwrap();
        if core.shutdown_requested {
            return Err(response_failure(
                None,
                "execute_bash",
                "Session is shutting down",
                None,
            ));
        }
        self.user_bash.claim().ok_or_else(|| {
            response_failure(
                None,
                "execute_bash",
                "A bash command is already running",
                None,
            )
        })
    }

    /// `require_created`'s shutdown gate re-checked and the awaited run
    /// registered under the same lock: the registration cannot interleave
    /// with the gate's close, so the close's abort always sees — and cancels —
    /// the new token (a registration its `abort_and_settle` missed would let
    /// a child outlive the exit).
    // DaemonResponse is the wire response struct and is deliberately wide; the
    // error channel here carries the whole response, so allow the large-err lint.
    #[allow(clippy::result_large_err)]
    pub(crate) fn admit_awaited_bash(&self) -> Result<AwaitedRun<'_>, DaemonResponse> {
        let core = self.core.lock().unwrap();
        if core.shutdown_requested {
            return Err(response_failure(
                None,
                "execute_bash_and_wait",
                "Session is shutting down",
                None,
            ));
        }
        Ok(self.user_bash.begin_awaited())
    }

    /// `execute_bash_and_wait { command }` (TS `executeBash`): run to
    /// completion, record the row, answer the `BashResult` wire shape.
    pub(crate) async fn handle_execute_bash_and_wait(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("execute_bash_and_wait") {
            return response;
        }
        let Some(command) = payload.get("command").and_then(Value::as_str) else {
            return response_failure(
                None,
                "execute_bash_and_wait",
                "execute_bash_and_wait requires a command",
                None,
            );
        };
        let (cwd, prefix, shell_path) = {
            let core = self.core.lock().unwrap();
            let settings =
                pa_core::settings::SettingsManager::create(&core.cwd, &self.config.agent_dir);
            let settings = settings.settings();
            (
                core.cwd.clone(),
                settings.shell_command_prefix.clone(),
                settings.shell_path.clone(),
            )
        };
        let command = command.to_string();
        // The awaited run counts toward `isBashRunning` without
        // blocking a streamed user bash. The admission re-checks the
        // shutdown gate and registers under the same lock, so a close
        // cannot slip between them: it either sees the gate shut (and
        // the dispatch is rejected) or aborts a token that is already
        // registered (a registration after its abort would leave a
        // child the exit orphans).
        let awaited = match self.admit_awaited_bash() {
            Ok(awaited) => awaited,
            Err(response) => return response,
        };
        let end = run_bash(RunBash {
            command: &command,
            cwd: &cwd,
            prefix: prefix.as_deref(),
            shell_path: shell_path.as_deref(),
            cancellation: &awaited.cancellation,
            // The awaited path emits nothing (TS passes no `onChunk`).
            on_chunk: None,
        })
        .await;
        // The durable row lands while the run still counts: the orphan
        // monitor treats `!is_running` as exit permission, so an awaited
        // result released before its row (the streamed path persists,
        // then releases) could be lost to a racing orphan exit.
        self.roster_pushes.push();
        if let Some(error) = &end.error_message {
            drop(awaited);
            return response_failure(None, "execute_bash_and_wait", error, None);
        }
        let result = BashResult {
            output: end.output,
            exit_code: end.exit_code,
            cancelled: end.cancelled,
            truncated: end.truncated,
            full_output_path: end.full_output_path,
        };
        record_bash_result(&self.core, &command, &result, false);
        drop(awaited);
        response_success(
            None,
            "execute_bash_and_wait",
            Some(serde_json::to_value(&result).unwrap_or(Value::Null)),
        )
    }

    /// `abort_bash` (TS `abortBash`): kill the in-flight command; the
    /// settled run reports cancelled. Always a success.
    pub(crate) fn handle_abort_bash(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("abort_bash") {
            return response;
        }
        self.user_bash.abort();
        response_success(None, "abort_bash", None)
    }
}

/// The wire identity echoed on `bash_start`/`bash_end` (TS `identity`).
fn bash_identity(transient: bool, run_id: Option<&str>) -> Value {
    let mut identity = serde_json::Map::new();
    if transient {
        identity.insert("transient".to_string(), json!(true));
    }
    if let Some(run_id) = run_id {
        identity.insert("runId".to_string(), json!(run_id));
    }
    Value::Object(identity)
}

fn merge_identity(mut event: Value, identity: &Value) -> Value {
    if let (Some(event), Some(identity)) = (event.as_object_mut(), identity.as_object()) {
        for (key, value) in identity {
            event.insert(key.clone(), value.clone());
        }
    }
    event
}

/// The drop-bracket [`UserBash::begin_awaited`] returns: one awaited run's contribution to the
/// `isBashRunning` flag, released even when the run's future is dropped mid-await.
pub(crate) struct AwaitedRun<'a> {
    user_bash: &'a UserBash,
    cancellation: Arc<CancellationToken>,
}

impl Drop for AwaitedRun<'_> {
    fn drop(&mut self) {
        self.user_bash.awaited.fetch_sub(1, Ordering::SeqCst);
        self.user_bash.settled.notify_waiters();
    }
}

/// The TS `BashResult` wire shape.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BashResult {
    output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    cancelled: bool,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    full_output_path: Option<String>,
}

/// The settled user-bash run (TS `UserBashEndDetails` plus the output it
/// carries for the durable row).
struct BashEnd {
    output: String,
    exit_code: Option<i64>,
    cancelled: bool,
    truncated: bool,
    full_output_path: Option<String>,
    error_message: Option<String>,
}

/// One process run (TS `executeBashWithOperations` over the local bash
/// operations): the streaming window, the spill, and the tail truncation.
struct RunBash<'a> {
    command: &'a str,
    cwd: &'a str,
    prefix: Option<&'a str>,
    shell_path: Option<&'a str>,
    cancellation: &'a CancellationToken,
    /// The streaming emit target for each sanitized chunk; `None` on
    /// the awaited path, which emits nothing.
    on_chunk: Option<(
        Arc<std::sync::Mutex<crate::worker::SessionCore>>,
        Arc<crate::worker::EventPump>,
    )>,
}

/// The streaming accumulator (TS `onData`): the sanitizing decode, the
/// spill, the in-memory tail window, and the chunk callback.
struct OutputStream {
    chunks: Vec<String>,
    retained_bytes: usize,
    total_bytes: usize,
    spill: OutputSpill,
    on_chunk: Option<(
        Arc<std::sync::Mutex<crate::worker::SessionCore>>,
        Arc<crate::worker::EventPump>,
    )>,
}

impl Clone for OutputStream {
    fn clone(&self) -> Self {
        Self {
            chunks: self.chunks.clone(),
            retained_bytes: self.retained_bytes,
            total_bytes: self.total_bytes,
            spill: OutputSpill::new(),
            on_chunk: self.on_chunk.clone(),
        }
    }
}

impl OutputStream {
    /// The collected view (the shared clone path): this port never clones
    /// mid-run, but the fallback keeps the collected chunks.
    fn clone_stream(&self) -> Self {
        self.clone()
    }

    fn push(&mut self, data: &[u8]) {
        let text = sanitize_output(&String::from_utf8_lossy(data));
        if text.is_empty() {
            return;
        }
        self.total_bytes += text.len();
        if self.total_bytes > DEFAULT_MAX_BYTES {
            self.spill.open(&self.chunks);
        }
        self.spill.write(&text);
        self.chunks.push(text.clone());
        self.retained_bytes += self.chunks.last().map(String::len).unwrap_or_default();
        // The in-memory window keeps the tail (TS `maxOutputBytes`).
        while self.retained_bytes > STREAM_MAX_BYTES && self.chunks.len() > 1 {
            let removed = self.chunks.remove(0);
            self.retained_bytes -= removed.len();
        }
        if let Some((core, events)) = &self.on_chunk {
            emit_session_event_frame(
                core,
                events,
                json!({ "type": "bash_output", "chunk": text }),
            );
        }
    }
}

async fn run_bash(run: RunBash<'_>) -> BashEnd {
    let resolved = match run.prefix.filter(|prefix| !prefix.is_empty()) {
        Some(prefix) => format!("{prefix}\n{}", run.command),
        None => run.command.to_string(),
    };
    let spawn_failure = |message: String| BashEnd {
        output: String::new(),
        exit_code: None,
        cancelled: false,
        truncated: false,
        full_output_path: None,
        error_message: Some(message),
    };
    if !std::path::Path::new(run.cwd).exists() {
        // TS local operations reject before spawning.
        return spawn_failure(format!(
            "Working directory does not exist: {}\nCannot execute bash commands.",
            run.cwd
        ));
    }
    let shell = match pa_core::platform::shell::get_shell_config(run.shell_path) {
        Ok(shell) => shell,
        Err(error) => return spawn_failure(error.to_string()),
    };
    let mut command = tokio::process::Command::new(&shell.shell);
    command
        .args(&shell.args)
        .arg(&resolved)
        .current_dir(run.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group on POSIX, so a kill reaches every process the
    // command started (TS `detached: true`); Windows tree kills go through
    // `taskkill /T`.
    #[cfg(unix)]
    pa_core::platform::process::set_new_process_group(command.as_std_mut());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return spawn_failure(error.to_string()),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Only this run kills its tree, and only before it reaps the child: a
    // reaped pid can be reused. A failed tree kill still stops the shell.
    let kill_tree = |child: &mut tokio::process::Child| {
        let killed = child
            .id()
            .is_some_and(|pid| pa_core::platform::process::kill_process_group_or_pid(pid as i32));
        if !killed {
            let _ = child.start_kill();
        }
    };
    let abort = run.cancellation.cancelled();
    tokio::pin!(abort);
    // Cancellation remains sticky even if another command starts before this task runs.
    let mut killed = run.cancellation.is_cancelled();
    if killed {
        kill_tree(&mut child);
    }
    let stream = std::sync::Arc::new(std::sync::Mutex::new(OutputStream {
        chunks: Vec::new(),
        retained_bytes: 0,
        total_bytes: 0,
        spill: OutputSpill::new(),
        on_chunk: run.on_chunk,
    }));
    // stdout and stderr merge into one stream (TS wires both pipes to the
    // same `onData`); the shared accumulator keeps the arrival order.
    let pump = |mut reader: Box<dyn AsyncRead + Unpin + Send>| {
        let stream = Arc::clone(&stream);
        async move {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => stream.lock().unwrap().push(&buffer[..read]),
                }
            }
        }
    };
    let stdout_pump = stdout.map(|pipe| pump(Box::new(pipe)));
    let stderr_pump = stderr.map(|pipe| pump(Box::new(pipe)));
    let mut pumps = Box::pin(async move {
        match (stdout_pump, stderr_pump) {
            (Some(stdout_pump), Some(stderr_pump)) => {
                futures::future::join(stdout_pump, stderr_pump).await;
            }
            (Some(pump), None) | (None, Some(pump)) => pump.await,
            (None, None) => {}
        }
    });
    let mut pumps_done = false;
    // The run settles on the shell's exit, not on its pipes closing
    // (abort_bash may kill it meanwhile; a cancelled run reports no exit code).
    let status = loop {
        tokio::select! {
            // If both are ready, kill while the unreaped child still pins its PID.
            biased;
            () = &mut abort, if !killed => {
                killed = true;
                kill_tree(&mut child);
            }
            status = child.wait() => break status,
            () = &mut pumps, if !pumps_done => pumps_done = true,
        }
    };
    // Descendants still holding the pipes (a `cmd &`) get the grace, then the
    // pipes close (TS `waitForChildProcess`).
    if !pumps_done {
        let _ = tokio::time::timeout(EXIT_STDIO_GRACE, &mut pumps).await;
    }
    drop(pumps);
    // A signal death reports 128 + the signal number, like a shell's `$?` (TS
    // `normalizedExitCode`); a cancelled run still reports none below.
    let exit_code = status
        .ok()
        .and_then(|status| {
            status.code().or_else(|| {
                pa_core::platform::process::termination_signal(&status).map(|signal| 128 + signal)
            })
        })
        .map(i64::from);
    let cancelled = run.cancellation.is_cancelled();
    // The pumps are dropped, so this is the last reference; a poisoned
    // lock (a reader panicked) keeps whatever it collected.
    let mut stream = match Arc::try_unwrap(stream) {
        Ok(mutex) => mutex
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        Err(stream) => stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone_stream(),
    };
    let full_output = stream.chunks.join("");
    let (output, truncated) = truncate_tail(&full_output);
    // A line-truncated run spills at settle even under the byte budget,
    // so the truncation notice can always name a full-output file.
    if truncated {
        stream.spill.open(&stream.chunks);
    }
    let full_output_path = stream.spill.finalize();
    BashEnd {
        output,
        exit_code: if cancelled { None } else { exit_code },
        cancelled,
        truncated,
        full_output_path,
        error_message: None,
    }
}

/// Record one bash outcome as the durable `bashExecution` row (TS
/// `recordBashResult`); it joins the model context unless excluded.
fn record_bash_result(
    core: &Arc<std::sync::Mutex<crate::worker::SessionCore>>,
    command: &str,
    result: &BashResult,
    exclude_from_context: bool,
) {
    let mut core = core.lock().unwrap();
    let Some(store) = core.store.as_mut() else {
        return;
    };
    let mut row = json!({
        "role": "bashExecution",
        "command": command,
        "output": result.output,
        "cancelled": result.cancelled,
        "truncated": result.truncated,
        "timestamp": crate::util::now_ms(),
    });
    if let Some(exit_code) = result.exit_code {
        row["exitCode"] = json!(exit_code);
    }
    if let Some(path) = &result.full_output_path {
        row["fullOutputPath"] = json!(path);
    }
    if exclude_from_context {
        row["excludeFromContext"] = json!(true);
    }
    let _ = store.persist_entry("message", json!({ "message": row }));
}

/// Sanitize one output chunk (TS `strip-ansi` + `sanitizeBinaryOutput` +
/// the `\r` strip in the executor's `onData`).
fn sanitize_output(text: &str) -> String {
    let stripped = strip_ansi(text);
    let mut out = String::with_capacity(stripped.len());
    for character in stripped.chars() {
        let code = character as u32;
        // Tab, newline, carriage return stay.
        if matches!(code, 0x09 | 0x0a | 0x0d) {
            out.push(character);
            continue;
        }
        // Control characters and the format characters that break width
        // rendering drop.
        if code <= 0x1f || (0xfff9..=0xfffb).contains(&code) {
            continue;
        }
        out.push(character);
    }
    out.replace('\r', "")
}

/// Strip ANSI escape sequences (CSI sequences and the simple two-byte
/// escapes the `strip-ansi` package handles).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates run to the final byte (0x40-0x7e).
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // A simple escape sequence: one following byte.
            Some(_) => {}
            // A trailing escape with nothing after it drops.
            None => break,
        }
    }
    out
}

/// The output spill (TS `OutputSpill`): opened once the output outgrows
/// the window; a degraded spill never advertises a path.
struct OutputSpill {
    file: Option<std::fs::File>,
    path: Option<String>,
    failed: bool,
}

impl OutputSpill {
    fn new() -> Self {
        Self {
            file: None,
            path: None,
            failed: false,
        }
    }

    fn open(&mut self, replay: &[String]) {
        if self.file.is_some() || self.failed {
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "{SPILL_PREFIX}-{}.log",
            uuid::Uuid::new_v4().simple()
        ));
        let Ok(mut file) = std::fs::File::create(&path) else {
            self.failed = true;
            return;
        };
        for chunk in replay {
            if file.write_all(chunk.as_bytes()).is_err() {
                self.failed = true;
                return;
            }
        }
        self.path = Some(path.to_string_lossy().to_string());
        self.file = Some(file);
    }

    fn write(&mut self, text: &str) {
        let Some(file) = self.file.as_mut() else {
            return;
        };
        if file.write_all(text.as_bytes()).is_err() {
            self.failed = true;
            self.file = None;
            self.path = None;
        }
    }

    fn finalize(mut self) -> Option<String> {
        if let Some(file) = self.file.as_mut() {
            if file.flush().is_err() {
                self.failed = true;
            }
        }
        self.file = None;
        if self.failed {
            None
        } else {
            self.path
        }
    }
}

/// Tail truncation (TS `truncateTail`): the last 2000 lines within 50KB
/// win; an oversized last line keeps its tail, blank trailing lines permitting.
fn truncate_tail(content: &str) -> (String, bool) {
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();
    if total_lines <= DEFAULT_MAX_LINES && total_bytes <= DEFAULT_MAX_BYTES {
        return (content.to_string(), false);
    }
    let mut collected: Vec<&str> = Vec::new();
    let mut output_bytes = 0usize;
    for line in lines.iter().rev() {
        if collected.len() >= DEFAULT_MAX_LINES {
            break;
        }
        let line_bytes = line.len() + usize::from(!collected.is_empty());
        if output_bytes + line_bytes > DEFAULT_MAX_BYTES {
            // The oversized-line rescue: trailing blanks must not defeat
            // the rescue, so keep as many as the budget allows and unshift
            // the line's own tail.
            if collected.iter().all(|collected| collected.is_empty()) {
                let kept_blanks = collected.len().min(DEFAULT_MAX_BYTES.saturating_sub(1));
                let budget = DEFAULT_MAX_BYTES.saturating_sub(kept_blanks);
                let truncated_line = truncate_string_to_bytes_from_end(line, budget);
                let mut out = String::with_capacity(DEFAULT_MAX_BYTES);
                out.push_str(&truncated_line);
                for _ in 0..kept_blanks {
                    out.push('\n');
                }
                return (out, true);
            }
            break;
        }
        collected.push(line);
        output_bytes += line_bytes;
    }
    collected.reverse();
    (collected.join("\n"), true)
}

/// The tail `maxBytes` of one string, on char boundaries (TS `truncateStringToBytesFromEnd`).
fn truncate_string_to_bytes_from_end(text: &str, max_bytes: usize) -> String {
    let mut end = text.len().min(max_bytes);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[text.len() - end..].to_string()
}

/// Sequence and broadcast one `session_event` frame (the free-standing
/// form of the worker's emitter the spawned bash task uses).
pub(crate) fn emit_session_event_frame(
    core: &Arc<std::sync::Mutex<crate::worker::SessionCore>>,
    events: &Arc<crate::worker::EventPump>,
    event: Value,
) {
    use crate::protocol::create_daemon_event_meta;
    use crate::protocol::DaemonOutbound;
    use crate::worker::OutboundFrame;
    let mut core = core.lock().unwrap();
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let active_session_id = core.active_session_id.clone();
    let outbound = DaemonOutbound::SessionEvent {
        active_session_id,
        event,
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    drop(core);
    events.send(OutboundFrame::session_event(payload));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker(cwd: &std::path::Path) -> Arc<Worker> {
        std::fs::create_dir_all(cwd).unwrap();
        let dir = std::env::temp_dir().join(format!("pa-worker-bash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "bash-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": cwd.to_string_lossy(), "name": "bash" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    fn bash_rows(worker: &Worker) -> Vec<Value> {
        let core = worker.core.lock().unwrap();
        core.store
            .as_ref()
            .map(|store| {
                store
                    .entries()
                    .iter()
                    .filter(|entry| entry.type_ == "message")
                    .filter_map(|entry| entry.fields.get("message").cloned())
                    .filter(|message| {
                        message.get("role").and_then(Value::as_str) == Some("bashExecution")
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn execute_bash_and_wait_matches_the_ts_result_shape() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let response = worker
            .dispatch(
                "execute_bash_and_wait",
                &json!({ "activeSessionId": "bash-session", "command": "echo hello" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let data = response.data.expect("data");
        assert_eq!(data["output"], json!("hello\n"));
        assert_eq!(data["exitCode"], json!(0));
        assert_eq!(data["cancelled"], json!(false));
        assert_eq!(data["truncated"], json!(false));
        assert!(data.get("fullOutputPath").is_none(), "no spill: {data}");

        let rows = bash_rows(&worker);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["command"], json!("echo hello"));
        assert_eq!(rows[0]["output"], json!("hello\n"));
        assert_eq!(rows[0]["exitCode"], json!(0));
        assert!(rows[0].get("excludeFromContext").is_none());

        // Failures carry the exit status and the merged stderr.
        let response = worker
            .dispatch(
                "execute_bash_and_wait",
                &json!({ "activeSessionId": "bash-session", "command": "echo boom >&2; exit 3" }),
            )
            .await;
        assert!(response.success);
        let data = response.data.expect("data");
        assert_eq!(data["exitCode"], json!(3));
        assert_eq!(data["output"], json!("boom\n"));

        let response = worker
            .dispatch(
                "execute_bash_and_wait",
                &json!({ "activeSessionId": "bash-session" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("execute_bash_and_wait requires a command")
        );
    }

    /// A command whose shell dies by a signal reports 128 + the signal number, like a shell's
    /// `$?` (TS `normalizedExitCode`): with no exit code the model would read it as a success.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_signal_death_reports_128_plus_the_signal() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        for (command, code) in [
            ("kill -TERM $$", 143),
            ("kill -KILL $$", 137),
            ("kill -SEGV $$", 139),
        ] {
            let response = worker
                .dispatch(
                    "execute_bash_and_wait",
                    &json!({ "activeSessionId": "bash-session", "command": command }),
                )
                .await;
            assert!(response.success, "failed: {response:?}");
            assert_eq!(
                response.data,
                Some(json!({
                    "output": "",
                    "exitCode": code,
                    "cancelled": false,
                    "truncated": false,
                })),
                "{command}"
            );
        }
    }

    #[test]
    fn an_abort_stays_with_every_admitted_run_when_another_run_starts() {
        let user_bash = UserBash::new();
        let streamed = user_bash.claim().expect("claim slot");
        let first = user_bash.begin_awaited();
        let second = user_bash.begin_awaited();
        user_bash.abort();
        let later = user_bash.begin_awaited();
        assert_eq!(
            [
                streamed.is_cancelled(),
                first.cancellation.is_cancelled(),
                second.cancellation.is_cancelled(),
                later.cancellation.is_cancelled()
            ],
            [true, true, true, false],
        );
        user_bash.abort();
        assert!(later.cancellation.is_cancelled());
        user_bash.release();
        drop((first, second, later));
        assert!(!user_bash.is_running());
    }

    #[test]
    fn an_abandoned_awaited_run_releases_the_flag() {
        let user_bash = UserBash::new();
        assert!(!user_bash.is_running());
        {
            let _awaited = user_bash.begin_awaited();
            assert!(user_bash.is_running());
        }
        assert!(
            !user_bash.is_running(),
            "the dropped bracket left the awaited count stuck on"
        );
    }

    #[tokio::test]
    async fn an_awaited_bash_run_reports_running_to_the_connection_state() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let runner = std::sync::Arc::clone(&worker);
        let run = tokio::spawn(async move {
            runner
                .dispatch(
                    "execute_bash_and_wait",
                    &json!({ "activeSessionId": "bash-session", "command": "sleep 1" }),
                )
                .await
        });
        let mut saw_running = false;
        for _ in 0..100 {
            let state = worker
                .dispatch(
                    "get_connection_state",
                    &json!({ "activeSessionId": "bash-session" }),
                )
                .await;
            if state.data.expect("state data")["isBashRunning"] == json!(true) {
                saw_running = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            saw_running,
            "the awaited run never reported isBashRunning to the connection state"
        );
        let response = run.await.expect("the awaited run task panicked");
        assert!(response.success, "failed: {response:?}");
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "bash-session" }),
            )
            .await;
        assert_eq!(
            state.data.expect("state data")["isBashRunning"],
            json!(false),
            "the settled run left the flag on"
        );
    }

    #[tokio::test]
    async fn execute_bash_claims_the_slot_and_aborts() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let response = worker
            .dispatch(
                "execute_bash",
                &json!({
                    "activeSessionId": "bash-session",
                    "command": "sleep 2",
                    "excludeFromContext": true,
                }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        assert!(response.data.is_none(), "responds before completion");

        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "bash-session" }),
            )
            .await;
        assert_eq!(state.data.expect("data")["isBashRunning"], json!(true));
        let refusal = worker
            .dispatch(
                "execute_bash",
                &json!({ "activeSessionId": "bash-session", "command": "echo nope" }),
            )
            .await;
        assert!(!refusal.success);
        assert_eq!(
            refusal.error.as_deref(),
            Some("A bash command is already running")
        );

        let aborted = worker
            .dispatch("abort_bash", &json!({ "activeSessionId": "bash-session" }))
            .await;
        assert!(aborted.success, "failed: {aborted:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let state = worker
                .dispatch(
                    "get_connection_state",
                    &json!({ "activeSessionId": "bash-session" }),
                )
                .await;
            if state.data.expect("data")["isBashRunning"] == json!(false) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "bash slot never released"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let rows = bash_rows(&worker);
        assert_eq!(rows.len(), 1, "the cancelled run still records");
        assert_eq!(rows[0]["cancelled"], json!(true));
        assert_eq!(rows[0]["excludeFromContext"], json!(true));
        assert!(
            rows[0].get("exitCode").is_none(),
            "killed runs carry no exit code"
        );
    }

    /// The next `session_event` of `event_type` (bounded: a missing event fails the test).
    #[cfg(unix)]
    async fn next_session_event(
        events: &mut tokio::sync::broadcast::Receiver<Arc<crate::worker::OutboundFrame>>,
        event_type: &str,
    ) -> Value {
        let next = async {
            loop {
                let frame = events.recv().await.expect("the event stream stays live");
                if frame.outbound_type != "session_event" {
                    continue;
                }
                let outbound: Value = serde_json::from_slice(&frame.payload).expect("event JSON");
                if outbound["event"]["type"] == json!(event_type) {
                    return outbound["event"].clone();
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), next)
            .await
            .unwrap_or_else(|_| panic!("no {event_type} event arrived"))
    }

    /// The child a running user bash command forked (the shell runs `sh`, which execs `sleep`).
    /// The child holds a FIFO's write end, so the FIFO reader's EOF is the child's death.
    #[cfg(unix)]
    struct ForkedChild {
        /// Killed on drop until [`Self::assert_killed`] saw the death: a failing run leaks nothing.
        pid: Option<i32>,
        gone: Option<tokio::task::JoinHandle<()>>,
    }

    #[cfg(unix)]
    impl ForkedChild {
        async fn start(
            worker: &Worker,
            cwd: &std::path::Path,
            events: &mut tokio::sync::broadcast::Receiver<Arc<crate::worker::OutboundFrame>>,
        ) -> Self {
            let fifo = cwd.join("child-alive");
            let made = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("run mkfifo");
            assert!(made.success(), "mkfifo failed: {made}");
            let response = worker
                .dispatch(
                    "execute_bash",
                    &json!({
                        "activeSessionId": "bash-session",
                        "command": r#"sh -c 'exec 3<>child-alive; echo "ready $$"; exec sleep 60'; echo after"#,
                    }),
                )
                .await;
            assert!(response.success, "failed: {response:?}");
            let ready = next_session_event(events, "bash_output").await;
            let pid = ready["chunk"]
                .as_str()
                .and_then(|chunk| chunk.trim().strip_prefix("ready "))
                .and_then(|pid| pid.parse().ok());
            assert!(pid.is_some(), "the child reports its pid: {ready}");
            // The child opened its end before `ready`, so this open returns at once.
            let mut reader = std::fs::File::open(&fifo).expect("open the fifo");
            let gone = tokio::task::spawn_blocking(move || {
                std::io::copy(&mut reader, &mut std::io::sink()).expect("drain the fifo");
            });
            ForkedChild {
                pid,
                gone: Some(gone),
            }
        }

        async fn assert_killed(&mut self) {
            let gone = self.gone.take().expect("awaited once");
            tokio::time::timeout(std::time::Duration::from_secs(10), gone)
                .await
                .expect("the command's child is still running")
                .expect("the fifo reader joins");
            self.pid = None;
        }
    }

    #[cfg(unix)]
    impl Drop for ForkedChild {
        fn drop(&mut self) {
            if let Some(pid) = self.pid {
                let _ = pa_core::platform::process::kill_pid(
                    pid,
                    pa_core::platform::process::Signal::Kill,
                );
            }
        }
    }

    /// `abort_bash` kills every process the command started, not just the shell: a surviving
    /// child would keep running and hold the output pipes open.
    #[cfg(unix)]
    #[tokio::test]
    async fn abort_bash_kills_the_commands_child_processes() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let mut events = worker.events.subscribe();
        let mut child = ForkedChild::start(&worker, cwd.path(), &mut events).await;
        let aborted = worker
            .dispatch("abort_bash", &json!({ "activeSessionId": "bash-session" }))
            .await;
        assert!(aborted.success, "failed: {aborted:?}");
        child.assert_killed().await;
        assert_eq!(
            next_session_event(&mut events, "bash_end").await,
            json!({
                "type": "bash_end",
                "exitCode": null,
                "cancelled": true,
                "truncated": false,
            })
        );
    }

    /// The graceful stop's abort reaches the command's children too: the worker's exit never
    /// leaves the user's processes running.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_kills_the_running_commands_child_processes() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let mut events = worker.events.subscribe();
        let mut child = ForkedChild::start(&worker, cwd.path(), &mut events).await;
        let stopped = worker.dispatch("shutdown", &json!({})).await;
        assert!(stopped.success, "failed: {stopped:?}");
        assert!(
            !worker.user_bash.is_running(),
            "the stop answered before the aborted run settled"
        );
        child.assert_killed().await;
    }

    /// A command that backgrounds a process settles when its shell exits: the background process
    /// holding the inherited output pipes does not hold the run open (TS `waitForChildProcess`).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_backgrounded_process_does_not_hold_the_run_open() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let settled = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            worker.dispatch(
                "execute_bash_and_wait",
                &json!({
                    "activeSessionId": "bash-session",
                    "command": "sleep 60 & echo $! > background.pid; echo started",
                }),
            ),
        )
        .await;
        // The background process outlives the run (TS leaves it running too).
        if let Some(pid) = std::fs::read_to_string(cwd.path().join("background.pid"))
            .ok()
            .and_then(|pid| pid.trim().parse().ok())
        {
            let _ =
                pa_core::platform::process::kill_pid(pid, pa_core::platform::process::Signal::Kill);
        }
        let response = settled.expect("the run waited on the backgrounded process");
        assert!(response.success, "failed: {response:?}");
        assert_eq!(
            response.data,
            Some(json!({
                "output": "started\n",
                "exitCode": 0,
                "cancelled": false,
                "truncated": false,
            }))
        );
    }

    #[tokio::test]
    async fn transient_execute_bash_records_nothing() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let response = worker
            .dispatch(
                "execute_bash",
                &json!({
                    "activeSessionId": "bash-session",
                    "command": "echo transient",
                    "transient": true,
                }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let state = worker
                .dispatch(
                    "get_connection_state",
                    &json!({ "activeSessionId": "bash-session" }),
                )
                .await;
            if state.data.expect("data")["isBashRunning"] == json!(false) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "bash slot never released"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(bash_rows(&worker).len(), 0, "transient runs record nothing");
    }

    #[tokio::test]
    async fn execute_bash_and_wait_refuses_a_missing_cwd() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        {
            let mut core = worker.core.lock().unwrap();
            core.cwd = "/nonexistent-bash-cwd".to_string();
        }
        let response = worker
            .dispatch(
                "execute_bash_and_wait",
                &json!({ "activeSessionId": "bash-session", "command": "pwd" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some(
                "Working directory does not exist: /nonexistent-bash-cwd\nCannot execute bash commands."
            )
        );
    }

    #[test]
    fn sanitize_output_matches_the_ts_chain() {
        assert_eq!(sanitize_output("clean\r\noutput"), "clean\noutput");
        assert_eq!(
            sanitize_output("\u{1b}[32mgreen\u{1b}[0m plain"),
            "green plain"
        );
        assert_eq!(
            sanitize_output("keep\ttab\nand\x00drop"),
            "keep\ttab\nanddrop"
        );
        assert_eq!(sanitize_output("format\u{fff9}gone"), "formatgone");
    }

    #[test]
    fn truncate_tail_keeps_the_tail_budget() {
        let (content, truncated) = truncate_tail("one\ntwo\nthree\n");
        assert!(!truncated);
        assert_eq!(content, "one\ntwo\nthree\n");

        // A long output keeps only its tail (the TS window).
        let big = "x".repeat(DEFAULT_MAX_BYTES + 10_000);
        let (kept, truncated) = truncate_tail(&big);
        assert!(truncated);
        assert!(kept.len() <= DEFAULT_MAX_BYTES);
        assert!(big.ends_with(&kept), "the tail wins");
    }

    /// Readiness wait for a racing thread's entered signal: the signal is
    /// what the caller proceeds on — the deadline only bounds failure, it can
    /// never make an assertion pass.
    fn wait_for(signal: &AtomicBool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !signal.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the racing admission never started"
            );
            std::hint::spin_loop();
            std::thread::yield_now();
        }
    }

    #[tokio::test]
    async fn the_shutdown_gate_cannot_close_between_a_streamed_claim_and_its_registration() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;

        // Gate shut: the admission's own re-check rejects, nothing claims.
        worker.core.lock().unwrap().shutdown_requested = true;
        assert!(worker.admit_streamed_bash().is_err());
        assert!(!worker.user_bash.is_running());

        // A gate that closes while a claim waits on the admission lock: the
        // gate check and the claim are one critical section, so the claim
        // cannot slip past the close (a claim the close's abort missed would
        // leave the child running past the exit).
        {
            let mut core = worker.core.lock().unwrap();
            core.shutdown_requested = false;
        }
        let mut gate = worker.core.lock().unwrap();
        // Readiness is the racing admission's own signal, not a fixed sleep:
        // once the thread is inside its call, the held gate pins it to enter
        // the critical section only after the close.
        let entered = Arc::new(AtomicBool::new(false));
        let racing = std::thread::spawn({
            let worker = Arc::clone(&worker);
            let entered = Arc::clone(&entered);
            move || {
                entered.store(true, Ordering::SeqCst);
                worker.admit_streamed_bash().is_ok()
            }
        });
        wait_for(&entered);
        assert!(
            !worker.user_bash.is_running(),
            "the gated claim must not register"
        );
        gate.shutdown_requested = true;
        drop(gate);
        let claimed = racing.join().expect("claim thread");
        assert!(!claimed, "the closed gate must reject it");
        assert!(!worker.user_bash.is_running(), "nothing may register");
    }

    #[tokio::test]
    async fn the_shutdown_gate_cannot_close_between_an_awaited_admission_and_its_registration() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;

        // Gate shut: the admission's own re-check rejects, nothing registers.
        worker.core.lock().unwrap().shutdown_requested = true;
        assert!(worker.admit_awaited_bash().is_err());
        assert!(!worker.user_bash.is_running());

        // A gate that closes while an admission waits on the admission
        // lock: the gate check and the registration are one critical
        // section, so the admission cannot slip past the close (a
        // registration the close's abort missed would leave the child
        // running past the exit).
        {
            let mut core = worker.core.lock().unwrap();
            core.shutdown_requested = false;
        }
        let mut gate = worker.core.lock().unwrap();
        // Readiness is the racing admission's own signal, not a fixed sleep
        // (same as the streamed claim's gate test).
        let entered = Arc::new(AtomicBool::new(false));
        let racing = std::thread::spawn({
            let worker = Arc::clone(&worker);
            let entered = Arc::clone(&entered);
            move || {
                entered.store(true, Ordering::SeqCst);
                worker.admit_awaited_bash().is_ok()
            }
        });
        wait_for(&entered);
        assert!(
            !worker.user_bash.is_running(),
            "the gated admission must not register"
        );
        gate.shutdown_requested = true;
        drop(gate);
        let admitted = racing.join().expect("admission thread");
        assert!(!admitted, "the closed gate must reject it");
        assert!(!worker.user_bash.is_running(), "nothing may register");
    }

    #[tokio::test]
    async fn the_close_abort_cancels_an_admitted_awaited_run_and_settles_after_it() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        let awaited = worker.admit_awaited_bash().expect("gate open");
        assert!(worker.user_bash.is_running());
        let settle = tokio::spawn({
            let worker = Arc::clone(&worker);
            async move { worker.user_bash.abort_and_settle().await }
        });
        // The close's abort cancels the admitted run's token: the token's
        // own cancellation is the observable signal, and the bound only
        // bounds failure.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            awaited.cancellation.cancelled(),
        )
        .await
        .expect("the abort never reached the admitted token");
        // The settle still waits: the run counts until it settles.
        assert!(!settle.is_finished());
        drop(awaited);
        tokio::time::timeout(std::time::Duration::from_secs(2), settle)
            .await
            .expect("the settle completes once the run settles")
            .expect("the settle task joins");
    }

    #[tokio::test]
    async fn an_awaited_dispatch_against_a_closing_gate_records_no_row() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let worker = created_worker(cwd.path()).await;
        worker.core.lock().unwrap().shutdown_requested = true;
        let response = worker
            .dispatch(
                "execute_bash_and_wait",
                &json!({ "activeSessionId": "bash-session", "command": "echo no" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(response.error.as_deref(), Some("Session is shutting down"));
        assert_eq!(
            bash_rows(&worker).len(),
            0,
            "a rejected run records nothing"
        );
        assert!(!worker.user_bash.is_running());
    }
}
