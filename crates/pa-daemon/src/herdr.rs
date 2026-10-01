//! The built-in Herdr connector: session-scoped pane state reporting.
//!
//! Herdr (<https://herdr.dev>) is a terminal workspace manager: it owns
//! panes and exports the pane's identity in the environment
//! (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` — the socket of
//! its pane-state API) for the processes running inside them. This module
//! reports this session's lifecycle state (`working` / `blocked` /
//! `idle`) to that socket, so a Herdr pane shows its Prime Agent session
//! as live, done, or stuck — the in-tree counterpart of the TS
//! `herdr-agent-state.ts` extension (`herdr integration install pi` also
//! writes one; the built-in ships so the pane reports out of the box).
//!
//! Session-scoped by construction, not by boot context: the pane
//! identity never comes from this process's ambient environment. The
//! client that owns the pane sends the allowlisted `HERDR_*` vars on the
//! session `create` (TS `DAEMON_CLIENT_ENV_KEYS`), the supervisor rides
//! them on the worker's durable create command, and the worker resolves
//! them from the create payload here. Every session is its own worker
//! process, so its reporter owns its pane alone: a daemon (supervisor)
//! booted outside Herdr, or in one Herdr tab, cannot bleed its boot
//! context into sessions later created in other panes — the TS bug
//! class this port does not reproduce.
//!
//! The wire contract (one JSON line per request, closed after the first
//! response byte, an error, or 500 ms):
//!
//! ```json
//! {"id":"herdr:pi:<ms>:<rand>","method":"pane.report_agent","params":{"pane_id":"<HERDR_PANE_ID>","source":"herdr:pi","agent":"prime-agent","state":"working","seq":1780000000000000,"agent_session_path":"/home/me/.prime/agent/sessions/<id>.jsonl"}}
//! {"id":"herdr:pi:release:<ms>:<rand>","method":"pane.release_agent","params":{"pane_id":"…","source":"herdr:pi","agent":"prime-agent","seq":1780000000000001}}
//! ```
//!
//! `message` rides only blocked reports. `seq` is per-process monotonic
//! (seeded `now_ms * 1000`; a successor reporter after a session
//! replacement never restarts below a used value — Herdr drops
//! lower-seq reports per source, which would stick a pane at working).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The allowlist of client env vars the connector consumes (TS
/// `DAEMON_CLIENT_ENV_KEYS` — the shared wire contract, in `pa-types` so
/// clients and the daemon read one list).
pub use pa_types::daemon::herdr_env::filter_client_env;

/// The tuning env for the idle debounce (a turn that ends with queued
/// work reports idle only after this window, so a pane does not flicker
/// done -> working between queued turns).
const IDLE_DEBOUNCE_ENV: &str = "HERDR_PI_IDLE_DEBOUNCE_MS";
/// The tuning env for the retry grace (an error-ended turn holds
/// `working` this long before settling to `blocked`, so an immediate
/// retry never shows the pane as stuck).
const RETRY_GRACE_ENV: &str = "HERDR_PI_RETRY_GRACE_MS";
const DEFAULT_IDLE_DEBOUNCE_MS: u64 = 250;
const DEFAULT_RETRY_GRACE_MS: u64 = 2500;
/// The send timeout: one line, then close after the first response byte,
/// an error, or this window (the TS `finish` arm).
const SEND_TIMEOUT_MS: u64 = 500;

/// The reporter identity on every report (TS main `herdr:pi` source;
/// `herdr integration install pi` reports under the same pair).
pub(crate) const HERDR_SOURCE: &str = "herdr:pi";
pub(crate) const HERDR_AGENT: &str = "prime-agent";

/// The Herdr socket target (TS `herdrSocketTarget`): Herdr exports a
/// Unix-style socket path; on Windows that dials the local named-pipe
/// namespace, so map it into `\\.\pipe\` (an already-namespaced path
/// passes through unchanged).
pub fn herdr_socket_target(socket_path: &str, windows: bool) -> String {
    if !windows {
        return socket_path.to_string();
    }
    let lowered = socket_path.to_lowercase();
    if lowered.starts_with("\\\\.\\pipe\\") || lowered.starts_with("\\\\?\\pipe\\") {
        return socket_path.to_string();
    }
    format!("\\\\.\\pipe\\{socket_path}")
}

/// Parse a non-negative millisecond duration env (invalid or negative
/// values fall back to the default, exactly like the TS).
fn parse_duration_env(env: &BTreeMap<String, String>, key: &str, fallback_ms: u64) -> Duration {
    env.get(key)
        .and_then(|raw| raw.parse::<u64>().ok())
        .map_or(Duration::from_millis(fallback_ms), Duration::from_millis)
}

