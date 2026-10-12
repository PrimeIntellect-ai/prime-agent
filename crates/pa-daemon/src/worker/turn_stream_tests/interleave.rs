//! The interleave harness (the passivation lane's named follow-up from the
//! nine-round bar): the race windows between concurrent lifecycle events —
//! the class every fresh bot pass found a new instance of (the round-1
//! concurrent-wake join, the round-5 departure release, the round-6
//! post-await windows, the round-7 compacting/attach revalidation, the
//! round-8 shutdown/admission and attach/close orders, the round-9 token
//! lifecycle) — pinned as tests, so the class is closed by construction,
//! not by the next bot pass.
//!
//! THE HARNESS CONTRACT (the abort-idle-race lane's rate-harness precedents,
//! made deterministic):
//! - THE DIRECT-DRIVE FIRE: the raced window lives inside
//!   [`TurnRunner::maybe_request_idle_passivation`] — the engine gate's
//!   await, between the fresh-snapshot fence and the post-await
//!   revalidation. The harness drives THAT path directly (the same
//!   discipline the product's own e2e uses: `idle_passivation_e2e.rs`
//!   drives the worker->supervisor passivation request directly so the
//!   e2e stays gate-fast). The park->window->timer leg cannot be driven
//!   deterministically: the park arm re-stamps `last_activity_ms` from
//!   `SystemTime` and the fire's fresh-clock gate re-checks the same wall
//!   clock, so no in-process clock fake can carry the fire past its own
//!   gate (and `idleEvictionMinutes: 0` is not a zero threshold — the
//!   settings grammar falls back to the default). The timer leg stays
//!   pinned at rest by the park family's window battery; this harness
//!   pins the RACE — the events landing while the fire holds.
//! - PROBE-TRUE-AT-THE-SEAM: every raced test parks the fire at a
//!   PROVABLE point before landing the racing event — the fire holds
//!   inside the engine gate's await (the [`GateHoldEngine`] seam, the
//!   exact window the post-await revalidation covers), reached exactly
//!   once (the gate counter). The racing event never lands blind.
//! - THE JOIN BARRIER: the settle is the fire task's own join — the
//!   raced continuation (the post-await revalidation, the ask) runs to
//!   completion before any assertion reads the transcript. No test
//!   sleeps; no assertion reads a wall latency.
//! - THE TRANSCRIPT ASSERTION: the settled state names the winner —
//!   the recording supervisor probe OBSERVES the ask as the exact
//!   command the product sends (`worker_idle_passivation` with the
//!   worker token and the threshold), never inferred from a side
//!   effect (the served-path oracle, the `window_serves` pattern: an
//!   oracle that cannot prove the request left is vacuous exactly
//!   where it matters).
//! - THE SERVED-PATH PAIRING: every cancel arm shares the positive
//!   arm's fixture, so a broken harness (a link that never answers, a
//!   gate that never releases) fails the positive arm first — the
//!   cancel arms cannot green themselves by never asking.
//!
//! THE PINS (the nine rounds' windows, each named by the round that found
//! it, plus the two residual windows the harness itself found — the lane's
//! product fixes):
//! - THE POST-AWAIT REVALIDATION (rounds 6/7/9): a client attaching, lane
//!   work parking, a manual compaction starting, an input suspension
//!   engaging, a user bash admitted, or a shutdown starting WHILE the fire
//!   holds at the engine gate each cancel the stop and keep the racing
//!   work intact. The shutdown arm is the harness's residual finding: the
//!   round-9 "uniform predicate set" claim did not hold at the post-await
//!   site (the arm ships with the harness).
//! - THE SHUTDOWN'S BASH ADMISSION (rounds 7/8): a bash dispatched while
//!   the stop is closing is refused ("Session is shutting down"), and a
//!   bash admitted before the stop is aborted by it (the settled run
//!   reports cancelled).
//! - THE ATTACH/CLOSE TOKEN LIFECYCLE (rounds 8/9): both orders pinned —
//!   the close beating the detached handler's registration leaves no
//!   unowned hold (the harness's residual finding: the round-8 belt
//!   closed the registry entry but the core retain was still ungated; the
//!   retain now rides the registration's verdict), the registration
//!   beating the close releases cleanly, the non-final detach re-registers,
//!   the shared client id survives one connection's close, the
//!   released-token set caps.
//!
//! DISCLOSED COVERAGE: the input-pause lease arm of the suspension gates
//! shares the window/fence predicate with `queued_input_suspended` (one
//! `||` term at every site); the pause table's lease arms are not
//! runner-seizable in-crate, so the arm stays covered at rest by the park
//! family's predicate-set test. The timer leg (the park loop's sleep to
//! the threshold) is wall-clock-bound by design and stays pinned at rest
//! by the park family's window battery plus the product's real-time
//! coverage. The departure release (a closed connection's release
//! re-arming the window) is the park family's window battery too. The
//! gate-before-abort ORDER inside `handle_shutdown` (one critical section
//! sets `shutdown_requested` before `user_bash.abort()` runs) has no seam
//! a test can hold between the two steps, so no test here pins it - the
//! tests pin each step's effect. The base's `UserBash` open corners (the single-slot overlap,
//! the forked-grandchild survival) are TS-anchored follow-ups on the
//! base's bash surface — out of this lane's scope (the round-9 rebuttal
//! carries them).
// Unix-only: the probe harness stands in for the supervisor side of
// the passivation ask over a real unix domain socket
// (tokio::net::UnixListener), which has no counterpart on the windows
// target.
#![cfg(unix)]

