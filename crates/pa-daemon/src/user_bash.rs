//! The user bash surface (protocol breadth wave b5): the worker arms for
//! `execute_bash`, `execute_bash_and_wait`, and `abort_bash` (TS
//! daemon-mode cases over `AgentSession.runUserBash` / `executeBash` /
//! `abortBash`, with `bash_start`/`bash_output`/`bash_end` session events
//! and the `bashExecution` durable row).
//!
//! The execution port follows the TS stack: the local bash operations
//! (shell config, cwd guard, merged stdout+stderr streaming, kill on
//! abort), the executor (ANSI/binary sanitization, the 50KB streaming
//! window with the tail kept, the 2000-line/50KB tail truncation, the
//! spill file), and the user-bash wrapper (the already-running guard, the
//! identity echoed on start/end, transient rows staying unrecorded).

use std::io::Write;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// Streaming window: chunks are retained (spilled to disk beyond this).
const DEFAULT_MAX_BYTES: usize = 50 * 1024;
/// Streaming retention cap: the in-memory tail (TS `maxOutputBytes`).
const STREAM_MAX_BYTES: usize = DEFAULT_MAX_BYTES * 2;
/// Tail truncation line budget (TS `DEFAULT_MAX_LINES`).
const DEFAULT_MAX_LINES: usize = 2000;
/// The TS spill prefix (temp file names in `$TMPDIR`).
const SPILL_PREFIX: &str = "pa-bash";

/// The user-bash slot: one command runs at a time (TS `_userBashRunning`
/// plus the per-invocation abort controllers), with a kill switch the
/// `abort_bash` command pulls.
pub(crate) struct UserBash {
    /// The user-bash claim (execute_bash only; TS `runUserBash` guard).
    running: AtomicBool,
    /// An abort was requested: the settled result reports cancelled.
    abort_requested: AtomicBool,
    /// The in-flight process (user bash or an awaited run): `abort_bash`
    /// kills it.
    child: Mutex<Option<tokio::process::Child>>,
}

