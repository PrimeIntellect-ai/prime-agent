//! The inbox routing's queue tests: an arrival lands one short steering
//! notice (the message in the durable store), busy-window arrivals
//! coalesce into one queued row, a delivered row frees the next batch,
//! and the periodic reminder repeats while the inbox stays unread.
use super::queue::INBOX_ARRIVAL_QUEUE_KEY;
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
fn routing_state() -> (
    Arc<Worker>,
    Arc<SessionInbox>,
    Arc<Mutex<Vec<pa_core::session_engine::inbox::InboxMessage>>>,
    Arc<Notify>,
) {
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
