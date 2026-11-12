//! The inbox routing's queue tests: an arrival lands one short steering
//! notice (the message in the durable store), busy-window arrivals
//! coalesce into one queued row, a delivered row frees the next batch,
//! and the periodic reminder repeats while the inbox stays unread.
use super::queue::{INBOX_ARRIVAL_QUEUE_KEY, INBOX_REMINDER_QUEUE_KEY};
use super::*;
use pa_core::session_engine::inbox::SessionInbox;

fn worker_with_journal() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-inbox-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    *worker.recovery.lock().unwrap() =
        Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
    worker
}

fn inbox_notice(class: &'static str, text: &str) -> pa_core::session_engine::inbox::InboxNotice {
    pa_core::session_engine::inbox::InboxNotice {
        class,
        sender: Some(format!("sender-{class}")),
        text: text.to_string(),
        meta: serde_json::json!({ "text": text }),
    }
}

/// One test's routing state: a journal-backed worker core plus a fresh
/// inbox store (the session dir the worker's journal lives under).
type InboxRoutingState = (
    Arc<Worker>,
    Arc<SessionInbox>,
    Arc<Mutex<Vec<pa_core::session_engine::inbox::InboxMessage>>>,
    Arc<Notify>,
);

fn routing_state() -> InboxRoutingState {
    let worker = worker_with_journal();
    let session_dir = worker
        .config
        .recovery_journal_path
        .parent()
        .unwrap()
        .to_path_buf();
    let notify = Arc::new(Notify::new());
    (
        worker,
        Arc::new(pa_core::session_engine::inbox::SessionInbox::open(Some(
            &session_dir,
        ))),
        Arc::new(Mutex::new(Vec::new())),
        notify,
    )
}

fn steering_rows(worker: &Worker) -> Vec<(String, Option<String>, bool)> {
    worker
        .core
        .lock()
        .unwrap()
        .steering
        .iter()
        .map(|item| {
            (
                item.message.clone(),
                item.preview.clone(),
                item.queue_visible,
            )
        })
        .collect()
}

/// An idle session's arrival: the message lands in the store, one
/// invisible injected notice row queues on the steering lane.
#[tokio::test]
async fn an_idle_arrival_queues_one_short_notice_and_keeps_the_message() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "[bash-done pid:4321 exit:0]",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "exactly one notice row: {rows:?}");
    let (message, preview, visible) = &rows[0];
    assert!(
        message.starts_with("[inbox ") && message.contains("1 new message (bash-done)"),
        "the short notice steers: {message}"
    );
    assert!(message.contains("rlm.inbox.read()"));
    assert!(message.contains("total waiting: 1"));
    assert_eq!(preview.as_deref(), Some("Inbox: 1 new message (bash-done)"));
    assert!(!visible, "an idle wake is an invisible injected turn");
    let (queue_key, custom_message) = {
        let core = worker.core.lock().unwrap();
        let item = core.steering.front().expect("the notice row queued");
        (item.queue_key.clone(), item.custom_message.clone())
    };
    assert_eq!(
        queue_key.as_deref(),
        Some(INBOX_ARRIVAL_QUEUE_KEY),
        "the notice row carries the coalescing key: {queue_key:?}"
    );
    assert!(
        custom_message.is_none(),
        "no full notice row rides the turn: {custom_message:?}"
    );
    let (count, _, classes) = inbox.count();
    assert_eq!(count, 1);
    assert_eq!(
        classes[pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE],
        1
    );
    // The arrival is journal busy evidence.
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the notice admission is live work"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// Busy-window arrivals coalesce: while a notice row stays queued, a
/// later arrival replaces it with one row covering the whole batch.
#[tokio::test]
async fn busy_window_arrivals_coalesce_into_one_queued_row() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "third",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one coalesced row, not three: {rows:?}");
    let (message, _preview, visible) = &rows[0];
    assert!(visible, "a busy session keeps a visible queued row");
    assert!(
        message.contains("3 new messages")
            && message.contains("2 bash-done, 1 factory-progress")
            && message.contains("total waiting: 3"),
        "the row covers the whole busy window: {message}"
    );
    assert_eq!(inbox.count().0, 3);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A delivered notice row frees the batch: the next arrival starts a
