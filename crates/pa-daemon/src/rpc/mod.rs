//! RPC stdio mode: headless operation with JSON commands on stdin and
//! JSON responses and events on stdout (TS `modes/rpc/rpc-mode.ts`).
//!
//! One connection drives one live session. Commands arrive as JSON lines
//! and answer one ordered stream of response and event frames: the
//! response `data` channel distinguishes an absent key from JSON `null`,
//! a `prompt` response is written before the turn's stream events
//! (events landing while the response is pending are buffered and
//! flushed after it, TS `promptResponsePending`), prompts serialize on
//! a stdin-order chain (TS `promptCommandTail`) while other commands
//! run concurrently, and stdin close settles the running turn before
//! the process exits. SIGTERM exits 143 and SIGHUP 129 (TS signal exit
//! codes).
//!
//! The in-process transport serves the session engine directly, exactly
//! like the TS in-process connection: the scheduling and agent-messaging
//! surfaces answer their TS in-process "requires daemon mode" errors,
//! and `observe` sees no other active sessions (the in-process session
//! hosts no family) — the daemon-attached transport serves those for
//! real.

pub mod commands;
pub mod model_commands;
pub mod prompt_commands;
pub mod protocol;
pub mod session;
pub mod session_commands;

use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::AsyncBufReadExt;

use protocol::{ParsedLine, RpcCommand};
use session::{RpcEngineFactory, RpcEngineHandle, RpcSession};

/// Everything the composition root hands the mode.
pub struct RpcOptions {
    /// The assembled engine the connection adopts first.
    pub engine: RpcEngineHandle,
    /// The whole-session replacement seam (`new_session` /
    /// `switch_session` / `fork`), when wired.
    pub engine_factory: Option<RpcEngineFactory>,
    /// The session's cwd (the engine replacement reads it).
    pub cwd: std::path::PathBuf,
    /// The agent dir (model registry auth, refinement history).
    pub agent_dir: std::path::PathBuf,
    /// The CLI autonomous flags seeding the host-owned autonomous state
    /// (TS `createAgentSession` parity; `None` starts disabled).
    pub autonomous_config: Option<pa_core::autonomous::AgentAutonomousConfig>,
}

/// The ordered stdout writer: one queue for responses and events, in
/// publication order (TS `output` through `writeRawStdout`). The queue
/// depth is tracked so an exit path can drain every queued frame before
/// the process exits (TS `process.exit` follows synchronous writes).
#[derive(Clone)]
pub struct LineWriter {
    tx: tokio::sync::mpsc::UnboundedSender<Value>,
    /// Frames queued but not yet written by the writer task (incremented
    /// on `write`, decremented once the task wrote the frame).
    pending: Arc<AtomicUsize>,
}

impl LineWriter {
    /// Spawn the writer task over the process stdout.
    fn spawn() -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let pending = Arc::new(AtomicUsize::new(0));
        let task_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stdout = tokio::io::stdout();
            while let Some(frame) = rx.recv().await {
                if let Ok(mut line) = serde_json::to_string(&frame) {
                    line.push('\n');
                    let _ = stdout.write_all(line.as_bytes()).await;
                    let _ = stdout.flush().await;
                }
                task_pending.fetch_sub(1, Ordering::SeqCst);
            }
        });
        Self { tx, pending }
    }

    /// Queue one frame (serializeJsonLine: LF-only framing).
    pub fn write(&self, frame: Value) {
        self.pending.fetch_add(1, Ordering::SeqCst);
        let _ = self.tx.send(frame);
    }

    /// Wait until the writer task has written every queued frame (the
    /// exit paths call this before `process::exit`, TS parity for
    /// synchronous writes). Bounded: a broken pipe retires after the
    /// deadline instead of hanging the exit.
    pub async fn drain(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while self.pending.load(Ordering::SeqCst) > 0 {
            if std::time::Instant::now() >= deadline {
                return;
            }
            tokio::task::yield_now().await;
        }
    }
}

/// The signal exit codes (TS `runRpcModeWithConnectionInternal`).
const SIGTERM_EXIT: i32 = 143;
const SIGHUP_EXIT: i32 = 129;

/// The mode's exit path: the writer must flush its queued frames before
/// the process exits (TS `process.exit` follows the synchronous writes).
fn exit_with(code: i32) -> ! {
    // stdout is line-buffered on the writer task; a direct flush of the
    // blocking handle covers the frames the task already wrote.
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}

