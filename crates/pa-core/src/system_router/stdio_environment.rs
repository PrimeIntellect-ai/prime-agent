//! The stdio environment adapter: a JSON-lines subprocess protocol. Rust port
//! of `packages/coding-agent/src/core/system-router/stdio-environment.ts`
//! (#2484).
//!
//! Protocol (the documented environment boundary):
//! request  `{"id": <n>, "type": "init"|"reset"|"observe"|"execute"|"close", ...payload}`
//! response `{"id": <n>, "ok": true, ...result}` | `{"id": <n>, "ok": false, "error": "<message>"}`
//! One JSON object per line on stdin, one per line on stdout. Adapters may be
//! any program that speaks it.
//!
//! Port notes (divergences from the TS reference, each bounded):
//! the early-exit error carries the stderr tail but not the process exit code
//! (the tokio child handle stays owned by the environment and is reaped in
//! `close`); cleanup sends SIGTERM to the direct child (not the whole group)
//! while the leader is alive, then falls back to the platform tree kill
//! ([`crate::platform::kill_process_group_or_pid`]). Every leader-exit stage
//! relays the stop to the group like the reference
//! ([`crate::platform::signal_process_group`]) and then enforces it
//! ([`crate::platform::kill_process_group`], after a bounded drain grace on
//! the leader-exit arm) so a launcher that exits first cannot strand its
//! descendants - not even ones that ignore SIGTERM, and not on Windows,
//! where the group relay is a no-op and the enforced stop is the taskkill
//! tree kill. The reader completes the buffered tail as a final line at end
//! of stream, where the TS data handler can drop a reply the adapter wrote
//! without its trailing newline (cursor: EOF drops last adapter reply).

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::time::Instant;

use crate::platform::process::{kill_pid, Signal};

use super::types::{
    RouterCloseOptions, RouterEnvironment, RouterExecution, RouterObservation,
    RouterSegmentEnvironment,
};

/// A reply line longer than this is a protocol violation, not a message to
/// buffer (TS `MAX_REPLY_LINE_CHARS`).
const MAX_REPLY_LINE_CHARS: usize = 1_000_000;
/// Bounded tail of the adapter's stderr kept for diagnostics.
const MAX_STDERR_TAIL_CHARS: usize = 2_000;

/// One in-flight request's reply slot.
type PendingSender = oneshot::Sender<anyhow::Result<Map<String, Value>>>;

/// Shared state between the environment handle and its reader tasks.
struct Shared {
    pending: Mutex<HashMap<u64, PendingSender>>,
    stderr_tail: Mutex<String>,
    /// The terminal failure that ended the adapter; later requests fail fast.
    failure: Mutex<Option<String>>,
    closed: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            stderr_tail: Mutex::new(String::new()),
            failure: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }

    fn tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|tail| tail.clone())
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn append_tail(&self, chunk: &str) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            let mut combined = format!("{tail}{chunk}");
            let length = combined.chars().count();
            if length > MAX_STDERR_TAIL_CHARS {
                combined = combined
                    .chars()
                    .skip(length - MAX_STDERR_TAIL_CHARS)
                    .collect();
            }
            *tail = combined;
        }
    }

    /// Fail every pending request with `message` and remember it.
    fn fail_all(&self, message: &str) {
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(message.to_string());
            }
        }
        let requests = match self.pending.lock() {
            Ok(mut pending) => pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for sender in requests {
            let _ = sender.send(Err(anyhow!("{message}")));
        }
    }
}

struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
    next_id: u64,
    closed: bool,
}

/// A JSON-lines stdio environment adapter.
pub struct StdioRouterEnvironment {
    command: Vec<String>,
    cwd: Option<String>,
    request_timeout_ms: u64,
    init: Option<Value>,
    shared: Arc<Shared>,
    inner: AsyncMutex<Inner>,
}

impl StdioRouterEnvironment {
    /// Build an adapter handle; the process spawns on the first request.
    #[must_use]
    pub fn new(
        command: Vec<String>,
        cwd: Option<String>,
        request_timeout_ms: u64,
        init: Option<Value>,
    ) -> Self {
        Self {
            command,
            cwd,
            request_timeout_ms,
            init,
            shared: Arc::new(Shared::new()),
            inner: AsyncMutex::new(Inner {
                child: None,
                stdin: None,
                pid: None,
                next_id: 0,
                closed: false,
            }),
        }
    }