use super::park::passivation_settings;
use super::*;

// ---------------------------------------------------------------------------
// The fixtures: the recording supervisor probe, the engine-gate seam, and
// the runner/worker builders.
// ---------------------------------------------------------------------------

/// The recording supervisor-side probe: a real private-framed JSONL socket
/// the harness owns, standing in for the supervisor's stop path. The fire's
/// ask is OBSERVED as the exact command the product sends (the
/// `worker_idle_passivation` shape with the worker token and the threshold)
/// and answered with a success — never inferred from a side effect.
struct StopAskProbe {
    socket: PathBuf,
    asks: Arc<Mutex<Vec<Value>>>,
    _dir: tempfile::TempDir,
}

impl StopAskProbe {
    /// Bind the probe socket and spawn its accept loop (one connection per
    /// ask — the product link dials a fresh socket per request).
    fn spawn() -> Self {
        let dir = tempfile::TempDir::new().expect("probe dir");
        let socket = dir.path().join("probe.sock");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind probe socket");
        let asks: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&asks);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let asks = Arc::clone(&sink);
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                    let (read_half, mut write_half) = stream.into_split();
                    // The link's handshake: the probe is the supervisor
                    // side, so the hello goes first (the link only checks
                    // the `daemon_hello` tag).
                    if write_half
                        .write_all(
                            b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => {}
                        }
                        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                            continue;
                        };
                        if value.get("type").and_then(Value::as_str) != Some("command") {
                            continue;
                        }
                        let Some(command) = value.get("command").cloned() else {
                            continue;
                        };
                        let id = value
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let kind = command
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        asks.lock().unwrap().push(command);
                        let response = crate::protocol::response_line(
                            &crate::protocol::response_success(Some(&id), &kind, None),
                        );
                        let mut answer = serde_json::to_string(&response).unwrap_or_default();
                        answer.push('\n');
                        if write_half.write_all(answer.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self {
            socket,
            asks,
            _dir: dir,
        }
    }

    /// The recorded stop asks (the served-path oracle's read side).
    fn asks(&self) -> Vec<Value> {
        self.asks.lock().unwrap().clone()
    }
}

/// The engine-gate seam: `can_passivate_worker` signals entry and
/// parks on its release Notify, so the harness holds the fire at the EXACT
/// await the post-await revalidation covers — probe-true-at-the-seam. The
/// engine counts gate entries (the cancel arms must reach it exactly once).
struct GateHoldEngine {
    entered: Arc<Notify>,
    release: Arc<Notify>,
    gates: Arc<std::sync::atomic::AtomicUsize>,
}

impl GateHoldEngine {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            gates: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
}

impl SessionEngine for GateHoldEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "unsupported".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Skipped {
            message: "nothing to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: crate::engine::BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::BranchSummaryOutcome::Failed {
            error: "unsupported".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    fn can_passivate_worker(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        let entered = Arc::clone(&self.entered);
        let release = Arc::clone(&self.release);
        let gates = Arc::clone(&self.gates);
        Box::pin(async move {
            gates.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            entered.notify_waiters();
            release.notified().await;
            true
        })
    }
}