/// The async entry: serve the RPC stdio mode until stdin closes or a
/// signal exits. Returns the process exit code.
///
/// # Errors
///
/// Returns an error when the tokio runtime cannot be built; the transport
/// itself never errors out of the loop (protocol failures answer on
/// stdout, TS parity).
pub async fn run_rpc_mode(options: RpcOptions) -> anyhow::Result<i32> {
    let writer = LineWriter::spawn();
    let initial_goal = options.engine.engine.goal_state().await;
    let session =
        Arc::new(RpcSession::adopt(options.engine, options.engine_factory, writer.clone()).await);
    let state = Arc::new(commands::RpcState {
        session: Arc::clone(&session),
        writer: writer.clone(),
        cwd: options.cwd,
        agent_dir: options.agent_dir,
        compacting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        autonomous: Arc::new(tokio::sync::Mutex::new(
            pa_core::autonomous::create_autonomous_runtime_state(
                options.autonomous_config.as_ref(),
                None,
            ),
        )),
        last_goal: Arc::new(tokio::sync::Mutex::new(initial_goal)),
        queue_pump: Arc::new(tokio::sync::Mutex::new(())),
        pump_suspended: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        model_ops: Arc::new(tokio::sync::Mutex::new(())),
        session_ops: Arc::new(tokio::sync::Mutex::new(())),
    });
    spawn_signal_handlers(Arc::clone(&session), writer.clone());
    Ok(serve_stdin(state).await)
}

/// SIGTERM exits 143, SIGHUP 129 (unix; the TS mode handles exactly this
/// pair): abort the running turn, settle it, dispose the kernel, drain
/// the queued frames, exit.
fn spawn_signal_handlers(session: Arc<RpcSession>, writer: LineWriter) {
    use tokio::signal::unix::{signal, SignalKind};
    let terminate_session = Arc::clone(&session);
    let terminate_writer = writer.clone();
    tokio::spawn(async move {
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            stream.recv().await;
            let engine = terminate_session.handle().await.engine.clone();
            engine.session.agent().abort();
            // Retire the queued-input pumps the instant the abort fires
            // (the dispose bumps again — idempotent): a pump that wakes
            // as the aborted turn settles must not deliver the next
            // queued row while the exit drains.
            terminate_session.retire_pumps();
            terminate_session.dispose().await;
            terminate_writer.drain().await;
            exit_with(SIGTERM_EXIT);
        }
    });
    let hangup_session = Arc::clone(&session);
    let hangup_writer = writer;
    tokio::spawn(async move {
        if let Ok(mut stream) = signal(SignalKind::hangup()) {
            stream.recv().await;
            let engine = hangup_session.handle().await.engine.clone();
            engine.session.agent().abort();
            // Retire the queued-input pumps the instant the abort fires
            // (the dispose bumps again — idempotent): the exit settles
            // the aborted turn without running the next queued one.
            hangup_session.retire_pumps();
            hangup_session.dispose().await;
            hangup_writer.drain().await;
            exit_with(SIGHUP_EXIT);
        }
    });
}

/// The stdin loop: parse every line, dispatch commands concurrently
/// (prompts serialize on the stdin-order chain), and settle on EOF.
async fn serve_stdin(state: Arc<commands::RpcState>) -> i32 {
    // TS `promptCommandTail`: prompt commands chain on their stdin-order
    // predecessor — the chain hands each prompt the previous prompt's
    // completion, so execution and response order follow the read order
    // (the spawned tasks' scheduling order is not the guarantee, exactly
    // the TS tail's role).
    let mut prompt_tail: Option<tokio::sync::oneshot::Receiver<()>> = None;
    // The in-flight handlers EOF waits for (TS `pendingInputHandlers`).
    let mut pending = tokio::task::JoinSet::new();
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        match protocol::parse_line(&line) {
            ParsedLine::ParseError(response) => state.writer.write(response),
            // No in-process extension-UI seam exists: the bridge would
            // answer; unknown request ids are silently ignored (TS
            // `respondToExtensionUiRequest(...).catch(() => undefined)`).
            ParsedLine::ExtensionUiResponse => {}
            ParsedLine::Command(command) => {
                let state = Arc::clone(&state);
                let is_prompt = command.command == "prompt";
                let previous = if is_prompt { prompt_tail.take() } else { None };
                let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                if is_prompt {
                    prompt_tail = Some(done_rx);
                }
                pending.spawn(async move {
                    if let Some(previous) = previous {
                        let _ = previous.await;
                    }
                    dispatch_one(state, command).await;
                    let _ = done_tx.send(());
                });
            }
        }
    }
    // stdin closed: settle the in-flight handlers, wait the session
    // idle, dispose, drain the queued frames, exit 0 (TS `onInputEnd`).
    while pending.join_next().await.is_some() {}
    // Serialize with any in-flight queued-input pump before the settle
    // (dispose retires the pumps; the lane ensures none is mid-delivery).
    {
        let _pump = state.queue_pump.lock().await;
        state.session.dispose().await;
    }
    state.writer.drain().await;
    0
}

/// One command's dispatch: prompts run on the stdin-order chain (the
/// caller hands each prompt its predecessor's completion) and buffer
/// connection events until their response is written (TS
/// `handleInputLine`); every other command runs unlocked.
async fn dispatch_one(state: Arc<commands::RpcState>, command: RpcCommand) {
    if command.command != "prompt" {
        let response = commands::handle_command(&state, command).await;
        state.writer.write(response);
        return;
    }
    state.session.set_prompt_response_pending(true).await;
    let response = commands::handle_command(&state, command).await;
    // The response writes while the buffer stays armed (TS `output` of
    // the response precedes the buffered events); the flush then
    // disarms and emits them in arrival order.
    state.writer.write(response);
    state.session.flush_connection_events().await;
}
