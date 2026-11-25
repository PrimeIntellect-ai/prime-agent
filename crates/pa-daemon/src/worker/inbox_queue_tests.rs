//! The inbox router's queue behavior: one arrival row announces every
//! waiting message the agent was not told about (its covers), reads and
//! withdrawals trim it, a closing session stores mail for its next open,
//! and the kill switch hands notices back for direct delivery.
use super::queue::{INBOX_ARRIVAL_QUEUE_KEY, INBOX_REMINDER_QUEUE_KEY};
use super::*;
use pa_core::session_engine::inbox::{InboxNotice, SessionInbox};
use pa_types::inbox_notice::{
    INBOX_CLASS_AGENT_MESSAGE, INBOX_CLASS_BASH_DONE, INBOX_CLASS_FACTORY_PROGRESS,
};

/// A worker over the faux engine (so it has an inbox router) whose
/// session's inbox is open; `created` is set directly so no build races
/// the test.
struct Fixture {
    worker: Arc<Worker>,
    inbox: Arc<SessionInbox>,
    dir: PathBuf,
}

impl Fixture {
    fn router(&self) -> &crate::agent_inbox::InboxRouter {
        self.worker
            .inbox_router
            .as_ref()
            .expect("the faux engine routes")
    }

    fn engine(&self) -> &Arc<crate::agent_engine::AgentSessionEngine> {
        self.worker.agent_engine.as_ref().expect("the faux engine")
    }

    fn route(&self, notice: InboxNotice, lane: Lane) -> bool {
        self.router()
            .route(notice, lane)
            .expect("the inbox is enabled")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn faux_worker_in(dir: &std::path::Path) -> Arc<Worker> {
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
    worker
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("pa-worker-inbox-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let worker = faux_worker_in(&dir);
    worker.core.lock().unwrap().created = true;
    let engine = worker.agent_engine.as_ref().expect("the faux engine");
    engine.set_session_file(dir.join("sessions").join("inbox-session.jsonl"));
    let inbox = engine.open_inbox();
    Fixture { worker, inbox, dir }
}

fn notice(class: &'static str, text: &str) -> InboxNotice {
    InboxNotice {
        class,
        sender: Some(format!("sender-{class}")),
        text: text.to_string(),
        meta: json!({ "text": text }),
    }
}

fn bash_done(pid: u32, command: &str) -> InboxNotice {
    InboxNotice {
        class: INBOX_CLASS_BASH_DONE,
        sender: Some(command.to_string()),
        text: format!("[bash-done pid:{pid} exit:0]"),
        meta: json!({ "pid": pid, "command": command, "exitCode": 0 }),
    }
}

/// One queued row: its lane, text, queue key, and arrival covers.
#[derive(Debug)]
struct Row {
    lane: Lane,
    text: String,
    key: Option<String>,
    covers: Vec<String>,
}

fn rows(worker: &Worker) -> Vec<Row> {
    let core = worker.core.lock().unwrap();
    let lane_rows = |lane: Lane, items: &VecDeque<QueuedItem>| -> Vec<Row> {
        items
            .iter()
            .map(|item| Row {
                lane,
                text: item.message.clone(),
                key: item.queue_key.clone(),
                covers: item
                    .custom_message
                    .as_ref()
                    .and_then(|row| row["details"]["covers"].as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect(),
            })
            .collect()
    };
    let mut rows = lane_rows(Lane::Steering, &core.steering);
    rows.extend(lane_rows(Lane::FollowUp, &core.follow_up));
    rows
}

fn waiting_ids(inbox: &SessionInbox) -> Vec<String> {
    inbox
        .waiting_messages()
        .into_iter()
        .map(|message| message.id)
        .collect()
}

async fn deliver_agent_message(worker: &Worker, message: &str) -> DaemonResponse {
    worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": message,
                "sender": { "activeSessionId": "peer-1" },
            }),
        )
        .await
}

fn write_inbox_settings(agent_dir: &std::path::Path, inbox: &Value) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "agentInbox": inbox }).to_string(),
    )
    .unwrap();
}

