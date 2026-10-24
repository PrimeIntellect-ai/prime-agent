//! The `rlm.watch.agent` registry pins (the TS `agent-watch.test.ts`
//! regression intent): per-child baselines, range/status-only events, the
//! two caps, idempotent cancel with published events kept readable,
//! owner teardown, and one coalesced wake row per poll batch.
//! The settle watcher's pins live in `watch_tests.rs` (naming rule: the
//! subscription constants are `AGENT_WATCH_*`/`WATCH_SUB_*`, never the
//! bare `WATCH_*` settle names).

use super::*;
use crate::protocol::{response_failure, response_success};
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::agent_watch::{
    AgentWatchRegisterError, AgentWatchRegistry, AGENT_WATCH_MAX_ACTIVE, AGENT_WATCH_MAX_TOTAL,
};

/// The fake child state the scripted supervisor reports: the
/// `messageCount` per active session id (a test advances it) and the
/// `isStreaming` flag. `blocked` ids model a dead link (`get_state`
/// never answers); past `serve_limit` served requests, a child's
/// `get_state` waits for [`Self::release`] so a test can park the poller
/// mid-tick and land two children's growth in ONE batch
/// deterministically.
#[derive(Default)]
struct FakeWatchState {
    counts: std::sync::Mutex<HashMap<String, u64>>,
    streaming: std::sync::Mutex<HashMap<String, bool>>,
    served: std::sync::Mutex<HashMap<String, u32>>,
    /// The first N `get_state` calls per child answer immediately; later
    /// ones wait for [`Self::release`] (0 = ungated).
    serve_limit: std::sync::Mutex<u32>,
    blocked: std::sync::Mutex<std::collections::HashSet<String>>,
    released: std::sync::atomic::AtomicBool,
    release: tokio::sync::Notify,
}

impl FakeWatchState {
    fn count(&self, active_session_id: &str, count: u64) {
        self.counts
            .lock()
            .unwrap()
            .insert(active_session_id.to_string(), count);
    }

    /// Turn on the `get_state` gate (`serve_limit` doubles as the
    /// enabled flag: 0 means ungated).
    fn set_serve_limit(&self, serve_limit: u32) {
        let mut limit = self.serve_limit.lock().unwrap();
        *limit = serve_limit;
    }

    /// Model a dead link: `get_state` for this child never answers.
    fn block(&self, active_session_id: &str) {
        self.blocked
            .lock()
            .unwrap()
            .insert(active_session_id.to_string());
    }

    /// Let every parked `get_state` answer (all later growth observes in
    /// one batch).
    fn release(&self) {
        self.released
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.release.notify_waiters();
    }

    fn serve(&self, active_session_id: &str) -> u32 {
        let mut served = self.served.lock().unwrap();
        let entry = served.entry(active_session_id.to_string()).or_insert(0);
        *entry += 1;
        *entry
    }
}

/// A scripted JSONL supervisor for the watch tests: `create` mints a
/// fresh child identity per call, `get_state` reports the scripted
/// `messageCount` and streaming flag, and `follow_up` (the wake-row
/// delivery lane) is captured.
async fn spawn_watch_supervisor(
    socket: std::path::PathBuf,
    follow_up_tx: mpsc::UnboundedSender<Value>,
    state: Arc<FakeWatchState>,
) {
    let listener = bind_transport(&socket).await.unwrap();
    let created = Arc::new(AtomicU64::new(0));
    tokio::spawn(async move {
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let state = Arc::clone(&state);
            let follow_up_tx = follow_up_tx.clone();
            let created = Arc::clone(&created);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.split();
                let mut reader = BufReader::new(reader);
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .await
                    .unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap() == 0 {
                        return;
                    }
                    let value: Value = serde_json::from_str(line.trim()).unwrap();
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    let command = value["command"].clone();
                    let command_type: &str = command["type"].as_str().unwrap_or_default();
                    let response = match command_type {
                        "create" => {
                            let n = created.fetch_add(1, Ordering::SeqCst) + 1;
                            response_success(
                                Some(&id),
                                command_type,
                                Some(json!({
                                    "activeSessionId": format!("watch-live-{n}"),
                                    "sessionId": format!("watch-file-{n}"),
                                    "sessionFile": format!("/tmp/pa-watch-fake-{n}.jsonl"),
                                    "sessionName": format!("watch-worker-{n}"),
                                })),
                            )
                        }
                        "get_state" => {
                            let active = command["activeSessionId"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string();
                            if state.blocked.lock().unwrap().contains(&active) {
                                // A dead link: the connection never
                                // answers (the poller's snapshot
                                // timeout is the only bound).
                                std::future::pending::<()>().await;
                            }
                            let serve_limit = *state.serve_limit.lock().unwrap();
                            if serve_limit > 0
                                && state.serve(&active) > serve_limit
                                && !state.released.load(std::sync::atomic::Ordering::SeqCst)
                            {
                                let notified = state.release.notified();
                                if !state.released.load(std::sync::atomic::Ordering::SeqCst) {
                                    notified.await;
                                }
                            }
                            let count = state
                                .counts
                                .lock()
                                .unwrap()
                                .get(&active)
                                .copied()
                                .unwrap_or(0);
                            let streaming = state
                                .streaming
                                .lock()
                                .unwrap()
                                .get(&active)
                                .copied()
                                .unwrap_or(false);
                            response_success(
                                Some(&id),
                                command_type,
                                Some(json!({
                                    "isStreaming": streaming,
                                    "hasRunningSubagents": false,
                                    "sessionActions": { "queuedCount": 0 },
                                    "messageCount": count,
                                })),
                            )
                        }
                        "follow_up" => {
                            let _ = follow_up_tx.send(command.clone());
                            response_success(
                                Some(&id),
                                command_type,
                                Some(json!({ "queued": true })),
                            )
                        }
                        "prompt" | "wait_for_idle" | "kill" => {
                            response_success(Some(&id), command_type, None)
                        }
                        "get_last_assistant_text" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({ "text": "the child final answer" })),
                        ),
                        other => response_failure(Some(&id), other, "unexpected command", None),
                    };
                    let mut line = serde_json::to_string(&response).unwrap();
                    line.push('\n');
                    if writer.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}

/// Registry-backed sessions against the scripted supervisor.
async fn watch_sessions(
    follow_up_tx: mpsc::UnboundedSender<Value>,
    state: Arc<FakeWatchState>,
) -> SupervisorChildSessions {
    let socket = std::env::temp_dir().join(format!(
        "pa-aw-{}.sock",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    spawn_watch_supervisor(socket.clone(), follow_up_tx, state).await;
    let link = Arc::new(crate::supervisor_link::SupervisorLink::new(socket));
    let sessions = SupervisorChildSessions::new(
        link,
        std::env::temp_dir(),
        "parent-live".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::env::temp_dir(),
            /*telemetry_disabled*/ true,
        )),
        String::new(),
    );
    sessions.set_identity(ParentIdentity {
        model: Some("mock/mock-1".to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        ..ParentIdentity::with_default_depth()
    });
    sessions
}

/// A test-knob registry session pair with a shortened poll cadence.
async fn quick_watch_sessions() -> (
    SupervisorChildSessions,
    mpsc::UnboundedReceiver<Value>,
    Arc<FakeWatchState>,
) {
    let (follow_up_tx, follow_up_rx) = mpsc::unbounded_channel();
    let state = Arc::new(FakeWatchState::default());
    let sessions = watch_sessions(follow_up_tx, Arc::clone(&state)).await;
    sessions
        .inner
        .agent_watch
        .lock()
        .await
        .set_poll_interval_ms(10);
    (sessions, follow_up_rx, state)
}

/// One pushed registry child (the `push_test_child` seam): no spawn, no
/// settle watcher — only the roster row a watch resolves against.
async fn push_child(sessions: &SupervisorChildSessions, child_id: &str, active: &str) {
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: child_id.to_string(),
            active_session_id: active.to_string(),
            session_id: Some(format!("{active}-file")),
            session_name: format!("{child_id}-worker"),
        })
        .await;
}