/// The raced-fire runner fixture: an unattached session (roots and children
/// alike reach the fire since the depth fence left) under the one-minute
/// eviction threshold, its idle clock already two minutes
/// past the stamp (the park loop's own re-stamp shape — `now_ms() - 120s`,
/// wall-clock elapsed, so the fire's fresh-clock gate passes
/// deterministically; no test waits a real threshold), the probe link in
/// place of the supervisor socket, and the gate engine as the session's
/// engine (the fire can reach the gate and hold).
fn interleave_runner(
    engine: &Arc<GateHoldEngine>,
    probe: &StopAskProbe,
) -> (TurnRunner, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().expect("runner dir");
    let agent_dir = dir.path().join("agent");
    passivation_settings(&agent_dir, &json!(1));
    let mut runner = burst_runner(Arc::clone(engine) as Arc<dyn SessionEngine>);
    {
        let mut core = runner.core.lock().unwrap();
        core.cwd = dir.path().to_string_lossy().to_string();
        // The idle clock crossed the 1-minute threshold two minutes ago:
        // the fresh-snapshot fence and the fresh-clock gate both pass, and
        // the 120s margin dwarfs any test-time jitter.
        core.last_activity_ms = crate::util::now_ms().saturating_sub(120_000);
    }
    runner.passivation.agent_dir = agent_dir;
    runner.passivation.link = Arc::new(crate::supervisor_link::SupervisorLink::new(
        probe.socket.clone(),
    ));
    runner.passivation.worker_token = "interleave-worker-token".to_string();
    (runner, dir)
}

/// Drive the fire itself to the engine-gate seam and prove it: the spawned
/// fire runs the fresh-snapshot fence and the fresh-clock gate, and the
/// returned seam completes only once the fire PROVABLY reached the engine
/// gate's await (the racing event's landing zone). The park->window->timer
/// leg is the park family's at-rest battery (see the module docs).
async fn drive_the_fire_to_the_gate(
    runner: TurnRunner,
    dir: tempfile::TempDir,
    gate: &GateHoldEngine,
) -> FiredSeam {
    let runner = Arc::new(runner);
    let core = Arc::clone(&runner.core);
    let user_bash = Arc::clone(&runner.user_bash);
    let entered = gate.entered.notified();
    let fired = {
        let fire = Arc::clone(&runner);
        tokio::spawn(async move {
            fire.maybe_request_idle_passivation().await;
        })
    };
    entered.await;
    assert_eq!(
        gate.gates.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the fire must reach the engine gate (the seam probe)"
    );
    FiredSeam {
        core,
        user_bash,
        fired,
        _dir: dir,
    }
}

/// The reached seam: the fire is parked inside the engine gate's await,
/// and these are the handles the racing events land through.
struct FiredSeam {
    core: Arc<Mutex<SessionCore>>,
    user_bash: Arc<crate::user_bash::UserBash>,
    /// The in-flight fire: the settle barrier — the raced continuation
    /// (the post-await revalidation, the ask) runs to completion when
    /// this handle joins.
    fired: tokio::task::JoinHandle<()>,
    /// The runner's temp tree (the settings the fire reads): it stays
    /// alive with the seam so the fire never reads a gone file.
    _dir: tempfile::TempDir,
}

/// Release the held fire and settle on its own completion: the post-await
/// revalidation and the ask run to their end before any assertion reads
/// the transcript — the join barrier, never a timing window. The settle
/// TAKES the fire handle (the caller's last use of the seam's settle
/// arm; the survivors stay readable through the seam's own handles).
async fn release_the_gate_and_settle(gate: &GateHoldEngine, fired: tokio::task::JoinHandle<()>) {
    gate.release.notify_one();
    fired.await.expect("the fire settles at its own completion");
}

// ---------------------------------------------------------------------------
// THE POST-AWAIT REVALIDATION (the fire's window, rounds 6/7/9 + the
// shutdown arm the harness found).
// ---------------------------------------------------------------------------