/// An idle session's arrival: the message waits in the store and one
/// invisible injected notice row announces it, its covers naming the
/// message.
#[tokio::test]
async fn an_idle_arrival_queues_one_injected_notice_covering_the_message() {
    let fx = fixture();
    let queued = fx.route(bash_done(4321, "sleep 1"), Lane::Steering);
    assert!(!queued, "an idle session takes the notice now");
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].key.as_deref(), Some(INBOX_ARRIVAL_QUEUE_KEY));
    assert_eq!(rows[0].covers, waiting_ids(&fx.inbox));
    assert!(
        rows[0].text.starts_with("[inbox ")
            && rows[0]
                .text
                .contains("1 new message (bash-done); total waiting: 1"),
        "{rows:?}"
    );
    let core = fx.worker.core.lock().unwrap();
    let item = core.steering.front().unwrap();
    assert!(!item.queue_visible);
    assert_eq!(item.policy, TurnPolicy::Injected);
    let row = item.custom_message.as_ref().unwrap();
    assert_eq!(
        row["customType"],
        json!(pa_types::inbox_notice::INBOX_NOTICE_CUSTOM_TYPE)
    );
    assert_eq!(row["content"], json!(item.message));
    drop(core);
    assert!(
        WorkerRecoveryJournal::read_interrupted(&fx.worker.config.recovery_journal_path),
        "the notice admission is live work"
    );
}

/// Arrivals coalesce into one row that keeps its place in the lane; a
/// steering arrival moves a follow-up row to steering, and a later
/// follow-up arrival never moves it back.
#[tokio::test]
async fn arrivals_coalesce_into_one_row_on_the_most_urgent_lane() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    assert!(fx.route(notice(INBOX_CLASS_BASH_DONE, "first"), Lane::FollowUp));
    fx.worker
        .core
        .lock()
        .unwrap()
        .follow_up
        .push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: "queued behind".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    fx.route(
        notice(INBOX_CLASS_FACTORY_PROGRESS, "second"),
        Lane::FollowUp,
    );
    let follow_up = rows(&fx.worker);
    assert_eq!(follow_up.len(), 2, "{follow_up:?}");
    assert_eq!(follow_up[0].key.as_deref(), Some(INBOX_ARRIVAL_QUEUE_KEY));
    assert_eq!(follow_up[0].covers.len(), 2, "the row kept its place");
    assert_eq!(follow_up[1].text, "queued behind");

    fx.route(notice(INBOX_CLASS_AGENT_MESSAGE, "third"), Lane::Steering);
    fx.route(notice(INBOX_CLASS_BASH_DONE, "fourth"), Lane::FollowUp);
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].lane, Lane::Steering);
    assert_eq!(rows[0].covers, waiting_ids(&fx.inbox));
    assert!(
        rows[0]
            .text
            .contains("4 new messages (2 bash-done, 1 factory-progress, 1 agent-message)"),
        "{rows:?}"
    );
    assert_eq!(
        (rows[1].lane, rows[1].text.as_str()),
        (Lane::FollowUp, "queued behind")
    );
}

/// A delivered row leaves the lane, so the next arrival starts a fresh
/// batch: the older message was announced already.
#[tokio::test]
async fn a_delivered_row_starts_a_fresh_batch() {
    let fx = fixture();
    fx.route(notice(INBOX_CLASS_BASH_DONE, "first"), Lane::Steering);
    assert!(fx
        .worker
        .core
        .lock()
        .unwrap()
        .steering
        .pop_front()
        .is_some());
    fx.route(
        notice(INBOX_CLASS_FACTORY_PROGRESS, "second"),
        Lane::Steering,
    );
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].covers, waiting_ids(&fx.inbox)[1..]);
    assert!(
        rows[0]
            .text
            .contains("1 new message (factory-progress); total waiting: 2"),
        "{rows:?}"
    );
}