/// The resolved pane identity and tuning for one session's reporter.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HerdrConfig {
    socket_path: String,
    pane_id: String,
    idle_debounce: Duration,
    retry_grace: Duration,
}

impl HerdrConfig {
    /// Resolve the reporter config from a received env map. `None` when
    /// this session does not run inside a Herdr pane (`HERDR_ENV` unset,
    /// not `"1"`, or the socket/pane identity is missing — TS parity: the
    /// connector is a complete no-op then, so it is safe to always load).
    pub(crate) fn from_env(env: &BTreeMap<String, String>) -> Option<Self> {
        if env.get("HERDR_ENV").map(String::as_str) != Some("1") {
            return None;
        }
        let socket_path = env.get("HERDR_SOCKET_PATH")?.trim();
        let pane_id = env.get("HERDR_PANE_ID")?.trim();
        if socket_path.is_empty() || pane_id.is_empty() {
            return None;
        }
        Some(Self {
            socket_path: socket_path.to_string(),
            pane_id: pane_id.to_string(),
            idle_debounce: parse_duration_env(env, IDLE_DEBOUNCE_ENV, DEFAULT_IDLE_DEBOUNCE_MS),
            retry_grace: parse_duration_env(env, RETRY_GRACE_ENV, DEFAULT_RETRY_GRACE_MS),
        })
    }
}

/// The session reference a report carries (TS `agent_session_path` /
/// `agent_session_id`): the session file when the session has one,
/// otherwise the session id (`--no-session` and unfilled files).
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct HerdrSessionRef {
    path: Option<String>,
    id: Option<String>,
}

impl HerdrSessionRef {
    pub(crate) fn new(path: Option<String>, id: Option<String>) -> Self {
        Self { path, id }
    }
}

/// The pane states Herdr understands (TS `AgentState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaneState {
    Working,
    Blocked,
    Idle,
}

impl PaneState {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Idle => "idle",
        }
    }
}

/// The process-global report sequence (TS's module-level `reportSeq`):
/// seeded at `now_ms * 1000` and never restarting below a used value, so
/// a replacement reporter (a session swap in this same worker process)
/// cannot drop to a seq Herdr already saw.
static REPORT_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms_x1000() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
        .saturating_mul(1000)
}

fn next_report_seq() -> u64 {
    let floor = now_ms_x1000();
    let mut current = REPORT_SEQ.load(Ordering::Relaxed);
    if current == 0 {
        // First use this process: seed at the floor, then continue.
        match REPORT_SEQ.compare_exchange(0, floor, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => floor,
            Err(seeded) => seeded + 1,
        }
    } else {
        loop {
            let next = (current + 1).max(floor);
            match REPORT_SEQ.compare_exchange(current, next, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => return next,
                Err(seen) => current = seen,
            }
        }
    }
}

/// One pending report: the latest state wins (the TS single-slot queue —
/// an in-flight send never blocks a newer state from replacing it).
struct PendingReport {
    state: PaneState,
    message: Option<String>,
}

/// The reporter's state machine (the TS extension's module state).
struct ReporterState {
    agent_active: bool,
    retry_hold_active: bool,
    failure_blocked: bool,
    failure_message: Option<String>,
    last_state: Option<PaneState>,
    last_message: Option<String>,
    pending: Option<PendingReport>,
    session_ref: HerdrSessionRef,
    /// The idle debounce deadline (a queued-work turn end).
    idle_deadline: Option<tokio::time::Instant>,
    /// The retry-grace deadline (an error-ended turn holding working).
    retry_deadline: Option<tokio::time::Instant>,
    /// Silenced: no further reports (a dead session that must not
    /// reclaim its pane — the replacement-failure arm).
    silenced: bool,
    /// Released: the pane was released; nothing may report after.
    released: bool,
}

/// The boundary events the worker feeds the reporter (the TS extension
/// event hooks, mapped to the worker's own boundaries).
enum Signal {
    /// `session_start` (create, replacement swap, re-create): refresh the
    /// session reference and force-publish the current state.
    SessionStarted {
        active: bool,
        session_ref: HerdrSessionRef,
    },
    /// `agent_start`: a run began — working.
    RunStarted,
    /// `agent_end`: a run ended. `error` holds the terminal assistant
    /// row's provider error (the hold arm); `more_queued` is the
    /// has-pending-messages debounce arm.
    RunEnded {
        error: Option<String>,
        more_queued: bool,
    },
    /// The engine's `auto_retry_start`: a provider failure is being
    /// retried — keep the pane working and clear any pending hold.
    RetryStarted,
    /// A quit close: drain the in-flight send, then release the pane as
    /// the last write; nothing reports after. Acked on the channel.
    Release {
        done: tokio::sync::oneshot::Sender<()>,
    },
}

