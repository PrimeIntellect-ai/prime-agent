//! Tests of the guest daemon's idle self-pause.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_core::cron::store::{
    AgentCronJobStore, CreateAgentCronJobInput, RlmHeartbeatStatusUpdate, RlmHeartbeatUpdate,
};
use serde_json::json;

use super::TICK_MS;
use super::{heartbeat_due_soon, self_pause_loop, SelfPauseConfig, DEFAULT_IDLE_MINUTES, TICK};
use crate::supervisor::{Supervisor, SupervisorOptions};

fn write_config(dir: &std::path::Path, value: &serde_json::Value) -> PathBuf {
    let path = dir.join("bot-self-pause.json");
    std::fs::write(&path, value.to_string()).unwrap();
    path
}

fn config_value(minutes: u64) -> serde_json::Value {
    json!({
        "botId": "bot-1",
        "sandboxId": "sbx-1",
        "relayUrl": "https://relay.example",
        "pauseUrl": "https://relay.example/api/bots/bot-1/pause",
        "idleMinutes": minutes,
    })
}

#[test]
fn a_full_configuration_parses() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(7));
    assert_eq!(
        SelfPauseConfig::load_from(&path).unwrap(),
        SelfPauseConfig {
            bot_id: "bot-1".to_string(),
            sandbox_id: "sbx-1".to_string(),
            relay_url: "https://relay.example".to_string(),
            pause_url: "https://relay.example/api/bots/bot-1/pause".to_string(),
            idle_minutes: 7,
        }
    );
}

#[test]
fn a_missing_idle_window_falls_back_to_the_default() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        dir.path(),
        &json!({"botId": "bot-1", "sandboxId": "sbx-1", "pauseUrl": "https://r.example/p"}),
    );
    assert_eq!(
        SelfPauseConfig::load_from(&path).unwrap().idle_minutes,
        DEFAULT_IDLE_MINUTES
    );
}

#[test]
fn an_unparsable_or_missing_file_is_none() {
    let dir = tempfile::tempdir().unwrap();
    assert!(SelfPauseConfig::load_from(&dir.path().join("missing.json")).is_none());
    let path = write_config(dir.path(), &json!({"botId": "bot-1"}));
    assert!(SelfPauseConfig::load_from(&path).is_none());
}

/// Drive the loop until `attempts` pause attempts ran (or a simulated
/// `deadline`), and return the configs the attempts carried.
async fn run_loop(
    path: PathBuf,
    busy: Arc<AtomicBool>,
    lines: Arc<AtomicU64>,
    fail: bool,
    synced: bool,
    attempts: usize,
    deadline: Duration,
) -> Vec<SelfPauseConfig> {
    let requests: Arc<Mutex<Vec<SelfPauseConfig>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::new(AtomicUsize::new(0));
    let (notify, mut waited) = tokio::sync::mpsc::channel::<()>(1);
    let task = {
        let (requests, seen, notify) = (Arc::clone(&requests), Arc::clone(&seen), notify);
        tokio::spawn(async move {
            let request = |config: SelfPauseConfig| {
                let (requests, seen) = (Arc::clone(&requests), Arc::clone(&seen));
                let notify = notify.clone();
                async move {
                    requests.lock().unwrap().push(config);
                    if seen.fetch_add(1, Ordering::SeqCst) + 1 == attempts {
                        let _ = notify.send(()).await;
                    }
                    if fail {
                        anyhow::bail!("the relay answered 500");
                    }
                    Ok(())
                }
            };
            let busy = move || busy.load(Ordering::SeqCst);
            let lines = move || lines.load(Ordering::Relaxed);
            let wall = || 0;
            let before_pause = move || std::future::ready(synced);
            self_pause_loop(path, busy, lines, wall, before_pause, request).await;
        })
    };
    let _ = tokio::time::timeout(deadline, waited.recv()).await;
    task.abort();
    let requests = requests.lock().unwrap().clone();
    requests
}

/// Long enough in simulated time for a 1-minute window to fire twice.
const LONG: Duration = Duration::from_mins(10);