/// Reads and withdrawals trim the wake rows to what still waits: a
/// partial read re-renders the arrival row and the reminder, and the
/// collected bash handle drops both once nothing waits.
#[tokio::test]
async fn reads_and_withdrawals_trim_the_wake_rows() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    fx.route(bash_done(7, "make"), Lane::Steering);
    fx.route(
        notice(INBOX_CLASS_FACTORY_PROGRESS, "milestone"),
        Lane::Steering,
    );
    fx.router().remind();
    assert_eq!(rows(&fx.worker).len(), 2, "arrival and reminder rows");

    let read = fx
        .inbox
        .withdraw_ids(&[waiting_ids(&fx.inbox)[1].clone()].into());
    assert_eq!(read.len(), 1);
    fx.router().refresh_after_read();
    let rows_after_read = rows(&fx.worker);
    assert_eq!(rows_after_read[0].covers, waiting_ids(&fx.inbox));
    assert!(rows_after_read[0]
        .text
        .contains("1 new message (bash-done); total waiting: 1"));
    assert_eq!(
        rows_after_read[1].text,
        pa_core::session_engine::inbox::reminder_notice(1)
    );

    withdraw_bash_completion_notice(
        &fx.worker.recovery,
        &fx.worker.core,
        &crate::engine::BashConsumedNotice {
            pid: 7,
            command: "make".to_string(),
        },
        Some(fx.engine().as_ref()),
    );
    assert!(rows(&fx.worker).is_empty(), "nothing waits, nothing wakes");
    assert_eq!(fx.inbox.count().0, 0);
}

/// The reminder queues one steering row while mail waits, replaces
/// itself instead of stacking, and never queues on a closed session or
/// an empty inbox.
#[tokio::test]
async fn the_reminder_follows_the_waiting_count() {
    let fx = fixture();
    fx.router().remind();
    assert!(rows(&fx.worker).is_empty(), "an empty inbox never reminds");
    fx.route(notice(INBOX_CLASS_BASH_DONE, "first"), Lane::Steering);
    fx.router().remind();
    fx.router().remind();
    let reminders: Vec<Row> = rows(&fx.worker)
        .into_iter()
        .filter(|row| row.key.as_deref() == Some(INBOX_REMINDER_QUEUE_KEY))
        .collect();
    assert_eq!(reminders.len(), 1, "{reminders:?}");
    assert_eq!(reminders[0].lane, Lane::Steering);
    fx.worker.dispatch("clear_queue", &json!({})).await;
    fx.engine().mark_session_closed();
    fx.router().remind();
    assert!(
        rows(&fx.worker)
            .iter()
            .all(|row| row.key.as_deref() != Some(INBOX_REMINDER_QUEUE_KEY)),
        "a closed session never reminds"
    );
}

/// `agentInbox.enabled: false` hands every notice back: the router
/// refuses, the agent message and the child notice park their full rows,
/// and nothing lands in the store.
#[tokio::test]
async fn the_kill_switch_hands_notices_back_for_direct_delivery() {
    let fx = fixture();
    write_inbox_settings(&fx.worker.config.agent_dir, &json!({ "enabled": false }));
    assert!(fx
        .router()
        .route(notice(INBOX_CLASS_BASH_DONE, "direct"), Lane::Steering)
        .is_none());
    assert!(deliver_agent_message(&fx.worker, "hello").await.success);
    let message = pa_core::session_engine::rlm_notices::create_rlm_child_failure_message(
        "sub-9", "lane", "boom", 1_000,
    );
    let text = message.content.text();
    let wire = serde_json::to_value(pa_types::session::AgentMessage::Custom(message)).unwrap();
    let parked = fx
        .worker
        .dispatch(
            "follow_up",
            &json!({
                "message": text,
                "customMessage": wire,
                "rlmNoticeNonce": crate::child_status_notices::mint(),
            }),
        )
        .await;
    assert!(parked.success, "{parked:?}");
    assert_eq!(fx.inbox.count().0, 0, "the disabled inbox takes nothing");
    let core = fx.worker.core.lock().unwrap();
    assert_eq!(
        core.steering.front().unwrap().agent_message.as_deref(),
        Some("hello")
    );
    assert_eq!(core.follow_up.front().unwrap().message, text);
}

