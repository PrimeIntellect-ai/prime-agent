//! Real withdrawal commands preserve active/remaining work and clear the last idle note.
use super::*;

#[tokio::test]
async fn queue_withdrawals_clear_only_the_last_idle_notes() {
    for command in [
        "mutate_queued_message",
        "cancel_prompt_admission",
        "agent_messages_pause",
        "agent_messages_clear",
        "bash_consumed",
        "inbox_drain",
        "abort",
    ] {
        for state in ["last", "busy", "remaining"] {
            let dir = tempfile::tempdir().unwrap();
            let engine = Arc::new(NoteWitnessEngine::default());
            let mut worker = Worker::new(
                WorkerConfig {
                    socket_path: dir.path().join("worker.sock"),
                    supervisor_socket_path: dir.path().join("supervisor.sock"),
                    token: "token".to_string(),
                    worker_instance_id: String::new(),
                    active_session_id: "withdraw-note".to_string(),
                    agent_dir: dir.path().join("agent"),
                    recovery_journal_path: dir.path().join("recovery.jsonl"),
                    telemetry_disabled: Some(true),
                    script: Some(json!({ "responses": ["unused"] })),
                },
                None,
            );
            worker.engine = engine.clone();
            let (roster_pushes, publication_pending) =
                crate::roster_activity::RosterPushQueue::observed_for_test();
            worker.roster_pushes = roster_pushes;
            // Represent a run whose AgentEnd retained its note for queued work.
            *engine.note.lock().unwrap() = Some("checking deployment".to_string());
            worker.register_prompt_admission("owned-note");
            assert!(worker.prompt_admissions.commit("owned-note"));
            {
                let mut core = worker.core.lock().unwrap();
                core.created = true;
                core.busy = state == "busy";
                core.queued_input_suspended = true;
                if !matches!(command, "bash_consumed" | "inbox_drain") {
                    let mut row = queued_prompt("withdraw me", TurnPolicy::Queued);
                    row.admission_id = Some("owned-note".to_string());
                    if command.starts_with("agent_messages_") {
                        row.agent_message = Some("message-note".to_string());
                    }
                    if command == "abort" {
                        row.queue_visible = false;
                    }
                    core.follow_up.push_back(row);
                }
                if state == "remaining" {
                    let mut row = queued_prompt("keep me", TurnPolicy::Queued);
                    row.queue_visible = true;
                    core.steering.push_back(row);
                }
            }
            if command == "bash_consumed" {
                admit_kernel_notice(
                    &worker.recovery,
                    &worker.core,
                    &Arc::new(crate::worker::WorkNotify::new(Arc::default())),
                    crate::engine::KernelNotice::bash_completion(4321, "fixture command", 0),
                    || false,
                );
                withdraw_bash_completion_notice(
                    &worker.recovery,
                    &worker.core,
                    /*inbox*/
                    None, // The direct steering lane carries no inbox store.
                    &crate::engine::BashConsumedNotice {
                        pid: 4321,
                        command: "fixture command".to_string(),
                    },
                    Some(engine.as_ref()),
                );
            } else if command == "inbox_drain" {
                // THE DRAIN SWEEP'S CLEAR: a background kernel task's
                // `rlm.inbox.read` drained the store and fired the sweep
                // while the queued wake row was the session's last work —
                // the clear belongs to that sweep, at the drain.
                let inbox = Arc::new(pa_core::session_engine::inbox::SessionInbox::in_memory());
                let arrivals: pa_core::session_engine::inbox::InboxArrivals =
                    Arc::new(Mutex::new(Vec::new()));
                let _ = admit_inbox_notice(
                    &worker.recovery,
                    &worker.core,
                    &Arc::new(crate::worker::WorkNotify::new(Arc::default())),
                    &inbox,
                    &arrivals,
                    pa_core::session_engine::inbox::InboxNotice {
                        class: pa_types::inbox_notice::INBOX_CLASS_BASH_DONE,
                        sender: Some("fixture command".to_string()),
                        text: "[bash-done pid:4321 exit:0]".to_string(),
                        meta: json!({ "pid": 4321, "command": "fixture command", "exitCode": 0 }),
                    },
                    Lane::Steering,
                    || false,
                    None,
                );
                assert_eq!(
                    inbox.drain().len(),
                    1,
                    "{command}/{state}: the read drained the waiting message"
                );
                withdraw_drained_inbox_notice(
                    &worker.recovery,
                    &worker.core,
                    &arrivals,
                    &inbox,
                    engine.as_ref(),
                );
            } else {
                let payload = match command {
                    "mutate_queued_message" => json!({
                        "lane": "followUp", "index": 0, "expectedText": "withdraw me",
                        "mutation": { "type": "delete" },
                    }),
                    "cancel_prompt_admission" => json!({
                        "admissionId": "owned-note", "cancelOwned": true,
                    }),
                    _ => json!({}),
                };
                let response = worker.dispatch(command, &payload).await;
                assert!(response.success, "{command}/{state}: {response:?}");
                if command == "mutate_queued_message" {
                    assert_eq!(response.data, Some(json!({ "status": "applied" })));
                }
            }
            let core = worker.core.lock().unwrap();
            assert!(core.follow_up.is_empty(), "{command}/{state}");
            assert_eq!(
                core.steering.len(),
                usize::from(state == "remaining"),
                "{command}/{state}"
            );
            let expected = (state != "last").then(|| "checking deployment".to_string());
            assert_eq!(engine.progress_note(), expected, "{command}/{state}");
            drop(core);
            if matches!(command, "cancel_prompt_admission" | "abort") {
                assert!(publication_pending(), "{command}/{state}: no roster push");
                let (core, inputs) = worker.summary_inputs();
                let summary = crate::worker::summary::session_summary(&core, inputs);
                assert_eq!(
                    summary.progress_note, expected,
                    "{command}/{state}: summary"
                );
            }
        }
    }
}