#[tokio::test(start_paused = true)]
async fn an_idle_daemon_requests_its_pause_once_per_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    // Two attempts prove the window re-arms rather than firing per tick.
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        false,
        true,
        2,
        LONG,
    )
    .await;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].sandbox_id, "sbx-1");
}

#[tokio::test(start_paused = true)]
async fn a_busy_daemon_never_requests_its_pause() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicU64::new(0)),
        false,
        true,
        2,
        LONG,
    )
    .await;
    assert!(requests.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_failed_pre_pause_sync_skips_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        false,
        false,
        1,
        LONG,
    )
    .await;
    assert!(requests.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_failed_request_re_arms_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        true,
        true,
        2,
        LONG,
    )
    .await;
    assert_eq!(requests.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn client_activity_holds_off_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    // A client line every tick: the loop never reaches the window.
    let lines = Arc::new(AtomicU64::new(0));
    let pacer = {
        let lines = Arc::clone(&lines);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                lines.fetch_add(1, Ordering::Relaxed);
            }
        })
    };
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::clone(&lines),
        false,
        true,
        2,
        LONG,
    )
    .await;
    pacer.abort();
    assert!(requests.is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_empty_pause_url_disables_the_loop() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        dir.path(),
        &json!({"botId": "bot-1", "sandboxId": "sbx-1", "pauseUrl": "", "idleMinutes": 1}),
    );
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        false,
        true,
        2,
        LONG,
    )
    .await;
    assert!(requests.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_zero_idle_window_disables_the_loop() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(0));
    let requests = run_loop(
        path,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(0)),
        false,
        true,
        2,
        LONG,
    )
    .await;
    assert!(requests.is_empty());
}

#[test]
fn a_running_session_summary_is_busy() {
    for flag in [
        "isStreaming",
        "isCompacting",
        "isBashRunning",
        "isRunningTools",
        "hasRunningSubagents",
        "hasRunningRlmChildren",
        "hasBackgroundKernelWork",
    ] {
        assert!(super::summary_busy(&json!({ flag: true })), "{flag}");
    }
    assert!(!super::summary_busy(&json!({"isStreaming": false})));
    assert!(!super::summary_busy(&json!({})));
}

/// One roster row the supervisor's self-pause reads: the shape a resident
/// worker's summary push writes, with the new busy flags flipped on.
#[test]
fn background_kernel_work_and_factory_runs_hold_off_the_self_pause() {
    let dir = tempfile::tempdir().unwrap();
    let supervisor = Supervisor::new(SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    })
    .expect("supervisor");
    let mut summary = json!({
        "sessionId": "s1",
        "activeSessionId": "a1",
        "sessionFile": dir.path().join("s1.jsonl"),
        "activity": "idle",
    });
    supervisor
        .roster
        .lock()
        .unwrap()
        .write_seeded(summary.clone(), false);
    assert!(!supervisor.self_pause_active());
    summary["hasBackgroundKernelWork"] = json!(true);
    supervisor
        .roster
        .lock()
        .unwrap()
        .write_seeded(summary.clone(), false);
    assert!(supervisor.self_pause_active());
    // Once the background work and the run finish, the pause may proceed.
    summary["hasBackgroundKernelWork"] = json!(false);
    supervisor
        .roster
        .lock()
        .unwrap()
        .write_seeded(summary.clone(), false);
    assert!(!supervisor.self_pause_active());
}