/// A minted child-status row routes into the inbox like every machine
/// notice: one arrival row on the requested lane announces it.
#[tokio::test]
async fn a_minted_child_notice_routes_into_the_inbox() {
    let fx = fixture();
    let message = pa_core::session_engine::rlm_notices::create_rlm_child_failure_message(
        "sub-9", "lane", "boom", 1_000,
    );
    let wire =
        serde_json::to_value(pa_types::session::AgentMessage::Custom(message.clone())).unwrap();
    let routed = fx
        .worker
        .dispatch(
            "follow_up",
            &json!({
                "message": message.content.text(),
                "customMessage": wire,
                "rlmNoticeNonce": crate::child_status_notices::mint(),
            }),
        )
        .await;
    assert!(routed.success, "{routed:?}");
    let waiting = fx.inbox.waiting_messages();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].class, "child-failed");
    assert_eq!(waiting[0].sender.as_deref(), Some("lane"));
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].lane, Lane::FollowUp);
    assert!(rows[0].text.contains("1 new message (child-failed)"));
}

/// A closing session still takes deliveries: the agent message gets a
/// success receipt and waits in the inbox without a wake row (the lanes
/// belong to the session's teardown), and the session's next open
/// announces everything that waited with one notice.
#[tokio::test]
async fn a_closing_session_stores_mail_and_its_next_open_announces_it() {
    let fx = fixture();
    fx.engine().mark_session_closed();
    let delivered = deliver_agent_message(&fx.worker, "late reply").await;
    assert!(
        delivered.success,
        "never an error for the close window: {delivered:?}"
    );
    assert_eq!(delivered.data.unwrap()["deliveryStatus"], json!("queued"));
    fx.route(notice(INBOX_CLASS_BASH_DONE, "late"), Lane::Steering);
    assert_eq!(fx.inbox.count().0, 2);
    assert!(rows(&fx.worker).is_empty(), "no row while closing");

    fx.engine().clear_session_closed();
    fx.router().announce_waiting();
    fx.router().announce_waiting();
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "one notice, announced once: {rows:?}");
    assert_eq!(rows[0].covers, waiting_ids(&fx.inbox));
    assert!(rows[0].text.contains("2 new messages"), "{rows:?}");
}

/// Mail that waited in a session's inbox while no worker hosted it gets
/// one notice when a worker opens the session, and the store is open
/// from the create on: a delivery right after it lands in the inbox
/// before any build.
#[tokio::test]
async fn a_session_opened_over_waiting_mail_gets_one_notice() {
    let dir = std::env::temp_dir().join(format!("pa-worker-inbox-open-{}", uuid::Uuid::new_v4()));
    let sessions = dir.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let mut store = SessionFile::create("/tmp", None, 0);
    let path = sessions.join(session_file_name(store.session_id()));
    store.set_path(path.clone());
    store.rewrite().unwrap();
    {
        let waiting = SessionInbox::open(
            pa_core::session_engine::harness_digest::session_artifact_dir_for_log(&path).as_deref(),
        );
        waiting.push(notice(INBOX_CLASS_AGENT_MESSAGE, "while away"), 1_000);
        waiting.push(notice(INBOX_CLASS_BASH_DONE, "while away"), 2_000);
    }
    let worker = faux_worker_in(&dir);
    let created = worker
        .dispatch(
            "create",
            &json!({ "cwd": "/tmp", "sessionPath": path.display().to_string() }),
        )
        .await;
    assert!(created.success, "{created:?}");
    let inbox = worker
        .agent_engine
        .as_ref()
        .unwrap()
        .inbox()
        .expect("the create opened the session's inbox");
    // The notice is queued, or its injected turn already took it.
    let waiting = waiting_ids(&inbox);
    let announced = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let covered: Vec<Vec<String>> = rows(&worker)
                .into_iter()
                .filter(|row| row.key.as_deref() == Some(INBOX_ARRIVAL_QUEUE_KEY))
                .map(|row| row.covers)
                .collect();
            if !covered.is_empty() {
                return covered == [waiting.clone()];
            }
            if std::fs::read_to_string(&path).is_ok_and(|text| text.contains("2 new messages")) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await;
    assert_eq!(announced, Ok(true), "one notice covers the waiting mail");
    assert!(deliver_agent_message(&worker, "after open").await.success);
    // The open-time notice may have delivered (and consumed what it
    // showed) already; the new message waits out its debounce.
    assert!(
        inbox
            .waiting_messages()
            .iter()
            .any(|message| message.text.contains("after open")),
        "the delivery routed into the inbox"
    );
    let _ = worker.dispatch("kill", &json!({})).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// The covers ride the journaled row: a restored arrival row still knows
/// its batch, so a clear after a restart takes exactly the unannounced
/// agent messages, a pause takes none, and announced mail stays readable.
#[tokio::test]
async fn a_clear_takes_only_the_unannounced_batch_even_after_a_restore() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    assert!(deliver_agent_message(&fx.worker, "announced").await.success);
    assert!(fx
        .worker
        .core
        .lock()
        .unwrap()
        .steering
        .pop_front()
        .is_some());
    assert!(
        deliver_agent_message(&fx.worker, "unannounced")
            .await
            .success
    );
    let paused = fx.worker.dispatch("agent_messages_pause", &json!({})).await;
    assert!(paused.success, "{paused:?}");
    assert_eq!(fx.inbox.count().0, 2, "a pause leaves every inbox record");
    fx.worker
        .dispatch("agent_messages_resume", &json!({}))
        .await;

    let (steering, follow_up, _) = restore_queue_snapshot(
        fx.worker.recovery.lock().unwrap().as_ref().unwrap(),
        "target-session",
    );
    {
        let mut core = fx.worker.core.lock().unwrap();
        core.steering = steering;
        core.follow_up = follow_up;
    }
    let cleared = fx.worker.dispatch("agent_messages_clear", &json!({})).await;
    assert_eq!(
        cleared.data,
        Some(json!({ "steering": ["[agent-message from peer-1]\n\nunannounced"], "followUp": [] })),
    );
    let waiting: Vec<String> = fx
        .inbox
        .waiting_messages()
        .into_iter()
        .map(|message| message.text)
        .collect();
    assert_eq!(waiting, ["[agent-message from peer-1]\n\nannounced"]);
    assert!(
        rows(&fx.worker).is_empty(),
        "the emptied batch drops its row"
    );
}