/// TS `agent-watch.test.ts`, the core pin: the baseline emits nothing;
/// growth 3..7 emits one range event with the status transition; a
/// repeat tick with no growth emits nothing. **Mutation check:** delete
/// the quiet guard (`count == baseline && status == last`) and the
/// repeat tick emits, failing this test.
#[test]
fn agent_watch_registry_emits_ranges_and_status_only() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "researcher", Some((3, "idle")), 1_000, true)
        .expect("register the watched child");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    // The baseline tick: no growth, no status change — nothing.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((3, "idle")), 1_500)
        .is_none());
    // Growth 3->7 with idle->running: one event with the range and the
    // transition.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "running")), 2_000)
        .expect("growth emits one event");
    assert_eq!(event.kind, "watch.agent");
    assert_eq!(event.content.target, "sub-1");
    assert_eq!(event.content.start, 3);
    assert_eq!(event.content.end, 7);
    assert_eq!(
        event
            .content
            .status
            .as_ref()
            .map(|change| (change.from, change.to)),
        Some(("idle", "running"))
    );
    let event = registry.push_event(event);
    assert_eq!(event.seq, 1);
    // A repeat tick with no growth and no change: quiet.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "running")), 2_500)
        .is_none());
    // A status transition alone (no growth) still reports.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "idle")), 3_000)
        .expect("a status transition emits");
    assert_eq!(event.content.start, 7);
    assert_eq!(event.content.end, 7);
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "idle")), 3_500)
        .is_none());
    // Content is unreachable by construction: the snapshot is a count
    // and a label, never transcript text.
}

/// The two caps: the 65th active register refuses with `active`; the
/// 1025th monotonic registration refuses with `total`. Cancels never
/// refund the total (TS `totalRegistered`). **Mutation check:** remove
/// either bound and this test fails.
#[test]
fn agent_watch_enforces_active_and_total_limits() {
    let mut registry = AgentWatchRegistry::default();
    for index in 0..AGENT_WATCH_MAX_ACTIVE {
        let child = format!("sub-{index}");
        registry
            .register(
                &child,
                "worker",
                Some((0, "idle")),
                1_000 + index as u64,
                true,
            )
            .unwrap_or_else(|_| panic!("register {index} must fit the active cap"));
    }
    let error = registry
        .register("sub-overflow", "worker", Some((0, "idle")), 2_000, true)
        .expect_err("the 65th active register must refuse");
    assert_eq!(error, AgentWatchRegisterError::ActiveLimit);
    assert_eq!(
        error.message(),
        "Agent watch limit reached (64 active)",
        "the TS refusal text"
    );
    // Cancels free the ACTIVE slot but never refund the total: the
    // monotonic cap is reachable with zero live subscriptions.
    for index in 0..AGENT_WATCH_MAX_ACTIVE {
        assert!(registry.cancel(&format!("watch-agent-sub-{index}")));
    }
    let mut registered = AGENT_WATCH_MAX_ACTIVE as u64;
    while registered < AGENT_WATCH_MAX_TOTAL {
        let child = format!("sub-r{registered}");
        registry
            .register(&child, "worker", Some((0, "idle")), 3_000, true)
            .unwrap_or_else(|_| panic!("the total cap must not fire at {registered}"));
        assert!(registry.cancel(&format!("watch-agent-{child}")));
        registered += 1;
    }
    let error = registry
        .register(
            "sub-total-overflow",
            "worker",
            Some((0, "idle")),
            4_000,
            true,
        )
        .expect_err("the 1025th registration must refuse");
    assert_eq!(error, AgentWatchRegisterError::TotalLimit);
    assert_eq!(error.message(), "Agent watch total limit reached (1024)");
}