/// Spawn the loop with a wall clock that advances one tick per call, a
/// shared client-line counter, and a log of the sync/pause order.
fn spawn_test_loop(
    path: PathBuf,
    wall: Arc<AtomicU64>,
    lines: Arc<AtomicU64>,
    events: Arc<Mutex<Vec<&'static str>>>,
    requests: Arc<AtomicUsize>,
    bump_lines_on_first_sync: bool,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let busy = || false;
        let lines_now = {
            let lines = Arc::clone(&lines);
            move || lines.load(Ordering::Relaxed)
        };
        let wall = move || wall.fetch_add(TICK_MS, Ordering::Relaxed);
        let bumped = Arc::new(AtomicBool::new(false));
        let before_pause = {
            let events = Arc::clone(&events);
            let lines = Arc::clone(&lines);
            let bumped = Arc::clone(&bumped);
            move || {
                let events = Arc::clone(&events);
                let lines = Arc::clone(&lines);
                let bumped = Arc::clone(&bumped);
                async move {
                    events.lock().unwrap().push("sync");
                    if bump_lines_on_first_sync && !bumped.swap(true, Ordering::SeqCst) {
                        lines.fetch_add(1, Ordering::Relaxed);
                    }
                    true
                }
            }
        };
        let request = {
            let events = Arc::clone(&events);
            let requests = Arc::clone(&requests);
            move |_config| {
                let events = Arc::clone(&events);
                let requests = Arc::clone(&requests);
                async move {
                    events.lock().unwrap().push("pause");
                    requests.fetch_add(1, Ordering::SeqCst);
                    Ok::<(), anyhow::Error>(())
                }
            }
        };
        self_pause_loop(path, busy, lines_now, wall, before_pause, request).await;
    })
}

/// A VM resume moves the wall clock far past the last tick. The loop must
/// start a fresh idle window, not pause before the due heartbeat runs.
#[tokio::test(start_paused = true)]
async fn a_wall_clock_jump_starts_a_fresh_idle_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let wall = Arc::new(AtomicU64::new(1_000_000));
    let events = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(AtomicUsize::new(0));
    let lines = Arc::new(AtomicU64::new(0));
    let task = spawn_test_loop(
        path,
        Arc::clone(&wall),
        Arc::clone(&lines),
        Arc::clone(&events),
        Arc::clone(&requests),
        false,
    );
    // Let the loop read its first wall clock before the test advances time.
    tokio::task::yield_now().await;
    // Tick 1: 30 s of idle, no pause.
    tokio::time::advance(TICK).await;
    tokio::task::yield_now().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    // The VM froze for two minutes: the next tick sees a wall-clock jump
    // and starts a fresh idle window instead of pausing.
    wall.fetch_add(120_000, Ordering::SeqCst);
    tokio::time::advance(TICK).await;
    tokio::task::yield_now().await;
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "the jump reset the window"
    );
    // One full window after the reset.
    tokio::time::advance(TICK).await;
    tokio::task::yield_now().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    tokio::time::advance(TICK).await;
    tokio::task::yield_now().await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    task.abort();
    let events = events.lock().unwrap();
    assert_eq!(events.first(), Some(&"sync"));
    assert_eq!(events.get(1), Some(&"pause"));
}

/// The relay mirror must run before the pause request: a heartbeat fire
/// just before the pause leaves a stale next run time otherwise.
#[tokio::test(start_paused = true)]
async fn a_pre_pause_sync_runs_before_the_pause_request() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let wall = Arc::new(AtomicU64::new(1_000_000));
    let events = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(AtomicUsize::new(0));
    let lines = Arc::new(AtomicU64::new(0));
    let task = spawn_test_loop(
        path,
        Arc::clone(&wall),
        Arc::clone(&lines),
        Arc::clone(&events),
        Arc::clone(&requests),
        false,
    );
    tokio::task::yield_now().await;
    for _ in 0..2 {
        tokio::time::advance(TICK).await;
        tokio::task::yield_now().await;
    }
    for _ in 0..20 {
        if requests.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let events = events.lock().unwrap();
    assert_eq!(events.first(), Some(&"sync"));
    assert_eq!(events.get(1), Some(&"pause"));
    task.abort();
}

/// A client command that arrives and finishes during the pre-pause sync is
/// fresh activity: the loop must re-arm, not pause on the stale busy check.
#[tokio::test(start_paused = true)]
async fn client_activity_during_the_pre_pause_sync_re_arms_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(dir.path(), &config_value(1));
    let wall = Arc::new(AtomicU64::new(1_000_000));
    let lines = Arc::new(AtomicU64::new(0));
    let events = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(AtomicUsize::new(0));
    let task = spawn_test_loop(
        path,
        Arc::clone(&wall),
        Arc::clone(&lines),
        Arc::clone(&events),
        Arc::clone(&requests),
        true,
    );
    tokio::task::yield_now().await;
    for _ in 0..2 {
        tokio::time::advance(TICK).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "client activity during the sync held the pause"
    );
    assert_eq!(lines.load(Ordering::Relaxed), 1);
    // The next full window has no new client line.
    for _ in 0..2 {
        tokio::time::advance(TICK).await;
        tokio::task::yield_now().await;
    }
    for _ in 0..20 {
        if requests.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    task.abort();
}