/// `clear_queue` keeps the arrival row: it announces mail that still
/// waits, and nothing else would wake the agent for it.
#[tokio::test]
async fn clear_queue_keeps_the_arrival_row() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    fx.route(notice(INBOX_CLASS_BASH_DONE, "first"), Lane::Steering);
    fx.worker
        .dispatch("steer", &json!({ "message": "user text" }))
        .await;
    fx.worker.dispatch("clear_queue", &json!({})).await;
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].key.as_deref(), Some(INBOX_ARRIVAL_QUEUE_KEY));
}

/// The arrival row is daemon-owned: a `mutate_queued_message` replace
/// against it is refused, and the next arrival still coalesces into it.
#[tokio::test]
async fn a_replace_of_an_arrival_row_is_refused_and_the_next_arrival_coalesces() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    fx.route(notice(INBOX_CLASS_BASH_DONE, "first"), Lane::Steering);
    let preview = fx.worker.core.lock().unwrap().steering[0]
        .preview
        .clone()
        .unwrap();
    let refused = fx
        .worker
        .dispatch(
            "mutate_queued_message",
            &json!({
                "activeSessionId": "target-session",
                "lane": "steering",
                "index": 0,
                "expectedText": preview,
                "mutation": { "type": "replace", "text": "user instruction" },
            }),
        )
        .await;
    assert_eq!(
        refused.data,
        Some(json!({ "status": "rejected" })),
        "{refused:?}"
    );
    fx.route(
        notice(INBOX_CLASS_FACTORY_PROGRESS, "second"),
        Lane::Steering,
    );
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0]
        .text
        .contains("2 new messages (1 bash-done, 1 factory-progress)"));
}