/// A register against an unknown target is a hard error, never an empty
/// watch (the TS `/No direct child/` pin).
#[tokio::test]
async fn agent_watch_register_rejects_unknown_child() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let state = Arc::new(FakeWatchState::default());
    let sessions = watch_sessions(tx, state).await;
    let error = sessions
        .watch_agent("ghost".to_string(), true)
        .await
        .expect_err("an unmatched target is a hard error");
    assert_eq!(error.to_string(), "No direct child matches \"ghost\"");
}

/// The register-time baseline snapshot is bounded by the registry's
/// snapshot timeout, not the 30s `STATE_TIMEOUT_MS`: a dead link must
/// not park the kernel's `rlm.watch.agent` call (a wait-only entry
/// state does that snapshot inside `run()`). **Mutation check:** drop
/// the timeout wrap and the register blocks on the blocked `get_state`
/// for the full `STATE_TIMEOUT_MS`, failing the elapsed bound.
#[tokio::test]
async fn agent_watch_register_snapshots_a_dead_link_within_the_bounded_slice() {
    let (sessions, _follow_up_rx, state) = quick_watch_sessions().await;
    sessions
        .inner
        .agent_watch
        .lock()
        .await
        .set_snapshot_timeout_ms(50);
    push_child(&sessions, "sub-dead", "live-dead").await;
    state.block("live-dead");
    let started = std::time::Instant::now();
    let watch = sessions
        .watch_agent("sub-dead".to_string(), true)
        .await
        .expect("a blocked child registers baseline-less inside the slice");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the register must not wait the 30s STATE_TIMEOUT_MS on a dead link"
    );
    assert_eq!(watch.status, "active");
    assert_eq!(watch.messages, 0);
}

/// Cancel is idempotent (`false` the second time) and published events
/// stay readable after the cancel (nano-rlm: "published inbox events
/// stay readable").
#[test]
fn agent_watch_cancel_is_idempotent_and_keeps_published_events() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "researcher", Some((3, "idle")), 1_000, true)
        .expect("register");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((3, "idle")), 1_100)
        .is_none());
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "running")), 1_200)
        .expect("growth");
    registry.push_event(event);
    let before = registry.read(0, 100);
    assert_eq!(before.events.len(), 1);
    assert!(registry.cancel("watch-agent-sub-1"));
    assert!(
        !registry.cancel("watch-agent-sub-1"),
        "the second cancel is false"
    );
    assert!(
        !registry.cancel("watch-agent-unknown"),
        "an unknown id is false"
    );
    let after = registry.read(0, 100);
    assert_eq!(
        after.events.len(),
        1,
        "published events stay readable after the cancel"
    );
    // A cancelled subscription stops emitting.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((9, "running")), 1_300)
        .is_none());
}

/// A register against an already-busy child baselines the observed
/// activity label too: the first poll of a running child is quiet, not
/// a fabricated `idle -> running` event (a factory wait on a live child
/// would otherwise fire with no new messages). **Mutation check:**
/// hardcoding the baseline label back to `idle` fails this test.
#[test]
fn agent_watch_register_baselines_the_activity_label() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((3, "running")), 1_000, true)
        .expect("register a running child");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    // The same running snapshot: no transition, no growth — quiet.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((3, "running")), 1_100)
        .is_none());
    // Growth still reports; the transition from running to idle is a
    // real change, emitted with the range.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((5, "idle")), 1_200)
        .expect("growth emits");
    assert_eq!(event.content.start, 3);
    assert_eq!(event.content.end, 5);
    assert_eq!(
        event
            .content
            .status
            .as_ref()
            .map(|change| (change.from, change.to)),
        Some(("running", "idle"))
    );
}

/// A full page never advances the cursor past unread events: the cursor
/// is the last event examined, and a later page returns the rest. A
/// partial page resumes at the ring's tail. **Mutation check:** always
/// answering the ring tail fails this test (the second page is empty).
#[test]
fn agent_watch_read_pages_a_full_page_without_skipping() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((0, "idle")), 1_000, true)
        .expect("register");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    for count in 1..=60 {
        if let Some(event) =
            registry.apply_snapshot("watch-agent-sub-1", epoch, &Ok((count, "idle")), count)
        {
            registry.push_event(event);
        }
    }
    let first = registry.read(0, 50);
    assert_eq!(first.events.len(), 50);
    assert_eq!(first.next_seq, 50, "the cursor is the last event read");
    let second = registry.read(first.next_seq, 50);
    assert_eq!(
        second.events.len(),
        10,
        "the remaining ten events are readable, not skipped"
    );
    assert_eq!(second.events[0].seq, 51);
    assert_eq!(second.next_seq, 60);
    // A partial page: every event past the cursor is in hand, so the
    // resume point is the ring's tail.
    let drain = registry.read(0, 500);
    assert_eq!(drain.events.len(), 60);
    assert_eq!(drain.next_seq, 60);
}