/// The positive arm (the served-path oracle): an unraced fire passes the
/// fresh-snapshot fence, the fresh-clock gate, and the engine gate, then
/// asks the supervisor to stop — exactly one `worker_idle_passivation` ask,
/// carrying the worker token and the live threshold. Every cancel arm
/// below shares this fixture; without this proof a missing ask would be
/// vacuous.
#[tokio::test]
async fn the_unraced_fire_passes_the_gate_and_asks_the_supervisor_to_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    release_the_gate_and_settle(&gate, seam.fired).await;
    let asks = probe.asks();
    assert_eq!(
        asks.len(),
        1,
        "the unraced fire must ask exactly once: {asks:?}"
    );
    assert_eq!(
        asks[0].get("type").and_then(Value::as_str),
        Some("worker_idle_passivation")
    );
    assert_eq!(
        asks[0].get("workerToken").and_then(Value::as_str),
        Some("interleave-worker-token")
    );
    assert_eq!(asks[0].get("idleMinutes").and_then(Value::as_u64), Some(1));
}

/// A client attaching while the fire holds at the engine gate (the round-7
/// window): the post-await revalidation cancels the stop, and the racing
/// client's hold survives intact (the stop would have disconnected it).
#[tokio::test]
async fn a_client_attaching_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    seam.core
        .lock()
        .unwrap()
        .attached_client_ids
        .push("late-client".to_string());
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "a client attaching at the gate must cancel the stop: {:?}",
        probe.asks()
    );
    assert!(
        seam.core
            .lock()
            .unwrap()
            .attached_client_ids
            .iter()
            .any(|id| id.as_str() == "late-client"),
        "the racing client's hold must survive the canceled stop"
    );
}

/// Lane work parking while the fire holds at the engine gate (the round-6
/// B1/B3 windows: a racing steer, and a replayed `pending_next_turn` row):
/// the stop cancels — the queued work lives only on the resident worker,
/// so the graceful stop would have discarded it — and both rows survive.
#[tokio::test]
async fn lane_work_parking_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    let parked_steer = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "the racing steer".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = seam.core.lock().unwrap();
        core.steering.push_back(parked_steer);
        core.pending_next_turn
            .push(json!({ "type": "user", "text": "the replayed prefix row" }));
    }
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "lane work parking at the gate must cancel the stop: {:?}",
        probe.asks()
    );
    let core = seam.core.lock().unwrap();
    assert_eq!(
        core.steering.len(),
        1,
        "the racing steer must survive the canceled stop"
    );
    assert_eq!(
        core.pending_next_turn.len(),
        1,
        "the racing replay prefix must survive the canceled stop"
    );
}

/// A manual compaction starting while the fire holds at the engine gate
/// (the round-7 window): the stop cancels — the shutdown would have
/// cancelled the compaction mid-run.
#[tokio::test]
async fn a_manual_compaction_starting_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    seam.core.lock().unwrap().compacting = true;
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "a compaction starting at the gate must cancel the stop: {:?}",
        probe.asks()
    );
}

/// An input suspension engaging while the fire holds at the engine gate
/// (the round-8 window): the stop cancels — the revival initializes the
/// fresh core un-suspended, so the paused pump's suspension state would be
/// lost. The `queued_input_suspended` arm stands for the suspension
/// predicate set (the input-pause lease arm shares the same `||` term).
#[tokio::test]
async fn an_input_suspension_engaging_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    seam.core.lock().unwrap().queued_input_suspended = true;
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "a suspension engaging at the gate must cancel the stop: {:?}",
        probe.asks()
    );
}

/// A user bash admitted while the fire holds at the engine gate (the
/// round-6/7 windows): the stop cancels — the worker's exit would have
/// left the user's process running (the awaited-run bracket holds the same
/// `isBashRunning` contribution the exclusive slot does).
#[tokio::test]
async fn a_user_bash_admitted_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    // The awaited-run bracket: `begin_awaited` is the same
    // `isBashRunning` contribution `execute_bash_and_wait` makes.
    let awaited = seam.user_bash.begin_awaited();
    assert!(
        seam.user_bash.is_running(),
        "the probe: the bash hold is live at the seam"
    );
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "a bash admitted at the gate must cancel the stop: {:?}",
        probe.asks()
    );
    drop(awaited);
}