    fn ensure_child(&self, inner: &mut Inner) -> anyhow::Result<()> {
        if inner.child.is_some() {
            return Ok(());
        }
        let (program, args) = self
            .command
            .split_first()
            .ok_or_else(|| anyhow!("environment adapter command is empty"))?;
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        // Own process group on POSIX: a forced cleanup reaches a launcher's
        // descendants (`sh -c ...`, a container wrapper), not only the child.
        crate::platform::set_new_process_group(command.as_std_mut());
        let mut child = command
            .spawn()
            .map_err(|error| anyhow!("environment adapter failed to start: {error}"))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("environment adapter stdin is not a pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("environment adapter stdout is not a pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("environment adapter stderr is not a pipe"))?;
        tokio::spawn(read_loop(stdout, Arc::clone(&self.shared)));
        tokio::spawn(drain_stderr(stderr, Arc::clone(&self.shared)));
        inner.child = Some(child);
        inner.stdin = Some(stdin);
        inner.pid = pid;
        Ok(())
    }

    async fn request(
        &self,
        request_type: &str,
        extra: Map<String, Value>,
    ) -> anyhow::Result<Map<String, Value>> {
        if let Some(failure) = self
            .shared
            .failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
        {
            return Err(anyhow!("{failure}"));
        }
        let (id, receiver) = {
            let mut inner = self.inner.lock().await;
            self.ensure_child(&mut inner)?;
            let id = inner.next_id;
            inner.next_id += 1;
            let (sender, receiver) = oneshot::channel();
            if let Ok(mut pending) = self.shared.pending.lock() {
                pending.insert(id, sender);
            }
            let mut request = Map::new();
            request.insert("id".to_string(), Value::from(id));
            request.insert("type".to_string(), Value::String(request_type.to_string()));
            for (key, value) in extra {
                request.insert(key, value);
            }
            let mut line = serde_json::to_vec(&Value::Object(request)).map_err(|error| {
                anyhow!("failed to encode the environment adapter request: {error}")
            })?;
            line.push(b'\n');
            let write_result = match &mut inner.stdin {
                Some(stdin) => stdin
                    .write_all(&line)
                    .await
                    .map_err(|error| anyhow!("failed writing to the environment adapter: {error}")),
                None => Err(anyhow!("environment adapter stdin is not a pipe")),
            };
            if let Err(error) = write_result {
                if let Ok(mut pending) = self.shared.pending.lock() {
                    pending.remove(&id);
                }
                return Err(error);
            }
            (id, receiver)
        };
        match tokio::time::timeout(Duration::from_millis(self.request_timeout_ms), receiver).await {
            Ok(Ok(Ok(reply))) => Ok(reply),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(anyhow!("environment adapter closed")),
            Err(_) => {
                if let Ok(mut pending) = self.shared.pending.lock() {
                    pending.remove(&id);
                }
                Err(anyhow!(
                    "environment adapter {request_type} timed out after {}ms",
                    self.request_timeout_ms
                ))
            }
        }
    }
}

