//! Tests of the guest daemon's idle self-pause.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::{self_pause_loop, SelfPauseConfig, DEFAULT_IDLE_MINUTES, TICK};

fn write_config(dir: &std::path::Path, value: &serde_json::Value) -> PathBuf {
    let path = dir.join("bot-self-pause.json");
    std::fs::write(&path, value.to_string()).unwrap();
    path
}

fn config_value(minutes: u64) -> serde_json::Value {
    json!({
        "botId": "bot-1",
        "sandboxId": "sbx-1",
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
            self_pause_loop(path, busy, lines, request).await;
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
        2,
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
    ] {
        assert!(super::summary_busy(&json!({ flag: true })), "{flag}");
    }
    assert!(!super::summary_busy(&json!({"isStreaming": false})));
    assert!(!super::summary_busy(&json!({})));
}