/// fresh one instead of growing the old window.
#[tokio::test]
async fn a_delivered_row_starts_a_fresh_batch() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    // The delivery: the turn runner pops the row off the lane.
    let delivered = worker.core.lock().unwrap().steering.pop_front();
    assert!(delivered.is_some());
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "a fresh row queued: {rows:?}");
    let (message, _, _) = &rows[0];
    assert!(
        message.contains("1 new message (factory-progress)"),
        "the fresh batch names only the new arrival: {message}"
    );
    assert!(
        message.contains("total waiting: 2"),
        "the total still counts every unread message: {message}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The reminder: an empty inbox admits nothing, an unread inbox steers
/// one reminder row, and a later reminder replaces the queued one.
#[tokio::test]
async fn the_reminder_repeats_while_the_inbox_stays_unread() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        || false,
        None,
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "an empty inbox never reminds"
    );
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        || false,
        None,
    );
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        || false,
        None,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one reminder row, replaced: {rows:?}");
    let (message, _, _) = &rows[0];
    assert!(
        message.starts_with("[inbox reminder] 1 message still waiting"),
        "the reminder repeats the waiting count: {message}"
    );
    assert!(message.contains("rlm.inbox.read()"));
    let queue_key = {
        let core = worker.core.lock().unwrap();
        let item = core.steering.front().expect("the reminder row queued");
        item.queue_key.clone()
    };
    assert_eq!(
        queue_key.as_deref(),
        Some("inbox:reminder"),
        "the reminder carries its coalescing key: {queue_key:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A closed session drops the arrival's wake: no row, no crash, and the
/// store stays honest.
#[tokio::test]
async fn a_closed_session_refuses_the_arrival() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "late",
        ),
        Lane::Steering,
        || true,
        |_, _| None,
        None,
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "no row on a closed session"
    );
    assert_eq!(inbox.count().0, 0, "the message never entered the store");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The reminder rows across both lanes (the coalescing key counts).
fn reminder_rows(worker: &Worker) -> usize {
    let core = worker.core.lock().unwrap();
    core.steering
        .iter()
        .chain(core.follow_up.iter())
        .filter(|item| item.queue_key.as_deref() == Some(INBOX_REMINDER_QUEUE_KEY))
        .count()
}

/// Write the `agentInbox` settings under one agent dir (the reminder
/// loop reads this file every cycle).
fn write_inbox_settings(agent_dir: &std::path::Path, inbox: &Value) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "agentInbox": inbox }).to_string(),
    )
    .unwrap();
}

/// One paused-clock reminder poll: advance the clock and yield, so the
/// spawned reminder task completes a cycle.
async fn run_reminder_cycles(cycle: std::time::Duration) {
    tokio::time::advance(cycle).await;
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
}

