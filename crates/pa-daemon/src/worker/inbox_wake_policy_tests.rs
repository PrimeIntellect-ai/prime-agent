//! The inbox wake rules wired through the queue admission and the
//! runner's pickup: a row of only successes waits while other background
//! work runs and delivers when that work settles, anything else wakes at
//! once, other queued work takes a waiting row along, and a delivery
//! consumes the items it shows.
use super::inbox_queue_tests::{routing_state, steering_rows};
use super::inbox_router::only_successes;
use super::*;
use pa_core::session_engine::inbox::{InboxArrivals, InboxNotice, SessionInbox};

fn notice(class: &'static str, text: &str, exit_code: i64) -> InboxNotice {
    InboxNotice {
        class,
        sender: Some("sender".to_string()),
        text: text.to_string(),
        meta: json!({ "exitCode": exit_code }),
    }
}

fn bash_done(pid: u32, exit_code: i64) -> InboxNotice {
    notice(
        pa_types::inbox_notice::INBOX_CLASS_BASH_DONE,
        &format!("[bash-done pid:{pid} exit:{exit_code}]"),
        exit_code,
    )
}

fn admit(
    worker: &Worker,
    notify: &Arc<crate::worker::WorkNotify>,
    inbox: &Arc<SessionInbox>,
    arrivals: &InboxArrivals,
    notice: InboxNotice,
) {
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        notify,
        inbox,
        arrivals,
        notice,
        Lane::Steering,
        || false,
        None,
    )
    .expect("the admission succeeds");
}

/// Take the queued arrival row the way the runner's pickup does.
fn pick_up(
    worker: &Worker,
    arrivals: &InboxArrivals,
    inbox: &Arc<SessionInbox>,
) -> (String, Option<String>) {
    let mut core = worker.core.lock().unwrap();
    let mut item = core.steering.pop_front().expect("the queued arrival row");
    deliver_inbox_arrival_row_locked(&mut core, &mut item, arrivals, inbox);
    (item.message, item.preview)
}

/// Pick the row up and accept its transcript row, as a turn does.
fn deliver(
    worker: &Worker,
    arrivals: &InboxArrivals,
    inbox: &Arc<SessionInbox>,
) -> (String, Option<String>) {
    let delivered = pick_up(worker, arrivals, inbox);
    consume_shown_inbox_items_locked(&mut worker.core.lock().unwrap(), arrivals, inbox);
    delivered
}

/// Wake the runner and wait until it parks again: it re-read the queue
/// after every earlier admission. The bound is only the failure bound.
async fn after_runner_pass(worker: &Worker) {
    let parked = worker.idle_notify.notified();
    tokio::pin!(parked);
    parked.as_mut().enable();
    worker.work_notify.notify_one();
    tokio::time::timeout(Duration::from_secs(10), parked)
        .await
        .expect("the runner parks");
}

/// Wait until the runner took every queued row and parked idle.
async fn until_delivered(worker: &Worker) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let parked = worker.idle_notify.notified();
            tokio::pin!(parked);
            parked.as_mut().enable();
            {
                let core = worker.core.lock().unwrap();
                if !core.busy && core.steering.is_empty() {
                    return;
                }
            }
            parked.await;
        }
    })
    .await
    .expect("the runner delivers the row");
}

