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
        Lane::Steering,
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
        Lane::Steering,
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
        Lane::Steering,
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
        Lane::Steering,
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
        Lane::Steering,
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
        Lane::Steering,
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

/// The collected-handle pin: the kernel read the finished command through
/// its handle (`bash.consumed`), so its withdrawal drains the pushed inbox
/// message without an explicit read — the count drops to zero — and an
/// emptied inbox drops every queued wake row (the arrival row and a stale
/// reminder both promised it).
#[tokio::test]
async fn a_collected_handle_drains_its_message_and_drops_the_queued_wake_rows() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        bash_done_notice(4321, "sleep 1"),
        Lane::Steering,
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
        Some((&inbox, &arrivals)),
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
        "the arrival row and the stale reminder both dropped"
    );
    // The sweep settled the busy evidence with the rows.
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "no queued row still promises a wake"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A withdrawal inside a covered batch re-renders the queued row over the
/// trimmed batch, re-renders a queued reminder with the live count, and
/// refreshes the recovery snapshot the revival replays.
#[tokio::test]
async fn a_withdrawal_inside_a_covered_batch_rerenders_the_queued_rows() {
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
        Lane::Steering,
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
        Lane::Steering,
        || false,
    );
    admit_inbox_reminder(&worker.recovery, &worker.core, &notify, &inbox, || false);
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        Some((&inbox, &arrivals)),
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 1".to_string(),
        },
        None,
    );
    assert_eq!(inbox.count().0, 1, "the factory milestone still waits");
    let milestone = inbox
        .drain()
        .pop()
        .expect("the milestone survived the withdrawal");
    let rows = steering_rows(&worker);
    assert_eq!(
        rows.len(),
        2,
        "the arrival row and the reminder row: {rows:?}"
    );
    let (expected_preview, expected_text) =
        pa_core::session_engine::inbox::arrival_notice(std::slice::from_ref(&milestone), 1);
    assert_eq!(
        rows[0],
        (expected_text.clone(), Some(expected_preview), true),
        "the arrival row re-rendered over the trimmed batch"
    );
    assert!(
        rows[1]
            .0
            .starts_with("[inbox reminder] 1 message still waiting"),
        "the reminder re-rendered with the live count: {rows:?}"
    );
    // The re-render reached the recovery journal: a crash now revives
    // the re-rendered text, not the admission's.
    let (steering, _, _) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the withdrawal checkpointed its snapshot");
    assert!(
        steering
            .iter()
            .any(|record| record.message == expected_text),
        "the revived row carries the re-rendered text: {steering:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A queued arrival row that covered only the withdrawn message drops its
/// now-empty wake while older waiting messages keep the reminder.
#[tokio::test]
async fn a_withdrawal_of_the_last_message_of_its_batch_drops_the_batches_row() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        inbox_notice(
            pa_core::session_engine::inbox::INBOX_CLASS_FACTORY_PROGRESS,
            "still waiting",
        ),
        Lane::Steering,
        || false,
    );
    // The older message's row delivered; its message stays waiting.
    let delivered = worker.core.lock().unwrap().steering.pop_front();
    assert!(delivered.is_some());
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &inbox,
        &arrivals,
        bash_done_notice(4321, "sleep 1"),
        Lane::Steering,
        || false,
    );
    assert_eq!(
        steering_rows(&worker).len(),
        1,
        "a fresh arrival row covers only the bash-done"
    );
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        Some((&inbox, &arrivals)),
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 1".to_string(),
        },
        None,
    );
    assert_eq!(
        inbox.count().0,
        1,
        "the older factory milestone is still waiting"
    );
    assert!(
        steering_rows(&worker).is_empty(),
        "the batch's row dropped with the collected message"
    );
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the dropped row settled the busy evidence"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A collection racing an arrival must not deadlock: the consumed
/// withdrawal and the arrival admission run on separate host-request
/// tasks, and the withdrawal takes the locks in the admission's order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_withdrawal_racing_an_arrival_settles_both() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.dispatch("clear_queue", &json!({})).await;
    for i in 0..200u32 {
        admit_inbox_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            &inbox,
            &arrivals,
            bash_done_notice(10_000 + i, "job a"),
            Lane::Steering,
            || false,
        );
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let admit = {
            let (worker, inbox, arrivals, notify, barrier, done_tx) = (
                Arc::clone(&worker),
                Arc::clone(&inbox),
                Arc::clone(&arrivals),
                Arc::clone(&notify),
                Arc::clone(&barrier),
                done_tx.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                admit_inbox_notice(
                    &worker.recovery,
                    &worker.core,
                    &notify,
                    &inbox,
                    &arrivals,
                    bash_done_notice(20_000 + i, "job b"),
                    Lane::Steering,
                    || false,
                );
                let _ = done_tx.send(());
            })
        };
        let withdraw = {
            let (worker, inbox, arrivals, barrier, done_tx) = (
                Arc::clone(&worker),
                Arc::clone(&inbox),
                Arc::clone(&arrivals),
                Arc::clone(&barrier),
                done_tx,
            );
            std::thread::spawn(move || {
                barrier.wait();
                withdraw_bash_completion_notice(
                    &worker.recovery,
                    &worker.core,
                    Some((&inbox, &arrivals)),
                    &crate::engine::BashConsumedNotice {
                        pid: 10_000 + i,
                        command: "job a".to_string(),
                    },
                    None,
                );
                let _ = done_tx.send(());
            })
        };
        for _ in 0..2 {
            assert!(
                done_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .is_ok(),
                "iteration {i}: the admission and the withdrawal deadlocked"
            );
        }
        admit.join().unwrap();
        withdraw.join().unwrap();
    }
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
        Lane::Steering,
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