/// A re-register of a live subscription is the TS cancel-then-register
/// re-baseline: it stays inside the active cap without burning the
/// monotonic total, and it re-arms the baseline.
/// **Mutation check:** charging the caps before the overwrite fails
/// this test (the 64-cap refusal, and the burned total).
#[test]
fn agent_watch_rebaseline_at_the_active_cap_burns_nothing() {
    let mut registry = AgentWatchRegistry::default();
    for index in 0..AGENT_WATCH_MAX_ACTIVE {
        registry
            .register(
                &format!("sub-{index}"),
                "worker",
                Some((0, "idle")),
                1_000,
                true,
            )
            .unwrap_or_else(|_| panic!("register {index} must fit the active cap"));
    }
    for _ in 0..100 {
        // At the cap, re-registering an already-watched child is a
        // re-baseline, not a refused or a burnt registration.
        let row = registry
            .register("sub-0", "worker", Some((9, "idle")), 2_000, true)
            .expect("a re-baseline at the cap");
        assert_eq!(row.id, "watch-agent-sub-0");
        assert_eq!(row.messages, 9);
    }
    // The total did not burn: the fresh-child cap still has its full
    // 1024 - 64 budget (free the active slots first).
    for index in 0..AGENT_WATCH_MAX_ACTIVE {
        assert!(registry.cancel(&format!("watch-agent-sub-{index}")));
    }
    let mut fresh = 0;
    while fresh < AGENT_WATCH_MAX_TOTAL - AGENT_WATCH_MAX_ACTIVE as u64 {
        registry
            .register(
                &format!("sub-fresh-{fresh}"),
                "worker",
                Some((0, "idle")),
                3_000,
                true,
            )
            .unwrap_or_else(|_| panic!("the total cap must not fire at {fresh}"));
        registry.cancel(&format!("watch-agent-sub-fresh-{fresh}"));
        fresh += 1;
    }
    registry
        .register("sub-over-total", "worker", Some((0, "idle")), 4_000, true)
        .expect_err("the monotonic total cap still refuses a new child");
}

/// A poll observation taken before a re-baseline is discarded. The
/// harmful shape is a child restart: the re-register re-arms the
/// baseline at the fresh session's low count while a pre-restart poll
/// observation still carries the old high count — applying it would
/// emit a premature growth event AND move the replacement baseline
/// backward, so the next tick replays a backwards range. **Mutation
/// check:** removing the epoch check fails this test (the stale
/// observation emits `3..7`).
#[test]
fn agent_watch_stale_observations_after_a_rebaseline_are_discarded() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((7, "idle")), 1_000, true)
        .expect("register");
    let stale_epoch = registry.subscription_epoch("watch-agent-sub-1");
    // The child restarts (its message count resets); a re-register
    // re-baselines at the fresh low count before the poll's
    // pre-restart observation lands.
    registry
        .register("sub-1", "worker", Some((3, "idle")), 1_100, true)
        .expect("re-baseline");
    let fresh_epoch = registry.subscription_epoch("watch-agent-sub-1");
    assert_ne!(stale_epoch, fresh_epoch);
    let stale_observation = Ok((7_u64, "idle"));
    assert!(
        registry
            .apply_snapshot("watch-agent-sub-1", stale_epoch, &stale_observation, 1_200)
            .is_none(),
        "an observation from before the re-baseline is discarded"
    );
    // The fresh registration still observes normally: 3 -> 5, never a
    // replayed backwards `7..5`.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", fresh_epoch, &Ok((5, "idle")), 1_300)
        .expect("the new epoch observes");
    assert_eq!(event.content.start, 3);
    assert_eq!(event.content.end, 5);
}

/// A re-register without a snapshot (the child's link timed out) keeps
/// the armed baseline: the next poll reports the growth since it, never
/// a quiet re-arm that absorbs it. **Mutation check:** overwrite the
/// baseline with the snapshot-less `None` and the growth tick arms
/// quietly, failing the expect.
#[test]
fn agent_watch_snapshotless_rebaseline_keeps_the_armed_baseline() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((3, "idle")), 1_000, true)
        .expect("register");
    let row = registry
        .register("sub-1", "worker", None, 1_100, true)
        .expect("re-register without a snapshot");
    assert_eq!(row.messages, 3, "the armed baseline survives");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((7, "running")), 1_200)
        .expect("the growth since the baseline reports");
    assert_eq!(event.content.start, 3);
    assert_eq!(event.content.end, 7);
    assert_eq!(
        event
            .content
            .status
            .as_ref()
            .map(|change| (change.from, change.to)),
        Some(("idle", "running"))
    );
}

/// Owner teardown: the close walk cancels every subscription (nano-rlm
/// "owner termination cancels subscriptions") and retires the poller.
#[tokio::test]
async fn agent_watch_owner_teardown_cancels_every_subscription() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let state = Arc::new(FakeWatchState::default());
    let sessions = watch_sessions(tx, state).await;
    push_child(&sessions, "sub-1", "live-1").await;
    push_child(&sessions, "sub-2", "live-2").await;
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register one");
    sessions
        .watch_agent("sub-2".to_string(), true)
        .await
        .expect("register two");
    sessions
        .close_children(ChildCloseReason::Killed)
        .await
        .expect("close the parent session's children");
    let rows = sessions
        .watch_agent_list()
        .await
        .expect("relist after close");
    assert_eq!(rows.len(), 2, "rows stay inspectable after teardown");
    assert!(rows.iter().all(|row| row.status == "cancelled"));
    // A cancelled registry registers nothing new post-teardown — the
    // subscriptions died with the owner.
}