/// A reminder row moved onto the follow-up lane still coalesces: the
/// next reminder replaces it there instead of stacking a second row
/// that could deliver as its own turn.
#[tokio::test]
async fn a_reminder_row_moved_to_follow_up_still_coalesces() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        || false,
        None,
    );
    // The queue mutation moved the reminder row onto the follow-up
    // lane, its coalescing key preserved.
    let moved_key = {
        let mut core = worker.core.lock().unwrap();
        let moved = core.steering.pop_front().expect("the reminder row queued");
        let key = moved.queue_key.clone();
        core.follow_up.push_back(moved);
        key
    };
    assert_eq!(moved_key.as_deref(), Some(INBOX_REMINDER_QUEUE_KEY));
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        || false,
        None,
    );
    assert_eq!(
        reminder_rows(&worker),
        1,
        "the moved row is replaced, never doubled"
    );
    let steering = steering_rows(&worker);
    assert!(
        steering.len() == 1 && steering[0].0.starts_with("[inbox reminder]"),
        "the fresh reminder row steers: {steering:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The reminder loop with the interval disabled
/// (`reminderIntervalMs: 0`): a non-empty inbox never steers a row, and
/// the loop keeps polling settings — a later flip re-arms it.
#[tokio::test(start_paused = true)]
async fn the_disabled_interval_reminder_never_admits_but_keeps_polling() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 0 }));
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    engine.set_inbox(std::sync::Arc::clone(&inbox));
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    crate::agent_inbox::spawn_inbox_reminder(
        std::sync::Arc::downgrade(&engine),
        &worker.core,
        &notify,
        &worker.recovery,
        &agent_dir,
    );
    // Several poll cycles with the reminder disabled: nothing admits.
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert!(
        reminder_rows(&worker) == 0,
        "the disabled reminder never admits a row"
    );
    // The flip re-arms the poll: the next cycle steers the reminder.
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 30_000 }));
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert_eq!(reminder_rows(&worker), 1, "the re-armed reminder admits");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The reminder loop under the kill switch
/// (`agentInbox.enabled: false`): the unread inbox never steers a row,
/// and re-enabling arms the next cycle.
#[tokio::test(start_paused = true)]
async fn the_disabled_inbox_never_admits_a_reminder() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_inbox_settings(
        &agent_dir,
        &json!({ "enabled": false, "reminderIntervalMs": 30_000 }),
    );
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    engine.set_inbox(std::sync::Arc::clone(&inbox));
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    crate::agent_inbox::spawn_inbox_reminder(
        std::sync::Arc::downgrade(&engine),
        &worker.core,
        &notify,
        &worker.recovery,
        &agent_dir,
    );
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert!(
        reminder_rows(&worker) == 0,
        "the kill switch never admits a reminder"
    );
    // Re-enabling arms the next cycle: the reminder steers again.
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 30_000 }));
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert_eq!(reminder_rows(&worker), 1, "the re-enabled reminder admits");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A closed session skips reminder cycles without ending the loop: the
/// reminder task is spawned once per worker, so a later session on the
/// same worker must re-arm it.
#[tokio::test(start_paused = true)]
async fn a_closed_session_keeps_the_reminder_polling_for_the_next_session() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 30_000 }));
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    engine.set_inbox(std::sync::Arc::clone(&inbox));
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    crate::agent_inbox::spawn_inbox_reminder(
        std::sync::Arc::downgrade(&engine),
        &worker.core,
        &notify,
        &worker.recovery,
        &agent_dir,
    );
    // The session closes: every cycle skips, nothing admits, and the
    // loop stays alive.
    engine.mark_session_closed();
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert!(
        reminder_rows(&worker) == 0,
        "a closed session never admits a reminder"
    );
    // The next session on the worker clears the marker: the same loop
    // re-arms and the reminder admits.
    engine.clear_session_closed();
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert_eq!(
        reminder_rows(&worker),
        1,
        "the reminder re-arms for the next session"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A mid-cycle flip to `reminderIntervalMs: 0` never admits: the loop
/// re-reads the interval after its wait, not only at the sample.
#[tokio::test(start_paused = true)]
async fn an_interval_flip_to_zero_during_the_wait_never_admits() {
    let (worker, inbox, _arrivals, notify) = routing_state();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 30_000 }));
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    engine.set_inbox(std::sync::Arc::clone(&inbox));
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "waiting",
        ),
        1_000,
    );
    crate::agent_inbox::spawn_inbox_reminder(
        std::sync::Arc::downgrade(&engine),
        &worker.core,
        &notify,
        &worker.recovery,
        &agent_dir,
    );
    // The cycle samples the 30s interval and starts its wait.
    run_reminder_cycles(std::time::Duration::from_secs(10)).await;
    // The flip lands mid-wait: the waking cycle must not admit.
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 0 }));
    run_reminder_cycles(std::time::Duration::from_secs(30)).await;
    assert!(
        reminder_rows(&worker) == 0,
        "the stale interval sample never admits after a flip to zero"
    );
    // The disabled poll keeps reading settings: a flip back re-arms.
    write_inbox_settings(&agent_dir, &json!({ "reminderIntervalMs": 30_000 }));
    for _ in 0..3 {
        run_reminder_cycles(std::time::Duration::from_millis(60_000)).await;
    }
    assert_eq!(reminder_rows(&worker), 1, "the re-armed reminder admits");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A retired session leaves no inbox behind: the replacement's build