impl RouterEnvironment for StdioRouterEnvironment {
    fn reset<'a>(
        &'a self,
        goal: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.request("reset", object_of(&json!({ "goal": goal })))
                .await
                .map(|_| ())
        })
    }

    fn observe<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<RouterObservation>> + Send + 'a>> {
        Box::pin(async move {
            let reply = self.request("observe", Map::new()).await?;
            let observation = reply
                .get("observation")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    anyhow!(
                        "environment adapter observe must reply with {{ok: true, observation: {{text: string}}}}"
                    )
                })?;
            let text = observation
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow!(
                        "environment adapter observe must reply with {{ok: true, observation: {{text: string}}}}"
                    )
                })?;
            Ok(RouterObservation {
                text: text.to_string(),
                fields: observation
                    .get("fields")
                    .and_then(Value::as_object)
                    .map(|fields| {
                        fields
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
                image: observation
                    .get("image")
                    .and_then(Value::as_str)
                    .filter(|image| !image.is_empty())
                    .map(str::to_string),
                terminal: observation.get("terminal") == Some(&Value::Bool(true)),
            })
        })
    }

    fn execute<'a>(
        &'a self,
        action: &'a str,
        params: &'a BTreeMap<String, String>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<RouterExecution>> + Send + 'a>> {
        Box::pin(async move {
            let reply = self
                .request(
                    "execute",
                    object_of(&json!({ "action": action, "params": params })),
                )
                .await?;
            let text = reply.get("text").and_then(Value::as_str).ok_or_else(|| {
                anyhow!("environment adapter execute must reply with {{ok: true, text: string}}")
            })?;
            Ok(RouterExecution {
                text: text.to_string(),
                terminal: reply.get("terminal") == Some(&Value::Bool(true)),
            })
        })
    }

    fn close<'a>(
        &'a self,
        options: RouterCloseOptions,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let mut inner = self.inner.lock().await;
            if inner.closed {
                return;
            }
            inner.closed = true;
            self.shared.closed.store(true, Ordering::Relaxed);
            if inner.child.is_none() {
                return;
            }
            let started = Instant::now();
            let budget = options.budget_ms;
            // Ask the adapter to exit, then close its stdin.
            let close_id = inner.next_id;
            if let Some(stdin) = &mut inner.stdin {
                let line = format!("{}\n", json!({ "id": close_id, "type": "close" }));
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
            inner.stdin = None;
            // Half the budget is reserved for the SIGTERM wait: an adapter
            // that ignores the close request but forwards SIGTERM (a
            // container wrapper) still gets its stop relayed before SIGKILL.
            let sigterm_reserve = budget.map_or(0, |budget| (budget / 2).min(1_000));
            let graceful_ms = remaining_ms(started, budget, sigterm_reserve).min(1_500);
            let pid = inner.pid;
            if let Some(child) = &mut inner.child {
                match tokio::time::timeout(Duration::from_millis(graceful_ms), child.wait()).await {
                    Err(_) => {
                        if let Some(pid) = pid {
                            // SIGTERM first: a container-wrapped adapter
                            // forwards it (a SIGKILL would hit only the
                            // wrapper client).
                            let _ = kill_pid(pid as i32, Signal::Term);
                        }
                        let term_ms = remaining_ms(started, budget, 0).min(1_000);
                        match tokio::time::timeout(Duration::from_millis(term_ms), child.wait())
                            .await
                        {
                            Err(_) => {
                                // It ignored the SIGTERM too: the enforced
                                // platform tree kill.
                                if let Some(pid) = pid {
                                    let _ = crate::platform::kill_process_group_or_pid(pid as i32);
                                }
                            }
                            Ok(_) => {
                                // It exited from the relayed SIGTERM:
                                // descendants that ignored the stop still
                                // get the enforced group kill (the
                                // reference's post-SIGTERM arm) - the group
                                // SIGKILL on POSIX, the tree kill on
                                // Windows, where the group relay is a no-op.
                                if let Some(pid) = pid {
                                    let _ = crate::platform::kill_process_group(pid as i32);
                                }
                            }
                        }
                    }
                    Ok(_) => {
                        // The launcher answered the close request and exited
                        // first (`sh -c`, a container client), or crashed
                        // before: its group can still hold descendants, so
                        // the stop is relayed to the group (the reference's
                        // leader-exit arm). The relay is a request, not
                        // enforcement: descendants that ignore SIGTERM
                        // outlive it, and on Windows the relay is a no-op -
                        // so after a bounded drain grace the enforced kill
                        // below must land too, or the descendants outlive
                        // the segment (`closed` keeps `Drop` from reaching
                        // them).
                        if let Some(pid) = pid {
                            let relayed =
                                crate::platform::signal_process_group(pid as i32, Signal::Term);
                            // The same shape as the SIGTERM wait above: a
                            // descendant that honors the relay empties the
                            // group and the poll exits early; one that
                            // ignores it meets the enforced kill at the
                            // deadline.
                            let grace_ms = remaining_ms(started, budget, 0).min(1_000);
                            let deadline = Instant::now() + Duration::from_millis(grace_ms);
                            while relayed
                                && crate::platform::process_group_exists(pid as i32)
                                && Instant::now() < deadline
                            {
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                            if !relayed || crate::platform::process_group_exists(pid as i32) {
                                // The enforced stop once the leader is
                                // reaped: the group SIGKILL on POSIX (never
                                // the recycled bare pid), the taskkill
                                // tree kill on Windows (its relay was the
                                // no-op above). It must run before
                                // `inner.child = None` below: the Child
                                // handle still anchors the reaped leader's
                                // pid for the Windows walk (`kill_process_group`
                                // documents the contract).
                                let _ = crate::platform::kill_process_group(pid as i32);
                            }
                        }
                    }
                }
            }
            self.shared.fail_all("environment adapter closed");
            inner.child = None;
        })
    }
}

impl RouterSegmentEnvironment for StdioRouterEnvironment {
    fn init<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move {
            // Only an omitted init payload is absent; a provided falsy one
            // (false, 0, "", null) is the caller's value and reaches the adapter.
            let extra = match &self.init {
                Some(init) => object_of(&json!({ "init": init })),
                None => Map::new(),
            };
            let reply = self.request("init", extra).await?;
            Ok(reply.get("environment").cloned())
        })
    }
}

impl Drop for StdioRouterEnvironment {
    fn drop(&mut self) {
        // A handle dropped without `close` must not leak a live adapter
        // (kill_on_drop reaps the direct child; this reaches its group).
        if let Ok(inner) = self.inner.try_lock() {
            if !inner.closed {
                if let Some(pid) = inner.pid {
                    let _ = crate::platform::kill_process_group_or_pid(pid as i32);
                }
            }
        }
    }
}

/// Remaining budget in milliseconds after `started`, minus `reserve`.
fn remaining_ms(started: Instant, budget: Option<u64>, reserve: u64) -> u64 {
    match budget {
        None => u64::MAX,
        Some(budget) => {
            let elapsed = started.elapsed().as_millis() as u64;
            budget.saturating_sub(elapsed).saturating_sub(reserve)
        }
    }
}