/// One coalesced quiet wake row per poll batch: two children growing in
/// one tick produce ONE `display: false` `agent_watch_notice` row and
/// two ring events; a quiet tick produces no row at all.
#[tokio::test]
async fn agent_watch_one_wake_row_per_batch() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    // The first get_state per child (the register baselines) answers
    // immediately; every later one parks until `release`, so the
    // poller's first tick blocks BEFORE reading any growth and both
    // children's updates land in one batch deterministically (a plain
    // sleep could straddle a tick boundary).
    state.set_serve_limit(1);
    push_child(&sessions, "sub-1", "live-1").await;
    push_child(&sessions, "sub-2", "live-2").await;
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register one");
    sessions
        .watch_agent("sub-2".to_string(), true)
        .await
        .expect("register two");
    // The parked tick has both children's growth staged behind the
    // release; one flip delivers both in the same batch.
    tokio::time::sleep(Duration::from_millis(100)).await;
    state.count("live-1", 5);
    state.count("live-2", 4);
    state.release();
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the batch must deliver one wake row")
        .expect("the follow_up channel stays open");
    assert_eq!(row["type"], "follow_up");
    assert_eq!(row["activeSessionId"], "parent-live");
    let custom = &row["customMessage"];
    assert_eq!(custom["role"], "custom");
    assert_eq!(custom["customType"], "agent_watch_notice");
    assert_eq!(custom["display"], false, "the wake row is quiet");
    assert!(
        row["rlmNoticeNonce"].as_str().is_some(),
        "the reserved-kind row rides the one-shot capability"
    );
    let events = custom["details"]["events"].as_array().unwrap();
    assert_eq!(
        events.len(),
        2,
        "one line per child, one row per batch: {custom:?}"
    );
    let by_child: HashMap<&str, &Value> = events
        .iter()
        .map(|event| (event["childId"].as_str().unwrap(), event))
        .collect();
    assert_eq!(by_child["sub-1"]["fromIndex"], 0);
    assert_eq!(by_child["sub-1"]["toIndex"], 5);
    assert_eq!(by_child["sub-2"]["fromIndex"], 0);
    assert_eq!(by_child["sub-2"]["toIndex"], 4);
    assert!(
        custom["content"]
            .as_str()
            .unwrap()
            .contains("[watch-agent child:sub-1-worker] messages 0..5 (+5)"),
        "the row's text is the batched range lines: {custom:?}"
    );
    // The readable ring carries the same batch as N events.
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.next_seq, 2);
    assert_eq!(page.dropped, 0);
    // A quiet tick (no further growth) emits no row and no events.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv())
            .await
            .is_err(),
        "no second wake row may arrive"
    );
    let still = sessions
        .watch_read(2, 100)
        .await
        .expect("read past the batch");
    assert!(still.events.is_empty());
}

/// A dead child link must not withhold a healthy sibling's event: the
/// tick snapshots concurrently, and one child's unresponsive link is
/// bounded by the snapshot timeout, not by the 30s `STATE_TIMEOUT_MS`
/// (serial, the healthy sibling's event would sit behind the dead
/// link). **Mutation check:** reverting the tick to serial awaits
/// fails this test (the row arrives only after the dead link's full
/// timeout, well past the assertion bound).
#[tokio::test]
async fn agent_watch_a_hanging_child_does_not_withhold_a_healthy_sibling() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    sessions
        .inner
        .agent_watch
        .lock()
        .await
        .set_snapshot_timeout_ms(300);
    push_child(&sessions, "sub-dead", "live-dead").await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .watch_agent("sub-dead".to_string(), true)
        .await
        .expect("register the dead-link child");
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register the healthy child");
    // The healthy child grows while the dead child's get_state never
    // answers; its snapshot future resolves on the 300ms bound.
    state.block("live-dead");
    state.count("live-1", 5);
    let row = tokio::time::timeout(Duration::from_secs(5), follow_up_rx.recv())
        .await
        .expect("the healthy child's event is not withheld by the dead link")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1, "only the healthy child grew: {row:?}");
    assert_eq!(events[0]["childId"], "sub-1");
    assert_eq!(events[0]["toIndex"], 5);
    // The dead child's own subscription is untouched by this batch: its
    // row still lists active (its dead-poll streak only accumulates).
    let rows = sessions.watch_agent_list().await.expect("list");
    let dead = rows
        .iter()
        .find(|row| row.child_id == "sub-dead")
        .expect("the dead child's watch row");
    assert_eq!(dead.status, "active");
}

/// A re-register (the `rlm.rename` re-baseline) refreshes the stored
/// child name: list rows and wake notices must carry the renamed child,
/// not the name the subscription was first armed under. **Mutation
/// check:** skip the `child_name` copy in the re-baseline branch and the
/// row answers the stale pre-rename name.
#[test]
fn agent_watch_rebaseline_refreshes_the_renamed_child_name() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "old-name", Some((3, "idle")), 1_000, true)
        .expect("register under the pre-rename name");
    let row = registry
        .register("sub-1", "renamed-worker", Some((5, "idle")), 2_000, true)
        .expect("re-register after the rename");
    assert_eq!(row.child_id, "sub-1");
    assert_eq!(row.child_name, "renamed-worker");
    let rows = registry.rows();
    assert_eq!(rows[0].child_name, "renamed-worker");
}

/// A compacted child's message count can shrink below the armed
/// baseline: the shrink is a re-baseline (quiet unless the status
/// changed too, then zero-width), never a backwards `start > end` growth
/// range. **Mutation check:** delete the shrink re-arm and the first
/// snapshot here answers the backwards `100..20` event.
#[test]
fn agent_watch_a_shrunk_count_rebases_without_a_backwards_range() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((100, "idle")), 1_000, true)
        .expect("register");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    // The shrink alone: quiet, re-armed at the fresh low count.
    assert!(
        registry
            .apply_snapshot("watch-agent-sub-1", epoch, &Ok((20, "idle")), 1_100)
            .is_none(),
        "a shrink with no status change is quiet"
    );
    // Growth resumes from the re-armed baseline, never `20 < start`.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((25, "idle")), 1_200)
        .expect("growth after the shrink emits");
    assert_eq!(event.content.start, 20);
    assert_eq!(event.content.end, 25);
    // A shrink WITH a status change reports the transition zero-width.
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &Ok((10, "running")), 1_300)
        .expect("the transition still reports");
    assert_eq!(event.content.start, 10);
    assert_eq!(event.content.end, 10);
    assert_eq!(
        event
            .content
            .status
            .as_ref()
            .map(|change| (change.from, change.to)),
        Some(("idle", "running"))
    );
}

