//! The inbox wake rules wired through the queue admission and the
//! runner's pickup: a success-only idle wake is held (never dropped) and
//! delivers at its hold expiry, a waking arrival flushes the held
//! successes into its own row, a run cut at a tool boundary continues at
//! once while a run that ended on its own holds the successes that landed
//! during it, and a delivery consumes the items it shows.
use super::inbox_queue_tests::{routing_state, steering_rows};
use super::*;
use pa_core::session_engine::inbox::{InboxArrivals, InboxNotice, SessionInbox};

/// The default `agentInbox.successHoldMs` (30 s) and `idleDebounceMs` (5 s).
const HOLD: Duration = Duration::from_secs(30);
const DEBOUNCE: Duration = Duration::from_secs(5);
const JUST_BEFORE_THE_HOLD: Duration = Duration::from_millis(29_999);

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
    admit_on(worker, notify, inbox, arrivals, notice, Lane::Steering);
}

fn admit_on(
    worker: &Worker,
    notify: &Arc<crate::worker::WorkNotify>,
    inbox: &Arc<SessionInbox>,
    arrivals: &InboxArrivals,
    notice: InboxNotice,
    lane: Lane,
) {
    admit_inbox_notice(
        &worker.recovery,
        &worker.core,
        notify,
        inbox,
        arrivals,
        notice,
        lane,
        || false,
        None,
    )
    .expect("the admission succeeds");
}

fn hold(worker: &Worker) -> Option<tokio::time::Instant> {
    worker
        .core
        .lock()
        .unwrap()
        .inbox_wake_hold(tokio::time::Instant::now())
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

#[tokio::test(start_paused = true)]
async fn an_idle_success_is_held_and_delivers_at_the_hold_expiry() {
    let (worker, inbox, arrivals, _) = routing_state();
    let start = tokio::time::Instant::now();
    // The worker's own runner takes the row: it parks until the due time.
    admit(
        &worker,
        &worker.work_notify,
        &inbox,
        &arrivals,
        bash_done(1, 0),
    );
    assert_eq!(hold(&worker), Some(start + HOLD));
    tokio::time::advance(JUST_BEFORE_THE_HOLD).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        steering_rows(&worker).len(),
        1,
        "held, neither dropped nor delivered early"
    );
    tokio::time::advance(Duration::from_millis(1)).await;
    // The runner parks again after it takes the row; register before the
    // check, so a park between the two still wakes this waiter.
    loop {
        let parked = worker.idle_notify.notified();
        if steering_rows(&worker).is_empty() {
            break;
        }
        parked.await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_waking_arrival_flushes_the_held_successes_into_its_row() {
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
        tokio::time::advance(Duration::from_secs(10)).await;
        admit(&worker, &notify, &inbox, &arrivals, bash_done(2, 0));
        let flushed_at = tokio::time::Instant::now();
        admit(&worker, &notify, &inbox, &arrivals, waking);
        assert_eq!(hold(&worker), Some(flushed_at + DEBOUNCE));
        let rows = steering_rows(&worker);
        assert_eq!(rows.len(), 1, "one row carries all three: {rows:?}");
        assert!(rows[0].0.contains("3 new"), "{rows:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_success_landing_in_a_turn_joins_it_or_is_held_after_it() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.core.lock().unwrap().busy = true;
    let start = tokio::time::Instant::now();
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1, 0));
    // The run was cut at a tool boundary: the row continues the turn now.
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = false;
        core.run_cut_at_tool_boundary = true;
    }
    assert_eq!(hold(&worker), None);
    // The run ended on its own: no fresh turn for the success alone.
    worker.core.lock().unwrap().run_cut_at_tool_boundary = false;
    assert_eq!(hold(&worker), Some(start + HOLD));
    // Any other queued work starts a turn the held row joins.
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
    assert_eq!(hold(&worker), None);
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

#[tokio::test(start_paused = true)]
async fn a_sole_follow_up_arrival_waits_out_the_debounce() {
    let (worker, inbox, arrivals, notify) = routing_state();
    let start = tokio::time::Instant::now();
    admit_on(
        &worker,
        &notify,
        &inbox,
        &arrivals,
        notice(
            pa_types::inbox_notice::INBOX_CLASS_AGENT_MESSAGE,
            "hello",
            0,
        ),
        Lane::FollowUp,
    );
    assert_eq!(hold(&worker), Some(start + DEBOUNCE));
}
