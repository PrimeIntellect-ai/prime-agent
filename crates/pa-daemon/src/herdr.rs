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
// AtomicBool feeds the unix-gated SOCKET_REFUSAL_LOGGED static only.
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
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
        // The JS bound (`setTimeout` saturates at 2^31 - 1 ms): a hostile
        // or runaway tuning value cannot overflow the deadline additions
        // (`Instant + Duration` panics on overflow, which would kill the
        // reporter task before it could report or release the pane).
        .map(|ms| ms.min(TUNING_MAX_MS))
        .map_or(Duration::from_millis(fallback_ms), Duration::from_millis)
}

/// The ceiling for the tuning envs (the JS `setTimeout` saturation bound).
const TUNING_MAX_MS: u64 = 2_147_483_647;

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
        // First use this process: seed at the floor. The CAS loser must
        // ADVANCE through the same loop as everyone else — returning
        // `seeded + 1` without storing it let the next caller mint the
        // same value (a duplicate seq herdr may drop).
        match REPORT_SEQ.compare_exchange(0, floor, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return floor,
            Err(seeded) => current = seeded,
        }
    }
    loop {
        let next = (current + 1).max(floor);
        match REPORT_SEQ.compare_exchange(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => current = seen,
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
    /// Start the reporter for a session resolved to a Herdr pane. The
    /// `generation` is the worker's reporter epoch (bumped on every
    /// (re)bind): the task drops signals once the shared counter has
    /// moved past its own epoch, so a replaced reporter's queued or
    /// racing boundary events cannot overwrite the successor's pane
    /// state — only the current reporter's writes reach the wire.
    pub(crate) fn start(
        config: HerdrConfig,
        session_ref: HerdrSessionRef,
        generation: u64,
        current_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(run_reporter(
            config,
            session_ref,
            generation,
            current_generation,
            rx,
        ));
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
/// The quit release: the last write, the pending drop, then the ack.
/// The write itself is time-bounded, so the awaiting caller's timeout is
/// the exception path, not the norm.
async fn release_pane(
    state: &mut ReporterState,
    config: &HerdrConfig,
    fence_hung: &mut bool,
    done: tokio::sync::oneshot::Sender<()>,
) {
    state.released = true;
    state.pending = None;
    state.idle_deadline = None;
    state.retry_deadline = None;
    // This task serializes every write and the drain below completed
    // before the release was admitted, so the release is the last
    // write on the wire — exactly the TS ordering contract. The same
    // fence gates it: a target that never accepted reports (or a
    // check that hung) releases nothing, and the ack still fires.
    let target = herdr_socket_target(&config.socket_path, cfg!(windows));
    let reached = if *fence_hung {
        false
    } else {
        let verdict = pane_socket_acceptable(&target).await;
        if matches!(verdict, FenceVerdict::TimedOut) {
            *fence_hung = true;
        }
        matches!(verdict, FenceVerdict::Accepted)
            && send_request(&target, release_request(&config.pane_id, next_report_seq())).await
    };
    let _ = reached;
    let _ = done.send(());
}

async fn run_reporter(
    config: HerdrConfig,
    session_ref: HerdrSessionRef,
    generation: u64,
    current_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Signal>,
) {
    // A stale reporter never writes: the worker bumped the generation
    // when it installed a successor, so this task's queued or racing
    // boundary events (and its pending slot) die here — only the
    // current reporter's writes reach the wire.
    let is_stale = || current_generation.load(std::sync::atomic::Ordering::Relaxed) != generation;
    // The pane-socket fence: checked per send at the task level (never
    // inside send_request). A missing or invalid target refuses that
    // one send (the cheap lstat re-checks next time); a HUNG check
    // (the 500 ms bound) refuses every later send without spawning
    // another blocking-pool thread the runtime cannot cancel.
    let mut fence_hung = false;
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
        if is_stale() {
            return;
        }
        // The next timer deadline, if any: the two debounce/grace timers.
        let deadline = [state.idle_deadline, state.retry_deadline]
            .into_iter()
            .flatten()
            .min();
        tokio::select! {
            signal = rx.recv() => {
                match signal {
                    Some(Signal::Release { done }) => {
                        if is_stale() {
                            // A successor owns the pane now (the rebind
                            // bumped the epoch and its `session_start`
                            // force-published): this task must neither
                            // release nor leak the caller — the ack still
                            // fires so the quit close does not stall on
                            // the timeout.
                            let _ = done.send(());
                            return;
                        }
                        release_pane(&mut state, &config, &mut fence_hung, done).await;
                        return;
                    }
                    Some(signal) => {
                        if is_stale() {
                            return;
                        }
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
        // Drain the single-slot queue — the TS latest-wins slot: the
        // queued state writes first, and the signals that arrived while
        // that write was in flight are absorbed after it, so only the
        // NEWEST state of a flapping run writes next (the absorbed
        // intermediates never hit the wire). Absorbing before the first
        // write would instead swallow the run's opening `working`.
        while !state.released && !state.silenced && !is_stale() {
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
            let reached_wire = if fence_hung {
                false
            } else {
                let verdict = pane_socket_acceptable(&target).await;
                if matches!(verdict, FenceVerdict::TimedOut) {
                    fence_hung = true;
                }
                matches!(verdict, FenceVerdict::Accepted) && send_request(&target, request).await
            };
            if reached_wire {
                // The state reached the wire (best-effort): the
                // publish-dedup keys on it. A failed or refused send
                // leaves it unpublished, so it re-queues at the next
                // boundary instead of being deduped away.
                state.last_state = Some(report.state);
                state.last_message = report.message;
            }
            if is_stale() {
                return;
            }
            while let Ok(signal) = rx.try_recv() {
                match signal {
                    Signal::Release { done } => {
                        // The same fence as the select arm: a stale
                        // reporter never releases the successor's pane,
                        // and the ack still fires so the quit close does
                        // not stall on the timeout.
                        if is_stale() {
                            let _ = done.send(());
                            return;
                        }
                        release_pane(&mut state, &config, &mut fence_hung, done).await;
                        return;
                    }
                    signal => handle_signal(&mut state, signal, &config),
                }
                if is_stale() {
                    return;
                }
            }
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
            // The successor starts CLEAN: the predecessor's failure
            // block, its hold message, and both timers describe the
            // replaced session, so `desired_state` must not carry them
            // over (a fork after a provider error must not re-publish
            // the old error as the new session's state).
            state.session_ref = session_ref;
            state.agent_active = active;
            state.retry_hold_active = false;
            state.failure_blocked = false;
            state.failure_message = None;
            state.idle_deadline = None;
            state.retry_deadline = None;
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
    // Dedup only against a state that actually reached the wire — a
    // never-sent state (Herdr down) must re-queue, not silently dedup
    // against the pre-wire default.
    if let Some(last_state) = state.last_state {
        if next_state == last_state && next_message == state.last_message {
            return;
        }
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
    // The slot only QUEUES here: `last_state` marks what is on the
    // wire, recorded after a successful send — a state whose send
    // failed (Herdr down) stays UNpublished, so the same state is
    // re-sent at the next boundary instead of being deduped away.
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

/// The pane-socket trust fence (the operator's hardening for the
/// client-supplied socket target): before the reporter connects, the
/// target must lstat (no symlink follow) as a Unix socket owned by THIS
/// process's own effective uid. A regular file, a symlink (even one
/// pointing at a legitimate socket), or a socket another user owns
/// never reports — the session simply stays unreported. The normal case
/// passes unchanged: Herdr's own socket under the user's runtime
/// directory is that user's own socket (TS parity). Named pipes on
/// Windows keep their connect-time ACL model (no lstat to check).
#[cfg(unix)]
static SOCKET_REFUSAL_LOGGED: AtomicBool = AtomicBool::new(false);

/// The fence's pure decision (unit-testable without `chown`): the
/// metadata must be a socket owned by `own_uid`.
#[cfg(unix)]
fn pane_socket_is_ownable(metadata: &std::fs::Metadata, own_uid: u32) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    metadata.file_type().is_socket() && metadata.uid() == own_uid
}

/// This process's effective uid, std-only (the crate forbids unsafe
/// code, so no direct `geteuid`): a file the process creates is owned by
/// its effective uid — the temp file's owner is exactly the uid the
/// fence compares against, which is also the uid a socket this process
/// would bind would carry. Cached once per process.
#[cfg(unix)]
fn effective_uid() -> Option<u32> {
    static UID: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *UID.get_or_init(|| probe_effective_uid(&std::env::temp_dir()))
}

/// The uid probe itself: `None` when the probe file cannot be created or
/// read — the fence FAILS CLOSED on `None` (it must never fall back to
/// uid 0, which would accept a root-owned socket).
#[cfg(unix)]
fn probe_effective_uid(dir: &std::path::Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let probe = dir.join(format!("pa-herdr-uid-probe-{}", uuid::Uuid::new_v4()));
    let uid = std::fs::File::create(&probe)
        .and_then(|file| file.metadata())
        .map(|metadata| metadata.uid())
        .ok();
    let _ = std::fs::remove_file(&probe);
    uid
}

/// The fence's verdict for one send.
// Only `Accepted` is constructed on Windows (named pipes keep their
// connect-time ACL model; the fence is unix-only).
#[cfg_attr(windows, allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FenceVerdict {
    /// The target is this process's own socket: the send may connect.
    Accepted,
    /// The target is missing or fails the ownership check: this send
    /// is refused (the cheap lstat re-checks on the next send).
    Rejected,
    /// The lstat itself hung past the 500 ms bound: the reporter never
    /// spawns another (a blocking-pool thread the runtime cannot
    /// cancel) — it fails closed for the rest of its life.
    TimedOut,
}

#[cfg(unix)]
async fn pane_socket_acceptable(socket_target: &str) -> FenceVerdict {
    // The lstat is a blocking syscall on a CLIENT-SUPPLIED path — it
    // moves off the async runtime (spawn_blocking) under the same
    // 500 ms bound as every other phase, so a pathological target (a
    // hung mount) cannot stall the reporter task, and a hung check is
    // never repeated (the pool thread cannot be cancelled).
    let target = socket_target.to_string();
    let checked = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        tokio::task::spawn_blocking(move || pane_socket_acceptable_blocking(&target)),
    )
    .await;
    match checked {
        Ok(Ok(true)) => FenceVerdict::Accepted,
        Ok(Ok(false)) => FenceVerdict::Rejected,
        Ok(Err(_)) | Err(_) => FenceVerdict::TimedOut,
    }
}

#[cfg(windows)]
// The async stays for the shared call site (the unix arm awaits); the
// windows pipe arm needs no await for its connect-time ACL verdict.
#[allow(clippy::unused_async)]
async fn pane_socket_acceptable(_socket_target: &str) -> FenceVerdict {
    // Named pipes carry their own ACL model at connect time.
    FenceVerdict::Accepted
}

/// The fence's blocking decision (runs on the blocking pool): lstat the
/// target, and accept only a socket this process's own uid owns.
#[cfg(unix)]
fn pane_socket_acceptable_blocking(socket_target: &str) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(socket_target) else {
        // A target that does not exist (yet) NEVER connects: passing it
        // through to the connect would open a check-then-use window (a
        // target created between the lstat and the connect bypasses the
        // fence). Refusing is wire-identical (the connect on a missing
        // path failed anyway) and the cheap NotFound lstat re-checks on
        // every send, so reporting starts the moment the socket appears.
        return false;
    };
    // A probe that cannot resolve the uid fails CLOSED (no report) —
    // falling back to uid 0 would accept a root-owned socket.
    let acceptable = effective_uid().is_some_and(|uid| pane_socket_is_ownable(&metadata, uid));
    if !acceptable
        && SOCKET_REFUSAL_LOGGED
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        // Log once per process (the pane state API is best-effort; a
        // hostile or misconfigured target must not spam the daemon log).
        eprintln!(
            "herdr: the pane socket target {socket_target} failed the ownership fence — this session stays unreported"
        );
    }
    acceptable
}

/// Send one request line: connect, write, and finish on the first
/// response byte, an error, a close, or the 500 ms window (the TS
/// `sendRequest`). Failures are silent — the pane state API is
/// best-effort, and a down daemon must never wedge a session.
async fn send_request(socket_target: &str, request: Value) -> bool {
    // Every phase of the one-shot request is time-bounded — connect,
    // write, and the response's first byte — so a wedged peer (a socket
    // that accepts but never reads) can never stall the reporter task
    // and starve later states or the release.
    let connected = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        pa_types::platform::transport::connect_transport(std::path::Path::new(socket_target)),
    )
    .await;
    let Ok(Ok(stream)) = connected else {
        return false;
    };
    let (mut reader, mut writer) = stream.split();
    let line = format!("{request}\n");
    let written = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        writer.write_all(line.as_bytes()),
    )
    .await;
    if !matches!(written, Ok(Ok(()))) {
        return false;
    }
    let _ = writer.shutdown().await;
    let mut byte = [0u8; 1];
    let _ = tokio::time::timeout(
        Duration::from_millis(SEND_TIMEOUT_MS),
        reader.read_exact(&mut byte),
    )
    .await;
    // The request left the process (best-effort: whether the peer read
    // it is unknowable, but the write succeeded).
    true
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

// Unix-only tests: the fake server binds a unix socket and the fence
// cases use unix symlink identity (the windows pipe arm's connect-time ACL
// model has no lstat equivalent to exercise here).
#[cfg(all(test, unix))]
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
        let requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
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

    /// A fresh generation counter with the reporter started at epoch 1:
    /// tests that exercise the stale-generation gate bump the counter.
    fn start_reporter(
        config: HerdrConfig,
        session_ref: HerdrSessionRef,
    ) -> (HerdrReporter, std::sync::Arc<std::sync::atomic::AtomicU64>) {
        let current = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1));
        let reporter =
            HerdrReporter::start(config, session_ref, 1, std::sync::Arc::clone(&current));
        (reporter, current)
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
        let (reporter, _generation) = start_reporter(config, session_ref.clone());

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
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s2".to_string())));
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
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s3".to_string())));
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
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s4".to_string())));
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

    /// A session replacement must not inherit the predecessor's
    /// failure state: the successor's `session_start` publishes clean
    /// (idle), never the old blocked/error shape.
    #[tokio::test]
    async fn a_replacement_resets_the_predecessor_failure_state() {
        let socket_path = temp_socket("reset");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p6")).unwrap();
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s7".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s7".to_string())));
        wait_for_requests(&requests, 1).await;

        // The predecessor's run fails and settles blocked with the error.
        reporter.run_started();
        reporter.run_ended(Some("overloaded".to_string()), false);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let states = states_of(&requests);
            if states.last() == Some(&"blocked".to_string()) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the failure never settled blocked: {states:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // The successor session starts on the SAME pane: clean idle, the
        // predecessor's block and message do not carry over.
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s8".to_string())));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let frames = requests.lock().unwrap().clone();
            if let Some(last) = frames.last() {
                if last["params"]["state"] == "idle" {
                    assert!(
                        last["params"].get("message").is_none(),
                        "the successor inherited the error message: {last}"
                    );
                    assert_eq!(last["params"]["agent_session_id"], "s8");
                    assert!(frames.len() >= 3, "the frames: {frames:?}");
                    server.abort();
                    return;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the successor never reported idle: {frames:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The stale-generation gate: a replaced reporter's racing boundary
    /// events never reach the wire — only the successor's do.
    #[tokio::test]
    async fn a_stale_generation_reporter_never_writes() {
        let socket_path = temp_socket("stale");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p7")).unwrap();
        let (predecessor, generation) = start_reporter(
            config.clone(),
            HerdrSessionRef::new(None, Some("s9".to_string())),
        );
        predecessor.session_started(false, HerdrSessionRef::new(None, Some("s9".to_string())));
        wait_for_requests(&requests, 1).await;

        // The worker installs a successor: the generation moves past the
        // predecessor's epoch.
        generation.store(2, std::sync::atomic::Ordering::Relaxed);
        let successor = HerdrReporter::start(
            config,
            HerdrSessionRef::new(None, Some("s10".to_string())),
            2,
            std::sync::Arc::clone(&generation),
        );
        // The predecessor's late boundary event must be dropped by the
        // gate, never sent (the wire stays at one frame until the
        // successor speaks).
        predecessor.run_started();
        tokio::time::sleep(Duration::from_millis(80)).await;
        let frames = requests.lock().unwrap().clone();
        assert_eq!(
            frames.len(),
            1,
            "a stale-generation reporter wrote: {frames:?}"
        );

        // The successor reports for its own session.
        successor.session_started(false, HerdrSessionRef::new(None, Some("s10".to_string())));
        wait_for_requests(&requests, 2).await;
        let frames = requests.lock().unwrap().clone();
        assert_eq!(frames[1]["params"]["agent_session_id"], "s10");
        server.abort();
    }

    /// A runaway tuning env cannot overflow the deadline arithmetic:
    /// the value caps at the JS `setTimeout` bound instead of panicking
    /// the reporter task with `Instant + Duration`.
    #[test]
    fn runaway_tuning_values_cap_instead_of_panicking() {
        let config = HerdrConfig::from_env(&env(&[
            ("HERDR_ENV", "1"),
            ("HERDR_SOCKET_PATH", "/tmp/h.sock"),
            ("HERDR_PANE_ID", "w1:p1"),
            ("HERDR_PI_IDLE_DEBOUNCE_MS", &u64::MAX.to_string()),
            ("HERDR_PI_RETRY_GRACE_MS", &u64::MAX.to_string()),
        ]))
        .expect("the runaway config still resolves");
        assert_eq!(config.idle_debounce, Duration::from_millis(2_147_483_647));
        assert_eq!(config.retry_grace, Duration::from_millis(2_147_483_647));
        // The capped deadline additions are representable.
        let _ = tokio::time::Instant::now() + config.idle_debounce;
        let _ = tokio::time::Instant::now() + config.retry_grace;
    }

    /// A stale-generation reporter never releases the successor's pane —
    /// and the dropped release still acks so the quit close does not
    /// stall on the timeout.
    #[tokio::test]
    async fn a_stale_release_neither_writes_nor_stalls() {
        let socket_path = temp_socket("stale-release");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p8")).unwrap();
        let (predecessor, generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s11".to_string())));
        predecessor.session_started(false, HerdrSessionRef::new(None, Some("s11".to_string())));
        wait_for_requests(&requests, 1).await;

        // The successor installs: the epoch moves past the predecessor.
        generation.store(2, std::sync::atomic::Ordering::Relaxed);
        let released_at = tokio::time::Instant::now();
        predecessor.release().await;
        let awaited = released_at.elapsed();
        assert!(
            awaited < Duration::from_secs(1),
            "a dropped release must ack promptly, took {awaited:?}"
        );
        let frames = requests.lock().unwrap().clone();
        assert_eq!(
            frames.len(),
            1,
            "a stale reporter released the successor's pane: {frames:?}"
        );
        server.abort();
    }

    /// The pane-socket fence decides by file type and owner: a bound
    /// socket this process owns passes, a regular file and a symlink
    /// (even one pointing at the legitimate socket) never do, and the
    /// pure decision rejects a foreign owner (the `chown`-free mock: a
    /// uid that is not ours).
    #[cfg(unix)]
    #[tokio::test]
    async fn the_pane_socket_fence_decides_by_type_and_owner() {
        let socket_path = temp_socket("fence");
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let own_metadata = std::fs::symlink_metadata(&socket_path).unwrap();

        // The owner check is the process's own uid for a real socket
        // (the probe succeeds on this box — the cached Some carries it).
        let own_uid = effective_uid().expect("the uid probe succeeds in a writable temp dir");
        assert!(pane_socket_is_ownable(&own_metadata, own_uid));
        // A foreign owner never passes (the mocked metadata check).
        assert!(!pane_socket_is_ownable(&own_metadata, own_uid + 1));
        // A regular file is never a pane socket.
        let file_path = socket_path.with_extension("file");
        std::fs::write(&file_path, b"not a socket").unwrap();
        let file_metadata = std::fs::symlink_metadata(&file_path).unwrap();
        assert!(!pane_socket_is_ownable(&file_metadata, own_uid));
        // A symlink never passes — even one pointing at the legitimate
        // socket (lstat does not follow).
        let link_path = socket_path.with_extension("link");
        std::os::unix::fs::symlink(&socket_path, &link_path).unwrap();
        let link_metadata = std::fs::symlink_metadata(&link_path).unwrap();
        assert!(!pane_socket_is_ownable(&link_metadata, own_uid));
        // The fence end of it: the real socket passes, the file and the
        // symlink do not, and a missing target REFUSES (no connect is
        // ever attempted on it — the check-then-use window stays
        // closed; the cheap NotFound lstat re-checks on every send, so
        // reporting starts the moment the socket appears).
        assert_eq!(
            pane_socket_acceptable(socket_path.to_str().unwrap()).await,
            FenceVerdict::Accepted
        );
        assert_eq!(
            pane_socket_acceptable(file_path.to_str().unwrap()).await,
            FenceVerdict::Rejected
        );
        assert_eq!(
            pane_socket_acceptable(link_path.to_str().unwrap()).await,
            FenceVerdict::Rejected
        );
        assert_eq!(
            pane_socket_acceptable(socket_path.with_extension("absent").to_str().unwrap()).await,
            FenceVerdict::Rejected
        );
        drop(listener);
    }

    /// A reporter aimed at a non-socket target stays silent: the fence
    /// drops the report before the connect, exactly like a missing
    /// socket.
    #[tokio::test]
    async fn a_reporter_into_a_non_socket_target_stays_silent() {
        // A LIVE listener exists at the real path: the impostor the
        // reporter receives is a symlink pointing AT it. If the fence
        // ever followed the link (or accepted the impostor), the
        // server below would record the report — the assertion watches
        // a real, reachable sink, never a vacuous vector.
        let dir = temp_socket("not-a-socket");
        let real_socket = dir.with_extension("real.sock");
        let (requests, server) = fake_herdr(&real_socket);
        let impostor = dir.with_extension("impostor");
        std::os::unix::fs::symlink(&real_socket, &impostor).unwrap();

        let config = HerdrConfig::from_env(&pane_env(&impostor, "w1:p9")).unwrap();
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s12".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s12".to_string())));
        tokio::time::sleep(Duration::from_millis(120)).await;
        let frames = requests.lock().unwrap().clone();
        assert!(
            frames.is_empty(),
            "a non-socket target produced reports: {frames:?}"
        );
        reporter.release().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let frames = requests.lock().unwrap().clone();
        assert!(
            frames.is_empty(),
            "a non-socket target produced a release: {frames:?}"
        );
        server.abort();
    }

    /// A uid probe that cannot create its file yields `None`, and the
    /// fence treats `None` as reject (fail closed — the probe must never
    /// fall back to uid 0, which would accept a root-owned socket).
    #[cfg(unix)]
    #[test]
    fn a_failed_uid_probe_fails_closed() {
        assert!(
            probe_effective_uid(std::path::Path::new("/nonexistent-pa-herdr-probe-dir")).is_none()
        );
        // The fence's `None` arm is its own `is_some_and` — a refused
        // uid never reaches the owner check at all.
    }

    /// A state whose send never reached the wire (the socket down) is
    /// NOT recorded as published: the same state re-sends at the next
    /// boundary once the socket exists. The old queue-time marking
    /// deduped it away forever — this test fails on that shape.
    #[tokio::test]
    async fn a_state_is_re_sent_after_the_socket_comes_up() {
        let socket_path = temp_socket("late-boot");

        // A full turn happens with the socket MISSING: the fence
        // refuses every send (nothing ever reached the wire, and the
        // pending states were never marked published).
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p10")).unwrap();
        let (reporter, _generation) =
            start_reporter(config, HerdrSessionRef::new(None, Some("s13".to_string())));
        reporter.session_started(false, HerdrSessionRef::new(None, Some("s13".to_string())));
        reporter.run_started();
        reporter.run_ended(None, false);

        // Herdr boots: the socket appears at exactly that path.
        let (requests, server) = fake_herdr(&socket_path);

        // The next turn re-sends the SAME states — and then blocks: an
        // error end produces `blocked`, a state the clean down-phase
        // turn can never deliver, and the frame the retry grace settles
        // is the RE-SENT `working` (the run start's working that never
        // reached the wire while the socket was down). The old
        // queue-time `last_state` marking deduped that working away
        // forever, so nothing but the grace's `blocked` would land. No
        // fixed sleep orders the phases: the reporter task is
        // sequential, so whether the down-phase's refused sends drained
        // before or after the listener bound, the assertion keys on the
        // observed `blocked` and its predecessor only.
        reporter.run_started();
        reporter.run_ended(Some("late provider failure".to_string()), false);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let states = states_of(&requests);
            if let Some(blocked_at) = states.iter().position(|state| state == "blocked") {
                assert!(
                    blocked_at > 0 && states[blocked_at - 1] == "working",
                    "the re-sent working never preceded the block: {states:?}"
                );
                let blocked = requests.lock().unwrap()[blocked_at].clone();
                assert_eq!(
                    blocked["params"]["message"], "late provider failure",
                    "the block carries the error: {states:?}"
                );
                server.abort();
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the re-sent turn never settled blocked: {states:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Concurrent seq minting never duplicates: the first-seed race's
    /// loser must advance the shared counter like every other caller.
    #[test]
    fn concurrent_seq_mints_never_duplicate() {
        let all = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let all = &all;
                scope.spawn(move || {
                    let mut mine = Vec::new();
                    for _ in 0..50 {
                        mine.push(next_report_seq());
                    }
                    all.lock().unwrap().extend(mine);
                });
            }
        });
        let all = all.into_inner().unwrap();
        let distinct = all.iter().collect::<std::collections::HashSet<_>>().len();
        assert_eq!(distinct, all.len(), "duplicate seq minted: {all:?}");
    }

    #[tokio::test]
    async fn a_dropped_reporter_stays_silent_without_releasing() {
        let socket_path = temp_socket("silent");
        let (requests, server) = fake_herdr(&socket_path);
        let config = HerdrConfig::from_env(&pane_env(&socket_path, "w1:p5")).unwrap();
        let (reporter, generation) = start_reporter(
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
        let successor = HerdrReporter::start(
            config,
            HerdrSessionRef::new(None, Some("s6".to_string())),
            generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1,
            std::sync::Arc::clone(&generation),
        );
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