/// A shutdown starting while the fire holds at the engine gate: the stop
/// cancels (the round-9 "uniform predicate set" claim, made true at the
/// post-await site — the harness's residual finding: the ask would have
/// raced the worker's own exit). Stricter than TS: daemon-mode.ts
/// `passivateSession` checks `shuttingDown` only before its fresh-snapshot
/// await.
#[tokio::test]
async fn a_shutdown_starting_at_the_gate_cancels_the_stop() {
    let probe = StopAskProbe::spawn();
    let gate = Arc::new(GateHoldEngine::new());
    let (runner, dir) = interleave_runner(&gate, &probe);
    let seam = drive_the_fire_to_the_gate(runner, dir, &gate).await;
    seam.core.lock().unwrap().shutdown_requested = true;
    release_the_gate_and_settle(&gate, seam.fired).await;
    assert!(
        probe.asks().is_empty(),
        "a shutdown starting at the gate must cancel the stop ask: {:?}",
        probe.asks()
    );
}

// ---------------------------------------------------------------------------
// THE SHUTDOWN'S BASH ADMISSION (rounds 7/8): the gate refuses, the abort kills.
// ---------------------------------------------------------------------------

/// A created worker over the plain scripted engine: the register/release
/// and shutdown/admission seams need the worker's own dispatch surface.
async fn interleave_worker() -> (Arc<Worker>, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().expect("worker dir");
    let config = WorkerConfig {
        socket_path: dir.path().join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "interleave-worker".to_string(),
        agent_dir: dir.path().join("agent"),
        recovery_journal_path: dir.path().join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": [] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": dir.path().to_string_lossy(), "name": "interleave" }),
        )
        .await;
    assert!(created.success, "the worker's create failed: {created:?}");
    (worker, dir)
}

/// A bounded state probe (the repo's standard wait shape): poll until the
/// predicate holds or the deadline passes — never a fixed sleep.
async fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !predicate() {
        assert!(
            std::time::Instant::now() < deadline,
            "the probed state never arrived"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// Read the worker's event stream until one `session_event` frame of the
/// given type lands (the positive signal the raced flow ran).
async fn wait_for_event(
    events: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
    event_type: &str,
) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let frame =
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), events.recv())
                .await
                .expect("the event never arrived")
                .expect("the event stream stays live");
        if frame.outbound_type != "session_event" {
            continue;
        }
        let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
            continue;
        };
        if outbound["event"]["type"].as_str() == Some(event_type) {
            return outbound["event"].clone();
        }
    }
}

/// The round-8 admission pin: a bash dispatched while the graceful stop
/// holds at its work-settled park (a compaction in flight keeps it parked
/// there) is REFUSED by the shutdown admission gate and spawns no child.
/// This pins the gate, not its order against the bash abort (see the
/// module docs).
#[tokio::test]
async fn the_shutdown_gate_refuses_a_bash_admitted_inside_the_stop() {
    let (worker, _dir) = interleave_worker().await;
    // The settle seam: a compaction in flight parks the graceful stop at
    // `await_session_work_settled` — AFTER the admission gate closed and
    // the bash abort ran.
    worker.core.lock().unwrap().compacting = true;
    let stopping = {
        let worker = Arc::clone(&worker);
        tokio::spawn(async move { worker.dispatch("shutdown", &json!({})).await })
    };
    // THE SEAM PROBE: the gate is closed (the stop reached its park).
    {
        let core_set = Arc::clone(&worker.core);
        wait_for(move || core_set.lock().unwrap().shutdown_requested).await;
    }
    // THE RACED ADMISSION: a bash dispatched inside the stop.
    let raced = worker
        .dispatch("execute_bash", &json!({ "command": "sleep 30" }))
        .await;
    assert!(
        !raced.success,
        "a bash admitted inside the stop must be refused: {raced:?}"
    );
    assert!(
        raced
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("shutting down"),
        "the refusal names the shutdown gate: {raced:?}"
    );
    assert!(
        !worker.user_bash.is_running(),
        "no bash child may spawn behind the stop's abort"
    );
    // The stop completes once the compaction window ends.
    worker.core.lock().unwrap().compacting = false;
    worker.idle_notify.notify_waiters();
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(15), stopping)
        .await
        .expect("the shutdown settles")
        .expect("the shutdown task joins");
    assert!(stopped.success, "the graceful stop answers: {stopped:?}");
}