/// The quiescence observation's bash lane: no background work counts zero,
/// an admitted `[bash-done]` notice counts as the pending wake until it is
/// withdrawn, a plain queued prompt never counts, and the
/// `wait_for_headless_completion` answer carries the count as an additive
/// key next to the TS status.
#[tokio::test]
async fn headless_completion_counts_the_bash_lane() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(NoteWitnessEngine::default());
    let mut worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: dir.path().join("supervisor.sock"),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "bash-quiescence".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "responses": ["unused"] })),
        },
        None,
    );
    worker.engine = engine.clone();
    let (roster_pushes, _pending) = crate::roster_activity::RosterPushQueue::observed_for_test();
    worker.roster_pushes = roster_pushes;
    worker.core.lock().unwrap().created = true;

    // No background work: the bash lane counts zero, and the answer still
    // carries the TS autonomous status.
    let quiet = worker
        .dispatch("wait_for_headless_completion", &json!({}))
        .await;
    assert!(
        quiet.success,
        "wait_for_headless_completion failed: {quiet:?}"
    );
    assert_eq!(
        quiet.data.as_ref().unwrap()["outstandingBackgroundJobs"],
        0,
        "no background work must count zero: {quiet:?}"
    );
    assert_eq!(
        quiet.data.as_ref().unwrap()["enabled"],
        false,
        "the TS status must ride alongside the count: {quiet:?}"
    );

    // An admitted `[bash-done]` notice is completed work whose wake is
    // still pending delivery; a plain queued prompt never counts.
    admit_kernel_notice(
        &worker.recovery,
        &worker.core,
        &Arc::new(crate::worker::WorkNotify::new(Arc::default())),
        crate::engine::KernelNotice::bash_completion(4321, "fixture command", 0),
        || false,
    );
    worker
        .core
        .lock()
        .unwrap()
        .steering
        .push_back(queued_prompt("ordinary", TurnPolicy::Queued));
    assert_eq!(
        worker.outstanding_background_jobs(),
        1,
        "the pending [bash-done] wake must count as background work"
    );

    // The consumed notice withdraws; the bash lane quiets again.
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        /*inbox*/
        None, // The direct steering lane carries no inbox store.
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "fixture command".to_string(),
        },
        Some(engine.as_ref()),
    );
    assert_eq!(
        worker.outstanding_background_jobs(),
        0,
        "the withdrawn notice must not count as background work"
    );
}
