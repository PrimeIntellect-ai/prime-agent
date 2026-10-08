//! RPC stdio mode: headless operation with JSON commands on stdin and JSON
//! responses and events on stdout; one connection drives one live session,
//! stdin close settles the running turn, SIGTERM/SIGHUP exit 143/129; the
//! in-process transport answers daemon-only surfaces with daemon-mode errors.

pub mod commands;
pub mod model_commands;
pub mod prompt_commands;
pub mod protocol;
pub mod session;
pub mod session_commands;

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
    /// The whole-session replacement seam (`new_session` / `switch_session` / `fork`), when wired.
    pub engine_factory: Option<RpcEngineFactory>,
    /// The session's cwd (the engine replacement reads it).
    pub cwd: std::path::PathBuf,
    /// The agent dir (model registry auth, refinement history).
    pub agent_dir: std::path::PathBuf,
    /// The CLI autonomous flags seeding the host-owned autonomous state (`None` starts disabled).
    pub autonomous_config: Option<pa_core::autonomous::AgentAutonomousConfig>,
}

/// The ordered stdout writer: one queue for responses and events, in
/// publication order. The queue depth is tracked so exit paths drain.
#[derive(Clone)]
pub struct LineWriter {
    tx: tokio::sync::mpsc::UnboundedSender<Value>,
    /// Frames queued but not yet written by the writer task (incremented
    /// on `write`, decremented once the task wrote the frame).
    pending: Arc<AtomicUsize>,
}

impl LineWriter {
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

    /// Wait until the writer task has written every queued frame (the EOF
    /// path calls this before the exit).
    pub async fn drain(&self) {
        while self.pending.load(Ordering::SeqCst) > 0 {
            tokio::task::yield_now().await;
        }
    }

    /// The signal-exit drain (SIGTERM/SIGHUP): the 143/129 exit codes
    /// must fire even against a stalled reader, so the wait is bounded.
    pub async fn drain_bounded(&self) {
        self.drain_within(std::time::Duration::from_secs(2)).await;
    }

    /// Wait until the writer task has written every queued frame, giving
    /// up once `budget` elapses (a stalled reader never wedges the command).
    pub async fn drain_within(&self, budget: std::time::Duration) {
        let deadline = std::time::Instant::now() + budget;
        while self.pending.load(Ordering::SeqCst) > 0 {
            if std::time::Instant::now() >= deadline {
                return;
            }
            tokio::task::yield_now().await;
        }
    }
}

/// The compaction paths' frame-flush budget: the handler waits for the `compaction_start` flush
/// before the pre-summarizer CPU span; binds only against a reader that stopped draining its pipe.
pub(crate) const COMPACT_FRAME_FLUSH_BUDGET: std::time::Duration =
    std::time::Duration::from_millis(50);

#[cfg(unix)]
const SIGTERM_EXIT: i32 = 143;
#[cfg(unix)]
const SIGHUP_EXIT: i32 = 129;

/// The mode's exit path. The signal paths' bounded drains already waited on the writer task, so the
/// exit never re-acquires the stdout lock (a stalled reader holds it inside the blocked write).
#[cfg(unix)]
fn exit_with(code: i32) -> ! {
    std::process::exit(code);
}

/// Windows delivers no SIGTERM/SIGHUP to a console-less process, so the
/// stdin-close settle stays the only exit path.
#[cfg(not(unix))]
fn spawn_signal_handlers(_session: &Arc<RpcSession>, _writer: LineWriter) {}