/// A due heartbeat is busy evidence: the relay's wake must not be undone
/// by the guest pausing its own sandbox before the turn starts.
#[test]
fn a_due_heartbeat_holds_off_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path();
    let now = 1_700_000_000_000_u64;
    let store = AgentCronJobStore::for_session_artifacts();
    let partition = agent_dir.join("session-artifacts").join("main");
    std::fs::create_dir_all(&partition).unwrap();
    store.register_session_artifact("main", &partition);
    let job = store
        .create_rlm_heartbeat(&CreateAgentCronJobInput {
            active_session_id: "live-1".to_string(),
            session_id: "main".to_string(),
            session_file: "/w/main.jsonl".to_string(),
            cwd: "/w".to_string(),
            prompt: "check".to_string(),
            schedule_text: "every 10m".to_string(),
            now: Some(now),
            ..Default::default()
        })
        .expect("rlm heartbeat");
    // Due in 10 minutes: outside the 30 s horizon.
    assert!(!heartbeat_due_soon(agent_dir, now));
    // Due in 15 seconds: inside it.
    let due_in_15 = now + 10 * 60 * 1000 - 15 * 1000;
    assert!(heartbeat_due_soon(agent_dir, due_in_15));
    // A paused heartbeat never holds off the pause.
    store
        .update_rlm_heartbeat(
            "live-1",
            &job.id,
            &RlmHeartbeatUpdate {
                status: Some(RlmHeartbeatStatusUpdate::Pause),
                now: Some(due_in_15),
                ..Default::default()
            },
        )
        .expect("pause")
        .expect("updated");
    assert!(!heartbeat_due_soon(agent_dir, due_in_15));
    // A plain cron job is not a heartbeat.
    store
        .create(&CreateAgentCronJobInput {
            active_session_id: "live-1".to_string(),
            session_id: "main".to_string(),
            session_file: "/w/main.jsonl".to_string(),
            cwd: "/w".to_string(),
            prompt: "plain".to_string(),
            schedule_text: "every 1m".to_string(),
            now: Some(now),
            ..Default::default()
        })
        .expect("plain job");
    assert!(!heartbeat_due_soon(agent_dir, now + 60 * 1000 - 1000));
}

/// A dormant session's old overdue heartbeat must not keep an idle sandbox
/// billing forever: the guard only covers the recent wake window.
#[test]
fn an_old_dormant_heartbeat_does_not_block_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path();
    let now = 1_700_000_000_000_u64;
    let store = AgentCronJobStore::for_session_artifacts();
    let partition = agent_dir.join("session-artifacts").join("main");
    std::fs::create_dir_all(&partition).unwrap();
    store.register_session_artifact("main", &partition);
    store
        .create_rlm_heartbeat(&CreateAgentCronJobInput {
            active_session_id: "live-1".to_string(),
            session_id: "main".to_string(),
            session_file: "/w/main.jsonl".to_string(),
            cwd: "/w".to_string(),
            prompt: "check".to_string(),
            schedule_text: "every 10m".to_string(),
            now: Some(now - 20 * 60 * 1000),
            ..Default::default()
        })
        .expect("old heartbeat");
    // Overdue by 10 minutes: dormant, so it does not hold off the pause.
    assert!(!heartbeat_due_soon(agent_dir, now));
    // Overdue by 4 minutes: still inside the recent wake window.
    store
        .create_rlm_heartbeat(&CreateAgentCronJobInput {
            active_session_id: "live-2".to_string(),
            session_id: "main".to_string(),
            session_file: "/w/main.jsonl".to_string(),
            cwd: "/w".to_string(),
            prompt: "check".to_string(),
            schedule_text: "every 10m".to_string(),
            now: Some(now - 14 * 60 * 1000),
            ..Default::default()
        })
        .expect("recent heartbeat");
    assert!(heartbeat_due_soon(agent_dir, now));
}
