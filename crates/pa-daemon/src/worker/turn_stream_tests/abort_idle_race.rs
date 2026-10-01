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
//! - `PA_RACE_REPS`: repetitions in one process (default 50; a
//!   long battery should chunk processes — the workers accumulate
//!   engines and runtimes in-process past ~130 reps).
//! - `PA_RACE_DELAY_MS`: the held turn's faux delay (default 3000; the
//!   product-family test uses `600_000` — the delay's magnitude does not
//!   change the abort-vs-admission interleaving, only the miss cost).
//! - `PA_RACE_IDLE_WINDOW_MS`: the wait-for-idle window the settle
//!   latency report uses (default 300; an honored abort settles the
//!   held turn in single-digit ms).
//! - `PA_RACE_EVENT_LOG`: path the per-rep event frames append to
//!   (forwarded to the worker's `PA_DAEMON_EVENT_LOG` seam).
//!
//! THE VERDICT CLASSES (the harness deliberately fires the abort without
//! a positive-signal sync, so the abort can land anywhere in the
//! delivery — the admission prefix included, exactly the product race):
//! - `lost_aborts` — the PRODUCT race this harness exists for: the abort
//!   never reached the run, the held turn serves "held reply" as its OWN
//!   reply (the first assistant row behind ONE user row), the pre-fix
//!   dump shape (busy=true `abort_requested=true` `steering_len=2`
//!   `run_signal=live`). ANY occurrence fails the harness.
//! - `fixture_leaks` — the expected post-fix artifact of the same
//!   interleaving: the consult aborts the turn BEFORE its provider call,
//!   so the faux step the held turn never consumed (the delayed one)
//!   leaks to the batch turn, whose co-delivered reply serves "held
//!   reply" behind the batch's user rows (the pop-at-call contract: no
//!   call, no consumption). With a real provider the batch turn serves
//!   promptly; the class is REPORTED, never asserted.
//! - `green` — the abort landed on the registered run (the normal
//!   abort path) and the whole queue settled inside the window.
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
    use std::fmt::Write as _;
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
            let _ = write!(dump, " turn_agent=present run_signal={run_signal}");
        }
        Some(None) => dump.push_str(" turn_agent=absent"),
        None => dump.push_str(" turn_agent=none-engine"),
    }
    dump
}