/// installs the next session's store, so no retired store can serve
/// reads or take appends across the swap.
#[tokio::test]
async fn a_retired_session_leaves_no_inbox_for_the_rebuild() {
    let (worker, inbox, _arrivals, _notify) = routing_state();
    let dir = tempfile::tempdir().unwrap();
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    engine.set_inbox(std::sync::Arc::clone(&inbox));
    assert!(engine.inbox().is_some(), "the live session's store serves");
    engine.mark_session_closed();
    engine.retire_session_runtime().await;
    assert!(
        engine.inbox().is_none(),
        "the retired store never outlives its session"
    );
    // The replacement's build installs the next session's store.
    engine.set_inbox(std::sync::Arc::new(SessionInbox::in_memory()));
    assert!(
        engine.inbox().is_some(),
        "the rebuilt session's store serves"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A worker over the faux engine (so the agent-message route has an
/// engine and a store) with its inbox attached; `created` is set
/// directly so no demand-seam build races the store install.
fn faux_worker_with_inbox() -> (Arc<Worker>, Arc<SessionInbox>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("pa-worker-inbox-faux-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "engine": "faux", "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    *worker.recovery.lock().unwrap() =
        Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
    worker.core.lock().unwrap().created = true;
    let inbox = Arc::new(SessionInbox::open(Some(&dir)));
    worker
        .agent_engine
        .as_ref()
        .expect("the faux engine")
        .set_inbox(std::sync::Arc::clone(&inbox));
    (worker, inbox, dir)
}

/// The wrapped wire row of one child-status notice (the daemon's
/// reserved-kind delivery form).
fn child_notice_wire(message: pa_types::session::CustomMessage) -> (String, serde_json::Value) {
    let text = message.content.text();
    let wire = serde_json::to_value(pa_types::session::AgentMessage::Custom(message)).unwrap();
    (text, wire)
}

/// A minted child-status row routes into the durable inbox (the
/// agent-lifecycle class): the message waits with its sender, ONE
/// coalesced wake row replaces the loud full row, and the arrival is
/// journal busy evidence.
#[tokio::test]
async fn a_minted_child_notice_routes_into_the_inbox() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    let (text, wire) = child_notice_wire(
        pa_core::session_engine::rlm_notices::create_rlm_child_failure_message(
            "sub-9", "lane", "boom", 1_000,
        ),
    );
    let nonce = crate::child_status_notices::mint();
    let delivered = worker
        .dispatch(
            "follow_up",
            &json!({
                "message": text,
                "customMessage": wire,
                "rlmNoticeNonce": nonce,
            }),
        )
        .await;
    assert!(delivered.success, "the notice routes: {delivered:?}");
    assert_eq!(delivered.command, "follow_up");
    let (count, _, classes) = inbox.count();
    assert_eq!(count, 1, "the message waits in the durable store");
    assert_eq!(classes["child-failed"], 1);
    let messages = inbox.drain();
    assert_eq!(messages[0].sender.as_deref(), Some("lane"));
    assert!(messages[0].text.contains("[child-failed child:lane]"));
    assert_eq!(messages[0].meta["error"], "boom");
    // The loud full row never parked: one short coalesced wake rides the
    // requested lane, and the strip projection refreshed.
    let rows = steering_rows(&worker);
    assert!(
        rows.is_empty(),
        "the wake rides the follow-up lane: {rows:?}"
    );
    let follow_up: Vec<(String, Option<String>, bool)> = worker
        .core
        .lock()
        .unwrap()
        .follow_up
        .iter()
        .map(|item| {
            (
                item.message.clone(),
                item.queue_key.clone(),
                item.custom_message.is_some(),
            )
        })
        .collect();
    assert_eq!(follow_up.len(), 1, "one coalesced wake row: {follow_up:?}");
    let (wake, queue_key, full_row) = &follow_up[0];
    assert!(
        wake.contains("1 new message (child-failed)"),
        "the wake counts the class: {wake}"
    );
    assert_eq!(queue_key.as_deref(), Some(INBOX_ARRIVAL_QUEUE_KEY));
    assert!(
        !full_row,
        "no full notice row rides the wake: {follow_up:?}"
    );
    // The arrival is journal busy evidence like every inbox admission.
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the routed notice is live work"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// `agentInbox.enabled: false` keeps the minted child-status row direct:
/// the full row parks on the follow-up lane and nothing lands in a store.
#[tokio::test]
async fn the_inbox_kill_switch_keeps_the_child_notice_row_direct() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    std::fs::create_dir_all(&worker.config.agent_dir).unwrap();
    std::fs::write(
        worker.config.agent_dir.join("settings.json"),
        json!({ "agentInbox": { "enabled": false } }).to_string(),
    )
    .unwrap();
    let (text, wire) = child_notice_wire(
        pa_core::session_engine::rlm_notices::create_rlm_child_terminal_notice(
            &pa_core::session_engine::rlm_notices::RlmChildTerminalNotice::CompletedWithoutReply {
                child_id: "sub-1".to_string(),
                session_name: "lane".to_string(),
                last_assistant_text_preview: None,
            },
            2_000,
        ),
    );
    let nonce = crate::child_status_notices::mint();
    let delivered = worker
        .dispatch(
            "follow_up",
            &json!({
                "message": text,
                "customMessage": wire,
                "rlmNoticeNonce": nonce,
            }),
        )
        .await;
    assert!(delivered.success, "the direct row parks: {delivered:?}");
    assert_eq!(inbox.count().0, 0, "the disabled inbox takes nothing");
    let core = worker.core.lock().unwrap();
    let parked = core.follow_up.front().expect("the full row parked");
    assert!(
        parked.custom_message.is_some(),
        "the direct route keeps the full row"
    );
    assert_eq!(parked.message, text);
    assert!(core.steering.is_empty());
    drop(core);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A clear drops unread inbox-routed agent messages and the wake rows
/// that referred to them: an emptied inbox leaves no stale notice or
/// reminder, and the withdrawal replays across a reopen.
#[tokio::test]
async fn a_clear_drops_unread_agent_messages_and_their_wake_rows() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    // A busy-window delivery routes into the durable store and queues
    // ONE short notice; a reminder tick then queues the count row.
    worker.core.lock().unwrap().busy = true;
    let mut subscription = worker.events.subscribe();
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "peer note",
                "sender": { "activeSessionId": "peer-1", "sessionName": "peer" },
            }),
        )
        .await;
    assert!(delivered.success, "delivery failed: {delivered:?}");
    assert_eq!(inbox.count().0, 1, "the message waits in the store");
    // The delivery refreshes the queue-strip projection like the direct
    // route does: the queued notice lands as a session_action_update.
    let mut frames = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                frames.push(outbound["event"].clone());
            }
        }
    }
    assert!(
        frames.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("session_action_update")
                && event.to_string().contains("Inbox:")
        }),
        "the queued notice reached the action projection: {frames:?}"
    );
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &worker.work_notify,
        &inbox,
        || false,
        None,
    );
    assert_eq!(reminder_rows(&worker), 1, "the reminder row queued");
    let cleared = worker.dispatch("agent_messages_clear", &json!({})).await;
    assert!(cleared.success, "clear failed: {cleared:?}");
    assert_eq!(
        cleared.data,
        Some(json!({ "steering": [], "followUp": [] })),
        "the lane shape is unchanged"
    );
    assert_eq!(
        inbox.count().0,
        0,
        "the durable record leaves with the clear"
    );
    let rows = steering_rows(&worker);
    assert!(
        rows.is_empty(),
        "no stale wake row survives the emptied inbox: {rows:?}"
    );
    // The withdrawal replays: a reopened store stays empty.
    let reopened = SessionInbox::open(Some(&dir));
    assert_eq!(
        reopened.count(),
        (0, None, std::collections::BTreeMap::new())
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The capacity gate refuses inside the admission's critical section:
/// a full store of agent messages refuses the next delivery.
#[tokio::test]
async fn a_full_agent_message_inbox_refuses_the_next_delivery() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    for index in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
        inbox.push(
            inbox_notice(
                pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                &format!("waiting {index}"),
            ),
            1_000 + index as u64,
        );
    }
    let refused = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "one too many",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(!refused.success, "the full store refuses: {refused:?}");
    assert!(
        refused
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("too many pending messages"),
        "the TS refusal text rides: {refused:?}"
    );
    assert_eq!(
        inbox.count().0,
        DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
        "nothing leaked past the cap"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A closed session takes a durable push with no wake row; a retired
/// session (no store) is refused instead of injecting a raw row.
#[tokio::test]
async fn a_closed_session_takes_the_durable_push_and_refuses_without_a_store() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    worker
        .agent_engine
        .as_ref()
        .expect("the faux engine")
        .mark_session_closed();
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "for the journal",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(
        delivered.success,
        "a closed session still takes the durable push: {delivered:?}"
    );
    assert_eq!(inbox.count().0, 1, "the message waits in the durable store");
    assert!(
        steering_rows(&worker).is_empty(),
        "no wake row for a closed session"
    );
    // The retired session (no store) refuses: no raw row lands.
    worker
        .agent_engine
        .as_ref()
        .expect("the faux engine")
        .clear_inbox();
    let refused = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "into the void",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(!refused.success, "the retired session refuses: {refused:?}");
    assert_eq!(
        refused.error.as_deref(),
        Some("Target session is closed"),
        "{refused:?}"
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "no raw row lands on a retiring session"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The closed-session append is atomic with the retire: the slot's own
/// mutex covers the identity re-check and the journal append, so a
/// retired store never takes an append that could race the replacement's
/// reopen and compaction of the same journal, and the sender's retry
/// lands in the replacement store. Mutation: dropping the identity check
/// lets the stale store take the append (both refusal pins go red).
#[tokio::test]
async fn a_retired_slot_refuses_the_closed_sessions_append_atomically() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    let engine = worker.agent_engine.as_ref().expect("the faux engine");
    // The live slot takes the closed session's durable push.
    assert!(
        engine
            .push_to_live_inbox(
                &inbox,
                inbox_notice(
                    pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                    "first",
                ),
                1_000,
            )
            .is_some(),
        "the live slot takes the durable push"
    );
    assert_eq!(inbox.count().0, 1);
    // The retire clears the slot: the stale store is refused — its append
    // would race the replacement's reopen of the same journal.
    engine.clear_inbox();
    assert!(
        engine
            .push_to_live_inbox(
                &inbox,
                inbox_notice(
                    pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                    "stale",
                ),
                2_000,
            )
            .is_none(),
        "the retired store never takes an append"
    );
    assert_eq!(inbox.count().0, 1, "the retired store stayed untouched");
    // The replacement store is the sender's retry target; the retired one
    // stays refused even after the slot moved on.
    let replacement = Arc::new(SessionInbox::open(Some(&dir.join("replacement"))));
    engine.set_inbox(std::sync::Arc::clone(&replacement));
    assert!(
        engine
            .push_to_live_inbox(
                &inbox,
                inbox_notice(
                    pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                    "still stale",
                ),
                3_000,
            )
            .is_none(),
        "the replaced-away store stays refused"
    );
    assert!(
        engine
            .push_to_live_inbox(
                &replacement,
                inbox_notice(
                    pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                    "retried",
                ),
                4_000,
            )
            .is_some(),
        "the replacement store takes the retry"
    );
    assert_eq!(replacement.count().0, 1);
    assert_eq!(inbox.count().0, 1, "the retired store stays untouched");
    let _ = std::fs::remove_dir_all(&dir);
}

/// An open-session delivery is atomic with the session swap too: a store
/// the `create` replacement already retired refuses the append instead of
/// accepting a notice the replacement session cannot read, and the wake
/// row never queues for the replacement. Mutation: dropping the identity
/// check lands the notice in the retired store (both pins red).
#[tokio::test]
async fn a_replaced_inbox_refuses_the_open_sessions_append() {
    let (worker, inbox, dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    let engine = worker.agent_engine.as_ref().expect("the faux engine");
    // The replacement installs the next session's store.
    let replacement = Arc::new(SessionInbox::open(Some(&dir.join("replacement"))));
    engine.set_inbox(std::sync::Arc::clone(&replacement));
    let refused = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &worker.work_notify,
        &inbox,
        &worker.inbox_arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
            "for the retired store",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        Some(engine.as_ref()),
    );
    assert_eq!(
        refused.as_ref().err().map(String::as_str),
        Some("Target session is closed"),
        "the retired store refuses the accepted delivery: {refused:?}"
    );
    assert_eq!(inbox.count().0, 0, "nothing landed in the retired store");
    assert_eq!(
        replacement.count().0,
        0,
        "nothing leaked into the replacement"
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "no wake row queues for the replacement: {:?}",
        steering_rows(&worker)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A follow-up arrival never demotes a queued steering notice: the batch
/// keeps the most urgent lane it has already ridden.
#[tokio::test]
async fn a_follow_up_arrival_keeps_a_queued_steering_notice() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
            "second",
        ),
        Lane::FollowUp,
        || false,
        |_, _| None,
        None,
    );
    let core = worker.core.lock().unwrap();
    assert!(
        core.steering
            .iter()
            .any(|item| item.queue_key.as_deref() == Some(INBOX_ARRIVAL_QUEUE_KEY)),
        "the notice stays on the steering lane"
    );
    assert!(
        !core
            .follow_up
            .iter()
            .any(|item| item.queue_key.as_deref() == Some(INBOX_ARRIVAL_QUEUE_KEY)),
        "the follow-up arrival never demotes it"
    );
    drop(core);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// An edited arrival row leaves the coalescing sweep: a later arrival
/// queues a fresh notice instead of silently deleting the user's text.
#[tokio::test]
async fn an_edited_arrival_row_survives_the_next_arrival() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.core.lock().unwrap().created = true;
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    // The queue strip addresses the row by its visible preview.
    let queued_preview = steering_rows(&worker)[0]
        .1
        .clone()
        .expect("the notice preview");
    let applied = worker
        .dispatch(
            "mutate_queued_message",
            &json!({
                "activeSessionId": "target-session",
                "lane": "steering",
                "index": 0,
                "expectedText": queued_preview,
                "mutation": { "type": "replace", "text": "user instruction" },
            }),
        )
        .await;
    assert!(applied.success, "mutation failed: {applied:?}");
    assert_eq!(applied.data, Some(json!({ "status": "applied" })));
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 2, "the edited row survives: {rows:?}");
    assert!(
        rows.iter().any(|(text, _, _)| text == "user instruction"),
        "the user's instruction stays queued: {rows:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A queued notice row never consumes the a2a capacity: the bound counts
/// waiting inbox messages (and direct-route marker rows), not the one
/// coalesced wake row per batch.
#[tokio::test]
async fn a_queued_notice_row_does_not_consume_the_capacity() {
    let (worker, inbox, _dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let first = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "one",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(first.success, "the first delivery admits: {first:?}");
    assert_eq!(inbox.count().0, 1);
    for index in 1..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION - 1 {
        inbox.push(
            inbox_notice(
                pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                &format!("waiting {index}"),
            ),
            2_000 + index as u64,
        );
    }
    // 19 waiting messages + the queued notice row: the 20th delivery is
    // still admitted (the notice row is not a pending message), and the
    // next one refuses.
    let twentieth = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "twenty",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(
        twentieth.success,
        "the 20th delivery still admits: {twentieth:?}"
    );
    assert_eq!(
        inbox.count().0,
        DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION
    );
    let refused = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "twenty-one",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(!refused.success, "the 21st refuses: {refused:?}");
    assert!(
        refused
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("too many pending messages"),
        "{refused:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The wake-row refresh retracts the queued notice and reminder once the
/// store empties, and re-renders them over a surviving batch.
#[tokio::test]
async fn the_wake_row_refresh_follows_the_live_store() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &worker.work_notify,
        &inbox,
        || false,
        None,
    );
    // A targeted read takes the bash-done message: the batch trims and
    // both rows re-render over what is left.
    let taken = inbox.drain_matching(&pa_core::session_engine::inbox::InboxReadFilter {
        class: Some(pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE.to_string()),
        ..Default::default()
    });
    assert_eq!(taken.len(), 1);
    assert!(
        crate::worker::refresh_inbox_wake_rows(&worker.core, &arrivals, &inbox),
        "the partial drain re-render reports the change"
    );
    let rows = steering_rows(&worker);
    assert!(
        rows.iter().any(
            |(text, preview, _)| text.contains("1 new message (factory-progress)")
                && preview.as_deref() == Some("Inbox: 1 new message (factory-progress)")
        ),
        "the notice re-rendered over the surviving batch: {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|(text, _, _)| text.starts_with("[inbox reminder] 1 message still waiting")),
        "the reminder re-rendered with the live count: {rows:?}"
    );
    // A restart restores the row without its batch: the refresh rebuilds
    // coverage over the waiting set instead of dropping a wake unread
    // messages still need.
    {
        arrivals.lock().unwrap().clear();
        crate::worker::refresh_inbox_wake_rows(&worker.core, &arrivals, &inbox);
        let rows = steering_rows(&worker);
        assert!(
            rows.iter()
                .any(|(text, _, _)| text.contains("1 new message (factory-progress)")),
            "the recovered row survives with the waiting message: {rows:?}"
        );
    }
    // The final drain empties the store: both rows retract.
    let rest = inbox.drain();
    assert_eq!(rest.len(), 1);
    crate::worker::refresh_inbox_wake_rows(&worker.core, &arrivals, &inbox);
    let rows = steering_rows(&worker);
    assert!(
        rows.is_empty(),
        "an emptied store leaves no stale wake row: {rows:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The read hook retracts the wake rows and refreshes the queue-strip
/// projection for subscribed clients (the kernel's read handler runs the
/// engine's installed seam after every drain).
#[tokio::test]
async fn the_read_hook_refreshes_the_wake_rows_and_their_action_events() {
    let (worker, inbox, _dir) = faux_worker_with_inbox();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    let mut subscription = worker.events.subscribe();
    // The delivery routes into the store, queues the notice, and emits
    // the strip refresh (the direct route's parity).
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "waiting",
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await;
    assert!(delivered.success, "delivery failed: {delivered:?}");
    assert_eq!(inbox.count().0, 1);
    admit_inbox_reminder(
        &worker.recovery,
        &worker.core,
        &worker.work_notify,
        &inbox,
        || false,
        None,
    );
    let delivery_frames = {
        let mut frames = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type == "session_event" {
                if let Ok(outbound) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                    frames.push(outbound["event"].clone());
                }
            }
        }
        frames
    };
    assert!(
        delivery_frames.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("session_action_update")
        }),
        "the delivery refreshed the strip: {delivery_frames:?}"
    );
    // The agent reads: the store drains, then the installed seam runs.
    let drained = inbox.drain();
    assert_eq!(drained.len(), 1);
    let hook = worker
        .agent_engine
        .as_ref()
        .expect("the faux engine")
        .inbox_read_hook()
        .expect("the worker installed the seam");
    hook(&inbox);
    let rows = steering_rows(&worker);
    assert!(
        rows.is_empty(),
        "the drain hook retracts the stale rows: {rows:?}"
    );
    let hook_frames = {
        let mut frames = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type == "session_event" {
                if let Ok(outbound) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                    frames.push(outbound["event"].clone());
                }
            }
        }
        frames
    };
    assert!(
        hook_frames.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("session_action_update")
        }),
        "the retraction refreshed the strip: {hook_frames:?}"
    );
    // A late strip refresh over the drained state recomputes under the
    // emission lock and stays silent: the drained notice is never
    // republished from a stale copy.
    crate::worker::emit_action_update_fresh(&worker.core, &worker.events).unwrap();
    assert!(
        subscription.try_recv().is_err(),
        "a refresh over the already-published strip stays silent"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A live batch drained to nothing drops its arrival row (older unread
/// mail keeps its reminder); only an unknown recovered batch rebuilds.
#[tokio::test]
async fn a_drained_live_batch_drops_its_row_without_rebuilding() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    // An older message waits without ever being covered by the row.
    inbox.push(
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "older",
        ),
        500,
    );
    let _ = admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "covered",
        ),
        Lane::Steering,
        || false,
        |_, _| None,
        None,
    );
    // The read takes the covered arrival only; the live batch trims to
    // nothing while the older message stays.
    let taken = inbox.drain_matching(&pa_core::session_engine::inbox::InboxReadFilter {
        since_ms: Some(1_000),
        ..Default::default()
    });
    assert_eq!(taken.len(), 1);
    assert_eq!(inbox.count().0, 1, "the older message waits");
    crate::worker::refresh_inbox_wake_rows(&worker.core, &arrivals, &inbox);
    let rows = steering_rows(&worker);
    assert!(
        rows.is_empty(),
        "the drained live batch drops its row instead of re-announcing: {rows:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}