/// A sibling whose session NAME equals the watched child's id must not
/// shadow it at registration: the documented selector order is child id
/// first, then name, not first-match. **Mutation check:** first-match
/// resolution (`find_record`) registers the earlier shadow instead.
#[tokio::test]
async fn agent_watch_register_prefers_the_id_over_an_earlier_name_shadow() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let state = Arc::new(FakeWatchState::default());
    let sessions = watch_sessions(tx, state).await;
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: "shadow-id".to_string(),
            active_session_id: "live-shadow".to_string(),
            session_id: Some("live-shadow-file".to_string()),
            session_name: "beta".to_string(),
        })
        .await;
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: "beta".to_string(),
            active_session_id: "live-beta".to_string(),
            session_id: Some("live-beta-file".to_string()),
            session_name: "beta-worker".to_string(),
        })
        .await;
    let registered = sessions
        .watch_agent("beta".to_string(), true)
        .await
        .expect("register the id-matched child");
    assert_eq!(registered.child_id, "beta");
    assert_eq!(registered.child_name, "beta-worker");
}

/// The poller resolves its poll targets by child id only: a name shadow
/// snapshot in place of the watched child (quiet, never growing) would
/// withhold the watched child's growth row. **Mutation check:** resolve
/// the poll through the first-match selector and the shadow's silent
/// snapshot withholds the row past the assertion bound.
#[tokio::test]
async fn agent_watch_poll_snapshots_the_watched_child_not_a_name_shadow() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    state.set_serve_limit(1);
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: "shadow-id".to_string(),
            active_session_id: "live-shadow".to_string(),
            session_id: Some("live-shadow-file".to_string()),
            session_name: "beta".to_string(),
        })
        .await;
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: "beta".to_string(),
            active_session_id: "live-beta".to_string(),
            session_id: Some("live-beta-file".to_string()),
            session_name: "beta-worker".to_string(),
        })
        .await;
    sessions
        .watch_agent("beta".to_string(), true)
        .await
        .expect("register the watched child");
    // The parked tick stages the watched child's growth behind the
    // release; the name shadow never grows.
    tokio::time::sleep(Duration::from_millis(100)).await;
    state.count("live-beta", 5);
    state.release();
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the watched child's growth row arrives")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1, "only the watched child grew: {row:?}");
    assert_eq!(events[0]["childId"], "beta");
    assert_eq!(events[0]["toIndex"], 5);
}

/// The poller's exit decision clears its parked handle under the same
/// lock: a subscribe landing in the window before the task is marked
/// finished must see no live poller and start a fresh one, or its
/// subscription is never polled. **Mutation check:** revert to the bare
/// `return` (no `registry.poll = None`) and the post-exit poll slot
/// still holds the dying task's handle, failing the `poll`-is-cleared
/// assertion.
#[tokio::test]
async fn agent_watch_emptied_poller_clears_its_handle_under_the_lock() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register the watched child");
    assert!(
        sessions.inner.agent_watch.lock().await.has_parked_poller(),
        "the register parked a poller"
    );
    // The last active subscription cancels: the poller's next tick
    // decides to exit and must clear its handle in that decision.
    assert!(sessions
        .watch_agent_cancel("watch-agent-sub-1".to_string())
        .await
        .expect("cancel"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !sessions.inner.agent_watch.lock().await.has_parked_poller(),
        "the emptied poller cleared its handle under the exit lock"
    );
    // A subscribe in the exit window starts a fresh poller and its
    // events flow: the growth row arrives on the new generation.
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("re-register inside the exit window");
    state.count("live-1", 5); // growth past the fresh registration's baseline
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the fresh poller delivers the growth row")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["childId"], "sub-1");
    assert_eq!(events[0]["toIndex"], 5);
}

/// A deleted child ends its subscription with ONE terminal
/// `-> vanished` status event instead of a silent stop: a consumer
/// parked on the feed (a factory wait) learns the target is gone instead
/// of timing out against a dead subscription. **Mutation check:** revert
/// `mark_vanished` to the quiet flip (no event) and the row never
/// arrives, failing the wait bound.
#[tokio::test]
async fn agent_watch_vanished_child_emits_one_terminal_vanished_event() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register the watched child");
    // The child is hand-deleted from the roster mid-watch.
    sessions.drop_test_child("sub-1").await;
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the vanished child delivers one terminal row")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1, "one terminal event: {row:?}");
    assert_eq!(events[0]["childId"], "sub-1");
    assert_eq!(events[0]["fromIndex"], 0);
    assert_eq!(events[0]["toIndex"], 0);
    assert_eq!(events[0]["statusChange"]["to"], "vanished");
    // The terminal event is readable through the ring, and the
    // subscription is Stopped: a poll after the vanish observes nothing.
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        page.events[0].content.status.as_ref().map(|c| c.to),
        Some("vanished")
    );
    let rows = sessions.watch_agent_list().await.expect("list");
    assert_eq!(rows[0].status, "stopped");
    // The registry-level arm answers the same event: a direct
    // mark_vanished on an active row builds one zero-width terminal
    // event (mutation pin at the seam the poller calls).
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-2", "worker", Some((3, "idle")), 1_000, true)
        .expect("register");
    let epoch = registry.subscription_epoch("watch-agent-sub-2");
    let event = registry
        .mark_vanished("watch-agent-sub-2", epoch, 1_500)
        .expect("the vanished row emits one terminal event");
    assert_eq!(event.content.start, 3);
    assert_eq!(event.content.end, 3);
    assert_eq!(
        event
            .content
            .status
            .as_ref()
            .map(|change| (change.from, change.to)),
        Some(("idle", "vanished"))
    );
    // A stale epoch (a re-baseline raced the vanish) stays quiet.
    assert!(
        registry
            .mark_vanished("watch-agent-sub-2", epoch, 1_600)
            .is_none(),
        "the stopped row never re-fires"
    );
    let _ = state;
}