// The faux registry is process-global: the lock guard must span the
// whole async flow (every rep registers into the same registry).
#[allow(clippy::await_holding_lock)]
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
    let mut lost_aborts = 0usize;
    let mut fixture_leaks = 0usize;
    let mut green_reps = 0usize;
    for rep in 1..=reps {
        if let Some(path) = &event_log {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                use std::io::Write;
                let _ = writeln!(file, "=== RATE_HARNESS rep {rep} ===");
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "pa-worker-abort-race-{rep}-{}",
            uuid::Uuid::new_v4()
        ));
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
            .dispatch(
                "follow_up",
                &json!({ "message": "follow up after the batch" }),
            )
            .await;
        assert!(follow.success, "rep {rep}: follow_up failed: {follow:?}");
        let sent = worker.abort_and_send_queued();
        assert!(
            sent,
            "rep {rep}: the armed steering batch sent with the abort"
        );
        // THE SETTLE-LATENCY WINDOW first (the original symptom's
        // observable): an honored abort settles the whole queue in
        // single-digit ms when the abort lands on the registered run; the
        // consult's leaked-step class inherits the delay for the batch
        // turn (the fixture artifact); a lost abort inherits it for the
        // held turn (the product race).
        let idle = tokio::time::timeout(
            std::time::Duration::from_millis(window_ms),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        let idle_ok = matches!(&idle, Ok(response) if response.success);
        // THE PRODUCT ASSERTION (the race this harness exists for): the
        // abort is honored — the held turn NEVER serves its scripted
        // reply. Classified by the settled transcript, never by wall
        // latency: the first assistant row names the turn that won the
        // race for the held step. The aborted row is the registered-run
        // abort; "held reply" behind ONE user row is the held turn's own
        // reply (the LOST abort — the run served its hold); "held reply"
        // behind the batch's co-delivered user rows is the consult's
        // honored abort leaking the unconsumed step to the batch turn
        // (the fixture artifact).
        let first_row =
            tokio::time::timeout(std::time::Duration::from_millis(delay_ms + 10_000), async {
                loop {
                    let messages = worker.dispatch("get_messages", &json!({})).await;
                    if !messages.success {
                        anyhow::bail!("rep {rep}: get_messages failed: {messages:?}");
                    }
                    let rows = messages
                        .data
                        .as_ref()
                        .and_then(|data| data.get("messages"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(index) = rows
                        .iter()
                        .position(|row| crate::types::message_role(row) == Some("assistant"))
                    {
                        let users_before = rows[..index]
                            .iter()
                            .filter(|row| crate::types::message_role(row) == Some("user"))
                            .count();
                        return Ok((rows[index].clone(), users_before));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            })
            .await;
        let mut honored = false;
        match first_row {
            Ok(Ok((row, users_before))) => {
                let aborted = row.get("stopReason").and_then(Value::as_str) == Some("aborted");
                let held_reply = crate::types::message_text(&row).contains("held reply");
                if held_reply && users_before < 2 {
                    lost_aborts += 1;
                    eprintln!(
                        "RATE_HARNESS LOST_ABORT rep {rep} of {reps}: the held turn served \"held reply\" as its own reply (users_before={users_before}) - the abort never reached the run: {}",
                        dump_hang_state(&worker)
                    );
                    // Wait out the busy session (the batch and the
                    // follow-up lanes still hold work) so the next rep
                    // starts on an idle queue, exactly like the leak
                    // branch - the lost abort's worker otherwise keeps
                    // delivering behind the harness's back.
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(delay_ms + 10_000),
                        worker.dispatch("wait_for_idle", &json!({})),
                    )
                    .await;
                } else {
                    honored = true;
                    if !idle_ok {
                        fixture_leaks += 1;
                        eprintln!(
                            "RATE_HARNESS FIXTURE_LEAK rep {rep} of {reps} (users_before={users_before}, aborted_row={aborted}): the consult honored the abort; the unconsumed held step leaked to the batch turn: {}",
                            dump_hang_state(&worker)
                        );
                        // Wait out the inherited hold so the next rep
                        // starts clean.
                        let settle = tokio::time::timeout(
                            std::time::Duration::from_millis(delay_ms + 10_000),
                            worker.dispatch("wait_for_idle", &json!({})),
                        )
                        .await;
                        let settle_ok = matches!(&settle, Ok(response) if response.success);
                        if !settle_ok {
                            // The inherited hold outlived its whole
                            // window: the session never settled - count
                            // it, never exit green on a busy session.
                            lost_aborts += 1;
                        }
                        eprintln!(
                            "RATE_HARNESS FIXTURE_LEAK rep {rep}: post-leak settle ok={settle_ok}"
                        );
                    }
                }
            }
            Ok(Err(error)) => {
                lost_aborts += 1;
                eprintln!("RATE_HARNESS LOST_ABORT rep {rep}: {error:#}");
            }
            Err(_) => {
                lost_aborts += 1;
                eprintln!(
                    "RATE_HARNESS LOST_ABORT rep {rep} of {reps}: the first assistant row never settled past the delay: {}",
                    dump_hang_state(&worker)
                );
            }
        }
        if idle_ok && honored {
            green_reps += 1;
        }
    }
    println!(
        "RATE_HARNESS reps={reps} green={green_reps} lost_aborts={lost_aborts} fixture_leaks={fixture_leaks}"
    );
    assert!(
        lost_aborts == 0,
        "the idle race reproduced at rate: {lost_aborts}/{reps} lost aborts"
    );
}