/// A journal write failure names the memory-only degradation in the
/// arrival notice and the reminder.
#[tokio::test]
async fn a_journal_failure_marks_the_notice_memory_only() {
    let fx = fixture();
    let journal = pa_core::session_engine::harness_digest::session_artifact_dir_for_log(
        &fx.dir.join("sessions").join("inbox-session.jsonl"),
    )
    .unwrap()
    .join(pa_core::session_engine::inbox::INBOX_JOURNAL_FILE);
    let _ = std::fs::remove_file(&journal);
    // A directory in the journal's place fails the append even as root.
    std::fs::create_dir_all(&journal).unwrap();
    fx.route(bash_done(4321, "sleep 1"), Lane::Steering);
    fx.router().remind();
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 2, "{rows:?}");
    for row in &rows {
        assert!(
            row.text
                .ends_with(pa_core::session_engine::inbox::INBOX_PERSISTENCE_ERROR_CLAUSE),
            "{rows:?}"
        );
    }
}

/// The inbox store follows the session file: the same session keeps its
/// store, even a memory-only one whose journal could not be read, and
/// another session file opens its own.
#[tokio::test]
async fn the_inbox_store_follows_the_session_file() {
    let fx = fixture();
    assert!(Arc::ptr_eq(&fx.engine().open_inbox(), &fx.inbox));
    let broken = fx.dir.join("sessions").join("broken.jsonl");
    let journal = pa_core::session_engine::harness_digest::session_artifact_dir_for_log(&broken)
        .unwrap()
        .join(pa_core::session_engine::inbox::INBOX_JOURNAL_FILE);
    // A directory in the journal's place cannot be read.
    std::fs::create_dir_all(&journal).unwrap();
    fx.engine().set_session_file(broken);
    let memory_only = fx.engine().open_inbox();
    assert!(!Arc::ptr_eq(&memory_only, &fx.inbox));
    assert!(
        memory_only.persistence_error().is_some(),
        "the journal could not be read"
    );
    memory_only.push(notice(INBOX_CLASS_BASH_DONE, "kept"), 1_000);
    assert!(Arc::ptr_eq(&fx.engine().open_inbox(), &memory_only));
    assert_eq!(fx.engine().inbox().unwrap().count().0, 1);
}

/// A message sent while the session is being replaced reaches the new
/// session's inbox and is announced when the new session opens; the
/// outgoing session's inbox never sees it.
#[tokio::test]
async fn a_message_sent_during_a_replacement_reaches_the_new_session() {
    let fx = fixture();
    let successor = fx.dir.join("sessions").join("successor.jsonl");
    fx.worker
        .teardown_for_replacement(&successor)
        .await
        .expect("the teardown");
    let delivered = deliver_agent_message(&fx.worker, "mid-replacement").await;
    assert!(delivered.success, "{delivered:?}");
    assert_eq!(fx.inbox.count().0, 0, "the outgoing session never sees it");
    // The swap points the engine at the successor's file, then the
    // successor opens.
    fx.engine().set_session_file(successor);
    fx.worker.refresh_replaced_session_state().await;
    let inbox = fx.engine().inbox().expect("the successor's inbox");
    assert!(!Arc::ptr_eq(&inbox, &fx.inbox));
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].covers, waiting_ids(&inbox));
    assert!(
        rows[0].text.contains("1 new message (agent-message)"),
        "{rows:?}"
    );
}

/// Mail admitted just before a replacement moves to the new session: it
/// leaves the outgoing inbox, keeps its arrival time, and the new
/// session's open announces it.
#[tokio::test]
async fn mail_waiting_at_a_replacement_moves_to_the_new_session() {
    let fx = fixture();
    assert!(
        deliver_agent_message(&fx.worker, "just before")
            .await
            .success
    );
    let arrived_at = fx.inbox.waiting_messages()[0].arrived_at_ms;
    let successor = fx.dir.join("sessions").join("successor.jsonl");
    fx.worker
        .teardown_for_replacement(&successor)
        .await
        .expect("the teardown");
    assert_eq!(fx.inbox.count().0, 0, "the outgoing inbox gave it up");
    fx.engine().set_session_file(successor);
    fx.worker.refresh_replaced_session_state().await;
    let inbox = fx.engine().inbox().expect("the successor's inbox");
    let waiting = inbox.waiting_messages();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].arrived_at_ms, arrived_at);
    assert_eq!(waiting[0].meta["movedFrom"], json!("inbox-session/inbox-1"));
    let rows = rows(&fx.worker);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].covers, waiting_ids(&inbox));
}