/// A session's Herdr reporter. Cheap to clone; `None`-backed when the
/// session has no Herdr pane (every method is a no-op then). Cloned
/// handles share the same task, so a clone's report rides the same seq
/// chain.
#[derive(Clone, Default)]
pub(crate) struct HerdrReporter {
    tx: Option<std::sync::Arc<tokio::sync::mpsc::UnboundedSender<Signal>>>,
}

impl HerdrReporter {
    /// Start the reporter for a session resolved to a Herdr pane.
    pub(crate) fn start(config: HerdrConfig, session_ref: HerdrSessionRef) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(run_reporter(config, session_ref, rx));
        Self {
            tx: Some(std::sync::Arc::new(tx)),
        }
    }

    /// True when this reporter is live (a Herdr pane is bound).
    pub(crate) fn enabled(&self) -> bool {
        self.tx.is_some()
    }

    /// `session_start`: refresh the session reference and force-publish.
    pub(crate) fn session_started(&self, active: bool, session_ref: HerdrSessionRef) {
        self.send(Signal::SessionStarted {
            active,
            session_ref,
        });
    }

    /// `agent_start`: a run began — working.
    pub(crate) fn run_started(&self) {
        self.send(Signal::RunStarted);
    }

    /// `agent_end`: a run ended (the error hold and the queued-work
    /// debounce are resolved inside the task).
    pub(crate) fn run_ended(&self, error: Option<String>, more_queued: bool) {
        self.send(Signal::RunEnded { error, more_queued });
    }

    /// `auto_retry_start`: clear any pending failure hold and keep
    /// working.
    pub(crate) fn retry_started(&self) {
        self.send(Signal::RetryStarted);
    }

    /// The quit release: stop new reports, drop the queued one, wait for
    /// the in-flight send, then release the pane as the last write.
    /// Inert (an immediate return) when the reporter is disabled.
    pub(crate) async fn release(&self) {
        let Some(tx) = &self.tx else { return };
        let (done, ack) = tokio::sync::oneshot::channel();
        if tx.send(Signal::Release { done }).is_ok() {
            let _ = tokio::time::timeout(Duration::from_millis(2000), ack).await;
        }
    }

    fn send(&self, signal: Signal) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(signal);
        }
    }
}

/// The reporter task: owns the state machine and the single-slot send
/// queue; one write in flight at a time, the latest state wins.
async fn run_reporter(
    config: HerdrConfig,
    session_ref: HerdrSessionRef,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Signal>,
) {
    let mut state = ReporterState {
        agent_active: false,
        retry_hold_active: false,
        failure_blocked: false,
        failure_message: None,
        last_state: None,
        last_message: None,
        pending: None,
        session_ref,
        idle_deadline: None,
        retry_deadline: None,
        silenced: false,
        released: false,
    };
    loop {
        // The next timer deadline, if any: the two debounce/grace timers.
        let deadline = [state.idle_deadline, state.retry_deadline]
            .into_iter()
            .flatten()
            .min();
        tokio::select! {
            signal = rx.recv() => {
                match signal {
                    Some(Signal::Release { done }) => {
                        state.released = true;
                        state.pending = None;
                        state.idle_deadline = None;
                        state.retry_deadline = None;
                        // This task serializes every write and the
                        // drain below completed before the release was
                        // admitted, so the release is the last write on
                        // the wire — exactly the TS ordering contract.
                        let target = herdr_socket_target(&config.socket_path, cfg!(windows));
                        send_request(
                            &target,
                            release_request(&config.pane_id, next_report_seq()),
                        )
                        .await;
                        let _ = done.send(());
                        return;
                    }
                    Some(signal) => {
                        handle_signal(&mut state, signal, &config);
                    }
                    None => {
                        // The worker dropped its handle without a quit
                        // release (a failed replacement's teardown): stay
                        // silent — never reclaim a pane a successor or a
                        // released reporter owns.
                        return;
                    }
                }
            }
            () = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let now = tokio::time::Instant::now();
                if let Some(at) = state.retry_deadline {
                    if at <= now {
                        state.retry_deadline = None;
                        state.retry_hold_active = false;
                        state.failure_blocked = true;
                        publish(&mut state);
                    }
                }
                if let Some(at) = state.idle_deadline {
                    if at <= now {
                        state.idle_deadline = None;
                        publish(&mut state);
                    }
                }
            }
        }
        // Drain the single-slot queue: one write at a time; a state that
        // changed while the write was in flight replaces the slot.
        while !state.released && !state.silenced {
            let Some(report) = state.pending.take() else {
                break;
            };
            let target = herdr_socket_target(&config.socket_path, cfg!(windows));
            let request = report_request(
                &config.pane_id,
                report.state,
                report.message.as_deref(),
                &state.session_ref,
                next_report_seq(),
            );
            send_request(&target, request).await;
        }
    }
}