/// The round-7 abort pin: a bash admitted BEFORE the gate closed (the
/// pre-window interleave) is aborted by the stop — the settled run reports
/// cancelled, so the worker's exit never leaves the user's process running.
#[tokio::test]
async fn a_bash_admitted_before_the_gate_is_aborted_by_the_stop() {
    let (worker, _dir) = interleave_worker().await;
    let mut events = worker.events.subscribe();
    let started = worker
        .dispatch("execute_bash", &json!({ "command": "sleep 30" }))
        .await;
    assert!(
        started.success,
        "the bash admits before the gate: {started:?}"
    );
    // THE POSITIVE SIGNAL: the bash_start frame proves the child is live.
    wait_for_event(&mut events, "bash_start").await;
    assert!(
        worker.user_bash.is_running(),
        "the probe: the bash child is live before the stop"
    );
    let stopped = worker.dispatch("shutdown", &json!({})).await;
    assert!(stopped.success, "the graceful stop answers: {stopped:?}");
    let ended = wait_for_event(&mut events, "bash_end").await;
    assert_eq!(
        ended.get("cancelled").and_then(Value::as_bool),
        Some(true),
        "the stop must abort the running user bash: {ended}"
    );
    assert!(
        !worker.user_bash.is_running(),
        "the aborted bash releases the slot"
    );
}

// ---------------------------------------------------------------------------
// THE ATTACH/CLOSE TOKEN LIFECYCLE (rounds 8/9): both orders pinned.
// ---------------------------------------------------------------------------

/// The round-8 order the harness re-found: the connection's close beats the
/// detached attach handler's registration — the token is dead, and the late
/// handler must not recreate an unowned hold (the round-8 belt closed the
/// REGISTRY entry; the core retain was still ungated, so the id leaked in
/// `attached_client_ids` with no registry entry to release it — the idle
/// gate disabled forever. The retain now rides the registration's
/// verdict).
#[tokio::test]
async fn the_close_beats_the_late_attach_registration() {
    let (worker, _dir) = interleave_worker().await;
    // THE CLOSE: the attach guard's Drop ran first (the connection's EOF
    // beat the detached handler).
    worker.release_session_attachments("late-conn", true);
    assert!(
        worker
            .released_attach_tokens
            .lock()
            .unwrap()
            .contains("late-conn"),
        "the probe: the token is dead before the late registration"
    );
    // THE LATE REGISTRATION: the detached attach handler runs now, on the
    // dead connection's token.
    let response = worker.handle_attach(&json!({
        "clientId": "late-client",
        "connectionToken": "late-conn",
    }));
    assert!(
        response.success,
        "the attach itself still answers: {response:?}"
    );
    assert!(
        !worker
            .core
            .lock()
            .unwrap()
            .attached_client_ids
            .iter()
            .any(|id| id.as_str() == "late-client"),
        "the late registration must not recreate the unowned core hold"
    );
    assert!(
        worker
            .session_attachments
            .lock()
            .unwrap()
            .get("late-conn")
            .is_none(),
        "the dead token's registry entry stays empty"
    );
}

/// The routed attach (no connection token — the supervisor's shape):
/// its core retain stands — its release rides the routed detach, so the
/// token-gated verdict must not hold it.
#[tokio::test]
async fn a_routed_attach_without_a_token_keeps_the_core_retain() {
    let (worker, _dir) = interleave_worker().await;
    let response = worker.handle_attach(&json!({ "clientId": "supervisor-routed" }));
    assert!(response.success, "the routed attach answers: {response:?}");
    assert!(
        worker
            .core
            .lock()
            .unwrap()
            .attached_client_ids
            .iter()
            .any(|id| id.as_str() == "supervisor-routed"),
        "the supervisor-routed attach keeps its core retain"
    );
}

