//! The identity-scoped withdraw and the idle-kill gate (the A2A cancel
//! sweep's and the LRU reclamation's worker-side contracts).
use super::*;

/// One queued row with an admission identity.
fn admitted_item(message: &str, wire: &str, client: &str) -> QueuedItem {
    QueuedItem {
        message: message.to_string(),
        priority: QueuePriority::Human,
        preview: None,
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: Some(wire.to_string()),
        client_admission_id: Some(client.to_string()),
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
    }
}

/// `withdraw_admission` takes ONLY the deliveries the admission named —
/// the A2A conversation's own queued rows — and every other client's
/// row (its own admission, its plain `follow_up`) survives: the cancel
/// sweep never clears the shared session's queue.
#[tokio::test]
async fn withdraw_admission_takes_only_the_named_deliveries() {
    let worker = created_dispatch_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        core.steering.push_back(admitted_item(
            "the conversation's steer",
            "supervisor-admission:wire-1",
            "task-1",
        ));
        core.follow_up.push_back(admitted_item(
            "another client's admission prompt",
            "supervisor-admission:wire-2",
            "other-task",
        ));
        core.follow_up.push_back({
            let mut item = admitted_item(
                "an unattached client's queued question",
                "supervisor-admission:wire-1",
                "task-1",
            );
            item.admission_id = None;
            item.client_admission_id = None;
            item
        });
    }
    let withdrawn = worker
        .dispatch("withdraw_admission", &json!({ "admissionId": "task-1" }))
        .await;
    assert!(withdrawn.success, "withdraw failed: {withdrawn:?}");
    assert_eq!(
        withdrawn
            .data
            .as_ref()
            .and_then(|data| data.get("steering")),
        Some(&json!(["the conversation's steer"])),
        "the task's own queued steer row is the one withdrawn: {withdrawn:?}"
    );
    assert_eq!(
        withdrawn
            .data
            .as_ref()
            .and_then(|data| data.get("followUp")),
        Some(&json!([])),
        "the foreign rows never leave the queue: {withdrawn:?}"
    );
    let queue = worker.dispatch("get_queue", &json!({})).await;
    assert_eq!(
        queue.data.as_ref().and_then(|data| data.get("followUp")),
        Some(&json!([
            "another client's admission prompt",
            "an unattached client's queued question"
        ])),
        "the other clients' queued rows survive the withdraw: {queue:?}"
    );
    assert_eq!(
        queue.data.as_ref().and_then(|data| data.get("steering")),
        Some(&json!([])),
        "the withdrawn row is gone from the lane: {queue:?}"
    );
}

/// The withdraw matches EITHER half of the delivery's identity (the
/// wire admission id the supervisor assigned or the client's own id):
/// the supervisor's admission cancel names the wire half.
#[tokio::test]
async fn withdraw_admission_matches_the_wire_identity_too() {
    let worker = created_dispatch_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        core.steering.push_back(admitted_item(
            "the conversation's steer",
            "supervisor-admission:wire-1",
            "task-1",
        ));
        core.follow_up.push_back(admitted_item(
            "another client's admission prompt",
            "supervisor-admission:wire-2",
            "other-task",
        ));
    }
    let withdrawn = worker
        .dispatch(
            "withdraw_admission",
            &json!({ "admissionId": "supervisor-admission:wire-1" }),
        )
        .await;
    assert!(withdrawn.success, "withdraw failed: {withdrawn:?}");
    assert_eq!(
        withdrawn
            .data
            .as_ref()
            .and_then(|data| data.get("steering")),
        Some(&json!(["the conversation's steer"])),
        "the wire-named delivery withdraws: {withdrawn:?}"
    );
    let queue = worker.dispatch("get_queue", &json!({})).await;
    assert_eq!(
        queue.data.as_ref().and_then(|data| data.get("followUp")),
        Some(&json!(["another client's admission prompt"])),
        "the foreign admission row survives: {queue:?}"
    );
}

