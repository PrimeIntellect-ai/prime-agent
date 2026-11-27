//! The inbox wake rules wired through the queue admission and the
//! runner's pickup: only a row of successes may wait (the real daemon e2e
//! `agent_inbox_e2e` covers the same-cell hold), other queued work takes a
//! waiting row along, and a delivery consumes the items it shows.
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