/// The opposite order (green at the base): the registration beats the
/// close — the live connection's attach registers, and the close releases
/// both the registry entry and the core hold.
#[tokio::test]
async fn the_registration_beats_the_close_and_the_release_frees_the_hold() {
    let (worker, _dir) = interleave_worker().await;
    let response = worker.handle_attach(&json!({
        "clientId": "client-1",
        "connectionToken": "conn-1",
    }));
    assert!(response.success, "the live attach answers: {response:?}");
    assert!(
        worker
            .core
            .lock()
            .unwrap()
            .attached_client_ids
            .iter()
            .any(|id| id.as_str() == "client-1"),
        "the live attach retains the core hold"
    );
    worker.release_session_attachments("conn-1", true);
    assert!(
        worker.core.lock().unwrap().attached_client_ids.is_empty(),
        "the close frees the core hold"
    );
    assert!(
        worker
            .session_attachments
            .lock()
            .unwrap()
            .get("conn-1")
            .is_none(),
        "the close frees the registry entry"
    );
    assert!(
        worker
            .released_attach_tokens
            .lock()
            .unwrap()
            .contains("conn-1"),
        "the close marks the token dead"
    );
}

/// The round-9 non-final corner: the explicit detach is NOT final — the
/// connection lives on, so the token stays live, a later re-attach on the
/// same connection re-registers, and the eventual close releases it (no
/// leak either way).
#[tokio::test]
async fn the_detach_is_not_final_the_reattach_registers_and_the_close_releases() {
    let (worker, _dir) = interleave_worker().await;
    let attach = worker.handle_attach(&json!({
        "clientId": "client-1",
        "connectionToken": "conn-1",
    }));
    assert!(attach.success, "the first attach answers: {attach:?}");
    // The explicit detach (NOT final — the connection lives on).
    worker.release_session_attachments("conn-1", false);
    assert!(
        !worker
            .released_attach_tokens
            .lock()
            .unwrap()
            .contains("conn-1"),
        "the probe: the detach leaves the token live"
    );
    // The re-attach on the same connection re-registers.
    let again = worker.handle_attach(&json!({
        "clientId": "client-1",
        "connectionToken": "conn-1",
    }));
    assert!(again.success, "the re-attach answers: {again:?}");
    assert!(
        worker
            .session_attachments
            .lock()
            .unwrap()
            .get("conn-1")
            .is_some_and(|ids| ids.iter().any(|id| id == "client-1")),
        "the re-attach re-registers on the live token"
    );
    // The eventual close releases everything (the re-attach leak corner).
    worker.release_session_attachments("conn-1", true);
    assert!(
        worker.core.lock().unwrap().attached_client_ids.is_empty(),
        "the close after the re-attach still frees the core hold"
    );
}

/// The shared-client-id reconnect shape (the round-6/9 sibling holds): the
/// id leaves the core only when the LAST live connection holding it goes.
#[tokio::test]
async fn a_shared_client_id_survives_one_connection_close_while_the_other_holds() {
    let (worker, _dir) = interleave_worker().await;
    let first = worker.handle_attach(&json!({
        "clientId": "shared-client",
        "connectionToken": "conn-a",
    }));
    let second = worker.handle_attach(&json!({
        "clientId": "shared-client",
        "connectionToken": "conn-b",
    }));
    assert!(first.success && second.success, "both attaches answer");
    worker.release_session_attachments("conn-a", true);
    assert!(
        worker
            .core
            .lock()
            .unwrap()
            .attached_client_ids
            .iter()
            .any(|id| id.as_str() == "shared-client"),
        "the shared id survives one connection's close"
    );
    worker.release_session_attachments("conn-b", true);
    assert!(
        worker.core.lock().unwrap().attached_client_ids.is_empty(),
        "the last holder's close frees the shared id"
    );
}

/// The round-9 overflow belt: the released-token set caps at 8192 with the
/// clear-on-overflow arm — a long-lived worker cannot grow it unbounded —
/// and the clear runs BEFORE the insert, so the overflowing release still
/// rejects its own late registration.
#[tokio::test]
async fn the_released_token_set_caps_at_8192() {
    let (worker, _dir) = interleave_worker().await;
    for index in 0..8193 {
        worker.release_session_attachments(&format!("cap-{index}"), true);
    }
    let len = worker.released_attach_tokens.lock().unwrap().len();
    assert!(
        len <= 8192,
        "the released-token set must cap on overflow (len {len})"
    );
    assert!(
        worker
            .released_attach_tokens
            .lock()
            .unwrap()
            .contains("cap-8192"),
        "the overflowing release must survive the clear"
    );
    assert!(
        !worker.register_session_attach("cap-8192", "late-client"),
        "a late registration on the overflowing token is rejected"
    );
}