/// The object view of a JSON object value (empty for a non-object).
fn object_of(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// Why the adapter's reply stream is unusable.
enum LineError {
    /// The unterminated buffered bytes exceeded the line cap.
    Overflow,
    /// A completed line was not valid UTF-8.
    Utf8,
}

/// Incremental NDJSON decoder with the adapter's line cap.
#[derive(Default)]
struct LineBuffer {
    buffer: Vec<u8>,
}

impl LineBuffer {
    fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>, LineError> {
        let mut scan_from = self.buffer.len();
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0usize;
        while let Some(relative) = self.buffer[scan_from..]
            .iter()
            .position(|&byte| byte == b'\n')
        {
            let end = scan_from + relative;
            let line = &self.buffer[consumed..end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            consumed = end + 1;
            scan_from = consumed;
            if line.is_empty() {
                continue;
            }
            if let Ok(line) = std::str::from_utf8(line) {
                lines.push(line.to_owned());
            } else {
                self.buffer.drain(..consumed);
                return Err(LineError::Utf8);
            }
        }
        self.buffer.drain(..consumed);
        if self.buffer.len() > MAX_REPLY_LINE_CHARS {
            return Err(LineError::Overflow);
        }
        Ok(lines)
    }
}

/// Read reply lines from the adapter's stdout, dispatching by request id.
async fn read_loop(mut stdout: ChildStdout, shared: Arc<Shared>) {
    let mut decoder = LineBuffer::default();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let (chunk, at_end) = match stdout.read(&mut buffer).await {
            // End of stream terminates the buffered tail like a newline would
            // (readline semantics): an adapter can write its final reply and
            // exit without the trailing newline, and a line the adapter fully
            // wrote must reach its pending request before the exit is handled
            // - the TS reference guarantees every reply line is dispatched
            // before its close handler runs.
            Ok(0) | Err(_) => (b"\n".as_slice(), true),
            Ok(read) => (&buffer[..read], false),
        };
        match decoder.feed(chunk) {
            Ok(lines) => {
                for line in lines {
                    if line.len() > MAX_REPLY_LINE_CHARS {
                        // A terminated oversized line is the same protocol
                        // violation as an unterminated one.
                        let overflow = format!(
                            "environment adapter wrote a reply line over {MAX_REPLY_LINE_CHARS} chars"
                        );
                        shared.append_tail(&format!("\n{overflow}"));
                        shared.fail_all(&overflow);
                        return;
                    }
                    dispatch_line(&line, &shared);
                }
            }
            Err(LineError::Overflow) => {
                let overflow = format!(
                    "environment adapter wrote an unterminated reply line over {MAX_REPLY_LINE_CHARS} chars"
                );
                shared.append_tail(&format!("\n{overflow}"));
                shared.fail_all(&overflow);
                return;
            }
            Err(LineError::Utf8) => {
                let invalid =
                    "environment adapter wrote a reply line that is not valid UTF-8".to_string();
                shared.append_tail(&format!("\n{invalid}"));
                shared.fail_all(&invalid);
                return;
            }
        }
        if at_end {
            break;
        }
    }
    if shared.closed.load(Ordering::Relaxed) {
        // The exit is the deliberate close (the flag is stored before the
        // close request is written): `close` records the failure itself, so
        // a supervised shutdown must not read as an adapter crash.
        return;
    }
    let tail = shared.tail();
    shared.fail_all(&format!("environment adapter exited early: {tail}"));
}

/// Dispatch one reply line to its pending request.
fn dispatch_line(line: &str, shared: &Shared) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(record) = value.as_object() else {
        return;
    };
    let Some(id) = record.get("id").and_then(Value::as_u64) else {
        return;
    };
    let sender = match shared.pending.lock() {
        Ok(mut pending) => pending.remove(&id),
        Err(_) => None,
    };
    let Some(sender) = sender else {
        return;
    };
    if record.get("ok") == Some(&Value::Bool(true)) {
        let _ = sender.send(Ok(record.clone()));
    } else {
        let detail = record.get("error").and_then(Value::as_str).map_or_else(
            || "adapter error".to_string(),
            |error| error.chars().take(2_000).collect(),
        );
        let _ = sender.send(Err(anyhow!("{detail}")));
    }
}

/// Keep a bounded tail of the adapter's stderr for diagnostics.
async fn drain_stderr(mut stderr: tokio::process::ChildStderr, shared: Arc<Shared>) {
    let mut buffer = vec![0u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]);
                shared.append_tail(&chunk);
            }
        }
    }
}

// The protocol battery lives in the child module (stdio_environment::tests).
#[cfg(test)]
mod tests;