/// A session build between the replacement's teardown and its file swap
/// keeps the new session's inbox: mail sent after the build still reaches
/// the new session.
#[tokio::test]
async fn a_build_during_a_replacement_keeps_the_new_sessions_inbox() {
    let fx = fixture();
    let successor = fx.dir.join("sessions").join("successor.jsonl");
    fx.worker
        .teardown_for_replacement(&successor)
        .await
        .expect("the teardown");
    let model = fx.engine().resolve_model().expect("the faux model");
    fx.engine()
        .ensure_core_session_async(&model)
        .await
        .expect("the build");
    assert!(
        deliver_agent_message(&fx.worker, "after the build")
            .await
            .success
    );
    fx.engine().set_session_file(successor);
    fx.worker.refresh_replaced_session_state().await;
    let inbox = fx.engine().inbox().expect("the successor's inbox");
    assert_eq!(inbox.count().0, 1, "the new session holds the mail");
}

/// A turn running at a replacement accepts no row once the mail moved:
/// the arrival row it picked shows mail the new session now announces, so
/// accepting that row would deliver the mail twice.
#[tokio::test]
async fn a_turn_running_at_a_replacement_accepts_no_row_after_the_mail_moves() {
    let fx = fixture();
    fx.route(notice(INBOX_CLASS_AGENT_MESSAGE, "shown"), Lane::Steering);
    {
        // The runner picked the arrival row: its turn shows the message.
        let mut core = fx.worker.core.lock().unwrap();
        let mut row = core.steering.pop_front().expect("the arrival row");
        deliver_inbox_arrival_row_locked(&mut core, &mut row, &fx.inbox);
        core.busy = true;
    }
    let successor = fx.dir.join("sessions").join("successor.jsonl");
    fx.worker.retire_for_replacement(&successor);
    assert_eq!(fx.inbox.count().0, 0, "the mail moved");
    assert!(
        fx.worker.core.lock().unwrap().abort_requested,
        "the running turn's row gate is shut"
    );
}

/// One cell-completion arrival (a `[cell-done]` message the
/// backgrounded cell's terminal notice pushed).
fn cell_done(cell_id: &str) -> InboxNotice {
    InboxNotice {
        class: pa_types::inbox_notice::INBOX_CLASS_CELL_DONE,
        sender: Some(cell_id.to_string()),
        text: format!("[cell-done id:{cell_id} status:ok duration:1.0s]"),
        meta: json!({ "cellId": cell_id, "status": "ok" }),
    }
}

/// The arrival row's stored bits: the wake eligibility and the pending
/// cell-delivery flag.
fn arrival_row_bits(worker: &Worker) -> Option<(bool, bool)> {
    let core = worker.core.lock().unwrap();
    let item = core
        .steering
        .iter()
        .find(|item| item.queue_key.as_deref() == Some(INBOX_ARRIVAL_QUEUE_KEY))?;
    let details = item.custom_message.as_ref()?.get("details")?;
    Some((
        details.get("wakesCell").and_then(Value::as_bool)?,
        details.get("coversCellDone").and_then(Value::as_bool)?,
    ))
}

/// A cell-done-only batch never marks its row wakeable (its delivery waits
/// for its own turn boundary), but it IS the covered cell's pending
/// delivery: the quiescence observation counts it. Withdrawing the only
/// wakeable message from a mixed batch flips the eligibility bit with the
/// row.
#[tokio::test]
async fn the_arrival_rows_cell_bits_follow_its_covered_batch() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    fx.route(cell_done("cell-1"), Lane::Steering);
    assert_eq!(arrival_row_bits(&fx.worker), Some((false, true)));
    assert_eq!(fx.worker.outstanding_background_jobs(), 1);

    fx.route(bash_done(4242, "sleep 2; echo done"), Lane::Steering);
    assert_eq!(arrival_row_bits(&fx.worker), Some((true, true)));
    withdraw_bash_completion_notice(
        &fx.worker.recovery,
        &fx.worker.core,
        &crate::engine::BashConsumedNotice {
            pid: 4242,
            command: "sleep 2; echo done".to_string(),
        },
        Some(fx.engine().as_ref()),
    );
    assert_eq!(
        arrival_row_bits(&fx.worker),
        Some((false, true)),
        "the withdrawn bash-done left a cell-done-only batch"
    );
    assert_eq!(fx.worker.outstanding_background_jobs(), 1);
}