/// A register against a child whose task prompt has not landed (the
/// spawn -> `watch.agent` window) stays unarmed: no fabricated kickoff
/// event, and the baseline arms AT ADMISSION — one bounded snapshot in
/// the admission path (host.rs's spawn watcher, mirrored by the test
/// seam), not at the next poll tick — so a fast child that finishes
/// before the first tick still reports its growth from the admission
/// boundary. **Mutation check:** drop the admission arm and the row
/// still answers `messages == 0` right after admission (the poller's
/// first arming tick cannot complete between the admission flip and the
/// list read, so the boundary assertion fails deterministically).
#[tokio::test]
async fn agent_watch_unadmitted_child_registers_without_a_baseline() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .set_test_child_prompt_admitted("live-1", false)
        .await;
    let registered = sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register the never-prompted child");
    assert_eq!(registered.status, "active");
    assert_eq!(registered.messages, 0, "no baseline was taken");
    // The kickoff prompt lands (count 1) and the child starts working:
    // while unadmitted, the poller observes NOTHING — no fabricated
    // kickoff growth event.
    state.count("live-1", 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv())
            .await
            .is_err(),
        "the unadmitted child's kickoff must not fabricate an event"
    );
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert!(page.events.is_empty());
    // The prompt admits. The admission arm snapshots the boundary (the
    // kickoff row, count 1) immediately: only that first `get_state`
    // answers and every later one parks behind the release, so the
    // arm — not a poller tick — is the only writer of the baseline.
    state.set_serve_limit(1);
    sessions
        .set_test_child_prompt_admitted("live-1", true)
        .await;
    let rows = sessions.watch_agent_list().await.expect("list the row");
    assert_eq!(
        rows[0].messages, 1,
        "the baseline armed at the admission boundary (the kickoff row)"
    );
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert!(
        page.events.is_empty(),
        "the admission arm is quiet, never a fabricated event"
    );
    // A fast child grows past the boundary before the parked tick can
    // observe: the growth reports from the boundary, not absorbed.
    state.count("live-1", 7);
    state.release();
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("post-admission growth reports")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["childId"], "sub-1");
    assert_eq!(events[0]["fromIndex"], 1, "armed at the admission boundary");
    assert_eq!(events[0]["toIndex"], 7);
}