/// Apply one boundary signal to the state machine (the TS extension's
/// event handlers).
fn handle_signal(state: &mut ReporterState, signal: Signal, config: &HerdrConfig) {
    match signal {
        Signal::SessionStarted {
            active,
            session_ref,
        } => {
            state.session_ref = session_ref;
            state.agent_active = active;
            publish_force(state);
        }
        // A run start and a retry both (re)claim the pane working and
        // clear every hold: identical handlers (the TS `agent_start` and
        // the auto-retry's hold-cancel).
        Signal::RunStarted | Signal::RetryStarted => {
            state.idle_deadline = None;
            state.retry_deadline = None;
            state.retry_hold_active = false;
            state.failure_blocked = false;
            state.failure_message = None;
            state.agent_active = true;
            publish(state);
        }
        Signal::RunEnded { error, more_queued } => {
            if !state.agent_active {
                // A duplicate/late end while a retry already holds the
                // pane working must not cancel the hold with a false idle.
                return;
            }
            state.agent_active = false;
            if let Some(message) = error {
                // An error end: hold working through the grace window —
                // an immediate retry keeps the pane working; none settles
                // to blocked with the error message.
                state.idle_deadline = None;
                state.retry_hold_active = true;
                state.failure_blocked = false;
                state.failure_message = Some(message);
                publish(state);
                state.retry_deadline = Some(tokio::time::Instant::now() + config.retry_grace);
                return;
            }
            state.retry_deadline = None;
            if more_queued {
                // Queued follow-up/steer messages start another run right
                // away: debounce the idle so the pane does not flicker
                // done -> working.
                state.retry_hold_active = false;
                state.failure_blocked = false;
                state.failure_message = None;
                if state.idle_deadline.is_none() {
                    state.idle_deadline = Some(tokio::time::Instant::now() + config.idle_debounce);
                }
                return;
            }
            state.idle_deadline = None;
            state.retry_hold_active = false;
            state.failure_blocked = false;
            state.failure_message = None;
            publish(state);
        }
        Signal::Release { .. } => unreachable!("the release arm handles it"),
    }
}

/// The desired pane state (the TS `desiredState` priority: a failure
/// block > a run in flight > idle).
fn desired_state(state: &ReporterState) -> (PaneState, Option<String>) {
    if state.failure_blocked {
        return (
            PaneState::Blocked,
            state
                .failure_message
                .clone()
                .or_else(|| Some("provider error".to_string())),
        );
    }
    if state.agent_active || state.retry_hold_active {
        return (PaneState::Working, None);
    }
    (PaneState::Idle, None)
}

/// Queue the desired state when it differs from the last published one.
fn publish(state: &mut ReporterState) {
    let (next_state, next_message) = desired_state(state);
    if next_state == state.last_state.unwrap_or(PaneState::Idle)
        && next_message == state.last_message
    {
        return;
    }
    queue_state(state, next_state, next_message);
}

/// Queue and publish regardless of the last state (the TS
/// `publishState(true)`: session starts always report).
fn publish_force(state: &mut ReporterState) {
    let (next_state, next_message) = desired_state(state);
    queue_state(state, next_state, next_message);
}

fn queue_state(state: &mut ReporterState, next_state: PaneState, next_message: Option<String>) {
    state.last_state = Some(next_state);
    state.last_message.clone_from(&next_message);
    state.pending = Some(PendingReport {
        state: next_state,
        message: next_message,
    });
}

/// The wire request for one pane state report (the TS `sendState` shape:
/// `message` rides only blocked reports; the session reference is
/// `agent_session_path` when the session has a file, `agent_session_id`
/// otherwise).
fn report_request(
    pane_id: &str,
    report_state: PaneState,
    message: Option<&str>,
    session_ref: &HerdrSessionRef,
    seq: u64,
) -> Value {
    let mut params = Map::new();
    params.insert("pane_id".to_string(), json!(pane_id));
    params.insert("source".to_string(), json!(HERDR_SOURCE));
    params.insert("agent".to_string(), json!(HERDR_AGENT));
    params.insert("state".to_string(), json!(report_state.wire_name()));
    if let Some(message) = message {
        params.insert("message".to_string(), json!(message));
    }
    params.insert("seq".to_string(), json!(seq));
    let mut resume_target = None;
    if let Some(path) = &session_ref.path {
        params.insert("agent_session_path".to_string(), json!(path));
        resume_target = Some(path.clone());
    } else if let Some(id) = &session_ref.id {
        params.insert("agent_session_id".to_string(), json!(id));
        resume_target = Some(id.clone());
    }
    if let Some(resume) = valid_resume_argv(resume_target.as_deref()) {
        params.insert("resume_argv".to_string(), json!(resume));
    }
    json!({
        "id": format!("{HERDR_SOURCE}:{}:{}", now_ms_x1000() / 1000, rand_suffix()),
        "method": "pane.report_agent",
        "params": Value::Object(params),
    })
}

