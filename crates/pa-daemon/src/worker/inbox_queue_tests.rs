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

/// One bash-done arrival with the meta the withdrawal matches (the
/// command's pid and command disambiguate the completion).
fn bash_done_notice(pid: u32, command: &str) -> pa_core::session_engine::inbox::InboxNotice {
    pa_core::session_engine::inbox::InboxNotice {
        class: pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
        sender: Some(command.to_string()),
        text: format!("[bash-done pid:{pid} exit:0]"),
        meta: serde_json::json!({ "pid": pid, "command": command, "exitCode": 0 }),
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
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "[bash-done pid:4321 exit:0]",
        ),
        || false,
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
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        || false,
    );
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        || false,
    );
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "third",
        ),
        || false,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one coalesced row, not three: {rows:?}");
    let (message, _preview, visible) = &rows[0];
    assert!(visible, "a busy session keeps a visible queued row");
    assert!(
        message.contains("+3 arrived")
            && message.contains("2 bash-done, 1 factory-progress")
            && message.contains("total 3"),
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
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "first",
        ),
        || false,
    );
    // The delivery: the turn runner pops the row off the lane.
    let delivered = worker.core.lock().unwrap().steering.pop_front();
    assert!(delivered.is_some());
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        || false,
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
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
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
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one reminder row, replaced: {rows:?}");
    let (message, _, _) = &rows[0];
    assert!(
        message.starts_with("[inbox reminder] 1 messages still waiting"),
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

/// The collected-handle pin: the kernel read the finished command through
/// its handle (`bash.consumed`), so its withdrawal drains the pushed
/// inbox message without an explicit read — the count drops to zero, the
/// queued wake row stops promising it, and the journal replays the
/// withdrawal across a restart.
#[tokio::test]
async fn a_collected_handle_drains_its_inbox_message_and_row() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        bash_done_notice(4321, "sleep 1"),
        || false,
    );
    assert_eq!(inbox.count().0, 1, "the arrival pushed one message");
    assert_eq!(steering_rows(&worker).len(), 1, "one queued notice row");
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        Some(&inbox),
        Some(&arrivals),
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 1".to_string(),
        },
        None,
    );
    assert_eq!(
        inbox.count(),
        (0, None, std::collections::BTreeMap::new()),
        "the collection drained the message without a read"
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "no wake row promises a drained message"
    );
    // The restart replays the withdrawal: the journal's pending set is
    // empty.
    let session_dir = worker
        .config
        .recovery_journal_path
        .parent()
        .unwrap()
        .to_path_buf();
    let reopened = pa_core::session_engine::inbox::SessionInbox::open(Some(&session_dir));
    assert_eq!(
        reopened.count(),
        (0, None, std::collections::BTreeMap::new()),
        "the withdrawal survived the restart"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A withdrawal inside a covered batch re-renders the queued row: the
/// remaining arrivals stay announced with the live count.
#[tokio::test]
async fn a_withdrawal_inside_a_covered_batch_rerenders_the_queued_row() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    worker.core.lock().unwrap().busy = true;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        bash_done_notice(4321, "sleep 1"),
        || false,
    );
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "second",
        ),
        || false,
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].0.contains("+2 arrived") && rows[0].0.contains("total 2"),
        "the queued row covers the batch: {rows:?}"
    );
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        Some(&inbox),
        Some(&arrivals),
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 1".to_string(),
        },
        None,
    );
    assert_eq!(inbox.count().0, 1, "the factory milestone still waits");
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "the re-rendered row stays queued: {rows:?}");
    assert!(
        rows[0].0.contains("1 new message (factory-progress)")
            && rows[0].0.contains("total waiting: 1"),
        "the row re-rendered over the trimmed batch: {rows:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// An emptied inbox drops every queued inbox row: a stale reminder must
/// not wake the agent to an empty inbox either.
#[tokio::test]
async fn a_withdrawal_that_empties_the_inbox_drops_the_queued_reminder_too() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        bash_done_notice(4321, "sleep 1"),
        || false,
    );
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
    let rows = steering_rows(&worker);
    assert_eq!(
        rows.len(),
        2,
        "the arrival row and the reminder row both queue: {rows:?}"
    );
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        Some(&inbox),
        Some(&arrivals),
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 1".to_string(),
        },
        None,
    );
    assert_eq!(inbox.count().0, 0, "the collection emptied the store");
    assert!(
        steering_rows(&worker).is_empty(),
        "the stale reminder row dropped with the arrival row"
    );
    // The sweep settled the busy evidence with it.
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "no queued row still promises a wake"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A closed session drops the arrival's wake: no row, no crash, and the
/// store stays honest.
#[tokio::test]
async fn a_closed_session_refuses_the_arrival() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_BASH_DONE,
            "late",
        ),
        || true,
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
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
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
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
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
