//! The inbox wake rules wired through the queue admission: an idle
//! session wakes for every unread arrival once the debounce window ends,
//! a burst inside the window makes one wake whose row names the count and
//! the kinds, and a busy session folds arrivals into the one queued row.
use super::inbox_queue_tests::{routing_state, steering_rows};
use super::*;
use pa_core::session_engine::inbox::{InboxArrivals, InboxNotice, SessionInbox};

/// Just short of the default `agentInbox.idleDebounceMs` (5 s).
const INSIDE_THE_WINDOW: Duration = Duration::from_millis(4_999);

fn notice(class: &'static str, text: &str) -> InboxNotice {
    InboxNotice {
        class,
        sender: Some("sender".to_string()),
        text: text.to_string(),
        meta: json!({ "exitCode": 0 }),
    }
}

fn bash_done(pid: u32) -> InboxNotice {
    notice(
        pa_types::inbox_notice::INBOX_CLASS_BASH_DONE,
        &format!("[bash-done pid:{pid} exit:0]"),
    )
}

fn admit(
    worker: &Worker,
    notify: &Arc<Notify>,
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

async fn woken_within(notify: &Notify, window: Duration) -> bool {
    tokio::time::timeout(window, notify.notified())
        .await
        .is_ok()
}

/// The stall guard: an agent that ended its turn to wait for a short
/// successful command is woken by it, once the window ends.
#[tokio::test(start_paused = true)]
async fn an_idle_short_success_wakes_once_the_debounce_window_ends() {
    let (worker, inbox, arrivals, notify) = routing_state();
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1));
    assert_eq!(steering_rows(&worker).len(), 1);
    assert!(!woken_within(&notify, INSIDE_THE_WINDOW).await);
    assert!(woken_within(&notify, Duration::from_millis(2)).await);
}

#[tokio::test(start_paused = true)]
async fn five_idle_arrivals_inside_the_window_make_one_wake_naming_count_and_kinds() {
    let (worker, inbox, arrivals, notify) = routing_state();
    for pid in 1..=4 {
        admit(&worker, &notify, &inbox, &arrivals, bash_done(pid));
    }
    admit(
        &worker,
        &notify,
        &inbox,
        &arrivals,
        notice(pa_types::inbox_notice::INBOX_CLASS_AGENT_MESSAGE, "hello"),
    );
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one row covers all five: {rows:?}");
    assert!(
        rows[0]
            .0
            .contains("5 new messages (4 bash-done, 1 agent-message); total waiting: 5."),
        "{rows:?}"
    );
    assert!(!woken_within(&notify, INSIDE_THE_WINDOW).await);
    assert!(woken_within(&notify, Duration::from_millis(2)).await);
    assert!(
        !woken_within(&notify, Duration::from_secs(600)).await,
        "the later arrivals add no wake"
    );
}

#[tokio::test(start_paused = true)]
async fn busy_arrivals_fold_into_one_row_without_a_debounce() {
    let (worker, inbox, arrivals, notify) = routing_state();
    worker.core.lock().unwrap().busy = true;
    admit(&worker, &notify, &inbox, &arrivals, bash_done(1));
    admit(&worker, &notify, &inbox, &arrivals, bash_done(2));
    let rows = steering_rows(&worker);
    assert_eq!(rows.len(), 1, "one folded row: {rows:?}");
    assert!(rows[0].0.contains("2 new bash-done messages"), "{rows:?}");
    assert!(woken_within(&notify, Duration::from_millis(1)).await);
}