/// An unadmitted register racing the spawn watcher's admission: the
/// admission cannot flip `prompt_admitted` between the register's read
/// and its row insert, so the admission arm always finds the row and
/// arms it at the admission boundary. The register is parked on the
/// registry lock it inserts under; lock fairness then runs its insert
/// before the admission arm's check, so only the flag read can expose
/// the window deterministically (production loses the row when the
/// admission's registry lock wins that race). **Mutation check:** read
/// the flag and insert the row in separate record-lock holds and the
/// admission flips the flag while the register is parked, failing the
/// first assertion.
#[tokio::test]
async fn agent_watch_unadmitted_register_racing_admission_arms_at_the_boundary() {
    let (sessions, _follow_up_rx, state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .set_test_child_prompt_admitted("live-1", false)
        .await;
    let record = sessions
        .inner
        .find_record_ordered("sub-1")
        .await
        .expect("the pushed child");
    let sessions = Arc::new(sessions);
    let registry = sessions.inner.agent_watch.lock().await;
    let register = tokio::spawn({
        let sessions = Arc::clone(&sessions);
        async move { sessions.watch_agent("sub-1".to_string(), true).await }
    });
    tokio::task::yield_now().await;
    // The kickoff row lands and the prompt admits while the register is
    // parked.
    state.count("live-1", 1);
    let admit = tokio::spawn({
        let sessions = Arc::clone(&sessions);
        async move {
            sessions
                .set_test_child_prompt_admitted("live-1", true)
                .await;
        }
    });
    tokio::task::yield_now().await;
    assert!(
        !record.try_lock().is_ok_and(|child| child.prompt_admitted),
        "the admission flipped the flag while the register was between its read and its insert"
    );
    drop(registry);
    register
        .await
        .expect("the register task")
        .expect("register the never-prompted child");
    admit.await.expect("the admission task");
    let rows = sessions.watch_agent_list().await.expect("list the row");
    assert_eq!(rows[0].messages, 1, "armed at the admission boundary");
}

/// A child whose kickoff failed permanently (the spawn watcher killed
/// the worker and `settle_failed` retained the roster row with an error
/// verdict, the prompt never admitted) ends its watch with ONE terminal
/// `-> failed` event instead of the unadmitted skip looping forever: a
/// parked consumer learns the target is dead and the row stops burning
/// an active slot. **Mutation check:** revert the settled check (skip
/// every unadmitted child) and the row never arrives, failing the wait
/// bound.
#[tokio::test]
async fn agent_watch_failed_kickoff_ends_the_watch_with_one_terminal_failed_event() {
    let (sessions, mut follow_up_rx, _state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .set_test_child_prompt_admitted("live-1", false)
        .await;
    sessions
        .watch_agent("sub-1".to_string(), true)
        .await
        .expect("register the never-prompted child");
    // The kickoff fails permanently: the record settles `error` with the
    // prompt never admitted (the `settle_failed` retention shape).
    {
        let children = sessions.inner.children.lock().await;
        for record in children.iter() {
            let mut record = record.lock().await;
            if record.active_session_id == "live-1" {
                record.settled_status = Some("error");
            }
        }
    }
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the failed kickoff delivers one terminal row")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1, "one terminal event: {row:?}");
    assert_eq!(events[0]["childId"], "sub-1");
    assert_eq!(events[0]["fromIndex"], 0);
    assert_eq!(events[0]["toIndex"], 0);
    assert_eq!(events[0]["statusChange"]["to"], "failed");
    // The terminal event is readable through the ring, and the
    // subscription is Stopped: a later poll observes nothing.
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert_eq!(page.events.len(), 1);
    assert_eq!(
        page.events[0].content.status.as_ref().map(|c| c.to),
        Some("failed")
    );
    let rows = sessions.watch_agent_list().await.expect("list");
    assert_eq!(rows[0].status, "stopped");
}

/// The unreachable give-up measures elapsed wall time, never poll
/// strikes: a hung link spends about 10s per failed tick (the 5s
/// cadence plus its own 5s snapshot await), so a 12-strike counter
/// would report near 120s against the documented ~60s bound, and a
/// factory wait (capped at 60s) would never see the terminal event.
/// A reachable poll resets the window: a fresh dead streak needs the
/// full 60s again. **Mutation check:** revert to a strike counter and
/// four failed polls never reach twelve strikes, so the give-up below
/// never fires, failing both expects.
#[test]
fn agent_watch_unreachable_gives_up_on_elapsed_time_not_strike_counts() {
    let mut registry = AgentWatchRegistry::default();
    registry
        .register("sub-1", "worker", Some((3, "idle")), 1_000, true)
        .expect("register");
    let epoch = registry.subscription_epoch("watch-agent-sub-1");
    let dead = Err(anyhow!("dead link"));
    // A first dead streak: quiet until 60s of failed polls elapse.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &dead, 10_000)
        .is_none());
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &dead, 40_000)
        .is_none());
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &dead, 69_999)
        .is_none());
    let event = registry
        .apply_snapshot("watch-agent-sub-1", epoch, &dead, 70_000)
        .expect("the elapsed window ends the subscription");
    assert_eq!(event.content.start, 3, "the baseline is retained");
    assert_eq!(event.content.end, 3);
    assert_eq!(
        event.content.status.as_ref().map(|change| change.to),
        Some("unreachable")
    );
    // The terminal row never re-fires.
    assert!(registry
        .apply_snapshot("watch-agent-sub-1", epoch, &dead, 200_000)
        .is_none());
    // A reachable poll mid-streak resets the window: a fresh dead
    // streak needs the full 60s again.
    registry
        .register("sub-2", "worker", Some((5, "running")), 1_000, true)
        .expect("register the second row");
    let epoch2 = registry.subscription_epoch("watch-agent-sub-2");
    assert!(registry
        .apply_snapshot("watch-agent-sub-2", epoch2, &dead, 10_000)
        .is_none());
    assert!(registry
        .apply_snapshot("watch-agent-sub-2", epoch2, &Ok((5, "running")), 35_000)
        .is_none());
    assert!(registry
        .apply_snapshot("watch-agent-sub-2", epoch2, &dead, 40_000)
        .is_none());
    assert!(registry
        .apply_snapshot("watch-agent-sub-2", epoch2, &dead, 95_999)
        .is_none());
    let event = registry
        .apply_snapshot("watch-agent-sub-2", epoch2, &dead, 100_000)
        .expect("the fresh streak gives up after its own full window");
    assert_eq!(
        event.content.status.as_ref().map(|change| change.to),
        Some("unreachable")
    );
}

/// A `wake: false` subscription (a factory-owned wait) still pages the
/// ring but never delivers the quiet wake row: the factory reads the
/// ring itself, so its events must not spend a parent LLM turn, and a
/// subscription leaked by a kernel restart stays silent.
/// **Mutation check:** drop the `wake` filter in the poll loop and the
/// row arrives, failing the quiet assertion.
#[tokio::test]
async fn agent_watch_non_waking_subscription_grows_the_ring_without_a_wake_row() {
    let (sessions, mut follow_up_rx, state) = quick_watch_sessions().await;
    push_child(&sessions, "sub-1", "live-1").await;
    sessions
        .watch_agent("sub-1".to_string(), false)
        .await
        .expect("register a non-waking watch");
    state.count("live-1", 5);
    // The growth event lands in the ring with no wake row behind it.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv())
            .await
            .is_err(),
        "a non-waking subscription delivers no wake row"
    );
    let page = sessions.watch_read(0, 100).await.expect("read the ring");
    assert_eq!(
        page.events.len(),
        1,
        "the event is readable through the ring"
    );
    assert_eq!(page.events[0].content.end, 5);
    let rows = sessions.watch_agent_list().await.expect("list");
    assert_eq!(rows[0].status, "active");
    // A waking sibling on another child still delivers its own row: the
    // filter is per subscription, not per batch.
    push_child(&sessions, "sub-2", "live-2").await;
    sessions
        .watch_agent("sub-2".to_string(), true)
        .await
        .expect("register a waking watch");
    state.count("live-2", 3);
    let row = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the waking sibling's growth row arrives")
        .expect("the follow_up channel stays open");
    let events = row["customMessage"]["details"]["events"]
        .as_array()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["childId"], "sub-2");
    assert_eq!(events[0]["toIndex"], 3);
}