impl UserBash {
    pub(crate) fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            abort_requested: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }

    /// Claim the slot; `false` when a user command is already running.
    /// A fresh claim clears any stale abort request (TS clears
    /// `_userBashAbortRequested` at each start, so a leftover flag cannot
    /// cancel an unrelated later run).
    fn claim(&self) -> bool {
        let claimed = self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if claimed {
            self.abort_requested.store(false, Ordering::SeqCst);
        }
        claimed
    }

    fn release(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Kill the in-flight process (TS `abortBash` aborts every
    /// controller); the settled runs report cancelled.
    pub(crate) async fn abort(&self) {
        self.abort_requested.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        if let Some(child) = child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

impl Worker {
    /// `execute_bash { command, excludeFromContext?, transient?, runId? }`
    /// (TS `runUserBash`): the already-running guard rejects a second
    /// command, the response goes out before the run completes, output
    /// streams as `bash_output` events, and the settled `bash_end` (plus
    /// the durable `bashExecution` row, unless transient) follows.
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
        // Claim the slot synchronously (TS claims before the extension
        // dispatch could slip a second command through).
        if !self.user_bash.claim() {
            return response_failure(
                None,
                "execute_bash",
                "A bash command is already running",
                None,
            );
        }
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
                user_bash: &user_bash,
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

    /// `execute_bash_and_wait { command }` (TS `executeBash` over the
    /// awaited path): run to completion, record the row, and answer the
    /// `BashResult` wire shape.
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
        // A fresh run owns a fresh abort state (each TS invocation owns its
        // own controller).
        self.user_bash
            .abort_requested
            .store(false, Ordering::SeqCst);
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
        let user_bash = Arc::clone(&self.user_bash);
        let command = command.to_string();
        let end = run_bash(RunBash {
            command: &command,
            cwd: &cwd,
            prefix: prefix.as_deref(),
            shell_path: shell_path.as_deref(),
            user_bash: &user_bash,
            // The awaited path emits nothing (TS passes no `onChunk`).
            on_chunk: None,
        })
        .await;
        if let Some(error) = &end.error_message {
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
        response_success(
            None,
            "execute_bash_and_wait",
            Some(serde_json::to_value(&result).unwrap_or(Value::Null)),
        )
    }

    /// `abort_bash` (TS `abortBash`): kill the in-flight command; the
    /// settled run reports cancelled. Always a success.
    pub(crate) async fn handle_abort_bash(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("abort_bash") {
            return response;
        }
        self.user_bash.abort().await;
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
    user_bash: &'a UserBash,
    /// The streaming emit target for each sanitized chunk (the
    /// executor's `onChunk`; `None` on the awaited path, which emits
    /// nothing).
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
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return spawn_failure(error.to_string()),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut slot = run.user_bash.child.lock().await;
        // A late abort that arrived before the process spawned kills it
        // immediately (TS honors `_userBashAbortRequested` before
        // executing); the flag still settles the run cancelled.
        if run.user_bash.abort_requested.load(Ordering::SeqCst) {
            let _ = child.start_kill();
        }
        *slot = Some(child);
    }
    let stream = std::sync::Arc::new(std::sync::Mutex::new(OutputStream {
        chunks: Vec::new(),
        retained_bytes: 0,
        total_bytes: 0,
        spill: OutputSpill::new(),
        on_chunk: run.on_chunk,
    }));
    // stdout and stderr merge into one stream (TS wires both pipes to the
    // same `onData`); order between them is arrival order. The shared
    // accumulator keeps the merged order the interleaved reads produce.
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
    match (stdout_pump, stderr_pump) {
        (Some(stdout_pump), Some(stderr_pump)) => {
            futures::future::join(stdout_pump, stderr_pump).await;
        }
        (Some(pump), None) | (None, Some(pump)) => pump.await,
        (None, None) => {}
    }
    // Take the child back for the exit status (abort_bash may have killed
    // it meanwhile; a signal death reports no exit code).
    let mut child = {
        let mut slot = run.user_bash.child.lock().await;
        slot.take()
    };
    let exit_code = match child.as_mut() {
        Some(child) => child
            .wait()
            .await
            .ok()
            .and_then(|status| status.code())
            .map(i64::from),
        None => None,
    };
    let cancelled = run.user_bash.abort_requested.load(Ordering::SeqCst);
    // The reader tasks joined, so this is the last reference; a poisoned
    // lock (a reader panicked) keeps whatever it collected.
    let mut stream = match Arc::try_unwrap(stream) {
        Ok(mutex) => mutex
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        Err(stream) => stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone_stream(),
    };
    let full_output = stream.chunks.join("");
    let (output, truncated) = truncate_tail(&full_output);
    // A line-truncated run spills at settle even under the byte budget
    // (TS bash-executor: `if (truncationResult.truncated)
    // spill.open(outputChunks)`), so the truncation notice can always
    // name a full-output file.
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
/// `recordBashResult`; the row renders as a user turn and joins the model
/// context unless excluded).
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
        // rendering drop (TS `sanitizeBinaryOutput`).
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
            // CSI: parameters and intermediates run to the final byte
            // (0x40-0x7e).
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

/// The output spill (TS `OutputSpill`): opened once when the output
/// outgrows the streaming window, written progressively, finalized to the
/// complete file's path. A degraded spill never advertises a path.
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
/// win; an oversized last line keeps its tail, blank trailing lines
/// permitting.
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
            // the line's own tail (TS keeps the last `maxBytes` bytes).
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

/// The tail `maxBytes` of one string, on char boundaries (TS
/// `truncateStringToBytesFromEnd`).
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
        rest: Default::default(),
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

    /// `execute_bash_and_wait` answers the TS `BashResult` wire shape and
    /// records the durable `bashExecution` row.
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

    /// `execute_bash` responds before completion (no data), claims the
    /// slot (a second command answers the TS already-running refusal),
    /// `abort_bash` kills the run, and the excluded row carries the
    /// `excludeFromContext` flag.
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

        // The slot is claimed while the command runs.
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

        // Abort settles the run; the durable row records the cancelled
        // outcome with the context-exclusion flag.
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

    /// Transient runs stay unrecorded (they live only in their pane).
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

    /// A missing cwd answers the TS local-operations refusal.
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

    /// The sanitizer matches the TS chain: ANSI escapes, control
    /// characters, and carriage returns drop; tab and newline stay.
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

    /// Tail truncation keeps the last lines within the byte budget, and
    /// the oversized-line rescue keeps the line's own tail.
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
}