/// The real runner over the faux engine: with background work running, a
/// success-only row waits through every success; the work's settle
/// delivers it in one turn. A failure wakes at once while work still runs.
#[allow(clippy::await_holding_lock)] // the faux registry is process-global for this worker flow
#[tokio::test]
async fn a_success_only_row_waits_for_background_work_and_a_failure_wakes_at_once() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("pa-inbox-wake-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let worker = Arc::new(Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "wake-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "engine": "faux", "responses": ["ack", "ack"] })),
        },
        None,
    ));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.to_string_lossy(),
                "sessionDir": dir.join("sessions").to_string_lossy(),
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let engine = worker.agent_engine.clone().expect("the faux engine");
    engine
        .ensure_core_session_async(&engine.resolve_model().expect("faux model"))
        .await
        .expect("session build");
    let background_work = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe = Arc::clone(&background_work);
    engine.set_test_probes(
        Some(Arc::new(move || {
            probe.load(std::sync::atomic::Ordering::SeqCst)
        })),
        None,
    );
    let set_work = |count| background_work.store(count, std::sync::atomic::Ordering::SeqCst);
    let mut handlers = pa_core::kernel::shared::HostRequestHandlers::default();
    engine.register_kernel_notice_host_handlers(&mut handlers);
    let completion = handlers
        .get(pa_core::kernel::shared::BASH_COMPLETED_REQUEST_TYPE)
        .expect("the bash completion handler")
        .clone();
    let complete = |pid: u32, exit_code: i64| {
        completion(pa_core::kernel::shared::HostRequestPayload {
            data: json!({ "pid": pid, "command": "job", "exitCode": exit_code }),
        })
    };
    let inbox = engine.inbox().expect("the built session's inbox");

    // Two jobs run. Each success lands while other work still counts.
    set_work(2);
    complete(4001, 0).await.expect("the notice admits");
    after_runner_pass(&worker).await;
    set_work(1);
    complete(4002, 0).await.expect("the notice admits");
    after_runner_pass(&worker).await;
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one waiting row: {rows:?}");
    assert!(rows[0].0.contains("2 new"), "{rows:?}");

    // The last job settles: the kernel's settle wakes the runner.
    set_work(0);
    let settled = engine
        .background_work_settled_sink
        .lock()
        .unwrap()
        .clone()
        .expect("the worker wires the settle seam");
    settled();
    until_delivered(&worker).await;
    assert_eq!(inbox.count().0, 0, "the delivery consumed both successes");

    // A failure wakes at once, while work still runs.
    set_work(1);
    complete(4003, 1).await.expect("the notice admits");
    until_delivered(&worker).await;
    assert_eq!(inbox.count().0, 0, "the delivery consumed the failure");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_waking_arrival_joins_the_successes_and_wakes() {
    for waking in [
        bash_done(3, 7),
        notice(
            pa_types::inbox_notice::INBOX_CLASS_AGENT_MESSAGE,
            "hello",
            0,
        ),
        notice(
            pa_types::inbox_notice::INBOX_CLASS_CHILD_EXITED,
            "child done",
            0,
        ),
    ] {
        let (worker, inbox, arrivals, notify) = routing_state();
        admit(&worker, &notify, &inbox, &arrivals, bash_done(1, 0));
        admit(&worker, &notify, &inbox, &arrivals, bash_done(2, 0));
        assert!(only_successes(&arrivals.lock().unwrap()));
        admit(&worker, &notify, &inbox, &arrivals, waking);
        assert!(!only_successes(&arrivals.lock().unwrap()));
        let rows = steering_rows(&worker);
        assert_eq!(rows.len(), 1, "one row carries all three: {rows:?}");
        assert!(rows[0].0.contains("3 new"), "{rows:?}");
    }
}

#[tokio::test]
async fn other_queued_work_takes_a_waiting_row_along() {
    let (worker, inbox, arrivals, notify) = routing_state();
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1, 0));
    assert!(worker.core.lock().unwrap().inbox_row_holdable());
    worker.core.lock().unwrap().follow_up.push_back(QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "user prompt".to_string(),
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
    assert!(!worker.core.lock().unwrap().inbox_row_holdable());
}

#[tokio::test]
async fn a_delivery_consumes_what_it_shows_and_leaves_counted_items_waiting() {
    let (worker, inbox, arrivals, notify) = routing_state();
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1, 0));
    let (text, preview) = deliver(&worker, &arrivals, &inbox);
    assert_eq!(inbox.count().0, 0, "the shown item is consumed");
    assert!(
        text.contains("1 new message (bash-done); shown below and marked read; total waiting: 0.\n\n[bash-done pid:1 exit:0]"),
        "{text}"
    );
    assert!(!text.contains("rlm.inbox.read()"), "{text}");
    assert_eq!(preview.as_deref(), Some("Inbox: 1 new message (bash-done)"));
    let journal = std::fs::read_to_string(inbox.journal_path().unwrap()).unwrap();
    assert!(
        journal
            .lines()
            .last()
            .unwrap()
            .contains("\"kind\":\"withdrawn\""),
        "{journal}"
    );

    // Above the inline limit a success is one shown line; a failure is
    // only counted and waits for a read.
    admit(&worker, &notify, &inbox, &arrivals, bash_done(2, 0));
    admit(&worker, &notify, &inbox, &arrivals, bash_done(3, 0));
    admit(&worker, &notify, &inbox, &arrivals, bash_done(4, 7));
    let (text, _) = deliver(&worker, &arrivals, &inbox);
    assert_eq!(
        inbox
            .waiting_messages()
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>(),
        vec!["[bash-done pid:4 exit:7]"]
    );
    assert!(
        text.contains(
            "3 new bash-done messages; 2 shown below and marked read; total waiting: 1. \
             Read them with msgs = await rlm.inbox.read().\n\n\
             [bash-done pid:2 exit:0]\n[bash-done pid:3 exit:0]"
        ),
        "{text}"
    );
}

#[tokio::test]
async fn a_picked_row_that_is_never_accepted_leaves_its_items_waiting() {
    let (worker, inbox, arrivals, notify) = routing_state();
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1, 0));
    let (text, _) = pick_up(&worker, &arrivals, &inbox);
    assert!(text.contains("shown below and marked read"), "{text}");
    // The turn settles (an abort, a compaction) before the row is accepted.
    worker.core.lock().unwrap().inbox_shown_unaccepted.clear();
    assert_eq!(
        inbox
            .waiting_messages()
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>(),
        vec!["[bash-done pid:1 exit:0]"]
    );
}