/// The wire request releasing the pane (the quit close's last write).
fn release_request(pane_id: &str, seq: u64) -> Value {
    json!({
        "id": format!("{HERDR_SOURCE}:release:{}:{}", now_ms_x1000() / 1000, rand_suffix()),
        "method": "pane.release_agent",
        "params": {
            "pane_id": pane_id,
            "source": HERDR_SOURCE,
            "agent": HERDR_AGENT,
            "seq": seq,
        },
    })
}

/// A short random suffix for request ids (the TS
/// `Math.random().toString(36).slice(2)`): collisions only pair two
/// requests from the same millisecond, and Herdr treats ids as opaque.
fn rand_suffix() -> String {
    let random = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| u64::from(since.subsec_nanos()));
    format!("{random:x}")
}

/// Send one request line: connect, write, and finish on the first
/// response byte, an error, a close, or the 500 ms window (the TS
/// `sendRequest`). Failures are silent — the pane state API is
/// best-effort, and a down daemon must never wedge a session.
async fn send_request(socket_target: &str, request: Value) {
    let Ok(stream) =
        pa_types::platform::transport::connect_transport(std::path::Path::new(socket_target)).await
    else {
        return;
    };
    let (mut reader, mut writer) = stream.split();
    let line = format!("{request}\n");
    if writer.write_all(line.as_bytes()).await.is_err() {
        return;
    }
    let _ = writer.shutdown().await;
    let mut byte = [0u8; 1];
    let _ = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        reader.read_exact(&mut byte),
    )
    .await;
}

/// The resume argv a report carries (the one gap herdr's contract names
/// for a custom source: a reported resume command lets herdr restore the
/// pane's session natively — `herdr` records it because the state report
/// holds the pane, and restores it into the pane's shell). Herdr's
/// validation is strict — a bare command name, a bounded length, no
/// apostrophes or control characters — so a reference that cannot ride
/// the command safely is omitted rather than refused.
pub(crate) fn valid_resume_argv(target: Option<&str>) -> Option<Vec<String>> {
    let target = target?.trim();
    if target.is_empty() || target.contains('\'') || target.chars().any(char::is_control) {
        return None;
    }
    let argv = ["prime-agent", "--resume", target]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<String>>();
    let total: usize = argv.iter().map(String::len).sum::<usize>() + argv.len();
    if argv.len() > 64 || total > 8192 {
        return None;
    }
    Some(argv)
}