/// `kill_if_idle` refuses a session holding work — the idle check and
/// the destructive stop are ONE worker-owned decision, so a queued row
/// (another client's) never dies to a reclamation that read an earlier
/// idle row; an idle session stops.
#[tokio::test]
async fn kill_if_idle_refuses_a_session_holding_work() {
    let worker = created_dispatch_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        core.follow_up.push_back(admitted_item(
            "an unattached client's queued question",
            "supervisor-admission:wire-9",
            "task-9",
        ));
    }
    let refused = worker
        .dispatch("kill_if_idle", &json!({ "reason": "killed" }))
        .await;
    assert!(
        !refused.success,
        "a session holding queued work refuses the idle kill: {refused:?}"
    );
    let queue = worker.dispatch("get_queue", &json!({})).await;
    assert_eq!(
        queue.data.as_ref().and_then(|data| data.get("followUp")),
        Some(&json!(["an unattached client's queued question"])),
        "the queued row survives the refused kill: {queue:?}"
    );

    let idle = created_dispatch_worker().await;
    let stopped = idle
        .dispatch("kill_if_idle", &json!({ "reason": "killed" }))
        .await;
    assert!(stopped.success, "an idle session stops: {stopped:?}");
}

/// `CancelTask` stops the task's own post-children goal loop: the RLM
/// terminal notice's turn runs with the spawning delivery's stamp (the
/// daemon stamps the delivery's id on the notice row), the goal
/// continuation owed behind the children mints with the same stamp at
/// that turn's end, and the identity-scoped withdraw of the task id
/// sweeps the queued continuation and aborts the running notice turn —
/// never the -32002 refusal the unstamped row earned.
#[tokio::test]
async fn a_cancel_withdraws_the_tasks_post_children_goal_loop() {
    let worker = created_dispatch_worker().await;
    // The notice row exactly as the daemon delivers it for children
    // spawned by the task's own delivery: the reserved custom kind with
    // the spawning delivery's `clientAdmissionId`.
    let notice = QueuedItem {
        message: "child finished".to_string(),
        priority: QueuePriority::Background,
        preview: None,
        custom_message: Some(json!({
            "role": "custom",
            "customType": pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
            "content": "child finished",
            "display": true,
            "timestamp": 0
        })),
        agent_message: None,
        queue_key: None,
        admission_id: None,
        client_admission_id: Some("task-1".to_string()),
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        let items = vec![notice];
        // The real pickup's identity functions over the real row.
        core.running_admission_ids = running_admission_ids(&items);
        core.running_client_admissions = running_client_admissions(&items);
        core.running_wire_admissions = running_wire_admissions(&items);
        core.busy = true;
    }
    // The goal continuation owed behind the children mints at the
    // notice turn's end with the running delivery's stamp.
    admit_goal_follow_up(
        &worker.recovery,
        &worker.core,
        &worker.events,
        &worker.work_notify,
        crate::engine::GoalTurnEndWork::Continuation(crate::engine::GoalContinuation {
            request: crate::engine::PromptRequest {
                batch: Vec::new(),
                message: "goal continuation".to_string(),
                images: Vec::new(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            goal_update: None,
            pending_handle: None,
        }),
    );
    {
        let core = worker.core.lock().unwrap();
        let owed = core.follow_up.front().expect("the owed continuation");
        assert_eq!(
            owed.client_admission_id.as_deref(),
            Some("task-1"),
            "the post-children continuation carries the task's id: {owed:?}"
        );
    }
    let withdrawn = worker
        .dispatch("withdraw_admission", &json!({ "admissionId": "task-1" }))
        .await;
    let data = withdrawn.data.clone().unwrap_or_default();
    let swept = data["followUp"]
        .as_array()
        .is_some_and(|rows| !rows.is_empty())
        || data["steering"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty());
    let aborted = data["aborted"].as_bool().unwrap_or(false);
    assert!(
        swept && aborted,
        "the task's cancel stops its own post-children goal loop: {withdrawn:?}"
    );
}
