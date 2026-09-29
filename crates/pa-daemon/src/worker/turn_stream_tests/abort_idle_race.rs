//! The abort-and-send idle-race rate harness (the gate-pool lane's honest
//! disposition): `abort_and_send_queued`'s settle path left the session
//! busy forever on an intermittent solo-reproducing interleaving
//! (`abort_and_send_queued_delivers_the_steering_batch_then_the_follow_ups`
//! hung to the harness wall and panicked at `queue.rs:545` — "the session
//! never went idle after the abort" — on 1/3 quiet-VM solo runs). This
//! harness reproduces that interleaving AT RATE: the held turn's delay
//! and the idle window shrink so a miss costs a second instead of a
//! hang, every miss dumps the settle-path state (the worker core, the
//! engine's turn agent, the agent run's abort signal), and the run ends
//! with a one-line verdict the rate driver classifies.
//!
//! Knobs (all default to the single-rep shape):
//! - `PA_RACE_REPS`: repetitions in one process (default 50).
//! - `PA_RACE_DELAY_MS`: the held turn's faux delay (default 3000; the
//!   product-family test uses 600_000 — the delay's magnitude does not
//!   change the abort-vs-admission interleaving, only the miss cost).
//! - `PA_RACE_IDLE_WINDOW_MS`: the wait-for-idle window that decides a
//!   miss (default 300; a green settle completes in single-digit ms).
//! - `PA_RACE_EVENT_LOG`: path the per-rep event frames append to
//!   (forwarded to the worker's `PA_DAEMON_EVENT_LOG` seam).
//!
//! `#[ignore]`d: the rate driver invokes it explicitly; it never runs in
//! the normal test battery.
use super::*;

/// Read one numeric knob with a default.
fn race_knob(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// The state at the miss: everything the settle path owns, one dump line
/// each, so the interleaving that left the session never-idle reads off
/// the transcript directly.
fn dump_hang_state(worker: &Worker) -> String {
    let core = worker.core.lock().unwrap();
    let mut dump = format!(
        "core: busy={} abort_requested={} retry_abort_requested={} \
         queued_input_suspended={} compacting={} shutdown_requested={} \
         forced_all_steering={} steering_len={} follow_up_len={} \
         running_tool_calls={}",
        core.busy,
        core.abort_requested,
        core.retry_abort_requested,
        core.queued_input_suspended,
        core.compacting,
        core.shutdown_requested,
        core.forced_all_steering,
        core.steering.len(),
        core.follow_up.len(),
        core.running_tool_calls.len(),
    );
    drop(core);
    // The engine's abort target: present? and does the agent's ACTIVE
    // run carry an aborted signal? A miss with `run_signal=aborted`
    // means the abort landed but the turn never settled; a miss with
    // `run_signal=live` means the abort never reached the run (a lost
    // abort at a registration boundary); `no-run` means no active run
    // at all (the settle raced the next admission).
    match worker.agent_engine.as_ref().map(|engine| {
        engine
            .turn_agent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }) {
        Some(Some(agent)) => {
            let run_signal = match agent.signal() {
                Some(signal) => {
                    if signal.is_aborted() {
                        "aborted"
                    } else {
                        "live"
                    }
                }
                None => "no-run",
            };
            dump.push_str(&format!(" turn_agent=present run_signal={run_signal}"));
        }
        Some(None) => dump.push_str(" turn_agent=absent"),
        None => dump.push_str(" turn_agent=none-engine"),
    }
    dump
}

#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
#[ignore = "the rate harness: run with PA_RACE_* knobs (see the module docs)"]
async fn abort_and_send_idle_race_rate_harness() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let reps = race_knob("PA_RACE_REPS", 50).clamp(1, 100_000);
    let delay_ms = race_knob("PA_RACE_DELAY_MS", 3000).clamp(200, 600_000);
    let window_ms = race_knob("PA_RACE_IDLE_WINDOW_MS", 300).clamp(50, 600_000);
    // The worker's event-log seam: one file for the whole run, one
    // rep-marker line per rep, the frames append behind each marker.
    let event_log = std::env::var("PA_RACE_EVENT_LOG").ok();
    if let Some(path) = &event_log {
        std::env::set_var("PA_DAEMON_EVENT_LOG", path);
    }
    let mut misses = 0usize;
    for rep in 1..=reps {
        if let Some(path) = &event_log {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path)
            {
                use std::io::Write;
                let _ = writeln!(file, "=== RATE_HARNESS rep {rep} ===");
            }
        }
        let dir = std::env::temp_dir().join(format!("pa-worker-abort-race-{rep}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: format!("abort-race-{rep}"),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": delay_ms },
                    "batch reply",
                    "follow-up reply"
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": format!("abort-race-{rep}") }),
            )
            .await;
        assert!(created.success, "rep {rep}: create failed: {created:?}");
        // The held turn parks the queue behind it (the delay hold).
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": format!("abort-race-{rep}"),
                    "message": "held turn for the batch abort",
                }),
            )
            .await;
        assert!(prompt.success, "rep {rep}: prompt failed: {prompt:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if worker.core.lock().unwrap().busy {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "rep {rep}: the held turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        // The product-family test's exact pacing: the hold has the turn
        // when this sleep ends, the steers queue behind it, and the abort
        // fires against the in-flight run.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        for message in ["steering one", "steering two"] {
            let steered = worker
                .dispatch("steer", &json!({ "message": message }))
                .await;
            assert!(steered.success, "rep {rep}: steer failed: {steered:?}");
        }
        let follow = worker
            .dispatch("follow_up", &json!({ "message": "follow up after the batch" }))
            .await;
        assert!(follow.success, "rep {rep}: follow_up failed: {follow:?}");
        let sent = worker.abort_and_send_queued();
        assert!(sent, "rep {rep}: the armed steering batch sent with the abort");
        let idle = tokio::time::timeout(
            std::time::Duration::from_millis(window_ms),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        if matches!(&idle, Ok(response) if response.success) {
            continue;
        }
        misses += 1;
        eprintln!(
            "RATE_HARNESS MISS rep {rep} of {reps} (window {window_ms}ms): {}",
            dump_hang_state(&worker)
        );
        // Wait out the never-aborted hold so the next rep starts clean:
        // the miss's outcome (settled normally at the delay vs hung past
        // it) is itself evidence.
        let settle = tokio::time::timeout(
            std::time::Duration::from_millis(delay_ms + 10_000),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        eprintln!(
            "RATE_HARNESS MISS rep {rep}: post-miss settle ok={} (the hold ran out at {delay_ms}ms)",
            matches!(&settle, Ok(response) if response.success)
        );
    }
    println!("RATE_HARNESS reps={reps} misses={misses}");
    if misses > 0 {
        panic!("the idle race reproduced at rate: {misses}/{reps} misses");
    }
}