/// The error hold's message (the TS `errorHoldMessage`): the terminal
/// assistant row's provider error, when the run's last assistant row
/// ended in `stopReason: "error"`.
pub(crate) fn error_hold_message(messages: &[Value]) -> Option<String> {
    let last_assistant = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"));
    let assistant = last_assistant?;
    if assistant.get("stopReason").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let message = assistant
        .get("errorMessage")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .unwrap_or("provider error");
    Some(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn the_socket_target_maps_windows_and_passes_unix_through() {
        // Unix paths pass through unchanged on both platforms.
        assert_eq!(
            herdr_socket_target("/tmp/herdr.sock", false),
            "/tmp/herdr.sock"
        );
        assert_eq!(herdr_socket_target("herdr.sock", false), "herdr.sock");
        // A Unix-style path maps into the named-pipe namespace on
        // Windows (the TS mapping).
        assert_eq!(
            herdr_socket_target("/tmp/herdr.sock", true),
            "\\\\.\\pipe\\herdr.sock".replace("herdr.sock", "/tmp/herdr.sock")
        );
        // Already-namespaced paths pass through (the case-insensitive
        // prefix check).
        assert_eq!(
            herdr_socket_target("\\\\.\\PIPE\\herdr", true),
            "\\\\.\\PIPE\\herdr"
        );
        assert_eq!(
            herdr_socket_target("\\\\?\\pipe\\herdr", true),
            "\\\\?\\pipe\\herdr"
        );
    }

    #[test]
    fn the_config_requires_the_pane_env() {
        // No Herdr pane: no config (the connector is a no-op).
        assert!(HerdrConfig::from_env(&env(&[])).is_none());
        assert!(HerdrConfig::from_env(&env(&[("HERDR_ENV", "0")])).is_none());
        assert!(HerdrConfig::from_env(&env(&[("HERDR_ENV", "1")])).is_none());
        // The socket and the pane must both be present and non-empty.
        assert!(HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", "/tmp/h.sock"),
        ]))
        .is_none());
        assert!(
            HerdrConfig::from_env(&env(&[("HERDR_ENV", "1"), ("HERDR_PANE_ID", "w1:p1"),]))
                .is_none()
        );
        assert!(HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", "  "),
            ("HERDR_PANE_ID", "w1:p1"),
        ]))
        .is_none());
        let config = HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", " /tmp/h.sock "),
            ("HERDR_PANE_ID", " w1:p1 "),
        ]))
        .expect("a pane env resolves");
        assert_eq!(config.socket_path, "/tmp/h.sock");
        assert_eq!(config.pane_id, "w1:p1");
        // The tuning defaults (250ms idle debounce, 2500ms retry grace).
        assert_eq!(config.idle_debounce, Duration::from_millis(250));
        assert_eq!(config.retry_grace, Duration::from_millis(2500));
        // The tuning env overrides; invalid values fall back.
        let tuned = HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", "/tmp/h.sock"),
            ("HERDR_PANE_ID", "w1:p1"),
            ("HERDR_PI_IDLE_DEBOUNCE_MS", "10"),
            ("HERDR_PI_RETRY_GRACE_MS", "30"),
        ]))
        .expect("tuned config");
        assert_eq!(tuned.idle_debounce, Duration::from_millis(10));
        assert_eq!(tuned.retry_grace, Duration::from_millis(30));
        let invalid = HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", "/tmp/h.sock"),
            ("HERDR_PANE_ID", "w1:p1"),
            ("HERDR_PI_IDLE_DEBOUNCE_MS", "-1"),
            ("HERDR_PI_RETRY_GRACE_MS", "later"),
        ]))
        .expect("invalid tuning falls back to the defaults");
        assert_eq!(invalid.idle_debounce, Duration::from_millis(250));
        assert_eq!(invalid.retry_grace, Duration::from_millis(2500));
    }

    #[test]
    fn the_error_hold_reads_the_terminal_assistant_row() {
        // The terminal assistant row's error becomes the hold message.
        let messages = [
            json!({ "role": "user", "text": "hi" }),
            json!({ "role": "assistant", "stopReason": "error", "errorMessage": "overloaded" }),
        ];
        assert_eq!(
            error_hold_message(&messages),
            Some("overloaded".to_string())
        );
        // An error without a message holds with the fallback text.
        assert_eq!(
            error_hold_message(&[
                json!({ "role": "assistant", "stopReason": "error", "errorMessage": "" }),
            ]),
            Some("provider error".to_string())
        );
        // A settled row and an abort end do not hold.
        assert_eq!(
            error_hold_message(&[json!({
                "role": "assistant", "stopReason": "stop", "errorMessage": "irrelevant",
            })]),
            None
        );
        assert_eq!(
            error_hold_message(&[json!({
                "role": "assistant", "stopReason": "aborted",
            })]),
            None
        );
        // The LAST assistant row decides (an error earlier in the run
        // followed by a settled row does not hold).
        assert_eq!(
            error_hold_message(&[
                json!({ "role": "assistant", "stopReason": "error", "errorMessage": "early" }),
                json!({ "role": "assistant", "stopReason": "stop" }),
            ]),
            None
        );
        // An empty run holds nothing.
        assert_eq!(error_hold_message(&[]), None);
    }

    #[test]
    fn the_resume_argv_rides_only_valid_targets() {
        let argv = valid_resume_argv(Some("019e71ec-e08a-75a9-b573-000000000001.jsonl"));
        assert_eq!(
            argv,
            Some(vec![
                "prime-agent".to_string(),
                "--resume".to_string(),
                "019e71ec-e08a-75a9-b573-000000000001.jsonl".to_string(),
            ])
        );
        assert_eq!(
            valid_resume_argv(Some("  trimmed-id  ")),
            Some(vec![
                "prime-agent".into(),
                "--resume".into(),
                "trimmed-id".into()
            ])
        );
        // Missing, empty, or hostile targets carry no resume command.
        assert_eq!(valid_resume_argv(None), None);
        assert_eq!(valid_resume_argv(Some("")), None);
        assert_eq!(valid_resume_argv(Some("   ")), None);
        assert_eq!(valid_resume_argv(Some("id'; rm -rf /")), None);
        assert_eq!(valid_resume_argv(Some("id\u{0007}")), None);
    }

    #[test]
    fn the_seq_never_restarts_below_a_used_value() {
        // The process-global seq is monotonic and floor-clamped: within
        // one test run the successive values strictly increase.
        let first = next_report_seq();
        let second = next_report_seq();
        let third = next_report_seq();
        assert!(first < second && second < third, "{first} {second} {third}");
        assert!(first >= now_ms_x1000() - 1, "seeded at now_ms*1000");
    }

    /// A fake Herdr socket: one listener that records every request line
    /// and answers the wire success shape.
    fn fake_herdr(
        socket_path: &std::path::Path,
    ) -> (
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&requests);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let seen = std::sync::Arc::clone(&seen);
                let _ = tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                    let (reader, mut writer) = stream.split();
                    let mut lines = BufReader::new(reader);
                    let mut line = String::new();
                    while lines.read_line(&mut line).await.unwrap_or(0) > 0 {
                        if let Ok(request) = serde_json::from_str::<Value>(line.trim()) {
                            let id = request.get("id").cloned().unwrap_or(Value::Null);
                            seen.lock().unwrap().push(request);
                            let _ = writer
                                .write_all(
                                    format!(
                                        "{}\n",
                                        json!({ "id": id, "result": { "type": "ok" } })
                                    )
                                    .as_bytes(),
                                )
                                .await;
                        }
                        line.clear();
                    }
                })
                .await;
            }
        });
        (requests, handle)
    }

    async fn wait_for_requests(
        requests: &std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        count: usize,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if requests.lock().unwrap().len() >= count {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the reporter never sent {count} requests: {:?}",
                requests.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn states_of(requests: &std::sync::Arc<std::sync::Mutex<Vec<Value>>>) -> Vec<String> {
        requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request["params"]["state"].as_str().unwrap().to_string())
            .collect()
    }

    fn temp_socket(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-herdr-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("herdr.sock")
    }

    fn pane_env(socket_path: &std::path::Path, pane_id: &str) -> BTreeMap<String, String> {
        env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", &socket_path.to_string_lossy()),
            ("HERDR_PANE_ID", pane_id),
            ("HERDR_PI_IDLE_DEBOUNCE_MS", "10"),
            ("HERDR_PI_RETRY_GRACE_MS", "30"),
        ])
    }

    #[tokio::test]
    async fn the_reporter_publishes_the_wire_contract_states() {
        let socket_path = temp_socket("wire");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p1")).unwrap();
        let session_ref = HerdrSessionRef::new(
            Some("/home/me/.prime/agent/sessions/s1.jsonl".to_string()),
            Some("s1".to_string()),
        );
        let reporter = HerdrReporter::start(config, session_ref.clone());

        // session_start always reports (idle), refreshed with the same
        // file-backed session reference the worker resolves.
        reporter.session_started(false, session_ref);
        wait_for_requests(&requests, 1).await;
        let report = requests.lock().unwrap()[0].clone();
        assert_eq!(report["method"], "pane.report_agent");
        let params = &report["params"];
        assert_eq!(params["pane_id"], "w1:p1");
        assert_eq!(params["source"], "herdr:pi");
        assert_eq!(params["agent"], "prime-agent");
        assert_eq!(params["state"], "idle");
        assert_eq!(
            params["agent_session_path"],
            "/home/me/.prime/agent/sessions/s1.jsonl"
        );
        assert_eq!(
            params["resume_argv"],
            json!([
                "prime-agent",
                "--resume",
                "/home/me/.prime/agent/sessions/s1.jsonl"
            ])
        );
        // The id carries the source prefix; the seq is a number.
        assert!(report["id"].as_str().unwrap().starts_with("herdr:pi:"));
        assert!(params["seq"].as_u64().unwrap() > 0);
        // No message on non-blocked reports.
        assert!(params.get("message").is_none());

        // A run flips working, its end settles idle; unchanged states
        // publish once. The settle's idle may land while the working
        // write drains, so the assertion waits for the full chain.
        reporter.run_started();
        reporter.run_ended(None, false);
        wait_for_requests(&requests, 3).await;
        let states = states_of(&requests);
        assert_eq!(
            states,
            ["idle", "working", "idle"],
            "the run chain: {states:?}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn an_error_end_holds_then_blocks_with_the_message() {
        let socket_path = temp_socket("hold");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p2")).unwrap();
        let reporter =
            HerdrReporter::start(config, HerdrSessionRef::new(None, Some("s2".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s2".to_string())));
        wait_for_requests(&requests, 1).await;

        // An error end holds the working state (already published, so
        // the hold itself is silent) through the (30ms) grace, then
        // settles blocked with the error message.
        reporter.run_started();
        reporter.run_ended(Some("unexpected provider failure".to_string()), false);
        // The grace settle is a timer: wait for the blocked report.
        wait_for_requests(&requests, 3).await;
        let frames: Vec<Value> = requests.lock().unwrap().clone();
        let states: Vec<String> = frames
            .iter()
            .map(|request| request["params"]["state"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            states,
            ["idle", "working", "blocked"],
            "the hold then the settle: {states:?}"
        );
        let blocked = frames.last().unwrap();
        assert_eq!(blocked["params"]["message"], "unexpected provider failure");
        server.abort();
    }

    #[tokio::test]
    async fn a_retry_within_the_grace_keeps_the_pane_working() {
        let socket_path = temp_socket("retry");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p3")).unwrap();
        let reporter =
            HerdrReporter::start(config, HerdrSessionRef::new(None, Some("s3".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s3".to_string())));
        wait_for_requests(&requests, 1).await;

        // The error end starts the hold; the retry (the engine's
        // auto-retry) cancels it before the grace settles the block.
        reporter.run_started();
        reporter.run_ended(Some("flaky".to_string()), false);
        tokio::time::sleep(Duration::from_millis(5)).await;
        reporter.retry_started();
        reporter.run_ended(None, false);
        // The tail is working (the retry) then idle; no blocked report.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let states = states_of(&requests);
            if states.contains(&"idle".to_string()) && states.len() >= 3 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the retry run never settled: {states:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let states = states_of(&requests);
        assert!(
            !states.contains(&"blocked".to_string()),
            "a retry within the grace never blocks: {states:?}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn the_release_is_the_last_write_and_never_reclaims() {
        let socket_path = temp_socket("release");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p4")).unwrap();
        let reporter =
            HerdrReporter::start(config, HerdrSessionRef::new(None, Some("s4".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s4".to_string())));
        wait_for_requests(&requests, 1).await;

        // The quit release: awaited, the last write.
        reporter.release().await;
        wait_for_requests(&requests, 2).await;
        {
            let frames = requests.lock().unwrap();
            let release = frames.last().unwrap();
            assert_eq!(release["method"], "pane.release_agent");
            assert_eq!(release["params"]["pane_id"], "w1:p4");
            assert_eq!(release["params"]["source"], "herdr:pi");
            assert!(release["params"]["seq"].as_u64().unwrap() > 0);
        }
        // Nothing reports after the release — a late boundary event is
        // dropped, never a pane reclaim.
        reporter.run_started();
        reporter.run_ended(None, false);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(requests.lock().unwrap().len(), 2, "silence after release");
        server.abort();
    }

    #[tokio::test]
    async fn a_dropped_reporter_stays_silent_without_releasing() {
        let socket_path = temp_socket("silent");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p5")).unwrap();
        let reporter = HerdrReporter::start(
            config.clone(),
            HerdrSessionRef::new(None, Some("s5".to_string())),
        );
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s5".to_string())));
        wait_for_requests(&requests, 1).await;

        // A session replacement drops the old reporter: no release (the
        // pane is the successor's), and no further reports from it. The
        // frame guard is scoped: a live guard across the later waits
        // would self-deadlock the single-threaded test runtime's lock.
        drop(reporter);
        tokio::time::sleep(Duration::from_millis(80)).await;
        {
            let frames = requests.lock().unwrap();
            assert_eq!(frames.len(), 1, "no release, no reports after the drop");
            assert_eq!(frames[0]["method"], "pane.report_agent");
        }

        // A successor reporter in the same pane re-reports immediately
        // (its session_start) and its seq stays above the predecessor's.
        let successor =
            HerdrReporter::start(config, HerdrSessionRef::new(None, Some("s6".to_string())));
        successor.session_started(false, HerdrSessionRef::new(None, Some("s6".to_string())));
        wait_for_requests(&requests, 2).await;
        let (predecessor_seq, successor_seq) = {
            let frames = requests.lock().unwrap();
            (
                frames[0]["params"]["seq"].as_u64().unwrap(),
                frames[1]["params"]["seq"].as_u64().unwrap(),
            )
        };
        assert!(
            successor_seq > predecessor_seq,
            "the successor's seq must stay above the predecessor's: {predecessor_seq} -> {successor_seq}"
        );
        drop(successor);
        server.abort();
    }

    #[test]
    fn the_noop_reporter_is_inert() {
        let noop = HerdrReporter::default();
        assert!(!noop.enabled());
        // Every boundary call is a no-op (no task, no channel).
        noop.session_started(true, HerdrSessionRef::default());
        noop.run_started();
        noop.run_ended(None, false);
        noop.retry_started();
    }
}