/// The async entry: serve the RPC stdio mode until stdin closes or a
/// signal exits. Returns the process exit code.
///
/// # Errors
/// Returns an error when the tokio runtime cannot be built; the transport itself never errors out
/// of the loop (protocol failures answer on stdout).
pub async fn run_rpc_mode(options: RpcOptions) -> anyhow::Result<i32> {
    let writer = LineWriter::spawn();
    let initial_goal = options.engine.engine.goal_state().await;
    let session =
        Arc::new(RpcSession::adopt(options.engine, options.engine_factory, writer.clone()).await);
    let state = Arc::new(commands::RpcState {
        session: Arc::clone(&session),
        writer: writer.clone(),
        cwd: options.cwd,
        agent_dir: options.agent_dir.clone(),
        compacting: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
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
    // With no create command, the FIRST `get_available_models` would pay
    // the whole awaited refresh chain; this spawn warms the caches early.
    tokio::spawn(async move {
        let auth = pa_core::auth::AuthStorage::create(&options.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, options.agent_dir.join("models.json"));
        let _ = registry.refresh_available_models().await;
    });
    spawn_signal_handlers(&session, writer.clone());
    Ok(serve_stdin(state).await)
}

/// SIGTERM exits 143, SIGHUP 129 (unix; the TS mode handles exactly this
/// pair): abort the running turn, settle it, dispose the kernel, drain the queued frames, exit.
#[cfg(unix)]
fn spawn_signal_handlers(session: &Arc<RpcSession>, writer: LineWriter) {
    use tokio::signal::unix::{signal, SignalKind};
    let terminate_session = Arc::clone(session);
    let terminate_writer = writer.clone();
    tokio::spawn(async move {
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            stream.recv().await;
            // Fire the shutdown broadcast FIRST: a replacement mid-settle
            // aborts and refuses, so the exit never queues behind it.
            terminate_session.fire_shutdown();
            // Serialize with any in-flight whole-session replacement:
            // the handle read below sees the session that is live NOW.
            let _replacement = terminate_session.replacement_lease().await;
            let engine = terminate_session.handle().await.engine.clone();
            // Retire the queued-input pumps BEFORE the abort (idempotent
            // with the dispose's bump): no queued row starts a turn the
            // exit would wait out.
            terminate_session.retire_pumps();
            engine.session.agent().abort();
            terminate_session.dispose().await;
            terminate_writer.drain_bounded().await;
            exit_with(SIGTERM_EXIT);
        }
    });
    let hangup_session = Arc::clone(session);
    let hangup_writer = writer;
    tokio::spawn(async move {
        if let Ok(mut stream) = signal(SignalKind::hangup()) {
            stream.recv().await;
            // Fire the shutdown broadcast FIRST (the settle racing this
            // exit aborts and refuses).
            hangup_session.fire_shutdown();
            // Serialize with any in-flight replacement (the lease holds
            // until the exit): the abort and the dispose target the
            // session that is live NOW.
            let _replacement = hangup_session.replacement_lease().await;
            let engine = hangup_session.handle().await.engine.clone();
            // Retire the queued-input pumps BEFORE the abort (idempotent
            // with the dispose's bump): no queued row starts a turn the
            // exit would wait out.
            hangup_session.retire_pumps();
            engine.session.agent().abort();
            hangup_session.dispose().await;
            hangup_writer.drain_bounded().await;
            exit_with(SIGHUP_EXIT);
        }
    });
}

/// The stdin loop: parse every line, dispatch commands concurrently
/// (prompts serialize on the stdin-order chain), and settle on EOF.
async fn serve_stdin(state: Arc<commands::RpcState>) -> i32 {
    // Prompt commands chain on their stdin-order predecessor: execution
    // and response order follow the read order.
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
    // idle, dispose, drain the queued frames, exit 0.
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

/// One command's dispatch: prompts run on the stdin-order chain and
/// buffer connection events until their response is written; every other command runs unlocked.
async fn dispatch_one(state: Arc<commands::RpcState>, command: RpcCommand) {
    if command.command != "prompt" {
        let response = commands::handle_command(&state, command).await;
        state.writer.write(response);
        return;
    }
    state.session.set_prompt_response_pending(true).await;
    let response = commands::handle_command(&state, command).await;
    // The response writes while the buffer stays armed; the flush then
    // disarms and emits them in arrival order.
    state.writer.write(response);
    state.session.flush_connection_events().await;
}