/// A bash-only batch is wakeable but nobody's cell delivery, and a full
/// `[cell-done]` row queued on the steering lane (the inbox-disabled lane)
/// counts as a pending delivery.
#[tokio::test]
async fn the_full_row_and_bash_only_counts_pin_the_quiescence_observation() {
    let fx = fixture();
    fx.worker.core.lock().unwrap().busy = true;
    fx.route(bash_done(7777, "echo only"), Lane::Steering);
    assert_eq!(arrival_row_bits(&fx.worker), Some((true, false)));
    assert_eq!(fx.worker.outstanding_background_jobs(), 0);
    fx.worker
        .core
        .lock()
        .unwrap()
        .steering
        .push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: Some("[cell-done]".to_string()),
            message: "[cell-done id:cell-9 status:ok duration:1.0s]".to_string(),
            custom_message: Some(
                serde_json::to_value(
                    pa_core::session_engine::messages::create_background_cell_completion_message(
                        "cell-9",
                        "ok",
                        1_000,
                        "wait-budget:1000",
                        "done",
                        &[],
                        0,
                    ),
                )
                .expect("the full cell-done row"),
            ),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    assert_eq!(fx.worker.outstanding_background_jobs(), 1);
}

/// The wake predicate classifies the queued rows: a bash-done arrival row
/// is wakeable input, a cell-done-only arrival row is not (its own turn
/// boundary delivers it), a backgrounded cell's full completion row is
/// not, and a restored arrival row without the stored bit stays
/// conservatively wakeable.
#[test]
fn the_wake_predicate_classifies_the_queued_rows() {
    fn item(custom_message: Option<serde_json::Value>) -> QueuedItem {
        QueuedItem {
            priority: crate::worker::QueuePriority::Background,
            preview: None,
            message: "row".to_string(),
            custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: crate::worker::TurnPolicy::Injected,
            forced_batch: false,
        }
    }
    // A plain user row (no custom twin) is wakeable.
    assert!(row_wakes_a_cell(&item(None)));
    // A bash-done arrival row (the stored bit from a wakeable batch) is wakeable.
    let bash_arrival = pa_core::session_engine::inbox::create_inbox_notice_row(
        "[inbox 12:00 UTC] 1 new message (bash-done)",
        pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL,
        1,
        true,
        false,
        1_730_000_000_000,
    );
    assert!(row_wakes_a_cell(&item(Some(bash_arrival))));
    // A cell-done-only arrival batch never ends a running cell's wait.
    let cell_only_arrival = pa_core::session_engine::inbox::create_inbox_notice_row(
        "[inbox 12:00 UTC] 1 new message (cell-done)",
        pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL,
        1,
        false,
        false,
        1_730_000_000_000,
    );
    assert!(!row_wakes_a_cell(&item(Some(cell_only_arrival))));
    // A backgrounded cell's own completion row never wakes a later cell.
    let cell_done_row = serde_json::to_value(
        pa_core::session_engine::messages::create_background_cell_completion_message(
            "cell-1",
            "ok",
            1_200,
            "wait-budget:200",
            "done",
            &[],
            1_730_000_000_000,
        ),
    )
    .unwrap();
    assert!(!row_wakes_a_cell(&item(Some(cell_done_row))));
    // A restored arrival row without the eligibility bit is conservatively
    // wakeable: one extra detach, never a lost steer.
    let mut restored = pa_core::session_engine::inbox::create_inbox_notice_row(
        "[inbox 12:00 UTC] 1 new message (cell-done)",
        pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL,
        1,
        true,
        false,
        1_730_000_000_000,
    );
    restored
        .get_mut("details")
        .and_then(serde_json::Value::as_object_mut)
        .unwrap()
        .remove("wakesCell");
    assert!(row_wakes_a_cell(&item(Some(restored))));
}
