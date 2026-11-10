//! The idle-kill gate tests: the close's ownership of the session and
//! the attached-client refusal.
use super::*;
use serde_json::json;

fn idle_kill_worker() -> Arc<Worker> {
    let dir = tempfile::tempdir().unwrap();
    Arc::new(Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "idle-kill-token".into(),
            worker_instance_id: String::new(),
            active_session_id: "idle-kill".into(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [{ "text": "must survive", "delayMs": 60000 }] })),
        },
        None,
    ))
}

/// The idle kill's close owns the session from its decision: a foreign
/// prompt dispatched while the close still settles its side questions
/// is refused — the close never acknowledges work it then destroys.
#[tokio::test]
async fn kill_if_idle_never_accepts_then_discards_a_foreign_prompt() {
    let worker = idle_kill_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": std::env::temp_dir().to_str().unwrap() }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let question = worker
        .dispatch(
            "start_side_question",
            &json!({
                "sideQuestionId": "question",
                "question": "hold the close",
                "clientId": "foreign-client"
            }),
        )
        .await;
    assert!(question.success, "the side question started: {question:?}");
    // The kill parks on the side-question settlement: the poll proves
    // the close is in flight before the foreign prompt races it.
    let kill_payload = json!({ "reason": "killed" });
    let kill = worker.dispatch("kill_if_idle", &kill_payload);
    tokio::pin!(kill);
    let initial_poll = std::future::poll_fn(|cx| {
        std::task::Poll::Ready(std::future::Future::poll(kill.as_mut(), cx))
    })
    .await;
    assert!(
        initial_poll.is_pending(),
        "the close waits for the side question's settlement"
    );
    let accepted = worker
        .dispatch(
            "prompt",
            &json!({ "message": "foreign work after the idle check" }),
        )
        .await;
    let stopped = kill.await;
    assert!(
        !accepted.success,
        "the close owns the session from its decision — a prompt admitted behind it is refused, never accepted and then discarded: {accepted:?} (kill: {stopped:?})"
    );
    let after = {
        let core = worker.core.lock().unwrap();
        (core.created, core.steering.len(), core.follow_up.len())
    };
    assert_eq!(
        after,
        (false, 0, 0),
        "the closed session holds no admitted row the close destroyed"
    );
}

/// A live attached client refuses the idle kill: the A2A link detaches
/// before it asks, so any attached client left is a foreign observer
/// whose connection a reclamation never drops.
#[tokio::test]
async fn kill_if_idle_refuses_a_session_with_an_attached_client() {
    let worker = idle_kill_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": std::env::temp_dir().to_str().unwrap() }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let observer = worker
        .dispatch("attach", &json!({ "clientId": "observer" }))
        .await;
    assert!(observer.success, "the observer attached: {observer:?}");
    let refused = worker
        .dispatch("kill_if_idle", &json!({ "reason": "killed" }))
        .await;
    assert!(
        !refused.success
            && refused
                .error
                .as_deref()
                .is_some_and(|error| error.contains(crate::worker::KILL_IF_IDLE_HAS_CLIENT)),
        "the attached client refuses the idle kill: {refused:?}"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(core.created, "the refused kill leaves the session live");
    }
    let detached = worker
        .dispatch("detach", &json!({ "clientId": "observer" }))
        .await;
    assert!(detached.success, "the observer detached: {detached:?}");
    let killed = worker
        .dispatch("kill_if_idle", &json!({ "reason": "killed" }))
        .await;
    assert!(killed.success, "the detached session closes: {killed:?}");
}

/// The engine's minted continuation carries the running delivery's own
/// client identity: a withdrawal naming that id (the A2A cancel of the
/// task the delivery named) sweeps the queued continuation row like
/// any owned row.
#[tokio::test]
async fn a_minted_goal_continuation_carries_the_running_delivery_client_id() {
    let worker = idle_kill_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": std::env::temp_dir().to_str().unwrap() }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // The running turn names the delivery (the A2A task id).
    {
        let mut core = worker.core.lock().unwrap();
        core.running_client_admissions = vec!["task-1".to_string()];
    }
    admit_goal_follow_up(
        &worker.recovery,
        &worker.core,
        &worker.events,
        &worker.work_notify,
        crate::engine::GoalTurnEndWork::Continuation(crate::engine::GoalContinuation {
            request: crate::engine::PromptRequest {
                batch: Vec::new(),
                message: "continue the goal".to_string(),
                images: Vec::new(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            goal_update: None,
            pending_handle: None,
        }),
    );
    let owner = {
        let core = worker.core.lock().unwrap();
        core.follow_up
            .front()
            .and_then(|item| item.client_admission_id.clone())
    };
    assert_eq!(
        owner.as_deref(),
        Some("task-1"),
        "the minted continuation carries the running delivery's client id"
    );
    // The identity-scoped withdrawal takes the row.
    let withdrawn = worker
        .dispatch("withdraw_admission", &json!({ "admissionId": "task-1" }))
        .await;
    assert!(withdrawn.success, "the withdrawal answers: {withdrawn:?}");
    let swept = withdrawn
        .data
        .as_ref()
        .and_then(|data| data.get("followUp"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    assert_eq!(
        swept, 1,
        "the withdrawal swept the stamped continuation row: {withdrawn:?}"
    );
    let core = worker.core.lock().unwrap();
    assert!(
        core.follow_up.is_empty() && core.steering.is_empty(),
        "the swept row left the lanes"
    );
}

/// The withdrawal's abort of a running turn carries the same TS
/// `requestAbort()` suspension the bare abort sets: the goal driver's
/// re-mint gate reads it at the aborted boundary (a withdrawn loop
/// does not mint its next continuation), and the resume sites (a
/// prompt carrying a streaming behavior — every A2A send does) clear
/// it exactly like the abort's.
#[tokio::test]
async fn a_withdrawn_running_turns_goal_loop_stays_suspended() {
    let worker = idle_kill_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": std::env::temp_dir().to_str().unwrap() }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // The running turn anchors the task's delivery identity (either
    // half — the set carries the wire and the client ids).
    {
        let mut core = worker.core.lock().unwrap();
        core.running_admission_ids.insert("task-1".to_string());
    }
    let withdrawn = worker
        .dispatch("withdraw_admission", &json!({ "admissionId": "task-1" }))
        .await;
    assert!(withdrawn.success, "the withdrawal answers: {withdrawn:?}");
    let aborted = withdrawn
        .data
        .as_ref()
        .and_then(|data| data.get("aborted"))
        .and_then(Value::as_bool);
    assert_eq!(aborted, Some(true), "the anchored running turn aborted");
    let core = worker.core.lock().unwrap();
    assert!(
        core.queued_input_suspended,
        "the withdrawn turn's abort suspends the queued input (the goal driver's re-mint gate)"
    );
}
